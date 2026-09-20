import type { Certainty, GraphItem } from "@/lib/graph/view";
import { RELATION_WORDS } from "@/lib/graph/view";

import type { BeamResult } from "../beam";
import type { MapLayout, PlacedDistrict } from "../layout";

import {
  arrowAt,
  clamp,
  hatchStart,
  labelAnchorAt,
  onScreen,
  shifted,
  spanBetween,
  visibleRange,
  type OrientedBox,
  type Span,
} from "./geometry";
import {
  LabelField,
  nameCandidates,
  MAX_LINES_THROUGH_A_WORD,
  RELATION_STOPS,
  WORD_AVOID,
  type NamePlacement,
} from "./labels";
import {
  detailAt,
  itemAlphaFor,
  itemScreenRadius,
  thresholdsFor,
  ASSUMED_NAME_WIDTH,
  HUB_BOOST,
  type Detail,
  type NameMetrics,
} from "./lod";
import { hueFor, withAlpha, type Palette } from "./palette";
import {
  itemStrength,
  linkStrength,
  stepFor,
  touchesFocus,
  walking,
  type Focus,
  type MapLink,
  type Trail,
  type TrailStep,
} from "./scene";

/**
 * One frame of the map.
 *
 * ## The rule every primitive in this file obeys
 *
 * **No transform is ever put on the context.** Every point is converted to
 * screen coordinates by hand before it is drawn. That is not a preference: the
 * hatch that distinguishes 확실해요 from 짐작이에요 has to keep a constant pitch in
 * screen pixels or it stops being distinguishable at the zoom where a whole
 * project fits on screen (UI_DIRECTION section 5, warning 1), and the moment
 * one primitive draws under a transform the next person copies it. Line widths,
 * text sizes, arrowheads, the gap cut in a line to make room for its words —
 * all of them are pixels, all of them are constant at every zoom.
 *
 * ## Why it is a module and not a method
 *
 * It is the one part of the map that is worth timing on its own: `drawMap` is
 * reachable from a plain script with a counting stand-in for the context, which
 * is how the frame budget on a 300-item project was measured. A draw call
 * buried inside a component is a draw call nobody can put a number on.
 */

export type Camera = { x: number; y: number; scale: number };

/** Every connection that leaves its territory, added up, drawn as one road. */
export type Road = {
  a: PlacedDistrict;
  b: PlacedDistrict;
  certain: number;
  inferred: number;
};

export type Scene = {
  layout: MapLayout;
  roads: readonly Road[];
  /** Rank order ascending, which the label budget below relies on. */
  links: readonly MapLink[];
  itemsById: ReadonlyMap<string, GraphItem>;
  /** Territory id → the item drawn as its hub. Absent for a territory too small to have one. */
  hubs: ReadonlyMap<string, string>;
  /**
   * Item id → the order it gets its name in, when there is not room for every
   * name. From `nameRanks`, and required rather than optional for the same
   * reason `trail` is: a scene that quietly means "no order" would spend the
   * whole name budget inside whichever territory happened to come first.
   */
  nameRank: ReadonlyMap<string, number>;
  /** False when colour is not carrying the grouping — see `colourCarriesGrouping`. */
  grouped: boolean;
  beam: BeamResult;
  /**
   * What the user chose. **This is the only thing that dims the rest of the
   * map**, because dimming is an answer to a decision.
   */
  selection: Focus;
  /**
   * What the pointer is over, falling back to the selection. This lights the
   * bright overlay and nothing else: a map that dimmed under the pointer would
   * flash the whole picture every time a hand crossed it, and a glance is not
   * a decision.
   */
  pointed: Focus;
  selectedId: string | null;
  /**
   * The investigation's walk, when one is showing. `NO_TRAIL` otherwise.
   *
   * Required rather than optional, though every function below already defaults
   * it, because a scene that quietly means "no walk" is how a feature stops
   * working without anything failing. There are two places that build a
   * `Scene`; both should have to say.
   *
   * While this is non-empty it **takes over the lighting from the selection**
   * — see `itemStrength`. One screen, one meaning of "near".
   */
  trail: Trail;
  size: { width: number; height: number } | null;
};

export type View = {
  width: number;
  height: number;
  dpr: number;
  camera: Camera;
  palette: Palette;
  font: string;
  /** The zoom at which the whole map last fitted the container. */
  fitScale: number;
};

/** Screen pixels between two hatch ticks. Constant at every zoom — that is the point. */
const HATCH_PITCH = 5;

/** Below this many screen pixels a territory's name is noise, so it is not drawn. */
const LABEL_MIN_SCREEN_R = 22;

/** A territory's name never shrinks below this, however narrow its land is. */
const DISTRICT_LABEL_MIN = 10;

/** A guard for a pathological repo: never draw more thin lines than this in a frame. */
const MAX_LINKS = 2500;

/** Screen pixels of arrowhead. Constant, so direction survives every zoom. */
const ARROW_LENGTH = 7.5;
const ARROW_HALF_WIDTH = 3.2;

/** Shorter than this on screen and a line is a dot: no head, no words. */
const MIN_LINK_LENGTH = 9;

/**
 * How far outside the window an item may sit and still anchor a line.
 *
 * Generous, because the point is only to rule out lines that arrive from
 * somewhere genuinely off the map — a dot just past the edge is one the reader
 * finds by nudging the view, and cutting its line at the exact boundary would
 * make the picture change under a small pan.
 */
const END_SLACK = 120;
const MIN_ARROW_LENGTH = 16;

/** Bare line left either side of a link's words, so the text is not struck through. */
const LABEL_CLEARANCE = 7;

const LABEL_SIZE = 11;

/**
 * How many of a selection's own links carry words.
 *
 * The connections panel already caps its list at 24 per direction and says out
 * loud how many it left out; two dozen words fanned around one dot is about
 * where they start landing on each other, and the panel is where the rest are
 * read anyway. Taken in rank order, so which 24 is not decided by the pan.
 */
const FOCUS_LABEL_CAP = 24;

/**
 * How much fainter a line between two territories is drawn when the map is
 * grouped.
 *
 * The reference overview is emphatic about this: the links inside a
 * neighbourhood are what give it its shape, and the ones between are a thin
 * scatter. At full strength the crossings are what the eye follows and the
 * neighbourhoods stop reading as neighbourhoods.
 */
const CROSSING_FADE = 0.45;

/** Resting weight of an ordinary link, before alpha. Quiet, so the territories read first. */
const LINK_ALPHA = 0.42;

/**
 * A territory's outline: a circle with a slight wobble, so the map reads as
 * land rather than as a bubble chart.
 *
 * The wobble only ever pulls the rim INWARD (0.9 to 1.0 of the radius), which
 * is what keeps `layout.ts`'s non-overlap guarantee true of the drawn shape and
 * not merely of the circle it was computed from. Derived from the district id,
 * so a territory has the same coastline on every render and in every
 * screenshot.
 */
const blobCache = new Map<string, number[]>();
function unitBlob(id: string, points: number): number[] {
  const key = `${id}|${points}`;
  const hit = blobCache.get(key);
  if (hit) return hit;
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) {
    seed ^= id.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const radii: number[] = [];
  for (let i = 0; i < points; i++) {
    seed = Math.imul(seed ^ (seed >>> 15), 2246822507);
    seed = Math.imul(seed ^ (seed >>> 13), 3266489909);
    const unit = ((seed ^ (seed >>> 16)) >>> 0) / 4294967296;
    radii.push(0.9 + unit * 0.1);
  }
  blobCache.set(key, radii);
  return radii;
}

