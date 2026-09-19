import { ITEM_SPACING } from "../layout";

import { clamp, smoothstep } from "./geometry";

/**
 * When the map says more, and when it shuts up.
 *
 * ## The failure this file exists to prevent
 *
 * Three hundred items with every connection labelled is not a knowledge graph,
 * it is a grey rectangle — the exact hairball D59 and UI_DIRECTION section 5
 * are written to avoid, reached by a different road. So detail has to arrive
 * with the zoom. The hard part is not deciding *that*; it is deciding it in a
 * way that cannot flicker.
 *
 * ## The invariant: nothing here may read the camera's POSITION
 *
 * Every threshold below is a function of the zoom, the size of the container
 * and facts about the graph that do not change while you drag. **None of them
 * counts what is currently inside the viewport.** That is deliberate and it is
 * the whole design.
 *
 * The obvious rule — "draw words while fewer than N connections are on screen"
 * — is the trap. Pan towards a dense district and the count crosses N, every
 * word on screen vanishes at once, and panning back brings them all in again:
 * labels strobing under a moving hand, at a zoom the user never changed. It
 * reads as a broken screen, and it is unfixable by tuning N.
 *
 * What is used instead is the *expected* number on screen — how many there
 * would be if the graph were spread evenly over its own extent. That is
 * `count × viewFraction(scale)`, and it depends on the zoom alone. Solve it for
 * the budget and you get one zoom threshold per kind of label, computed once
 * per layout and per container size. Pan all day; it cannot move.
 *
 * Clustering means the estimate is wrong locally — a dense district really does
 * have more lines per inch than the average. Two things absorb that, and both
 * are themselves position-independent: a link only carries words if it is long
 * enough on screen to hold them (`labelFits`), and only the first
 * `RANK_CEILING`-worth of links by a fixed ranking are ever eligible at a given
 * zoom (`rankCeilingAt`). Both are decided per link from the link's own
 * numbers, so the same link gets the same answer wherever it happens to sit.
 *
 * ## The numbers, and where each came from
 *
 * They are below with their reasons. The one worth stating here: **28**
 * relation labels is the budget, taken from the reference picture the founder
 * sent — about twenty-five items, every connection named, and it reads. Past
 * roughly thirty short Korean phrases the eye stops reading words and starts
 * seeing texture, which is the same thing as having drawn none of them.
 */

/**
 * How far past "the whole map fits on screen" you must be before the lines
 * between individual items are drawn.
 *
 * Measured against the fitting zoom rather than against an absolute scale,
 * which is the correction a real repo forced: at 1400px the demo project fit at
 * a scale above any fixed threshold, so every item line switched on at the
 * resting zoom and produced precisely the tangle D59 exists to prevent. Zooming
 * is the user saying "show me this part", and that is when the strings belong.
 */
export const LINK_ZOOM_FACTOR = 2.2;

/**
 * How many named connections may be expected on screen at once.
 *
 * From the founder's reference picture: ~25 items, every connection carrying a
 * word, and the whole point of it is that you can read "Supplier → Supplies →
 * Component A" straight off the page. Thirty is where that stops working.
 */
export const RELATION_BUDGET = 28;

/**
 * How many items may be expected on screen before their names come off.
 *
 * Larger than the connection budget because a name sits at one point while a
 * connection's words sit across a line and collide with everything the line
 * crosses. Thirty-six is a little over the reference picture's item count,
 * which is the density it was drawn at.
 */
export const NAME_BUDGET = 36;

/**
 * The narrowest gap, in screen pixels, between two packed items at which their
 * names can both be written.
 *
 * `ITEM_SPACING` world units apart at a given zoom is `ITEM_SPACING × scale`
 * pixels apart. A name is drawn under its dot at 11px, so about 52px of pitch
 * is where two neighbours' names stop touching. Without this the name budget
 * alone would switch names on for a project whose items are packed into one
 * small territory, and they would land on top of each other.
 */
export const NAME_MIN_PITCH = 52;

/**
 * The most links that may be *eligible* for words on one screenful.
 *
 * A cost guard, not a design rule: the budget above already holds the expected
 * count near 28, and this only engages where clustering has beaten the
 * estimate by nearly an order of magnitude. It is written as a rank ceiling
 * that grows as the viewport shrinks rather than as "stop after N labels this
 * frame", because a per-frame stop is decided by draw order and draw order
 * moves when you pan — which is the flicker this file is about.
 */
export const RANK_CEILING = 220;

/**
 * The width of the zoom band a label class fades in over, as a fraction of its
 * threshold.
 *
 * Without it, crossing a threshold pops a hundred words into existence in one
 * frame; a wheel notch is about 12% of scale, so a band of that order turns
 * one notch into a fade rather than a switch.
 */
const RAMP = 0.12;

