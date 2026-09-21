import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AskSession } from "@/lib/ask/session";
import type { GraphConnection, GraphItem } from "@/lib/graph/view";
import { FLOW_FORBIDDEN_WORDS } from "@/lib/graph/flow";
import { EXPLAIN_STARTED } from "@/hooks/use-explain";
import { GROUNDED_FALLBACK_SUMMARY } from "@/qa/answer";

import { MODEL_TAG } from "../panel/connection-row";
import {
  DEEP_BY_MODEL,
  DEEP_BY_US,
  DEEP_FINDINGS_BY_MODEL,
  DEEP_OFFER,
  EXPLAIN_SOURCES,
  ExplainCard,
  FROM_THE_MAP,
} from "./explain-card";
import {
  certaintySplit,
  explainKnown,
  KNOWN_ROWS,
  membersSentence,
  usedBySentence,
  usesSentence,
} from "./known";

/**
 * 설명하기's free half: what the graph already knows, split by who wrote it.
 *
 * The property that matters most is the split itself. A sentence a model wrote
 * and a sentence the parser counted must never arrive under the same heading,
 * so most of what is pinned here is *where* each sentence lands.
 */

function item(partial: Partial<GraphItem> & Pick<GraphItem, "id" | "kind" | "name">): GraphItem {
  return {
    shape: null,
    label: null,
    summary: null,
    path: null,
    startLine: null,
    endLine: null,
    fromUser: false,
    usedBy: 0,
    uses: 0,
    ...partial,
  };
}

const ITEMS: GraphItem[] = [
  item({ id: "f-pay", kind: "file", name: "src/components/PayButton.tsx", path: "src/components/PayButton.tsx" }),
  item({
    id: "s-pay",
    kind: "symbol",
    shape: "component",
    name: "PayButton",
    label: "결제 버튼",
    summary: "누르면 주문을 넣어요.",
    path: "src/components/PayButton.tsx",
    startLine: 5,
    endLine: 18,
  }),
  item({ id: "s-checkout", kind: "symbol", shape: "component", name: "CheckoutPage", label: "결제 화면" }),
  item({ id: "s-format", kind: "symbol", shape: "function", name: "formatPrice", path: "src/lib/format.ts" }),
  item({ id: "feat-pay", kind: "feature", name: "feature:9f8e7d6c5b4a", label: "결제" }),
  item({ id: "s-lonely", kind: "symbol", shape: "function", name: "unusedThing", path: "src/lib/x.ts" }),
];

const CONNECTIONS: GraphConnection[] = [
  { id: "c1", from: "f-pay", to: "s-pay", relation: "contains", certainty: "certain" },
  { id: "c2", from: "s-checkout", to: "s-pay", relation: "renders", certainty: "certain" },
  {
    id: "c3",
    from: "s-pay",
    to: "s-format",
    relation: "calls",
    certainty: "inferred",
    purpose: "가격을 사람이 읽는 모양으로 바꿔요",
  },
  { id: "c4", from: "s-pay", to: "feat-pay", relation: "belongs_to", certainty: "inferred" },
];

const GRAPH = { items: ITEMS, connections: CONNECTIONS };

