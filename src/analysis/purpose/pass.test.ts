import { describe, expect, it } from "vitest";

import { MAX_FLOW_HOPS } from "@/lib/graph/flow";
import { LlmError } from "@/lib/llm/types";

import type { ChangeScope } from "../incremental";
import { replyJson, scriptedLlm, userText } from "../semantic/__fixtures__/graph";

import { buildPurposeAsks, DEFAULT_PURPOSE_BUDGET, type PurposeAsk } from "./ask";
import { spreadPurpose } from "./groups";
import { runPurposePass } from "./pass";
import { manyHelpersGraph, sharedHelperGraph } from "./__fixtures__/graph";

/**
 * Pass 3, end to end, with a model that says exactly what the test tells it.
 *
 * Nothing here imports `@/lib/llm` or `@/db`. Both reach `env.ts`, which
 * validates 21 variables at import time and throws, and this codebase has been
 * bitten by that five times. The model, the questions and the budget are all
 * parameters — the same shape `RunAnalysisInput` uses — which is why these
 * tests run on a machine with no API key.
 */

const FULL: ChangeScope = { mode: "full", reason: "no_base_run" };
const NOTHING_CHANGED: ChangeScope = {
  mode: "incremental",
  base: "before",
  head: "after",
  changed: new Set(),
};

/** Answer every index the prompt was given, with one sentence each. */
function answerAll(asks: readonly PurposeAsk[]) {
  return replyJson({
    items: asks.map((ask) => ({ i: ask.index, why: `여기서 ${ask.index}번 일을 해요.` })),
  });
}

describe("asking what a connection is for", () => {
  it("asks once about a helper twelve places call, and spreads the answer to all twelve", async () => {
    const graph = sharedHelperGraph(12);
    const { asks, groups } = buildPurposeAsks(graph);
    const helper = asks.find((ask) => ask.relation === "calls");
    expect(helper).toBeDefined();

    const { llm, requests } = scriptedLlm([answerAll(asks)]);
    const result = await runPurposePass({ llm, asks, known: new Map(), scope: FULL });

    expect(requests).toHaveLength(1);
    const byEdge = spreadPurpose(groups, result.answers);
    const group = groups.find((entry) => entry.key === helper?.key);
    expect(group?.edgeIds).toHaveLength(12);
    // Twelve connections, one sentence, and it is the SAME string on all of
    // them. A map that words one fact twelve ways is one nobody believes.
    const said = new Set(group?.edgeIds.map((id) => byEdge.get(id)));
    expect(said.size).toBe(1);
    expect([...said][0]).toBeTypeOf("string");
  });

  it("never sends a node id, only the integers it made up (D46)", async () => {
    const { asks } = buildPurposeAsks(sharedHelperGraph(3));
    const { llm, requests } = scriptedLlm([answerAll(asks)]);
    await runPurposePass({ llm, asks, known: new Map(), scope: FULL });

    const sent = userText(requests[0]);
    for (const ask of asks) expect(sent).toContain(`[${ask.index}]`);
    expect(sent).not.toMatch(/[0-9a-f]{32}/);
  });

  it("never sends source text", async () => {
    const { asks } = buildPurposeAsks(sharedHelperGraph(2));
    const { llm, requests } = scriptedLlm([answerAll(asks)]);
    await runPurposePass({ llm, asks, known: new Map(), scope: FULL });
    expect(userText(requests[0])).not.toContain("function");
    expect(userText(requests[0])).not.toContain("=>");
  });
});

