import { describe, expect, it } from "vitest";

import type { GraphConnection, GraphItem } from "@/lib/graph/view";
import { FLOW_FORBIDDEN_WORDS } from "@/lib/graph/flow";
import { locksShown } from "@/components/workspace/prompt/scope-open";

import {
  buildPrompt,
  canPromptAbout,
  placesUsing,
  PROMPT_SECTIONS,
  requestWords,
  REUSE_FLOOD,
  reuseCandidates,
  scopeQuestion,
  STOP_RULE,
  type PromptInput,
} from "./build";

/**
 * The prompt builder, against a shop small enough to read every line of.
 *
 * Step 4's own test brief: "given a fixture selection and lock state, the
 * output contains the right paths, the right locked items, and the
 * shared-component warning when applicable." Each block below is one clause of
 * that sentence, plus the two things this product adds to it — the snapshot
 * (D23) and the vocabulary.
 *
 * The shop: two pages render one `PayButton`, which calls `formatPrice` and
 * renders the project's shared `Button`. `formatCount` sits in the same file as
 * `formatPrice` and nothing reaches it — the helper an agent would never find
 * unless someone told it where to look.
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
  item({ id: "f-checkout", kind: "file", name: "src/app/checkout/page.tsx", path: "src/app/checkout/page.tsx" }),
  item({
    id: "s-checkout",
    kind: "symbol",
    shape: "component",
    name: "CheckoutPage",
    label: "결제 화면",
    path: "src/app/checkout/page.tsx",
    startLine: 1,
    endLine: 30,
  }),
  item({ id: "f-cart", kind: "file", name: "src/app/cart/page.tsx", path: "src/app/cart/page.tsx" }),
  item({
    id: "s-cart",
    kind: "symbol",
    shape: "component",
    name: "CartPage",
    label: "장바구니 화면",
    path: "src/app/cart/page.tsx",
    startLine: 1,
    endLine: 40,
  }),
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
    usedBy: 2,
    uses: 2,
  }),
  item({ id: "f-format", kind: "file", name: "src/lib/format.ts", path: "src/lib/format.ts" }),
  item({
    id: "s-format",
    kind: "symbol",
    shape: "function",
    name: "formatPrice",
    label: "가격 표시",
    summary: "숫자를 원 단위 가격 글자로 바꿔요.",
    path: "src/lib/format.ts",
    startLine: 3,
    endLine: 8,
    usedBy: 1,
  }),
  item({
    id: "s-count",
    kind: "symbol",
    shape: "function",
    name: "formatCount",
    label: "개수 표시",
    path: "src/lib/format.ts",
    startLine: 10,
    endLine: 12,
    // Used elsewhere in the project, off this fixture's map: the kind of
    // shared helper 다시 쓸 것 exists to point at.
    usedBy: 3,
  }),
  item({ id: "f-button", kind: "file", name: "src/components/ui/Button.tsx", path: "src/components/ui/Button.tsx" }),
  item({
    id: "s-button",
    kind: "symbol",
    shape: "component",
    name: "Button",
    label: "공통 버튼",
    path: "src/components/ui/Button.tsx",
    startLine: 1,
    endLine: 25,
    usedBy: 5,
  }),
  item({ id: "p-react", kind: "package", name: "react" }),
];

const CONNECTIONS: GraphConnection[] = [
  { id: "c1", from: "f-checkout", to: "s-checkout", relation: "contains", certainty: "certain" },
  { id: "c2", from: "f-cart", to: "s-cart", relation: "contains", certainty: "certain" },
  { id: "c3", from: "f-pay", to: "s-pay", relation: "contains", certainty: "certain" },
  { id: "c4", from: "f-format", to: "s-format", relation: "contains", certainty: "certain" },
  { id: "c5", from: "f-format", to: "s-count", relation: "contains", certainty: "certain" },
  { id: "c6", from: "f-button", to: "s-button", relation: "contains", certainty: "certain" },
  { id: "c7", from: "s-checkout", to: "s-pay", relation: "renders", certainty: "certain" },
  { id: "c8", from: "s-cart", to: "s-pay", relation: "renders", certainty: "certain" },
  {
    id: "c9",
    from: "s-pay",
    to: "s-format",
    relation: "calls",
    certainty: "inferred",
    purpose: "보여 줄 가격을 사람이 읽는 모양으로 바꿔요",
  },
  { id: "c10", from: "s-pay", to: "s-button", relation: "renders", certainty: "certain" },
  { id: "c11", from: "f-pay", to: "p-react", relation: "uses_package", certainty: "certain" },
];

const GRAPH = { items: ITEMS, connections: CONNECTIONS };

function build(overrides: Partial<PromptInput> = {}) {
  return buildPrompt({
    graph: GRAPH,
    selectionIds: ["s-pay"],
    hops: 1,
    locks: {},
    request: "결제 버튼 색을 파란색으로 바꿔줘",
    goal: null,
    scope: null,
    ...overrides,
  });
}

/** The lines under one heading, up to the next. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("the sections", () => {
  it("come in §6.4's order, with the shared warning in its place", () => {
    const text = build({ scope: { kind: "everywhere" } }).promptText;
    const positions = PROMPT_SECTIONS.map((heading) => text.indexOf(heading));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("leaves the shared warning out when the selection is used in one place", () => {
    const text = build({ selectionIds: ["s-format"] }).promptText;
    expect(text).not.toContain(PROMPT_SECTIONS[6]);
    // Every other section is still there.
    for (const heading of PROMPT_SECTIONS.filter((_, index) => index !== 6)) {
      expect(text).toContain(heading);
    }
  });

  it("ends on the rule, word for word", () => {
    const text = build().promptText;
    expect(section(text, PROMPT_SECTIONS[7])).toContain(STOP_RULE);
    expect(STOP_RULE).toContain("멈추고 왜 필요한지 먼저 설명해 주세요");
  });
});

describe("the goal", () => {
  it("is the person's own words when nothing restated them", () => {
    const goal = section(build().promptText, PROMPT_SECTIONS[0]);
    expect(goal).toContain('"결제 버튼 색을 파란색으로 바꿔줘"');
    expect(goal).toContain("사용자가 직접 쓴 말 그대로예요");
  });

  it("keeps the person's words beside a model's restatement, and says which wins", () => {
    const goal = section(
      build({ goal: { text: "결제 버튼(PayButton)의 색을 파란색으로 바꿔 주세요.", fromModel: true } })
        .promptText,
      PROMPT_SECTIONS[0],
    );
    expect(goal).toContain("결제 버튼(PayButton)의 색을 파란색으로 바꿔 주세요.");
    expect(goal).toContain('사용자가 직접 쓴 말: "결제 버튼 색을 파란색으로 바꿔줘"');
    expect(goal).toContain("사용자가 쓴 말을 따라 주세요");
  });
});

describe("where", () => {
  it("names the selection by its code name, path and line range", () => {
    const where = section(build().promptText, PROMPT_SECTIONS[1]);
    expect(where).toContain("`PayButton`");
    expect(where).toContain("`src/components/PayButton.tsx` 5–18줄");
    expect(where).toContain("조각(component)");
  });

  it("marks what a model wrote about it", () => {
    const where = section(build().promptText, PROMPT_SECTIONS[1]);
    expect(where).toContain("쉬운 이름(짐작): 결제 버튼");
    expect(where).toContain("하는 일(짐작): 누르면 주문을 넣어요.");
  });

  it("says a whole file is a whole file rather than printing no lines", () => {
    const where = section(build({ selectionIds: ["f-format"] }).promptText, PROMPT_SECTIONS[1]);
    expect(where).toContain("`src/lib/format.ts` (파일 전체)");
  });
});

describe("the connected context", () => {
  it("lists every neighbour with its certainty, in the panel's own headings", () => {
    const context = section(build().promptText, PROMPT_SECTIONS[2]);
    expect(context).toContain("여기가 있는 곳:");
    expect(context).toContain("여기서 쓰는 것:");
    expect(context).toContain("여기를 쓰는 곳:");
    // Read along the arrow, so which end does the using is never a question.
    expect(context).toContain("`PayButton` → `formatPrice` · 사용해요 · 짐작이에요");
    expect(context).toContain("`CheckoutPage` → `PayButton` · 그려요 · 확실해요");
    expect(context).toContain("`CartPage` → `PayButton` · 그려요 · 확실해요");
  });

  it("carries Pass 3's purpose sentence, marked as a guess", () => {
    const context = section(build().promptText, PROMPT_SECTIONS[2]);
    expect(context).toContain("무엇을 위한 연결인지(짐작): 보여 줄 가격을 사람이 읽는 모양으로 바꿔요");
  });

  it("goes as deep as the panel was set, and says so", () => {
    const one = build().promptText;
    const two = build({ hops: 2 }).promptText;
    expect(one).toContain("## 3. 이어진 것 (바로 옆까지)");
    expect(two).toContain("## 3. 이어진 것 (한 다리 건너까지)");
    // Two steps out is the file the checkout page is written in, reached by
    // way of the page — and the row says which way it went.
    const far = "`src/app/checkout/page.tsx` → `CheckoutPage` → `PayButton`";
    expect(section(two, PROMPT_SECTIONS[2])).toContain(far);
    expect(section(one, PROMPT_SECTIONS[2])).not.toContain(far);
  });

  it("counts what the cap left out instead of stopping silently", () => {
    const text = build({ limit: 1 }).promptText;
    expect(section(text, PROMPT_SECTIONS[2])).toMatch(/연결이 많아서 \d+개는 목록에서 뺐어요/);
  });
});

describe("allowed and locked", () => {
  it("allows only the selection when nothing was opened", () => {
    const built = build();
    const allowed = section(built.promptText, PROMPT_SECTIONS[3]);
    expect(allowed).toContain("`PayButton` · `src/components/PayButton.tsx` 5–18줄 — 바꿀 곳");
    expect(allowed).not.toContain("formatPrice");
    expect(built.lockState.editable).toEqual(["s-pay"]);
  });

  it("puts every neighbour that stayed locked under 건드리지 말 것", () => {
    const built = build({ locks: { "s-format": "editable" } });
    const allowed = section(built.promptText, PROMPT_SECTIONS[3]);
    const locked = section(built.promptText, PROMPT_SECTIONS[4]);

    expect(allowed).toContain("`formatPrice` · `src/lib/format.ts` 3–8줄 — 사용자가 열어 둠");
    expect(locked).toContain("`CheckoutPage`");
    expect(locked).toContain("`CartPage`");
    expect(locked).toContain("`Button`");
    expect(locked).not.toContain("`formatPrice`");
  });

  it("words the file the selection lives in as the rest of that file", () => {
    const locked = section(build().promptText, PROMPT_SECTIONS[4]);
    // Not "do not touch PayButton.tsx" — that would forbid the very lines the
    // agent was told to change.
    expect(locked).toContain("`src/components/PayButton.tsx`에서 `PayButton`(5–18줄) 밖의 부분");
  });

  it("says nothing was locked when nothing was", () => {
    const built = build({
      locks: {
        "f-pay": "editable",
        "s-format": "editable",
        "s-button": "editable",
        "s-checkout": "editable",
        "s-cart": "editable",
      },
    });
    expect(section(built.promptText, PROMPT_SECTIONS[4])).toContain("따로 잠가 둔 것은 없어요.");
    expect(built.lockState.locked).toEqual([]);
  });
});

describe("the lock snapshot (D23)", () => {
  it("records every listed item in exactly one list, by id", () => {
    const built = build({ locks: { "s-format": "editable" } });
    const { editable, locked } = built.lockState;
    expect(editable).toEqual(["s-format", "s-pay"]);
    expect(locked).toEqual(["f-pay", "s-button", "s-cart", "s-checkout"].sort());
    expect(editable.filter((id) => locked.includes(id))).toEqual([]);
  });

  it("is a snapshot: changing the locks afterwards does not change it", () => {
    const locks: Record<string, "editable" | "locked"> = { "s-format": "editable" };
    const built = build({ locks });
    locks["s-format"] = "locked";
    locks["s-button"] = "editable";
    expect(built.lockState.editable).toEqual(["s-format", "s-pay"]);
    expect(built.promptText).toContain("`formatPrice` · `src/lib/format.ts` 3–8줄 — 사용자가 열어 둠");
  });

  it("uses the generated_prompts column names, so storing it is one insert", () => {
    const built = build({ scope: { kind: "everywhere" } });
    expect(Object.keys(built)).toEqual(
      expect.arrayContaining([
        "selectionNodeIds",
        "lockState",
        "sharedScope",
        "userRequest",
        "promptText",
        "confirmationText",
      ]),
    );
    expect(built.selectionNodeIds).toEqual(["s-pay"]);
    expect(built.sharedScope).toBe("everywhere");
    expect(built.userRequest).toBe("결제 버튼 색을 파란색으로 바꿔줘");
  });
});

describe("the shared-component question", () => {
  it("is asked when two places use the selection, and lists them by the name a person reads", () => {
    const question = scopeQuestion(GRAPH, ["s-pay"]);
    expect(question?.selectionId).toBe("s-pay");
    // 결제 화면 before 장바구니 화면: 가나다 order, by the name a person reads.
    expect(question?.places.map((place) => place.id)).toEqual(["s-checkout", "s-cart"]);
  });

  it("is not asked about something used in one place, a package, or nothing at all", () => {
    expect(scopeQuestion(GRAPH, ["s-format"])).toBeNull();
    expect(scopeQuestion(GRAPH, ["p-react"])).toBeNull();
    expect(scopeQuestion(GRAPH, ["s-count"])).toBeNull();
  });

  it("counts places rather than connections, and never counts where a thing lives", () => {
    const doubled = {
      items: ITEMS,
      connections: [
        ...CONNECTIONS,
        { id: "c12", from: "s-cart", to: "s-pay", relation: "calls" as const, certainty: "certain" as const },
      ],
    };
    expect(placesUsing(doubled, "s-pay").map((place) => place.id)).toEqual(["s-checkout", "s-cart"]);
    // f-pay contains s-pay; that is its home, not a place that uses it.
    expect(placesUsing(GRAPH, "s-pay").map((place) => place.id)).not.toContain("f-pay");
  });

  it("writes the choice into the prompt: only here", () => {
    const built = build({ scope: { kind: "only_here", placeId: "s-checkout" } });
    const shared = section(built.promptText, PROMPT_SECTIONS[6]);
    expect(shared).toContain("쓰이는 곳이 2곳이에요");
    expect(shared).toContain("사용자가 고른 범위: `CheckoutPage`에서만 바꿔요.");
    expect(shared).toContain("다른 곳에서는 지금과 똑같이 보이고 똑같이 동작해야 해요.");
    // "Only on the checkout screen" needs the checkout screen opened.
    expect(built.lockState.editable).toContain("s-checkout");
    expect(built.lockState.locked).not.toContain("s-checkout");
    expect(section(built.promptText, PROMPT_SECTIONS[3])).toContain(
      "`CheckoutPage` · `src/app/checkout/page.tsx` 1–30줄 — 이 곳에서만 바꾸기로 해서 함께 열었어요",
    );
    expect(built.sharedScope).toBe("only_here");
  });

  it("writes the choice into the prompt: everywhere", () => {
    const shared = section(build({ scope: { kind: "everywhere" } }).promptText, PROMPT_SECTIONS[6]);
    expect(shared).toContain("사용자가 고른 범위: 쓰이는 모든 곳에서 함께 바뀌어요.");
  });

  it("tells the agent to ask, if a prompt was ever built without an answer", () => {
    const shared = section(build({ scope: null }).promptText, PROMPT_SECTIONS[6]);
    expect(shared).toContain("사용자에게 먼저 물어봐 주세요");
  });
});

describe("reuse these", () => {
  it("offers what the selection already uses before anything else", () => {
    const reuse = reuseCandidates(GRAPH, ["s-pay"], "결제 버튼 색을 바꿔줘");
    const already = reuse.filter((entry) => entry.why === "already").map((entry) => entry.item.id);
    expect(already).toEqual(["s-button"]);
  });

  it("never tells the agent to reuse what the selection reaches only by a guess", () => {
    // PayButton → formatPrice is `inferred` in the fixture: a name matched to a
    // name. On the real map the same kind of guess told `materializeFixture` to
    // reuse a private `byteLength` it never calls. Section 3 still lists it,
    // marked as a guess, so nothing is hidden.
    const built = build();
    const reuse = section(built.promptText, PROMPT_SECTIONS[5]);
    expect(reuse).not.toContain("`formatPrice`");
    expect(section(built.promptText, PROMPT_SECTIONS[2])).toContain(
      "`PayButton` → `formatPrice` · 사용해요 · 짐작이에요",
    );
    // The same connection, read by the parser, is an instruction again.
    const certain = {
      items: ITEMS,
      connections: CONNECTIONS.map((c) => (c.id === "c9" ? { ...c, certainty: "certain" as const } : c)),
    };
    const already = reuseCandidates(certain, ["s-pay"], "색을 바꿔줘")
      .filter((entry) => entry.why === "already")
      .map((entry) => entry.item.id);
    expect(already).toContain("s-format");
  });

  it("finds pieces elsewhere whose names the request's words land on", () => {
    const reuse = reuseCandidates(GRAPH, ["s-checkout"], "개수 표시를 추가해줘");
    const matched = reuse.find((entry) => entry.item.id === "s-count");
    expect(matched?.why).toBe("matched");
    expect(matched?.words).toContain("개수");
  });

  it("drops the words that only say 'change something'", () => {
    expect(requestWords("버튼 색을 파란색으로 바꿔줘")).not.toContain("바꿔줘");
    expect(requestWords("please change the button")).toEqual(["button"]);
  });

  it("ignores a word that lands on so many pieces it points at none of them", () => {
    // D153's measurement: 글자 landed on a time formatter, a text probe and a
    // byte formatter on the real map — real helpers, none of them relevant.
    const flood = Array.from({ length: REUSE_FLOOD + 1 }, (_, n) =>
      item({
        id: `s-text-${n}`,
        kind: "symbol",
        shape: "function",
        name: `textThing${n}`,
        label: `글자 도우미 ${n}`,
        path: `src/lib/text${n}.ts`,
        startLine: 1,
        endLine: 3,
        usedBy: 4,
      }),
    );
    const graph = { items: [...ITEMS, ...flood], connections: CONNECTIONS };
    const reuse = reuseCandidates(graph, ["s-checkout"], "글자 개수 표시를 추가해줘");
    const matched = reuse.filter((entry) => entry.why === "matched").map((entry) => entry.item.id);
    expect(matched.some((id) => id.startsWith("s-text-"))).toBe(false);
    // The word that still points somewhere keeps pointing there.
    expect(matched).toContain("s-count");
  });

  it("offers a matched piece only when more than one place already uses it", () => {
    // D153: the real map's 글자 matches were each used in one place, and none
    // of them was a thing to reuse.
    const lonely = item({
      id: "s-lonely",
      kind: "symbol",
      shape: "function",
      name: "countOnce",
      label: "개수 세기",
      path: "src/lib/once.ts",
      startLine: 1,
      endLine: 2,
      usedBy: 1,
    });
    const graph = { items: [...ITEMS, lonely], connections: CONNECTIONS };
    const matched = reuseCandidates(graph, ["s-checkout"], "개수 표시를 추가해줘")
      .filter((entry) => entry.why === "matched")
      .map((entry) => entry.item.id);
    expect(matched).toContain("s-count");
    expect(matched).not.toContain("s-lonely");
  });

  it("tells the agent a match is a lead and a use is an instruction", () => {
    const text = build({ selectionIds: ["s-pay"], request: "개수 표시 추가해줘" }).promptText;
    const reuse = section(text, PROMPT_SECTIONS[5]);
    expect(reuse).toContain("바꿀 곳이 이미 쓰고 있는 것이에요.");
    expect(reuse).toContain("요청과 관련이 있을 때만");
    expect(reuse).toContain('겹치는 낱말: "개수"');
  });

  it("names a file once, not as its name and then its path", () => {
    const text = build({ selectionIds: ["f-format"] }).promptText;
    expect(text).not.toContain("`src/lib/format.ts` · `src/lib/format.ts`");
  });

  it("says so, and says what to do, when nothing matched", () => {
    const text = build({ selectionIds: ["s-count"], request: "ㅋㅋ" }).promptText;
    expect(section(text, PROMPT_SECTIONS[5])).toContain("먼저 찾아봐 주세요");
  });
});

describe("the confirmation the person reads", () => {
  it("is §3's sentence for 'only here'", () => {
    const built = build({ scope: { kind: "only_here", placeId: "s-checkout" } });
    expect(built.confirmationText.startsWith("결제 화면의 결제 버튼만 바꾸라고 적었어요.")).toBe(true);
    // The place is named by that sentence; the person opened no switch.
    expect(built.confirmationText).not.toContain("열어 둔");
  });

  it("opens the 'only here' place for that prompt alone, not for the next one", () => {
    // The verifier's finding: choosing a place wrote it into the remembered
    // locks, and the "everywhere" prompt after it read "열어 둔 1개" about a
    // switch nobody touched. Nothing is written now, so the next prompt is
    // built from exactly the locks the person set.
    const onlyHere = build({ scope: { kind: "only_here", placeId: "s-checkout" } });
    expect(onlyHere.lockState.editable).toContain("s-checkout");
    const everywhere = build({ scope: { kind: "everywhere" } });
    expect(everywhere.lockState.editable).not.toContain("s-checkout");
    expect(everywhere.confirmationText).not.toContain("열어 둔");
    expect(locksShown({}, { selectionId: "s-pay", placeId: "s-checkout" }, { promptInFront: true, selectedId: "s-pay" })).toEqual({
      "s-checkout": "editable",
    });
    // Not while something else is in front, and not about another selection.
    expect(locksShown({}, { selectionId: "s-pay", placeId: "s-checkout" }, { promptInFront: false, selectedId: "s-pay" })).toEqual({});
    expect(locksShown({}, { selectionId: "s-pay", placeId: "s-checkout" }, { promptInFront: true, selectedId: "s-cart" })).toEqual({});
    expect(locksShown({ "s-checkout": "locked" }, null, { promptInFront: true, selectedId: "s-pay" })).toEqual({
      "s-checkout": "locked",
    });
  });

  it("says everywhere, with the number, and never 'only' beside 'all'", () => {
    const built = build({ scope: { kind: "everywhere" } });
    expect(built.confirmationText).toContain("결제 버튼 — 쓰이는 2곳 모두에서 함께 바꾸라고 적었어요.");
    // It read "결제 버튼만 바꾸라고 적었어요. 쓰이는 2곳 모두 함께 바뀌어요."
    expect(built.confirmationText).not.toContain("만 바꾸라고");
  });

  it("counts what was opened and what stayed locked", () => {
    const built = build({ locks: { "s-format": "editable" } });
    expect(built.confirmationText).toContain("열어 둔 1개는 같이 고쳐도 된다고 했어요.");
    expect(built.confirmationText).toContain("잠긴 4개는 건드리지 말라고 했어요.");
  });

  it("speaks 해요체 and never needs a particle it cannot know", () => {
    for (const scope of [null, { kind: "everywhere" as const }, { kind: "only_here" as const, placeId: "s-cart" }]) {
      const text = build({ scope }).confirmationText;
      expect(text).toMatch(/요\.$/);
      expect(text).not.toMatch(/습니다|합니다/);
      // A Latin name followed by 을/를/이/가 is a guess about pronunciation.
      expect(text).not.toMatch(/[A-Za-z`](을|를|이|가|은|는) /);
    }
  });
});

/*
 * A file, the page that is that file, and a feature a model grouped it under.
 *
 * Its own small map, because the shop above has none of the three shapes this
 * block is about, and adding them there would move every count the blocks above
 * pin. `f-page` is a Next.js page file; `r-page` is the page it serves, which the
 * map holds as a second item with the same path and no line range. `s-hero`
 * and `s-helper` are written inside it.
 */
