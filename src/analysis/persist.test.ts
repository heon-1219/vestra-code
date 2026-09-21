import { randomUUID } from "node:crypto";

import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "dotenv";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { edges, nodes, projects, user } from "@/db/schema";

import { nodeId } from "./ids";
import { loadPreviousShape } from "./incremental";
import { clearPurposes, loadStoredPurposes, writePurposes } from "./purpose/persist";
import { clearSetAsideText, writeSemanticText } from "./semantic/persist";
import {
  carryForwardSkipped,
  persistGraph,
  promoteRun,
  suppressedBelongsToIds,
  sweepStaleRows,
  WRITE_CHUNK,
} from "./persist";
import type { AnalyzedEdge, AnalyzedNode } from "./types";

/**
 * These hit a real Postgres, so they are opt-in the same way ingest's live test
 * is: `npm test` must stay hermetic and must not depend on Neon being
 * reachable. Run them deliberately:
 *
 *   VESTRA_DB=1 npm test -- src/analysis/persist.test.ts
 *
 * There is no fake here on purpose. Everything this module does that could go
 * wrong is SQL — `ON CONFLICT ... WHERE`, `IS DISTINCT FROM` on a nullable
 * column, and `ON DELETE CASCADE` amplifying a sweep (D37). A mock database
 * would agree with whatever the code believes and prove nothing.
 */
config({ path: ".env.local", quiet: true });

const withDb = process.env.VESTRA_DB ? describe : describe.skip;

const TEST_USER_ID = "vestra-test-persist-user";
const TEST_PROJECT_PREFIX = "vestra-test-persist-";

