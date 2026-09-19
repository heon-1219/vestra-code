import { describe, expect, it } from "vitest";

import {
  detailAt,
  itemAlphaFor,
  itemScreenRadius,
  labelFits,
  scaleForBudget,
  thresholdsFor,
  viewFraction,
  NAME_BUDGET,
  RELATION_BUDGET,
  type LodInput,
} from "./lod";

const CROWDED: LodInput = {
  linkCount: 700,
  itemCount: 300,
  mapArea: 1800 * 1800,
  viewWidth: 900,
  viewHeight: 700,
  fitScale: 0.39,
};

describe("scaleForBudget", () => {
  it("asks for no zoom at all when there is already little enough to show", () => {
    expect(scaleForBudget(10, 28, 1_000_000, 600_000)).toBe(0);
    expect(scaleForBudget(28, 28, 1_000_000, 600_000)).toBe(0);
  });

  it("lands exactly where the budget's worth is expected on screen", () => {
    const mapArea = 1800 * 1800;
    const screenArea = 900 * 700;
    const scale = scaleForBudget(700, RELATION_BUDGET, mapArea, screenArea);
    const expected = 700 * (screenArea / (scale * scale * mapArea));
    expect(expected).toBeCloseTo(RELATION_BUDGET, 6);
  });

  it("asks for more zoom the more there is to hide", () => {
    const a = scaleForBudget(200, 28, 1e6, 6e5);
    const b = scaleForBudget(2000, 28, 1e6, 6e5);
    expect(b).toBeGreaterThan(a);
  });

  it("does not divide by a map with no extent", () => {
    expect(Number.isFinite(scaleForBudget(700, 28, 0, 6e5))).toBe(true);
  });
});

describe("thresholdsFor", () => {
  it("never lets words appear before the line they sit on", () => {
    const wide = thresholdsFor({ ...CROWDED, linkCount: 4 });
    expect(wide.relationScale).toBeGreaterThanOrEqual(wide.linkScale);
    const dense = thresholdsFor(CROWDED);
    expect(dense.relationScale).toBeGreaterThanOrEqual(dense.linkScale);
  });

  it("holds names back until two packed neighbours have room for both", () => {
    // A project small enough that the budget alone would let every name
    // through at any zoom. The pitch between packed items is what stops it.
    const tiny = thresholdsFor({ ...CROWDED, itemCount: 8, mapArea: 200 * 200 });
    expect(tiny.nameScale).toBeGreaterThan(0);
  });

  it("makes a 300-item project earn its words and a small one not", () => {
    const dense = thresholdsFor(CROWDED);
    const small = thresholdsFor({
      linkCount: 121,
      itemCount: 68,
      mapArea: 800 * 600,
      viewWidth: 900,
      viewHeight: 700,
      fitScale: 1.12,
    });
    expect(dense.relationScale).toBeGreaterThan(dense.linkScale);
    // On the demo-sized graph the density threshold is already met by the time
    // the lines themselves are drawn, so words arrive with the lines.
    expect(small.relationScale).toBeCloseTo(small.linkScale, 6);
  });
});

describe("viewFraction", () => {
  it("is the whole map at the fitting zoom and shrinks as the square of the zoom", () => {
    const thresholds = thresholdsFor(CROWDED);
    expect(viewFraction(thresholds, 0.0001)).toBe(1);
    const one = viewFraction(thresholds, 2);
    const two = viewFraction(thresholds, 4);
    expect(two / one).toBeCloseTo(0.25, 6);
  });
});

describe("detailAt", () => {
  /**
   * The whole point of this module. Every threshold is a function of the zoom
   * and of the graph, and nothing may reach for where the camera happens to be
   * — otherwise panning towards a dense corner switches every label off at
   * once and panning back switches them on, at a zoom the user never touched.
   */
  it("is decided by the zoom alone", () => {
    const thresholds = thresholdsFor(CROWDED);
    const a = detailAt(thresholds, 2.4);
    const b = detailAt(thresholds, 2.4);
    expect(b).toEqual(a);
  });

  it("brings detail on in order: lines, then words, as the zoom grows", () => {
    const thresholds = thresholdsFor(CROWDED);
    expect(detailAt(thresholds, thresholds.linkScale * 0.5).links).toBe(0);
    expect(detailAt(thresholds, thresholds.linkScale * 0.5).relations).toBe(0);
    expect(detailAt(thresholds, thresholds.linkScale * 1.5).links).toBe(1);
    expect(detailAt(thresholds, thresholds.relationScale * 2).relations).toBe(1);
  });

  it("fades across the threshold rather than switching", () => {
    const thresholds = thresholdsFor(CROWDED);
    const mid = detailAt(thresholds, thresholds.relationScale).relations;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("lets more links be eligible for words the further in you go", () => {
    const thresholds = thresholdsFor(CROWDED);
    const near = detailAt(thresholds, 1).rankCeiling;
    const far = detailAt(thresholds, 4).rankCeiling;
    expect(far).toBeGreaterThan(near);
  });
});

describe("labelFits", () => {
  it("wants the words plus bare line on both sides", () => {
    expect(labelFits(60, 40, 7)).toBe(true);
    expect(labelFits(53, 40, 7)).toBe(false);
  });
});

describe("itemAlphaFor", () => {
  it("takes items away below about a screen pixel and never before", () => {
    expect(itemAlphaFor(4, 0.2)).toBe(0);
    expect(itemAlphaFor(4, 1)).toBe(1);
  });

  it("keeps the largest items longest, which is what leaves a map of places", () => {
    expect(itemAlphaFor(9, 0.2)).toBeGreaterThan(itemAlphaFor(3.4, 0.2));
  });
});

describe("itemScreenRadius", () => {
  it("never lets a dot become a hairline or a plate", () => {
    expect(itemScreenRadius(3.4, 0.01, false)).toBe(1.4);
    expect(itemScreenRadius(9, 200, false)).toBe(64);
  });

  it("draws a hub larger than its neighbours", () => {
    expect(itemScreenRadius(5, 2, true)).toBeGreaterThan(itemScreenRadius(5, 2, false));
  });
});

describe("the budgets themselves", () => {
  it("names more items than it names connections", () => {
    // A name sits at one point; a connection's words lie across a line and
    // collide with everything that line crosses.
    expect(NAME_BUDGET).toBeGreaterThan(RELATION_BUDGET);
  });
});
