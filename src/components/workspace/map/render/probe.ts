import type { MapLayout } from "../layout";

import { itemAlphaFor, itemScreenRadius, HUB_BOOST } from "./lod";
import type { Camera } from "./paint";

/**
 * An instrument for counting what a frame actually put on screen.
 *
 * ## Why this is a module and not a few lines in a test
 *
 * The founder's ask was "겹침 x" — things must not overlap — and "요소 많은데
 * 어떻게 너무 난잡하게 안보일지". Neither is a thing you can check by looking at a
 * 1,442-item map: at that size every judgement about crowding made by eye is a
 * judgement about the one part of the picture you happened to look at. They are
 * however both exactly countable, and `lod.ts` already carries the scar that
 * proves counting is not optional — a threshold of 6.81 against a ceiling of 6,
 * a feature that could never fire, invisible to looking and obvious to
 * arithmetic.
 *
 * So the renderer gets an instrument. It records the real `drawMap` call
 * against a stand-in context and then answers four questions with numbers:
 * how many pairs of words are lying on each other, how many words are lying on
 * a dot, how many dots are lying on each other, and how many lines cross.
 *
 * ## What it is not
 *
 * It is not a canvas. It implements exactly the part of the 2D context this
 * renderer uses, and anything else would be fiction — the same reasoning
 * `paint.test.ts` gives for its own recorder, which this replaces and widens.
 * If the painter reaches for something not here, it throws in a test rather
 * than drawing something wrong on a screen.
 */

/** A rectangle of text, as four corners in screen space. It may be rotated. */
export type TextBox = {
  text: string;
  /** Centre of the box. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  /** Which pass drew it: a name under a dot, a word on a line, a district's name. */
  kind: "name" | "relation" | "district";
};

export type Segment = { x0: number; y0: number; x1: number; y1: number };

/**
 * How wide a string is at a given size, Korean included.
 *
 * The existing recorder in `paint.test.ts` answers six pixels per character
 * whatever the character is, which is close enough for "does this fit" on a
 * Latin fixture and **halves every Korean measurement** — a Hangul syllable is
 * a full em where a Latin lowercase letter is about half of one. Measuring a
 * Korean-first map with a Latin ruler would under-count every collision in this
 * file by roughly a factor of two, which is the difference between "the map is
 * crowded" and "the map is fine".
 *
 * The factors are ems, read off Pretendard's own metrics at 11px. They do not
 * have to be exact: they have to be right about the ratio between a syllable
 * and a letter, which is what every count here turns on.
 */
export function measureTextWidth(text: string, size: number): number {
  let ems = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xac00 && code <= 0xd7a3) ems += 1; // 가 — a composed syllable
    else if (code >= 0x3130 && code <= 0x318f) ems += 1; // ㄱ — a bare jamo
    else if (code >= 0x4e00 && code <= 0x9fff) ems += 1; // 漢
    else if (character === " ") ems += 0.26;
    else if (character === "·") ems += 0.34;
    else if (code >= 0x30 && code <= 0x39) ems += 0.56; // 0-9
    else if (code >= 0x41 && code <= 0x5a) ems += 0.64; // A-Z
    else if (code >= 0x61 && code <= 0x7a) ems += 0.52; // a-z
    else ems += 0.34; // / . - _ and the rest of the ASCII furniture
  }
  return ems * size;
}

function sizeOf(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number(match[1]) : 11;
}

/**
 * The stand-in context.
 *
 * Tracks the transform by hand — `translate` and `rotate` are the only two the
 * painter uses, and only around a relation's words — so every recorded box is
 * already in screen space and the caller never has to undo a rotation.
 */
export class Probe {
  fillStyle: string | CanvasGradient = "";
  strokeStyle: string | CanvasGradient = "";
  lineWidth = 1;
  lineCap = "butt";
  font = "11px sans-serif";
  textAlign = "left";
  textBaseline = "alphabetic";
  shadowColor = "";
  shadowBlur = 0;
  letterSpacing = "0px";

  readonly texts: TextBox[] = [];
  /** Straight one- and two-segment stroked paths: the links and the roads. */
  readonly lines: Segment[] = [];
  strokes = 0;
  fills = 0;
  /** Every `arc` the painter asked for, which is every dot, ring and hub mark. */
  arcs = 0;

  private tx = 0;
  private ty = 0;
  private rot = 0;
  private stack: { tx: number; ty: number; rot: number }[] = [];
  private path: { points: [number, number][]; curved: boolean }[] = [];
  private current: { points: [number, number][]; curved: boolean } | null = null;

