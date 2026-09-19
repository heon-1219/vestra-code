import { describe, expect, it } from "vitest";

import {
  arrowAt,
  hatchStart,
  labelAnchor,
  onScreen,
  shifted,
  smoothstep,
  spanBetween,
  visibleRange,
} from "./geometry";

const HALF_PI = Math.PI / 2;

describe("smoothstep", () => {
  it("is flat outside its band and level in the middle", () => {
    expect(smoothstep(1, 2, 0.5)).toBe(0);
    expect(smoothstep(1, 2, 3)).toBe(1);
    expect(smoothstep(1, 2, 1.5)).toBeCloseTo(0.5, 6);
  });

  it("does not divide by zero when the band has no width", () => {
    expect(smoothstep(2, 2, 1)).toBe(0);
    expect(smoothstep(2, 2, 2)).toBe(1);
  });
});

describe("spanBetween", () => {
  it("starts and ends at the rims rather than at the centres", () => {
    const span = spanBetween(0, 0, 100, 0, 10, 20, 5);
    expect(span).not.toBeNull();
    expect(span?.x0).toBeCloseTo(10, 6);
    expect(span?.x1).toBeCloseTo(80, 6);
    expect(span?.length).toBeCloseTo(70, 6);
    expect(span?.ux).toBeCloseTo(1, 6);
  });

  it("refuses a line with nothing left between two touching dots", () => {
    expect(spanBetween(0, 0, 30, 0, 14, 14, 9)).toBeNull();
    expect(spanBetween(5, 5, 5, 5, 0, 0, 0)).toBeNull();
  });
});

describe("shifted", () => {
  it("moves a line sideways without changing its direction or length", () => {
    const span = spanBetween(0, 0, 100, 0, 0, 0, 0);
    expect(span).not.toBeNull();
    if (!span) return;
    const lane = shifted(span, 4);
    expect(lane.y0).toBeCloseTo(4, 6);
    expect(lane.y1).toBeCloseTo(4, 6);
    expect(lane.length).toBe(span.length);
    expect(lane.ux).toBe(span.ux);
  });
});

describe("arrowAt", () => {
  it("puts the point at the far end and the base a fixed distance behind it", () => {
    const span = spanBetween(0, 0, 100, 0, 0, 0, 0);
    expect(span).not.toBeNull();
    if (!span) return;
    const arrow = arrowAt(span, 8, 3);
    expect(arrow.tipX).toBeCloseTo(100, 6);
    expect(arrow.leftX).toBeCloseTo(92, 6);
    expect(Math.abs(arrow.leftY - arrow.rightY)).toBeCloseTo(6, 6);
  });
});

describe("labelAnchor", () => {
  /**
   * The one thing that must never happen: words printed upside down. A line
   * running right to left has an angle beyond a quarter turn, and text laid
   * along it reads backwards and inverted — unreadable, not merely untidy.
   */
  it("never leaves the words more than a quarter turn from level", () => {
    for (let degrees = 0; degrees < 360; degrees += 7) {
      const radians = (degrees * Math.PI) / 180;
      const span = spanBetween(
        0,
        0,
        Math.cos(radians) * 100,
        Math.sin(radians) * 100,
        0,
        0,
        0,
      );
      expect(span).not.toBeNull();
      if (!span) continue;
      const anchor = labelAnchor(span);
      expect(anchor.angle).toBeGreaterThanOrEqual(-HALF_PI - 1e-9);
      expect(anchor.angle).toBeLessThanOrEqual(HALF_PI + 1e-9);
    }
  });

  it("sits at the midpoint of the drawn line, not of the two items", () => {
    const span = spanBetween(0, 0, 100, 0, 20, 0, 0);
    expect(span).not.toBeNull();
    if (!span) return;
    expect(labelAnchor(span).x).toBeCloseTo(60, 6);
  });
});

describe("visibleRange", () => {
  const span = (ax: number, ay: number, bx: number, by: number) => {
    const made = spanBetween(ax, ay, bx, by, 0, 0, 0);
    if (!made) throw new Error("the test fixture itself is wrong");
    return made;
  };

  it("keeps a line that is entirely inside", () => {
    const range = visibleRange(span(10, 10, 90, 90), 100, 100, 0);
    expect(range?.from).toBeCloseTo(0, 6);
    expect(range?.to).toBeCloseTo(Math.hypot(80, 80), 6);
  });

  /**
   * The case that costs: a road between two territories either side of the
   * window. Both ends are off screen, so no bounding box test would keep it,
   * and it crosses the whole view.
   */
  it("finds the crossing part of a line whose two ends are both outside", () => {
    const range = visibleRange(span(-500, 50, 600, 50), 100, 100, 0);
    expect(range).not.toBeNull();
    expect(range?.from).toBeCloseTo(500, 6);
    expect(range?.to).toBeCloseTo(600, 6);
  });

  it("drops a line that misses the window entirely", () => {
    expect(visibleRange(span(-500, -500, -400, -450), 100, 100, 0)).toBeNull();
    expect(visibleRange(span(200, 0, 200, 100), 100, 100, 0)).toBeNull();
  });

  it("keeps a line running just outside an edge when the slack allows it", () => {
    expect(visibleRange(span(-10, 20, -10, 80), 100, 100, 0)).toBeNull();
    expect(visibleRange(span(-10, 20, -10, 80), 100, 100, 20)).not.toBeNull();
  });
});

describe("hatchStart", () => {
  /**
   * Clipping must not re-phase the ladder. If the first tick were drawn at
   * wherever the window happens to cut the line, the texture would crawl under
   * the hand as the map is dragged — a moving pattern on a static picture,
   * which is far more distracting than the cost it was meant to save.
   */
  it("snaps back to the line's own grid, so the ticks never move as you pan", () => {
    expect(hatchStart(0, 5)).toBe(0);
    expect(hatchStart(12, 5)).toBe(10);
    expect(hatchStart(15, 5)).toBe(15);
    expect(hatchStart(-3, 5)).toBe(0);
  });
});

describe("onScreen", () => {
  it("keeps anything touching the frame and drops what is fully outside", () => {
    expect(onScreen(-10, -10, 5, 5, 100, 100, 0)).toBe(true);
    expect(onScreen(-40, 10, -20, 30, 100, 100, 0)).toBe(false);
    expect(onScreen(-40, 10, -20, 30, 100, 100, 25)).toBe(true);
  });
});
