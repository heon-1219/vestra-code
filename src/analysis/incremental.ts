import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { edges as edgesTable, nodes as nodesTable } from "@/db/schema";
import type { ChangedFile, GithubFailure, RepoComparison } from "@/lib/github/api";

import { nodeId, normalizePath } from "./ids";
import type { GraphDb } from "./persist";
import type { AnalyzedEdge, AnalyzedNode, Confidence } from "./types";

/**
 * Re-analysing only what changed, without ever producing a different graph.
 *
 * The property this whole file exists to hold is one line long:
 *
 *     incremental(A -> B) must equal full(B)
 *
 * Nodes, edges, ids, types, certainties, all of it. `incremental.test.ts`
 * asserts exactly that against the real analyzer and real fixtures, because
 * without it this feature is a silent graph-corruption machine — and the
 * corruption surfaces as a confidently wrong sentence shown to someone who
 * cannot read the code and has no way to check.
 *
 * ## Where the cost actually is, measured
 *
 * The obvious design — hand the analyzer only the changed files — was measured
 * on the `shop` fixture (16 source files) before any of this was written, and
 * it is wrong twice over:
 *
 *   - **It saves nothing.** A program of 1 source file took 1425 ms; a program
 *     of all 16 took 1310 ms. The numbers are inside each other's noise. Nearly
 *     all of Pass 1's CPU is the TypeScript checker starting up — constructing
 *     the `Project` object alone is 2 ms, so the second and a half is the lib
 *     files and the checker, paid once regardless of how many files enter.
 *   - **It destroys the graph.** Analysing only `src/components/PayButton.tsx`
 *     produced 2 of the 9 edges that file owns in a full run. The seven that
 *     vanished included every `certain` import and call it makes, because
 *     ts-morph resolves symbols *across* the project and a program with one
 *     file in it has nothing to resolve to. A run like that does not fail; it
 *     succeeds with a smaller, wronger map.
 *
 * So Pass 1 keeps running over the whole tree, and it is the **write** that is
 * incremental: which rows are re-stated, and — when Pass 2 lands — which rows
 * are worth spending tokens on. D52 to D54 are the record that the LLM half is
 * where the money is, and this module hands that half an exact answer to
 * "which parts of this project are new since last time".
 *
 * That is a smaller win than "skip the parse", and it is the honest one.
 *
 * ## The dependency closure, and why it stops where it does
 *
 * A changed file is not the only file whose rows can move. Every row the
 * analyzer emits is **owned by exactly one file** — a node by the file it is
 * declared in, an edge by the file its source sits in — so the question is
 * precisely: whose owned rows can differ when someone else's file changed?
 *
 * Three answers, and the third is the one that is easy to miss:
 *
 *   1. **The changed files themselves.** Obvious.
 *   2. **Whoever pointed at them, one hop, in either graph.** If `orders.ts`
 *      drops an export, every file that called it loses an edge — and those
 *      files did not change. The hop is taken over the *union* of the previous
 *      graph's edges and this run's, because a deleted target leaves no trace
 *      in the new graph: the only record that `PayButton` used to call
 *      `createOrder` is the edge the last run stored.
 *
 *      One hop, not transitive. A file two hops away is unaffected because its
 *      own targets are unchanged: resolution already follows re-export chains
 *      to the *final* declaration, so an edge names where a symbol really
 *      lives rather than the barrel it travelled through. A transitive closure
 *      over an import graph swallows the whole repository through the first
 *      `index.ts` it meets, which would leave the feature with nothing to skip.
 *
 *   3. **Everyone who guessed.** The analyzer has one project-global index
 *      that is not visible in the edge graph: a bare name with exactly one
 *      match project-wide resolves to that match. Delete a same-named function
 *      somewhere else and a name that was ambiguous becomes unique, and files
 *      that touch neither end of that change gain or lose an edge.
 *
 *      There is no edge in either graph connecting those files to the change,
 *      so no hop count finds them. What does find them: that fallback is the
 *      *only* thing in the analyzer that produces an `inferred` edge, so every
 *      file it could affect either owns an inferred edge now or owned one
 *      before. Re-stating all of those covers it exactly, with no guard to get
 *      subtly wrong. On a repository where nearly everything is inferred this
 *      degenerates towards a full write — which is correct, and self-limiting.
 *
 * ## Two analyzers, two closures
 *
 * The rules above are written against the graph, not against TypeScript, and
 * that matters because most real projects here do not reach the TypeScript
 * analyzer at all — an HTML/CSS site and a Python repository both go to the
 * shallow one (D26), and an uploaded folder never goes incremental at all.
 *
 * The shallow analyzer extracts **no symbols**, so it has no name index and
 * hop 3 is dead weight for it — harmless, because it owns few inferred edges
 * and touching their files costs a few rows. Its own global index is a
 * different one: `packages`, built from the dependency manifests. A bare
 * `import x from "react"` only becomes an edge when some `package.json`
 * declares `react`, so **adding or removing a manifest changes the edges of
 * files that did not change and have no link to the manifest**. That is why
 * hop 2 below runs over package *names* as well as over file paths: a package
 * that appeared or disappeared drags in everyone who names it, and nobody
 * else. For the TypeScript analyzer the same rule costs nothing, because there
 * a package node is created by the file importing it, so the only file naming
 * a newly-appeared package is the one that changed.
 *
 * The other index — the set of API addresses a `fetch` is matched against — is
 * a pure function of the file paths, so hop 2 already reaches every file whose
 * fetch edge can move: an address only appears or disappears when a route file
 * is added, removed or renamed, and that path is in the changed set by
 * definition. The escalation below is kept anyway, because `matchEndpoint`
 * *ranks* candidates across the whole address list, and a ranking function is
 * exactly the sort of thing that gains a tie-breaker later without anyone
 * coming back to re-read this comment.
 */

