import { describe, expect, it } from "vitest";

import { LlmError } from "@/lib/llm/types";

import type { ChangeScope } from "../incremental";

import { replyJson, scriptedLlm, shopGraph, userText } from "./__fixtures__/graph";
import type { PreviousFeature } from "./features";
import { buildOutline, refKey, type KnownText } from "./outline";
import { runSemanticPass, type SemanticEmitter } from "./pass";
import { DEFAULT_SEMANTIC_BUDGET } from "./select";

/**
 * Pass 2, end to end, with a model that says exactly what the test tells it.
 *
 * Nothing here imports `@/lib/llm` or `@/db`. Both reach `env.ts`, which
 * validates 21 variables at import time and throws, and this codebase has been
 * bitten by that five times. The model and the outline are parameters, which is
 * the same shape `RunAnalysisInput` uses — and it is why these tests run on a
 * machine with no API key.
 */

const FULL: ChangeScope = { mode: "full", reason: "no_base_run" };
const BIG_BATCH = { ...DEFAULT_SEMANTIC_BUDGET, batchSize: 100 };

function outlineOf(text: Record<string, KnownText> = {}) {
  const known = new Map<string, KnownText>();
  for (const [path, value] of Object.entries(text)) {
    known.set(refKey({ type: "file", filePath: path }), value);
  }
  return buildOutline(shopGraph(), known);
}

/** Index of a file in the outline, by path. Tests never hard-code a number. */
function indexOf(outline: ReturnType<typeof outlineOf>, path: string): number {
  const found = outline.files.find((file) => file.filePath === path);
  if (!found) throw new Error(`no ${path} in the outline`);
  return found.index;
}

function recorder(): { emit: SemanticEmitter; features: string[]; assigned: number[] } {
  const features: string[] = [];
  const assigned: number[] = [];
  return {
    features,
    assigned,
    emit: {
      featureCreated: (name) => void features.push(name),
      nodesAssigned: (count) => void assigned.push(count),
    },
  };
}

const NAMED: KnownText = { label: "값 모양 만들기", summary: "값을 보기 좋게 바꿔요.", textLang: "ko" };

describe("naming and grouping a project", () => {
  it("names files, draws features, and marks every one of them as a guess", async () => {
    const outline = outlineOf();
    const page = indexOf(outline, "src/app/checkout/page.tsx");
    const button = indexOf(outline, "src/components/PayButton.tsx");

    const { llm, requests } = scriptedLlm([
      replyJson({
        items: [
          { i: page, label: "결제 화면", summary: "물건 값을 내는 화면이에요." },
          { i: button, label: "결제 버튼", summary: "누르면 주문을 넣어요." },
        ],
      }),
      replyJson({
        features: [
          { name: "결제", summary: "물건 값을 받아요.", files: [page, button] },
        ],
      }),
    ]);

    const heard = recorder();
    const result = await runSemanticPass({
      llm,
      outline,
      scope: FULL,
      budget: BIG_BATCH,
      emit: heard.emit,
    });

    // One naming call plus one feature call. The feature question is asked once
    // for the whole project, which is what keeps it affordable (D52).
    expect(requests).toHaveLength(2);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].ref.type).toBe("feature");
    expect(result.nodes[0].metadata?.origin).toBe("llm");

    // Direction matters: member -> feature. `grouping.ts#byFeature` finds the
    // feature by looking at which end IS one, so a reversed edge would not
    // crash — it would quietly put the feature inside the file.
    expect(result.edges).toHaveLength(2);
    for (const edge of result.edges) {
      expect(edge.type).toBe("belongs_to");
      expect(edge.target.type).toBe("feature");
      expect(edge.source.type).toBe("file");
      // A model's opinion is never `certain`. No exception, ever.
      expect(edge.confidence).toBe("inferred");
      expect(edge.metadata?.origin).toBe("llm");
    }

    const labels = result.text.map((row) => row.label);
    expect(labels).toContain("결제 화면");
    expect(labels).toContain("결제 버튼");
    expect(labels).toContain("결제");

    expect(heard.features).toEqual(["결제"]);
    expect(heard.assigned).toEqual([2]);
  });

  it("sends no source, only the shape of the project", async () => {
    // Section 6.2 and D52, and also D49's trust line: a file inside the
    // repository must not be able to influence what we tell its owner their
    // own app contains.
    const outline = outlineOf();
    const { llm, requests } = scriptedLlm([
      replyJson({ items: [] }),
      replyJson({ features: [] }),
    ]);
    await runSemanticPass({ llm, outline, scope: FULL, budget: BIG_BATCH });

    const asked = requests.map(userText).join("\n");
    expect(asked).toContain("src/lib/useCart.ts");
    expect(asked).toContain("/checkout");
    expect(asked).not.toContain("function");
    expect(asked).not.toContain("import ");
  });

  it("never puts a node id in a prompt (D46)", async () => {
    const outline = outlineOf();
    const { llm, requests } = scriptedLlm([
      replyJson({ items: [] }),
      replyJson({ features: [] }),
    ]);
    await runSemanticPass({ llm, outline, scope: FULL, budget: BIG_BATCH });
    for (const request of requests) {
      expect(userText(request)).not.toMatch(/\b[0-9a-f]{32}\b/);
    }
  });

  it("asks in batches, and a batch is one question", async () => {
    const outline = outlineOf();
    const { llm, requests } = scriptedLlm([
      replyJson({ items: [] }),
      replyJson({ items: [] }),
      replyJson({ items: [] }),
      replyJson({ features: [] }),
    ]);
    await runSemanticPass({
      llm,
      outline,
      scope: FULL,
      budget: { ...DEFAULT_SEMANTIC_BUDGET, batchSize: 2 },
    });
    // 6 files at 2 per call is 3 naming calls, plus the one feature call.
    expect(requests).toHaveLength(4);
  });
});