const PAGE_ITEMS: GraphItem[] = [
  item({ id: "f-page", kind: "file", name: "src/app/about/page.tsx", path: "src/app/about/page.tsx" }),
  item({ id: "r-page", kind: "route", name: "/about", path: "src/app/about/page.tsx" }),
  item({
    id: "s-hero",
    kind: "symbol",
    shape: "component",
    name: "AboutHero",
    label: "소개 첫 화면",
    path: "src/app/about/page.tsx",
    startLine: 3,
    endLine: 20,
  }),
  item({
    id: "s-helper",
    kind: "symbol",
    shape: "function",
    name: "yearsSince",
    path: "src/app/about/page.tsx",
    startLine: 22,
    endLine: 26,
  }),
  item({ id: "f-layout", kind: "file", name: "src/app/layout.tsx", path: "src/app/layout.tsx" }),
  item({ id: "feat-about", kind: "feature", name: "feature:0a1b2c3d4e5f", label: "회사 소개" }),
  item({ id: "p-dotenv", kind: "package", name: "dotenv" }),
];

const PAGE_CONNECTIONS: GraphConnection[] = [
  { id: "p1", from: "f-page", to: "r-page", relation: "contains", certainty: "certain" },
  { id: "p2", from: "f-page", to: "s-hero", relation: "contains", certainty: "certain" },
  { id: "p3", from: "f-page", to: "s-helper", relation: "contains", certainty: "certain" },
  { id: "p4", from: "s-hero", to: "s-helper", relation: "calls", certainty: "certain" },
  { id: "p5", from: "f-page", to: "f-layout", relation: "imports", certainty: "certain" },
  { id: "p6", from: "f-page", to: "feat-about", relation: "belongs_to", certainty: "inferred" },
  { id: "p7", from: "f-page", to: "p-dotenv", relation: "uses_package", certainty: "certain" },
];