/**
 * Bump this when any analyzer starts producing different rows for the same
 * code.
 *
 * Without it, a deploy that improves the parser would leave every unchanged
 * file carrying rows the old parser produced, for ever — the sweep never sees
 * them because they keep being stamped, and nothing anywhere reports it. The
 * graph would be a mix of two analyzer versions with no way to tell which rows
 * came from which.
 */
/*
 * Bumped to 2 when the Python analyzer landed.
 *
 * A project that was `unsupported` or `static_site` and is now detected as
 * `python` has a base graph built by the shallow analyzer. Its rows are not
 * wrong so much as from a different world — files and packages, no symbols —
 * and an incremental write against it would stamp those shallow rows as still
 * current and carry them past the sweep for ever. A version mismatch forces
 * one full write, after which it is incremental again.
 */
/*
 * Bumped to 3 when Pass 2 landed, and to 4 when Pass 3 and the Streamlit
 * addresses did.
 *
 * A carried-forward row from a version-2 graph means something different now.
 * Version 2 had no `feature` nodes, no `belongs_to` edges and no `label`,
 * `summary` or `text_lang` on anything — Pass 2 existed only as an event type
 * nothing emitted. Pass 2 decides what to re-ask by looking at which files
 * already carry a Korean name, so against a version-2 base every file is
 * unnamed and the first run would ask about all of them anyway. The bump makes
 * that one run a full write as well, so the two halves of the graph are never
 * a mixture of "named under the old shape" and "named under the new one".
 *
 * Version 3 → 4 is a stronger case, because one half of it does NOT heal on
 * its own. A version-3 Python graph has **no `route` nodes at all** — Streamlit
 * addresses did not exist — and an incremental write only writes the rows of
 * files that changed, so a project whose entry script nobody edited would
 * never gain its addresses and 흐름 따라가기 would go on refusing for ever with
 * nothing anywhere saying why. (The other half, `edges.metadata.purpose`, does
 * heal: an edge with no sentence is simply one nobody has answered for yet.)
 * One full write per project, then incremental again.
 */
export const ANALYZER_VERSION = "4";

/**
 * Above this share of the analysed tree, an incremental write is bookkeeping
 * for nothing: the rows we skip are a rounding error against the rows we
 * write, and the skipping is the part that can be wrong. Half is a judgement
 * call, not a measurement — the point is that there is a ceiling at all.
 */
export const FULL_WRITE_SHARE = 0.5;

/** Why a run wrote the whole graph instead of a slice of it. */
export type FullReason =
  /** Nothing to compare against: the first analysis of this project. */
  | "no_base_run"
  /** The last run did not record a commit, so its graph cannot be dated. */
  | "no_base_commit"
  /** An uploaded folder has no commits and no compare endpoint. */
  | "not_a_repo"
  /** We could not resolve the branch to a commit this time. */
  | "no_head_commit"
  /** GitHub would not answer, or answered with something unreadable. */
  | "compare_failed"
  /** GitHub no longer has the base commit — a force-push deleted it. */
  | "base_missing"
  /** History was rewritten or the branch moved backwards. */
  | "history_rewritten"
  /** The change list may be missing entries, or used a word we do not know. */
  | "compare_incomplete"
  /** So much changed that skipping the rest saves nothing real. */
  | "too_many_changes"
  /** A different analyzer, or a different version of it, produced the base. */
  | "analyzer_changed"
  /** The set of API addresses moved, which can change any file's fetch edges. */
  | "endpoints_changed";

