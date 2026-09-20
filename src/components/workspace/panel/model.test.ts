import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GraphItem, GraphView } from "@/lib/graph/view";

import { RightPanel, type RightPanelProps } from "./connections-panel";
import {
  chooseModel,
  DEFAULT_PANEL_EFFORT,
  EFFORT_WORDS,
  effortHonoured,
  hasModelChoice,
  NO_EFFORT_WORDS,
  NO_MODEL_WORDS,
  PANEL_EFFORTS,
  type ModelChoice,
  type PanelEffort,
} from "./model";
import { ModelSelect } from "./model-select";

/**
 * A picker in front of models this installation may not have.
 *
 * There is no key on this machine, and there will be none on most, so the
 * shape most likely to ship is a control over nothing: a dropdown with no
 * entries, or worse, entries we cannot honour. What is pinned here is that the
 * control withdraws rather than pretends — no model at all says so in words,
 * one model is a fact rather than a question, and a model with no thinking
 * control loses the 빠르게/깊게 row instead of keeping a switch wired to
 * nothing.
 */

const MIMO: ModelChoice = { id: "mimo", label: "MiMo", effort: "binary" };
const GEMINI: ModelChoice = { id: "gemini", label: "Gemini", effort: "graded" };
/** Any endpoint we know nothing about: the client sends it no thinking knob. */
const CUSTOM: ModelChoice = { id: "custom", label: "직접 설정한 모델", effort: "none" };

function controlHtml(
  models: readonly ModelChoice[],
  picked: ModelChoice | null = null,
  effort: PanelEffort = DEFAULT_PANEL_EFFORT,
): string {
  return renderToStaticMarkup(
    createElement(ModelSelect, {
      models,
      model: picked?.id ?? null,
      onModelChange: () => {},
      effort,
      onEffortChange: () => {},
    }),
  );
}

function item(id: string, overrides: Partial<GraphItem> = {}): GraphItem {
  return {
    id,
    kind: "symbol",
    shape: "function",
    name: id,
    label: null,
    summary: null,
    path: `src/${id}.ts`,
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
  items: [item("PayButton", { shape: "component" }), item("formatPrice")],
  connections: [
    { id: "a", from: "PayButton", to: "formatPrice", relation: "calls", certainty: "certain" },
  ],
  lastRun: {
    id: "run-1",
    status: "completed",
    finishedAt: "2026-09-19T00:00:00.000Z",
    filesParsed: 2,
    filesSkipped: [],
    error: null,
  },
};

function render(overrides: Partial<RightPanelProps>): string {
  return renderToStaticMarkup(
    createElement(RightPanel, {
      view,
      selectedId: null,
      locks: {},
      onLockChange: () => {},
      onSelect: () => {},
      ...overrides,
    }),
  );
}

function words(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the effort vocabulary", () => {
  it("offers two settings and no third", () => {
    // A third would be a level MiMo cannot honour: it documents enabled and
    // disabled and nothing between them.
    expect([...PANEL_EFFORTS]).toEqual(["fast", "deep"]);
    expect(PANEL_EFFORTS).toContain(DEFAULT_PANEL_EFFORT);
  });

  it("uses the words the founder asked for", () => {
    expect(EFFORT_WORDS.fast).toBe("빠르게");
    expect(EFFORT_WORDS.deep).toBe("깊게");
  });

  it("starts on the cheaper one", () => {
    // Thinking costs tokens and time, and the person running this pays for
    // both. The expensive setting is asked for, not defaulted into.
    expect(DEFAULT_PANEL_EFFORT).toBe("fast");
  });

  it("speaks 해요체 and never names the machinery", () => {
    for (const sentence of [NO_MODEL_WORDS, NO_EFFORT_WORDS]) {
      expect(sentence).toMatch(/요\.$/);
      expect(sentence).not.toMatch(/습니다|합니다/);
      expect(sentence).not.toMatch(/노드|엣지|간선|함수|컴포넌트/);
    }
    // Two different problems, so two different sentences: "no model" and "this
    // model has no such setting" are not the same news.
    expect(NO_MODEL_WORDS).not.toBe(NO_EFFORT_WORDS);
  });
});

describe("which model answers", () => {
  it("has none to answer with when none is connected", () => {
    expect(chooseModel([], null)).toBeNull();
    expect(chooseModel([], "mimo")).toBeNull();
  });

  it("takes the one that was picked", () => {
    expect(chooseModel([MIMO, GEMINI], "gemini")).toBe(GEMINI);
  });

  it("falls through to the default when the picked one is no longer there", () => {
    // A key can be taken away while a choice made before that is still held on
    // screen. Pointing at a model that is not there would fail at the moment of
    // asking rather than at the moment of choosing.
    expect(chooseModel([MIMO, GEMINI], "custom")).toBe(MIMO);
  });

  it("starts on the installation's default, which is listed first", () => {
    expect(chooseModel([GEMINI, MIMO], null)).toBe(GEMINI);
  });

  it("treats one model as a fact and two as a choice", () => {
    expect(hasModelChoice([])).toBe(false);
    expect(hasModelChoice([MIMO])).toBe(false);
    expect(hasModelChoice([MIMO, GEMINI])).toBe(true);
  });

  it("knows which models would ignore the effort setting", () => {
    expect(effortHonoured(null)).toBe(false);
    expect(effortHonoured(CUSTOM)).toBe(false);
    expect(effortHonoured(MIMO)).toBe(true);
    expect(effortHonoured(GEMINI)).toBe(true);
  });
});

