import { randomUUID } from "node:crypto";

import { config } from "dotenv";
import { describe, expect, it } from "vitest";

import type { Db } from "@/db";

import type { AnalysisEvent } from "./events";
import { selectAnalyzer } from "./pipeline";
import { createRunStore } from "./run-store";
import { createShallowAnalyzer } from "./shallow/analyzer";
import { createTypescriptAnalyzer } from "./typescript/analyzer";

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
function adversarialDb(committed: Insert[], failOnSeq?: number) {
  const values = (row: unknown) => {
    const insert = row as Insert;
    const delay = Math.max(0, 40 - insert.seq * 4);
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        if (insert.seq === failOnSeq) {
          reject(new Error("connection reset"));
          return;
        }
        committed.push({ seq: insert.seq, type: insert.type });
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