/** The last completed run, as the decision below needs it. */
export type BaseRun = {
  commitSha: string | null;
  analyzer: string | null;
  analyzerVersion: string | null;
};

export type ChangeScope =
  | { mode: "full"; reason: FullReason }
  | {
      mode: "incremental";
      base: string;
      head: string;
      /**
       * Every path the change touched, in both spellings for a rename.
       *
       * A rename is a delete plus an add, never an update, because the path is
       * inside the id hash. Both halves go in here so the old path's rows are
       * neither written nor carried forward, and are therefore swept.
       */
      changed: ReadonlySet<string>;
    };

/**
 * Decide, before any analysis, whether this run has a base to work from.
 *
 * Everything here falls back to a full run, never to a wrong graph, and every
 * fallback has its own reason so a log line says which one fired. The caller
 * is expected to log it: a feature that silently stops working is worse than
 * one that never worked, because nobody goes looking.
 */
export function planChangeScope(input: {
  source: "github" | "upload";
  baseRun: BaseRun | null;
  headSha: string | null;
  analyzer: string;
  /** The comparison, when one was fetched. */
  comparison: RepoComparison | null;
  /** Why the comparison could not be fetched, when it could not. */
  comparisonError: GithubFailure | null;
}): ChangeScope {
  const { source, baseRun, headSha, analyzer, comparison, comparisonError } = input;

  if (source !== "github") return { mode: "full", reason: "not_a_repo" };
  if (!baseRun) return { mode: "full", reason: "no_base_run" };
  if (!baseRun.commitSha) return { mode: "full", reason: "no_base_commit" };
  if (!headSha) return { mode: "full", reason: "no_head_commit" };

  // A different parser produces different rows for the same code, so carrying
  // the old ones forward would leave two analyzers' output mixed in one graph.
  if (baseRun.analyzer !== analyzer || baseRun.analyzerVersion !== ANALYZER_VERSION) {
    return { mode: "full", reason: "analyzer_changed" };
  }

  if (comparisonError !== null) {
    // 404 on a compare whose head we just resolved means the *base* is gone,
    // which is what a force-push looks like from here.
    return {
      mode: "full",
      reason: comparisonError === "not_found" ? "base_missing" : "compare_failed",
    };
  }
  if (!comparison) return { mode: "full", reason: "compare_failed" };

  if (comparison.status === "behind" || comparison.status === "diverged") {
    return { mode: "full", reason: "history_rewritten" };
  }
  if (comparison.gap !== null) return { mode: "full", reason: "compare_incomplete" };

  return {
    mode: "incremental",
    base: baseRun.commitSha,
    head: headSha,
    changed: changedPathsOf(comparison.files),
  };
}

/** Both spellings of every changed path, normalised the one way ids are. */
export function changedPathsOf(files: readonly ChangedFile[]): Set<string> {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(normalizePath(file.path));
    if (file.previousPath) paths.add(normalizePath(file.previousPath));
  }
  return paths;
}

/**
 * One file-to-file link from the stored graph, which is all the closure needs.
 *
 * Deliberately not the edges themselves. A 300-file project has thousands of
 * edges and dozens of distinct file pairs, and the question being asked —
 * "whose rows could have moved" — is a question about files.
 */
export type FileDependency = {
  from: string;
  /** The target's file. Empty when the target is a package, which has none. */
  to: string;
  /**
   * The package the target is, when it is one. Empty otherwise.
   *
   * Carried separately from `to` rather than encoded into it, because any
   * encoding needs a separator that cannot appear in a path or a package name
   * — and this codebase has had that exact separator silently rewritten in
   * transit more than once (see `ids.ts`).
   */
  toPackage: string;
  confidence: Confidence;
};

/** As much of the previous graph as deciding the write scope requires. */
export type PreviousGraphShape = {
  dependencies: readonly FileDependency[];
  /** Node ids of the previous graph's API addresses. */
  endpointIds: readonly string[];
  /**
   * Every package the previous graph knew about, including ones no file
   * imported — the shallow analyzer declares one per manifest entry, and its
   * appearing or disappearing is what moves other files' edges.
   */
  packageNames: readonly string[];
};

/**
 * Read the previous graph's shape in two small queries.
 *
 * `SELECT DISTINCT` on the two file paths is the point: it turns the edge
 * table into the file-level dependency graph inside Postgres, so a project
 * with ten thousand edges comes back as a few hundred rows instead.
 */
