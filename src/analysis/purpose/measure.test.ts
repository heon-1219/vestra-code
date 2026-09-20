import { describe, expect, it } from "vitest";

import type { Llm, LlmReply, LlmRequest } from "@/lib/llm/types";

import type { AnalyzedEdge, AnalyzedNode, EdgeType, NodeType, SymbolKind } from "../types";

import { buildPurposeAsks, DEFAULT_PURPOSE_BUDGET, type NodeText } from "./ask";
import { runPurposePass } from "./pass";

/**
 * What Pass 3 costs, and whether its sentence is a copy of one we already have.
 *
 *   VESTRA_PURPOSE=<projectId> npx vitest run src/analysis/purpose/measure.test.ts
 *   VESTRA_PURPOSE_MAX=120   how many purposes to actually pay for (default 120)
 *   VESTRA_PURPOSE_DRY=1     count and rank, ask nothing, spend nothing
 *
 * A tool rather than a test, the same shape as `semantic/measure.test.ts`, and
 * it exists for two separate jobs.
 *
 * **The cost.** Every constant in `ask.ts` is a ceiling on somebody's money and
 * wait. This prints tokens per call, the finish reason of every call, and what
 * the parser threw away — which is how D88's silent truncation was caught.
 *
 * **The storage question.** `FLOW_TRACKING.md` §12.1 says the purpose key may
 * not earn its own table, because "for a `calls` edge the purpose is close to
 * the target's `nodes.summary`". That was written before Pass 2 existed. This
 * counts how many purpose targets actually carry a summary, which is the
 * measurement §12.1 asks for and the one the decision rests on.
 *
 * It reads a graph a previous run already wrote and writes nothing.
 */

const projectId = process.env.VESTRA_PURPOSE ?? "";

if (projectId) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Absent or unreadable. The import below says so in the only way that
    // matters: `env.ts` refuses to hand out a half-configured environment.
  }
}

