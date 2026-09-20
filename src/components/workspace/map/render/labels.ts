import { boundsOfBox, boxesOverlap, type OrientedBox } from "./geometry";

/**
 * Where every word on the map is allowed to go.
 *
 * ## The rule, in one line
 *
 * **A label drawn over another label is worse than no label.** Two Korean words
 * on top of each other are not two facts a reader can recover; they are one
 * smear that says neither, and on a map read by someone who cannot read code
 * they are worse than a blank space, because a blank space is honest.
 *
 * So every word is offered a short, fixed list of places it could sit, takes
 * the first one that is clear, and is **dropped** if none of them is. What is
 * dropped is counted and said out loud by the map — the same promise
 * `neighbourhood.ts` keeps when it prints "N개는 줄였어요". A map that quietly
 * omits is a map that lies.
 *
 * ## Why this is not a budget, and why the budgets are not this
 *
 * `lod.ts` decides *how many* words the map may say at a zoom, from the zoom
 * alone, so that the answer cannot change while you pan. This file decides
 * *whether two particular words collide*, which is geometry and depends on
 * exactly where the camera is. They are different questions and they need each
 * other: without the budgets this field would be handed a thousand names and
 * drop nine hundred of them, which is a worse picture and a frightening
 * sentence; without the field the budgets would let thirty-six names land in a
 * heap inside one territory.
 *
 * ## Determinism
 *
 * The answer depends only on the boxes offered and the order they are offered
 * in. Both come from fixed ranks (`nameRanks`, `MapLink.rank`) rather than from
 * draw order or from a set's iteration order, so the same graph at the same
 * camera places the same labels in the same spots on every render — which is
 * the promise `layout.ts` makes and this had to keep.
 *
 * ## What it costs
 *
 * A uniform grid, bucketed on the upright bounds of each box. Blocking a dot is
 * one insert; placing a label is a handful of cells' worth of exact tests. The
 * work is bounded by the number of things offered, and both budgets bound that
 * — which is why the frame cost of the whole mechanism is a rounding error
 * beside the text drawing it prevents.
 */

/**
 * What a box is, for the purpose of deciding what may sit on what.
 *
 * `dot` is an item's circle. It is blocked so a name does not land on a
 * neighbouring item, and a name is allowed to sit under **its own** dot, which
 * is why the owner is excluded rather than the class.
 */
export type LabelClass = "dot" | "line" | "district" | "name" | "relation";

/**
 * A line, as a very flat box, so a word can be asked to stay off one.
 *
 * Only words on lines avoid these, and only the lines that are not their own —
 * which is what `owner` is for. An item's **name** does not: a name sits in a
 * crowd of lines radiating from its own dot, so avoiding them would drop nearly
 * every name in a busy territory, and a name carries a halo in the surface
 * colour that cuts whatever runs under it. A word on a line has no halo — the
 * line is cut for it instead, and that cut only opens its own line.
 */
export function lineBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness = 3,
): OrientedBox {
  return {
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    width: Math.hypot(x1 - x0, y1 - y0),
    height: thickness,
    angle: Math.atan2(y1 - y0, x1 - x0),
  };
}

/** Screen pixels per grid cell. About one long Korean label wide. */
const CELL = 56;

type Held = {
  box: OrientedBox;
  kind: LabelClass;
  owner: string | null;
  /**
   * Which query last looked at this box.
   *
   * A box sits in every cell it touches, so one query meets the same box
   * several times and has to skip the repeats. A `Set` per query is the obvious
   * way and it allocates one per candidate position — at a deep zoom that is
   * two and a half thousand short-lived sets a frame, under a dragging hand.
   * A stamp does the same job with a number compare.
   */
  mark: number;
};

