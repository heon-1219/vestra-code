import type { ChangeScope } from "../incremental";
import { normalizePath, type NodeRef } from "../ids";
import type { AnalyzedEdge, AnalyzedNode, NodeType, SymbolKind } from "../types";

import { groupByPurpose, purposeKey, type PurposeGroup } from "./groups";

/**
 * One question per purpose, and the rule for which questions get asked.
 *
 * `groups.ts` answers "which connections are the same connection". This turns
 * each of those groups into something a model can be shown — the far end, what
 * it is called, where it lives, how many places reach for it — and then decides
 * which of them are worth a call.
 *
 * ## What the model is shown, and what it is not
 *
 * **No source text, anywhere.** The same line Pass 2 draws (D49, §6.2): a path,
 * a symbol name and a count are facts we derived, and a file's own prose is the
 * repository talking. A purpose sentence is written from the shape of the graph
 * around the target, plus whatever Korean Pass 2 has already put on it.
 *
 * **Indices, not ids (D46).** Every ask carries a small integer and that is the
 * only way the model may refer to anything, which turns "drop any id that does
 * not exist" into a bounds check rather than string matching.
 *
 * ## What carry-forward means here, and why it is cheaper than Pass 2's
 *
 * A purpose belongs to the **target**, not to the caller. So the twelfth
 * component to call `formatPrice` costs nothing — not because we cached the
 * answer for that component, but because it was never a separate question. A
 * stored purpose is re-asked only when the file the target lives in changed,
 * which is the one event that can make the sentence untrue.
 */

/** What a previous run, or Pass 2 moments ago, wrote about a node. */
export type NodeText = { label: string | null; summary: string | null };

/** One purpose, dressed as a question. */
export type PurposeAsk = {
  /** Stable within this run. What the model answers with (D46). */
  index: number;
  /** `purposeKey(relation, targetKey)`. What the answer is stored against. */
  key: string;
  relation: AnalyzedEdge["type"];
  /** Distinct places that reach for it. Not the edge count — see `groups.ts`. */
  sources: number;
  targetKind: NodeType;
  /** The name in the code. */
  targetName: string;
  targetLabel: string | null;
  targetSummary: string | null;
  targetPath: string;
  targetShape: SymbolKind | null;
  /** Names of up to two places that reach for it, for context. */
  examples: string[];
  /** The Korean name of the file the target is written in, when there is one. */
  homeLabel: string | null;
};

export type PurposeSelection = {
  /** In the order they will be asked. */
  asks: readonly PurposeAsk[];
  /** Purposes whose stored sentence this run keeps without asking. */
  carried: readonly PurposeAsk[];
  /** Purposes the budget could not reach. They keep the structural verb. */
  skipped: readonly PurposeAsk[];
};

/**
 * The natural key of a node ref, matching `semantic/outline.ts#refKey`.
 *
 * Restated rather than imported so `purpose/` does not depend on `semantic/`
 * for its identity scheme — the two passes are independent and either could be
 * turned off. It is the same JSON encoding `ids.ts` hashes, for the reason
 * `ids.ts` gives: any separator would have to be a control character, and a
 * literal control character in source is what gets silently rewritten in
 * transit.
 */
export function refKey(ref: NodeRef): string {
  return JSON.stringify([
    ref.type,
    normalizePath(ref.filePath),
    ref.container ?? "",
    ref.name ?? "",
  ]);
}

/** The natural key of an edge. Hashed into a row id only by `persist.ts`. */
export function edgeKey(edge: AnalyzedEdge): string {
  return JSON.stringify([edge.type, refKey(edge.source), refKey(edge.target)]);
}

/**
 * Turn a run's graph into one question per purpose.
 *
 * Deterministic: `groupByPurpose` orders by how many distinct places reach for
 * a thing and then by key, so two runs over an unchanged project produce the
 * same questions in the same order — which is what makes a carried-forward
 * answer comparable with a fresh one.
 */