const PAGE_GRAPH = { items: PAGE_ITEMS, connections: PAGE_CONNECTIONS };

function buildPage(overrides: Partial<PromptInput> = {}) {
  return buildPrompt({
    graph: PAGE_GRAPH,
    selectionIds: ["f-page"],
    hops: 1,
    locks: {},
    request: "제목 글자를 굵게 해줘",
    goal: null,
    scope: null,
    ...overrides,
  });
}

/** Every locked id whose lines sit inside an allowed item's lines. Must be none. */
function contradictions(built: ReturnType<typeof buildPrompt>, items: readonly GraphItem[]): string[] {
  const byId = new Map(items.map((one) => [one.id, one]));
  const within = (inner: GraphItem, outer: GraphItem) =>
    inner.path !== null &&
    inner.path === outer.path &&
    (outer.startLine === null ||
      (inner.startLine !== null &&
        outer.startLine <= inner.startLine &&
        (inner.endLine ?? inner.startLine) <= (outer.endLine ?? outer.startLine)));
  return built.lockState.locked.filter((id) =>
    built.selectionNodeIds.some((sel) => within(byId.get(id)!, byId.get(sel)!)),
  );
}

describe("a selected file, and what is written in it", () => {
  it("opens what is written inside the file, so the prompt does not allow and forbid the same lines", () => {
    // The verifier's finding: 238 of 238 files with pieces in them allowed the
    // whole file under 4 and forbade every piece of it under 5.
    const built = buildPage();
    const allowed = section(built.promptText, PROMPT_SECTIONS[3]);
    const locked = section(built.promptText, PROMPT_SECTIONS[4]);
    expect(allowed).toContain("- `src/app/about/page.tsx` (파일 전체) — 바꿀 곳");
    expect(locked).not.toContain("AboutHero");
    expect(locked).not.toContain("yearsSince");
    expect(locked).not.toContain("`src/app/about/page.tsx`");
    expect(built.lockState.editable).toEqual(expect.arrayContaining(["s-hero", "s-helper", "r-page"]));
    expect(contradictions(built, PAGE_ITEMS)).toEqual([]);
  });

  it("does not list the file's own pieces as things the person opened", () => {
    const built = buildPage();
    expect(section(built.promptText, PROMPT_SECTIONS[3])).not.toContain("사용자가 열어 둠");
    expect(built.confirmationText).not.toContain("열어 둔");
  });

  it("words a piece the person closed inside the file as a carve-out", () => {
    const built = buildPage({ locks: { "s-hero": "locked" } });
    const allowed = section(built.promptText, PROMPT_SECTIONS[3]);
    const locked = section(built.promptText, PROMPT_SECTIONS[4]);
    expect(allowed).toContain("(파일 전체) — 바꿀 곳 (5번에 적은 잠긴 줄은 빼고)");
    expect(locked).toContain("`AboutHero` · `src/app/about/page.tsx` 3–20줄");
    expect(locked).toContain("사용자가 직접 잠갔어요");
    expect(built.lockState.locked).toContain("s-hero");
  });

  it("treats the page that is the selected file as the selected file", () => {
    const built = buildPage();
    expect(section(built.promptText, PROMPT_SECTIONS[1])).toContain(
      "같은 코드가 지도에 한 번 더 있어요: `/about` (페이지)",
    );
    expect(section(built.promptText, PROMPT_SECTIONS[4])).not.toContain("/about");
    // Even if its switch was somehow closed, it is the thing being changed.
    const closed = buildPage({ locks: { "r-page": "locked" } });
    expect(closed.lockState.locked).not.toContain("r-page");
  });

  it("and the other way round: the file a selected page is, is never locked as a whole", () => {
    // Kim-and-Chang-'s pages/log.py: 4 said `/log` (파일 전체) — 바꿀 곳, 5 said
    // `pages/log.py` (파일 전체).
    const built = buildPage({ selectionIds: ["r-page"] });
    const locked = section(built.promptText, PROMPT_SECTIONS[4]);
    expect(locked).not.toContain("`src/app/about/page.tsx` (파일 전체)");
    expect(locked).not.toContain("`src/app/about/page.tsx`에서");
    expect(contradictions(built, PAGE_ITEMS)).toEqual([]);
  });

  it("still locks the rest of the file around a selected piece", () => {
    const built = buildPage({ selectionIds: ["s-helper"] });
    expect(section(built.promptText, PROMPT_SECTIONS[4])).toContain(
      "`src/app/about/page.tsx`에서 `yearsSince`(22–26줄) 밖의 부분 — 바꿀 곳이 들어 있는 파일",
    );
  });

  it("never allows and forbids the same lines, for any selection on either map", () => {
    for (const graph of [GRAPH, PAGE_GRAPH]) {
      for (const one of graph.items.filter(canPromptAbout)) {
        for (const hops of [1, 2]) {
          const built = buildPrompt({
            graph,
            selectionIds: [one.id],
            hops,
            locks: {},
            request: "바꿔줘",
            goal: null,
            scope: { kind: "everywhere" },
          });
          expect(contradictions(built, graph.items), `${one.id} at ${hops}`).toEqual([]);
        }
      }
    }
  });
});

