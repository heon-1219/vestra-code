import { describe, expect, it } from "vitest";

import type { Llm, LlmReply, LlmRequest } from "@/lib/llm/types";

import type { AnalyzedEdge, AnalyzedNode, EdgeType, NodeType, SymbolKind } from "../types";

import { buildOutline, refKey, type KnownText } from "./outline";
import { runSemanticPass } from "./pass";
import { DEFAULT_SEMANTIC_BUDGET } from "./select";

/**
 * What Pass 2 actually costs, on a real project, from the command line.
 *
 *   VESTRA_MEASURE=<projectId> npx vitest run src/analysis/semantic/measure.test.ts
 *
 * A tool rather than a test, the same way `reanalyze.test.ts` is, and it exists
 * for the same reason the rest of this directory has numbers in its comments:
 * every constant in `select.ts` is a ceiling on somebody's money and wait, and
 * a ceiling chosen by feel is a ceiling that is wrong in a direction nobody
 * notices. This prints tokens per call, the finish reason of every call, and
 * what the parser threw away — which is how the first version of that budget
 * was caught silently truncating every batch that contained real source files.
 *
 * It reads the graph a previous run already wrote and asks the model again. It
 * writes nothing.
 */

const projectId = process.env.VESTRA_MEASURE ?? "";

if (projectId) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Absent or unreadable. The import below says so in the only way that
    // matters: `env.ts` refuses to hand out a half-configured environment.
  }
}

describe.skipIf(!projectId)("measuring Pass 2 on one real project", () => {
  it("prints what a run of it would cost", async () => {
    const { db } = await import("@/db");
    const { edges: edgesTable, nodes: nodesTable } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { llmFromEnv } = await import("@/lib/llm");

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
    const known = new Map<string, KnownText>();

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
      known.set(refKey(ref), {
        label: row.label,
        summary: row.summary,
        textLang: row.textLang,
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

    // Deliberately blank, so this measures a cold first run rather than the
    // zero-token re-read. The warm case is measured by its absence: no targets,
    // no calls.
    const outline = buildOutline({ nodes, edges }, new Map());
    console.log(
      `\n=== ${projectId} ===\n${outline.files.length} files, ${outline.byIndex.size} nameable things, ${edges.length} links`,
    );

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

    const result = await runSemanticPass({
      llm: watched,
      outline,
      scope: { mode: "full", reason: "no_base_run" },
    });

    const total = result.spent.inputTokens + result.spent.outputTokens;
    console.log(`\ncalls        ${result.spent.calls}`);
    console.log(`input        ${result.spent.inputTokens}`);
    console.log(`output       ${result.spent.outputTokens}`);
    console.log(`total        ${total}`);
    console.log(`named        ${result.text.length} of ${outline.byIndex.size}`);
    console.log(`features     ${result.features.length}`);
    console.log(`assigned     ${result.edges.length}`);
    console.log(`examined     ${result.examined.length}`);
    console.log(`not examined ${result.notExamined.length}`);
    console.log(`stopped      ${result.stopped ?? "no model"}`);
    console.log(`drops        ${JSON.stringify(result.drops)}`);
    console.log(`budget       ${JSON.stringify(DEFAULT_SEMANTIC_BUDGET)}`);

    /*
     * Prices as published on 2026-09-19 for `mimo-v2.5` (D45): about
     * $0.14 per million input tokens and $0.28 per million output.
     */
    const usd =
      (result.spent.inputTokens * 0.14 + result.spent.outputTokens * 0.28) / 1_000_000;
    console.log(`cost         $${usd.toFixed(5)} (~${Math.round(usd * 1380)}원)`);

    for (const feature of result.features) {
      console.log(`  기능 ${feature.label} — ${feature.memberCount}개`);
    }

    /*
     * The warm case, which is the one this pass will be in most often: the same
     * repository, read again, with nothing pushed since. Same outline, but this
     * time carrying the names already in the database and an incremental scope
     * with an empty change set.
     *
     * The number to look at is zero. Anything above it means an unchanged file
     * is being paid for twice.
     */
    const { loadSemanticState } = await import("./persist");
    const state = await loadSemanticState(db, projectId);
    const warm = await runSemanticPass({
      llm: watched,
      outline: buildOutline({ nodes, edges }, state.known),
      scope: { mode: "incremental", base: "before", head: "after", changed: new Set() },
      previousFeatures: state.previousFeatures,
    });
    console.log(
      `\nre-read with nothing changed: ${warm.spent.calls} calls, ` +
        `${warm.spent.inputTokens + warm.spent.outputTokens} tokens, ` +
        `${warm.carried.length} names carried forward`,
    );
    expect(warm.spent.calls).toBe(0);
  }, 10 * 60_000);
});