describe("the picker", () => {
  it("shows no control at all when nothing is connected", () => {
    const html = controlHtml([]);

    expect(words(html)).toBe(NO_MODEL_WORDS);
    // Not an empty dropdown and not a disabled one: the first promises a
    // choice, the second promises it is coming, and neither is true.
    expect(html).not.toContain("<button");
    expect(html).not.toContain(EFFORT_WORDS.deep);
  });

  it("states the one model rather than asking about it", () => {
    const html = controlHtml([GEMINI]);

    expect(html).toContain("Gemini");
    expect(html).not.toMatch(/<button[^>]*>Gemini</);
    // Only the effort row is a control here.
    expect(html.match(/<button/g) ?? []).toHaveLength(PANEL_EFFORTS.length);
  });

  it("announces which model is on, and only that one", () => {
    const html = controlHtml([MIMO, GEMINI], GEMINI);

    expect(html).toMatch(/aria-pressed="true"[^>]*>Gemini</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>MiMo</);
    expect(html).toContain('aria-label="어떤 모델로 할지"');
  });

  it("announces which effort is on, and only that one", () => {
    const html = controlHtml([GEMINI], GEMINI, "deep");

    expect(html).toMatch(/aria-pressed="true"[^>]*>깊게</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>빠르게</);
    expect(html).toContain('aria-label="빠르게 할지 깊게 할지"');
  });

  it("withdraws the effort choice where the model has no such control", () => {
    const html = controlHtml([CUSTOM]);

    // The client sends no thinking parameter to a "none" endpoint, so both
    // settings would put identical bytes on the wire.
    expect(words(html)).toContain(NO_EFFORT_WORDS);
    // Both words are still on screen, because the sentence names what is
    // missing — but neither of them is anything you can press.
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-pressed");
  });

  it("keeps choosing the model even when that model cannot be asked to think", () => {
    // The two controls answer to different facts: one is about what exists,
    // the other about what the chosen one can do.
    const html = controlHtml([CUSTOM, GEMINI], CUSTOM);

    expect(html).toMatch(/aria-pressed="true"[^>]*>직접 설정한 모델</);
    expect(words(html)).toContain(NO_EFFORT_WORDS);
  });

  it("keeps every option on the keyboard", () => {
    const html = controlHtml([MIMO, GEMINI], MIMO, "deep");

    // Real buttons, none of them disabled: choosing changes only what the next
    // send will do, so the choice is never the unsafe thing on this screen.
    expect(html.match(/<button/g) ?? []).toHaveLength(2 + PANEL_EFFORTS.length);
    expect(html).not.toContain("disabled");
  });
});

describe("the picker inside the request box", () => {
  it("says there is no model rather than showing an empty one", () => {
    // Nothing passes models today, which is the truth on a machine with no
    // key — so this is the state the founder actually sees.
    expect(words(render({ selectedId: "PayButton" }))).toContain(NO_MODEL_WORDS);
  });

  it("offers the models this installation has", () => {
    const text = words(render({ selectedId: "PayButton", models: [MIMO, GEMINI] }));

    expect(text).toContain("MiMo");
    expect(text).toContain("Gemini");
    expect(text).toContain(EFFORT_WORDS.fast);
    expect(text).not.toContain(NO_MODEL_WORDS);
  });

  it("keeps the choice in the footer, so changing selection cannot take it away", () => {
    // Same reason the box itself is mounted once: everything below the divider
    // belongs to the panel, not to whatever is selected in it.
    for (const html of [
      render({ selectedId: "PayButton", models: [MIMO, GEMINI] }),
      render({ selectedId: null, models: [MIMO, GEMINI] }),
      render({ view: null, models: [MIMO, GEMINI] }),
    ]) {
      expect(html).toContain('aria-label="어떤 모델로 할지"');
      expect(html).toContain('aria-label="빠르게 할지 깊게 할지"');
    }
  });

  it("leaves one action button, not one per model", () => {
    const html = render({ selectedId: "PayButton", models: [MIMO, GEMINI] });

    const actions = html.match(/<button[^>]*bg-paper[^>]*>([^<]*)<\/button>/g) ?? [];
    expect(actions).toHaveLength(1);
  });
});
