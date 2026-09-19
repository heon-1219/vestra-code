import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { analysisRuns } from "@/db/schema";

import type { EventSink } from "./events";
import { ingestRepo, LIMIT_MESSAGES, type IngestOutcome } from "./ingest";
import { ingestStoredUpload } from "./ingest/restore";
import { ingestUpload, type UploadPayload } from "./ingest/upload";
import { persistGraph, promoteRun } from "./persist";
import {
  createRun,
  createRunStore,
  findActiveRun,
  reapStaleRun,
  type RunStore,
} from "./run-store";
import { createShallowAnalyzer } from "./shallow/analyzer";
import type { AnalysisEmitter, Analyzer, ProjectKind } from "./types";
import { createTypescriptAnalyzer } from "./typescript/analyzer";

/**
 * One analysis run, end to end.
 *
 * Section 6.2: a plain module that takes a project and an event emitter and
 * knows nothing about HTTP. Nothing in this file reads a request, writes a
 * response or looks at a session — the route handlers above it do that and then
 * call in here, which is what keeps the pipeline testable and what would let it
 * move to a background worker without a rewrite.
 */

/** Everything the pipeline needs to know about a project. Not the whole row. */
/**
 * A project the pipeline can run on, discriminated by where its files come from.
 *
 * A union rather than optional fields, because the two cases differ in where a
 * run gets its files: a GitHub project is fetched from GitHub every time, and
 * an uploaded folder is either handed to us by the browser that picked it or
 * rebuilt from the copy we kept. Making that a type-level distinction means no
 * code path can forget which it is holding.
 */
export type AnalysisProject =
  | {
      id: string;
      source: "github";
      repoOwner: string;
      repoName: string;
      defaultBranch: string;
      kind: ProjectKind;
    }
  | { id: string; source: "upload"; kind: ProjectKind };

export type StartAnalysisResult =
  | { ok: true; runId: string; started: boolean }
  | { ok: false; message: string };

export type RunAnalysisInput = {
  db: Db;
  project: AnalysisProject;
  /**
   * The folder, when someone has just picked one. Meaningless for GitHub.
   *
   * Present for the first analysis and absent for every re-read after it: the
   * browser has the folder open once, and nobody should have to find it again
   * to re-read a project we already hold. Without it the run rebuilds the same
   * input from `project_files` — see `ingest/restore.ts`, which also decides
   * what to say about a project uploaded before we kept anything.
   */
  upload?: UploadPayload;
  runId: string;
  /** The signed-in user's GitHub token, resolved before the request ended. */
  githubToken: string | null;
  /** Injectable so a test can watch the sequence without a database. */
  sink?: EventSink;
};

/**
 * Unreachable today, and kept anyway. The shallow analyzer takes every kind the
 * deep ones refuse (D26: no repository is ever told it is unsupported), so the
 * only way here is a new `project_kind` value that nobody taught an analyzer
 * about — which is a bug, and one the user should see a sentence for rather
 * than a blank screen.
 */
const UNSUPPORTED_MESSAGE =
  "이 저장소는 아직 읽을 수 없어요. 잠시 후 다시 시도해 주시고, 계속 이러면 알려 주세요.";

const GENERIC_FAILURE_MESSAGE =
  "분석 중에 문제가 생겨서 멈췄어요. 잠시 후 다시 시도해 주세요. 이전에 만든 지도는 그대로 남아 있어요.";

const NOTHING_READABLE_MESSAGE =
  "이 저장소에서 읽을 수 있는 코드를 찾지 못했어요. 지도를 그리지 않고 멈췄고, 이전에 만든 지도는 그대로 남아 있어요.";

/** A failure with something we are willing to show the user. */
class AnalysisFailure extends Error {}

/**
 * The analyzers, in the order they are offered a project.
 *
 * A list and a `handles` call, not a registry with lifecycle and configuration:
 * D7 asked for a seam, and section 8 warns against building the framework
 * instead of the thing. Adding the static-site analyzer is one import and one
 * entry here.
 *
 * Built per run rather than once at module load, so nothing an analyzer
 * accumulates about one repository can reach the next one.
 */