  setTransform(): void {}
  fillRect(): void {}

  beginPath(): void {
    this.path = [];
    this.current = null;
  }
  moveTo(x: number, y: number): void {
    this.current = { points: [[x, y]], curved: false };
    this.path.push(this.current);
  }
  lineTo(x: number, y: number): void {
    if (!this.current) this.moveTo(x, y);
    else this.current.points.push([x, y]);
  }
  quadraticCurveTo(_cx: number, _cy: number, x: number, y: number): void {
    if (!this.current) this.moveTo(x, y);
    else {
      this.current.points.push([x, y]);
      this.current.curved = true;
    }
  }
  closePath(): void {
    this.current = null;
  }
  arc(): void {
    this.arcs++;
    this.current = null;
  }
  fill(): void {
    this.fills++;
  }

  /**
   * A stroke is recorded as a line only when it is one.
   *
   * A district's coastline is twenty-seven curved segments, a hatch ladder is
   * dozens of two-pixel ticks, an arrowhead is a closed triangle. None of those
   * is a connection, and counting them as crossings would bury the number this
   * file exists to produce. What is left — one or two straight runs of real
   * length — is exactly a link's thread, a guessed link's spine, or a road.
   */
  stroke(): void {
    this.strokes++;
    for (const run of this.path) {
      if (run.curved) continue;
      if (run.points.length < 2 || run.points.length > 3) continue;
      for (let i = 0; i + 1 < run.points.length; i++) {
        const [x0, y0] = run.points[i];
        const [x1, y1] = run.points[i + 1];
        if (Math.hypot(x1 - x0, y1 - y0) < 12) continue;
        this.lines.push({ x0, y0, x1, y1 });
      }
    }
  }

  createRadialGradient(): { addColorStop: () => void } {
    return { addColorStop: () => {} };
  }

  measureText(text: string): { width: number } {
    return { width: measureTextWidth(text, sizeOf(this.font)) };
  }

  save(): void {
    this.stack.push({ tx: this.tx, ty: this.ty, rot: this.rot });
  }
  restore(): void {
    const previous = this.stack.pop();
    if (previous) {
      this.tx = previous.tx;
      this.ty = previous.ty;
      this.rot = previous.rot;
    }
  }
  translate(x: number, y: number): void {
    const cos = Math.cos(this.rot);
    const sin = Math.sin(this.rot);
    this.tx += x * cos - y * sin;
    this.ty += x * sin + y * cos;
  }
  rotate(angle: number): void {
    this.rot += angle;
  }

  fillText(text: string, x: number, y: number): void {
    const size = sizeOf(this.font);
    const width = measureTextWidth(text, size);
    // Cap height plus a little, which is what a reader sees as the word's box.
    const height = size * 1.18;

    // Where the anchor sits inside the box, in the text's own frame.
    const dx =
      this.textAlign === "center" ? 0 : this.textAlign === "right" ? -width / 2 : width / 2;
    const dy =
      this.textBaseline === "top"
        ? height / 2
        : this.textBaseline === "middle"
          ? 0
          : -height * 0.32; // alphabetic

    const cos = Math.cos(this.rot);
    const sin = Math.sin(this.rot);
    const lx = x + dx;
    const ly = y + dy;
    this.texts.push({
      text,
      cx: this.tx + lx * cos - ly * sin,
      cy: this.ty + lx * sin + ly * cos,
      width,
      height,
      angle: this.rot,
      // The three passes are told apart by the baseline they use, which is the
      // one thing the painter sets differently for each and never varies.
      kind:
        this.textBaseline === "middle"
          ? "relation"
          : this.textBaseline === "top"
            ? "name"
            : "district",
    });
  }
}

export function asContext(probe: Probe): CanvasRenderingContext2D {
  return probe as unknown as CanvasRenderingContext2D;
}

/* ------------------------------------------------------------------ *
 * The geometry the counts rest on.
 * ------------------------------------------------------------------ */

type Corners = readonly [number, number][];

function cornersOf(box: TextBox): Corners {
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  const hw = box.width / 2;
  const hh = box.height / 2;
  return [
    [box.cx + (-hw * cos - -hh * sin), box.cy + (-hw * sin + -hh * cos)],
    [box.cx + (hw * cos - -hh * sin), box.cy + (hw * sin + -hh * cos)],
    [box.cx + (hw * cos - hh * sin), box.cy + (hw * sin + hh * cos)],
    [box.cx + (-hw * cos - hh * sin), box.cy + (-hw * sin + hh * cos)],
  ];
}

