import type { Certainty, GraphItem } from "@/lib/graph/view";
import { RELATION_WORDS } from "@/lib/graph/view";

import type { BeamResult } from "../beam";
import type { MapLayout, PlacedDistrict } from "../layout";

import {
  arrowAt,
  clamp,
  hatchStart,
  labelAnchor,
  onScreen,
  shifted,
  spanBetween,
  visibleRange,
  type Span,
} from "./geometry";
import {
  detailAt,
  itemAlphaFor,
  itemScreenRadius,
  labelFits,
  thresholdsFor,
  HUB_BOOST,
} from "./lod";
import { hueFor, withAlpha, type Palette } from "./palette";
import {
  itemStrength,
  linkStrength,
  touchesFocus,
  type Focus,
  type MapLink,
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

/** A guard for a pathological repo: never draw more thin lines than this in a frame. */
const MAX_LINKS = 2500;

/** Screen pixels of arrowhead. Constant, so direction survives every zoom. */
const ARROW_LENGTH = 7.5;
const ARROW_HALF_WIDTH = 3.2;

/** Shorter than this on screen and a line is a dot: no head, no words. */
const MIN_LINK_LENGTH = 9;
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

export function drawMap(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
): void {
  const { width, height, dpr, camera, palette } = view;
  const { layout, roads, beam, selection, pointed } = scene;

  // No transform on the context beyond the device pixel ratio. Everything below
  // converts to screen coordinates itself, which is what makes line widths,
  // text sizes and above all the hatch pitch independent of the zoom.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, width, height);

  const sx = (x: number) => (x - camera.x) * camera.scale + width / 2;
  const sy = (y: number) => (y - camera.y) * camera.scale + height / 2;

  const detail = detailAt(
    thresholdsFor({
      linkCount: scene.links.length,
      itemCount: layout.items.length,
      mapArea:
        Math.max(layout.bounds.maxX - layout.bounds.minX, 1) *
        Math.max(layout.bounds.maxY - layout.bounds.minY, 1),
      viewWidth: width,
      viewHeight: height,
      fitScale: view.fitScale,
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
  const anythingDimmed = beam.active || selection.id !== null;
  if (anythingDimmed) {
    for (const placed of layout.items) {
      const strength = itemStrength(placed.id, selection, beam);
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

  // 3. The names, lying flat on the surface.
  const tracked = ctx as Tracked;
  for (const district of layout.districts) {
    const cx = sx(district.x);
    const cy = sy(district.y);
    const r = district.r * camera.scale;
    if (r < LABEL_MIN_SCREEN_R) continue;
    if (!onScreen(cx - r, cy - r, cx + r, cy + r, width, height, 0)) continue;

    const strength = strengthOfDistrict(district.id);
    const size = clamp(r * 0.24, 11, 30);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    tracked.letterSpacing = "-0.03em";
    ctx.font = `800 ${size}px ${view.font}`;
    // A halo in the surface colour, so a name stays readable over its own items.
    ctx.shadowColor = palette.surface;
    ctx.shadowBlur = 8;
    ctx.fillStyle = withAlpha(palette.said, 0.34 + 0.58 * strength);
    ctx.fillText(district.name, cx, cy - r * 0.58);

    ctx.font = `500 ${Math.max(10, size * 0.46)}px ${view.font}`;
    ctx.fillStyle = withAlpha(palette.saidFaint, 0.4 + 0.55 * strength);
    ctx.fillText(`${district.count}개 · ${district.folder}`, cx, cy - r * 0.58 + size * 0.92);
    ctx.shadowBlur = 0;
    tracked.letterSpacing = "0px";
  }

  const labelFont = `500 ${LABEL_SIZE}px ${view.font}`;

  // 4. The lines between individual items, but only once you have come in close
  //    enough that they describe a neighbourhood instead of covering the map in
  //    string. The ones touching the selection are skipped here and drawn over
  //    everything in step 6, so a bright line is never crossed by a dim one.
  if (detail.links > 0) {
    let drawn = 0;
    for (const link of scene.links) {
      if (touchesFocus(link, pointed)) continue;
      const a = layout.byItemId.get(link.from);
      const b = layout.byItemId.get(link.to);
      if (!a || !b) continue;

      const reach =
        detail.links *
        Math.min(itemAlphaFor(a.r, camera.scale), itemAlphaFor(b.r, camera.scale)) *
        linkStrength(link, selection, beam) *
        (scene.grouped && link.crossing ? CROSSING_FADE : 1);
      const alpha = reach * LINK_ALPHA;
      if (alpha <= 0.02) continue;

      const ax = sx(a.x);
      const ay = sy(a.y);
      const bx = sx(b.x);
      const by = sy(b.y);
      if (!onScreen(
        Math.min(ax, bx),
        Math.min(ay, by),
        Math.max(ax, bx),
        Math.max(ay, by),
        width,
        height,
        0,
      )) {
        continue;
      }

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
      const laid = shifted(span, link.lane);

      const words =
        detail.relations > 0 && link.rank < detail.rankCeiling
          ? RELATION_WORDS[link.relation].short
          : null;
      const textWidth = words === null ? 0 : widthOf(ctx, labelFont, words);
      const room =
        words !== null && labelFits(laid.length, textWidth, LABEL_CLEARANCE);

      drawThread(
        ctx,
        laid,
        link.certainty,
        palette.wire,
        palette.guess,
        alpha,
        1,
        room ? textWidth / 2 + LABEL_CLEARANCE : 0,
        width,
        height,
      );
      if (laid.length >= MIN_ARROW_LENGTH) {
        drawArrow(ctx, laid, link.certainty === "certain" ? palette.wire : palette.guess, alpha);
      }
      if (room && words !== null) {
        drawRelation(ctx, laid, words, labelFont, palette.saidFaint, detail.relations * reach);
      }

      if (++drawn > MAX_LINKS) break;
    }
  }

  // 5. The items.
  const namesOn = detail.names > 0;
  for (const placed of layout.items) {
    const hub = scene.hubs.get(placed.districtId) === placed.id;
    const alpha = itemAlphaFor(placed.r * (hub ? HUB_BOOST : 1), camera.scale);
    if (alpha <= 0.02) continue;
    const cx = sx(placed.x);
    const cy = sy(placed.y);
    const r = itemScreenRadius(placed.r, camera.scale, hub);
    if (!onScreen(cx - r, cy - r, cx + r, cy + r, width, height, 0)) continue;

    const district = layout.byDistrictId.get(placed.districtId);
    const hue = hueFor(palette, district?.hue ?? 0, scene.grouped);
    const strength = itemStrength(placed.id, selection, beam);

    // A ring in the surface colour, so two dots that touch still read as two
    // things. The reference picture does this in white on paper; the same idea
    // on a dark sheet is a ring in the sheet's own colour.
    if (r >= 3) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 1.1, 0, Math.PI * 2);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = withAlpha(palette.surface, 0.85 * alpha);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(hue, alpha * strength * 0.95);
    ctx.fill();

    // The hub carries a mark rather than an icon: the product has no icon set,
    // and inventing one would be a claim about what this thing IS, which the
    // map cannot make. A ring says only "this is the busiest thing here",
    // which is exactly what was measured.
    if (hub && r >= 7) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.44, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(palette.surface, 0.9 * alpha);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.17, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(hue, alpha * strength);
      ctx.fill();
    }

    if (namesOn && r >= 2.5 && !pointed.lit.has(placed.id)) {
      const item = scene.itemsById.get(placed.id);
      if (item) {
        drawName(
          ctx,
          cx,
          cy + r,
          displayNameOf(item),
          view.font,
          palette,
          detail.names * alpha * strength,
          false,
        );
      }
    }
  }

  // 6. The neighbourhood of whatever is pointed at or selected, over everything.
  if (pointed.id !== null) {
    const centre = layout.byItemId.get(pointed.id);
    if (centre) {
      let labelled = 0;
      for (const link of scene.links) {
        if (!touchesFocus(link, pointed)) continue;
        const a = layout.byItemId.get(link.from);
        const b = layout.byItemId.get(link.to);
        if (!a || !b) continue;
        const span = spanBetween(
          sx(a.x),
          sy(a.y),
          sx(b.x),
          sy(b.y),
          Math.max(a.r * camera.scale, 2.6) + 2,
          Math.max(b.r * camera.scale, 2.6) + 3,
          MIN_LINK_LENGTH,
        );
        if (!span) continue;
        const laid = shifted(span, link.lane);

        const words = RELATION_WORDS[link.relation].short;
        const textWidth = widthOf(ctx, labelFont, words);
        // A selection's own links are the one case where words are always
        // worth drawing, so the only test left is whether they physically fit.
        const room =
          labelled < FOCUS_LABEL_CAP && labelFits(laid.length, textWidth, LABEL_CLEARANCE);

        drawThread(
          ctx,
          laid,
          link.certainty,
          palette.said,
          palette.saidSoft,
          0.92,
          1.6,
          room ? textWidth / 2 + LABEL_CLEARANCE : 0,
          width,
          height,
        );
        if (laid.length >= MIN_ARROW_LENGTH) {
          drawArrow(
            ctx,
            laid,
            link.certainty === "certain" ? palette.said : palette.saidSoft,
            0.92,
          );
        }
        if (room) {
          drawRelation(ctx, laid, words, labelFont, palette.said, 0.95);
          labelled++;
        }
      }

      for (const id of pointed.lit) {
        if (id === pointed.id) continue;
        const other = layout.byItemId.get(id);
        if (!other) continue;
        const ox = sx(other.x);
        const oy = sy(other.y);
        const r = Math.max(other.r * camera.scale, 2.6) + 1.6;
        if (!onScreen(ox - r, oy - r, ox + r, oy + r, width, height, 60)) continue;
        ctx.beginPath();
        ctx.arc(ox, oy, r, 0, Math.PI * 2);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = withAlpha(palette.said, 0.8);
        ctx.stroke();
        const item = scene.itemsById.get(id);
        // A lit neighbour keeps its name at every zoom the dot survives: this
        // is the moment the name is the answer, and the reference picture's
        // whole claim is that you can read the sentence off the line.
        if (item) {
          drawName(ctx, ox, oy + r, displayNameOf(item), view.font, palette, 0.92, false);
        }
      }

      const cx = sx(centre.x);
      const cy = sy(centre.y);
      const r = Math.max(centre.r * camera.scale, 3) + 4;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = palette.lamp;
      ctx.stroke();
      const item = scene.itemsById.get(pointed.id);
      if (item) {
        drawName(ctx, cx, cy + r, displayNameOf(item), view.font, palette, 1, true);
      }
    }
  }

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
  width: number,
  height: number,
): void {
  const mid = span.length / 2;
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
  words: string,
  font: string,
  colour: string,
  alpha: number,
): void {
  if (alpha <= 0.02) return;
  const anchor = labelAnchor(span);
  const tracked = ctx as Tracked;
  ctx.save();
  ctx.translate(anchor.x, anchor.y);
  ctx.rotate(anchor.angle);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  tracked.letterSpacing = "-0.02em";
  ctx.font = font;
  ctx.fillStyle = withAlpha(colour, Math.min(1, alpha));
  ctx.fillText(words, 0, 0);
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
  cx: number,
  baseline: number,
  name: string,
  font: string,
  palette: Palette,
  alpha: number,
  strong: boolean,
): void {
  if (alpha <= 0.05) return;
  const tracked = ctx as Tracked;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  tracked.letterSpacing = "-0.02em";
  ctx.font = `${strong ? 600 : 500} ${LABEL_SIZE}px ${font}`;
  ctx.shadowColor = palette.surface;
  ctx.shadowBlur = 6;
  ctx.fillStyle = withAlpha(strong ? palette.said : palette.saidSoft, Math.min(1, alpha));
  ctx.fillText(name, cx, baseline + 3);
  ctx.shadowBlur = 0;
  tracked.letterSpacing = "0px";
}