const ANALYZERS: readonly (() => Analyzer)[] = [
  createTypescriptAnalyzer,
  // Last, and it has to stay last: `selectAnalyzer` takes the first analyzer
  // that says yes, and the shallow one claims `static_site` until the D6
  // static-site analyzer exists. Ahead of a deep analyzer it would shadow it
  // permanently, and today the two are disjoint so nothing would fail.
  createShallowAnalyzer,
];

/**
 * Exported for the test that pins the ordering rule above. Nothing else should
 * call it — the pipeline picks the analyzer, callers pick the project.
 */
export function selectAnalyzer(kind: ProjectKind): Analyzer | null {
  for (const create of ANALYZERS) {
    const analyzer = create();
    if (analyzer.handles(kind)) return analyzer;
  }
  return null;
}

/**
 * In-flight starts, keyed by project.
 *
 * Two clicks on "분석 시작" arrive as two requests that both read "no run in
 * progress" before either has written one, and the user gets two runs racing to
 * write the same graph. The database check below cannot close that window on
 * its own without a constraint we do not have, and the map does: the second
 * caller awaits the first caller's promise and is handed the same run id.
 *
 * Cached on globalThis because Next reloads modules on every edit in dev, and a
 * fresh module means a fresh empty map halfway through a start.
 */
const globalForPipeline = globalThis as unknown as {
  __vestraStarting?: Map<string, Promise<StartAnalysisResult>>;
};
const starting = (globalForPipeline.__vestraStarting ??= new Map());

/**
 * Create the run row and set the analysis going, without waiting for it.
 *
 * Returns as soon as there is a run id to hand back (D16): the caller gets an
 * id it can immediately open an event stream on, and the run itself outlives
 * the request that started it.
 */
export function startAnalysis(input: {
  db: Db;
  project: AnalysisProject;
  githubToken: string | null;
  /** The folder, when someone has just picked one. A re-read passes nothing. */
  upload?: UploadPayload;
}): Promise<StartAnalysisResult> {
  const pending = starting.get(input.project.id);
  if (pending) return pending;

  const attempt = start(input).finally(() => {
    starting.delete(input.project.id);
  });
  starting.set(input.project.id, attempt);
  return attempt;
}

async function start(input: {
  db: Db;
  project: AnalysisProject;
  githubToken: string | null;
  upload?: UploadPayload;
}): Promise<StartAnalysisResult> {
  const { db, project, githubToken, upload } = input;

  if (!selectAnalyzer(project.kind)) {
    return { ok: false, message: UNSUPPORTED_MESSAGE };
  }

  const active = await findActiveRun(db, project.id);
  if (active && !(await reapStaleRun(db, active))) {
    // Already working. Handing back the same id is what makes a reload during
    // an analysis reattach to it rather than start a competing one.
    return { ok: true, runId: active.id, started: false };
  }

  const runId = await createRun(db, project.id);

  // Detached on purpose. We deploy to a persistent Node process (D3), so an
  // unawaited promise keeps running after the response is sent, for as long as
  // it has work — no queue, no worker, no `after()` with a request-bound
  // duration cap. The cost is that a process restart mid-run abandons the run;
  // `reapStaleRun` is what notices and closes it out.
  void runAnalysis({ db, project, runId, githubToken, upload }).catch((error: unknown) => {
    // `runAnalysis` handles its own failures, so reaching here means the failure
    // path itself failed. On Node 22 an unhandled rejection ends the process,
    // which would take every other user's run down with it.
    console.error("[pipeline] run crashed", runId, error);
  });

  return { ok: true, runId, started: true };
}

/**
 * Ingest, analyze, persist, sweep. The order matters at every step.
 */
