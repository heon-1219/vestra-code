import { eq } from "drizzle-orm";

import type { Db } from "@/db";
import { analysisRuns, projects } from "@/db/schema";
import {
  compareCommits,
  fetchCommitSha,
  type GithubFailure,
  type RepoComparison,
} from "@/lib/github/api";
import {
  detectProject,
  manifestsToFetch,
  type PackageManifest,
} from "@/lib/github/detect";

import type { AnalysisEventPayloads, EventSink } from "./events";
import {
  ANALYZER_VERSION,
  FULL_REASON_NOTES,
  loadPreviousShape,
  planChangeScope,
  resolveWriteScope,
  selectOwnedRows,
  type ChangeScope,
  type WriteScope,
} from "./incremental";
// Type only. A runtime import of `@/lib/llm` reaches `env.ts`, which validates
// eleven server variables at import time and throws when any is missing —
// correct for a server that must not boot half-configured, fatal for a unit
// test of this file. The model is injected by the caller instead.
import type { Llm } from "@/lib/llm/types";

import { ingestRepo, LIMIT_MESSAGES, type IngestOutcome } from "./ingest";
import { ingestStoredUpload } from "./ingest/restore";
import { ingestUpload, type UploadPayload } from "./ingest/upload";
import { graphSize, persistGraph, promoteRun } from "./persist";
import {
  createRun,
  createRunStore,
  findActiveRun,
  findBaseRun,
  reapStaleRun,
  type RunStore,
} from "./run-store";
import { createPythonAnalyzer, pythonLlmCoverage } from "./python/analyzer";
// Type only, and only for the reason the model pass stopped. The counts are
// read back off the nodes; this is the one fact the graph itself cannot carry.
import type { PythonLlmResult } from "./python/llm";
import { runPurposeLayer } from "./purpose";
import { runSemanticLayer } from "./semantic";
import { createShallowAnalyzer } from "./shallow/analyzer";
import type {
  AnalysisEmitter,
  AnalyzedEdge,
  AnalyzedNode,
  Analyzer,
  ProjectKind,
  SourceFile,
} from "./types";
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
  /**
   * The model, for the analyzers that use one. Null is ordinary.
   *
   * Resolved by the caller rather than read here, because reading it means
   * importing `env.ts`, which validates the whole environment at import and
   * throws — right for a route, fatal for a unit test of this module.
   */
  llm?: Llm | null;
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
 * The manifests detection wants, read from the files we already hold.
 *
 * `detectProject` takes parsed `package.json` bodies because the add-project
 * path fetches them one at a time over the network. By the time a run reaches
 * here the whole tree is on disk, so they are simply read.
 *
 * A manifest that will not parse is still recorded, with `json: null`. Its
 * presence is a detection signal in its own right — it says "something builds
 * this" — and dropping it would let a project with one broken `package.json`
 * read as a hand-written site.
 */
export function manifestsIn(files: readonly SourceFile[]): PackageManifest[] {
  const wanted = new Set(manifestsToFetch(files.map((file) => file.path)));
  const manifests: PackageManifest[] = [];

  for (const file of files) {
    if (!wanted.has(file.path) || !file.read) continue;
    try {
      manifests.push({ path: file.path, json: JSON.parse(file.read()) });
    } catch {
      manifests.push({ path: file.path, json: null });
    }
  }

  return manifests;
}

/**
 * What an analyzer is built from: the model, and a way to hand back what the
 * model pass could not reach.
 *
 * An object rather than a second positional argument, so an analyzer that never
 * takes a model keeps ignoring the whole thing, and so adding a third fact
 * later does not renumber anyone's parameters.
 */
