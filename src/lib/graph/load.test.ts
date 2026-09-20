import { randomUUID } from "node:crypto";

import { config } from "dotenv";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { analysisRuns, edges, nodes, projects, user } from "@/db/schema";

import {
  buildGraphView,
  loadGraphView,
  type GraphEdgeRow,
  type GraphNodeRow,
  type GraphRunRow,
} from "./load";

config({ path: ".env.local", quiet: true });

/**
 * Two suites.
 *
 * This first one is hermetic and runs on every `npm test`: everything that can
 * be wrong in the mapping and in the two counters is provable without Postgres
 * being reachable, and it has to stay provable in a second rather than a
 * minute. The second suite, at the bottom, runs the real queries against a real
 * database and is opt-in.
 *
 * The fixtures are the two real projects this has to look right on: the demo
 * repo (symbols, several kinds of connection, all certain) and the founder's
 * portfolio (files only, zero symbols, imports only).
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";

function node(over: Partial<GraphNodeRow> & { id: string }): GraphNodeRow {
  return {
    type: "file",
    kind: null,
    name: over.id,
    label: null,
    summary: null,
    filePath: `src/${over.id}.ts`,
    startLine: null,
    endLine: null,
    origin: "static",
    ...over,
  };
}

function edge(over: Partial<GraphEdgeRow> & { id: string }): GraphEdgeRow {
  return {
    sourceNodeId: "a",
    targetNodeId: "b",
    type: "imports",
    confidence: "certain",
    ...over,
  };
}

describe("buildGraphView", () => {
  it("renames every column to the word the workspace reads", () => {
    const view = buildGraphView(
      PROJECT,
      [
        node({
          id: "n1",
          type: "symbol",
          kind: "component",
          name: "PayButton",
          label: "결제 버튼",
          summary: "결제를 시작하는 버튼이에요.",
          filePath: "src/components/PayButton.tsx",
          startLine: 12,
          endLine: 48,
        }),
      ],
      [],
      null,
    );

    expect(view.projectId).toBe(PROJECT);
    expect(view.items[0]).toEqual({
      id: "n1",
      kind: "symbol",
      shape: "component",
      name: "PayButton",
      label: "결제 버튼",
      summary: "결제를 시작하는 버튼이에요.",
      path: "src/components/PayButton.tsx",
      startLine: 12,
      endLine: 48,
      fromUser: false,
      usedBy: 0,
      uses: 0,
    });
  });

  it("marks only a row a person put there as theirs", () => {
    const view = buildGraphView(
      PROJECT,
      [
        node({ id: "static", origin: "static" }),
        node({ id: "llm", origin: "llm" }),
        node({ id: "mine", origin: "user" }),
      ],
      [],
      null,
    );

    expect(view.items.map((item) => [item.id, item.fromUser])).toEqual([
      ["static", false],
      ["llm", false],
      ["mine", true],
    ]);
  });

  it("carries the relation and how sure we are, unchanged", () => {
    const view = buildGraphView(
      PROJECT,
      [node({ id: "a" }), node({ id: "b" })],
      [
        edge({ id: "e1", sourceNodeId: "a", targetNodeId: "b", type: "calls" }),
        edge({
          id: "e2",
          sourceNodeId: "a",
          targetNodeId: "b",
          type: "fetches",
          confidence: "inferred",
        }),
      ],
      null,
    );

    expect(view.connections).toEqual([
      { id: "e1", from: "a", to: "b", relation: "calls", certainty: "certain" },
      { id: "e2", from: "a", to: "b", relation: "fetches", certainty: "inferred" },
    ]);
  });

  it("counts both directions, and leaves an unconnected item at zero", () => {
    // formatPrice is called from three places and calls nothing. The file that
    // holds it contains it — which is NOT a fourth place that uses it, and this
    // assertion used to say it was. The photo nobody uses stays at zero, which
    // is what makes "아는 연결이 없어요" answerable at all.
    const view = buildGraphView(
      PROJECT,
      [
        node({ id: "file" }),
        node({ id: "formatPrice", type: "symbol" }),
        node({ id: "caller1", type: "symbol" }),
        node({ id: "caller2", type: "symbol" }),
        node({ id: "caller3", type: "symbol" }),
        node({ id: "photo" }),
      ],
      [
        edge({ id: "c", sourceNodeId: "file", targetNodeId: "formatPrice", type: "contains" }),
        edge({ id: "e1", sourceNodeId: "caller1", targetNodeId: "formatPrice", type: "calls" }),
        edge({ id: "e2", sourceNodeId: "caller2", targetNodeId: "formatPrice", type: "calls" }),
        edge({ id: "e3", sourceNodeId: "caller3", targetNodeId: "formatPrice", type: "calls" }),
      ],
      null,
    );

    const byId = new Map(view.items.map((item) => [item.id, item]));
    expect(byId.get("formatPrice")).toMatchObject({ usedBy: 3, uses: 0 });
    expect(byId.get("caller1")).toMatchObject({ usedBy: 0, uses: 1 });
    // The file holds it; holding is not using.
    expect(byId.get("file")).toMatchObject({ usedBy: 0, uses: 0 });
    expect(byId.get("photo")).toMatchObject({ usedBy: 0, uses: 0 });
  });

  it("holds up on a project with no symbols at all", () => {
    // The founder's portfolio through the shallow analyzer: 58 files, 57
    // `imports` links, nothing else. The view must not need a symbol to exist.
    const files = Array.from({ length: 58 }, (_, index) =>
      node({ id: `f${index}`, filePath: `page${index}.html` }),
    );
    const links = Array.from({ length: 57 }, (_, index) =>
      edge({
        id: `l${index}`,
        sourceNodeId: `f${index}`,
        targetNodeId: `f${index + 1}`,
        type: "imports",
      }),
    );

    const view = buildGraphView(PROJECT, files, links, null);

    expect(view.items).toHaveLength(58);
    expect(view.connections).toHaveLength(57);
    expect(view.items.every((item) => item.kind === "file")).toBe(true);
    expect(view.items.every((item) => item.shape === null)).toBe(true);
    expect(view.items[0]).toMatchObject({ uses: 1, usedBy: 0 });
    expect(view.items[57]).toMatchObject({ uses: 0, usedBy: 1 });
  });

  it("counts in one pass rather than once per item", () => {
    // A shape test, not a benchmark. Counting inside the item loop is
    // items x connections — 200 million comparisons here, several seconds —
    // where one pass is 45,000 and a few milliseconds. The budget is two
    // orders of magnitude above the honest implementation on purpose, so a
    // loaded machine cannot fail it but a reintroduced quadratic scan will.
    const itemCount = 5_000;
    const connectionCount = 40_000;

    const items = Array.from({ length: itemCount }, (_, index) =>
      node({ id: `n${index}` }),
    );
    const links = Array.from({ length: connectionCount }, (_, index) =>
      edge({
        id: `e${index}`,
        sourceNodeId: `n${index % itemCount}`,
        targetNodeId: "n0",
      }),
    );

    const started = performance.now();
    const view = buildGraphView(PROJECT, items, links, null);
    const elapsed = performance.now() - started;

    expect(view.items[0].usedBy).toBe(connectionCount);
    // n0 is also the source of every 5000th link.
    expect(view.items[0].uses).toBe(connectionCount / itemCount);
    expect(elapsed).toBeLessThan(2000);
  });

  it("says nothing about a run that has never happened", () => {
    expect(buildGraphView(PROJECT, [], [], null).lastRun).toBeNull();
  });

  it("reports the latest run, finished or not", () => {
    const run: GraphRunRow = {
      id: "run-1",
      status: "running",
      finishedAt: null,
      filesParsed: 18,
      filesSkipped: ["src/broken.tsx"],
      error: null,
    };

    expect(buildGraphView(PROJECT, [], [], run).lastRun).toEqual({
      id: "run-1",
      status: "running",
      finishedAt: null,
      filesParsed: 18,
      filesSkipped: ["src/broken.tsx"],
      error: null,
    });
  });

  it("turns the finish time into something that survives JSON", () => {
    const run: GraphRunRow = {
      id: "run-2",
      status: "completed",
      finishedAt: new Date("2026-09-19T04:05:06.000Z"),
      filesParsed: 18,
      filesSkipped: [],
      error: null,
    };

    expect(buildGraphView(PROJECT, [], [], run).lastRun?.finishedAt).toBe(
      "2026-09-19T04:05:06.000Z",
    );
  });

  it("carries a failed run's plain-language reason", () => {
    const run: GraphRunRow = {
      id: "run-3",
      status: "failed",
      finishedAt: new Date("2026-09-19T04:05:06.000Z"),
      filesParsed: 0,
      filesSkipped: [],
      error: "저장소를 가져오지 못했어요.",
    };

    expect(buildGraphView(PROJECT, [], [], run).lastRun).toMatchObject({
      status: "failed",
      error: "저장소를 가져오지 못했어요.",
    });
  });

  it("does not let a strange skipped-files value take the whole map down", () => {
    // `files_skipped` is jsonb, so it can hold anything a bad write put there.
    // A map that fails to render over a list of filenames nobody reads is the
    // worse outcome by a distance.
    const run: GraphRunRow = {
      id: "run-4",
      status: "completed",
      finishedAt: null,
      filesParsed: 3,
      filesSkipped: { nope: true },
      error: null,
    };

    expect(buildGraphView(PROJECT, [], [], run).lastRun?.filesSkipped).toEqual([]);

    const mixed: GraphRunRow = { ...run, filesSkipped: ["ok.ts", 7, null] };
    expect(buildGraphView(PROJECT, [], [], mixed).lastRun?.filesSkipped).toEqual([
      "ok.ts",
    ]);
  });
});

/**
 * The three queries themselves, against a real Postgres.
 *
 * Opt-in the same way `persist.test.ts` is, so `npm test` stays hermetic and
 * does not depend on Neon being reachable:
 *
 *   VESTRA_DB=1 npm test -- src/lib/graph/load.test.ts
 *
 * What this proves that the pure tests cannot: that the columns selected exist,
 * that the Postgres enums still line up with `view.ts`, and that the latest run
 * is the one that comes back when a project has several.
 */
