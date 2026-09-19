import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GraphItem, GraphView } from "@/lib/graph/view";

import { RightPanel, type RightPanelProps } from "./connections-panel";
import { DEFAULT_PANEL_MODE, MODE_WORDS, PANEL_MODES, type PanelMode } from "./mode";
import { ModeSelect } from "./mode-select";

/**
 * These tests are about the same thing the panel's other tests are about: a
 * screen that says something it cannot back.
 *
 * The mode selector is a working control in front of three actions that do not
 * exist yet, which is the single most likely way this panel could come to look
 * finished while being empty. So what is pinned here is that every mode says,
 * in its own words, that it cannot do its job yet; that the honesty is per mode
 * rather than one line about all of them; and that the control announcing the
 * choice actually announces it.
 */

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

function selectorHtml(value: PanelMode): string {
  return renderToStaticMarkup(createElement(ModeSelect, { value, onChange: () => {} }));
}

describe("the mode vocabulary", () => {
  it("lists every mode exactly once, and has words for each", () => {
    const listed = [...PANEL_MODES];
    const described = Object.keys(MODE_WORDS) as PanelMode[];

    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...described].sort());
    expect(listed).toContain(DEFAULT_PANEL_MODE);
  });

  it("offers the third mode the founder asked for", () => {
    expect(MODE_WORDS.explain.name).toBe("설명하기");
    // 설명하기 is about the thing already chosen, so it must not be waiting on
    // typed text — that would leave its button dead beside its own sentence.
    expect(MODE_WORDS.explain.needs).toBe("selection");
  });

  it("says per mode that the mode cannot do its job yet", () => {
    for (const mode of PANEL_MODES) {
      const { name, promise, notYet } = MODE_WORDS[mode];

      expect(notYet).toMatch(/아직/);
      // The promise is what it does; the admission is not allowed to eat it.
      expect(promise.length).toBeGreaterThan(0);
      expect(promise).not.toMatch(/아직/);
      expect(notYet.startsWith(promise)).toBe(false);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("writes a different sentence for every mode, so none of them is generic", () => {
    const promises = PANEL_MODES.map((mode) => MODE_WORDS[mode].promise);
    const excuses = PANEL_MODES.map((mode) => MODE_WORDS[mode].notYet);

    expect(new Set(promises).size).toBe(promises.length);
    expect(new Set(excuses).size).toBe(excuses.length);
  });

  it("speaks 해요체 and never names the machinery", () => {
    for (const mode of PANEL_MODES) {
      const { promise, notYet } = MODE_WORDS[mode];
      for (const sentence of [promise, notYet]) {
        expect(sentence).toMatch(/요\.$/);
        expect(sentence).not.toMatch(/습니다|합니다/);
        expect(sentence).not.toMatch(/노드|엣지|간선|함수|컴포넌트/);
      }
    }
  });
});

describe("the mode control", () => {
  it("announces which mode is on, and only that one", () => {
    const html = selectorHtml("explain");

    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g) ?? []).toHaveLength(PANEL_MODES.length - 1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>설명하기</);
  });

  it("keeps every mode on the keyboard", () => {
    const html = selectorHtml(DEFAULT_PANEL_MODE);

    // Real buttons, so Tab reaches them and the global focus outline shows.
    // None of them is `disabled`: a disabled button cannot be focused, and
    // choosing a mode is never the unsafe thing on this screen.
    expect(html.match(/<button/g) ?? []).toHaveLength(PANEL_MODES.length);
    expect(html).not.toContain("disabled");
  });
});

describe("the panel footer", () => {
  it("offers one action rather than a button per mode", () => {
    const html = render({ selectedId: "PayButton" });

    // The action is the filled button, and it carries the chosen mode's word.
    const actions = html.match(/<button[^>]*bg-paper[^>]*>([^<]*)<\/button>/g) ?? [];
    expect(actions).toHaveLength(1);
    expect(actions[0]).toContain(MODE_WORDS[DEFAULT_PANEL_MODE].name);
  });

  it("replaces the one shared 준비 중 line with the chosen mode's own", () => {
    const text = words(render({ selectedId: "PayButton" }));

    expect(text).toContain(MODE_WORDS[DEFAULT_PANEL_MODE].notYet);
    expect(text).not.toContain("묻고 답하기와 프롬프트 만들기는 아직 준비 중이에요");
    // And the other two modes' admissions are not on screen at the same time.
    expect(text).not.toContain(MODE_WORDS.explain.notYet);
  });

  it("drops the apology once that mode has something behind it", () => {
    const text = words(render({ selectedId: "PayButton", onAsk: () => {} }));

    expect(text).toContain(MODE_WORDS.ask.promise);
    expect(text).not.toContain(MODE_WORDS.ask.notYet);
  });

  it("keeps the choice in the footer, so changing selection cannot take it away", () => {
    // Same reason the box itself is mounted once: everything below the divider
    // belongs to the panel, not to whatever is selected in it.
    for (const html of [
      render({ selectedId: "PayButton" }),
      render({ selectedId: null }),
      render({ view: null }),
    ]) {
      expect(html).toContain('aria-label="이 상자로 무엇을 할지"');
      for (const mode of PANEL_MODES) {
        expect(html).toContain(`>${MODE_WORDS[mode].name}<`);
      }
    }
  });
});
