import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GraphItem, GraphView } from "@/lib/graph/view";
import { buildPrompt } from "@/lib/prompt/build";
import { GOAL_NOTES } from "@/lib/prompt/goal";
import { EXPLAIN_WORDS } from "@/qa/explain";

import { FROM_THE_MAP } from "../explain/explain-card";
import { scopeSentence } from "../prompt/prompt-card";
import { SAME_CODE } from "./connection-row";
import { groupedSentence, RightPanel, type RightPanelProps } from "./connections-panel";
import { MODE_WORDS } from "./mode";

/**
 * 프롬프트 만들기 and 설명하기, as the panel shows them.
 *
 * Rendered to static markup, the way the panel's other tests are, so what is
 * pinned is what a person would read: the question asked before a prompt is
 * written, the one plain sentence and the toggle that hides the prompt, and an
 * explanation that says who wrote each of its lines.
 */

function item(id: string, overrides: Partial<GraphItem> = {}): GraphItem {
  return {
    id,
    kind: "symbol",
    shape: "component",
    name: id,
    label: null,
    summary: null,
    path: `src/${id}.tsx`,
    startLine: 1,
    endLine: 10,
    fromUser: false,
    usedBy: 0,
    uses: 0,
    ...overrides,
  };
}

const view: GraphView = {
  projectId: "project-1",
  items: [
    item("PayButton", { label: "결제 버튼", summary: "누르면 주문을 넣어요.", usedBy: 2 }),
    item("CheckoutPage", { label: "결제 화면" }),
    item("CartPage", { label: "장바구니 화면" }),
    item("formatPrice", { shape: "function" }),
  ],
  connections: [
    { id: "a", from: "CheckoutPage", to: "PayButton", relation: "renders", certainty: "certain" },
    { id: "b", from: "CartPage", to: "PayButton", relation: "renders", certainty: "certain" },
    { id: "c", from: "PayButton", to: "formatPrice", relation: "calls", certainty: "inferred" },
  ],
  lastRun: {
    id: "run-1",
    status: "completed",
    finishedAt: "2026-09-21T00:00:00.000Z",
    filesParsed: 4,
    filesSkipped: [],
    error: null,
  },
};

function render(overrides: Partial<RightPanelProps>): string {
  return renderToStaticMarkup(
    createElement(RightPanel, {
      view,
      selectedId: "PayButton",
      locks: {},
      onLockChange: () => {},
      onSelect: () => {},
      onAsk: () => {},
      onMakePrompt: () => {},
      onExplain: () => {},
      onFlow: () => {},
      models: [{ id: "gemini", label: "Gemini", effort: "graded" }],
      ...overrides,
    }),
  );
}

