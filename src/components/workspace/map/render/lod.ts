import { HUB_BOOST, ITEM_SPACING } from "../layout";

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
 * The estimate is only as good as the area it divides by, and that is where
 * this file was wrong: it divided by the map's **bounding box** while the items
 * live in discs with gaps between them, which on a 1,442-item project is 3.9
 * times too much area and therefore 3.9 times too few things expected on
 * screen. `MapLayout.itemArea` is the area the packing actually fills, and
 * every rule below now divides by that.
 *
 * What is left of the clustering error is absorbed by two things, both of them
 * themselves position-independent: a link only carries words if it is long
 * enough on screen to hold them (`labelFits`), and every class of label has a
 * **rank ceiling** — `budget / viewFraction` — so that the expected number on
 * screen is the budget exactly, at every zoom. Both are decided from a thing's
 * own fixed numbers, so the same thing gets the same answer wherever it happens
 * to sit.
 *
 * ## The numbers, and where each came from
 *
 * They are below with their reasons. The one worth stating here: **28**
 * relation labels is the budget, taken from the reference picture the founder
 * sent — about twenty-five items, every connection named, and it reads. Past
 * roughly thirty short Korean phrases the eye stops reading words and starts
 * seeing texture, which is the same thing as having drawn none of them.
 *
 * ## What a budget here does NOT do
 *
 * It does not stop two words landing on each other. A budget is about how many
 * words are on screen; whether any two of them collide is geometry, and it is
 * answered separately in `labels.ts`, which places each label in the first free
 * spot from a fixed list of candidates and **draws nothing** rather than
 * drawing over something already there. The two work together: without the
 * budget the field would drop most of what it was offered, and without the
 * field the budget would let 36 names land in a heap.
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
 * How many lines between individual items may be expected on screen at once.
 *
 * ## The one budget that is about crossings rather than about words
 *
 * This is the founder's second complaint — "요소 많은데 어떻게 너무 난잡하게 안보일지"
 * — as a number. A map with too many lines on it does not fail because the ink
 * is dense; it fails because you cannot follow one line from one end to the
 * other, and what stops you is other lines crossing it.
 *
 * Measured on the 1,442-item project at the zoom where lines first come on:
 * **1,517 lines drawn and 44,064 crossings**, which is fifty-eight crossings on
 * the average line. Crossings grow as the square of the line count in a fixed
 * area, and the measurement fixes the constant — about 0.019 per line-pair — so
 * the count that gives four crossings on the average line is near 110.
 *
 * Rounded to 120, which the reference picture independently agrees with: about
 * twenty-five items and thirty connections is 1.2 lines per item, and at this
 * budget a deep zoom holds roughly a hundred items and a hundred and twenty
 * lines.
 *
 * **Lines held back are said out loud.** A budget that quietly drops a
 * connection is a map that lies about someone's project; `drawMap` counts what
 * it held and the map prints the number, the way `neighbourhood.ts` prints
 * "N개는 줄였어요".
 */
export const LINK_BUDGET = 120;

/**
 * The bare space left between two neighbouring names, in screen pixels.
 *
 * The only guessed number left in the name rule, and it is a guess about
 * legibility rather than about type: below about six pixels two 11px words read
 * as one word. Everything else the rule needs — how wide a name actually is —
 * is **measured** now, see `NameMetrics`.
 */
export const NAME_GAP = 6;

/**
 * How wide the project's own names are, measured rather than assumed.
 *
 * ## The constant this replaces, and what it cost
 *
 * The rule used to be `NAME_MIN_PITCH = 52`: "a name is drawn under its dot at
 * 11px, so about 52px of pitch is where two neighbours' names stop touching."
 * That is a statement about Latin text. This product is Korean-first, and a
 * Hangul syllable is a full em where a Latin lowercase letter is about half of
 * one — 결제 화면 is 47px at 11px, and `orderSummaryCard-118.tsx` is over a
 * hundred. Measured across a 1,442-item project, the median drawn name is
 * roughly **twice** the constant that was standing in for it. The threshold was
 * therefore letting names on at half the zoom they need, every time, on the
 * only language this product ships in.
 *
 * So the caller measures. `median` is the width of the middle name at
 * `LABEL_SIZE`, taken over a fixed sample in a fixed order, which keeps it
 * deterministic — the same project measures the same way on every render, which
 * is the promise `layout.ts` makes and this must not break.
 *
 * **The median and not the widest.** The widest name in a project is an
 * outlier, and sizing the whole map's threshold to it would hold every name
 * back until a zoom nothing else needs. Half the names fitting is the right
 * target because the collision field behind this drops the ones that do not,
 * and says how many.
 */