/*
 * A class with a method in it, inside a file, used from another file.
 *
 * The two nestings D171 is about need one piece inside another inside a file,
 * which neither map above has: `Cart` (a class) holds `total` (a method), both
 * written in `src/cart.ts`, and `src/checkout.ts`'s `pay` calls `total`.
 */
const NEST_ITEMS: GraphItem[] = [
  item({ id: "f-cart", kind: "file", name: "src/cart.ts", path: "src/cart.ts" }),
  item({ id: "s-class", kind: "symbol", shape: "class", name: "Cart", path: "src/cart.ts", startLine: 1, endLine: 40 }),
  item({ id: "s-total", kind: "symbol", shape: "function", name: "total", path: "src/cart.ts", startLine: 10, endLine: 18 }),
  item({ id: "s-empty", kind: "symbol", shape: "function", name: "isEmpty", path: "src/cart.ts", startLine: 44, endLine: 46 }),
  item({ id: "f-checkout", kind: "file", name: "src/checkout.ts", path: "src/checkout.ts" }),
  item({ id: "s-pay", kind: "symbol", shape: "function", name: "pay", path: "src/checkout.ts", startLine: 3, endLine: 12 }),
];
const NEST_CONNECTIONS: GraphConnection[] = [
  { id: "n1", from: "f-cart", to: "s-class", relation: "contains", certainty: "certain" },
  { id: "n2", from: "f-cart", to: "s-total", relation: "contains", certainty: "certain" },
  { id: "n3", from: "f-cart", to: "s-empty", relation: "contains", certainty: "certain" },
  { id: "n4", from: "s-class", to: "s-total", relation: "contains", certainty: "certain" },
  { id: "n5", from: "f-checkout", to: "s-pay", relation: "contains", certainty: "certain" },
  { id: "n6", from: "s-pay", to: "s-total", relation: "calls", certainty: "certain" },
  { id: "n7", from: "f-checkout", to: "f-cart", relation: "imports", certainty: "certain" },
];
const NEST_GRAPH = { items: NEST_ITEMS, connections: NEST_CONNECTIONS };

