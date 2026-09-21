import { describe, expect, it, vi } from "vitest";

import type { Llm } from "@/lib/llm/types";

import {
  call,
  fixtureReader,
  GRAPH,
  ITEMS,
  replyWith,
  scriptedLlm,
} from "./__fixtures__/project";
import { GROUNDED_FALLBACK_SUMMARY, UNGROUNDED_SUMMARY } from "./answer";
import {
  deepSummaryAuthor,
  EXPLAIN_BUDGET,
  EXPLAIN_STOP_WORDS,
  EXPLAIN_WORDS,
  explainQuestion,
  prepareExplain,
  type ExplainDeps,
  type ExplainProject,
} from "./explain";
import { investigate } from "./loop";
import { buildSystemPrompt } from "./prompt";
import type { QaGraph } from "./tools";

/**
 * 설명하기's deep read: who may ask for it, what it refuses, and the one change
 * it makes to the loop's brief.
 *
 * Driven with fakes, so nothing here touches the environment — `@/db` and
 * `@/lib/llm` both reach `env.ts`, which throws at import on a machine without
 * all 21 variables.
 */

const PROJECT_ID = "6a069e22-91c8-492a-baea-820be1f8d7f6";
const OWNER = "user-owner";

const GITHUB: ExplainProject = {
  id: PROJECT_ID,
  source: "github",
  repoOwner: "heon1219",
  repoName: "vestra-code",
  defaultBranch: "main",
};

const LLM: Llm = { complete: async () => Promise.reject(new Error("not in this test")) };

function deps(overrides: Partial<ExplainDeps> = {}): ExplainDeps {
  return {
    session: async () => ({ user: { id: OWNER } }),
    findOwnedProject: async (projectId, userId) =>
      projectId === PROJECT_ID && userId === OWNER ? GITHUB : null,
    llm: () => LLM,
    loadGraph: async () => GRAPH,
    storedFiles: async () => 12,
    sourceFor: async () => fixtureReader(),
    ...overrides,
  };
}

const ask = (d: ExplainDeps, body: unknown = { itemId: "s-pay" }, id: string = PROJECT_ID) =>
  prepareExplain(d, { id }, async () => body);