withDb("persistGraph against a real database", () => {
  let pool: Pool;
  let db: Db;
  let projectId: string;

  /** Everything this suite ever writes, by id prefix. */
  const removeTestRows = async () => {
    await db.delete(projects).where(like(projects.id, `${TEST_PROJECT_PREFIX}%`));
    await db.delete(user).where(eq(user.id, TEST_USER_ID));
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    db = drizzle(pool, { schema });

    // A previous run that crashed between tests would leave rows behind, and a
    // suite that is not repeatable is a suite nobody runs twice.
    await removeTestRows();
    await db.insert(user).values({
      id: TEST_USER_ID,
      name: "persist test",
      email: "persist-test@vestra.invalid",
      emailVerified: false,
    });
  }, 60000);

  afterAll(async () => {
    await removeTestRows();
    await pool.end();
  }, 60000);

  beforeEach(async () => {
    projectId = `${TEST_PROJECT_PREFIX}${randomUUID()}`;
    await db.insert(projects).values({
      id: projectId,
      userId: TEST_USER_ID,
      repoOwner: "vestra",
      repoName: "fixture",
      repoUrl: "https://github.com/vestra/fixture",
      defaultBranch: "main",
      displayName: "fixture",
      kind: "nextjs",
    });
  });

  // Deleting the project cascades to its nodes and edges, so a failing test
  // cannot leave anything behind — afterEach runs whether the test passed.
  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId));
  });

  const readNodes = async () =>
    db.select().from(nodes).where(eq(nodes.projectId, projectId)).orderBy(nodes.id);

  const readEdges = async () =>
    db.select().from(edges).where(eq(edges.projectId, projectId)).orderBy(edges.id);

  it("writes nodes before edges and drops an edge that resolves to nothing", async () => {
    const result = await persistGraph(db, projectId, "run-1", fixtureNodes(), [
      ...fixtureEdges(),
      // Nothing ever declared this symbol. Under D31's two passes it cannot be
      // "not yet written", so it is a dangling edge and must be counted.
      {
        source: { type: "symbol", filePath: "a.ts", name: "alpha" },
        target: { type: "symbol", filePath: "ghost.ts", name: "gamma" },
        type: "calls",
        confidence: "certain",
      },
    ]);

    expect(result.nodesWritten).toBe(4);
    expect(result.edgesWritten).toBe(4);
    expect(result.edgesDropped).toBe(1);
    expect(result.droppedSamples).toHaveLength(1);
    expect(result.droppedSamples[0]).toContain("ghost.ts");

    expect(await readNodes()).toHaveLength(4);
    expect(await readEdges()).toHaveLength(4);

    const alpha = (await readNodes()).find((row) => row.name === "alpha");
    expect(alpha?.filePath).toBe("a.ts");
    expect(alpha?.kind).toBe("function");
    expect(alpha?.origin).toBe("static");
    expect(alpha?.lastSeenRunId).toBe("run-1");
  });

  it("changes nothing when the same graph is analyzed again", async () => {
    await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());
    await promoteRun(db, projectId, "run-1");
    const before = await readNodes();
    const beforeEdges = await readEdges();

    const second = await persistGraph(db, projectId, "run-2", fixtureNodes(), fixtureEdges());
    const promoted = await promoteRun(db, projectId, "run-2");

    expect(promoted.swept).toEqual({ nodes: 0, edges: 0 });
    expect(second.edgesDropped).toBe(0);

    const after = await readNodes();
    const afterEdges = await readEdges();

    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(afterEdges.map((row) => row.id)).toEqual(beforeEdges.map((row) => row.id));
    // Upserted, not deleted and re-inserted. A churning createdAt would mean
    // ids were churning too, and every chat citation with them (section 6.1).
    expect(after.map((row) => row.createdAt.getTime())).toEqual(
      before.map((row) => row.createdAt.getTime()),
    );
    expect(new Set(after.map((row) => row.lastSeenRunId))).toEqual(new Set(["run-2"]));
  });

  it("deletes exactly the removed file's rows, and nothing else", async () => {
    await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());
    await promoteRun(db, projectId, "run-1");

    // b.ts is gone from the repo: no nodes, and the only surviving edge is the
    // one wholly inside a.ts.
    const remaining: AnalyzedNode[] = [
      { ref: { type: "file", filePath: "a.ts" }, metadata: { size: 10 } },
      { ref: { type: "symbol", filePath: "a.ts", name: "alpha" }, kind: "function" },
    ];
    const remainingEdges: AnalyzedEdge[] = [
      {
        source: { type: "file", filePath: "a.ts" },
        target: { type: "symbol", filePath: "a.ts", name: "alpha" },
        type: "contains",
        confidence: "certain",
      },
    ];

    await persistGraph(db, projectId, "run-2", remaining, remainingEdges);
    const promoted = await promoteRun(db, projectId, "run-2");

    // b.ts and beta.
    expect(promoted.swept.nodes).toBe(2);
    // contains b.ts->beta, imports a.ts->b.ts, calls alpha->beta.
    expect(promoted.swept.edges).toBe(3);

    const survivors = await readNodes();
    expect(survivors.map((row) => row.name).sort()).toEqual(["a.ts", "alpha"]);
    expect(await readEdges()).toHaveLength(1);
  });

  it("never overwrites or sweeps a user row", async () => {
    await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());

    // The user renamed a symbol's grouping and made their own feature. Both are
    // origin `user`; re-analysis does not get to argue (section 6.1 rule 2).
    const alphaId = nodeId(projectId, { type: "symbol", filePath: "a.ts", name: "alpha" });
    await db
      .update(nodes)
      .set({ origin: "user", label: "결제 버튼", lastSeenRunId: null })
      .where(eq(nodes.id, alphaId));

    const featureRef = { type: "feature", filePath: "", name: "결제" } as const;
    const featureId = nodeId(projectId, featureRef);
    await db.insert(nodes).values({
      id: featureId,
      projectId,
      type: "feature",
      name: "결제",
      origin: "user",
      metadata: {},
    });
    await db.insert(edges).values({
      id: "user-belongs-to",
      projectId,
      sourceNodeId: alphaId,
      targetNodeId: featureId,
      type: "belongs_to",
      confidence: "certain",
      origin: "user",
      metadata: {},
    });

    // A whole new run, which does not know about any of it.
    await persistGraph(db, projectId, "run-2", fixtureNodes(), fixtureEdges());
    await promoteRun(db, projectId, "run-2");

    const rows = await readNodes();
    const alpha = rows.find((row) => row.id === alphaId);
    expect(alpha, "user node was swept").toBeDefined();
    expect(alpha?.label, "user label was overwritten").toBe("결제 버튼");
    expect(alpha?.origin).toBe("user");
    // Untouched means untouched: the upsert skipped it, so it still carries no
    // run stamp, and the sweep still has to leave it alone.
    expect(alpha?.lastSeenRunId).toBeNull();

    expect(rows.some((row) => row.id === featureId), "user feature was swept").toBe(true);
    const userEdge = (await readEdges()).find((row) => row.id === "user-belongs-to");
    expect(userEdge, "user edge was swept").toBeDefined();
    expect(userEdge?.lastSeenRunId).toBeNull();
  });

  it("carries a skipped file's rows forward, with the edges that touch it", async () => {
    await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());
    await promoteRun(db, projectId, "run-1");

    // Run two: b.ts has a syntax error, so the analyzer emitted nothing for it.
    // Without the carry-forward, the sweep deletes b.ts and beta — and the
    // cascade takes `calls alpha -> beta`, an edge from a perfectly healthy
    // file (D37).
    const parsed: AnalyzedNode[] = [
      { ref: { type: "file", filePath: "a.ts" }, metadata: { size: 10 } },
      { ref: { type: "symbol", filePath: "a.ts", name: "alpha" }, kind: "function" },
    ];
    const parsedEdges: AnalyzedEdge[] = [
      {
        source: { type: "file", filePath: "a.ts" },
        target: { type: "symbol", filePath: "a.ts", name: "alpha" },
        type: "contains",
        confidence: "certain",
      },
    ];

    await persistGraph(db, projectId, "run-2", parsed, parsedEdges);
    const promoted = await promoteRun(db, projectId, "run-2", ["b.ts"]);

    expect(promoted.carriedForward.nodes).toBe(2);
    // contains b.ts->beta, imports a.ts->b.ts, calls alpha->beta.
    expect(promoted.carriedForward.edges).toBe(3);
    expect(promoted.swept).toEqual({ nodes: 0, edges: 0 });

    const rows = await readNodes();
    expect(rows.map((row) => row.name).sort()).toEqual(["a.ts", "alpha", "b.ts", "beta"]);
    expect(new Set(rows.map((row) => row.lastSeenRunId))).toEqual(new Set(["run-2"]));
    expect(await readEdges()).toHaveLength(4);
  });

  it("resolves an edge against nodes an earlier pass of the same run wrote", async () => {
    await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());

    // Pass 2 writes a feature node and points existing symbols at it. Its
    // sources were written by a different call, so an in-batch-only endpoint
    // check would drop every one of them.
    const result = await persistGraph(
      db,
      projectId,
      "run-1",
      [{ ref: { type: "feature", filePath: "", name: "결제" } }],
      [
        {
          source: { type: "symbol", filePath: "a.ts", name: "alpha" },
          target: { type: "feature", filePath: "", name: "결제" },
          type: "belongs_to",
          confidence: "inferred",
        },
      ],
      { origin: "llm" },
    );

    expect(result.edgesDropped).toBe(0);
    expect(result.edgesWritten).toBe(1);

    const belongsTo = (await readEdges()).find((row) => row.type === "belongs_to");
    expect(belongsTo?.origin).toBe("llm");
    expect(belongsTo?.confidence).toBe("inferred");
  });

  it("writes more rows than fit in one statement, and tolerates duplicate refs", async () => {
    const many: AnalyzedNode[] = [];
    for (let i = 0; i < WRITE_CHUNK * 2 + 7; i += 1) {
      many.push({
        ref: { type: "symbol", filePath: `pkg/file-${i}.ts`, name: `sym${i}` },
        kind: "function",
      });
    }
    // The same ref twice. Postgres rejects an upsert whose VALUES name one key
    // twice, so this is a hard failure rather than a duplicated row.
    many.push(many[0]);

    const result = await persistGraph(db, projectId, "run-1", many, []);
    expect(result.nodesWritten).toBe(WRITE_CHUNK * 2 + 7);
    expect(await readNodes()).toHaveLength(WRITE_CHUNK * 2 + 7);
  });

  it("drops a node that can be neither named nor located", async () => {
    const result = await persistGraph(
      db,
      projectId,
      "run-1",
      [{ ref: { type: "package", filePath: "" } }],
      [],
    );
    expect(result.nodesDropped).toBe(1);
    expect(result.nodesWritten).toBe(0);
  });

  it("sweeps and carries forward only within its own project", async () => {
    const otherId = `${TEST_PROJECT_PREFIX}${randomUUID()}`;
    await db.insert(projects).values({
      id: otherId,
      userId: TEST_USER_ID,
      repoOwner: "vestra",
      repoName: "other",
      repoUrl: "https://github.com/vestra/other",
      defaultBranch: "main",
      displayName: "other",
      kind: "nextjs",
    });

    try {
      await persistGraph(db, otherId, "other-run", fixtureNodes(), fixtureEdges());
      await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());

      // A sweep for one project must not see another project's rows, even
      // though they were stamped with a run id it has never heard of.
      const swept = await sweepStaleRows(db, projectId, "run-2");
      expect(swept.nodes).toBe(4);
      const carried = await carryForwardSkipped(db, projectId, "run-2", ["a.ts"]);
      expect(carried.nodes).toBe(0);

      const others = await db.select().from(nodes).where(eq(nodes.projectId, otherId));
      expect(others).toHaveLength(4);
    } finally {
      await db.delete(projects).where(eq(projects.id, otherId));
    }
  });

  it("leaves the previous graph intact when a run fails", async () => {
    await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());
    await promoteRun(db, projectId, "run-1");

    // Run two got through ingest, wrote a fraction of the graph, then threw.
    // Nothing calls promoteRun, so nothing is swept and the user keeps the map
    // they had rather than the half of it this run managed to produce (D20).
    await persistGraph(
      db,
      projectId,
      "run-2",
      [{ ref: { type: "file", filePath: "a.ts" }, metadata: { size: 10 } }],
      [],
    );

    const rows = await readNodes();
    expect(rows).toHaveLength(4);
    expect(await readEdges()).toHaveLength(4);
    // And a later successful run is not confused by the failed one's stamps.
    await persistGraph(db, projectId, "run-3", fixtureNodes(), fixtureEdges());
    const promoted = await promoteRun(db, projectId, "run-3");
    expect(promoted.swept).toEqual({ nodes: 0, edges: 0 });
    expect(await readNodes()).toHaveLength(4);
  });

  it("carries an unchanged file's own connections forward and no one else's", async () => {
    await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());
    await promoteRun(db, projectId, "run-1");

    // Run two is incremental: `a.ts` changed and dropped its call into `b.ts`,
    // `b.ts` did not change and is carried forward. The stale `a.ts -> b.ts`
    // connections must NOT survive — `b.ts` is at the far end of them, and the
    // wider `touching` stamp would resurrect a call the author just deleted.
    await persistGraph(
      db,
      projectId,
      "run-2",
      [
        { ref: { type: "file", filePath: "a.ts" }, metadata: { size: 11 } },
        {
          ref: { type: "symbol", filePath: "a.ts", name: "alpha" },
          kind: "function",
          startLine: 1,
          endLine: 3,
        },
      ],
      [
        {
          source: { type: "file", filePath: "a.ts" },
          target: { type: "symbol", filePath: "a.ts", name: "alpha" },
          type: "contains",
          confidence: "certain",
        },
      ],
    );
    await promoteRun(db, projectId, "run-2", [], ["b.ts"]);

    expect((await readNodes()).map((row) => row.name).sort()).toEqual([
      "a.ts",
      "alpha",
      "b.ts",
      "beta",
    ]);
    // `b.ts contains beta` is b.ts's own and survives. The import and the call
    // out of a.ts are gone, because a.ts re-stated its connections this run.
    const edgeRows = await readEdges();
    expect(edgeRows.map((row) => row.type).sort()).toEqual(["contains", "contains"]);
  });

  it("reads the previous graph's shape as the file-level dependency graph", async () => {
    await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());
    await promoteRun(db, projectId, "run-1");

    const shape = await loadPreviousShape(db, projectId);
    const pairs = shape.dependencies
      .map((dependency) => `${dependency.from} -> ${dependency.to}`)
      .sort();

    // Four edges collapse to the two distinct file pairs the closure asks
    // about. That collapse happening in Postgres rather than here is the whole
    // point: a repository with ten thousand connections comes back as a few
    // hundred rows.
    expect(pairs).toEqual(["a.ts -> a.ts", "a.ts -> b.ts", "b.ts -> b.ts"]);
    expect(shape.packageNames).toEqual([]);
    expect(shape.endpointIds).toEqual([]);
    expect(shape.setAside).toEqual([]);
  });

  it("reads which file rows say they were set aside, and nothing else (D175)", async () => {
    await persistGraph(
      db,
      projectId,
      "run-1",
      [
        { ref: { type: "file", filePath: "src/a.test.ts" }, metadata: { setAside: "tests" } },
        { ref: { type: "file", filePath: ".claude/settings.json" }, metadata: { setAside: "tool_settings" } },
        // A value that is not a reason reads as "read", like no value at all.
        { ref: { type: "file", filePath: "src/odd.ts" }, metadata: { setAside: "maybe" } },
        { ref: { type: "file", filePath: "src/a.ts" }, metadata: { size: 10 } },
        // Only file rows carry the answer.
        {
          ref: { type: "symbol", filePath: "src/a.ts", name: "alpha" },
          kind: "function",
          metadata: { setAside: "tests" },
        },
      ],
      [],
    );
    await promoteRun(db, projectId, "run-1");

    const shape = await loadPreviousShape(db, projectId);
    expect([...shape.setAside].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: ".claude/settings.json", reason: "tool_settings" },
      { path: "src/a.test.ts", reason: "tests" },
    ]);
  });

  it("resolves an existing project's node ids without a hash collision", async () => {
    // D42's colliding pair, end to end: two refs that a delimiter-joined id
    // would have merged, writing one row and repointing the other's edges.
    const result = await persistGraph(
      db,
      projectId,
      "run-1",
      [
        { ref: { type: "file", filePath: "assets/me sitting 3.jpg" } },
        { ref: { type: "file", filePath: "assets/me sitting" }, metadata: { n: 3 } },
      ],
      [],
    );
    expect(result.nodesWritten).toBe(2);
    expect(await readNodes()).toHaveLength(2);
  });

  /*
   * Pass 3's one key inside `edges.metadata`, which Pass 1 must not wipe.
   *
   * SQL, and therefore untestable without a database: the upsert keeps
   * `purpose` and replaces everything else, which is the `jsonb` version of the
   * rule that keeps `label` and `summary` off Pass 1's node upsert. A fake
   * would agree with whatever the code believes and prove nothing.
   */
  describe("the sentence Pass 3 writes onto a connection", () => {
    const callsEdge = () => ({
      source: { type: "symbol" as const, filePath: "a.ts", name: "alpha" },
      target: { type: "symbol" as const, filePath: "b.ts", name: "beta" },
      type: "calls" as const,
      confidence: "certain" as const,
      metadata: { line: 34 },
    });

    const write = async (runId: string) =>
      persistGraph(db, projectId, runId, fixtureNodes(), [
        ...fixtureEdges().filter((edge) => edge.type !== "calls"),
        callsEdge(),
      ]);

    it("survives a full re-analysis, and keeps the call-site line beside it", async () => {
      await write("run-1");

      const before = await loadStoredPurposes(db, projectId);
      expect(before.size).toBe(0);

      const target = (await readEdges()).find((row) => row.type === "calls");
      expect(target).toBeDefined();
      const written = await writePurposes(
        db,
        projectId,
        new Map([[target!.id, "여기서 값을 사람이 읽기 좋게 바꿔요."]]),
      );
      expect(written).toBe(1);

      // Pass 1 runs again over the same graph and rewrites every metadata blob.
      await write("run-2");

      const after = await loadStoredPurposes(db, projectId);
      expect(after.get(target!.id)).toBe("여기서 값을 사람이 읽기 좋게 바꿔요.");

      // And D83's line is still there. Adding a sentence by replacing the blob
      // would have traded "PayButton.tsx 34줄에서" for it, which is the wrong half.
      const row = (await readEdges()).find((edge) => edge.id === target!.id);
      expect((row?.metadata as { line?: number }).line).toBe(34);
    });

    it("is not written onto a connection the user corrected", async () => {
      await write("run-1");
      const target = (await readEdges()).find((row) => row.type === "calls");
      await db.update(edges).set({ origin: "user" }).where(eq(edges.id, target!.id));

      const written = await writePurposes(
        db,
        projectId,
        new Map([[target!.id, "여기서 값을 바꿔요."]]),
      );
      // Section 6.1 rule 2: re-analysis does not argue with a row a person put
      // there, and that includes laying prose over it.
      expect(written).toBe(0);
      expect((await loadStoredPurposes(db, projectId)).size).toBe(0);
    });

    it("finds nothing when the id belongs to another project", async () => {
      await write("run-1");
      const target = (await readEdges()).find((row) => row.type === "calls");
      const written = await writePurposes(
        db,
        "vestra-test-persist-somebody-else",
        new Map([[target!.id, "여기서 값을 바꿔요."]]),
      );
      expect(written).toBe(0);
    });

    it("is taken off a connection Pass 3 set aside, and the rest of the blob stays", async () => {
      // D169: a sentence nobody will refresh is taken off, the call-site line
      // beside it is not, and a user's connection is not touched at all.
      await write("run-1");
      const rows = await readEdges();
      const calls = rows.find((row) => row.type === "calls")!;
      const importsRow = rows.find((row) => row.type === "imports")!;
      await writePurposes(
        db,
        projectId,
        new Map([
          [calls.id, "여기서 값을 바꿔요."],
          [importsRow.id, "필요한 것을 가져와요."],
        ]),
      );
      await db.update(edges).set({ origin: "user" }).where(eq(edges.id, importsRow.id));

      expect(await clearPurposes(db, "vestra-test-persist-somebody-else", [calls.id])).toBe(0);
      expect(await clearPurposes(db, projectId, [calls.id, importsRow.id])).toBe(1);
      // Nothing left to take: a second run changes nothing.
      expect(await clearPurposes(db, projectId, [calls.id])).toBe(0);

      const stored = await loadStoredPurposes(db, projectId);
      expect(stored.has(calls.id)).toBe(false);
      expect(stored.get(importsRow.id)).toBe("필요한 것을 가져와요.");
      const after = (await readEdges()).find((edge) => edge.id === calls.id);
      expect((after?.metadata as { line?: number }).line).toBe(34);
    });
  });

  describe("the Korean on a file the model no longer reads", () => {
    it("is cleared from the file and every piece inside it, and nowhere else", async () => {
      await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());
      await writeSemanticText(db, projectId, [
        { ref: { type: "file", filePath: "a.ts" }, label: "주문 화면", summary: "주문을 받아요." },
        { ref: { type: "symbol", filePath: "a.ts", name: "alpha" }, label: "주문 버튼", summary: null },
        { ref: { type: "file", filePath: "b.ts" }, label: "주문 검사", summary: "주문을 검사해요." },
        { ref: { type: "symbol", filePath: "b.ts", name: "beta" }, label: "검사 하나", summary: null },
      ]);

      // Another project's file of the same name is not this one.
      expect(await clearSetAsideText(db, "vestra-test-persist-somebody-else", ["b.ts"])).toBe(0);
      expect(await clearSetAsideText(db, projectId, ["b.ts"])).toBe(2);
      // Nothing left on them, so the next run changes nothing.
      expect(await clearSetAsideText(db, projectId, ["b.ts"])).toBe(0);

      const byName = new Map((await readNodes()).map((row) => [row.name, row]));
      const text = (name: string) => {
        const row = byName.get(name);
        return [row?.label ?? null, row?.summary ?? null, row?.textLang ?? null];
      };
      expect(text("a.ts")).toEqual(["주문 화면", "주문을 받아요.", "ko"]);
      expect(text("alpha")).toEqual(["주문 버튼", null, "ko"]);
      expect(text("b.ts")).toEqual([null, null, null]);
      expect(text("beta")).toEqual([null, null, null]);
    });

    it("keeps a name the person typed", async () => {
      await persistGraph(db, projectId, "run-1", fixtureNodes(), fixtureEdges());
      const fileId = nodeId(projectId, { type: "file", filePath: "b.ts" });
      await db
        .update(nodes)
        .set({ label: "내가 붙인 이름", origin: "user" })
        .where(eq(nodes.id, fileId));

      expect(await clearSetAsideText(db, projectId, ["b.ts"])).toBe(0);
      const row = (await readNodes()).find((node) => node.id === fileId);
      expect(row?.label).toBe("내가 붙인 이름");
    });
  });
});