/** Separating axis test for two oriented rectangles. */
export function boxesOverlap(a: TextBox, b: TextBox): boolean {
  const ca = cornersOf(a);
  const cb = cornersOf(b);
  for (const corners of [ca, cb]) {
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = corners[i];
      const [x1, y1] = corners[(i + 1) % 4];
      const ax = -(y1 - y0);
      const ay = x1 - x0;
      const length = Math.hypot(ax, ay);
      if (length === 0) continue;
      const nx = ax / length;
      const ny = ay / length;
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const [px, py] of ca) {
        const projection = px * nx + py * ny;
        minA = Math.min(minA, projection);
        maxA = Math.max(maxA, projection);
      }
      for (const [px, py] of cb) {
        const projection = px * nx + py * ny;
        minB = Math.min(minB, projection);
        maxB = Math.max(maxB, projection);
      }
      if (maxA <= minB || maxB <= minA) return false;
    }
  }
  return true;
}

/** A circle against an oriented rectangle: the closest point test, in the box's frame. */
export function circleTouchesBox(
  cx: number,
  cy: number,
  r: number,
  box: TextBox,
): boolean {
  const cos = Math.cos(-box.angle);
  const sin = Math.sin(-box.angle);
  const dx = cx - box.cx;
  const dy = cy - box.cy;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const hw = box.width / 2;
  const hh = box.height / 2;
  const nearestX = Math.max(-hw, Math.min(hw, lx));
  const nearestY = Math.max(-hh, Math.min(hh, ly));
  return Math.hypot(lx - nearestX, ly - nearestY) < r;
}

function segmentsCross(a: Segment, b: Segment): boolean {
  const d1x = a.x1 - a.x0;
  const d1y = a.y1 - a.y0;
  const d2x = b.x1 - b.x0;
  const d2y = b.y1 - b.y0;
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-9) return false;
  const ex = b.x0 - a.x0;
  const ey = b.y0 - a.y0;
  const t = (ex * d2y - ey * d2x) / denominator;
  const u = (ex * d1y - ey * d1x) / denominator;
  // Strictly inside both, so two lines meeting at a shared dot are not a
  // crossing — they are the same item, drawn once.
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}

function segmentTouchesBox(segment: Segment, box: TextBox): boolean {
  const cos = Math.cos(-box.angle);
  const sin = Math.sin(-box.angle);
  const to = (x: number, y: number): [number, number] => {
    const dx = x - box.cx;
    const dy = y - box.cy;
    return [dx * cos - dy * sin, dx * sin + dy * cos];
  };
  const [x0, y0] = to(segment.x0, segment.y0);
  const [x1, y1] = to(segment.x1, segment.y1);
  const hw = box.width / 2;
  const hh = box.height / 2;

  // Liang–Barsky against the box, in the box's own frame.
  let from = 0;
  let to1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > to1) return false;
      if (r > from) from = r;
    } else {
      if (r < from) return false;
      if (r < to1) to1 = r;
    }
    return true;
  };
  if (!clip(-dx, x0 + hw)) return false;
  if (!clip(dx, hw - x0)) return false;
  if (!clip(-dy, y0 + hh)) return false;
  if (!clip(dy, hh - y0)) return false;
  return to1 > from;
}

/** Every item the frame actually drew, as a screen circle. */
export function drawnCircles(
  layout: MapLayout,
  hubs: ReadonlyMap<string, string>,
  camera: Camera,
  width: number,
  height: number,
): { id: string; x: number; y: number; r: number }[] {
  const out: { id: string; x: number; y: number; r: number }[] = [];
  for (const placed of layout.items) {
    const hub = hubs.get(placed.districtId) === placed.id;
    if (itemAlphaFor(placed.r * (hub ? HUB_BOOST : 1), camera.scale) <= 0.02) continue;
    const x = (placed.x - camera.x) * camera.scale + width / 2;
    const y = (placed.y - camera.y) * camera.scale + height / 2;
    const r = itemScreenRadius(placed.r, camera.scale, hub);
    if (x + r < 0 || x - r > width || y + r < 0 || y - r > height) continue;
    out.push({ id: placed.id, x, y, r });
  }
  return out;
}

