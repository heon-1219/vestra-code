import { describe, expect, it } from "vitest";

import {
  columnTemplate,
  DEFAULT_LAYOUT,
  resizeColumns,
  resizeHistory,
  type PaneLayout,
} from "./panes";

/**
 * The arithmetic of dragging a divider.
 *
 * This is the part of a resizable layout that is wrong in ways you cannot see
 * by looking: a drag that quietly takes width from the pane on the far side, or
 * one that lets a pane reach zero and strands whatever was in it. Both look
 * fine for the first few pixels.
 */

const COLUMNS = DEFAULT_LAYOUT.columns;
const WIDTH = 1400;

/** What the three columns come to, which a divider must never change. */
const total = (columns: readonly number[]) =>
  Number(columns.reduce((sum, n) => sum + n, 0).toFixed(6));

describe("resizeColumns", () => {
  it("moves width from one neighbour to the other", () => {
    const next = resizeColumns(COLUMNS, 0, 140, WIDTH);
    expect(next[0]).toBeCloseTo(COLUMNS[0] + 0.1, 6);
    expect(next[1]).toBeCloseTo(COLUMNS[1] - 0.1, 6);
    // The divider between files and the map has no business touching the
    // connections panel on the far right.
    expect(next[2]).toBe(COLUMNS[2]);
  });

  it("keeps the row full, at every step of a drag", () => {
    let columns = COLUMNS;
    for (const delta of [30, -80, 200, -400, 15]) {
      columns = resizeColumns(columns, 1, delta, WIDTH);
      expect(total(columns)).toBe(1);
    }
  });

  it("stops at the left pane's minimum instead of collapsing it", () => {
    // Dragged hard left, far past zero.
    const next = resizeColumns(COLUMNS, 0, -5000, WIDTH);
    expect(next[0] * WIDTH).toBeCloseTo(170, 5);
    expect(total(next)).toBe(1);
  });

  it("stops at the right pane's minimum too", () => {
    const next = resizeColumns(COLUMNS, 0, 5000, WIDTH);
    // The map keeps its own floor; the pair's total is unchanged.
    expect(next[1] * WIDTH).toBeCloseTo(260, 5);
    expect(total(next)).toBe(1);
  });

  it("does nothing when the container has not been measured", () => {
    // A drag that starts before layout — a pointer-down on the first frame —
    // must not divide by zero and hand back NaN widths.
    expect(resizeColumns(COLUMNS, 0, 100, 0)).toEqual([...COLUMNS]);
  });
});

describe("resizeHistory", () => {
  it("grows the band when the divider is dragged up", () => {
    // Up is a negative delta, and the band is measured from the bottom, so the
    // sign inverts exactly once. Getting this backwards is the classic bug.
    expect(resizeHistory(0.1, -90, 900)).toBeCloseTo(0.2, 6);
  });

  it("never lets the band close entirely", () => {
    const next = resizeHistory(0.1, 5000, 900);
    expect(next * 900).toBeCloseTo(34, 5);
  });

  it("never lets the band take the workspace", () => {
    expect(resizeHistory(0.5, -5000, 900)).toBe(0.6);
  });
});

describe("columnTemplate", () => {
  it("draws three columns and two dividers when nothing is maximised", () => {
    expect(columnTemplate(DEFAULT_LAYOUT)).toBe(
      "minmax(0, 0.17fr) 5px minmax(0, 0.58fr) 5px minmax(0, 0.25fr)",
    );
  });

  it("gives the row to one pane and zero to the rest", () => {
    const layout: PaneLayout = { ...DEFAULT_LAYOUT, maximized: "panel" };
    // Zero width, not removed: the other panes stay mounted, so their scroll
    // position and a half-typed search survive being maximised and restored.
    expect(columnTemplate(layout)).toBe("0px 0px 0px 0px minmax(0, 1fr)");
  });

  it("collapses every column when the bottom band is maximised", () => {
    const layout: PaneLayout = { ...DEFAULT_LAYOUT, maximized: "history" };
    expect(columnTemplate(layout)).toBe("0px 0px 0px 0px 0px");
  });
});