describe("who may ask", () => {
  it("refuses without a session, before looking the project up", async () => {
    const findOwnedProject = vi.fn();
    const result = await ask(deps({ session: async () => null, findOwnedProject }));
    expect(result).toEqual({ ok: false, status: 401, message: EXPLAIN_WORDS.unauthenticated });
    expect(findOwnedProject).not.toHaveBeenCalled();
  });

  it("looks the project up as the signed-in user", async () => {
    const findOwnedProject = vi.fn(async () => GITHUB);
    await ask(deps({ findOwnedProject }));
    expect(findOwnedProject).toHaveBeenCalledWith(PROJECT_ID, OWNER);
  });

  it("answers somebody else's project exactly as a missing one, and reads nothing of it", async () => {
    const loadGraph = vi.fn(async () => GRAPH);
    const llm = vi.fn(() => LLM);
    const stranger = await ask(
      deps({ session: async () => ({ user: { id: "someone-else" } }), loadGraph, llm }),
    );
    const missing = await ask(deps({ loadGraph, llm }), undefined, "00000000-0000-4000-8000-000000000000");
    expect(stranger).toEqual({ ok: false, status: 404, message: EXPLAIN_WORDS.notFound });
    expect(missing).toEqual(stranger);
    expect(loadGraph).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("what it refuses, in Korean, instead of failing", () => {
  it("refuses with a sentence when no model is connected", async () => {
    expect(await ask(deps({ llm: () => null }))).toEqual({
      ok: false,
      status: 409,
      message: EXPLAIN_WORDS.noModel,
    });
  });

  it("refuses an upload that kept no files, before reading its graph", async () => {
    const loadGraph = vi.fn(async () => GRAPH);
    const result = await ask(
      deps({
        findOwnedProject: async () => ({ ...GITHUB, source: "upload", repoOwner: null, repoName: null }),
        storedFiles: async () => 0,
        loadGraph,
      }),
    );
    expect(result).toEqual({ ok: false, status: 409, message: EXPLAIN_WORDS.noStoredSource });
    expect(loadGraph).not.toHaveBeenCalled();
    expect(EXPLAIN_WORDS.noStoredSource).toContain("코드를 직접 열어 읽어 볼 수 없어요");
  });

  it("never asks a GitHub project how many files it stored — it stores none", async () => {
    const storedFiles = vi.fn(async () => 0);
    const result = await ask(deps({ storedFiles }));
    expect(result.ok).toBe(true);
    expect(storedFiles).not.toHaveBeenCalled();
  });

  it("says why a package, a feature, or a place with no file has nothing to read", async () => {
    const graph: QaGraph = {
      items: [
        ...ITEMS,
        { ...ITEMS[0], id: "p-react", kind: "package", name: "react", path: null },
        { ...ITEMS[0], id: "feat", kind: "feature", name: "결제", path: null },
        { ...ITEMS[0], id: "loose", kind: "symbol", name: "somewhere", path: null },
      ],
      connections: GRAPH.connections,
    };
    const d = deps({ loadGraph: async () => graph });
    expect(await ask(d, { itemId: "p-react" })).toMatchObject({ status: 409, message: EXPLAIN_WORDS.package });
    expect(await ask(d, { itemId: "feat" })).toMatchObject({ status: 409, message: EXPLAIN_WORDS.feature });
    expect(await ask(d, { itemId: "loose" })).toMatchObject({ status: 409, message: EXPLAIN_WORDS.noPath });
    expect(await ask(d, { itemId: "gone" })).toMatchObject({ status: 404, message: EXPLAIN_WORDS.noItem });
  });

  it("refuses a map that was never drawn, and a GitHub project it cannot reach", async () => {
    expect(await ask(deps({ loadGraph: async () => ({ items: [], connections: [] }) }))).toMatchObject({
      status: 409,
      message: EXPLAIN_WORDS.noGraph,
    });
    expect(await ask(deps({ sourceFor: async () => null }))).toMatchObject({
      status: 409,
      message: EXPLAIN_WORDS.noSource,
    });
  });

  it("writes every refusal in 해요체, with none of the words the product does not use", () => {
    for (const sentence of Object.values(EXPLAIN_WORDS)) {
      expect(sentence).toMatch(/요\.$/);
      expect(sentence).not.toMatch(/습니다|합니다|안전|노드|엣지|실행|추적|실시간/);
    }
  });
});

describe("the plan", () => {
  it("names the place by its code name, plain name, path and lines", async () => {
    const result = await ask(deps(), { itemId: "s-pay", question: "누르면 어디로 가요?" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.item.id).toBe("s-pay");
    expect(result.plan.question).toBe(
      '조각 PayButton (결제 버튼), src/components/PayButton.tsx 5–18줄 — 여기가 무슨 일을 하는지 코드를 읽고 쉬운 말로 설명해 주세요. 덧붙인 질문: "누르면 어디로 가요?"',
    );
  });

  it("is smaller than /ask's budget, because the question is smaller", () => {
    expect(EXPLAIN_BUDGET.maxSteps).toBeLessThan(20);
  });

  it("leaves the question alone when nothing was typed", () => {
    const question = explainQuestion(ITEMS[0], "   ");
    expect(question).not.toContain("덧붙인 질문");
  });
});

describe("the brief the loop is given", () => {
  const pay = ITEMS.find((item) => item.id === "s-pay")!;

  it("is /ask's prompt, unchanged, when there is no focus", () => {
    const without = buildSystemPrompt({ items: ITEMS, hasSource: true });
    const empty = buildSystemPrompt({ items: ITEMS, hasSource: true, focus: { items: [] } });
    expect(empty).toBe(without);
    expect(without).toContain("증상 하나를 붙잡고 원인을 찾아보는 조사자");
    expect(without).not.toContain("이번에 설명할 곳");
  });

  it("points at the place with the number the tools take", () => {
    const prompt = buildSystemPrompt({ items: ITEMS, hasSource: true, focus: { items: [pay] } });
    expect(prompt).toContain("풀어 설명하는 사람");
    expect(prompt).toContain("이번에 설명할 곳이에요.");
    // PayButton is the fourth item in the fixture, so the catalog calls it [4].
    expect(prompt).toContain("- [4] PayButton (조각) · src/components/PayButton.tsx:5-18");
    expect(prompt).toContain("먼저 이 곳을 read_source로 읽으세요");
  });

  it("keeps every rule the answer is checked against", () => {
    const prompt = buildSystemPrompt({ items: ITEMS, hasSource: true, focus: { items: [pay] } });
    for (const rule of ["certainty는 둘 중 하나예요", "읽지 않은 곳은 말하지 마세요", "'안전하다'는 말은 쓰지 마세요"]) {
      expect(prompt).toContain(rule);
    }
  });

  it("says it could not finish, not that it could not find a cause, when the budget runs out", async () => {
    // A model that only ever searches, never reports: the loop stops on steps.
    const { llm } = scriptedLlm(
      Array.from({ length: 2 }, (_, n) =>
        replyWith([call("find_items", { words: `결제${n}`, why: "찾아볼게요." }, `call-${n}`)]),
      ),
    );
    const investigation = await investigate({
      question: explainQuestion(pay, null),
      graph: GRAPH,
      llm,
      source: fixtureReader(),
      focus: { items: [pay] },
      budget: { maxSteps: 2 },
    });
    expect(investigation.stop).toBe("steps_spent");
    expect(investigation.summary).toBe(
      "2번까지 찾아봤는데 아직 다 풀어 드리지 못했어요. 어디를 봤는지는 아래에 남겨 뒀어요.",
    );
  });
});

describe("what the deep read says when it stops short", () => {
  const pay = ITEMS.find((item) => item.id === "s-pay")!;

  it("asks for 다시 읽어 보기, not for a question nobody asked, when the model cannot be reached", async () => {
    // An empty script throws on the first call: the provider refusing, as the
    // spending cap made it do in production.
    const { llm } = scriptedLlm([]);
    const explained = await investigate({
      question: explainQuestion(pay, null),
      graph: GRAPH,
      llm,
      source: fixtureReader(),
      focus: { items: [pay] },
    });
    expect(explained.stop).toBe("llm_failed");
    expect(explained.summary).toBe(EXPLAIN_STOP_WORDS.llm_failed);
    expect(explained.summary).not.toContain("물어봐");
    // /ask's own sentence is untouched.
    const asked = await investigate({ question: "왜 안 돼요?", graph: GRAPH, llm: scriptedLlm([]).llm, source: fixtureReader() });
    expect(asked.summary).toContain("다시 물어봐 주세요");
  });

  it("does not admit to missing a cause when no claim survived its check", async () => {
    const uncited = {
      why: "정리할게요.",
      answer: "결제 버튼이에요.",
      findings: [
        {
          claim: "결제 버튼이 주문을 넣어요.",
          certainty: "certain",
          citations: [{ path: "src/components/PayButton.tsx", startLine: 1, endLine: 40 }],
        },
      ],
    };
    const { llm } = scriptedLlm([
      replyWith([call("report", uncited, "r1")]),
      replyWith([call("report", uncited, "r2")]),
    ]);
    const explained = await investigate({
      question: explainQuestion(pay, null),
      graph: GRAPH,
      llm,
      source: fixtureReader(),
      focus: { items: [pay] },
    });
    expect(explained.findings).toEqual([]);
    expect(explained.summary).toBe(EXPLAIN_STOP_WORDS.ungrounded);
    expect(explained.summary).not.toContain("원인");
    expect(UNGROUNDED_SUMMARY).toContain("원인"); // /ask keeps its own
  });

  it("writes every one of those sentences in 해요체, with none of the words the product does not use", () => {
    for (const sentence of Object.values(EXPLAIN_STOP_WORDS)) {
      expect(sentence).toMatch(/요\.$/);
      expect(sentence).not.toMatch(/안전|노드|엣지|실행|추적|실시간/);
    }
  });
});

describe("who wrote the paragraph", () => {
  const finding = { claim: "x", certainty: "certain", citations: [] };

  it("is the model only on an answered read with a finding that survived", () => {
    expect(deepSummaryAuthor({ stop: "answered", findings: [finding], summary: "주문을 넣어요." })).toBe("model");
  });

  it("is the product on every other paragraph", () => {
    expect(deepSummaryAuthor({ stop: "answered", findings: [], summary: EXPLAIN_STOP_WORDS.ungrounded })).toBe("product");
    expect(deepSummaryAuthor({ stop: "answered", findings: [finding], summary: GROUNDED_FALLBACK_SUMMARY })).toBe("product");
    for (const stop of ["llm_failed", "steps_spent", "tokens_spent", "time_spent", "truncated", "no_answer", "stopped"] as const) {
      expect(deepSummaryAuthor({ stop, findings: [finding], summary: "무엇이든" })).toBe("product");
    }
    expect(deepSummaryAuthor({ stop: null, findings: [], summary: "" })).toBe("product");
  });
});