export type Crowding = {
  /** Pairs of words lying on each other. The one that must be zero. */
  labelLabel: number;
  /** Words lying on a dot that is not the one they name. */
  labelItem: number;
  /** Dots lying on each other. */
  itemItem: number;
  /** Lines crossing lines. */
  linkCrossings: number;
  /** Lines running under an item's name, which carries a halo to survive it. */
  linksUnderNames: number;
  /**
   * Lines running under a word on a line, which must be zero: the stroke is cut
   * for exactly the width of its own words, and no other line may cross there.
   */
  linksUnderRelations: number;
  /** How many words the frame drew, by pass. */
  names: number;
  relations: number;
  districts: number;
  /** How many dots the frame drew. */
  items: number;
  /** How many lines the frame drew inside the window. */
  links: number;
  /** Everything the painter asked for, on screen or not. Waste shows up here. */
  drawnWords: number;
  drawnLines: number;
};

/**
 * Count everything, from one recorded frame.
 *
 * Quadratic in the number of labels and lines on purpose: this runs in a test,
 * never in a frame, and an approximation would be the thing that let a
 * regression through. A screenful holds tens of labels, and the link count is
 * capped by the painter, so the worst case here is small enough to be exact.
 */
export function crowdingOf(
  probe: Probe,
  circles: readonly { id: string; x: number; y: number; r: number }[],
  width: number,
  height: number,
): Crowding {
  /*
   * Only what is inside the window counts.
   *
   * A line between two items can be thousands of pixels long at a deep zoom
   * with a dozen of them on screen; where it crosses another such line out in
   * the dark is not a crossing anybody sees, and counting it would drown the
   * numbers this file exists to produce in geometry nobody is looking at. The
   * renderer is separately expected not to *draw* any of that, and `drawnWords`
   * below still reports everything it asked for, so the waste stays visible
   * rather than being filtered out of sight.
   */
  const inside = (minX: number, minY: number, maxX: number, maxY: number) =>
    maxX >= 0 && minX <= width && maxY >= 0 && minY <= height;

  const words = probe.texts.filter((box) => {
    const cos = Math.abs(Math.cos(box.angle));
    const sin = Math.abs(Math.sin(box.angle));
    const hw = (box.width * cos + box.height * sin) / 2;
    const hh = (box.width * sin + box.height * cos) / 2;
    return inside(box.cx - hw, box.cy - hh, box.cx + hw, box.cy + hh);
  });
  const lines = probe.lines.filter((line) =>
    inside(
      Math.min(line.x0, line.x1),
      Math.min(line.y0, line.y1),
      Math.max(line.x0, line.x1),
      Math.max(line.y0, line.y1),
    ),
  );

  let labelLabel = 0;
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      // A district's name sits over its own territory by design — the items
      // are packed into the lower part of it precisely so the name has the top
      // to itself — and it is drawn with a halo in the surface colour that
      // punches through whatever is under it. It is still counted against the
      // other two passes; two district names on each other would be a real
      // fault and is what this pair test is for.
      if (boxesOverlap(words[i], words[j])) labelLabel++;
    }
  }

  let labelItem = 0;
  for (const box of words) {
    if (box.kind === "district") continue;
    for (const circle of circles) {
      if (circleTouchesBox(circle.x, circle.y, circle.r, box)) labelItem++;
    }
  }

  let itemItem = 0;
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i];
      const b = circles[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) itemItem++;
    }
  }

  let linkCrossings = 0;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (segmentsCross(lines[i], lines[j])) linkCrossings++;
    }
  }

  let linksUnderNames = 0;
  let linksUnderRelations = 0;
  for (const box of words) {
    if (box.kind === "district") continue;
    for (const line of lines) {
      if (!segmentTouchesBox(line, box)) continue;
      if (box.kind === "name") linksUnderNames++;
      else linksUnderRelations++;
    }
  }

  return {
    labelLabel,
    labelItem,
    itemItem,
    linkCrossings,
    linksUnderNames,
    linksUnderRelations,
    names: words.filter((one) => one.kind === "name").length,
    relations: words.filter((one) => one.kind === "relation").length,
    districts: words.filter((one) => one.kind === "district").length,
    items: circles.length,
    links: lines.length,
    drawnWords: probe.texts.length,
    drawnLines: probe.lines.length,
  };
}

/** The viewports the map is actually read in. 375 is a phone, and it is the hard one. */
export const VIEWPORTS: readonly { name: string; width: number; height: number }[] = [
  { name: "phone 375", width: 375, height: 640 },
  { name: "pane 900", width: 900, height: 720 },
  { name: "wide 1400", width: 1400, height: 900 },
];