function buildNest(overrides: Partial<PromptInput> = {}) {
  return buildPrompt({
    graph: NEST_GRAPH,
    selectionIds: ["f-cart"],
    hops: 1,
    locks: {},
    request: "합계 계산을 고쳐줘",
    goal: null,
    scope: null,
    ...overrides,
  });
}

/** The "- " line in a section that is about `one`: every line starts with what it names. */
function lineAbout(text: string, heading: string, one: GraphItem): string | undefined {
  const head = one.kind === "file" && one.name === one.path ? one.path : one.name;
  return section(text, heading)
    .split("\n")
    .find((line) => line.startsWith(`- \`${head}\``));
}

/**
 * Every place a prompt allows and forbids the same lines without saying so.
 *
 * Read off the text, not the lock lists, because the verifier's finding was a
 * sentence (the cap's) that the list comparison above never looks at. Three
 * ways, each a sentence an agent would have to choose between:
 *   - a locked thing inside an allowed place whose line in 4 has no carve-out;
 *   - an allowed thing inside a locked place whose line in 5 is not "the rest";
 *   - the cap forbidding everything unlisted when what it left out includes
 *     pieces of an allowed place.
 */
function unsaid(built: ReturnType<typeof buildPrompt>, items: readonly GraphItem[]): string[] {
  const byId = new Map(items.map((one) => [one.id, one]));
  const within = (inner: GraphItem, outer: GraphItem) =>
    inner.id !== outer.id &&
    inner.path !== null &&
    inner.path === outer.path &&
    (outer.startLine === null ||
      (inner.startLine !== null &&
        outer.startLine <= inner.startLine &&
        (inner.endLine ?? inner.startLine) <= (outer.endLine ?? outer.startLine)));
  const selection = built.selectionNodeIds.map((id) => byId.get(id)!);
  const allowed = built.lockState.editable.map((id) => byId.get(id)!);
  const locked = built.lockState.locked.map((id) => byId.get(id)!);
  const found: string[] = [];
  for (const a of allowed) {
    for (const l of locked) {
      if (within(l, a)) {
        // A place that is part of the selection has no line of its own: the
        // selection's line speaks for it.
        const home = selection.find((one) => one.id === a.id || within(a, one)) ?? a;
        const line = lineAbout(built.promptText, PROMPT_SECTIONS[3], home);
        if (!line?.includes("(5번에 적은 잠긴 줄은 빼고)")) found.push(`${l.id} locked inside allowed ${a.id}: ${line}`);
      }
      if (within(a, l)) {
        const line = lineAbout(built.promptText, PROMPT_SECTIONS[4], l);
        if (!line?.includes("밖의 부분")) found.push(`${a.id} allowed inside locked ${l.id}: ${line}`);
      }
    }
  }
  if (built.promptText.includes("목록에 없는 것은 건드리지 마세요")) found.push("the cap forbids everything unlisted");
  return found;
}