export type LodInput = {
  linkCount: number;
  itemCount: number;
  /** The map's own extent, in world units squared. */
  mapArea: number;
  viewWidth: number;
  viewHeight: number;
  /** The zoom at which the whole map last fitted the container. */
  fitScale: number;
};

export type LodThresholds = {
  /** At and above this zoom the lines between items are drawn at all. */
  linkScale: number;
  /** At and above this zoom those lines carry their relation in words. */
  relationScale: number;
  /** At and above this zoom every visible item carries its name. */
  nameScale: number;
  /** Kept so the per-frame rank ceiling can be worked out without the input again. */
  screenArea: number;
  mapArea: number;
};

/**
 * What share of the whole map the viewport covers at this zoom.
 *
 * One at the fitting zoom and below, and falling as the square of the zoom
 * above it. This is the only place the container's size enters the rules.
 */
export function viewFraction(thresholds: LodThresholds, scale: number): number {
  if (scale <= 0) return 1;
  return Math.min(1, thresholds.screenArea / (scale * scale * thresholds.mapArea));
}

/**
 * The zoom at which `budget` of `count` things are expected on screen.
 *
 * Zero when there are already few enough to show at any zoom — a nine-item
 * project should not have to be zoomed into before it will name anything.
 */
export function scaleForBudget(
  count: number,
  budget: number,
  mapArea: number,
  screenArea: number,
): number {
  if (count <= budget || budget <= 0) return 0;
  const area = Math.max(mapArea, 1);
  return Math.sqrt((count * screenArea) / (budget * area));
}

export function thresholdsFor(input: LodInput): LodThresholds {
  const screenArea = Math.max(input.viewWidth * input.viewHeight, 1);
  const mapArea = Math.max(input.mapArea, 1);
  const linkScale = input.fitScale * LINK_ZOOM_FACTOR;
  return {
    linkScale,
    // Words can never appear before the line they sit on, whatever the density
    // says — which is what the max is for on a small project.
    relationScale: Math.max(
      linkScale,
      scaleForBudget(input.linkCount, RELATION_BUDGET, mapArea, screenArea),
    ),
    nameScale: Math.max(
      NAME_MIN_PITCH / ITEM_SPACING,
      scaleForBudget(input.itemCount, NAME_BUDGET, mapArea, screenArea),
    ),
    screenArea,
    mapArea,
  };
}

/** How solid each class of detail is at this zoom. Zero means "not drawn". */
export type Detail = {
  links: number;
  relations: number;
  names: number;
  /** A link may carry words only if its rank is below this. */
  rankCeiling: number;
};

function ramp(threshold: number, scale: number): number {
  if (threshold <= 0) return 1;
  return smoothstep(threshold * (1 - RAMP), threshold * (1 + RAMP), scale);
}

export function detailAt(thresholds: LodThresholds, scale: number): Detail {
  return {
    links: ramp(thresholds.linkScale, scale),
    relations: ramp(thresholds.relationScale, scale),
    names: ramp(thresholds.nameScale, scale),
    rankCeiling: RANK_CEILING / viewFraction(thresholds, scale),
  };
}

/**
 * Whether there is room on this line for these words.
 *
 * Both numbers are screen pixels, so the answer for a given link changes only
 * with the zoom and never with where the link has been panned to. `clearance`
 * is the bare line left either side of the words — without it the text ends
 * exactly where the stroke resumes and reads as struck through.
 */
export function labelFits(
  lengthPx: number,
  textWidthPx: number,
  clearance: number,
): boolean {
  return lengthPx >= textWidthPx + clearance * 2;
}

/**
 * How solid an item is at this zoom.
 *
 * Items fade out as the map zooms away, largest last, and below about one
 * screen pixel they are gone entirely — leaving named territories and the roads
 * between them. This is the mechanism that makes "no hairball of dots at the
 * widest zoom" true of a 3,000-item repo and not just of a demo, and it needs
 * no thresholds tuned per project, because it is expressed in screen pixels.
 */
export function itemAlphaFor(worldRadius: number, scale: number): number {
  return smoothstep(1.2, 2.2, worldRadius * scale);
}

/**
 * The extra reach a district's busiest item is drawn with.
 *
 * The reference overview the founder sent is eight neighbourhoods, each one a
 * large node with dozens of small ones around it. Ours earns that shape rather
 * than decorating it: the large node is the most-connected thing in the
 * territory, and because the boost applies to the radius the alpha rule is fed,
 * it is also the last item to fade as you zoom out. Zooming away from a grouped
 * map therefore leaves one dot per territory before it leaves none, which is
 * the reading the reference has.
 */
export const HUB_BOOST = 1.9;

/** Never let a dot vanish into a hairline, and never let one become a plate. */
export function itemScreenRadius(
  worldRadius: number,
  scale: number,
  hub: boolean,
): number {
  const r = worldRadius * scale * (hub ? HUB_BOOST : 1);
  return clamp(r, 1.4, 64);
}
