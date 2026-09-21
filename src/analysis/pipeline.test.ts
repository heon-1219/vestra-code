import { randomUUID } from "node:crypto";

import { config } from "dotenv";
import { describe, expect, it } from "vitest";

import type { Db } from "@/db";

import type { AnalysisEvent } from "./events";
import {
  ingestStoredUpload,
  NO_CODE_MESSAGE,
  NOT_STORED_MESSAGE,
} from "./ingest/restore";
import { llmCoveragePayload, manifestsIn, selectAnalyzer } from "./pipeline";
import { createRunStore } from "./run-store";
import { createShallowAnalyzer } from "./shallow/analyzer";
import { createTypescriptAnalyzer } from "./typescript/analyzer";
import type { SourceFile } from "./types";

/**
 * What the store has to guarantee, and one live run of the whole pipeline.
 *
 * The ordering test is the one that matters most and is the easiest to lose:
 * the SSE reader advances a cursor, so an event that commits after a
 * higher-numbered one has already been read is an event nobody ever sees, and
 * nothing anywhere reports it. It fails under a naive fire-and-forget emitter
 * and passes under the chained one.
 */

type Insert = { seq: number; type: string };

/**
 * A database that commits in the worst order it is allowed to.
 *
 * Later inserts resolve sooner, which is what an unchained emitter would do to
 * a real connection pool under load, only reliably.
 */
function adversarialDb(committed: Insert[], failOnSeq?: number, statements?: number[]) {
  // One row or many, the way drizzle's `values` takes either. A statement that
  // holds the failing row fails whole, the way a real one does.
  const values = (row: unknown) => {
    const rows = (Array.isArray(row) ? row : [row]) as Insert[];
    statements?.push(rows.length);
    const delay = Math.max(0, 40 - rows[0].seq * 4);
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        if (rows.some((insert) => insert.seq === failOnSeq)) {
          reject(new Error("connection reset"));
          return;
        }
        for (const insert of rows) committed.push({ seq: insert.seq, type: insert.type });
        resolve();
      }, delay);
    });
  };

  // A stub standing in for two methods of a large generic client. Cast rather
  // than mocked because the store only ever calls `insert().values()`, and
  // building the rest would test the mock instead of the store.
  return { insert: () => ({ values }) } as unknown as Db;
}