export function buildPurposeAsks(
  graph: { nodes: readonly AnalyzedNode[]; edges: readonly AnalyzedEdge[] },
  text: ReadonlyMap<string, NodeText> = new Map(),
  /**
   * How an edge is named in the groups this returns.
   *
   * Defaults to the natural key, which is all a test needs. The layer passes
   * the hashed row id instead, so `spreadPurpose` hands back a map the writer
   * can use directly — hashing belongs to the half of the pass that knows the
   * project id, and an analyzer never hashes anything (`ids.ts`).
   */
  edgeIdOf: (edge: AnalyzedEdge) => string = edgeKey,
): { asks: PurposeAsk[]; groups: PurposeGroup[] } {
  const nodeByKey = new Map<string, AnalyzedNode>();
  for (const node of graph.nodes) nodeByKey.set(refKey(node.ref), node);

  const groups = groupByPurpose(graph.edges, edgeIdOf, (edge) => refKey(edge.target));

  // Example callers, collected in one pass so the order is the order the
  // analyzer found them in rather than a set's iteration order. Only for keys
  // that became a group: `contains` is the commonest relation in any graph and
  // has no purpose to explain, so collecting for it would grow a map the size
  // of the project for nothing.
  const wanted = new Set(groups.map((group) => group.key));
  const examplesByKey = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const key = purposeKey(edge.type, refKey(edge.target));
    if (!wanted.has(key)) continue;
    const list = examplesByKey.get(key) ?? [];
    if (list.length >= EXAMPLES_SHOWN) continue;
    const name = nameOf(edge.source);
    if (name === "" || list.includes(name)) continue;
    list.push(name);
    examplesByKey.set(key, list);
  }

  const asks: PurposeAsk[] = [];
  let index = 0;

  for (const group of groups) {
    const node = nodeByKey.get(group.targetId);
    if (!node) continue;

    const own = text.get(group.targetId) ?? { label: null, summary: null };
    const home =
      node.ref.type === "file"
        ? null
        : (text.get(refKey({ type: "file", filePath: node.ref.filePath }))?.label ?? null);

    asks.push({
      index: index++,
      key: group.key,
      relation: group.relation,
      sources: group.sources,
      targetKind: node.ref.type,
      targetName: nameOf(node.ref),
      targetLabel: own.label,
      targetSummary: own.summary,
      targetPath: normalizePath(node.ref.filePath),
      targetShape: node.kind ?? null,
      examples: examplesByKey.get(group.key) ?? [],
      homeLabel: home,
    });
  }

  // Groups whose target is not on the map are dropped from BOTH lists, so a
  // sentence can never be spread onto a connection nobody can be shown.
  const named = new Set(asks.map((ask) => ask.key));
  return { asks, groups: groups.filter((group) => named.has(group.key)) };
}

/** Two. Enough to show that this is shared, short enough not to be a list. */
const EXAMPLES_SHOWN = 2;

export type PurposeBudget = {
  /** Purposes the model is asked about at all. The rest keep their verb. */
  maxGroups: number;
  /** Purposes per request. */
  batchSize: number;
  /** Input plus output tokens for the whole pass. */
  maxTokens: number;
  /**
   * Hard ceiling on one reply. The ceiling actually sent is computed from the
   * batch — see `outputCeilingFor` — and clamped to this, so one runaway answer
   * cannot eat the pass.
   */
  maxOutputTokens: number;
};