export type NameMetrics = {
  /** The middle name's width in screen pixels, at `LABEL_SIZE`. */
  median: number;
};

/** What to assume before anything has been measured. Korean, at two words. */
export const ASSUMED_NAME_WIDTH = 47;

/**
 * How far the map can be zoomed, and how far in the thresholds above are
 * allowed to sit.
 *
 * The zoom range lives here rather than beside the pointer handlers because it
 * is the thing every threshold has to stay inside. **A threshold past the
 * maximum zoom is a feature that does not exist**, and this is not theoretical:
 * measured on the 300-item fixture in a 1400×900 pane, the density rule put the
 * relation words at a zoom of 6.81 against a ceiling of 6, so the founder's
 * "관계까지 엣지에 보여줌으로써" would simply never have happened on a large screen —
 * silently, with the map looking correct the whole time. Clamping to three
 * quarters of the ceiling leaves room to zoom past the threshold and watch the
 * words settle rather than meeting them on the last notch of the wheel.
 *
 * Where the clamp bites, the budget is the thing that gives: more than 28
 * connections may then be named at once, and `rankCeilingAt` is what keeps that
 * from becoming a grey rectangle. That is the right way round — the picture
 * gets crowded on a pathological graph, rather than going permanently silent on
 * an ordinary one.
 */
export const MIN_SCALE = 0.06;
export const MAX_SCALE = 6;
const REACHABLE_SHARE = 0.75;

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
  /**
   * The area the items actually occupy, in world units squared —
   * `MapLayout.itemArea`, never the bounding box.
   *
   * Measured on a 1,442-item project the two differ by **3.9x**, and since
   * every rule below divides by this number, so did every rule below. The map
   * is discs with gaps between them inside a rectangle; the rectangle is not
   * where the items are.
   */
  itemArea: number;
  viewWidth: number;
  viewHeight: number;
  /** The zoom at which the whole map last fitted the container. */
  fitScale: number;
  /** How wide this project's own names are. Measured, not assumed. */
  names: NameMetrics;
};

export type LodThresholds = {
  /** At and above this zoom the lines between items are drawn at all. */
  linkScale: number;
  /** At and above this zoom those lines carry their relation in words. */
  relationScale: number;
  /** At and above this zoom every visible item carries its name. */
  nameScale: number;
  /** Kept so the per-frame rank ceilings can be worked out without the input again. */
  screenArea: number;
  itemArea: number;
};

/**
 * What share of the whole map the viewport covers at this zoom.
 *
 * One at the fitting zoom and below, and falling as the square of the zoom
 * above it. This is the only place the container's size enters the rules.
 */
export function viewFraction(thresholds: LodThresholds, scale: number): number {
  if (scale <= 0) return 1;
  return Math.min(1, thresholds.screenArea / (scale * scale * thresholds.itemArea));
}

/**
 * Where the thresholds come from now, and the rule that used to be here.
 *
 * ## What was removed, and why it had to be
 *
 * Each threshold used to carry a **density term**: solve "how zoomed in must
 * you be before only `budget` of these are expected on screen" and start
 * drawing them there. It reads well and it did not work, for the reason
 * `MAX_SCALE`'s comment already gives about a different number — it kept
 * landing past the far end of the wheel and being clamped. Measured across
 * every project shape to hand: on the 68-item demo it asked for 10.4, on a
 * 300-item fixture 15.9, on the 1,442-item production graph 9.7 — **all three
 * clamped to 4.5**, on all three viewport sizes. A rule that computes a number
 * and then returns the same constant whatever the input is not a rule; it is a
 * delay with arithmetic in front of it, and it cost the demo its relation
 * words, which used to arrive at 3.0 with the lines and were being pushed to
 * 4.5 for a density the demo does not have.
 *
 * The budgets did not go anywhere. They moved to where they work: `ceilingFor`
 * spends each one exactly, at every zoom, by rank — which is the same
 * arithmetic solved for the right unknown. What is left here is two statements
 * that a ceiling cannot make:
 *
 *  - **Words never appear before the line they sit on.** That is `linkScale`,
 *    and it is a fact about the picture rather than about density.
 *  - **A name needs physical room beside its neighbour.** That is the measured
 *    pitch, `(median name + gap) / ITEM_SPACING`, which is about how wide this
 *    project's own words are and not about how many of them there are.
 */