export class LabelField {
  private readonly cells = new Map<number, Held[]>();
  private readonly cols: number;
  private readonly rows: number;
  private readonly width: number;
  private readonly height: number;
  /** Stamps each query, so one box met twice is skipped without a set. */
  private queries = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cols = Math.max(1, Math.ceil(width / CELL));
    this.rows = Math.max(1, Math.ceil(height / CELL));
  }

  /**
   * Whether any of this box would be on screen.
   *
   * It matters more than it sounds. At a deep zoom a line between two items can
   * be thousands of pixels long with a dozen of them inside the window, and its
   * word sits at the middle: measured on a 1,442-item project, **512 relation
   * words a frame were being laid out beyond the edge of the canvas**, costing
   * a text measurement and a fill each, and visible to nobody. A candidate that
   * lands off screen is refused here, which sends the word on to its next
   * candidate along the same line and usually finds it one that can be read.
   */
  visible(box: OrientedBox): boolean {
    const bounds = boundsOfBox(box);
    return (
      bounds.maxX >= 0 &&
      bounds.minX <= this.width &&
      bounds.maxY >= 0 &&
      bounds.minY <= this.height
    );
  }

  private keys(box: OrientedBox): number[] {
    const bounds = boundsOfBox(box);
    // Clamped rather than dropped: a label half off the edge is still on the
    // map, and bucketing it into the edge cell costs one extra exact test.
    const x0 = Math.min(this.cols - 1, Math.max(0, Math.floor(bounds.minX / CELL)));
    const x1 = Math.min(this.cols - 1, Math.max(0, Math.floor(bounds.maxX / CELL)));
    const y0 = Math.min(this.rows - 1, Math.max(0, Math.floor(bounds.minY / CELL)));
    const y1 = Math.min(this.rows - 1, Math.max(0, Math.floor(bounds.maxY / CELL)));
    const out: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) out.push(y * this.cols + x);
    }
    return out;
  }

  private insert(box: OrientedBox, kind: LabelClass, owner: string | null): void {
    const held: Held = { box, kind, owner, mark: 0 };
    for (const key of this.keys(box)) this.push(key, held);
  }

  /**
   * Reserve space that is not itself a label: a dot, or a word that has already
   * been placed by a rule of its own.
   */
  block(box: OrientedBox, kind: LabelClass, owner: string | null = null): void {
    this.insert(box, kind, owner);
  }

  /**
   * Reserve a line, bucketed along its length rather than by its corners.
   *
   * A line is the one shape here whose upright bounds are a lie about where it
   * is: a thousand-pixel diagonal covers a seven-hundred-square box and touches
   * about eighteen cells of it. Bucketing it the ordinary way put it in **a
   * hundred and sixty-nine**, and at two hundred and fifty lines on a deep zoom
   * that is forty thousand inserts a frame for a map that has fifty words on
   * it. Walking the segment instead costs the cells it actually crosses.
   */
  blockLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    owner: string,
    thickness = 3,
  ): void {
    const box = lineBox(x0, y0, x1, y1, thickness);
    const held: Held = { box, kind: "line", owner, mark: 0 };
    const length = box.width;
    const steps = Math.max(1, Math.ceil((length * 2) / CELL));
    const half = thickness / 2;
    const nx = -Math.sin(box.angle) * half;
    const ny = Math.cos(box.angle) * half;
    let last = -1;
    let lastOther = -1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      // Both edges of the band, so a line running along a cell boundary is in
      // both of the cells it actually touches.
      const key = this.cellAt(px + nx, py + ny);
      if (key !== last) {
        this.push(key, held);
        last = key;
      }
      const other = this.cellAt(px - nx, py - ny);
      if (other !== lastOther && other !== key) {
        this.push(other, held);
        lastOther = other;
      }
    }
  }

  private cellAt(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / CELL)));
    return cy * this.cols + cx;
  }

  private push(key: number, held: Held): void {
    const list = this.cells.get(key);
    if (list) list.push(held);
    else this.cells.set(key, [held]);
  }

  /**
   * How many of `kinds` this box touches, ignoring `owner`'s own things.
   *
   * `clear` answers "any at all", which is the right question for a word
   * against another word. For a word against the **lines** it is the wrong
   * one, and measurably so: at a deep zoom nine tenths of the positions on a
   * line have some other line within a few pixels, so refusing every crossed
   * spot took the relation words on a 1,442-item project to **one**, and the
   * founder's ask that the map name its connections would never have fired on
   * a real repository. Counting lets the caller take the quietest place a word
   * can have and judge whether that is quiet enough.
   */
  count(box: OrientedBox, kinds: readonly LabelClass[], owner: string | null): number {
    const mark = ++this.queries;
    let found = 0;
    for (const key of this.keys(box)) {
      const list = this.cells.get(key);
      if (!list) continue;
      for (const held of list) {
        if (held.mark === mark) continue;
        held.mark = mark;
        if (!kinds.includes(held.kind)) continue;
        if (owner !== null && held.owner === owner) continue;
        if (boxesOverlap(box, held.box)) found++;
      }
    }
    return found;
  }

  /** Whether this box is clear of everything in `avoid`, ignoring `owner`'s own things. */
  clear(box: OrientedBox, avoid: readonly LabelClass[], owner: string | null): boolean {
    const mark = ++this.queries;
    for (const key of this.keys(box)) {
      const list = this.cells.get(key);
      if (!list) continue;
      for (const held of list) {
        if (held.mark === mark) continue;
        held.mark = mark;
        if (!avoid.includes(held.kind)) continue;
        // A name is allowed to touch the dot it names — it is drawn against its
        // rim on purpose. Anything else's dot is a collision.
        if (owner !== null && held.owner === owner) continue;
        if (boxesOverlap(box, held.box)) return false;
      }
    }
    return true;
  }

  /**
   * The first candidate that is clear, reserved and returned — or null.
   *
   * Null is a real answer and the caller must honour it by drawing nothing.
   * Returning a "best effort" position would put this file back where it
   * started.
   */
  place<T extends OrientedBox>(
    candidates: readonly T[],
    kind: LabelClass,
    avoid: readonly LabelClass[],
    owner: string | null = null,
  ): T | null {
    for (const candidate of candidates) {
      if (!this.visible(candidate)) continue;
      if (this.clear(candidate, avoid, owner)) {
        this.insert(candidate, kind, owner);
        return candidate;
      }
    }
    return null;
  }

  /**
   * Put a label down whatever is already there.
   *
   * Exactly one caller is allowed this: the numbers on a walk's own hops. A
   * walk with step 2 missing is not a smaller picture, it is a wrong one — the
   * reader counts 1, 3, 4 and concludes the map lost a step it never had. Every
   * other word on the map is held back instead, and everything placed after
   * this one avoids it.
   */
  insist<T extends OrientedBox>(box: T, kind: LabelClass, owner: string | null = null): T {
    this.insert(box, kind, owner);
    return box;
  }
}