/*
 * Measured on the two real projects, not chosen.
 *
 * `vestra-code` (6a069e22) holds 1,711 explainable connections that collapse
 * into **801 purposes** — 2.14 connections per purpose. `Kim-and-Chang-`
 * (e0ef56c2) holds 134 that collapse into 60. So:
 *
 *  - `maxGroups: 1200`. 801 is the largest real number anyone here has
 *    measured, and a ceiling that stops short of it would leave the biggest
 *    project the product has with generic verbs on the connections a person is
 *    most likely to click. §4 of `FLOW_TRACKING.md` proposed 60, which covers
 *    **39% of that project's connections and 7% of its purposes** — measured,
 *    and the reason this number is not the one in the document.
 *  - `batchSize: 25`. A batch is what one truncation costs. A purpose answer is
 *    one short sentence, so twenty-five of them answer in well under two
 *    thousand tokens, and a smaller batch would multiply the fixed system
 *    prompt (~320 tokens) across more calls.
 *  - `maxTokens: 300_000`. A ceiling on the pass, not a target: 801 purposes
 *    measured at ~2.4k in / ~1.6k out per batch of 25 is ~130k, well inside it.
 */
export const DEFAULT_PURPOSE_BUDGET: PurposeBudget = {
  maxGroups: 1_200,
  batchSize: 25,
  maxTokens: 300_000,
  maxOutputTokens: 4_000,
};

/*
 * What one answer costs, with D88's headroom applied from the start.
 *
 * A purpose is one Korean sentence of at most `MAX_PURPOSE_CHARS`, plus the
 * JSON around it. Pass 2 measured a file's name-and-sentence at 51-53 output
 * tokens; a purpose is roughly the sentence half of that. 60 rather than 40
 * because the cost of over-asking is nothing — the ceiling is not a
 * reservation — and the cost of under-asking is an entire batch thrown away,
 * which is exactly the defect D88 records.
 */
const OUTPUT_PER_PURPOSE = 60;
const OUTPUT_OVERHEAD = 200;

export function outputCeilingFor(
  asks: readonly PurposeAsk[],
  budget: PurposeBudget = DEFAULT_PURPOSE_BUDGET,
): number {
  return Math.min(
    OUTPUT_OVERHEAD + asks.length * OUTPUT_PER_PURPOSE,
    budget.maxOutputTokens,
  );
}

/**
 * Which purposes this run asks about.
 *
 * Two rules, and the first is the whole of the incremental promise.
 *
 * **A purpose already answered is not asked again unless its target moved.**
 * The sentence is about the far end — what `formatPrice` is for — so a new
 * caller changes nothing about it, and only an edit to the file the target
 * lives in can make it untrue. On a re-read of a repository nobody pushed to,
 * every purpose is carried and the pass costs zero.
 *
 * **A full run re-asks.** `scope.mode === "full"` means we do not know what
 * moved, and Pass 2 takes the same position for the same reason: re-asking is
 * the only honest option when the alternative is keeping a sentence we have no
 * evidence for. The budget is what stops that being expensive.
 */
export function selectPurposes(
  asks: readonly PurposeAsk[],
  known: ReadonlyMap<string, string>,
  scope: ChangeScope,
  budget: PurposeBudget = DEFAULT_PURPOSE_BUDGET,
): PurposeSelection {
  const changed =
    scope.mode === "incremental"
      ? new Set([...scope.changed].map(normalizePath))
      : null;

  const carried: PurposeAsk[] = [];
  const candidates: PurposeAsk[] = [];

  for (const ask of asks) {
    const answered = known.has(ask.key);
    // A package has no file of ours to have changed, so `targetPath` is "" and
    // the membership test is false — which is right: `react` is what it was.
    if (answered && changed !== null && !changed.has(ask.targetPath)) {
      carried.push(ask);
      continue;
    }
    candidates.push(ask);
  }

  return {
    asks: candidates.slice(0, budget.maxGroups),
    carried,
    skipped: candidates.slice(budget.maxGroups),
  };
}

/** Cut a selection into requests. One shape, so the parser has one job. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, size);
  for (let at = 0; at < items.length; at += step) out.push(items.slice(at, at + step));
  return out;
}

function nameOf(ref: NodeRef): string {
  if (ref.type === "file") return normalizePath(ref.filePath);
  if (ref.container) return `${ref.container}.${ref.name ?? ""}`;
  return ref.name ?? normalizePath(ref.filePath);
}