export async function loadPreviousShape(
  db: GraphDb,
  projectId: string,
): Promise<PreviousGraphShape> {
  const sourceNode = alias(nodesTable, "incremental_source");
  const targetNode = alias(nodesTable, "incremental_target");

  // The package name only, never the target's name in general. A symbol's name
  // in the DISTINCT would stop it collapsing: `a.ts` calling four things in
  // `b.ts` is one fact for the closure, and four rows to carry it is four
  // times the answer for no gain.
  const targetPackage = sql<string>`case when ${targetNode.type} = 'package' then ${targetNode.name} else '' end`;

  const rows = await db
    .selectDistinct({
      from: sourceNode.filePath,
      to: targetNode.filePath,
      toPackage: targetPackage,
      confidence: edgesTable.confidence,
    })
    .from(edgesTable)
    .innerJoin(sourceNode, eq(sourceNode.id, edgesTable.sourceNodeId))
    .innerJoin(targetNode, eq(targetNode.id, edgesTable.targetNodeId))
    .where(eq(edgesTable.projectId, projectId));

  const global = await db
    .select({ id: nodesTable.id, type: nodesTable.type, name: nodesTable.name })
    .from(nodesTable)
    .where(
      and(
        eq(nodesTable.projectId, projectId),
        inArray(nodesTable.type, ["api_endpoint", "package"]),
      ),
    );

  const dependencies: FileDependency[] = [];
  for (const row of rows) {
    // A package node has no path of its own, so an edge *out of* one is not a
    // thing this analyzer produces and would have no owner if it were.
    if (row.from === null) continue;
    dependencies.push({
      from: row.from,
      to: row.to ?? "",
      toPackage: row.toPackage ?? "",
      confidence: row.confidence,
    });
  }

  return {
    dependencies,
    endpointIds: global.filter((row) => row.type === "api_endpoint").map((r) => r.id),
    packageNames: global.filter((row) => row.type === "package").map((r) => r.name),
  };
}

/**
 * The same shape, derived from a graph we already hold.
 *
 * This is what `loadPreviousShape` computes in SQL, written once in TypeScript
 * so the equivalence test can state a previous graph without a database and so
 * there is one readable definition of what that query is supposed to return.
 */
export function shapeOfGraph(
  projectId: string,
  graph: { nodes: readonly AnalyzedNode[]; edges: readonly AnalyzedEdge[] },
): PreviousGraphShape {
  const dependencies = new Map<string, FileDependency>();
  for (const edge of graph.edges) {
    const dependency: FileDependency = {
      from: normalizePath(edge.source.filePath),
      to: normalizePath(edge.target.filePath),
      toPackage: edge.target.type === "package" ? (edge.target.name ?? "") : "",
      confidence: edge.confidence,
    };
    if (dependency.from === "") continue;
    dependencies.set(
      JSON.stringify([
        dependency.from,
        dependency.to,
        dependency.toPackage,
        dependency.confidence,
      ]),
      dependency,
    );
  }

  return {
    dependencies: [...dependencies.values()],
    endpointIds: graph.nodes
      .filter((node) => node.ref.type === "api_endpoint")
      .map((node) => nodeId(projectId, node.ref)),
    packageNames: graph.nodes
      .filter((node) => node.ref.type === "package")
      .map((node) => node.ref.name ?? ""),
  };
}

export type WriteScope =
  | { mode: "full"; reason: FullReason }
  | {
      mode: "incremental";
      /** Files whose rows this run writes. */
      touched: ReadonlySet<string>;
      /** Files whose stored rows this run stamps instead of rewriting. */
      carryForward: string[];
    };

/**
 * Turn "these files changed" into "these files' rows get written".
 *
 * Runs after the analysis, not before, which is what makes the escalations
 * here free: the graph is already computed, so deciding to write all of it
 * costs one more statement and nothing else.
 */