function words(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

describe("프롬프트 만들기 on the panel", () => {
  it("asks 'only here or everywhere?' with a button per place, before any prompt exists", () => {
    const html = render({
      promptPhase: {
        status: "choosing",
        selectionId: "PayButton",
        request: "파란색으로",
        places: [view.items[1], view.items[2]],
      },
    });
    const text = words(html);
    expect(text).toContain("쓰이는 곳이 2곳이에요");
    expect(text).toContain("쓰이는 2곳 모두에서");
    // Where the change should apply, not where it should be seen: most of what
    // is asked this is a function, whose callers show nothing.
    expect(text).toContain(scopeSentence("결제 버튼", 2));
    expect(text).not.toContain("어디에 보이면");
    expect(text).toContain("결제 화면 에서만");
    expect(text).toContain("장바구니 화면 에서만");
    expect(text).not.toContain("프롬프트 보기");
  });

  it("shows the plain sentence first and keeps the prompt behind 프롬프트 보기", () => {
    const built = buildPrompt({
      graph: view,
      selectionIds: ["PayButton"],
      hops: 1,
      locks: {},
      request: "파란색으로 바꿔줘",
      goal: null,
      scope: { kind: "only_here", placeId: "CheckoutPage" },
    });
    const html = render({
      promptPhase: { status: "ready", selectionId: "PayButton", built, goal: null, note: GOAL_NOTES.no_model },
    });
    const text = words(html);
    expect(text).toContain("결제 화면의 결제 버튼만 바꾸라고 적었어요.");
    expect(text).toContain(GOAL_NOTES.no_model);
    expect(text).toContain("프롬프트 복사하기");
    // The prompt is in the markup — behind a closed <details> — and after the
    // sentence, never before it.
    expect(html).toMatch(/<details[^>]*><summary[^>]*>프롬프트 보기<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(text.indexOf("바꾸라고 적었어요")).toBeLessThan(text.indexOf("## 1. 목표"));
  });

  it("marks a restated goal as a model's sentence", () => {
    const built = buildPrompt({
      graph: view,
      selectionIds: ["PayButton"],
      hops: 1,
      locks: {},
      request: "파란색으로",
      goal: { text: "결제 버튼을 파란색으로 바꿔 주세요.", fromModel: true },
      scope: { kind: "everywhere" },
    });
    const text = words(
      render({
        promptPhase: {
          status: "ready",
          selectionId: "PayButton",
          built,
          goal: "결제 버튼을 파란색으로 바꿔 주세요.",
          note: null,
        },
      }),
    );
    expect(text).toContain("모델이 쓴 말 목표: 결제 버튼을 파란색으로 바꿔 주세요.");
  });

  it("does not show a prompt made for one place under another", () => {
    const built = buildPrompt({
      graph: view,
      selectionIds: ["PayButton"],
      hops: 1,
      locks: {},
      request: "x",
      goal: null,
      scope: { kind: "everywhere" },
    });
    const text = words(
      render({
        selectedId: "formatPrice",
        promptPhase: { status: "ready", selectionId: "PayButton", built, goal: null, note: null },
      }),
    );
    expect(text).not.toContain("바꾸라고 적었어요");
  });

  it("needs both a selection and a request, and says which is missing", () => {
    const nothing = render({ selectedId: null });
    // The box starts empty, so the button is disabled either way; with nothing
    // selected the footer also says what to click.
    expect(MODE_WORDS.prompt.needs).toBe("both");
    expect(words(nothing)).not.toContain(MODE_WORDS.prompt.pick!); // the default mode is 물어보기
  });
});

describe("설명하기 on the panel", () => {
  it("explains the selection for free, with the model's lines marked", () => {
    const text = words(render({ explainOn: true, onDeepExplain: () => {} }));
    expect(text).toContain("조각 설명");
    expect(text).toContain("누르면 주문을 넣어요.");
    expect(text).toContain("모델이 코드를 보고 풀어 쓴 말");
    expect(text).toContain(FROM_THE_MAP);
    expect(text).toContain("2곳에서 쓰여요.");
    expect(text).toContain("코드를 직접 읽고 더 알아보기");
  });

  it("follows the selection: another click explains another thing", () => {
    const text = words(render({ explainOn: true, selectedId: "formatPrice", onDeepExplain: () => {} }));
    expect(text).toContain("formatPrice");
    expect(text).not.toContain("누르면 주문을 넣어요.");
  });

  it("says there is no model rather than offering a deep read that cannot run", () => {
    const text = words(render({ explainOn: true, onDeepExplain: () => {}, models: [] }));
    expect(text).toContain(EXPLAIN_WORDS.noModel);
    expect(text).not.toContain("코드를 직접 읽고 더 알아보기");
  });

  it("shows nothing until it is asked for", () => {
    const text = words(render({ explainOn: false }));
    expect(text).not.toContain("조각 설명");
  });
});

describe("the footer once every mode is wired", () => {
  it("drops every apology", () => {
    const html = render({});
    for (const mode of ["ask", "prompt", "explain", "flow"] as const) {
      expect(words(html)).not.toContain(MODE_WORDS[mode].notYet);
    }
  });
});

/*
 * A page file, the page it serves, a piece written in it, a file it imports,
 * and the feature a model put it under — the four shapes a row can stand in.
 */
const pageView: GraphView = {
  ...view,
  items: [
    item("f-page", { kind: "file", shape: null, name: "src/app/about/page.tsx", path: "src/app/about/page.tsx", startLine: null, endLine: null }),
    item("r-page", { kind: "route", shape: null, name: "/about", path: "src/app/about/page.tsx", startLine: null, endLine: null }),
    item("AboutHero", { label: "소개 첫 화면", path: "src/app/about/page.tsx", startLine: 3, endLine: 20 }),
    item("f-layout", { kind: "file", shape: null, name: "src/app/layout.tsx", path: "src/app/layout.tsx", startLine: null, endLine: null }),
    item("feat-about", { kind: "feature", shape: null, name: "feature:0a1b2c3d4e5f", label: "회사 소개", path: null, startLine: null, endLine: null }),
  ],
  connections: [
    { id: "p1", from: "f-page", to: "r-page", relation: "contains", certainty: "certain" },
    { id: "p2", from: "f-page", to: "AboutHero", relation: "contains", certainty: "certain" },
    { id: "p3", from: "f-page", to: "f-layout", relation: "imports", certainty: "certain" },
    { id: "p4", from: "f-page", to: "feat-about", relation: "belongs_to", certainty: "inferred" },
  ],
};

function switchFor(html: string, name: string): string | null {
  const match = new RegExp(`<button[^>]*aria-checked="(true|false)"[^>]*aria-label="${name} 편집 허용"`).exec(html);
  return match ? match[1] : null;
}

describe("the switches, by where each row stands", () => {
  it("opens what is written inside the selected file, and keeps the rest locked", () => {
    const html = render({ view: pageView, selectedId: "f-page" });
    expect(switchFor(html, "소개 첫 화면")).toBe("true");
    expect(switchFor(html, "src/app/layout.tsx")).toBe("false");
    expect(words(html)).toContain("고른 것 안에 적힌 것은 처음부터 열려 있어요.");
  });

  it("gives the page that is the selected file no switch, and says why on hover", () => {
    const html = render({ view: pageView, selectedId: "f-page" });
    expect(switchFor(html, "/about")).toBeNull();
    expect(html).toContain(`title="${SAME_CODE}"`);
  });

  it("gives a feature no switch at all", () => {
    const html = render({ view: pageView, selectedId: "f-page" });
    expect(switchFor(html, "회사 소개")).toBeNull();
  });

  it("keeps the old sentence where nothing is written inside the selection", () => {
    const text = words(render({ view: pageView, selectedId: "f-layout" }));
    expect(text).toContain("연결된 것은 처음엔 모두 잠겨 있어요.");
  });

  it("says a feature groups things rather than that they use it", () => {
    const text = words(render({ view: pageView, selectedId: "feat-about" }));
    expect(text).toContain(groupedSentence(1));
    expect(text).not.toContain("1곳에서 쓰여요");
  });
});

describe("what 프롬프트 만들기 will not make a prompt about", () => {
  it("says why for a feature and a package, and no other mode refuses either", () => {
    const cannot = MODE_WORDS.prompt.cannot!;
    for (const kind of ["feature", "package"] as const) {
      expect(cannot[kind]).toMatch(/요\.$/);
      expect(cannot[kind]).toContain("골라 주세요");
    }
    expect(MODE_WORDS.explain.cannot).toBeUndefined();
    expect(MODE_WORDS.ask.cannot).toBeUndefined();
    expect(MODE_WORDS.flow.cannot).toBeUndefined();
  });
});