const withDb = process.env.VESTRA_DB ? describe : describe.skip;

const TEST_USER_ID = "vestra-test-load-user";
const TEST_PROJECT_PREFIX = "vestra-test-load-";

withDb("loadGraphView against a real database", () => {
  let pool: Pool;
  let db: Db;
  let projectId: string;

  const removeTestRows = async () => {
    await db.delete(projects).where(like(projects.id, `${TEST_PROJECT_PREFIX}%`));
    await db.delete(user).where(eq(user.id, TEST_USER_ID));
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    db = drizzle(pool, { schema });

    await removeTestRows();
    await db.insert(user).values({
      id: TEST_USER_ID,
      name: "load test",
      email: "load-test@vestra.invalid",
      emailVerified: false,
    });

    projectId = `${TEST_PROJECT_PREFIX}${randomUUID()}`;
    await db.insert(projects).values({
      id: projectId,
      userId: TEST_USER_ID,
      source: "github",
      repoOwner: "vestra",
      repoName: "load-test",
      defaultBranch: "main",
      displayName: "load test",
      kind: "nextjs",
    });

    await db.insert(nodes).values([
      {
        id: `${projectId}-file`,
        projectId,
        type: "file",
        name: "cart.ts",
        filePath: "src/lib/cart.ts",
        origin: "static",
      },
      {
        id: `${projectId}-symbol`,
        projectId,
        type: "symbol",
        kind: "function",
        name: "formatPrice",
        filePath: "src/lib/cart.ts",
        startLine: 4,
        endLine: 9,
        origin: "static",
      },
      {
        id: `${projectId}-mine`,
        projectId,
        type: "feature",
        name: "checkout",
        label: "결제",
        summary: "장바구니에서 결제까지의 흐름이에요.",
        filePath: "src/app/checkout/page.tsx",
        origin: "user",
      },
    ]);

    await db.insert(edges).values([
      {
        id: `${projectId}-contains`,
        projectId,
        sourceNodeId: `${projectId}-file`,
        targetNodeId: `${projectId}-symbol`,
        type: "contains",
        confidence: "certain",
        origin: "static",
      },
      {
        id: `${projectId}-belongs`,
        projectId,
        sourceNodeId: `${projectId}-symbol`,
        targetNodeId: `${projectId}-mine`,
        type: "belongs_to",
        confidence: "inferred",
        origin: "user",
      },
    ]);

    // Two runs, so "the latest" has something to be latest of.
    await db.insert(analysisRuns).values([
      {
        id: `${projectId}-run-old`,
        projectId,
        status: "failed",
        error: "옛날 기록이에요.",
        startedAt: new Date("2026-09-18T00:00:00.000Z"),
        finishedAt: new Date("2026-09-18T00:01:00.000Z"),
      },
      {
        id: `${projectId}-run-new`,
        projectId,
        status: "completed",
        filesParsed: 18,
        filesSkipped: ["src/broken.tsx"],
        startedAt: new Date("2026-09-19T00:00:00.000Z"),
        finishedAt: new Date("2026-09-19T00:02:00.000Z"),
      },
    ]);
  }, 60000);

  afterAll(async () => {
    await removeTestRows();
    await pool.end();
  }, 60000);

  it("reads the graph back in the shape the workspace renders", async () => {
    const view = await loadGraphView(db, projectId);

    expect(view.projectId).toBe(projectId);
    expect(view.items).toHaveLength(3);
    expect(view.connections).toHaveLength(2);

    const byId = new Map(view.items.map((item) => [item.id, item]));
    expect(byId.get(`${projectId}-symbol`)).toMatchObject({
      kind: "symbol",
      shape: "function",
      name: "formatPrice",
      path: "src/lib/cart.ts",
      startLine: 4,
      endLine: 9,
      fromUser: false,
      usedBy: 1,
      uses: 1,
    });
    expect(byId.get(`${projectId}-mine`)).toMatchObject({
      kind: "feature",
      label: "결제",
      fromUser: true,
      usedBy: 1,
      uses: 0,
    });

    const certainties = view.connections.map((c) => [c.relation, c.certainty]);
    expect(certainties).toEqual(
      expect.arrayContaining([
        ["contains", "certain"],
        ["belongs_to", "inferred"],
      ]),
    );
  });

  it("reports the most recent run, not the first one", async () => {
    const view = await loadGraphView(db, projectId);

    expect(view.lastRun).toEqual({
      id: `${projectId}-run-new`,
      status: "completed",
      finishedAt: "2026-09-19T00:02:00.000Z",
      filesParsed: 18,
      filesSkipped: ["src/broken.tsx"],
      error: null,
    });
  });

  it("returns an empty map for a project nobody has analysed", async () => {
    const emptyId = `${TEST_PROJECT_PREFIX}${randomUUID()}`;
    await db.insert(projects).values({
      id: emptyId,
      userId: TEST_USER_ID,
      source: "upload",
      displayName: "빈 프로젝트",
      kind: "static_site",
    });

    const view = await loadGraphView(db, emptyId);
    expect(view).toEqual({
      projectId: emptyId,
      items: [],
      connections: [],
      lastRun: null,
    });
  });
});