/**
 * Text widths, memoised by font and string.
 *
 * `measureText` is a layout call, and the relation words come from a table of
 * seven, so the cache is seven entries deep and answers every frame from then
 * on. Left uncached it was the second largest cost in a labelled frame.
 */
const widthCache = new Map<string, number>();
function widthOf(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const key = `${font}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  ctx.font = font;
  const width = ctx.measureText(text).width;
  widthCache.set(key, width);
  return width;
}

/**
 * Korean wants tighter tracking than the Latin default, and a canvas does not
 * inherit the rule globals.css sets for the DOM. The property is not in every
 * lib.dom the repo may be built against, hence the narrow widening — it is a
 * real property on every browser that ships a 2D context, and `undefined` on a
 * stand-in context simply does nothing.
 */
type Tracked = CanvasRenderingContext2D & { letterSpacing?: string };

export function displayNameOf(item: GraphItem): string {
  if (item.label) return item.label;
  if (item.kind === "file" && item.path) {
    const cut = item.path.lastIndexOf("/");
    return cut === -1 ? item.path : item.path.slice(cut + 1);
  }
  return item.name;
}

/**
 * What a frame drew, and what it had to hold back.
 *
 * ## Why a draw call returns anything at all
 *
 * Because the map is not allowed to omit in silence. Two of the mechanisms in
 * this renderer decline to draw things on purpose — the link budget holds back
 * lines that would make the picture unreadable, and the label field drops a
 * word rather than laying it over another word — and either of those, done
 * quietly, is the map telling someone their project has fewer connections than
 * it has. `neighbourhood.ts` already solved this for the panel: it caps its
 * list and prints "N개는 줄였어요". The map prints the same sentence, and this is
 * the number in it.
 *
 * Counted rather than estimated, and counted for this frame only: a line held
 * back while it is off screen is not hidden from anybody.
 */
export type FrameReport = {
  /** Lines between two items that the budget held back while they were on screen. */
  linksHeld: number;
  /** Words that had nowhere clear to sit, so were not drawn at all. */
  labelsHeld: number;
  linksDrawn: number;
  labelsDrawn: number;
};

export const QUIET_FRAME: FrameReport = {
  linksHeld: 0,
  labelsHeld: 0,
  linksDrawn: 0,
  labelsDrawn: 0,
};

/**
 * What the map says about what it left out.
 *
 * 해요체, like every sentence in this product, and it names what was held back
 * rather than how the renderer decided — "선" and "이름" are what is on screen,
 * where "링크" and "라벨" are words for the thing behind it. It ends with the
 * remedy, because a count with no way to act on it is only alarming.
 *
 * Empty when nothing was held back, which is the common case and is how the
 * line stays out of the way of the map it is about.
 */
export function heldBackSentence(report: FrameReport): string {
  const parts: string[] = [];
  if (report.linksHeld > 0) parts.push(`선 ${report.linksHeld.toLocaleString("ko-KR")}개`);
  if (report.labelsHeld > 0) parts.push(`이름 ${report.labelsHeld.toLocaleString("ko-KR")}개`);
  if (parts.length === 0) return "";
  return `${parts.join("와 ")}는 겹쳐 보여서 지금은 줄였어요. 더 크게 보면 다시 나와요.`;
}

/**
 * How many names are measured to find the typical one.
 *
 * Enough that one very long path does not move the middle, small enough that
 * the measurement is free on the first frame and cached after it. Taken in name
 * rank order, which is total, so the sample is the same sample on every render.
 */
const NAME_SAMPLE = 64;

/** Height of a name's box, as a multiple of its size. A little generous, on purpose. */
const NAME_BOX_HEIGHT = 1.25;

/**
 * The typical width of this project's own names, measured once.
 *
 * `lod.ts` needs it to decide the zoom at which names may come on, and the
 * number it used to use for that was a guess about Latin text sitting in a
 * Korean-first product. Measured here against the real font, with the real
 * strings, through the same `measureText` the painter lays them out with.
 *
 * Cached against the layout, because that is exactly what it depends on: a new
 * batch of items during a live run is a new layout and a fresh measurement,
 * and a pan or a zoom is neither.
 */
const nameMetricsCache = new WeakMap<MapLayout, Map<string, NameMetrics>>();

function nameMetricsFor(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  font: string,
): NameMetrics {
  let perFont = nameMetricsCache.get(scene.layout);
  if (!perFont) {
    perFont = new Map();
    nameMetricsCache.set(scene.layout, perFont);
  }
  const hit = perFont.get(font);
  if (hit) return hit;

  const sampled: { rank: number; text: string }[] = [];
  for (const placed of scene.layout.items) {
    const rank = scene.nameRank.get(placed.id) ?? Number.MAX_SAFE_INTEGER;
    if (rank >= NAME_SAMPLE) continue;
    const item = scene.itemsById.get(placed.id);
    if (item) sampled.push({ rank, text: displayNameOf(item) });
  }
  sampled.sort((a, b) => a.rank - b.rank);

  const widths = sampled.map((one) => widthOf(ctx, font, one.text)).sort((a, b) => a - b);
  const metrics: NameMetrics = {
    median: widths.length > 0 ? widths[widths.length >> 1] : ASSUMED_NAME_WIDTH,
  };
  perFont.set(font, metrics);
  return metrics;
}

/** One item, as this frame will draw it. */
type Dot = {
  id: string;
  cx: number;
  cy: number;
  r: number;
  hub: boolean;
  alpha: number;
  strength: number;
  hue: string;
};

/** One line between two items, with its words already decided. */
type Thread = {
  link: MapLink;
  span: Span;
  alpha: number;
  step: TrailStep | null;
  words: string | null;
  /** How far along the line the words sit, and how wide a gap the stroke leaves. */
  at: number;
  hole: number;
  /** This line's own key in the label field, so its word may sit on it. */
  owner: string | null;
};

/** One item's name, already placed. */
type PlacedName = NamePlacement & { text: string; alpha: number; strong: boolean };

/** One territory's name and the line under it, already placed. */
type DistrictLabel = {
  name: string;
  nameSize: number;
  nameBox: OrientedBox;
  subline: string | null;
  sublineSize: number;
  sublineBox: OrientedBox | null;
  strength: number;
};

/** The selection's neighbourhood, decided before anything under it is painted. */
type FocusPlan = {
  centre: { x: number; y: number; r: number };
  threads: {
    span: Span;
    certainty: Certainty;
    words: string | null;
    hole: number;
    at: number;
  }[];
  rings: { x: number; y: number; r: number }[];
  names: PlacedName[];
};

export function drawMap(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
): FrameReport {
  const { width, height, dpr, camera, palette } = view;
  const { layout, roads, beam, selection, pointed, trail } = scene;
  const report: FrameReport = { linksHeld: 0, labelsHeld: 0, linksDrawn: 0, labelsDrawn: 0 };

  // No transform on the context beyond the device pixel ratio. Everything below
  // converts to screen coordinates itself, which is what makes line widths,
  // text sizes and above all the hatch pitch independent of the zoom.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, width, height);

  const sx = (x: number) => (x - camera.x) * camera.scale + width / 2;
  const sy = (y: number) => (y - camera.y) * camera.scale + height / 2;

  const labelFont = `500 ${LABEL_SIZE}px ${view.font}`;
  const nameHeight = LABEL_SIZE * NAME_BOX_HEIGHT;

  const detail = detailAt(
    thresholdsFor({
      linkCount: scene.links.length,
      itemCount: layout.items.length,
      // The area the items occupy, never the bounding box: they differ by
      // nearly four times on a real project, and every budget below divides by
      // this number.
      itemArea: layout.itemArea,
      viewWidth: width,
      viewHeight: height,
      fitScale: view.fitScale,
      names: nameMetricsFor(ctx, scene, labelFont),
    }),
    camera.scale,
  );

  /**
   * How strongly each territory is drawn: as bright as the brightest thing in
   * it. A territory holding the selected item, or one match for what is typed,
   * is a place the answer is in, and dimming it would hide the answer inside a
   * dimmed shape.
   */
  const districtStrength = new Map<string, number>();
  // A walk dims too, and it dims without anything being selected. Leaving it
  // out of this test left every territory at full strength underneath a map
  // whose items had gone dark — the shapes stayed lit while their contents did
  // not, which reads as the map having failed rather than as an answer.
  const anythingDimmed = beam.active || selection.id !== null || walking(trail);
  if (anythingDimmed) {
    for (const placed of layout.items) {
      const strength = itemStrength(placed.id, selection, beam, trail);
      const current = districtStrength.get(placed.districtId);
      if (current === undefined || strength > current) {
        districtStrength.set(placed.districtId, strength);
      }
    }
  }
  const strengthOfDistrict = (id: string) =>
    anythingDimmed ? districtStrength.get(id) ?? 0.3 : 1;

  // 1. The territories.
  for (const district of layout.districts) {
    const cx = sx(district.x);
    const cy = sy(district.y);
    const r = district.r * camera.scale;
    if (!onScreen(cx - r, cy - r, cx + r, cy + r, width, height, 40)) continue;

    const hue = hueFor(palette, district.hue, scene.grouped);
    // Dimmed, never dark: an unlit district is still a place on the map.
    const strength = strengthOfDistrict(district.id);

    const radii = unitBlob(district.id, 26);
    ctx.beginPath();
    for (let i = 0; i <= radii.length; i++) {
      const index = i % radii.length;
      const nextIndex = (i + 1) % radii.length;
      const angle = (index / radii.length) * Math.PI * 2;
      const nextAngle = ((index + 1) / radii.length) * Math.PI * 2;
      const px = cx + Math.cos(angle) * r * radii[index];
      const py = cy + Math.sin(angle) * r * radii[index];
      const nx = cx + Math.cos(nextAngle) * r * radii[nextIndex];
      const ny = cy + Math.sin(nextAngle) * r * radii[nextIndex];
      if (i === 0) ctx.moveTo((px + nx) / 2, (py + ny) / 2);
      else ctx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
    }
    ctx.closePath();

    /*
     * The soft centre is a gradient until the territory is bigger than the
     * window, and a flat fill after that.
     *
     * A radial gradient is evaluated per pixel, so once you have zoomed inside
     * one territory the browser is shading every pixel on screen — the single
     * largest cost in a deep-zoom repaint on a 300-item project. What it buys
     * at that zoom is nothing: the visible sliver spans a few percent of the
     * radius, over which the gradient moves by about three hundredths of an
     * alpha. So past that size it is filled at the alpha the middle would have
     * had, which is the same picture for a fraction of the work. Degrading by
     * zoom rather than dropping the gradient outright keeps the resting screen
     * — the one people actually look at — exactly as it was.
     */
    if (r > Math.hypot(width, height)) {
      ctx.fillStyle = withAlpha(hue, 0.15 * strength);
    } else {
      const gradient = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
      gradient.addColorStop(0, withAlpha(hue, 0.17 * strength));
      gradient.addColorStop(1, withAlpha(hue, 0.05 * strength));
      ctx.fillStyle = gradient;
    }
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = withAlpha(hue, 0.42 * strength);
    ctx.stroke();
  }

  // 2. The roads between them, under the names.
  for (const road of roads) {
    const strength = Math.min(
      strengthOfDistrict(road.a.id),
      strengthOfDistrict(road.b.id),
    );
    drawRoad(ctx, road, sx, sy, camera.scale, palette, strength, width, height);
  }

  /*
   * 3. Every word on this frame is decided before any of them is drawn.
   *
   * The order below is a **priority** order and it is deliberately not the
   * order things are painted in. A label placed first owns its spot, so the
   * pass that places them runs from most important to least — a file name
   * taking the square inch the walk's step 2 needed would be the map answering
   * a question nobody asked. Painting then happens in layer order as before,
   * with every word already knowing whether it is drawn and where.
   *
   * Everything a word must not land on goes in first: the dots. A name is
   * allowed to touch the dot it names — it is drawn against that rim on purpose
   * — which is why each dot is blocked under its own item's id rather than
   * anonymously.
   */
  const field = new LabelField(width, height);
  /*
   * Dots are only worth reserving when a name might land on one.
   *
   * At the resting zoom nothing on this map carries a word, so blocking 1,442
   * circles buys nothing and costs an insert each — measured at about three
   * milliseconds a frame on the one screen this product opens with, for no
   * change to the picture whatsoever.
   */
  const dotsMatter = detail.names > 0 || detail.relations > 0 || pointed.id !== null;

  const dots: Dot[] = [];
  for (const placed of layout.items) {
    const hub = scene.hubs.get(placed.districtId) === placed.id;
    const alpha = itemAlphaFor(placed.r * (hub ? HUB_BOOST : 1), camera.scale);
    if (alpha <= 0.02) continue;
    const cx = sx(placed.x);
    const cy = sy(placed.y);
    const r = itemScreenRadius(placed.r, camera.scale, hub);
    if (!onScreen(cx - r, cy - r, cx + r, cy + r, width, height, 0)) continue;
    const district = layout.byDistrictId.get(placed.districtId);
    dots.push({
      id: placed.id,
      cx,
      cy,
      r,
      hub,
      alpha,
      strength: itemStrength(placed.id, selection, beam, trail),
      hue: hueFor(palette, district?.hue ?? 0, scene.grouped),
    });
    if (dotsMatter) {
      field.block({ cx, cy, width: r * 2, height: r * 2, angle: 0 }, "dot", placed.id);
    }
  }

  const threads = prepareThreads(scene, view, detail, sx, sy, report);
  /*
   * Every line is an obstacle for every word that sits on a *different* line.
   *
   * The gap `drawThread` cuts opens one line, its own; a second line crossing
   * that gap puts a stroke straight through the word and the cut says nothing
   * about it. Measured before this: about two lines through the average
   * relation word at a deep zoom. Each thread owns its own box, so a word is
   * never refused by the line it belongs to.
   */
  if (detail.relations > 0 || pointed.id !== null) {
    threads.forEach((thread, index) => {
      const { span } = thread;
      field.blockLine(span.x0, span.y0, span.x1, span.y1, `thread:${index}`);
      thread.owner = `thread:${index}`;
    });
  }

  // 3a. A walk's own numbers. First of everything, and the only words on this
  //     map that are never held back — see `LabelField.insist`.
  placeWalkNumbers(ctx, field, threads, labelFont);

  // 3b. The territories' names. At the resting zoom they are the entire map,
  //     and they are what a non-developer reads in ten seconds.
  const districtLabels = placeDistrictNames(
    ctx,
    scene,
    view,
    field,
    sx,
    sy,
    strengthOfDistrict,
    report,
  );

  // 3c. The neighbourhood of whatever is pointed at: the answer to the click
  //     that has just happened, so it outranks every ordinary name and word.
  const focus =
    pointed.id !== null && !walking(trail)
      ? planFocus(ctx, scene, view, field, sx, sy, labelFont, nameHeight, report)
      : null;

  // 3d. Then the ordinary names, then the ordinary words on lines.
  const names = placeNames(ctx, scene, detail, field, dots, labelFont, nameHeight, report);
  placeRelations(ctx, scene, detail, field, threads, labelFont, report);

  // 4. The lines themselves.
  for (const thread of threads) {
    paintThread(ctx, thread, palette, labelFont, width, height, report);
  }

  // 5. The items, and the names that found room under them.
  for (const dot of dots) {
    // A ring in the surface colour, so two dots that touch still read as two
    // things. The reference picture does this in white on paper; the same idea
    // on a dark sheet is a ring in the sheet's own colour.
    if (dot.r >= 3) {
      ctx.beginPath();
      ctx.arc(dot.cx, dot.cy, dot.r + 1.1, 0, Math.PI * 2);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = withAlpha(palette.surface, 0.85 * dot.alpha);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(dot.cx, dot.cy, dot.r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(dot.hue, dot.alpha * dot.strength * 0.95);
    ctx.fill();

    // The hub carries a mark rather than an icon: the product has no icon set,
    // and inventing one would be a claim about what this thing IS, which the
    // map cannot make. A ring says only "this is the busiest thing here",
    // which is exactly what was measured.
    if (dot.hub && dot.r >= 7) {
      ctx.beginPath();
      ctx.arc(dot.cx, dot.cy, dot.r * 0.44, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(palette.surface, 0.9 * dot.alpha);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(dot.cx, dot.cy, dot.r * 0.17, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(dot.hue, dot.alpha * dot.strength);
      ctx.fill();
    }

    const placement = names.get(dot.id);
    if (placement) {
      drawName(ctx, placement, view.font, palette);
      report.labelsDrawn++;
    }
  }

  // 6. The territories' names, lying flat over their own items.
  for (const label of districtLabels) {
    drawDistrictLabel(ctx, label, view.font, palette);
    report.labelsDrawn += label.sublineBox === null ? 1 : 2;
  }

  // 7. The neighbourhood, over everything, so a bright line is never crossed
  //    by a dim one.
  if (focus) paintFocus(ctx, focus, view, palette, labelFont, report);

  // The selection keeps its ring even while the pointer is over something else.
  if (scene.selectedId !== null && scene.selectedId !== pointed.id) {
    const placed = layout.byItemId.get(scene.selectedId);
    if (placed) {
      ctx.beginPath();
      ctx.arc(
        sx(placed.x),
        sy(placed.y),
        Math.max(placed.r * camera.scale, 3) + 4,
        0,
        Math.PI * 2,
      );
      ctx.lineWidth = 2;
      ctx.strokeStyle = withAlpha(palette.lamp, 0.7);
      ctx.stroke();
    }
  }

  return report;
}

/**
 * Which lines are drawn at all, and where each one runs.
 *
 * ## The budget, and why a line may be held back
 *
 * Measured on a 1,442-item project at the zoom where lines first come on:
 * **1,517 lines on a 375-pixel-wide screen, crossing each other 44,064 times**
 * — fifty-eight crossings on the average line. There is no sense in which that
 * picture tells anybody what their app is made of, and it is the second half of
 * the founder's ask ("요소 많은데 어떻게 너무 난잡하게 안보일지"). `LINK_BUDGET` is the
 * count at which a line can still be followed from one end to the other, and
 * `detail.linkCeiling` turns it into a rank — so *which* lines are eligible
 * depends on the zoom alone and never on where the map has been dragged to,
 * which is the flicker rule `lod.ts` is built around.
 *
 * Three kinds of line are exempt, and every exemption is the same statement:
 * this line is the answer to a question the person just asked. A walk's own
 * hops, the lines touching the selection, and the lines touching the pointer.
 *
 * What is held back is **counted, and said** — `report.linksHeld`, which the
 * map prints. A budget that dropped a connection in silence would be this
 * product telling someone their project has fewer connections than it has.
 */
function prepareThreads(
  scene: Scene,
  view: View,
  detail: Detail,
  sx: (x: number) => number,
  sy: (y: number) => number,
  report: FrameReport,
): Thread[] {
  const { layout, beam, selection, pointed, trail } = scene;
  const { camera, width, height } = view;
  const threads: Thread[] = [];
  if (detail.links <= 0 && !walking(trail) && pointed.id === null) return threads;

  for (const link of scene.links) {
    // The overlay draws these over everything at the end. While a walk is
    // showing there is no overlay, and the walk's own lines belong here.
    if (touchesFocus(link, pointed) && !walking(trail)) continue;
    const a = layout.byItemId.get(link.from);
    const b = layout.byItemId.get(link.to);
    if (!a || !b) continue;

    const step = stepFor(link, trail);
    const exempt =
      step !== null || touchesFocus(link, selection) || touchesFocus(link, pointed);

    const ax = sx(a.x);
    const ay = sy(a.y);
    const bx = sx(b.x);
    const by = sy(b.y);
    if (
      !onScreen(
        Math.min(ax, bx),
        Math.min(ay, by),
        Math.max(ax, bx),
        Math.max(ay, by),
        width,
        height,
        0,
      )
    ) {
      continue;
    }

    /*
     * A line with both of its ends off screen is not a connection anybody can
     * read; it is a stroke across the view that arrives from nowhere and leaves
     * for nowhere. The count budget alone does not catch it, because a long
     * line crosses the window far more often than a short one does — which is
     * exactly why a budget built on "how much of the map is on screen"
     * overshoots at a deep zoom. Measured on a 1,442-item project zoomed in to
     * one territory: 490 lines across the window against a budget of 120, and
     * **75 crossings on the average one** — worse per line than before any of
     * this, because the survivors were the longest lines on the map.
     *
     * Exempt lines are drawn whatever: a walk's own hops, and the lines
     * touching the selection or the pointer, are the answer to a question that
     * was just asked and their far end is what the person is being shown.
     */
    const endVisible =
      onScreen(ax, ay, ax, ay, width, height, END_SLACK) ||
      onScreen(bx, by, bx, by, width, height, END_SLACK);

    if (!exempt && (!endVisible || link.rank >= detail.linkCeiling)) {
      // Counted only where it would otherwise have been on screen: a line held
      // back somewhere the camera is not pointing is hidden from nobody.
      if (detail.links > 0) report.linksHeld++;
      continue;
    }

    /*
     * A walked line is drawn at full reach, whatever the zoom says.
     *
     * Every factor below is a way of saying "this line is not worth the
     * clutter right now": too many links on screen, dots too small to anchor
     * one, a connection crossing between territories. None of them is true of
     * a line the person just asked about — and `detail.links` being zero when
     * the whole map fits would otherwise erase the walk at exactly the zoom
     * where it is meant to be read.
     */
    const reach = step
      ? 1
      : detail.links *
        Math.min(itemAlphaFor(a.r, camera.scale), itemAlphaFor(b.r, camera.scale)) *
        linkStrength(link, selection, beam, trail) *
        (scene.grouped && link.crossing ? CROSSING_FADE : 1);
    const alpha = reach * LINK_ALPHA;
    if (alpha <= 0.02) continue;

    const span = spanBetween(
      ax,
      ay,
      bx,
      by,
      a.r * camera.scale + 1.5,
      b.r * camera.scale + 2.5,
      MIN_LINK_LENGTH,
    );
    if (!span) continue;

    threads.push({
      link,
      span: shifted(span, link.lane),
      alpha,
      step,
      words: null,
      at: 0.5,
      hole: 0,
      owner: null,
    });
    // A floor under a pathological graph. The rank ceiling above is what
    // actually holds the count down; this only catches a case it cannot.
    if (threads.length >= MAX_LINKS) break;
  }
  return threads;
}

/** Whether a word of this width fits on this line, sitting `at` of the way along it. */
function fitsAt(span: Span, textWidth: number, at: number): boolean {
  const half = textWidth / 2 + LABEL_CLEARANCE;
  return span.length * at >= half && span.length * (1 - at) >= half;
}

/**
 * Put a word on its line, in the quietest spot the line can offer it.
 *
 * Every stop that clears the things a word may never sit on — another word, a
 * dot — is scored by how many *lines* cross it, and the quietest wins. It is
 * drawn only if that best spot is below `MAX_LINES_THROUGH_A_WORD`; above it
 * the word is worth less than the noise it adds, and it is held back and
 * counted like everything else the map declines to draw.
 *
 * Stops are scanned in a fixed order and ties go to the earlier one, so the
 * midpoint wins whenever it is as quiet as anywhere else — which is where a
 * word belongs and where a reader expects it.
 */
function placeOnLine(
  field: LabelField,
  span: Span,
  textWidth: number,
  owner: string | null,
): number | null {
  let bestAt: number | null = null;
  let bestBox: OrientedBox | null = null;
  let quietest = Infinity;
  for (const at of RELATION_STOPS) {
    if (!fitsAt(span, textWidth, at)) continue;
    const box = relationBox(span, textWidth, at);
    // A word off the edge of the canvas is a text layout and a fill for nobody,
    // and this path does not go through `place`, which is where that test
    // normally lives. Leaving it out put eighty words a frame outside the
    // window — measured, because the count of words drawn stopped matching the
    // count of words on screen.
    if (!field.visible(box)) continue;
    if (!field.clear(box, WORD_AVOID, owner)) continue;
    const crossings = field.count(box, ["line"], owner);
    if (crossings < quietest) {
      quietest = crossings;
      bestAt = at;
      bestBox = box;
    }
    if (crossings === 0) break;
  }
  if (bestBox === null || quietest > MAX_LINES_THROUGH_A_WORD) return null;
  field.block(bestBox, "relation", owner);
  return bestAt;
}

/** The box a word occupies when it lies along a line at `at`. */
function relationBox(span: Span, textWidth: number, at: number): OrientedBox {
  const anchor = labelAnchorAt(span, at);
  return {
    cx: anchor.x,
    cy: anchor.y,
    width: textWidth,
    height: LABEL_SIZE * NAME_BOX_HEIGHT,
    angle: anchor.angle,
  };
}

/**
 * The numbers on a walk's own hops.
 *
 * Placed before every other word on the map, and never dropped. A walk with
 * step 2 missing is not a smaller picture, it is a wrong one: the reader counts
 * 1, 3, 4 and concludes the map lost a step that was never there. Everything
 * placed afterwards avoids these, which is how the exception stays cheap —
 * exactly one class of word insists, and it is the smallest one on screen.
 *
 * The relation word rides in front of the number where there is room, and is
 * dropped before the number is: "3" alone still places the hop in the sequence,
 * while "불러와요" alone loses the thing that made the line worth drawing.
 */
function placeWalkNumbers(
  ctx: CanvasRenderingContext2D,
  field: LabelField,
  threads: readonly Thread[],
  font: string,
): void {
  for (const thread of threads) {
    const step = thread.step;
    if (!step) continue;
    const both = `${step.order} · ${RELATION_WORDS[thread.link.relation].short}`;
    for (const words of [both, String(step.order)]) {
      const textWidth = widthOf(ctx, font, words);
      const at = placeOnLine(field, thread.span, textWidth, thread.owner);
      if (at === null) continue;
      thread.words = words;
      thread.at = at;
      thread.hole = textWidth / 2 + LABEL_CLEARANCE;
      break;
    }
    // Nowhere clear, and it is still drawn: this is the one word on the map
    // that a collision may not silence.
    if (thread.words === null && fitsAt(thread.span, widthOf(ctx, font, String(step.order)), 0.5)) {
      const words = String(step.order);
      const textWidth = widthOf(ctx, font, words);
      field.insist(relationBox(thread.span, textWidth, 0.5), "relation");
      thread.words = words;
      thread.at = 0.5;
      thread.hole = textWidth / 2 + LABEL_CLEARANCE;
    }
  }
}

/**
 * The name of each territory, and the line of folders under it.
 *
 * Two rules beyond the field, and both are about a name staying inside the land
 * it names. The size is **capped to the territory's own width**, because a name
 * wider than its district spills into the next one before any collision test
 * gets a say; and if the pair will not fit anywhere clear, the subline goes
 * first and the name goes last, because 화면 조각 without its folders is still a
 * name a person can read and the folders without the name are not.
 *
 * Measured before this existed: at the resting zoom on a 1,442-item project,
 * **seven pairs of territory names lying on each other** — on the one screen
 * this product opens with.
 */
function placeDistrictNames(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
  field: LabelField,
  sx: (x: number) => number,
  sy: (y: number) => number,
  strengthOfDistrict: (id: string) => number,
  report: FrameReport,
): DistrictLabel[] {
  const out: DistrictLabel[] = [];
  const { width, height, camera } = view;

  for (const district of scene.layout.districts) {
    const cx = sx(district.x);
    const cy = sy(district.y);
    const r = district.r * camera.scale;
    if (r < LABEL_MIN_SCREEN_R) continue;
    if (!onScreen(cx - r, cy - r, cx + r, cy + r, width, height, 0)) continue;

    // Shrunk to fit its own land before anything else is asked. A territory is
    // a disc with a gap around it, so a name inside that width cannot reach a
    // neighbour's name at all.
    let size = clamp(r * 0.24, DISTRICT_LABEL_MIN, 30);
    const room = r * 1.84;
    const font = (at: number) => `800 ${at}px ${view.font}`;
    while (size > DISTRICT_LABEL_MIN && widthOf(ctx, font(size), district.name) > room) {
      size -= 1;
    }
    const nameWidth = widthOf(ctx, font(size), district.name);

    const boxAt = (baseline: number, w: number, at: number): OrientedBox => ({
      cx,
      cy: baseline - at * 0.32,
      width: w,
      height: at * NAME_BOX_HEIGHT,
      angle: 0,
    });

    // Three heights inside the clear upper band the packing leaves for it.
    const baselines = [cy - r * 0.58, cy - r * 0.74, cy - r * 0.44];
    let nameBox: OrientedBox | null = null;
    let baseline = baselines[0];
    for (const candidate of baselines) {
      const box = boxAt(candidate, nameWidth, size);
      if (field.clear(box, ["district"], null)) {
        nameBox = field.place([box], "district", ["district"]);
        baseline = candidate;
        break;
      }
    }
    if (!nameBox) {
      report.labelsHeld++;
      continue;
    }

    const subline = `${district.count}개 · ${district.folder}`;
    const sublineSize = Math.max(DISTRICT_LABEL_MIN, size * 0.46);
    const sublineWidth = widthOf(ctx, font(sublineSize), subline);
    const sublineBox = field.place(
      [boxAt(baseline + size * 0.92, sublineWidth, sublineSize)],
      "district",
      ["district"],
    );
    if (!sublineBox) report.labelsHeld++;

    out.push({
      name: district.name,
      nameSize: size,
      nameBox,
      subline: sublineBox ? subline : null,
      sublineSize,
      sublineBox,
      strength: strengthOfDistrict(district.id),
    });
  }
  return out;
}

/**
 * Which items get their names, and where each one sits.
 *
 * Offered in `nameRank` order — round robin across territories, busiest first
 * inside each — so that the allowance is spread over the whole map rather than
 * spent inside whichever two districts happen to hold the busy things. The
 * ceiling comes from `NAME_BUDGET` and the zoom alone, so panning cannot change
 * which names are eligible; the field then decides which of those actually have
 * somewhere to sit, and every one it refuses is counted.
 *
 * Measured before this existed: 139 names on screen against a documented budget
 * of 36, and **502 pairs of them lying on each other**.
 */
function placeNames(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  detail: Detail,
  field: LabelField,
  dots: readonly Dot[],
  font: string,
  height: number,
  report: FrameReport,
): Map<string, PlacedName> {
  const placed = new Map<string, PlacedName>();
  if (detail.names <= 0) return placed;

  const eligible: { rank: number; dot: Dot }[] = [];
  for (const dot of dots) {
    if (dot.r < 2.5) continue;
    // The overlay writes these itself, at a brightness nothing else gets.
    if (scene.pointed.lit.has(dot.id)) continue;
    const rank = scene.nameRank.get(dot.id) ?? Number.MAX_SAFE_INTEGER;
    if (rank >= detail.nameCeiling) continue;
    eligible.push({ rank, dot });
  }
  eligible.sort((a, b) => a.rank - b.rank);

  for (const { dot } of eligible) {
    const item = scene.itemsById.get(dot.id);
    if (!item) continue;
    const text = displayNameOf(item);
    const textWidth = widthOf(ctx, font, text);
    const spot = field.place(
      nameCandidates(dot.cx, dot.cy, dot.r, textWidth, height),
      "name",
      ["dot", "district", "name", "relation"],
      dot.id,
    );
    if (!spot) {
      report.labelsHeld++;
      continue;
    }
    placed.set(dot.id, {
      ...spot,
      text,
      alpha: detail.names * dot.alpha * dot.strength,
      strong: false,
    });
  }
  return placed;
}

/**
 * Which lines carry their words.
 *
 * Last of everything, because a relation word is the one label on this map that
 * the picture has already half said: the line is there, its direction is drawn,
 * and the word adds the verb. Everything else — a territory's name, an item's
 * name, a walk's step number — tells the reader something the picture does not.
 *
 * Measured before the ceiling: **786 relation words on screen against a
 * documented budget of 28.**
 */
function placeRelations(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  detail: Detail,
  field: LabelField,
  threads: readonly Thread[],
  font: string,
  report: FrameReport,
): void {
  if (detail.relations <= 0) return;
  /*
   * While a walk is showing, no line but the walk's carries words.
   *
   * The other lines are still drawn — dimmed, never hidden (D59) — because they
   * are the shape of the project the walk happened inside. Their words are a
   * different matter: a label is read at whatever alpha it is drawn, so five
   * faint relation words sit at the same size and in the same place as the
   * numbers and compete with them for the one thing the person is trying to
   * follow. Dimming says "context". Keeping the words says "also read this".
   */
  if (walking(scene.trail)) return;
  for (const thread of threads) {
    if (thread.step || thread.words !== null) continue;
    if (thread.link.rank >= detail.relationCeiling) continue;
    /*
     * A dot is in the avoid list, and that is not obvious.
     *
     * A word on a line cannot touch the two dots its line runs between —
     * `fitsAt` keeps it clear of both ends — so the only dot it can land on is
     * some third item's, and a Korean word over a filled circle is a word
     * nobody reads. Measured before this: about a third of the relation words
     * at a deep zoom were sitting on another item.
     */
    const words = RELATION_WORDS[thread.link.relation].short;
    const textWidth = widthOf(ctx, font, words);
    const at = placeOnLine(field, thread.span, textWidth, thread.owner);
    if (at !== null) {
      thread.words = words;
      thread.at = at;
      thread.hole = textWidth / 2 + LABEL_CLEARANCE;
    } else if (fitsAt(thread.span, textWidth, 0.5)) {
      // Held back only where the line had room and something was already there.
      // A line too short to hold its own word is not a word the map is hiding.
      report.labelsHeld++;
    }
  }
}

/** One prepared line, put on the canvas. */
function paintThread(
  ctx: CanvasRenderingContext2D,
  thread: Thread,
  palette: Palette,
  font: string,
  width: number,
  height: number,
  report: FrameReport,
): void {
  const { span, link, step } = thread;
  drawThread(
    ctx,
    span,
    link.certainty,
    palette.wire,
    palette.guess,
    thread.alpha,
    // A line the answer rests on is drawn heavier than one merely walked
    // through. The loop already separates the two and the picture has to as
    // well, or "where it looked" and "what it found" arrive as one claim.
    step?.critical ? 2 : 1,
    thread.hole,
    thread.at,
    width,
    height,
  );
  report.linksDrawn++;
  if (span.length >= MIN_ARROW_LENGTH) {
    drawArrow(ctx, span, link.certainty === "certain" ? palette.wire : palette.guess, thread.alpha);
  }
  if (thread.words !== null) {
    drawRelation(
      ctx,
      span,
      thread.at,
      thread.words,
      font,
      // A walked line's number is said in the text colour, not the faint one.
      // It is the one thing on the map the person is reading right now.
      step ? palette.said : palette.saidFaint,
      // `detail.relations` is already folded into `alpha` for an ordinary word;
      // a walk's number is said at full strength at every zoom, because the
      // whole map fitting on screen is when a person most wants to follow it.
      step ? 1 : thread.alpha / LINK_ALPHA,
      palette.surface,
    );
    report.labelsDrawn++;
  }
}

/**
 * The neighbourhood of whatever is pointed at or selected.
 *
 * Decided here and painted last. Its words are placed straight after the
 * territories' names and before every ordinary one, because the user has just
 * asked what this thing is joined to and the answer is written on the lines
 * leaving it — the one case where a label is certainly worth the room.
 */
function planFocus(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
  field: LabelField,
  sx: (x: number) => number,
  sy: (y: number) => number,
  font: string,
  nameHeight: number,
  report: FrameReport,
): FocusPlan | null {
  const { layout, pointed } = scene;
  const { camera, width, height } = view;
  if (pointed.id === null) return null;
  const centre = layout.byItemId.get(pointed.id);
  if (!centre) return null;

  const plan: FocusPlan = {
    centre: {
      x: sx(centre.x),
      y: sy(centre.y),
      r: Math.max(centre.r * camera.scale, 3) + 4,
    },
    threads: [],
    rings: [],
    names: [],
  };

  // Every one of these lines first, so a word on one of them is not asked to
  // sit under another. The same two-pass shape as the ordinary threads, and for
  // the same reason.
  const reach: { link: MapLink; span: Span; owner: string }[] = [];
  for (const link of scene.links) {
    if (!touchesFocus(link, pointed)) continue;
    const a = layout.byItemId.get(link.from);
    const b = layout.byItemId.get(link.to);
    if (!a || !b) continue;
    const base = spanBetween(
      sx(a.x),
      sy(a.y),
      sx(b.x),
      sy(b.y),
      Math.max(a.r * camera.scale, 2.6) + 2,
      Math.max(b.r * camera.scale, 2.6) + 3,
      MIN_LINK_LENGTH,
    );
    if (!base) continue;
    const span = shifted(base, link.lane);
    const owner = `focus:${reach.length}`;
    field.blockLine(span.x0, span.y0, span.x1, span.y1, owner);
    reach.push({ link, span, owner });
  }

  let labelled = 0;
  for (const { link, span, owner } of reach) {
    const text = RELATION_WORDS[link.relation].short;
    const textWidth = widthOf(ctx, font, text);
    let words: string | null = null;
    let hole = 0;
    let at = 0.5;
    /*
     * The connections panel already caps its own list at 24 per direction and
     * says how many it left out; two dozen words fanned around one dot is
     * about where they start landing on each other anyway.
     */
    if (labelled < FOCUS_LABEL_CAP) {
      const stop = placeOnLine(field, span, textWidth, owner);
      if (stop !== null) {
        words = text;
        hole = textWidth / 2 + LABEL_CLEARANCE;
        at = stop;
        labelled++;
      } else if (fitsAt(span, textWidth, 0.5)) {
        report.labelsHeld++;
      }
    }
    plan.threads.push({ span, certainty: link.certainty, words, hole, at });
  }

  for (const id of pointed.lit) {
    if (id === pointed.id) continue;
    const other = layout.byItemId.get(id);
    if (!other) continue;
    const ox = sx(other.x);
    const oy = sy(other.y);
    const r = Math.max(other.r * camera.scale, 2.6) + 1.6;
    if (!onScreen(ox - r, oy - r, ox + r, oy + r, width, height, 60)) continue;
    plan.rings.push({ x: ox, y: oy, r });
    const item = scene.itemsById.get(id);
    if (!item) continue;
    const text = displayNameOf(item);
    const textWidth = widthOf(ctx, font, text);
    const spot = field.place(
      nameCandidates(ox, oy, r, textWidth, nameHeight),
      "name",
      ["dot", "district", "name", "relation"],
      id,
    );
    if (!spot) {
      report.labelsHeld++;
      continue;
    }
    plan.names.push({ ...spot, text, alpha: 0.92, strong: false });
  }

  const item = scene.itemsById.get(pointed.id);
  if (item) {
    const text = displayNameOf(item);
    const textWidth = widthOf(ctx, font, text);
    const candidates = nameCandidates(
      plan.centre.x,
      plan.centre.y,
      plan.centre.r,
      textWidth,
      nameHeight,
    );
    /*
     * The second word on this map that insists, and for the same kind of
     * reason as a walk's step number: it is the name of the thing the pointer
     * is on. A map that declined to say what you are pointing at because
     * something else got there first is not answering the question at all.
     */
    let spot: NamePlacement | null = null;
    for (const candidate of candidates) {
      if (field.clear(candidate, ["district", "name", "relation"], pointed.id)) {
        field.block(candidate, "name", pointed.id);
        spot = candidate;
        break;
      }
    }
    if (!spot) {
      field.insist(candidates[0], "name", pointed.id);
      spot = candidates[0];
    }
    plan.names.push({ ...spot, text, alpha: 1, strong: true });
  }

  return plan;
}

function paintFocus(
  ctx: CanvasRenderingContext2D,
  plan: FocusPlan,
  view: View,
  palette: Palette,
  font: string,
  report: FrameReport,
): void {
  for (const thread of plan.threads) {
    drawThread(
      ctx,
      thread.span,
      thread.certainty,
      palette.said,
      palette.saidSoft,
      0.92,
      1.6,
      thread.hole,
      thread.at,
      view.width,
      view.height,
    );
    report.linksDrawn++;
    if (thread.span.length >= MIN_ARROW_LENGTH) {
      drawArrow(
        ctx,
        thread.span,
        thread.certainty === "certain" ? palette.said : palette.saidSoft,
        0.92,
      );
    }
    if (thread.words !== null) {
      drawRelation(
        ctx,
        thread.span,
        thread.at,
        thread.words,
        font,
        palette.said,
        0.95,
        palette.surface,
      );
      report.labelsDrawn++;
    }
  }

  for (const ring of plan.rings) {
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = withAlpha(palette.said, 0.8);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(plan.centre.x, plan.centre.y, plan.centre.r, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = palette.lamp;
  ctx.stroke();

  for (const name of plan.names) {
    drawName(ctx, name, view.font, palette);
    report.labelsDrawn++;
  }
}

/**
 * One road between two districts.
 *
 * Certain and inferred travel side by side rather than merged, each as wide as
 * the number of connections it carries. The inferred band is hatched — a ladder
 * of ticks at a fixed pitch in SCREEN pixels — so that zooming out thins the
 * map without ever turning a guess into a fact. That pitch is the whole reason
 * this renderer keeps the context untransformed.
 */
function drawRoad(
  ctx: CanvasRenderingContext2D,
  road: Road,
  sx: (x: number) => number,
  sy: (y: number) => number,
  scale: number,
  palette: Palette,
  strength: number,
  width: number,
  height: number,
): void {
  // Start and end at the rims, so a road never runs under a district's name.
  const base = spanBetween(
    sx(road.a.x),
    sy(road.a.y),
    sx(road.b.x),
    sy(road.b.y),
    road.a.r * scale * 0.94,
    road.b.r * scale * 0.94,
    8,
  );
  if (!base) return;

  // Roads are the one thing on this map with no bounding box worth testing —
  // a road between two territories either side of the window crosses it while
  // both of its ends are off screen. The parametric clip answers both
  // questions at once: is any of it visible, and which part.
  const range = visibleRange(base, width, height, 24);
  if (!range) return;

  const { ux, uy, x0, y0 } = base;
  const px = -uy;
  const py = ux;

  const certainWidth = road.certain > 0 ? clamp(0.9 + Math.sqrt(road.certain) * 0.8, 1.2, 7) : 0;
  const inferredWidth = road.inferred > 0 ? clamp(0.9 + Math.sqrt(road.inferred) * 0.8, 1.2, 7) : 0;
  const bothShown = certainWidth > 0 && inferredWidth > 0;
  const certainOffset = bothShown ? -(inferredWidth / 2 + 1.5) : 0;
  const inferredOffset = bothShown ? certainWidth / 2 + 1.5 : 0;

  if (certainWidth > 0) {
    ctx.beginPath();
    ctx.moveTo(x0 + px * certainOffset, y0 + py * certainOffset);
    ctx.lineTo(
      x0 + ux * base.length + px * certainOffset,
      y0 + uy * base.length + py * certainOffset,
    );
    ctx.lineWidth = certainWidth;
    ctx.lineCap = "round";
    ctx.strokeStyle = withAlpha(palette.wire, 0.62 * strength);
    ctx.stroke();
  }

  if (inferredWidth > 0) {
    const half = inferredWidth / 2 + 1.2;
    ctx.lineWidth = 1;
    ctx.lineCap = "butt";
    ctx.strokeStyle = withAlpha(palette.guess, 0.95 * strength);
    ctx.beginPath();
    const end = Math.min(base.length, range.to);
    for (let t = hatchStart(range.from, HATCH_PITCH); t <= end; t += HATCH_PITCH) {
      const hx = x0 + ux * t + px * inferredOffset;
      const hy = y0 + uy * t + py * inferredOffset;
      ctx.moveTo(hx - px * half, hy - py * half);
      ctx.lineTo(hx + px * half, hy + py * half);
    }
    ctx.stroke();
    // A faint spine holds the ticks together as one road rather than a fence.
    ctx.beginPath();
    ctx.moveTo(x0 + px * inferredOffset, y0 + py * inferredOffset);
    ctx.lineTo(
      x0 + ux * base.length + px * inferredOffset,
      y0 + uy * base.length + py * inferredOffset,
    );
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = withAlpha(palette.guess, 0.45 * strength);
    ctx.stroke();
  }
}

/**
 * One item-to-item line. Same encoding as a road, at the scale of a single link.
 *
 * `hole` is the half-width of a gap left at the midpoint for the link's words.
 * The words are drawn ON the line, as in the reference picture, and a plate
 * behind them would be a dark box sitting on a tinted territory — visible as a
 * box, which the reference does not have. Cutting the line instead costs one
 * extra `moveTo` and looks like the line was drawn around the words.
 */
function drawThread(
  ctx: CanvasRenderingContext2D,
  span: Span,
  certainty: Certainty,
  solid: string,
  hatched: string,
  alpha: number,
  weight: number,
  hole: number,
  holeAt: number,
  width: number,
  height: number,
): void {
  // The gap travels with the words. They are not always at the midpoint any
  // more — the label field may slide one along its own line to keep it off a
  // word already placed — and a gap left behind at the middle would read as a
  // broken line beside a struck-through one.
  const mid = span.length * holeAt;
  const before = Math.max(0, mid - hole);
  const after = Math.min(span.length, mid + hole);
  const at = (t: number): [number, number] => [
    span.x0 + span.ux * t,
    span.y0 + span.uy * t,
  ];

  if (certainty === "certain") {
    ctx.beginPath();
    const [sx0, sy0] = at(0);
    const [sx1, sy1] = at(before);
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
    if (hole > 0) {
      const [sx2, sy2] = at(after);
      const [sx3, sy3] = at(span.length);
      ctx.moveTo(sx2, sy2);
      ctx.lineTo(sx3, sy3);
    }
    ctx.lineWidth = weight;
    ctx.lineCap = "round";
    ctx.strokeStyle = withAlpha(solid, alpha);
    ctx.stroke();
    return;
  }

  // A guess is a ladder, not a dashed line: at the zoom where a whole repo fits
  // on screen a dash and a solid stroke look identical, and this must not.
  const px = -span.uy;
  const py = span.ux;
  const half = 1.4 + weight;
  // Only the visible stretch is laddered. At a deep zoom a line between two
  // items can be thousands of pixels long with a dozen of them on screen, and
  // the pitch is fixed in screen pixels by design — so without this the cost of
  // one guessed connection would grow without bound as the user zooms in.
  const range = visibleRange(span, width, height, 16);
  if (!range) return;
  ctx.beginPath();
  const end = Math.min(span.length, range.to);
  for (let t = hatchStart(range.from, HATCH_PITCH); t <= end; t += HATCH_PITCH) {
    if (hole > 0 && t > before && t < after) continue;
    const [hx, hy] = at(t);
    ctx.moveTo(hx - px * half, hy - py * half);
    ctx.lineTo(hx + px * half, hy + py * half);
  }
  ctx.lineWidth = weight > 1.2 ? 1.2 : 0.9;
  ctx.lineCap = "butt";
  ctx.strokeStyle = withAlpha(hatched, alpha);
  ctx.stroke();

  ctx.beginPath();
  const [ax0, ay0] = at(0);
  const [ax1, ay1] = at(before);
  ctx.moveTo(ax0, ay0);
  ctx.lineTo(ax1, ay1);
  if (hole > 0) {
    const [ax2, ay2] = at(after);
    const [ax3, ay3] = at(span.length);
    ctx.moveTo(ax2, ay2);
    ctx.lineTo(ax3, ay3);
  }
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = withAlpha(hatched, alpha * 0.5);
  ctx.stroke();
}

/** The head at the far end. Filled, and a constant size in screen pixels. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  span: Span,
  colour: string,
  alpha: number,
): void {
  const arrow = arrowAt(span, ARROW_LENGTH, ARROW_HALF_WIDTH);
  ctx.beginPath();
  ctx.moveTo(arrow.tipX, arrow.tipY);
  ctx.lineTo(arrow.leftX, arrow.leftY);
  ctx.lineTo(arrow.rightX, arrow.rightY);
  ctx.closePath();
  ctx.fillStyle = withAlpha(colour, Math.min(1, alpha * 1.25));
  ctx.fill();
}

/** A link's relation, lying along the line it belongs to. */
function drawRelation(
  ctx: CanvasRenderingContext2D,
  span: Span,
  at: number,
  words: string,
  font: string,
  colour: string,
  alpha: number,
  palette: string,
): void {
  if (alpha <= 0.02) return;
  const anchor = labelAnchorAt(span, at);
  const tracked = ctx as Tracked;
  ctx.save();
  ctx.translate(anchor.x, anchor.y);
  ctx.rotate(anchor.angle);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  tracked.letterSpacing = "-0.02em";
  ctx.font = font;
  /*
   * The same halo an item's name carries, for the same reason.
   *
   * The gap `drawThread` cuts opens this word's OWN line and nothing else, and
   * at a deep zoom the label field measures an average of two and a half other
   * lines passing through the average word's box — it prefers a stop with none,
   * and takes a crossed one rather than leave the connection unnamed, because
   * measured the other way round (refusing every crossed stop) the relation
   * words on screen fell from about twenty to one. This is the mitigation for
   * the ones it accepts: a soft erase in the surface colour, not a plate, so
   * there is no box sitting on a tinted territory.
   */
  ctx.shadowColor = palette;
  ctx.shadowBlur = 5;
  ctx.fillStyle = withAlpha(colour, Math.min(1, alpha));
  ctx.fillText(words, 0, 0);
  ctx.shadowBlur = 0;
  tracked.letterSpacing = "0px";
  ctx.restore();
}

/**
 * An item's own name, under its dot.
 *
 * Under rather than inside. The reference picture sizes each circle to its
 * text, which this map cannot do: the radius already carries how connected a
 * thing is, and the packing in `layout.ts` gives its non-overlap guarantee from
 * a fixed pitch. Writing the name below keeps both, and the halo is what stops
 * it being eaten by whatever the dot is sitting on.
 */
function drawName(
  ctx: CanvasRenderingContext2D,
  placement: PlacedName,
  font: string,
  palette: Palette,
): void {
  if (placement.alpha <= 0.05) return;
  const tracked = ctx as Tracked;
  ctx.textAlign = placement.align;
  ctx.textBaseline = "top";
  tracked.letterSpacing = "-0.02em";
  ctx.font = `${placement.strong ? 600 : 500} ${LABEL_SIZE}px ${font}`;
  ctx.shadowColor = palette.surface;
  ctx.shadowBlur = 6;
  ctx.fillStyle = withAlpha(
    placement.strong ? palette.said : palette.saidSoft,
    Math.min(1, placement.alpha),
  );
  // The box the field reserved is the box the words go in, so the anchor is
  // worked back from it rather than being a second idea of where the name sits.
  const x =
    placement.align === "center"
      ? placement.cx
      : placement.align === "left"
        ? placement.cx - placement.width / 2
        : placement.cx + placement.width / 2;
  ctx.fillText(placement.text, x, placement.cy - placement.height / 2);
  ctx.shadowBlur = 0;
  tracked.letterSpacing = "0px";
}

/**
 * A territory's name, lying flat on the surface with its folders under it.
 *
 * The halo in the surface colour is what lets it stay readable over its own
 * items — the packing keeps the upper band of a territory clear for exactly
 * this, and the halo covers the rest.
 */
function drawDistrictLabel(
  ctx: CanvasRenderingContext2D,
  label: DistrictLabel,
  font: string,
  palette: Palette,
): void {
  const tracked = ctx as Tracked;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  tracked.letterSpacing = "-0.03em";
  ctx.shadowColor = palette.surface;
  ctx.shadowBlur = 8;

  ctx.font = `800 ${label.nameSize}px ${font}`;
  ctx.fillStyle = withAlpha(palette.said, 0.34 + 0.58 * label.strength);
  ctx.fillText(label.name, label.nameBox.cx, label.nameBox.cy + label.nameSize * 0.32);

  if (label.subline !== null && label.sublineBox !== null) {
    ctx.font = `500 ${label.sublineSize}px ${font}`;
    ctx.fillStyle = withAlpha(palette.saidFaint, 0.4 + 0.55 * label.strength);
    ctx.fillText(
      label.subline,
      label.sublineBox.cx,
      label.sublineBox.cy + label.sublineSize * 0.32,
    );
  }

  ctx.shadowBlur = 0;
  tracked.letterSpacing = "0px";
}
