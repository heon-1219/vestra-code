import type { Db } from "@/db";
// Type only. A runtime import of `@/lib/llm` reaches `env.ts`, which validates
// 21 variables at import time and throws — right for a route, fatal for a test.
import type { Llm } from "@/lib/llm/types";

import type { EventSink } from "../events";
import type { ChangeScope } from "../incremental";
import { persistGraph } from "../persist";
import type { AnalyzedEdge, AnalyzedNode } from "../types";

import { buildOutline } from "./outline";
import { runSemanticPass, type SemanticEmitter, type SemanticStop } from "./pass";
import { loadSemanticState, sweepStaleFeatureLinks, writeSemanticText } from "./persist";
import type { SemanticBudget } from "./select";

export { DEFAULT_SEMANTIC_BUDGET, type SemanticBudget } from "./select";
export { buildOutline, type Outline } from "./outline";
export { runSemanticPass, type SemanticResult } from "./pass";

/**
 * Pass 2, wired to the database and the event stream.
 *
 * The pure half is `pass.ts`: model in, checked rows out, no environment. This
 * is the half that knows where the rows go, and it is deliberately the only
 * place in `semantic/` that touches Postgres.
 *
 * **Nothing here throws.** The static graph is the floor and this pass is an
 * improvement on it, so every failure — no key, a bad key, an endpoint down, a
 * query that will not run — is caught, logged, and turned into a run that
 * completes with fewer words on it. A user whose analysis fails because the
 * naming step could not reach a model has lost a map they were entitled to.
 */

export type SemanticLayerResult = {
  /** Territories on the map after this run, fresh and restated together. */
  featureCount: number;
  /** `belongs_to` rows written. */
  assignedCount: number;
  /** Rows that gained a Korean name this run. */
  namedCount: number;
  nodesWritten: number;
  edgesWritten: number;
  /** For `llmCoveragePayload`. Null when no model ran, which is not a shortfall. */
  stopped: SemanticStop | null;
  coverage: { examined: number; notExamined: number };
  spent: { calls: number; inputTokens: number; outputTokens: number };
};

const EMPTY: SemanticLayerResult = {
  featureCount: 0,
  assignedCount: 0,
  namedCount: 0,
  nodesWritten: 0,
  edgesWritten: 0,
  stopped: null,
  coverage: { examined: 0, notExamined: 0 },
  spent: { calls: 0, inputTokens: 0, outputTokens: 0 },
};

export async function runSemanticLayer(input: {
  db: Db;
  projectId: string;
  runId: string;
  llm: Llm | null;
  /** This run's whole graph, not an incremental slice: a feature is global. */
  graph: { nodes: AnalyzedNode[]; edges: AnalyzedEdge[] };
  scope: ChangeScope;
  emit: EventSink;
  budget?: Partial<SemanticBudget>;
  signal?: AbortSignal;
}): Promise<SemanticLayerResult> {
  const { db, projectId, runId, graph, scope, emit } = input;

  try {
    const state = await loadSemanticState(db, projectId);
    const outline = buildOutline(graph, state.known);

    /*
     * Events are fired as the pass finds things rather than collected and
     * replayed, so the workspace checklist's 기능 이름 붙이는 중 step fills in
     * while the user is watching it — which is the one moment this pass is
     * visible at all. They are awaited through a queue so the run store keeps
     * them in sequence; the emitter contract is synchronous.
     */
    const pending: Promise<void>[] = [];
    const emitter: SemanticEmitter = {
      featureCreated: (name, memberCount) => {
        pending.push(
          emit("feature.created", { name, memberCount }).catch((error: unknown) => {
            console.error("[semantic] emit failed", error);
          }),
        );
      },
      nodesAssigned: (count) => {
        pending.push(
          emit("node.assigned", { count }).catch((error: unknown) => {
            console.error("[semantic] emit failed", error);
          }),
        );
      },
    };

    const result = await runSemanticPass({
      llm: input.llm,
      outline,
      scope,
      previousFeatures: state.previousFeatures,
      ...(input.budget ? { budget: input.budget } : {}),
      emit: emitter,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await Promise.all(pending);

    // Nodes first, then edges, in one call — `persistGraph` already does both
    // in that order (D31), and a `belongs_to` edge points at a file Pass 1 wrote
    // moments ago, which its `existingNodeIds` lookup resolves.
    const written = await persistGraph(
      db,
      projectId,
      runId,
      result.nodes,
      result.edges,
      { origin: "llm" },
    );
    const namedCount = await writeSemanticText(db, projectId, result.text);

    /*
     * A `belongs_to` from a file that did not change is stamped by
     * `carryForwardSkipped`'s `outgoing` rule whether or not this run still
     * believes it. That rule is right for a `calls` edge the file owns and
     * wrong for a grouping we just re-derived: it would leave a file in the
     * feature it used to be in AND the one it is in now. So the rows this pass
     * owns are swept by this pass, against the same run id, before the general
     * sweep runs.
     */
    const stale = await sweepStaleFeatureLinks(db, projectId, runId);

    if (written.edgesDropped > 0 || written.nodesDropped > 0) {
      console.warn("[semantic] dropped rows", runId, {
        nodes: written.nodesDropped,
        edges: written.edgesDropped,
        samples: written.droppedSamples,
      });
    }

    console.log("[semantic]", runId, {
      features: result.features.length,
      assigned: result.edges.length,
      named: namedCount,
      examined: result.examined.length,
      carried: result.carried.length,
      notExamined: result.notExamined.length,
      staleLinksRemoved: stale,
      calls: result.spent.calls,
      tokens: result.spent.inputTokens + result.spent.outputTokens,
      stopped: result.stopped,
      drops: result.drops,
      ...(result.error ? { error: result.error } : {}),
    });

    // The whole graph keeps these, so the count the user is told is the size of
    // the map rather than the size of Pass 1's half of it.
    graph.nodes.push(...result.nodes);
    graph.edges.push(...result.edges);

    return {
      featureCount: result.features.length,
      assignedCount: result.edges.length,
      namedCount,
      nodesWritten: written.nodesWritten,
      edgesWritten: written.edgesWritten,
      stopped: result.stopped,
      coverage: {
        // A carried-forward file WAS opened — in an earlier run, and its name is
        // on the map now. Counting it as unexamined would put a shortfall on
        // screen for work that is visibly done.
        examined: result.examined.length + result.carried.length,
        notExamined: result.notExamined.length,
      },
      spent: result.spent,
    };
  } catch (error) {
    // The map is already written and correct. Losing it over the step that adds
    // words to it would be the worst trade this pipeline could make.
    console.error("[semantic] pass failed, keeping the map", runId, error);
    return EMPTY;
  }
}