describe("what it refuses to write", () => {
  it("drops a name the model invented an index for", async () => {
    const outline = outlineOf();
    const { llm } = scriptedLlm([
      replyJson({ items: [{ i: 9999, label: "지어낸 이름", summary: "없는 파일이에요." }] }),
      replyJson({ features: [] }),
    ]);
    const result = await runSemanticPass({ llm, outline, scope: FULL, budget: BIG_BATCH });
    expect(result.text).toHaveLength(0);
    expect(result.drops.unknown_index).toBe(1);
  });

  it("drops a forbidden word rather than putting it on the map", async () => {
    const outline = outlineOf();
    const page = indexOf(outline, "src/app/checkout/page.tsx");
    const { llm } = scriptedLlm([
      replyJson({
        items: [{ i: page, label: "안전한 결제", summary: "결제를 안전하게 해요." }],
      }),
      replyJson({ features: [{ name: "노드 관리", files: [page] }] }),
    ]);
    const result = await runSemanticPass({ llm, outline, scope: FULL, budget: BIG_BATCH });

    expect(result.text).toHaveLength(0);
    expect(result.nodes).toHaveLength(0);
    expect(result.drops.forbidden_word).toBeGreaterThanOrEqual(2);
  });

  it("throws away a truncated reply whole, and asks a narrower question instead", async () => {
    /*
     * The defect this pins, found by measuring rather than by reading. The
     * first real run sent a flat 2,000-token ceiling; the first batch — twenty
     * files carrying 120 pieces — answered at 1,985 tokens with
     * `finishReason: "length"` and was discarded. Every Python file in that
     * project came back unnamed while its markdown was named perfectly, the run
     * completed, and the coverage event reported full coverage.
     *
     * Half a JSON object must never be kept: it would name the first few files
     * and lose the rest with nothing on screen to say any are missing. So the
     * reply is dropped, counted, and the batch asked again without its pieces —
     * which is two thirds less answer, and the part D52 says is the point.
     */
    const outline = outlineOf();
    const page = indexOf(outline, "src/app/checkout/page.tsx");
    const { llm, requests } = scriptedLlm([
      replyJson(
        { items: [{ i: page, label: "잘린 답", summary: "여기서 끊겼어요." }] },
        { finishReason: "length" },
      ),
      replyJson({ items: [{ i: page, label: "결제 화면", summary: "값을 내는 화면이에요." }] }),
      replyJson({ features: [] }),
    ]);
    const result = await runSemanticPass({ llm, outline, scope: FULL, budget: BIG_BATCH });

    expect(result.drops.truncated).toBe(1);
    expect(result.text.map((row) => row.label)).toEqual(["결제 화면"]);
    // Nothing from the truncated answer survives, however well-formed it looked.
    expect(result.text.map((row) => row.label)).not.toContain("잘린 답");

    // The retry is narrower, not the same question again: no piece is offered.
    const pieceIndex = outline.files
      .flatMap((file) => file.pieces)
      .map((piece) => piece.index);
    const retry = userText(requests[1]);
    for (const index of pieceIndex) expect(retry).not.toContain(`[${index}]`);

    // Read, though. The file was opened; it is the answer that was unusable.
    expect(result.examined).toHaveLength(6);
  });

  it("asks for a longer answer when the batch is longer", async () => {
    const outline = outlineOf();
    const { llm, requests } = scriptedLlm([
      replyJson({ items: [] }),
      replyJson({ items: [] }),
      replyJson({ features: [] }),
    ]);
    await runSemanticPass({
      llm,
      outline,
      scope: FULL,
      budget: { ...DEFAULT_SEMANTIC_BUDGET, batchSize: 4 },
    });
    // Six files at four per batch: a full batch, then a batch of two. The
    // ceiling is computed from what was asked, so the second is smaller.
    const ceilings = requests.slice(0, 2).map((r) => r.maxOutputTokens ?? 0);
    expect(ceilings[0]).toBeGreaterThan(ceilings[1]);
  });
});