/**
 * No database needed: the rule is a pure function of the rows on purpose, so
 * that undoing a correction un-suppresses immediately instead of waiting for
 * the next analysis run (D9).
 */
describe("suppressedBelongsToIds", () => {
  const llm = { id: "llm-1", sourceNodeId: "alpha", type: "belongs_to", origin: "llm" } as const;
  const userEdge = {
    id: "user-1",
    sourceNodeId: "alpha",
    type: "belongs_to",
    origin: "user",
  } as const;

  it("suppresses the machine grouping for a node the user has corrected", () => {
    expect([...suppressedBelongsToIds([llm, userEdge])]).toEqual(["llm-1"]);
  });

  it("returns the machine grouping once the correction is undone", () => {
    expect(suppressedBelongsToIds([llm]).size).toBe(0);
  });

  it("leaves other nodes' groupings alone", () => {
    const other = {
      id: "llm-2",
      sourceNodeId: "beta",
      type: "belongs_to",
      origin: "llm",
    } as const;
    expect([...suppressedBelongsToIds([llm, userEdge, other])]).toEqual(["llm-1"]);
  });

  it("never suppresses a user edge, and ignores other edge types", () => {
    const calls = {
      id: "calls-1",
      sourceNodeId: "alpha",
      type: "calls",
      origin: "llm",
    } as const;
    const result = suppressedBelongsToIds([llm, userEdge, calls]);
    expect(result.has("user-1")).toBe(false);
    expect(result.has("calls-1")).toBe(false);
  });
});