describe("what counts as being used", () => {
  /**
   * The product's headline sentence is "이건 N곳에서 쓰여요", so N has to be the
   * number a person would count. Structural relations are not uses: a file
   * holding a symbol is not a place that uses it, and a feature grouping is not
   * either. Counting them made `kv` report 7 on the demo repo when the parser
   * had measured 6.
   */
  it("does not count a file holding a symbol as a place that uses it", () => {
    const view = buildGraphView(
      "p",
      [
        { id: "file", type: "file", kind: null, name: "redis.js", label: null, summary: null, filePath: "lib/redis.js", startLine: null, endLine: null, origin: "static" },
        { id: "kv", type: "symbol", kind: "function", name: "kv", label: null, summary: null, filePath: "lib/redis.js", startLine: 1, endLine: 3, origin: "static" },
        { id: "caller", type: "symbol", kind: "function", name: "getPlan", label: null, summary: null, filePath: "lib/plan.js", startLine: 1, endLine: 9, origin: "static" },
      ],
      [
        { id: "e1", sourceNodeId: "file", targetNodeId: "kv", type: "contains", confidence: "certain" },
        { id: "e2", sourceNodeId: "caller", targetNodeId: "kv", type: "calls", confidence: "certain" },
      ],
      null,
    );
    const kv = view.items.find((item) => item.id === "kv");
    // One caller. Not two.
    expect(kv?.usedBy).toBe(1);
    // The connection itself is still in the graph — only the tally ignores it.
    expect(view.connections).toHaveLength(2);
  });

  it("does not count a feature grouping as a use", () => {
    const view = buildGraphView(
      "p",
      [
        { id: "feat", type: "feature", kind: null, name: "결제", label: "결제", summary: null, filePath: null, startLine: null, endLine: null, origin: "llm" },
        { id: "sym", type: "symbol", kind: "component", name: "PayButton", label: null, summary: null, filePath: "a.tsx", startLine: 1, endLine: 2, origin: "static" },
      ],
      [{ id: "e1", sourceNodeId: "sym", targetNodeId: "feat", type: "belongs_to", confidence: "inferred" }],
      null,
    );
    expect(view.items.find((i) => i.id === "feat")?.usedBy).toBe(0);
    expect(view.items.find((i) => i.id === "sym")?.uses).toBe(0);
  });

  it("counts every relation that genuinely is a use", () => {
    const view = buildGraphView(
      "p",
      [
        { id: "a", type: "symbol", kind: "function", name: "a", label: null, summary: null, filePath: "a.ts", startLine: 1, endLine: 2, origin: "static" },
        { id: "b", type: "symbol", kind: "function", name: "b", label: null, summary: null, filePath: "b.ts", startLine: 1, endLine: 2, origin: "static" },
      ],
      [
        { id: "e1", sourceNodeId: "a", targetNodeId: "b", type: "calls", confidence: "certain" },
        { id: "e2", sourceNodeId: "a", targetNodeId: "b", type: "renders", confidence: "certain" },
        { id: "e3", sourceNodeId: "a", targetNodeId: "b", type: "imports", confidence: "certain" },
        { id: "e4", sourceNodeId: "a", targetNodeId: "b", type: "fetches", confidence: "inferred" },
        { id: "e5", sourceNodeId: "a", targetNodeId: "b", type: "uses_package", confidence: "certain" },
      ],
      null,
    );
    expect(view.items.find((i) => i.id === "b")?.usedBy).toBe(5);
    expect(view.items.find((i) => i.id === "a")?.uses).toBe(5);
  });
});