describe("nothing is allowed and forbidden at once (D171)", () => {
  it("says what the cap left out of an allowed file may change with it", () => {
    // The verifier's finding: Kim-and-Chang-'s dashboard.py allowed the whole
    // file under 4, while 3 ended "목록에 없는 것은 건드리지 마세요" over 22 of
    // its own pieces the cap had dropped.
    for (const limit of [1, 2, 3]) {
      const built = buildPage({ limit });
      const context = section(built.promptText, PROMPT_SECTIONS[2]);
      expect(context, `limit ${limit}`).toMatch(/4번에 적은 곳 안에 적힌 것이라, 그 곳과 함께 고쳐도 돼요/);
      expect(context).not.toContain("목록에 없는 것은 건드리지 마세요");
      expect(unsaid(built, PAGE_ITEMS)).toEqual([]);
    }
  });

  it("still forbids what the cap left out that is outside everything allowed", () => {
    // `limit: 1` on the shop's PayButton leaves out one of the two pages that
    // render it — outside everything allowed, so still forbidden, and said so.
    const context = section(build({ limit: 1 }).promptText, PROMPT_SECTIONS[2]);
    expect(context).toContain("목록에서 뺀 것이라도 4번에 적은 곳 밖에 있는 것은 건드리지 마세요.");
    expect(context).not.toContain("고쳐도 돼요");
  });

  it("keeps a lock the person set by hand on a piece the cap left out", () => {
    // Locks are remembered by id, so a piece closed while something else was
    // selected is still closed when its file is selected — listed or not.
    const built = buildPage({ limit: 1, locks: { "s-hero": "locked" } });
    expect(built.lockState.locked).toContain("s-hero");
    expect(section(built.promptText, PROMPT_SECTIONS[4])).toContain("`AboutHero` · `src/app/about/page.tsx` 3–20줄");
    expect(section(built.promptText, PROMPT_SECTIONS[3])).toContain("(5번에 적은 잠긴 줄은 빼고)");
    expect(unsaid(built, PAGE_ITEMS)).toEqual([]);
  });

  it("carves a locked piece out of a file the person opened", () => {
    // The verifier's other finding: select `materializeFixture`, open the file
    // it is written in, and 4 allowed that file while 5 still forbade `walk`
    // in it, with nothing saying which wins. Here: select `total`, open
    // `src/cart.ts`, and `Cart` — around `total`, in the same file — stays shut.
    const built = buildNest({ selectionIds: ["s-total"], locks: { "f-cart": "editable" } });
    const allowed = section(built.promptText, PROMPT_SECTIONS[3]);
    const locked = section(built.promptText, PROMPT_SECTIONS[4]);
    expect(allowed).toContain(
      "- `src/cart.ts`의 다른 부분 — 바꿀 곳이 들어 있는 파일, 사용자가 열어 둠 (5번에 적은 잠긴 줄은 빼고)",
    );
    expect(locked).toContain("- `Cart` · `src/cart.ts` 1–40줄에서 `total`(10–18줄) 밖의 부분");
    expect(locked).toContain("4번에서 열어 둔 곳 안에 적힌 것은 잠긴 채로 남아 있어요");
    expect(unsaid(built, NEST_ITEMS)).toEqual([]);
  });

  it("carves every listed piece out of a neighbour file the person opened", () => {
    // Two steps out from `src/checkout.ts`: the file it imports, and the three
    // pieces written in that file, each with its own switch.
    const built = buildNest({ selectionIds: ["f-checkout"], hops: 2, locks: { "f-cart": "editable" } });
    const allowed = section(built.promptText, PROMPT_SECTIONS[3]);
    const locked = section(built.promptText, PROMPT_SECTIONS[4]);
    expect(allowed).toContain("- `src/cart.ts` (파일 전체) — 사용자가 열어 둠 (5번에 적은 잠긴 줄은 빼고)");
    expect(locked).toContain("- `total` · `src/cart.ts` 10–18줄");
    expect(locked).toContain("- `Cart` · `src/cart.ts` 1–40줄");
    expect(unsaid(built, NEST_ITEMS)).toEqual([]);
  });

  it("words a locked file around a piece the person opened as the rest of it", () => {
    const built = buildNest({ selectionIds: ["f-checkout"], hops: 2, locks: { "s-total": "editable" } });
    expect(section(built.promptText, PROMPT_SECTIONS[3])).toContain("- `total` · `src/cart.ts` 10–18줄 — 사용자가 열어 둠");
    const locked = section(built.promptText, PROMPT_SECTIONS[4]);
    expect(locked).toContain("- `src/cart.ts`에서 `total`(10–18줄) 밖의 부분 — 열어 둔 곳이 들어 있는 파일");
    expect(locked).toContain("- `Cart` · `src/cart.ts` 1–40줄에서 `total`(10–18줄) 밖의 부분");
    expect(unsaid(built, NEST_ITEMS)).toEqual([]);
  });

  it("words a class closed inside the selected file as the rest of it, when a method in it stays open", () => {
    // Kim-and-Chang-'s dashboard.py: closing `_SnapAccount` left `__getattr__`
    // open inside it, and 5 forbade the whole class.
    const built = buildNest({ locks: { "s-class": "locked" } });
    expect(section(built.promptText, PROMPT_SECTIONS[3])).toContain(
      "- `src/cart.ts` (파일 전체) — 바꿀 곳 (5번에 적은 잠긴 줄은 빼고)",
    );
    expect(section(built.promptText, PROMPT_SECTIONS[4])).toContain(
      "- `Cart` · `src/cart.ts` 1–40줄에서 `total`(10–18줄) 밖의 부분",
    );
    expect(unsaid(built, NEST_ITEMS)).toEqual([]);
  });

  it("names a class the person opened around the selection as a piece, not as its whole file", () => {
    const built = buildNest({ selectionIds: ["s-total"], locks: { "s-class": "editable" } });
    const allowed = section(built.promptText, PROMPT_SECTIONS[3]);
    expect(allowed).toContain("- `Cart` · `src/cart.ts` 1–40줄 — 바꿀 곳을 감싼 조각, 사용자가 열어 둠");
    expect(allowed).not.toContain("`src/cart.ts`의 다른 부분");
    expect(section(built.promptText, PROMPT_SECTIONS[4])).toContain(
      "- `src/cart.ts`에서 `Cart`(1–40줄) 밖의 부분 — 바꿀 곳이 들어 있는 파일",
    );
    expect(unsaid(built, NEST_ITEMS)).toEqual([]);
  });

  it("holds for every selection on all three maps, at every cap, before and after any one switch", () => {
    let prompts = 0;
    for (const graph of [GRAPH, PAGE_GRAPH, NEST_GRAPH]) {
      for (const one of graph.items.filter(canPromptAbout)) {
        for (const hops of [1, 2]) {
          for (const limit of [1, 2, 24]) {
            const ids = graph.items.filter((other) => other.id !== one.id).map((other) => other.id);
            const lockings = [{}, ...ids.flatMap((id) => [{ [id]: "editable" as const }, { [id]: "locked" as const }])];
            for (const locks of lockings) {
              const built = buildPrompt({
                graph,
                selectionIds: [one.id],
                hops,
                limit,
                locks,
                request: "바꿔줘",
                goal: null,
                scope: { kind: "everywhere" },
              });
              prompts += 1;
              expect(unsaid(built, graph.items), `${one.id} at ${hops}, limit ${limit}, ${JSON.stringify(locks)}`).toEqual([]);
            }
          }
        }
      }
    }
    expect(prompts).toBeGreaterThan(1_000);
  });
});