describe.skipIf(!projectId)("measuring Pass 3 on one real project", () => {
  it("prints what a run of it would cost, and whether the sentence is new", async () => {
    const { db } = await import("@/db");
    const { edges: edgesTable, nodes: nodesTable } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { llmFromEnv } = await import("@/lib/llm");
    const { refKey } = await import("./ask");

    const nodeRows = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.projectId, projectId));
    const edgeRows = await db
      .select()
      .from(edgesTable)
      .where(eq(edgesTable.projectId, projectId));

    expect(nodeRows.length, `no graph for ${projectId}`).toBeGreaterThan(0);

    const refById = new Map<string, { type: NodeType; filePath: string; name?: string }>();
    const nodes: AnalyzedNode[] = [];
    const text = new Map<string, NodeText>();

    for (const row of nodeRows) {
      const ref = {
        type: row.type as NodeType,
        filePath: row.filePath ?? "",
        ...(row.type === "file" ? {} : { name: row.name }),
      };
      refById.set(row.id, ref);
      nodes.push({
        ref,
        ...(row.kind ? { kind: row.kind as SymbolKind } : {}),
        ...(row.startLine !== null ? { startLine: row.startLine } : {}),
      });
      if (row.textLang === "ko" && (row.label !== null || row.summary !== null)) {
        text.set(refKey(ref), { label: row.label, summary: row.summary });
      }
    }

    const edges: AnalyzedEdge[] = [];
    for (const row of edgeRows) {
      const source = refById.get(row.sourceNodeId);
      const target = refById.get(row.targetNodeId);
      if (!source || !target) continue;
      edges.push({
        source,
        target,
        type: row.type as EdgeType,
        confidence: row.confidence,
      });
    }

    const { asks, groups } = buildPurposeAsks({ nodes, edges }, text);
    const connections = groups.reduce((total, group) => total + group.edgeIds.length, 0);

    console.log(`\n=== ${projectId} ===`);
    console.log(
      `${nodes.length} items, ${edges.length} connections; ` +
        `${connections} of them explainable, collapsing into ${asks.length} purposes ` +
        `(${(connections / Math.max(1, asks.length)).toFixed(2)} connections per purpose)`,
    );

    /*
     * §12.1's question, as a count. If the purpose were close to the target's
     * own summary, most of these would have one.
     */
    const byRelation = new Map<string, { purposes: number; withSummary: number }>();
    for (const ask of asks) {
      const row = byRelation.get(ask.relation) ?? { purposes: 0, withSummary: 0 };
      row.purposes += 1;
      if (ask.targetSummary) row.withSummary += 1;
      byRelation.set(ask.relation, row);
    }
    console.log("\npurposes whose target already carries a summary (FLOW_TRACKING §12.1):");
    let withSummary = 0;
    for (const [relation, row] of [...byRelation].sort((a, b) => b[1].purposes - a[1].purposes)) {
      withSummary += row.withSummary;
      console.log(
        `  ${relation.padEnd(13)} ${String(row.purposes).padStart(4)} purposes, ` +
          `${row.withSummary} with a summary`,
      );
    }
    console.log(
      `  total ${withSummary} of ${asks.length} ` +
        `(${((withSummary / Math.max(1, asks.length)) * 100).toFixed(0)}%)`,
    );

    if (process.env.VESTRA_PURPOSE_DRY === "1") return;

    const real = llmFromEnv();
    expect(real, "no model configured in .env.local").not.toBeNull();
    if (!real) return;

    let call = 0;
    const watched: Llm = {
      async complete(request: LlmRequest): Promise<LlmReply> {
        call += 1;
        const asked = request.messages.map((m) => m.content).join("").length;
        const started = Date.now();
        const reply = await real.complete(request);
        console.log(
          `call ${call}: ${asked} chars asked, ` +
            `${reply.usage.inputTokens} in / ${reply.usage.outputTokens} out ` +
            `(ceiling ${request.maxOutputTokens}), ${reply.finishReason}, ` +
            `${Date.now() - started}ms`,
        );
        return reply;
      },
    };

    const maxGroups = Number(process.env.VESTRA_PURPOSE_MAX ?? "120");
    const result = await runPurposePass({
      llm: watched,
      asks,
      // Deliberately blank, so this measures a cold first run rather than the
      // zero-token re-read. The warm case is measured by its absence below.
      known: new Map(),
      scope: { mode: "full", reason: "no_base_run" },
      budget: { ...DEFAULT_PURPOSE_BUDGET, maxGroups },
    });

    const total = result.spent.inputTokens + result.spent.outputTokens;
    console.log(`\ncalls        ${result.spent.calls}`);
    console.log(`input        ${result.spent.inputTokens}`);
    console.log(`output       ${result.spent.outputTokens}`);
    console.log(`total        ${total}`);
    console.log(`answered     ${result.answered} of ${Math.min(maxGroups, asks.length)} asked`);
    console.log(`not answered ${result.notAnswered}`);
    console.log(`stopped      ${result.stopped ?? "no model"}`);
    console.log(`drops        ${JSON.stringify(result.drops)}`);

    /*
     * Prices as published on 2026-09-19 for `mimo-v2.5` (D45): about
     * $0.14 per million input tokens and $0.28 per million output.
     */
    const usd = (result.spent.inputTokens * 0.14 + result.spent.outputTokens * 0.28) / 1e6;
    const perPurpose = usd / Math.max(1, result.answered);
    console.log(`cost         $${usd.toFixed(5)} (~${Math.round(usd * 1380)}원)`);
    console.log(
      `whole project would be ~${Math.round(perPurpose * asks.length * 1380)}원 ` +
        `for all ${asks.length} purposes`,
    );

    console.log("\nwhat it said, most-reached-for first:");
    for (const ask of asks.slice(0, 40)) {
      const sentence = result.answers.get(ask.key);
      if (!sentence) continue;
      console.log(
        `  ${String(ask.sources).padStart(3)}곳  ${ask.relation.padEnd(13)} ` +
          `${ask.targetLabel ?? ask.targetName}\n       → ${sentence}` +
          (ask.targetSummary ? `\n       (summary said: ${ask.targetSummary})` : ""),
      );
    }

    /*
     * The warm case, which is the one this pass will be in most often: the same
     * project, read again, with nothing pushed since. The number to look at is
     * zero. Anything above it means an unchanged purpose is being paid for
     * twice.
     */
    const warm = await runPurposePass({
      llm: watched,
      asks,
      known: result.answers,
      scope: { mode: "incremental", base: "before", head: "after", changed: new Set() },
    });
    console.log(
      `\nre-read with nothing changed: ${warm.spent.calls} calls, ` +
        `${warm.spent.inputTokens + warm.spent.outputTokens} tokens, ` +
        `${warm.carried} purposes carried forward`,
    );
    expect(warm.spent.calls).toBe(0);
  }, 15 * 60_000);

  /*
   * The same zero, through the half that touches Postgres.
   *
   * The test above proves the pure pass carries forward. This proves the layer
   * does — that `loadStoredPurposes` finds what the last run wrote, maps it
   * back onto purposes through this run's graph, and asks nothing. It is the
   * one part of the incremental promise that a unit test cannot reach, because
   * the mapping goes through a hashed edge id and the hash needs a project.
   *
   * It writes, and writing the same sentences back is idempotent.
   */
  it("carries every stored sentence forward without asking, against the real database", async () => {
    const { db } = await import("@/db");
    const { edges: edgesTable, nodes: nodesTable } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { runPurposeLayer } = await import("./index");

    const nodeRows = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.projectId, projectId));
    const edgeRows = await db
      .select()
      .from(edgesTable)
      .where(eq(edgesTable.projectId, projectId));

    const refById = new Map<string, { type: NodeType; filePath: string; name?: string }>();
    const nodes: AnalyzedNode[] = [];
    for (const row of nodeRows) {
      const ref = {
        type: row.type as NodeType,
        filePath: row.filePath ?? "",
        ...(row.type === "file" ? {} : { name: row.name }),
      };
      refById.set(row.id, ref);
      nodes.push({
        ref,
        ...(row.kind ? { kind: row.kind as SymbolKind } : {}),
        ...(row.startLine !== null ? { startLine: row.startLine } : {}),
      });
    }
    const edges: AnalyzedEdge[] = [];
    for (const row of edgeRows) {
      const source = refById.get(row.sourceNodeId);
      const target = refById.get(row.targetNodeId);
      if (!source || !target) continue;
      edges.push({
        source,
        target,
        type: row.type as EdgeType,
        confidence: row.confidence,
      });
    }

    const result = await runPurposeLayer({
      db,
      projectId,
      // Deliberately a model that throws if anything reaches it: the assertion
      // is that nothing does, and a null here would prove only that a null
      // model asks nothing.
      llm: {
        complete() {
          throw new Error("a warm re-read must not ask anything");
        },
      },
      graph: { nodes, edges },
      scope: { mode: "incremental", base: "before", head: "after", changed: new Set() },
    });

    console.log(
      `
warm layer: ${result.carried} purposes carried, ${result.answered} asked, ` +
        `${result.spent.calls} calls, ${result.connectionsWritten} connections restated`,
    );

    /*
     * Expect a handful short of every purpose, and a `stopped: 'llm_error'`
     * with it. That is this TOOL's limitation and not the pass's: a symbol's
     * `container` is not a column — it lives inside the id hash, which is what
     * `semantic/persist.ts` records — so a ref rebuilt here from `nodes` alone
     * loses it, and a method's edge hashes to a different id than the one the
     * real run wrote. Measured on `vestra-code`: 967 of 984 carried.
     *
     * In the pipeline the graph comes from the analyzer with containers intact
     * and the mapping is exact. The assertions below are the ones that hold
     * either way, and the throwing model is what makes "0 calls" mean something
     * a null model could not.
     */
    expect(result.spent.calls).toBe(0);
    expect(result.carried).toBeGreaterThan(0);
    expect(result.answered).toBe(0);
    // Restated onto every connection, including any written since — which is
    // the reason this writes at all rather than doing nothing.
    expect(result.connectionsWritten).toBeGreaterThanOrEqual(result.carried);
  }, 5 * 60_000);
});