export async function runAnalysis(input: RunAnalysisInput): Promise<void> {
  const { db, project, runId, githubToken, upload } = input;

  const store: RunStore = input.sink
    ? { emit: input.sink, flush: () => Promise.resolve() }
    : createRunStore(db, runId);
  const emit = store.emit;

  const analyzer = selectAnalyzer(project.kind);
  let cleanup: (() => Promise<void>) | null = null;

  try {
    if (!analyzer) throw new AnalysisFailure(UNSUPPORTED_MESSAGE);

    await db
      .update(analysisRuns)
      .set({ status: "running", phase: "ingest", analyzer: analyzer.name })
      .where(eq(analysisRuns.id, runId));
    await emit("phase.changed", { phase: "ingest" });

    // Resolve the branch to a commit before downloading, so the tree we analyze
    // and the commit we record against it are the same thing by construction. A
    // push landing mid-run would otherwise date the graph to a commit it never
    // saw.
    const commitSha =
      project.source === "github"
        ? await resolveCommitSha(
            project.repoOwner,
            project.repoName,
            project.defaultBranch,
            githubToken,
          )
        : null;
    if (commitSha) {
      await db
        .update(analysisRuns)
        .set({ commitSha })
        .where(eq(analysisRuns.id, runId));
    }

    let outcome: IngestOutcome;
    if (project.source === "upload") {
      if (upload) {
        outcome = { ok: true, value: await ingestUpload(upload) };
      } else {
        // No folder in hand, so this is a re-read: build the same input from
        // the files we kept when it was first uploaded. It refuses rather than
        // returning an empty folder, because an empty ingest succeeds and a
        // successful run sweeps — a project we cannot rebuild would have its
        // map deleted by the very click meant to refresh it.
        const restored = await ingestStoredUpload(db, project.id);
        if (!restored.ok) throw new AnalysisFailure(restored.message);
        outcome = { ok: true, value: restored.value };
      }
    } else {
      outcome = await ingestRepo(
        project.repoOwner,
        project.repoName,
        commitSha ?? project.defaultBranch,
        githubToken,
        // To the log, not to the browser. There is no ingest-progress event in
        // the contract, and reusing `file.parsed` for it would put "저장소를 받는
        // 중" in the user's list of files as if it were one. The download is the
        // longest silent stretch of a run, so this is a real gap in the UI — it
        // wants an event of its own, not a misused one.
        (message) => console.log("[pipeline] ingest", runId, message),
      );
    }
    if (!outcome.ok) throw new AnalysisFailure(outcome.message);

    const { root, files, skipped, limitsHit } = outcome.value;
    cleanup = outcome.value.cleanup;

    // The denominator for progress. Assets are excluded because they are never
    // read at all, which on a repo of photographs would leave the bar a third
    // of the way along at the end. It is still an upper bound rather than an
    // exact count: which readable files a given analyzer actually parses is its
    // own business, and the demo repo parses 18 of 22 (the rest are manifests
    // and stylesheets). `run.completed` carries the real figure.
    const readableCount = files.filter((file) => file.read !== null).length;

    await emit("run.started", { analyzer: analyzer.name, fileCount: files.length });

    let filesParsed = 0;
    let nodeTotal = 0;
    let edgeTotal = 0;
    let certainTotal = 0;
    let inferredTotal = 0;
    const skippedPaths = new Set(skipped.map((entry) => entry.path));

    // The emitter is synchronous by contract — an analyzer calls it mid-parse
    // and must not await a database round trip per file. The store keeps the
    // writes ordered behind the scenes and `flush` waits for them at the end.
    const emitter: AnalysisEmitter = {
      phase: (phase) => {
        fire(emit("phase.changed", { phase }));
        fire(
          db.update(analysisRuns).set({ phase }).where(eq(analysisRuns.id, runId)),
        );
      },
      fileParsed: (path) => {
        filesParsed += 1;
        fire(emit("file.parsed", { path, parsed: filesParsed, total: readableCount }));
      },
      nodes: (added) => {
        nodeTotal += added.length;
        fire(emit("nodes.added", { count: added.length, total: nodeTotal }));
      },
      edges: (added) => {
        const certain = added.filter((edge) => edge.confidence === "certain").length;
        certainTotal += certain;
        inferredTotal += added.length - certain;
        edgeTotal += added.length;
        fire(
          emit("edges.added", {
            count: added.length,
            total: edgeTotal,
            certain: certainTotal,
            inferred: inferredTotal,
          }),
        );
      },
      fileSkipped: (path, reason) => {
        skippedPaths.add(path);
        fire(emit("file.skipped", { path, reason }));
      },
    };

    const graph = await analyzer.analyze(files, root, emitter);
    await store.flush();

    // D36's tripwire. Every silent-emptiness failure this parser has — `allowJs`
    // off putting zero files in the program, a resolution change emptying the
    // name index — looks exactly like a successful run of an empty repository,
    // and the sweep that follows a success would then replace a correct graph
    // with nothing. Widened from D36's `filesParsed > 0` to also accept a graph
    // with content, so an analyzer that reports progress differently cannot
    // trip it by accident.
    if (readableCount > 0 && filesParsed === 0 && graph.nodes.length === 0) {
      throw new AnalysisFailure(NOTHING_READABLE_MESSAGE);
    }

    const written = await persistGraph(db, project.id, runId, graph.nodes, graph.edges);
    if (written.nodesDropped > 0 || written.edgesDropped > 0) {
      console.warn(
        "[pipeline] dropped rows",
        runId,
        { nodes: written.nodesDropped, edges: written.edgesDropped },
        written.droppedSamples,
      );
    }

    // Carry forward, then sweep, in one transaction — and only here, on the
    // success path. A file that became unparseable this run still has correct
    // rows from the last one, and sweeping them takes every connection from
    // healthy files with them through the cascade (D37).
    await promoteRun(db, project.id, runId, [...skippedPaths]);

    // Row first, then the event. A client that closes on `run.completed` and
    // then reads the project would otherwise be able to see a run still marked
    // running.
    await db
      .update(analysisRuns)
      .set({
        status: "completed",
        phase: "done",
        filesParsed,
        nodeCount: written.nodesWritten,
        edgeCount: written.edgesWritten,
        filesSkipped: [...skippedPaths],
        finishedAt: new Date(),
      })
      .where(eq(analysisRuns.id, runId));

    await emit("run.completed", {
      nodeCount: written.nodesWritten,
      edgeCount: written.edgesWritten,
      filesParsed,
      filesSkipped: skippedPaths.size,
      limits: limitsHit.map((limit) => LIMIT_MESSAGES[limit]),
    });
    await store.flush();
  } catch (error) {
    const message =
      error instanceof AnalysisFailure ? error.message : GENERIC_FAILURE_MESSAGE;
    console.error("[pipeline] run failed", runId, error);

    // No sweep on this path, deliberately. D20: a failed run drops its own work
    // and the previous graph stands, rather than the user watching their map
    // empty out because a download timed out.
    try {
      await db
        .update(analysisRuns)
        .set({ status: "failed", error: message, finishedAt: new Date() })
        .where(eq(analysisRuns.id, runId));
    } catch (updateError) {
      console.error("[pipeline] could not mark run failed", runId, updateError);
    }

    await emit("run.failed", { message });
    await store.flush();
  } finally {
    // Section 6.2: delete the temp directory when the run ends, including on
    // failure. `cleanup` swallows its own errors — a directory we cannot remove
    // is a disk problem, not the user's.
    if (cleanup) await cleanup();
  }
}

/**
 * Attach a handler to a promise we are not awaiting.
 *
 * The emitter contract is synchronous, so its writes are fire-and-forget. An
 * unhandled rejection on Node 22 terminates the process, which would turn a
 * missed progress line into a restart of the server.
 */
function fire(promise: Promise<unknown>): void {
  void promise.catch((error: unknown) => {
    console.error("[pipeline] emit failed", error);
  });
}

const commitSchema = z.object({ sha: z.string() });

/**
 * The commit a ref currently points at, or null.
 *
 * Belongs in `src/lib/github/api.ts` beside the other calls; it is here because
 * that file is being edited elsewhere. Best effort by design — a run without a
 * recorded commit is a graph that cannot be dated, which is worth strictly less
 * than a run that did not happen.
 */
async function resolveCommitSha(
  owner: string,
  repo: string,
  ref: string,
  token: string | null,
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "vestra-code",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return null;

    const parsed = commitSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.sha : null;
  } catch {
    return null;
  }
}