describe("when the model is absent or breaks", () => {
  it("does nothing at all without a model, and says nothing about coverage", async () => {
    const result = await runSemanticPass({
      llm: null,
      outline: outlineOf(),
      scope: FULL,
    });
    expect(result.stopped).toBeNull();
    expect(result.text).toHaveLength(0);
    expect(result.spent.calls).toBe(0);
  });

  it("keeps last run's features when there is no model", async () => {
    // A `feature` node has no file path, so nothing else in the pipeline can
    // carry it past D20's sweep. Without this, one run with no key would delete
    // every territory on the map and cascade the user's own corrections with it.
    const previous: PreviousFeature[] = [
      { key: "feature:abc123abc123", label: "결제", memberPaths: ["src/lib/format.ts"] },
    ];
    const result = await runSemanticPass({
      llm: null,
      outline: outlineOf(),
      scope: FULL,
      previousFeatures: previous,
    });
    expect(result.nodes.map((n) => n.ref.name)).toEqual(["feature:abc123abc123"]);
    expect(result.edges).toHaveLength(1);
  });

  it("stops after a failure that retrying cannot fix, and reports it in Korean", async () => {
    const { llm, requests } = scriptedLlm([
      () => {
        throw new LlmError("401", "auth", 401);
      },
    ]);
    const result = await runSemanticPass({
      llm,
      outline: outlineOf(),
      scope: FULL,
      budget: { ...DEFAULT_SEMANTIC_BUDGET, batchSize: 1 },
    });

    // One attempt, not six. A wrong key is still wrong on the sixth batch.
    expect(requests).toHaveLength(1);
    expect(result.stopped).toBe("llm_error");
    expect(result.error).toMatch(/열쇠/);
    expect(result.notExamined).toHaveLength(6);
  });

  it("walks past a failure that retrying can fix", async () => {
    const outline = outlineOf();
    const { llm, requests } = scriptedLlm([
      () => {
        throw new LlmError("429", "rate_limit", 429);
      },
      replyJson({ items: [] }),
      replyJson({ items: [] }),
      replyJson({ items: [] }),
      replyJson({ items: [] }),
      replyJson({ items: [] }),
      replyJson({ features: [] }),
    ]);
    const result = await runSemanticPass({
      llm,
      outline,
      scope: FULL,
      budget: { ...DEFAULT_SEMANTIC_BUDGET, batchSize: 1 },
    });
    expect(requests).toHaveLength(7);
    expect(result.notExamined).toHaveLength(1);
    expect(result.examined).toHaveLength(5);
  });

  it("keeps last run's features when the feature call itself fails", async () => {
    const outline = outlineOf();
    const page = indexOf(outline, "src/app/checkout/page.tsx");
    const previous: PreviousFeature[] = [
      { key: "feature:keepme00000", label: "결제", memberPaths: ["src/lib/format.ts"] },
    ];
    const { llm } = scriptedLlm([
      replyJson({ items: [{ i: page, label: "결제 화면", summary: "값을 내는 화면이에요." }] }),
      () => {
        throw new LlmError("503", "unavailable", 503);
      },
    ]);
    const result = await runSemanticPass({
      llm,
      outline,
      scope: FULL,
      previousFeatures: previous,
      budget: BIG_BATCH,
    });

    // The naming half worked and is kept; the grouping falls back to what the
    // last run drew rather than to nothing.
    expect(result.text.map((row) => row.label)).toContain("결제 화면");
    expect(result.nodes.map((n) => n.ref.name)).toEqual(["feature:keepme00000"]);
  });

  it("stops when the budget runs out and counts what it never opened", async () => {
    const outline = outlineOf();
    const { llm } = scriptedLlm([
      replyJson({ items: [] }, { usage: { inputTokens: 900, outputTokens: 200 } }),
      replyJson({ features: [] }),
    ]);
    const result = await runSemanticPass({
      llm,
      outline,
      scope: FULL,
      budget: { ...DEFAULT_SEMANTIC_BUDGET, batchSize: 1, maxTokens: 1_000 },
    });
    expect(result.stopped).toBe("token_budget");
    expect(result.examined).toHaveLength(1);
    expect(result.notExamined).toHaveLength(5);
  });
});