function fixtureNodes(): AnalyzedNode[] {
  return [
    { ref: { type: "file", filePath: "a.ts" }, metadata: { size: 10 } },
    { ref: { type: "file", filePath: "b.ts" }, metadata: { size: 20 } },
    {
      ref: { type: "symbol", filePath: "a.ts", name: "alpha" },
      kind: "function",
      startLine: 1,
      endLine: 3,
    },
    {
      ref: { type: "symbol", filePath: "b.ts", name: "beta" },
      kind: "function",
      startLine: 1,
      endLine: 2,
    },
  ];
}

function fixtureEdges(): AnalyzedEdge[] {
  return [
    {
      source: { type: "file", filePath: "a.ts" },
      target: { type: "symbol", filePath: "a.ts", name: "alpha" },
      type: "contains",
      confidence: "certain",
    },
    {
      source: { type: "file", filePath: "b.ts" },
      target: { type: "symbol", filePath: "b.ts", name: "beta" },
      type: "contains",
      confidence: "certain",
    },
    {
      source: { type: "file", filePath: "a.ts" },
      target: { type: "file", filePath: "b.ts" },
      type: "imports",
      confidence: "certain",
    },
    {
      source: { type: "symbol", filePath: "a.ts", name: "alpha" },
      target: { type: "symbol", filePath: "b.ts", name: "beta" },
      type: "calls",
      confidence: "certain",
    },
  ];
}