describe("what the graph already knows", () => {
  it("keeps the model's sentences and the parser's apart", () => {
    const known = explainKnown(GRAPH, "s-pay")!;
    // Pass 2's summary is under `written`, never as the measured line.
    expect(known.written.summary).toBe("누르면 주문을 넣어요.");
    expect(known.written.label).toBe("결제 버튼");
    expect(known.measured.line).not.toContain("누르면 주문을 넣어요");
    // The measured line is describe.ts's arithmetic for this piece.
    expect(known.measured.line).toBe("화면 조각이에요, 1곳에서 써요");
  });

  it("finds the file it is written in, the feature it was grouped under, and both sides", () => {
    const known = explainKnown(GRAPH, "s-pay")!;
    expect(known.measured.home?.id).toBe("f-pay");
    expect(known.written.feature?.id).toBe("feat-pay");
    expect(known.measured.usedBy.rows.map((row) => row.item.id)).toEqual(["s-checkout"]);
    expect(known.measured.uses.rows.map((row) => row.item.id)).toEqual(["s-format"]);
    // Where it lives and what it belongs to are not uses.
    expect(known.measured.uses.total).toBe(1);
    expect(known.measured.usedBy.total).toBe(1);
  });

  it("carries each connection's own certainty and its purpose sentence", () => {
    const known = explainKnown(GRAPH, "s-pay")!;
    const format = known.measured.uses.rows[0];
    expect(format.certainty).toBe("inferred");
    expect(format.verb).toBe("사용해요");
    expect(format.purpose).toBe("가격을 사람이 읽는 모양으로 바꿔요");
    expect(known.written.purposes).toBe(1);
    expect(known.measured.usedBy.rows[0].verb).toBe("여기에 그려져요");
  });

  it("counts a file's insides from the whole graph, not from one item", () => {
    // describeItem would hand describeAll only the file, and the file would
    // then read as one we never opened.
    const known = explainKnown(GRAPH, "f-pay")!;
    expect(known.measured.inside).toBe(1);
    expect(known.measured.line).toContain("화면 조각 1개가 들어 있어요");
  });

  it("caps each side and says how many it has before the cap", () => {
    const many: GraphItem[] = Array.from({ length: KNOWN_ROWS + 3 }, (_, n) =>
      item({ id: `user-${n}`, kind: "symbol", shape: "component", name: `User${n}` }),
    );
    const graph = {
      items: [...ITEMS, ...many],
      connections: [
        ...CONNECTIONS,
        ...many.map((user, n) => ({
          id: `u${n}`,
          from: user.id,
          to: "s-pay",
          relation: "renders" as const,
          certainty: "certain" as const,
        })),
      ],
    };
    const known = explainKnown(graph, "s-pay")!;
    expect(known.measured.usedBy.rows).toHaveLength(KNOWN_ROWS);
    expect(known.measured.usedBy.total).toBe(KNOWN_ROWS + 4);
    expect(usedBySentence(known.measured.usedBy)).toBe(`${KNOWN_ROWS + 4}곳에서 쓰여요.`);
  });

  it("returns null for something the map does not hold", () => {
    expect(explainKnown(GRAPH, "gone")).toBeNull();
  });
});

describe("the sentences", () => {
  it("never turns 'we found nothing' into a verdict on their code", () => {
    const known = explainKnown(GRAPH, "s-lonely")!;
    expect(usedBySentence(known.measured.usedBy)).toBe("쓰는 곳을 아직 못 찾았어요.");
    expect(usesSentence(known.measured.uses)).toBe("이 곳이 쓰는 것은 찾지 못했어요.");
    for (const sentence of [usedBySentence(known.measured.usedBy), known.measured.line]) {
      expect(sentence).not.toMatch(/안 써요|안 쓰여요|아무 데서도|0곳/);
    }
  });

  it("splits certain from inferred only where there is a split", () => {
    const known = explainKnown(GRAPH, "s-pay")!;
    expect(certaintySplit(known.measured.uses)).toBe("모두 짐작한 연결이에요.");
    expect(certaintySplit(known.measured.usedBy)).toBe("모두 확실한 연결이에요.");
    expect(certaintySplit({ total: 3, certain: 2, inferred: 1, rows: [] })).toBe(
      "확실한 연결 2개, 짐작한 연결 1개예요.",
    );
  });
});

function render(props: Partial<Parameters<typeof ExplainCard>[0]> = {}, id = "s-pay"): string {
  const known = explainKnown(GRAPH, id)!;
  return renderToStaticMarkup(
    createElement(ExplainCard, {
      known,
      deep: null,
      onDeep: () => {},
      deepRefusal: null,
      itemsById: new Map(ITEMS.map((one) => [one.id, one])),
      onSelect: () => {},
      ...props,
    }),
  );
}