describe("run store", () => {
  it("persists events in sequence order even when writes finish out of order", async () => {
    const committed: Insert[] = [];
    const store = createRunStore(adversarialDb(committed), randomUUID());

    // Fired without awaiting, exactly as the synchronous AnalysisEmitter does.
    store.emit("phase.changed", { phase: "static" });
    for (let i = 1; i <= 6; i += 1) {
      store.emit("file.parsed", { path: `src/file-${i}.ts`, parsed: i, total: 6 });
    }
    store.emit("run.completed", {
      nodeCount: 68,
      edgeCount: 121,
      filesParsed: 6,
      filesSkipped: 0,
      limits: [],
    });

    await store.flush();

    expect(committed.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(committed[0].type).toBe("phase.changed");
    expect(committed.at(-1)?.type).toBe("run.completed");
  });

  it("keeps going when one event cannot be written", async () => {
    const committed: Insert[] = [];
    const store = createRunStore(adversarialDb(committed, 2), randomUUID());

    store.emit("phase.changed", { phase: "static" });
    store.emit("file.parsed", { path: "src/a.ts", parsed: 1, total: 2 });
    store.emit("file.parsed", { path: "src/b.ts", parsed: 2, total: 2 });

    // A dropped progress line must not reject into the analysis behind it.
    await expect(store.flush()).resolves.toBeUndefined();
    expect(committed.map((row) => row.seq)).toEqual([1, 3]);
  });

  it("sends a burst of events in a few statements rather than one round trip each", async () => {
    /*
     * D159. A full re-read of `vestra-code` spent 22.9 s writing 268
     * `file.parsed` rows one round trip at a time, after the parser that
     * produced them had finished. The rows still have to arrive in order;
     * they do not have to arrive one by one.
     */
    const committed: Insert[] = [];
    const statements: number[] = [];
    const store = createRunStore(adversarialDb(committed, undefined, statements), randomUUID());

    for (let i = 1; i <= 300; i += 1) {
      store.emit("file.parsed", { path: `src/file-${i}.ts`, parsed: i, total: 300 });
    }
    await store.flush();

    expect(committed.map((row) => row.seq)).toEqual(
      Array.from({ length: 300 }, (_, at) => at + 1),
    );
    expect(statements.length).toBeLessThanOrEqual(2);
    expect(statements.reduce((sum, rows) => sum + rows, 0)).toBe(300);
  });

  it("keeps order while events keep arriving during a write", async () => {
    const committed: Insert[] = [];
    const statements: number[] = [];
    const store = createRunStore(adversarialDb(committed, undefined, statements), randomUUID());

    for (let i = 1; i <= 10; i += 1) {
      store.emit("file.parsed", { path: `src/a-${i}.ts`, parsed: i, total: 20 });
      // Let the first statement leave before the next events are queued.
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let i = 11; i <= 20; i += 1) {
      store.emit("file.parsed", { path: `src/b-${i}.ts`, parsed: i, total: 20 });
    }
    await store.flush();

    expect(committed.map((row) => row.seq)).toEqual(
      Array.from({ length: 20 }, (_, at) => at + 1),
    );
    expect(statements.length).toBeLessThan(20);
  });
});

/**
 * The whole pipeline, against the real database and the real demo repository.
 *
 * Gated the same way as the other live tests. It writes a throwaway user and
 * project, runs `startAnalysis`, and then tails `analysis_events` exactly the
 * way the SSE route does — which is the only way to find out whether a detached
 * run actually reaches a browser, since nothing about that is visible from the
 * pipeline's return value.
 *
 *   VESTRA_LIVE=1 npm test -- src/analysis/pipeline.test.ts
 */
describe("analyzer selection", () => {
  // Every value of `project_kind` has to reach an analyzer, because the branch
  // that handles "none of them said yes" is a Korean sentence telling the user
  // we cannot read their repository — and D26 is that we never say that.
  const kinds = ["nextjs", "react_spa", "static_site", "unsupported"] as const;

  it.each(kinds)("gives %s an analyzer", (kind) => {
    expect(selectAnalyzer(kind)?.name).toBeTypeOf("string");
  });

  it("sends React and Next.js projects to the deep analyzer", () => {
    expect(selectAnalyzer("nextjs")?.name).toBe("typescript");
    expect(selectAnalyzer("react_spa")?.name).toBe("typescript");
  });

  it("sends everything else to the shallow one", () => {
    expect(selectAnalyzer("static_site")?.name).toBe("shallow");
    expect(selectAnalyzer("unsupported")?.name).toBe("shallow");
  });

  // The ordering rule, pinned rather than left in a comment. The shallow
  // analyzer claims `static_site` only because the D6 static-site analyzer does
  // not exist yet; if it is ever moved ahead of a deep analyzer it would take
  // that analyzer's projects silently, and every one of them would lose its
  // certain edges.
  it("never lets the shallow analyzer answer for a kind a deep one handles", () => {
    const shallow = createShallowAnalyzer();
    const deep = createTypescriptAnalyzer();
    const contested = kinds.filter((kind) => shallow.handles(kind) && deep.handles(kind));
    expect(contested).toEqual([]);
  });
});

/**
 * What the run says about the files the model never opened.
 *
 * The one decision in it: when to stay silent. **"We did not look" and "there
 * is nothing there" are opposite claims**, and this function is where both
 * mistakes are possible — reporting a shortfall over a project that never had a
 * model, or staying quiet about a cap that halved the answer. Tested without a
 * database, a repository or a model, because it is the part that decides what a
 * person is told.
 */
describe("the model's coverage, as the run reports it", () => {
  it("says nothing for a project with no model configured", () => {
    // The Python analyzer writes `llmExamined` only when a model pass ran, so
    // with no model both counts are zero and there is no reason to report.
    // The parser half still produced a graph, and that is not a failure.
    expect(llmCoveragePayload({ examined: 0, notExamined: 0 }, null)).toBeNull();
  });

  it("says nothing when the model opened every file", () => {
    expect(
      llmCoveragePayload({ examined: 120, notExamined: 0 }, "completed"),
    ).toBeNull();
  });

  it("refuses to report a gap it cannot explain", () => {
    // Counts with no reason behind them. Silence beats a cause we made up.
    expect(llmCoveragePayload({ examined: 40, notExamined: 80 }, null)).toBeNull();
  });

  it("carries both counts and the reason when the file cap stopped it", () => {
    expect(
      llmCoveragePayload({ examined: 40, notExamined: 80 }, "file_budget"),
    ).toEqual({ examined: 40, notExamined: 80, reason: "file_budget" });
  });

  it("keeps a budget and a failure apart", () => {
    const budget = llmCoveragePayload({ examined: 40, notExamined: 80 }, "token_budget");
    const broke = llmCoveragePayload({ examined: 40, notExamined: 80 }, "llm_error");

    expect(budget?.reason).toBe("token_budget");
    expect(broke?.reason).toBe("llm_error");
  });

  it("calls a pass that finished with files left over a failure, not a budget", () => {
    // `stopped: "completed"` with files in `notExamined` is the one case that
    // needs translating: a retryable model call failed on those files and the
    // pass walked past them. Nothing was capped, so reporting a budget would
    // send someone looking for a limit that was never reached.
    expect(
      llmCoveragePayload({ examined: 39, notExamined: 1 }, "completed")?.reason,
    ).toBe("llm_error");
  });

  it("reports a run that was stopped as stopped", () => {
    expect(
      llmCoveragePayload({ examined: 12, notExamined: 30 }, "aborted")?.reason,
    ).toBe("aborted");
  });
});

/**
 * The other half of the upload story: what a run is handed when nobody picked
 * a folder.
 *
 * Tested without a database because everything that can go wrong here is a
 * decision rather than SQL — which stored rows are code, where the asset list
 * comes from now that nothing holds it, and what we say about a project we
 * cannot rebuild. The round trip is the opt-in DB test's job.
 */
type KeptRow = { path: string; size: number; content?: string };
type FileNodeRow = { filePath: string | null; metadata: Record<string, unknown> };

/**
 * A database holding one project's kept files and the file nodes of its map.
 *
 * The `WHERE path IN (...)` of a read is not emulated: no test below keeps a
 * file the restore would not ask for, so handing back everything is the same
 * answer Postgres would give.
 */
function keptDb(kept: KeptRow[], fileNodes: FileNodeRow[] = []) {
  type Chain = {
    from: () => Chain;
    where: () => Chain;
    orderBy: () => Promise<unknown[]>;
  };

  const db = {
    select(columns: Record<string, unknown>) {
      const wanted = Object.keys(columns);
      const answer: unknown[] = wanted.includes("metadata")
        ? fileNodes
        : kept.map((row) =>
            wanted.includes("content")
              ? {
                  path: row.path,
                  size: row.size,
                  content: Buffer.from(row.content ?? "", "utf8"),
                }
              : { path: row.path, size: row.size },
          );
      const chain: Chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => Promise.resolve(answer),
      };
      return chain;
    },
  };

  return db as unknown as Db;
}