describe("what a failure costs", () => {
  it("keeps the map when there is no model at all, and says nothing is wrong", async () => {
    const { asks } = buildPurposeAsks(sharedHelperGraph(3));
    const result = await runPurposePass({ llm: null, asks, known: new Map(), scope: FULL });

    expect(result.spent.calls).toBe(0);
    // Null, not a stop reason: a configuration we chose is not a fault the user
    // caused and cannot fix.
    expect(result.stopped).toBeNull();
    expect(result.answers.size).toBe(0);
    expect(result.notAnswered).toBe(asks.length);
  });

  it("restates every sentence it already had, even with no model", async () => {
    const { asks } = buildPurposeAsks(sharedHelperGraph(3));
    const known = new Map(asks.map((ask) => [ask.key, "여기서 값을 다듬어요."]));

    const result = await runPurposePass({
      llm: null,
      asks,
      known,
      scope: NOTHING_CHANGED,
    });
    expect(result.carried).toBe(asks.length);
    expect(result.answers.size).toBe(asks.length);
  });

  it("stops asking after a key that will still be wrong on the next batch", async () => {
    const { asks } = buildPurposeAsks(manyHelpersGraph(60));
    const { llm, requests } = scriptedLlm([
      () => {
        throw new LlmError("열쇠가 맞지 않아요.", "auth");
      },
      () => {
        throw new Error("이 호출은 일어나면 안 돼요.");
      },
    ]);

    const result = await runPurposePass({ llm, asks, known: new Map(), scope: FULL });
    expect(requests).toHaveLength(1);
    expect(result.stopped).toBe("llm_error");
    expect(result.error).toContain("열쇠");
    expect(result.notAnswered).toBe(asks.length);
  });

  it("keeps going after one batch fails for a reason that might not repeat", async () => {
    const { asks } = buildPurposeAsks(manyHelpersGraph(60));
    const budget = { ...DEFAULT_PURPOSE_BUDGET, batchSize: 30 };
    const { llm, requests } = scriptedLlm([
      () => {
        throw new LlmError("잠시 바빠요.", "rate_limit");
      },
      replyJson({ items: [] }),
      replyJson({ items: [] }),
      replyJson({ items: [] }),
    ]);

    const result = await runPurposePass({ llm, asks, known: new Map(), scope: FULL, budget });
    expect(requests.length).toBeGreaterThan(1);
    expect(result.stopped).toBe("completed");
  });

  it("re-asks a truncated batch narrower instead of losing it (D88)", async () => {
    const { asks } = buildPurposeAsks(manyHelpersGraph(20));
    const budget = { ...DEFAULT_PURPOSE_BUDGET, batchSize: asks.length };

    let call = 0;
    const llm = {
      complete(request: { messages: { role: string; content: string }[] }) {
        call += 1;
        const sent = request.messages.find((m) => m.role === "user")?.content ?? "";
        const indices = [...sent.matchAll(/^\[(\d+)\]/gmu)].map((m) => Number(m[1]));
        if (call === 1) {
          return Promise.resolve(
            replyJson({ items: [] }, { finishReason: "length" as const }),
          );
        }
        return Promise.resolve(
          replyJson({ items: indices.map((i) => ({ i, why: "여기서 값을 다듬어요." })) }),
        );
      },
    };

    const result = await runPurposePass({ llm, asks, known: new Map(), scope: FULL, budget });
    expect(result.drops.truncated).toBe(1);
    // Both halves came back on the queue, so nothing was lost to the ceiling.
    expect(result.answered).toBe(asks.length);
    expect(result.notAnswered).toBe(0);
  });

  it("says how many purposes the budget could not reach", async () => {
    const { asks } = buildPurposeAsks(manyHelpersGraph(20));
    const budget = { ...DEFAULT_PURPOSE_BUDGET, maxGroups: 2, batchSize: 2 };
    const { llm } = scriptedLlm([replyJson({ items: [] })]);

    const result = await runPurposePass({ llm, asks, known: new Map(), scope: FULL, budget });
    expect(result.stopped).toBe("group_budget");
    expect(result.notAnswered).toBe(asks.length);
  });
});

/**
 * §8.7 of `docs/FLOW_TRACKING.md`, as an assertion rather than as a paragraph.
 *
 * The rule the founder's token question was really about: **a twelve-hop flow
 * costs zero model calls warm and at most one cold.** It holds for a structural
 * reason rather than by luck — a hop's sentence is its (relation, target)
 * purpose, twelve hops are at most twelve purposes, and one request carries
 * `batchSize` of them. So the assertion is on the budget as much as on the run.
 */
describe("what a twelve-hop flow costs (FLOW_TRACKING §8.7)", () => {
  const twelve = () =>
    buildPurposeAsks(manyHelpersGraph(MAX_FLOW_HOPS * 4)).asks.slice(0, MAX_FLOW_HOPS);

  it("fits a whole flow's worth of purposes in one request", () => {
    expect(DEFAULT_PURPOSE_BUDGET.batchSize).toBeGreaterThanOrEqual(MAX_FLOW_HOPS);
  });

  it("costs exactly one call cold", async () => {
    const asks = twelve();
    expect(asks).toHaveLength(MAX_FLOW_HOPS);

    const { llm, requests } = scriptedLlm([answerAll(asks)]);
    const result = await runPurposePass({ llm, asks, known: new Map(), scope: FULL });

    expect(requests).toHaveLength(1);
    expect(result.spent.calls).toBeLessThanOrEqual(1);
  });

  it("costs zero calls and zero tokens warm", async () => {
    const asks = twelve();
    const known = new Map(asks.map((ask) => [ask.key, "여기서 값을 다듬어요."]));
    const { llm, requests } = scriptedLlm([]);

    const result = await runPurposePass({ llm, asks, known, scope: NOTHING_CHANGED });

    expect(requests).toHaveLength(0);
    expect(result.spent.calls).toBe(0);
    expect(result.spent.inputTokens + result.spent.outputTokens).toBe(0);
    expect(result.carried).toBe(MAX_FLOW_HOPS);
    // And every hop still has its sentence, which is the half that makes the
    // zero worth having.
    expect(result.answers.size).toBe(MAX_FLOW_HOPS);
  });
});
