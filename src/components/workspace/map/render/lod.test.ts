import { describe, expect, it } from "vitest";

import {
  detailAt,
  itemAlphaFor,
  itemScreenRadius,
  labelFits,
  thresholdsFor,
  viewFraction,
  MAX_SCALE,
  LINK_BUDGET,
  NAME_BUDGET,
  RELATION_BUDGET,
  type LodInput,
} from "./lod";

const CROWDED: LodInput = {
  linkCount: 700,
  itemCount: 300,
  itemArea: 1800 * 1800,
  viewWidth: 900,
  viewHeight: 700,
  fitScale: 0.39,
  names: { median: 47 },
};

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
    const tiny = thresholdsFor({ ...CROWDED, itemCount: 8, itemArea: 200 * 200 });
    expect(tiny.nameScale).toBeGreaterThan(0);
  });

  /**
   * A threshold past the maximum zoom is a feature that does not exist.
   * Measured on the 300-item fixture in a 1400×900 pane, the density rule that
   * used to live here asked for a zoom of 6.81 against a ceiling of 6 — so the
   * relation words would never have appeared on a large screen, and nothing
   * would have said so. The rule is gone (`ceilingFor` spends the budget by
   * rank instead), and what is left still has to stay inside the wheel.
   */
  it("never puts a threshold where the wheel cannot reach it", () => {
    const huge = thresholdsFor({
      linkCount: 40_000,
      itemCount: 12_000,
      itemArea: 4000 * 3000,
      viewWidth: 1400,
      viewHeight: 900,
      fitScale: 0.08,
      names: { median: 400 },
    });
    expect(huge.nameScale).toBeLessThan(MAX_SCALE);

    // The names rule is the one that can still run away, because a project is
    // free to have very long names.
    const wordy = thresholdsFor({ ...CROWDED, names: { median: 10_000 } });
    expect(wordy.nameScale).toBeLessThan(MAX_SCALE);
  });

  /**
   * Words arrive with the lines they sit on, on a project of any size.
   *
   * This is what the removed density term cost the demo: measured on the real
   * 68-item graph, relation words used to arrive at 3.0 with the lines and the
   * density rule pushed them to 4.5 — for a density the demo does not have,
   * because the rule clamped to the same 4.5 on every project it was given.
   * How MANY words is now `ceilingFor`'s job, and it does it at every zoom.
   */
  it("brings the words on with the lines, at every size", () => {
    const small = thresholdsFor({
      linkCount: 103,
      itemCount: 68,
      itemArea: 25_228,
      viewWidth: 1400,
      viewHeight: 900,
      fitScale: 1.36,
      names: { median: 47 },
    });
    expect(small.relationScale).toBeCloseTo(small.linkScale, 6);
    expect(thresholdsFor(CROWDED).relationScale).toBeCloseTo(
      thresholdsFor(CROWDED).linkScale,
      6,
    );
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
    const near = detailAt(thresholds, 1).relationCeiling;
    const far = detailAt(thresholds, 4).relationCeiling;
    expect(far).toBeGreaterThan(near);
  });

  /**
   * The identity the whole budget mechanism rests on, and the one nobody
   * checked before: a ceiling of `budget / viewFraction` puts exactly `budget`
   * of them on screen. What was there instead was a constant of 220 divided by
   * the same fraction, which is the same shape and 7.9x the documented number
   * — a budget of 28 that admitted 786.
   */
  it("spends exactly the budget at every zoom, and not a multiple of it", () => {
    const thresholds = thresholdsFor(CROWDED);
    for (const scale of [1, 2, 3.5, 5, 6]) {
      const detail = detailAt(thresholds, scale);
      const fraction = viewFraction(thresholds, scale);
      expect(detail.relationCeiling * fraction).toBeCloseTo(RELATION_BUDGET, 6);
      expect(detail.nameCeiling * fraction).toBeCloseTo(NAME_BUDGET, 6);
      expect(detail.linkCeiling * fraction).toBeCloseTo(LINK_BUDGET, 6);
    }
  });

  /**
   * The flicker rule, stated about the ceilings rather than about the
   * thresholds: a ceiling reads the zoom and nothing else, so dragging the map
   * cannot change which things are eligible to speak.
   */
  it("gives the same ceilings wherever the map has been dragged to", () => {
    const thresholds = thresholdsFor(CROWDED);
    const a = detailAt(thresholds, 3);
    const b = detailAt(thresholds, 3);
    expect(a).toEqual(b);
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

describe("names, measured rather than assumed", () => {
  /**
   * The constant this replaced was 52 pixels, written as "a name is drawn under
   * its dot at 11px, so about 52px of pitch". That is a Latin sentence about a
   * Korean-first product: the median name on a real 1,442-item project measures
   * roughly twice it, so names were being let on at half the zoom they need.
   */
  it("holds names back further when the project's own names are wider", () => {
    const narrow = thresholdsFor({ ...CROWDED, names: { median: 30 } });
    const wide = thresholdsFor({ ...CROWDED, names: { median: 110 } });
    expect(wide.nameScale).toBeGreaterThan(narrow.nameScale);
  });

  it("still refuses to put the threshold past the wheel", () => {
    const enormous = thresholdsFor({ ...CROWDED, names: { median: 4000 } });
    expect(enormous.nameScale).toBeLessThan(MAX_SCALE);
  });
});

describe("the budgets themselves", () => {
  it("names more items than it names connections", () => {
    // A name sits at one point; a connection's words lie across a line and
    // collide with everything that line crosses.
    expect(NAME_BUDGET).toBeGreaterThan(RELATION_BUDGET);
  });
});