function words(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the card", () => {
  it("marks every model sentence, and says what the mark means", () => {
    const html = render();
    const text = words(html);
    // The heading of the model's half, the purpose row: at least two marks.
    expect((html.match(new RegExp(MODEL_TAG, "g")) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text).toContain("누르면 주문을 넣어요.");
    expect(text).toContain(FROM_THE_MAP);
    expect(text).toContain(EXPLAIN_SOURCES);
  });

  it("puts the model's half before the parser's, and each sentence in its own half", () => {
    const text = words(render());
    const modelHalf = text.indexOf("모델이 코드를 보고 풀어 쓴 말");
    const countedHalf = text.indexOf(FROM_THE_MAP);
    expect(modelHalf).toBeGreaterThan(-1);
    expect(countedHalf).toBeGreaterThan(modelHalf);
    expect(text.indexOf("누르면 주문을 넣어요.")).toBeLessThan(countedHalf);
    expect(text.indexOf("화면 조각이에요, 1곳에서 써요")).toBeGreaterThan(countedHalf);
  });

  it("offers the deep read as a button, not as the default", () => {
    const text = words(render());
    expect(text).toContain("코드를 직접 읽고 더 알아보기");
    expect(text).toContain(DEEP_OFFER);
  });

  it("says why there is no deep read instead of showing a dead button", () => {
    const html = render({ onDeep: undefined, deepRefusal: "아직 모델이 연결되지 않아서요." });
    expect(words(html)).toContain("아직 모델이 연결되지 않아서요.");
    expect(html).not.toContain("코드를 직접 읽고 더 알아보기");
  });

  it("shows a deep read's findings with their certainty and where they were read", () => {
    const step = (n: number) => ({
      step: n,
      tool: "read_source",
      hypothesis: "읽어 볼게요.",
      note: "읽었어요.",
      items: [],
      conclusion: null,
    });
    const deep: AskSession = {
      status: "answered",
      question: "코드를 직접 열어서 읽어 볼게요.",
      steps: [step(1), step(2), step(3)],
      refused: [],
      trail: { points: [], hops: [], unplaced: [] },
      answer: {
        summary: "주문을 넣는 버튼이에요.",
        findings: [
          {
            claim: "누르면 주문을 보내요.",
            certainty: "certain",
            citations: [{ path: "src/components/PayButton.tsx", startLine: 5, endLine: 18 }],
          },
        ],
        ruledOut: [],
        stop: "answered",
        spent: { steps: 3, inputTokens: 9_000, outputTokens: 400, millis: 7_600 },
      },
      error: null,
    };
    const text = words(render({ deep }));
    expect(text).toContain(DEEP_BY_MODEL);
    expect(text).toContain("누르면 주문을 보내요.");
    expect(text).toContain("확실해요");
    expect(text).toContain("src/components/PayButton.tsx 5–18줄");
    expect(text).toContain("8초 동안 3번 살펴봤어요.");
  });

  it("shows a refusal from the server as the sentence it is", () => {
    const deep: AskSession = {
      status: "failed",
      question: "코드를 직접 열어서 읽어 볼게요.",
      steps: [],
      refused: [],
      trail: null,
      answer: null,
      error: "올려 주신 폴더의 파일을 보관하지 않은 프로젝트라서, 코드를 직접 열어 읽어 볼 수 없어요.",
    };
    expect(words(render({ deep }))).toContain("코드를 직접 열어 읽어 볼 수 없어요.");
  });

  it("offers no retry, and no 'reading it now', under a refusal that will not change", async () => {
    const { EXPLAIN_WORDS } = await import("@/qa/explain");
    const deep: AskSession = {
      status: "failed",
      question: "코드를 직접 열어서 읽어 볼게요.",
      steps: [],
      refused: [],
      trail: null,
      answer: null,
      error: EXPLAIN_WORDS.noStoredSource,
    };
    const text = words(render({ deep }));
    expect(text).toContain(EXPLAIN_WORDS.noStoredSource);
    expect(text).not.toContain("다시 읽어 보기");
    expect(text).not.toContain("코드를 직접 열어서 읽어 볼게요.");
    // A dropped connection is not permanent, and keeps its retry.
    const dropped = words(render({ deep: { ...deep, error: "읽어 오는 도중에 연결이 끊겼어요. 다시 눌러 주세요." } }));
    expect(dropped).toContain("다시 읽어 보기");
  });

  it("never says anything the product does not say", () => {
    const text = words(render());
    for (const word of FLOW_FORBIDDEN_WORDS) expect(text).not.toContain(word);
    expect(text).not.toMatch(/안전|아무 데서도/);
  });
});