describe("the second run", () => {
  it("asks nothing at all when nothing changed and everything has a name", async () => {
    // The case this code is in most often, and the one D53 wants to cost zero.
    const everything: Record<string, KnownText> = {};
    for (const file of outlineOf().files) everything[file.filePath] = NAMED;

    const { llm, requests } = scriptedLlm([]);
    const result = await runSemanticPass({
      llm,
      outline: outlineOf(everything),
      scope: { mode: "incremental", base: "a", head: "b", changed: new Set() },
      previousFeatures: [
        { key: "feature:stable00000", label: "결제", memberPaths: ["src/lib/format.ts"] },
      ],
    });

    expect(requests).toHaveLength(0);
    expect(result.spent.calls).toBe(0);
    expect(result.carried).toHaveLength(6);
    expect(result.nodes.map((n) => n.ref.name)).toEqual(["feature:stable00000"]);
  });

  it("keeps a feature's id when the model renames it (D55)", async () => {
    const outline = outlineOf();
    const page = indexOf(outline, "src/app/checkout/page.tsx");
    const button = indexOf(outline, "src/components/PayButton.tsx");

    const first = scriptedLlm([
      replyJson({ items: [] }),
      replyJson({ features: [{ name: "결제", files: [page, button] }] }),
    ]);
    const one = await runSemanticPass({
      llm: first.llm,
      outline,
      scope: FULL,
      budget: BIG_BATCH,
    });
    const key = one.nodes[0].ref.name;
    expect(key).toBeTruthy();

    // Second run: the same members, a different Korean word. If the id were a
    // hash of the name, the sweep would delete the old row and CASCADE would
    // take the user's `belongs_to` corrections with it.
    const second = scriptedLlm([
      replyJson({ items: [] }),
      replyJson({ features: [{ name: "결제하기", files: [page, button] }] }),
    ]);
    const two = await runSemanticPass({
      llm: second.llm,
      outline,
      scope: FULL,
      budget: BIG_BATCH,
      previousFeatures: [
        {
          key: key as string,
          label: "결제",
          memberPaths: ["src/app/checkout/page.tsx", "src/components/PayButton.tsx"],
        },
      ],
    });

    expect(two.nodes[0].ref.name).toBe(key);
    expect(two.text.find((row) => row.ref.type === "feature")?.label).toBe("결제하기");
  });

  it("keeps a feature's id when a member moves but the name holds", async () => {
    const outline = outlineOf();
    const page = indexOf(outline, "src/app/checkout/page.tsx");
    const button = indexOf(outline, "src/components/PayButton.tsx");
    const cart = indexOf(outline, "src/lib/useCart.ts");

    const { llm } = scriptedLlm([
      replyJson({ items: [] }),
      replyJson({ features: [{ name: "결제", files: [page, button, cart] }] }),
    ]);
    const result = await runSemanticPass({
      llm,
      outline,
      scope: FULL,
      budget: BIG_BATCH,
      previousFeatures: [
        {
          key: "feature:original000",
          label: "결제",
          memberPaths: ["src/app/checkout/page.tsx", "src/components/PayButton.tsx"],
        },
      ],
    });
    expect(result.nodes[0].ref.name).toBe("feature:original000");
  });

  it("gives a genuinely different feature a new id", async () => {
    const outline = outlineOf();
    const cart = indexOf(outline, "src/lib/useCart.ts");
    const { llm } = scriptedLlm([
      replyJson({ items: [] }),
      replyJson({ features: [{ name: "장바구니", files: [cart] }] }),
    ]);
    const result = await runSemanticPass({
      llm,
      outline,
      scope: FULL,
      budget: BIG_BATCH,
      previousFeatures: [
        {
          key: "feature:payment0000",
          label: "결제",
          memberPaths: ["src/app/checkout/page.tsx", "src/components/PayButton.tsx"],
        },
      ],
    });
    expect(result.nodes[0].ref.name).not.toBe("feature:payment0000");
  });
});
