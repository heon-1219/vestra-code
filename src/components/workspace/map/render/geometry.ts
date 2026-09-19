/**
 * The arithmetic behind every line the map draws.
 *
 * Separated from the painting for one reason: **every number here is in screen
 * pixels, and that is the guarantee the whole renderer rests on.** The canvas
 * context never carries a transform (see the header of `district-map.tsx`), so
 * an arrowhead is 7px at every zoom, a hatch tick is 5px at every zoom, and the
 * gap cut in a line to make room for its words is exactly as wide as the words.
 * Put any of this in world units and it would look right at one zoom and be a
 * lie at every other — which for the hatch is not a style problem but the
 * honesty encoding failing silently (UI_DIRECTION section 5, warning 1).
 *
 * Pure: numbers in, numbers out, no canvas, no clock.
 */

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** A line between two items, already cut back to their rims. */
export type Span = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Unit vector from the start towards the end. */
  ux: number;
  uy: number;
  /** How long the cut-back line is, in screen pixels. */
  length: number;
};

/**
 * The part of a line between two items that is actually drawn.
 *
 * Both ends are pulled back to the rim of the dot they touch, because a line
 * that runs under a filled circle and out the other side reads as a line
 * *crossing* the item rather than *arriving at* it — and an arrowhead buried
 * under the thing it points at says nothing at all. Returns null when there is
 * nothing left worth drawing, which is the common case for two items packed
 * next to each other at a wide zoom.
 */
export function spanBetween(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  startTrim: number,
  endTrim: number,
  minLength: number,
): Span | null {
  const dx = bx - ax;
  const dy = by - ay;
  const raw = Math.hypot(dx, dy);
  if (raw <= 0.001) return null;
  const ux = dx / raw;
  const uy = dy / raw;
  const length = raw - startTrim - endTrim;
  if (length < minLength) return null;
  return {
    x0: ax + ux * startTrim,
    y0: ay + uy * startTrim,
    x1: bx - ux * endTrim,
    y1: by - uy * endTrim,
    ux,
    uy,
    length,
  };
}

/** Shift a span sideways, so two links between the same pair do not sit on top of each other. */
export function shifted(span: Span, offset: number): Span {
  if (offset === 0) return span;
  const px = -span.uy * offset;
  const py = span.ux * offset;
  return {
    ...span,
    x0: span.x0 + px,
    y0: span.y0 + py,
    x1: span.x1 + px,
    y1: span.y1 + py,
  };
}

export type Arrow = {
  tipX: number;
  tipY: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
};

/**
 * The three points of the arrowhead at the far end.
 *
 * The direction IS the meaning of a connection — "A uses B" and "B uses A" are
 * different facts about someone's code — so this is drawn as a filled triangle
 * rather than as two strokes: a stroked chevron at 1px disappears at the zoom
 * where a whole project fits on screen, which is the same failure mode the
 * dashed-line encoding was rejected for.
 */
export function arrowAt(span: Span, length: number, halfWidth: number): Arrow {
  const backX = span.x1 - span.ux * length;
  const backY = span.y1 - span.uy * length;
  const px = -span.uy * halfWidth;
  const py = span.ux * halfWidth;
  return {
    tipX: span.x1,
    tipY: span.y1,
    leftX: backX + px,
    leftY: backY + py,
    rightX: backX - px,
    rightY: backY - py,
  };
}

export type LabelAnchor = {
  x: number;
  y: number;
  /** Radians to rotate the words by. Always within a quarter turn of level. */
  angle: number;
};

/**
 * Where a link's words sit, and which way up they go.
 *
 * The midpoint, turned to lie along the line — and then flipped a half turn
 * whenever the line runs right to left, because text following a
 * right-to-left arrow is upside down and simply cannot be read. Flipping the
 * words does not flip the arrowhead, so the sentence still reads in the
 * direction the arrow points; it is the reading order of the two item names
 * either side that reverses, and those are drawn the same way up regardless.
 */
export function labelAnchor(span: Span): LabelAnchor {
  // `atan2` answers in (-π, π], so a half turn is subtracted above the quarter
  // turn and added below it. Adding it in both directions is the bug this
  // comment is here to stop coming back: for an angle just past +π/2 that lands
  // at about 4.7 radians, which is three quarters of a turn the wrong way and
  // draws the words down the side of the screen.
  const angle = Math.atan2(span.uy, span.ux);
  const half = Math.PI / 2;
  const upright = angle > half ? angle - Math.PI : angle < -half ? angle + Math.PI : angle;
  return {
    x: (span.x0 + span.x1) / 2,
    y: (span.y0 + span.y1) / 2,
    angle: upright,
  };
}

/**
 * The part of a line that is actually on screen, as a range along it.
 *
 * Liang–Barsky, and it is here for a measured reason rather than for tidiness.
 * A hatched line is a ladder of ticks at a fixed pitch in screen pixels, so the
 * number of ticks is the line's SCREEN length divided by five — and screen
 * length grows with the zoom without limit. On a 300-item project at six times
 * the fitting zoom, the roads between territories are several thousand pixels
 * long and almost entirely outside the window: measured at **53,000 tick
 * segments a frame, essentially all of them off screen**, which took a repaint
 * from 1ms to a median of 13ms with multi-second stalls behind it. Clipping the
 * range first makes the cost of a hatch depend on how much of it you can see,
 * which is the only thing it should ever have depended on.
 *
 * Returns null when the line misses the window entirely.
 */
export function visibleRange(
  span: Span,
  width: number,
  height: number,
  slack: number,
): { from: number; to: number } | null {
  let from = 0;
  let to = span.length;

  // The standard four half-plane tests. `p` is the rate at which the line
  // approaches an edge and `q` how far outside it starts; `p === 0` is a line
  // running parallel to that edge, which is either wholly inside it or wholly
  // out and has no crossing to compute.
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > to) return false;
      if (r > from) from = r;
    } else {
      if (r < from) return false;
      if (r < to) to = r;
    }
    return true;
  };

  if (!clip(-span.ux, span.x0 + slack)) return null;
  if (!clip(span.ux, width + slack - span.x0)) return null;
  if (!clip(-span.uy, span.y0 + slack)) return null;
  if (!clip(span.uy, height + slack - span.y0)) return null;
  if (to < from) return null;
  return { from, to };
}

/**
 * Where a hatch starts, snapped back to the pitch grid the whole line is on.
 *
 * The ticks have to stay at fixed multiples of the pitch measured from the
 * line's own start, not from wherever the window happens to cut it — otherwise
 * clipping would re-phase the ladder as the map is dragged and the texture
 * would crawl under the hand. Snapping backwards also guarantees the first
 * drawn tick is at or before the edge, so no gap opens at the window's rim.
 */
export function hatchStart(from: number, pitch: number): number {
  return Math.max(0, Math.floor(from / pitch) * pitch);
}

/**
 * True when a rectangle touches the screen at all.
 *
 * Culling is done per primitive rather than by clipping, because the cheapest
 * pixel is the one never handed to the rasteriser — measured at roughly half
 * the frame time on a 300-item project once the camera is inside one district.
 */
export function onScreen(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  width: number,
  height: number,
  slack: number,
): boolean {
  return (
    maxX >= -slack && minX <= width + slack && maxY >= -slack && minY <= height + slack
  );
}