describe("who wrote the deep read's paragraph", () => {
  const stopped = (stop: "llm_failed" | "steps_spent" | "answered", summary: string, findings = 0): AskSession => ({
    status: "answered",
    question: "코드를 직접 열어서 읽어 볼게요.",
    steps: [],
    refused: [],
    trail: { points: [], hops: [], unplaced: [] },
    answer: {
      summary,
      findings: Array.from({ length: findings }, () => ({
        claim: "누르면 주문을 보내요.",
        certainty: "certain" as const,
        citations: [{ path: "src/components/PayButton.tsx", startLine: 5, endLine: 18 }],
      })),
      ruledOut: [],
      stop,
      spent: { steps: 2, inputTokens: 0, outputTokens: 0, millis: 800 },
    },
    error: null,
  });

  it("is ours, and says so, when the read stopped short", () => {
    // Seen live when the provider refused every call: 모델이 코드를 직접 읽고
    // 쓴 말 over our own "연결이 끊겼어요", and "1초 동안 2번 살펴봤어요" over
    // a read that had opened nothing.
    const text = words(render({ deep: stopped("llm_failed", "읽는 도중에 모델과 연결이 끊겼어요.") }));
    expect(text).toContain(DEEP_BY_US);
    expect(text).not.toContain(DEEP_BY_MODEL);
    expect(text).not.toContain("살펴봤어요");
  });

  it("is ours when every claim failed its check, and the model's only when one survived", () => {
    expect(words(render({ deep: stopped("answered", "확인하지 못했어요.", 0) }))).toContain(DEEP_BY_US);
    expect(words(render({ deep: stopped("answered", "주문을 넣는 버튼이에요.", 1) }))).toContain(DEEP_BY_MODEL);
  });

  it("still marks the findings as the model's when the paragraph above them is ours", () => {
    // The verifier's finding: a paragraph replaced for its vocabulary put the
    // model's surviving findings under 저희가 남기는 말 with no mark.
    const replaced = words(render({ deep: stopped("answered", GROUNDED_FALLBACK_SUMMARY, 1) }));
    expect(replaced).toContain(DEEP_BY_US);
    expect(replaced).toContain(`${MODEL_TAG} ${DEEP_FINDINGS_BY_MODEL}`);
    expect(replaced.indexOf(DEEP_FINDINGS_BY_MODEL)).toBeLessThan(replaced.indexOf("누르면 주문을 보내요."));
    // Under the model's own paragraph one mark covers both, and it is not said twice.
    const own = words(render({ deep: stopped("answered", "주문을 넣는 버튼이에요.", 1) }));
    expect(own).not.toContain(DEEP_FINDINGS_BY_MODEL);
  });

  it("promises to read only while it is reading, and keeps a question the person typed", () => {
    // Seen live under the spending cap: "코드를 직접 열어서 읽어 볼게요." above
    // "읽는 도중에 모델과 연결이 끊겼어요."
    const ended = words(render({ deep: stopped("llm_failed", "읽는 도중에 모델과 연결이 끊겼어요.") }));
    expect(ended).not.toContain(EXPLAIN_STARTED);
    const reading = words(render({ deep: { ...stopped("answered", "x"), status: "asking", answer: null } }));
    expect(reading).toContain(EXPLAIN_STARTED);
    const typed = words(
      render({ deep: { ...stopped("llm_failed", "읽는 도중에 모델과 연결이 끊겼어요."), question: "버튼은 어디서 눌려요?" } }),
    );
    expect(typed).toContain("버튼은 어디서 눌려요?");
  });
});

describe("a feature", () => {
  it("is explained by what was grouped under it, never as a thing nobody uses", () => {
    // 9 of 9 features on this repository's map read 쓰는 곳을 아직 못 찾았어요,
    // under a panel header that said 45곳에서 쓰여요.
    const known = explainKnown(GRAPH, "feat-pay")!;
    expect(known.written.members?.total).toBe(1);
    expect(known.written.members?.rows[0].item.id).toBe("s-pay");
    expect(known.written.members?.rows[0].certainty).toBe("inferred");
    expect(membersSentence(known.written.members!)).toBe("1개를 이 기능으로 묶어 뒀어요.");
    expect(explainKnown(GRAPH, "s-pay")!.written.members).toBeNull();

    const text = words(render({}, "feat-pay"));
    expect(text).toContain("이 기능으로 묶은 것");
    expect(text).toContain("1개를 이 기능으로 묶어 뒀어요.");
    expect(text).not.toContain("쓰는 곳을 아직 못 찾았어요");
  });

  it("never shows its id, and has nothing under the map's heading — all of it is a model's grouping", () => {
    const html = render({}, "feat-pay");
    const text = words(html);
    expect(text).not.toContain("feature:9f8e7d6c5b4a");
    expect(text).not.toContain("코드 이름");
    expect(text).not.toContain(FROM_THE_MAP);
    expect(text).not.toContain("기능 하나로 묶어 둔 것이에요");
    expect(html).toContain(MODEL_TAG);
  });
});

describe("the map's half", () => {
  it("names where a piece is written by its path, never by a model's name for the file", () => {
    const withLabel = {
      items: ITEMS.map((one) => (one.id === "f-pay" ? { ...one, label: "결제 버튼 파일" } : one)),
      connections: CONNECTIONS,
    };
    const known = explainKnown(withLabel, "s-pay")!;
    const text = words(
      renderToStaticMarkup(
        createElement(ExplainCard, {
          known,
          deep: null,
          onDeep: () => {},
          deepRefusal: null,
          itemsById: new Map(withLabel.items.map((one) => [one.id, one])),
          onSelect: () => {},
        }),
      ),
    );
    const mapHalf = text.slice(text.indexOf(FROM_THE_MAP));
    expect(mapHalf).not.toContain("결제 버튼 파일");
    expect(mapHalf).toContain("src/components/PayButton.tsx · 5–18줄");
  });
});