/**
 * Where a name may sit around its dot, in the order it should be tried.
 *
 * Under first, because that is where every name on this map has always been and
 * a reader learns one rule faster than four. Then above, then out to the right,
 * then to the left — a clockwise sweep, fixed, so the same crowd resolves the
 * same way every time.
 *
 * `align` travels with the box because the painter has to draw the text where
 * the box is: a name pushed out to the right of its dot starts at the rim and
 * runs away from it, which is `left` alignment, and centring it there would put
 * half of it back over the dot.
 */
export type NamePlacement = OrientedBox & {
  align: "center" | "left" | "right";
};

export function nameCandidates(
  cx: number,
  cy: number,
  r: number,
  width: number,
  height: number,
): NamePlacement[] {
  const gap = 3;
  return [
    { cx, cy: cy + r + gap + height / 2, width, height, angle: 0, align: "center" },
    { cx, cy: cy - r - gap - height / 2, width, height, angle: 0, align: "center" },
    { cx: cx + r + gap + 1 + width / 2, cy, width, height, angle: 0, align: "left" },
    { cx: cx - r - gap - 1 - width / 2, cy, width, height, angle: 0, align: "right" },
  ];
}

/**
 * Where a word on a line may sit, as a fraction along the line.
 *
 * The midpoint first, then a little either side of it. It never leaves its own
 * line: a relation word two lines away from the line it describes is not a
 * label that moved, it is a false statement. The gap the painter cuts in the
 * stroke moves with the word, so the line still reads as having been drawn
 * around it.
 */
export const RELATION_STOPS: readonly number[] = [0.5, 0.36, 0.64, 0.28, 0.72];

/**
 * What a word on a line may never sit on, whatever else is true.
 *
 * Another **word**, and a **dot**. Two words on each other say neither, and a
 * Korean word over a filled circle is a word nobody reads. Neither is ever
 * overruled — the word is dropped instead, and counted.
 */
export const WORD_AVOID: readonly LabelClass[] = ["dot", "district", "name", "relation"];

/**
 * How many other lines may cross a word before it is not worth drawing.
 *
 * This is the one place in this file where something short of clean is allowed
 * through, and it is a measured compromise rather than a taste. The two
 * extremes were both measured on the 1,442-item project, and both are bad:
 *
 *  - **Refuse every crossed spot.** At a deep zoom about nine tenths of the
 *    positions on any given line have another line within a few pixels, so the
 *    relation words on screen went to **one**, at every zoom and every viewport.
 *    The founder's "관계까지 엣지에 보여줌으로써" would simply never happen on a real
 *    repository, which is the same shape of failure as the 6.81 threshold.
 *  - **Accept any spot.** Words come back — eight to twenty-five, inside the
 *    budget — but at the zoom where the lines first appear they carry **about
 *    seventeen other lines through each of them**, which is a word you cannot
 *    read sitting where you cannot ignore it.
 *
 * So the word takes the **quietest** of the places it could have, and is drawn
 * only if that place is quiet enough. Two crossings is where a 11px Korean word
 * with a halo behind it is still legible.
 */
export const MAX_LINES_THROUGH_A_WORD = 2;
