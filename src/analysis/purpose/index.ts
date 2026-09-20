import type { Db } from "@/db";
// Type only. A runtime import of `@/lib/llm` reaches `env.ts`, which validates
// 21 variables at import time and throws — right for a route, fatal for a test.
import type { Llm } from "@/lib/llm/types";

import { edgeId, nodeId } from "../ids";
import type { ChangeScope } from "../incremental";
import type { AnalyzedEdge, AnalyzedNode } from "../types";

import { buildPurposeAsks, type PurposeBudget } from "./ask";
import { spreadPurpose } from "./groups";
import { runPurposePass, type PurposeStop } from "./pass";
import { loadPurposeText, loadStoredPurposes, writePurposes } from "./persist";

export { DEFAULT_PURPOSE_BUDGET, type PurposeBudget } from "./ask";
export { runPurposePass, type PurposeResult } from "./pass";

/**
 * Pass 3, wired to the database.
 *
 * The pure half is `pass.ts`: model in, checked sentences out, no environment.
 * This is the half that knows where the sentences go, and it is deliberately
 * the only place in `purpose/` that touches Postgres — and the only place that
 * hashes anything, because `ids.ts` says an analyzer never does.
 *
 * **Nothing here throws.** The static graph is the floor and this pass is prose
 * laid over it, so every failure — no key, a bad key, an endpoint down, a query
 * that will not run — is caught, logged, and turned into a run that completes
 * with generic verbs where the sentences would have been. Those verbs are true
 * and were never wrong; they are only general.
 */

export type PurposeLayerResult = {
  /** Purposes this run stands behind, fresh and carried together. */
  purposes: number;
  answered: number;
  carried: number;
  notAnswered: number;
  /** Connection rows that now carry a sentence. */
  connectionsWritten: number;
  stopped: PurposeStop | null;
  spent: { calls: number; inputTokens: number; outputTokens: number };
};

const EMPTY: PurposeLayerResult = {
  purposes: 0,
  answered: 0,
  carried: 0,
  notAnswered: 0,
  connectionsWritten: 0,
  stopped: null,
  spent: { calls: 0, inputTokens: 0, outputTokens: 0 },
};

export async function runPurposeLayer(input: {
  db: Db;
  projectId: string;
  llm: Llm | null;
  /**
   * This run's whole graph, not an incremental slice.
   *
   * A purpose is a claim about a target and every place that reaches for it,
   * and one derived from the files that happened to change would give the same
   * function two different sentences depending on which caller was edited.
   */
  graph: { nodes: AnalyzedNode[]; edges: AnalyzedEdge[] };
  scope: ChangeScope;
  budget?: Partial<PurposeBudget>;
  signal?: AbortSignal;
}): Promise<PurposeLayerResult> {
  const { db, projectId, graph, scope } = input;

  try {
    /*
     * Hashing happens here and nowhere else in this folder. `groupByPurpose`
     * is told to name each edge by its row id, so `spreadPurpose` hands back a
     * map the writer can use directly — which is the whole of "the twelfth
     * caller is told the same thing as the first", expressed as a lookup.
     */
    const rowIdOf = (edge: AnalyzedEdge) =>
      edgeId(
        projectId,
        edge.type,
        nodeId(projectId, edge.source),
        nodeId(projectId, edge.target),
      );

    const [text, stored] = await Promise.all([
      loadPurposeText(db, projectId),
      loadStoredPurposes(db, projectId),
    ]);

    const { asks, groups } = buildPurposeAsks(graph, text, rowIdOf);

    // What an earlier run already answered, mapped from edge rows back onto
    // purposes. The first stored sentence in a group wins: they are written
    // together from one map, so a group holding two different sentences means
    // a run was interrupted between chunks, and either is the last good answer.
    const known = new Map<string, string>();
    for (const group of groups) {
      for (const id of group.edgeIds) {
        const sentence = stored.get(id);
        if (sentence !== undefined) {
          known.set(group.key, sentence);
          break;
        }
      }
    }

    const result = await runPurposePass({
      llm: input.llm,
      asks,
      known,
      scope,
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    /*
     * Spread, then write every connection in every answered group — including
     * the ones that already carry the sentence.
     *
     * Restating rather than writing only the fresh answers is the correctness
     * half: a connection written for the first time this run has nothing in its
     * own row, and a new twelfth caller of `formatPrice` reading 사용해요 beside
     * eleven siblings reading the real sentence is exactly the inconsistency
     * the grouping exists to prevent. The cost is a handful of statements.
     */
    const byEdge = spreadPurpose(groups, result.answers);
    const connectionsWritten = await writePurposes(db, projectId, byEdge);

    console.log("[purpose]", projectId, {
      purposes: result.answers.size,
      answered: result.answered,
      carried: result.carried,
      notAnswered: result.notAnswered,
      connections: connectionsWritten,
      calls: result.spent.calls,
      // In and out separately, not only the sum: the two cost different money
      // (D45), so a total is a number nobody can turn into 원 afterwards.
      input: result.spent.inputTokens,
      output: result.spent.outputTokens,
      stopped: result.stopped,
      drops: result.drops,
      ...(result.error ? { error: result.error } : {}),
    });

    return {
      purposes: result.answers.size,
      answered: result.answered,
      carried: result.carried,
      notAnswered: result.notAnswered,
      connectionsWritten,
      stopped: result.stopped,
      spent: result.spent,
    };
  } catch (error) {
    // The map is already written and every line on it already has a verb.
    // Losing that over the step that adds a sentence to it would be the worst
    // trade this pipeline could make.
    console.error("[purpose] pass failed, keeping the map", projectId, error);
    return EMPTY;
  }
}