export function resolveWriteScope(input: {
  projectId: string;
  scope: ChangeScope;
  /** Every path this run analysed, from ingest. */
  analysedPaths: readonly string[];
  graph: { nodes: readonly AnalyzedNode[]; edges: readonly AnalyzedEdge[] };
  previous: PreviousGraphShape;
}): WriteScope {
  const { projectId, scope, analysedPaths, graph, previous } = input;
  if (scope.mode === "full") return scope;

  // The fetch matcher looks a URL up against every address in the project, so
  // an address appearing or disappearing can change a `fetches` edge in a file
  // that owns no edge today and changed nothing. Nothing in the graph links
  // those files to the change, so this is the one case that escalates.
  const endpointsBefore = new Set(previous.endpointIds);
  const endpointsNow = new Set(
    graph.nodes
      .filter((node) => node.ref.type === "api_endpoint")
      .map((node) => nodeId(projectId, node.ref)),
  );
  if (!sameSet(endpointsBefore, endpointsNow)) {
    return { mode: "full", reason: "endpoints_changed" };
  }

  // Packages that appeared or disappeared. For the shallow analyzer this is a
  // manifest being added or removed, which changes what a bare specifier in a
  // file nobody touched is allowed to resolve to. Narrowed to the names that
  // actually moved, so the common TypeScript case — one file starts importing
  // one new dependency — drags in only that file, which was changed anyway.
  const movedPackages = symmetricDifference(
    new Set(previous.packageNames),
    new Set(
      graph.nodes
        .filter((node) => node.ref.type === "package")
        .map((node) => node.ref.name ?? ""),
    ),
  );

  const touched = new Set(scope.changed);

  // Hop 2: whoever pointed into a changed file — or into a package that came
  // or went — in either graph.
  // Hop 3: whoever guessed, in either graph. See the header for why these
  // together are the whole closure.
  for (const edge of graph.edges) {
    const from = normalizePath(edge.source.filePath);
    if (from === "") continue;
    if (edge.confidence === "inferred") touched.add(from);
    if (scope.changed.has(normalizePath(edge.target.filePath))) touched.add(from);
    if (edge.target.type === "package" && movedPackages.has(edge.target.name ?? "")) {
      touched.add(from);
    }
  }
  for (const dependency of previous.dependencies) {
    if (dependency.confidence === "inferred") touched.add(dependency.from);
    if (scope.changed.has(dependency.to)) touched.add(dependency.from);
    if (dependency.toPackage !== "" && movedPackages.has(dependency.toPackage)) {
      touched.add(dependency.from);
    }
  }

  const analysed = analysedPaths.map(normalizePath);
  const carryForward = analysed.filter((path) => !touched.has(path));

  // Not a saving worth the bookkeeping. Measured against what we analysed
  // rather than against what changed, because a small change with a large
  // fan-in is exactly the case where the closure can engulf the repository.
  if (
    analysed.length > 0 &&
    carryForward.length < analysed.length * (1 - FULL_WRITE_SHARE)
  ) {
    return { mode: "full", reason: "too_many_changes" };
  }

  return { mode: "incremental", touched, carryForward };
}

/**
 * The slice of a full graph that the touched files own.
 *
 * Ownership is the invariant the whole design rests on: a node belongs to the
 * file it is declared in, and an edge belongs to the file its **source** sits
 * in. The analyzer never emits an edge whose source is in a file other than
 * the one it is walking, so every edge has exactly one owner and no edge can
 * fall between two files and be written by neither.
 */
export function selectOwnedRows(
  graph: { nodes: readonly AnalyzedNode[]; edges: readonly AnalyzedEdge[] },
  touched: ReadonlySet<string>,
): { nodes: AnalyzedNode[]; edges: AnalyzedEdge[] } {
  // A package has no file of its own — it is declared by whichever file
  // imports it, which may well be one we are carrying forward. Writing all of
  // them every run is a handful of rows and removes the question entirely; the
  // alternative is a package node nobody stamps, swept out from under the
  // `uses_package` edges that still point at it.
  const nodes = graph.nodes.filter((node) => {
    const owner = normalizePath(node.ref.filePath);
    return owner === "" || touched.has(owner);
  });

  const edges = graph.edges.filter((edge) => {
    const owner = normalizePath(edge.source.filePath);
    return owner === "" || touched.has(owner);
  });

  return { nodes, edges };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** What is in one set and not the other, either way round. */
function symmetricDifference(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const value of a) if (!b.has(value)) out.add(value);
  for (const value of b) if (!a.has(value)) out.add(value);
  return out;
}

/** One line for the run log, in the same words the reasons are named in. */
export const FULL_REASON_NOTES: Record<FullReason, string> = {
  no_base_run: "first analysis of this project",
  no_base_commit: "the previous run recorded no commit",
  not_a_repo: "uploaded folder, no commit history",
  no_head_commit: "could not resolve the branch to a commit",
  compare_failed: "GitHub compare did not answer",
  base_missing: "GitHub no longer has the base commit (force-push)",
  history_rewritten: "history was rewritten or the branch moved backwards",
  compare_incomplete: "the change list was capped or used an unknown status",
  too_many_changes: "too much changed for the saving to be real",
  analyzer_changed: "a different analyzer or analyzer version produced the base",
  endpoints_changed: "the set of API addresses changed",
};
