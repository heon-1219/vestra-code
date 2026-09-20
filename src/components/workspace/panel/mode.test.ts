import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GraphItem, GraphView } from "@/lib/graph/view";

import {
  PLANE,
  RightPanel,
  sendsOnKey,
  type RightPanelProps,
} from "./connections-panel";
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

    /*
     * The action is the filled button, and it still carries the chosen mode's
     * word — as its accessible name rather than as its text, since it became a
     * paper plane inside the box. The distinction between 물어보기 and
     * 프롬프트 만들기 has to stay readable; where it is written may move.
     */
    const actions = html.match(/<button[^>]*bg-paper[^>]*>/g) ?? [];
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

/**
 * Which keystroke sends.
 *
 * The button became a paper plane inside the box and Enter took over sending,
 * which puts the whole weight on one rule: an IME's Enter is not ours.
 */
describe("sending from the keyboard", () => {
  const press = (over: Partial<Parameters<typeof sendsOnKey>[0]> = {}) =>
    sendsOnKey({ key: "Enter", shiftKey: false, isComposing: false, ...over });

  it("sends on a plain Enter", () => {
    expect(press()).toBe(true);
  });

  it("does not send while an IME is assembling a syllable", () => {
    /*
     * The one that matters. A Korean IME commits 결제 with Enter, and that
     * keystroke belongs to it. Sending there fires mid-sentence with half a
     * question in the box, and nothing on screen explains why.
     */
    expect(press({ isComposing: true })).toBe(false);
  });

  it("leaves Shift+Enter to write a second line", () => {
    expect(press({ shiftKey: true })).toBe(false);
  });

  it("ignores every other key", () => {
    expect(press({ key: "a" })).toBe(false);
    expect(press({ key: "Tab" })).toBe(false);
    // Including one that looks close enough to be worth saying out loud.
    expect(press({ key: "NumpadEnter" })).toBe(false);
  });
});

/**
 * Where the send mark's weight sits.
 *
 * A paper plane has a long thin nose and a wide tail, so centring its bounding
 * box leaves the ink off in a corner — which is exactly how the first version
 * looked wrong inside a round button: box centre (8, 8), area centroid
 * (9.13, 6.87). The shape is drawn around its centroid now, and this recomputes
 * that rather than trusting the comment, because the next person to nudge a
 * point will not redo the arithmetic by hand.
 */
describe("the send mark", () => {
  const points = [PLANE.nose, PLANE.tail, PLANE.fold, PLANE.wing].map((pair) => {
    const [x, y] = pair.split(" ").map(Number);
    return { x, y };
  });

  /** Shoelace: signed area, and the centroid of that area. */
  function centroid() {
    let twiceArea = 0;
    let x = 0;
    let y = 0;
    for (const [index, a] of points.entries()) {
      const b = points[(index + 1) % points.length];
      const cross = a.x * b.y - b.x * a.y;
      twiceArea += cross;
      x += (a.x + b.x) * cross;
      y += (a.y + b.y) * cross;
    }
    const area = twiceArea / 2;
    return { x: x / (6 * area), y: y / (6 * area) };
  }

  it("carries its weight in the middle of the box", () => {
    const middle = centroid();
    expect(middle.x).toBeCloseTo(8, 1);
    expect(middle.y).toBeCloseTo(8, 1);
  });

  it("keeps its stroke inside the box it is drawn in", () => {
    // Half of `strokeWidth`, which a round cap puts outside the path.
    const bleed = 0.75;
    for (const point of points) {
      expect(point.x - bleed).toBeGreaterThanOrEqual(0);
      expect(point.x + bleed).toBeLessThanOrEqual(16);
      expect(point.y - bleed).toBeGreaterThanOrEqual(0);
      expect(point.y + bleed).toBeLessThanOrEqual(16);
    }
  });
});