type AnalyzerContext = {
  llm: Llm | null;
  /**
   * Why the model stopped, when it stopped short. `Analyzer.analyze` returns
   * nodes and edges, so there is nowhere in its return value for this — and the
   * counts alone cannot say whether a cap or a failure produced them.
   */
  onLlmResult?: (result: PythonLlmResult) => void;
};

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
const ANALYZERS: readonly ((context: AnalyzerContext) => Analyzer)[] = [
  () => createTypescriptAnalyzer(),
  /*
   * The one analyzer that takes a model, which is why the list is built from
   * the model rather than from nothing.
   *
   * A null model is an ordinary state, not a failure: the analyzer then runs
   * its parser half alone and produces a smaller honest graph. Python's
   * imports are `certain` without any model at all; only the calls need one.
   */
  ({ llm, onLlmResult }) =>
    createPythonAnalyzer({ llm, ...(onLlmResult ? { onLlmResult } : {}) }),
  // Last, and it has to stay last: `selectAnalyzer` takes the first analyzer
  // that says yes, and the shallow one claims `static_site` until the D6
  // static-site analyzer exists. Ahead of a deep analyzer it would shadow it
  // permanently, and today the two are disjoint so nothing would fail.
  () => createShallowAnalyzer(),
];

/**
 * Exported for the test that pins the ordering rule above. Nothing else should
 * call it — the pipeline picks the analyzer, callers pick the project.
 */
export function selectAnalyzer(
  kind: ProjectKind,
  llm: Llm | null = null,
  onLlmResult?: (result: PythonLlmResult) => void,
): Analyzer | null {
  for (const create of ANALYZERS) {
    const analyzer = create({
      llm,
      ...(onLlmResult ? { onLlmResult } : {}),
    });
    if (analyzer.handles(kind)) return analyzer;
  }
  return null;
}

/**
 * The coverage event's payload, or nothing when there is nothing to say.
 *
 * Nothing is the answer in two ordinary cases, and neither is a failure:
 *
 *   - **No model.** `pythonLlmCoverage` reads a flag the model pass writes onto
 *     each file node, so a project with no model configured has no flags and
 *     counts zero of each. The parser half ran alone and produced a smaller
 *     honest graph; reporting "0개 열어 봤어요" over it would turn that into a
 *     fault the user cannot fix and did not cause.
 *   - **Full coverage.** Every file opened. A run with nothing missing must not
 *     put a number on screen that reads as a shortfall.
 *
 * Separated out and exported so the mapping can be tested without a database, a
 * repository or a model — it is the one piece of this that decides what a
 * person is told.
 */