/**
 * The call-site line, which reaches this file as **text**.
 *
 * `load.ts` asks Postgres for `metadata->>'line'` rather than for the whole
 * `jsonb` object — measured at 39.7 KB per load on this repository's own
 * graph, most of it import specifiers nothing reads. `->>` returns text
 * whatever the value's JSON type was, and it returns null for a missing key,
 * so every check that used to run against an unknown object now runs against
 * an unknown string. These are those checks.
 *
 * The failure this guards is specific and has a shape: a line number printed
 * into a sentence in front of someone who is already unsure whether to trust
 * us. "PayButton.tsx NaN줄에서" is worse than saying nothing.
 */
describe("the call-site line", () => {
  const withLine = (line: string | null | undefined) =>
    buildGraphView(
      PROJECT,
      [node({ id: "a" }), node({ id: "b" })],
      [edge({ id: "e1", type: "calls", ...(line === undefined ? {} : { line }) })],
      null,
    ).connections[0];

  it("reads a line back as a number", () => {
    expect(withLine("34").line).toBe(34);
  });

  it("leaves the field off entirely when there is none", () => {
    // Absent, not `undefined`. `view.ts` says absent is the only way to say
    // "no line"; a present key holding undefined would give it a second.
    for (const missing of [null, undefined, ""]) {
      expect("line" in withLine(missing)).toBe(false);
    }
  });

  it("refuses anything that is not a whole line number", () => {
    // `->>` hands back whatever was in the column. A float, a zero, a
    // negative, an object stringified by Postgres, a word — each is the
    // parser having recorded something we do not understand, and inventing a
    // number from it is the quiet guess this file exists to refuse.
    for (const bad of ["0", "-1", "3.5", "1e3", "{}", "true", "abc", " "]) {
      expect("line" in withLine(bad), bad).toBe(false);
    }
  });
});