export function thresholdsFor(input: LodInput): LodThresholds {
  const screenArea = Math.max(input.viewWidth * input.viewHeight, 1);
  const itemArea = Math.max(input.itemArea, 1);
  const linkScale = input.fitScale * LINK_ZOOM_FACTOR;
  /** Nothing may be put where the wheel cannot reach it. */
  const reachable = (scale: number) => Math.min(scale, MAX_SCALE * REACHABLE_SHARE);
  return {
    linkScale,
    relationScale: linkScale,
    nameScale: reachable(
      Math.max(linkScale, (input.names.median + NAME_GAP) / ITEM_SPACING),
    ),
    screenArea,
    itemArea,
  };
}

/** How solid each class of detail is at this zoom. Zero means "not drawn". */
export type Detail = {
  links: number;
  relations: number;
  names: number;
  /** A line is drawn between two items only if its rank is below this. */
  linkCeiling: number;
  /** A line carries its words only if its rank is below this. */
  relationCeiling: number;
  /** An item carries its name only if its name rank is below this. */
  nameCeiling: number;
};

function ramp(threshold: number, scale: number): number {
  if (threshold <= 0) return 1;
  return smoothstep(threshold * (1 - RAMP), threshold * (1 + RAMP), scale);
}

/**
 * The rank at which a budget is exactly spent, at this zoom.
 *
 * ## The formula, and the one it replaces
 *
 * `budget / viewFraction` is the whole idea, and it is an identity rather than
 * a tuning: the things whose rank is below the ceiling number
 * `budget / viewFraction`, and a `viewFraction` share of them is on screen, so
 * the expected number on screen is exactly `budget`. At every zoom. Derived
 * from the zoom alone, so panning cannot change which things are eligible —
 * the flicker this file exists to prevent.
 *
 * What was there before was `RANK_CEILING / viewFraction` with
 * `RANK_CEILING = 220`, described in its own comment as "a cost guard, not a
 * design rule... the budget above already holds the expected count near 28".
 * **It did not.** The budget only ever set a zoom threshold, that threshold was
 * clamped to the reachable zoom on any real project, so the operative budget
 * was 220 — 7.9x the 28 the file documents — and then the bounding-box area
 * error above multiplied it by another 3.9. Measured at 1,442 items: **786
 * relation words on screen where the file says 28**, with the guard sitting at
 * a ceiling of 9,791 against 1,814 links, where it could never fire. A second
 * 6.81.
 *
 * Nothing about the cost guard is lost, because a ceiling that holds the
 * expected count at the budget is a far tighter guard than one that holds it
 * at 220.
 */
export function ceilingFor(
  budget: number,
  thresholds: LodThresholds,
  scale: number,
): number {
  return budget / viewFraction(thresholds, scale);
}

export function detailAt(thresholds: LodThresholds, scale: number): Detail {
  return {
    links: ramp(thresholds.linkScale, scale),
    relations: ramp(thresholds.relationScale, scale),
    names: ramp(thresholds.nameScale, scale),
    linkCeiling: ceilingFor(LINK_BUDGET, thresholds, scale),
    relationCeiling: ceilingFor(RELATION_BUDGET, thresholds, scale),
    nameCeiling: ceilingFor(NAME_BUDGET, thresholds, scale),
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
 * Re-exported from `layout.ts`, where it now lives.
 *
 * It moved because the packing has to reserve the room the boost spends —
 * applying it here alone was every item-on-item overlap on a 1,442-item map.
 * The name stays importable from this file so the renderer, which thinks about
 * it as a level-of-detail fact, does not have to reach past it.
 */
export { HUB_BOOST };

/** Never let a dot vanish into a hairline, and never let one become a plate. */
export function itemScreenRadius(
  worldRadius: number,
  scale: number,
  hub: boolean,
): number {
  const r = worldRadius * scale * (hub ? HUB_BOOST : 1);
  return clamp(r, 1.4, 64);
}