export function llmCoveragePayload(
  coverage: { examined: number; notExamined: number },
  stopped: PythonLlmResult["stopped"] | null,
): AnalysisEventPayloads["llm.coverage"] | null {
  if (coverage.notExamined <= 0) return null;
  // No model pass ran, so we have counts we cannot explain. Unreachable while
  // the flags and the callback come from the same block of the analyzer, and
  // kept because a number with an invented cause is worse than silence.
  if (stopped === null) return null;

  return {
    examined: coverage.examined,
    notExamined: coverage.notExamined,
    /*
     * `completed` with files left over is the one case that needs translating:
     * the pass walked past a file whose model call failed in a way worth
     * retrying and finished the rest. Nothing was capped, so calling it a
     * budget would be a lie — it belongs with the failures.
     */
    reason: stopped === "completed" ? "llm_error" : stopped,
  };
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
  /** The model, for the analyzers that use one. See `RunAnalysisInput.llm`. */
  llm?: Llm | null;
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
  llm?: Llm | null;
}): Promise<StartAnalysisResult> {
  const { db, project, githubToken, upload, llm } = input;

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
  void runAnalysis({ db, project, runId, githubToken, upload, llm }).catch((error: unknown) => {
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

  /*
   * Why the model pass stopped, filled in by the analyzer during `analyze`.
   *
   * A box rather than a bare `let`, because the only writer is a callback and a
   * variable assigned from one reads as permanently null to anyone skimming —
   * including, in some positions, the compiler.
   */
  const modelPass: { stopped: PythonLlmResult["stopped"] | null } = {
    stopped: null,
  };

  const chooseAnalyzer = (kind: ProjectKind) =>
    selectAnalyzer(kind, input.llm ?? null, (result) => {
      modelPass.stopped = result.stopped;
    });

  /*
   * Chosen twice: once from what we recorded, once from what actually arrived.
   *
   * The stored `kind` was decided when the project was added and never looked
   * at again, so a project keeps the answer the product gave on the day it was
   * connected — for ever. When the Python analyzer landed, every Python
   * repository already in the database stayed `unsupported` and kept getting
   * the shallow analyzer no matter how many times it was re-read. The feature
   * was unreachable for exactly the projects it was written for.
   *
   * The first choice still happens here because the run row records an analyzer
   * name before ingest. The second happens below, once the files are in hand,
   * which is the only moment the question can actually be answered.
   */
  let analyzer = chooseAnalyzer(project.kind);
  let cleanup: (() => Promise<void>) | null = null;

  try {
    if (!analyzer) throw new AnalysisFailure(UNSUPPORTED_MESSAGE);

    await db
      .update(analysisRuns)
      .set({
        status: "running",
        phase: "ingest",
        analyzer: analyzer.name,
        // Recorded on the run that produces the graph, not read from it, so the
        // *next* run can refuse to carry forward rows a different parser made.
        analyzerVersion: ANALYZER_VERSION,
      })
      .where(eq(analysisRuns.id, runId));
    await emit("phase.changed", { phase: "ingest" });

    // Resolve the branch to a commit before downloading, so the tree we analyze
    // and the commit we record against it are the same thing by construction. A
    // push landing mid-run would otherwise date the graph to a commit it never
    // saw.
    const commitSha =
      project.source === "github"
        ? await fetchCommitSha(
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

    // Ask what changed before downloading anything. It cannot make this run
    // faster — Pass 1 has to see the whole tree either way, for reasons
    // measured in `incremental.ts` — but it decides which rows this run
    // re-states, and it is the answer Pass 2 will need when it lands.
    const changeScope = await planRun({
      db,
      project,
      analyzerName: analyzer.name,
      headSha: commitSha,
      githubToken,
      runId,
    });

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

    /*
     * What this project turned out to be, judged on the files that arrived.
     *
     * Only ever widens what we can read, never narrows it: `selectAnalyzer`
     * falls through to the shallow analyzer for anything nobody claims, so the
     * worst outcome of a wrong re-reading is the analyzer the project already
     * had. And it is written back, because the stored kind is what the rest of
     * the product reads — the sentence on the project card, and the first
     * choice on the next run before any file is in hand.
     *
     * A changed kind means a changed analyzer, which `planChangeScope` already
     * refuses to go incremental against: the base graph was built by a
     * different parser and carrying its rows forward would leave the map a
     * mixture of two with nothing to say which is which.
     */
    const detected = detectProject(
      files.map((file) => file.path),
      manifestsIn(files),
    );
    if (detected.kind !== project.kind) {
      const rechosen = chooseAnalyzer(detected.kind);
      if (rechosen) {
        console.log(
          "[pipeline] kind changed",
          runId,
          `${project.kind} -> ${detected.kind} (${analyzer?.name ?? "none"} -> ${rechosen.name})`,
        );
        analyzer = rechosen;
        await db
          .update(projects)
          .set({ kind: detected.kind })
          .where(eq(projects.id, project.id));
        await db
          .update(analysisRuns)
          .set({ analyzer: rechosen.name })
          .where(eq(analysisRuns.id, runId));
      }
    }
    if (!analyzer) throw new AnalysisFailure(UNSUPPORTED_MESSAGE);

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
    const setPhase = (phase: "ingest" | "static" | "semantic" | "done") => {
      fire(emit("phase.changed", { phase }));
      fire(db.update(analysisRuns).set({ phase }).where(eq(analysisRuns.id, runId)));
    };

    const emitter: AnalysisEmitter = {
      /*
       * An analyzer knows when ITS work is finished. Only the pipeline knows
       * when the RUN is, and since Pass 2 landed those are no longer the same
       * moment — every analyzer ends by announcing `done`, and Pass 2 then runs
       * for another twenty seconds. Passing that through would take the
       * workspace checklist to 다 됐어요 and then back to 기능 이름 붙이는 중, which
       * reads as the analysis having restarted.
       *
       * Swallowed here rather than deleted from the three analyzers, because
       * the analyzers are right about their own half and this is the one place
       * that knows about the other one.
       */
      phase: (phase) => {
        if (phase === "done") return;
        setPhase(phase);
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

    /*
     * How much of the project the model actually opened.
     *
     * The counts are read back off the nodes rather than plumbed through a
     * callback, because the analyzer already writes them onto every file node
     * and a second channel for the same fact is a second thing to keep in step.
     * Only the reason comes through the callback: it is the one part of this
     * the graph cannot carry, and a cap and a broken key are not the same
     * sentence.
     *
     * Emitted rather than only logged, because a log reaches nobody who can act
     * on it. A cap that silently halves the answer is exactly how "there is
     * nothing there" gets said about files nobody opened — and the person
     * reading the map cannot open the code to check. The event is persisted
     * like every other, so a browser that reloads mid-run replays it.
     *
     * Computed here and emitted further down, after Pass 2 has also had its
     * turn: both passes read files and either can fall short, and the stream
     * carries one `llm.coverage` whose last value wins. Two events would mean
     * the second silently overwriting the first.
     */
    const parserCoverage = llmCoveragePayload(
      pythonLlmCoverage(graph.nodes),
      modelPass.stopped,
    );

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

    // With the graph in hand, decide how much of it to write. Every escalation
    // to a full write is free at this point — the analysis already happened —
    // which is exactly why the decision is taken here rather than up front.
    const writeScope: WriteScope = await resolveWrite(
      db,
      project.id,
      changeScope,
      files.map((file) => file.path),
      graph,
    );

    if (writeScope.mode === "incremental") {
      console.log(
        "[pipeline] incremental write",
        runId,
        {
          changed: changeScope.mode === "incremental" ? changeScope.changed.size : 0,
          rewriting: writeScope.touched.size,
          carriedForward: writeScope.carryForward.length,
        },
      );
    } else {
      // Never silent. A feature that quietly stops working is worse than one
      // that never worked, because nobody goes looking for it.
      console.log(
        "[pipeline] full write",
        runId,
        writeScope.reason,
        FULL_REASON_NOTES[writeScope.reason],
      );
    }

    const slice =
      writeScope.mode === "incremental"
        ? selectOwnedRows(graph, writeScope.touched)
        : graph;

    /*
     * Two writes, because an edge a model guessed must not be stored as
     * something a parser saw.
     *
     * `persistGraph` stamps one origin per call, so the only way to get both
     * is to partition and call it twice — the same thing Pass 2 already does
     * for its feature nodes. The Python analyzer marks every edge it got from
     * the model with `metadata.origin === "llm"`; every other analyzer emits
     * none, so `guessed` is empty and the second call is skipped entirely.
     *
     * Nodes all go with the `static` write: the model never invents a node,
     * only claims a call between two that the parser already found.
     */
    const guessed = slice.edges.filter(
      (edge) => (edge.metadata as { origin?: unknown } | undefined)?.origin === "llm",
    );
    const parsed =
      guessed.length === 0
        ? slice.edges
        : slice.edges.filter(
            (edge) =>
              (edge.metadata as { origin?: unknown } | undefined)?.origin !== "llm",
          );

    const written = await persistGraph(db, project.id, runId, slice.nodes, parsed);
    if (guessed.length > 0) {
      const guessedWritten = await persistGraph(db, project.id, runId, [], guessed, {
        origin: "llm",
      });
      written.edgesWritten += guessedWritten.edgesWritten;
      written.edgesDropped += guessedWritten.edgesDropped;
      written.droppedSamples.push(...guessedWritten.droppedSamples);
    }
    if (written.nodesDropped > 0 || written.edgesDropped > 0) {
      console.warn(
        "[pipeline] dropped rows",
        runId,
        { nodes: written.nodesDropped, edges: written.edgesDropped },
        written.droppedSamples,
      );
    }

    /*
     * Pass 2, the semantic layer.
     *
     * After the write and before the sweep, which is the only window where
     * both halves are true: Pass 1's rows are in the table, so a `belongs_to`
     * edge has a file to point at, and last run's features are still there to
     * be matched against so a rename does not change a feature's id (D55).
     *
     * It is handed the WHOLE graph rather than the incremental slice, because a
     * feature is a claim about the shape of the project and one derived from
     * the files that happened to change would be a confident statement about a
     * fifth of it.
     *
     * `runSemanticLayer` never throws. A model failure leaves the map exactly
     * as Pass 1 drew it and the run still completes — the static graph is the
     * floor, and this pass is an improvement on it.
     */
    setPhase("semantic");
    const semantic = await runSemanticLayer({
      db,
      projectId: project.id,
      runId,
      llm: input.llm ?? null,
      graph,
      scope: changeScope,
      emit,
    });
    await store.flush();

    /*
     * Pass 3, the purpose layer.
     *
     * After Pass 2, because it shows the model the Korean names Pass 2 has just
     * written — 결제 버튼 is better evidence for what calling something is for
     * than `PayButton` is, and it costs nothing, since the line is one string
     * either way.
     *
     * It emits no event and moves no phase. The checklist's 기능 이름 붙이는 중
     * step is about files, and every connection this pass cannot reach keeps
     * the relation's own verb — which the map has always shown and which is
     * true. There is no shortfall to report, so reporting one would invent a
     * hole in a map that does not have one.
     *
     * `runPurposeLayer` never throws, for the same reason `runSemanticLayer`
     * does not: the static graph is the floor.
     */
    const purpose = await runPurposeLayer({
      db,
      projectId: project.id,
      llm: input.llm ?? null,
      graph,
      scope: changeScope,
    });
    if (purpose.purposes > 0 || purpose.spent.calls > 0) {
      console.log(
        "[pipeline] connection sentences",
        runId,
        `${purpose.purposes} purposes (${purpose.answered} asked, ${purpose.carried} kept) ` +
          `on ${purpose.connectionsWritten} connections, ${purpose.spent.calls} calls`,
      );
    }

    /*
     * One coverage line for the run, from whichever pass fell furthest short.
     *
     * Not a blend of the two: `examined` and `notExamined` have to be numbers a
     * real pass actually measured, or the sentence on screen is about a run
     * that did not happen. The larger shortfall wins because it is the more
     * conservative claim about what we opened, which is the direction section 3
     * requires us to err in.
     */
    const semanticCoverage = llmCoveragePayload(semantic.coverage, semantic.stopped);
    const shortfall =
      (semanticCoverage?.notExamined ?? 0) > (parserCoverage?.notExamined ?? 0)
        ? semanticCoverage
        : parserCoverage;
    if (shortfall) {
      console.log(
        "[pipeline] model coverage",
        runId,
        `${shortfall.examined} examined, ${shortfall.notExamined} not opened`,
        shortfall.reason,
      );
      await emit("llm.coverage", shortfall);
    }

    // Now the run really is done: Pass 1 drew the map, Pass 2 wrote on it, and
    // what is left is bookkeeping the user is not watching.
    setPhase("done");

    // Carry forward, then sweep, in one transaction — and only here, on the
    // success path. A file that became unparseable this run still has correct
    // rows from the last one, and sweeping them takes every connection from
    // healthy files with them through the cascade (D37). An unchanged file is
    // carried forward by the same mechanism and a narrower rule: see
    // `CarryForwardScope`.
    await promoteRun(
      db,
      project.id,
      runId,
      [...skippedPaths],
      writeScope.mode === "incremental" ? writeScope.carryForward : [],
    );

    // What the user is told is the size of the map, not the size of this run's
    // write. A full run is left counting exactly what it counted before, so the
    // only behaviour that changes is the incremental case.
    // Pass 2's rows are part of the map: `graph` has them appended, and the
    // full-write branch adds what it wrote, so a project with 7 features
    // reports 7 more items than Pass 1 alone produced.
    const measured =
      writeScope.mode === "incremental"
        ? graphSize(project.id, graph.nodes, graph.edges)
        : {
            nodes: written.nodesWritten + semantic.nodesWritten,
            edges: written.edgesWritten + semantic.edgesWritten,
          };

    // Row first, then the event. A client that closes on `run.completed` and
    // then reads the project would otherwise be able to see a run still marked
    // running.
    await db
      .update(analysisRuns)
      .set({
        status: "completed",
        phase: "done",
        filesParsed,
        nodeCount: measured.nodes,
        edgeCount: measured.edges,
        filesSkipped: [...skippedPaths],
        finishedAt: new Date(),
      })
      .where(eq(analysisRuns.id, runId));

    await emit("run.completed", {
      nodeCount: measured.nodes,
      edgeCount: measured.edges,
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

/**
 * Find the commit this project's graph was last measured at, and ask GitHub
 * what has happened since.
 *
 * Everything that can go wrong here resolves to a full run, never to a partial
 * one: no base, an unreadable answer, a base GitHub has forgotten. The
 * decisions themselves live in `incremental.ts` so they can be tested without
 * a network; this function only gathers the facts they need.
 */
async function planRun(input: {
  db: Db;
  project: AnalysisProject;
  analyzerName: string;
  headSha: string | null;
  githubToken: string | null;
  runId: string;
}): Promise<ChangeScope> {
  // Every failure in here is a failure of an optimisation, never of the run.
  // A connection blip while reading the base run would otherwise turn "we
  // could have written fewer rows" into "your analysis failed", which is a
  // strictly worse product than not having this feature at all.
  try {
    return await planRunOrThrow(input);
  } catch (error) {
    console.error("[pipeline] could not plan an incremental run", input.runId, error);
    return { mode: "full", reason: "compare_failed" };
  }
}

/**
 * Decide the write scope, degrading to a full write rather than failing.
 *
 * The graph is already computed by the time this runs, so a full write costs
 * one more statement. That asymmetry is why the read below is allowed to fail
 * at all: there is a correct answer available for free.
 */
async function resolveWrite(
  db: Db,
  projectId: string,
  changeScope: ChangeScope,
  analysedPaths: string[],
  graph: { nodes: AnalyzedNode[]; edges: AnalyzedEdge[] },
): Promise<WriteScope> {
  if (changeScope.mode !== "incremental") return changeScope;
  try {
    return resolveWriteScope({
      projectId,
      scope: changeScope,
      analysedPaths,
      graph,
      previous: await loadPreviousShape(db, projectId),
    });
  } catch (error) {
    console.error("[pipeline] could not read the previous graph", projectId, error);
    return { mode: "full", reason: "compare_failed" };
  }
}

async function planRunOrThrow(input: {
  db: Db;
  project: AnalysisProject;
  analyzerName: string;
  headSha: string | null;
  githubToken: string | null;
  runId: string;
}): Promise<ChangeScope> {
  const { db, project, analyzerName, headSha, githubToken, runId } = input;

  if (project.source !== "github") {
    return planChangeScope({
      source: project.source,
      baseRun: null,
      headSha,
      analyzer: analyzerName,
      comparison: null,
      comparisonError: null,
    });
  }

  const base = await findBaseRun(db, project.id);
  const baseRun = base
    ? {
        commitSha: base.commitSha,
        analyzer: base.analyzer,
        analyzerVersion: base.analyzerVersion,
      }
    : null;

  let comparison: RepoComparison | null = null;
  let comparisonError: GithubFailure | null = null;

  if (baseRun?.commitSha && headSha) {
    if (baseRun.commitSha === headSha) {
      // Nobody pushed. Asking GitHub to compare a commit with itself is a
      // request we already know the answer to, and a re-read of an unchanged
      // repository is the most common reason this path runs at all.
      comparison = { status: "identical", files: [], gap: null };
    } else {
      const result = await compareCommits(
        project.repoOwner,
        project.repoName,
        baseRun.commitSha,
        headSha,
        githubToken,
      );
      if (result.ok) comparison = result.value;
      else comparisonError = result.error;
    }
  }

  const scope = planChangeScope({
    source: project.source,
    baseRun,
    headSha,
    analyzer: analyzerName,
    comparison,
    comparisonError,
  });

  if (scope.mode === "incremental") {
    console.log("[pipeline] compared", runId, {
      base: scope.base.slice(0, 7),
      head: scope.head.slice(0, 7),
      changedFiles: scope.changed.size,
    });
  }
  return scope;
}