describe("re-reading an uploaded folder from what we kept", () => {
  it("says so plainly when the project was uploaded before we kept files", async () => {
    // The case that has to be right: those rows do not exist and never will, so
    // the only way forward is the folder on their machine. Drawing an empty map
    // instead would delete the one they already have.
    const outcome = await ingestStoredUpload(keptDb([]), "p1");

    expect(outcome).toEqual({ ok: false, message: NOT_STORED_MESSAGE });
    expect(NOT_STORED_MESSAGE).toContain("폴더를 한 번 더 골라주셔야 해요");
  });

  it("refuses when what we kept holds no code at all", async () => {
    // A picture is not something an analyzer can read. Running on it would
    // succeed with an empty graph, and a successful run sweeps.
    const outcome = await ingestStoredUpload(
      keptDb([{ path: "public/logo.png", size: 2_048 }]),
      "p1",
    );

    expect(outcome).toEqual({ ok: false, message: NO_CODE_MESSAGE });
  });

  it("rebuilds the folder, assets included, from the stored text and the map", async () => {
    const outcome = await ingestStoredUpload(
      keptDb(
        [
          {
            path: "src/price.ts",
            size: 44,
            content: "export function formatPrice(n: number) { return n; }\n",
          },
        ],
        [
          { filePath: "src/price.ts", metadata: { size: 44 } },
          // A video is never previewable, so its bytes were never stored and
          // this node is the only record that the folder contains it.
          {
            filePath: "public/intro.mp4",
            metadata: { asset: true, size: 9_000_000 },
          },
        ],
      ),
      "p1",
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    try {
      const files = outcome.value.files;
      expect(files.map((file) => file.path).sort()).toEqual([
        "public/intro.mp4",
        "src/price.ts",
      ]);

      // Text comes back byte for byte, and on disk — ts-morph resolves modules
      // through the filesystem, which is why this goes through `ingestUpload`
      // rather than beside it.
      const code = files.find((file) => file.path === "src/price.ts");
      expect(code?.read?.()).toContain("formatPrice");

      // And the asset node survives the re-read. Losing it would mean the map
      // quietly stopped being able to say "이 영상은 아무 데서도 안 써요".
      const video = files.find((file) => file.path === "public/intro.mp4");
      expect(video?.read).toBeNull();
      expect(video?.size).toBe(9_000_000);
    } finally {
      await outcome.value.cleanup();
    }
  });

  it("reports a file whose bytes we do not have, so its place on the map survives", async () => {
    const outcome = await ingestStoredUpload(
      keptDb(
        [{ path: "src/app.ts", size: 20, content: "export const a = 1;\n" }],
        [
          { filePath: "src/app.ts", metadata: { size: 20 } },
          { filePath: "src/gone.ts", metadata: { size: 31 } },
        ],
      ),
      "p1",
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    try {
      // Skipped rather than absent: the pipeline hands these paths to
      // `promoteRun`, which carries their rows past the sweep (D37). Absent,
      // the node would go and the cascade would take healthy files' edges to it.
      expect(outcome.value.skipped).toContainEqual({
        path: "src/gone.ts",
        reason: expect.stringContaining("보관해 둔 내용이 없어서"),
      });
      expect(outcome.value.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    } finally {
      await outcome.value.cleanup();
    }
  });
});

// The live block reaches the real database through `@/db`, which validates the
// whole environment at import time and throws if one variable is missing. Vitest
// gives each test file its own worker, so another file's dotenv call does not
// reach this one — without this line the live run fails on DATABASE_URL rather
// than on anything it was written to test.
config({ path: ".env.local", quiet: true });

const live = process.env.VESTRA_LIVE ? describe : describe.skip;

live("analysis pipeline against the demo repo", () => {
  it("runs detached, streams to a cursor, and refuses to start twice", async () => {
    const { db } = await import("@/db");
    const { analysisRuns, projects, user } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { startAnalysis } = await import("./pipeline");
    const { readEventsAfter } = await import("./run-store");

    const userId = `test-${randomUUID()}`;
    const projectId = randomUUID();

    await db.insert(user).values({
      id: userId,
      name: "pipeline test",
      email: `${userId}@vestra.test`,
    });
    await db.insert(projects).values({
      id: projectId,
      userId,
      repoOwner: "heon-1219",
      repoName: "coding-interview-prep",
      repoUrl: "https://github.com/heon-1219/coding-interview-prep",
      defaultBranch: "master",
      displayName: "coding-interview-prep",
      kind: "nextjs",
    });

    try {
      const project = {
        id: projectId,
        source: "github" as const,
        repoOwner: "heon-1219",
        repoName: "coding-interview-prep",
        defaultBranch: "master",
        kind: "nextjs" as const,
      };

      const first = await startAnalysis({ db, project, githubToken: null });
      expect(first.ok && first.started).toBe(true);
      if (!first.ok) return;

      // The in-flight rule: a second start hands back the same run rather than
      // racing a second one against the same graph.
      const second = await startAnalysis({ db, project, githubToken: null });
      expect(second).toEqual({ ok: true, runId: first.runId, started: false });

      // Tail by cursor, as the SSE route does.
      const seen: AnalysisEvent[] = [];
      let cursor = 0;
      const deadline = Date.now() + 180_000;
      let terminal: AnalysisEvent | undefined;

      while (!terminal && Date.now() < deadline) {
        const batch = await readEventsAfter(db, first.runId, cursor, 500);
        for (const event of batch) {
          cursor = event.seq;
          seen.push(event);
          if (event.type === "run.completed" || event.type === "run.failed") {
            terminal = event;
          }
        }
        if (!terminal) await new Promise((resolve) => setTimeout(resolve, 400));
      }

      console.log("  events:", seen.length, "last seq:", cursor);
      console.log("  terminal:", terminal?.type, JSON.stringify(terminal?.payload));

      expect(terminal?.type).toBe("run.completed");
      expect(seen.map((event) => event.seq)).toEqual(
        seen.map((_, index) => index + 1),
      );

      // Resuming from a cursor returns the tail and nothing before it, which is
      // what a mid-run refresh depends on.
      const resumed = await readEventsAfter(db, first.runId, cursor - 3, 500);
      expect(resumed.map((event) => event.seq)).toEqual([
        cursor - 2,
        cursor - 1,
        cursor,
      ]);

      const [run] = await db
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, first.runId));

      console.log(
        "  run:",
        run.status,
        run.phase,
        `files=${run.filesParsed}`,
        `nodes=${run.nodeCount}`,
        `edges=${run.edgeCount}`,
        `commit=${run.commitSha?.slice(0, 8)}`,
      );

      expect(run.status).toBe("completed");
      expect(run.analyzer).toBe("typescript");
      expect(run.filesParsed).toBeGreaterThan(0);
      // Measured on this repo (DECISIONS): 22 files, 38 symbols, 4 API
      // endpoints, 1 route, 3 packages, 121 edges.
      //
      // These are exact on purpose — a drift in either number means the parser
      // changed behaviour, and that is worth failing over. It last moved from
      // 119 when calls inside event handlers stopped being dropped, which added
      // one call edge and one renders edge on this repo.
      //
      // The tradeoff, stated so nobody is surprised: this pins counts against
      // an external repository we do not control. It is gated behind
      // VESTRA_LIVE and never runs in the hermetic suite; the fixture tests are
      // what actually protect the parser.
      expect(run.nodeCount).toBe(68);
      expect(run.edgeCount).toBe(121);
      expect(run.commitSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      // Cascades through projects, runs, events, nodes and edges.
      await db.delete(user).where(eq(user.id, userId));
    }
  }, 240_000);
});

/**
 * Re-reading what a project is, from the files that actually arrived.
 *
 * The stored `kind` is decided when a project is added and was never looked at
 * again, so a project kept the answer the product gave on the day it was
 * connected — for ever. When the Python analyzer landed, every Python
 * repository already in the database stayed `unsupported` and kept getting the
 * shallow one no matter how often it was re-read.
 *
 * `detectProject` and `selectAnalyzer` are both tested elsewhere; what is new
 * is gathering the manifests detection needs out of files already on disk
 * rather than fetching them one at a time over the network.
 */
function sourceFile(path: string, text: string | null): SourceFile {
  return {
    path,
    absolutePath: `/tmp/${path}`,
    size: text?.length ?? 0,
    read: text === null ? null : () => text,
  };
}

describe("the manifests a re-read judges a project by", () => {
  it("reads the package.json files off the tree", () => {
    const found = manifestsIn([
      sourceFile("package.json", JSON.stringify({ dependencies: { next: "16" } })),
      sourceFile("src/index.ts", "export const a = 1;"),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("package.json");
    expect(found[0].json).toEqual({ dependencies: { next: "16" } });
  });

  it("keeps a manifest that will not parse, rather than dropping it", () => {
    /*
     * Its presence is a signal in its own right — it says something builds
     * this. Dropping it would let a project with one broken `package.json`
     * read as a hand-written site and lose the analyzer it should have had.
     */
    const found = manifestsIn([sourceFile("package.json", "{ this is not json")]);

    expect(found).toHaveLength(1);
    expect(found[0].json).toBeNull();
  });

  it("ignores vendored manifests, the way detection does", () => {
    const found = manifestsIn([
      sourceFile("node_modules/react/package.json", "{}"),
      sourceFile("main.py", "print(1)"),
    ]);

    expect(found).toEqual([]);
  });

  it("skips a manifest whose bytes we never held", () => {
    // An asset, or a file ingest declined to read. There is nothing to parse
    // and pretending otherwise would put `json: null` on a file that is fine.
    const found = manifestsIn([sourceFile("package.json", null)]);

    expect(found).toEqual([]);
  });
});