describe("what is not code", () => {
  it("is never a place to change: a feature and a package", () => {
    const feature = PAGE_ITEMS.find((one) => one.id === "feat-about")!;
    const dotenv = PAGE_ITEMS.find((one) => one.id === "p-dotenv")!;
    expect(canPromptAbout(feature)).toBe(false);
    expect(canPromptAbout(dotenv)).toBe(false);
    for (const id of ["feat-about", "p-dotenv"]) {
      const built = buildPage({ selectionIds: [id] });
      expect(built.selectionNodeIds).toEqual([]);
      expect(section(built.promptText, PROMPT_SECTIONS[3])).not.toContain("바꿀 곳");
      expect(built.promptText).not.toContain("feature:");
      expect(built.promptText).not.toContain("`dotenv` · 이 프로젝트 밖의 도구 — 바꿀 곳");
    }
  });

  it("names a feature by its plain name as context, and never puts its id on either list", () => {
    const built = buildPage();
    expect(built.promptText).not.toContain("feature:0a1b2c3d4e5f");
    expect(section(built.promptText, PROMPT_SECTIONS[2])).toContain("묶어 둔 기능(짐작): 회사 소개");
    expect(built.lockState.editable).not.toContain("feat-about");
    expect(built.lockState.locked).not.toContain("feat-about");
  });
});

describe("the vocabulary", () => {
  it("never uses a word the product does not, in anything it wrote itself", () => {
    // The fixture's own labels and the request are clean, so any hit here is
    // the template's.
    for (const scope of [null, { kind: "everywhere" as const }, { kind: "only_here" as const, placeId: "s-cart" }]) {
      for (const hops of [1, 3]) {
        const built = build({ scope, hops, locks: { "s-format": "editable" } });
        for (const text of [built.promptText, built.confirmationText]) {
          for (const word of FLOW_FORBIDDEN_WORDS) expect(text).not.toContain(word);
          expect(text).not.toContain("안전");
          expect(text).not.toContain("아무 데서도");
        }
      }
    }
  });

  it("quotes the person's own words untouched, whatever they are", () => {
    // The person may say 실행 about their own app; that is their sentence, and
    // it goes to the agent as written.
    const built = build({ request: "결제 버튼 누르면 실행되는 걸 바꿔줘" });
    expect(built.promptText).toContain('"결제 버튼 누르면 실행되는 걸 바꿔줘"');
  });
});
