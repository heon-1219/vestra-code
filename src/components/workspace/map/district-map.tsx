"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import { describeAll } from "@/lib/graph/describe";
import type { GraphConnection, GraphItem } from "@/lib/graph/view";
import { KIND_WORDS } from "@/lib/graph/view";
import type { QaTrail } from "@/qa";

import { previewTargetFor } from "../preview/file-preview";

import { beamOf, buildBeamIndex, runBeam } from "./beam";
import {
  districtLookup,
  groupItems,
  groupingOptions,
  resolveGrouping,
  DEFAULT_GROUPING,
  GROUPING_WORDS,
  type Grouping,
} from "./grouping";
import { layoutMap, type PlacedDistrict } from "./layout";
import { HUB_BOOST, itemAlphaFor, MAX_SCALE, MIN_SCALE } from "./render/lod";
import {
  drawMap,
  displayNameOf,
  heldBackSentence,
  type Camera,
  type FrameReport,
  type Road,
  type Scene,
} from "./render/paint";
import { FALLBACK, readPalette, type Palette } from "./render/palette";
import {
  buildAdjacency,
  buildLinks,
  colourCarriesGrouping,
  focusOf,
  hubsOf,
  nameRanks,
  NO_FOCUS,
  type Trail,
} from "./render/scene";
import { trailFrom } from "./render/walk";

/**
 * The map of the app. D59's resting screen.
 *
 * ## Why canvas and not SVG
 *
 * Three reasons, in the order they decided it.
 *
 *  1. **The hatch has to be drawn in screen space.** `certain` versus
 *     `inferred` is a texture, not a dashed line, because at the zoom where a
 *     real repo fits on screen a 1px dash and a 1px solid stroke are the same
 *     stroke — the honesty guarantee would silently degrade to nothing exactly
 *     where it matters (UI_DIRECTION section 2). SVG's `pattern` and
 *     `stroke-dasharray` both live in user space and scale with the zoom
 *     transform, which is warning 1 of section 5 restated. So this renderer
 *     never puts a transform on the context at all: every primitive is
 *     converted to screen coordinates in `render/paint.ts`, and the hatch pitch
 *     is a constant number of screen pixels by construction. There is nothing
 *     left to get wrong at a different zoom. Arrowheads, the words on a line
 *     and the gap cut in a line to hold them all follow the same rule.
 *  2. **The beam repaints everything on every keystroke.** In canvas that is
 *     one clear and one pass. In SVG it is hundreds of attribute mutations and
 *     a style recalc, per keystroke, while a Korean IME is composing.
 *  3. **300+ items must stay smooth.** One `<canvas>` against 300+ elements
 *     plus their labels.
 *
 * The cost of canvas is that nothing in it is reachable by a screen reader or
 * the keyboard, so the picture is mirrored as real DOM underneath it — a list
 * of districts and their items, each one a button that selects the same thing a
 * click would, plus a sentence saying what the picture is currently doing. It
 * is not decoration; it is the only way in for anyone not using a mouse, and
 * **every visual state has to reach it**: a dimmed item is still in the list,
 * still focusable and still selectable, because dimming means "the map is not
 * talking about this right now" and never "this is gone".
 *
 * ## What is idle
 *
 * There is no animation loop. A frame is drawn when something changed — a pan,
 * a zoom, a hover crossing an item, a keystroke, a batch of new items during a
 * live run — and then nothing runs at all until the next change. The one
 * exception is the short camera tween when you click a district, which stops
 * itself, and which is skipped entirely under `prefers-reduced-motion`.
 *
 * ## Where the decisions live
 *
 * This file wires React to a canvas and mirrors the picture into the DOM.
 * Anything that is a *rule* — what counts as connected, who stays lit, when a
 * connection is allowed to say its name, which colour a territory wears — is in
 * `render/` or `layout.ts`, under test. A rule inside a draw call is a rule
 * nobody can check.
 */

export type DistrictMapProps = {
  items: readonly GraphItem[];
  connections: readonly GraphConnection[];
  /**
   * What the beam is lighting. Typing dims everything else to 30%, never to
   * zero (D59) — a map that goes black tells an already-anxious person their
   * project vanished.
   *
   * The input that produces this lives with whoever owns the workspace shell,
   * and section 5's warning 2 applies to it there: if that input ever moves, it
   * moves by layout and never by remounting, because a remount destroys the
   * IME's composition state and eats a half-typed 한글 syllable.
   */
  query?: string;
  /**
   * What a territory IS. The map is indifferent to the answer — it packs named
   * places and the things inside them — so switching is a different picture of
   * the same project, never a different project.
   *
   * Judged again here through `groupingOptions` / `resolveGrouping` rather than
   * trusted. The prop is public and nothing forces a caller through the
   * control, and grouping.ts's judgement — "58개가 파일 하나에 몰려 있어서 한
   * 덩어리가 돼요" — is the difference between a map and a circle. Drawing a
   * picture that file has already said is unreadable would be inventing a
   * second grouping system with worse judgement than the first.
   */
  grouping?: Grouping;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /**
   * Open this item's file. Double-clicking an item on the canvas asks for it,
   * and so does the 열어보기 button beside every item in the reachable list
   * below the canvas — a keyboard has no double click.
   */
  onOpen?: (id: string) => void;
  onHoverChange?: (id: string | null) => void;
  /**
   * The walk an answer was found by, when one is showing.
   *
   * **This takes the lighting over from the selection while it is set.** A
   * walk and a neighbourhood are two different answers to "what should I be
   * looking at", and showing both at once leaves the reader to guess which one
   * came from the question they asked. Clear it to hand the map back.
   */
  trail?: QaTrail | null;
  /**
   * A flow being followed, already in the renderer's own vocabulary.
   *
   * Separate from `trail` rather than folded into it because the two arrive in
   * different shapes and only one of them needs translating: `src/qa/trail.ts`
   * speaks in points and hops and is joined to the renderer by
   * `render/walk.ts`, while a flow is joined by `flow/trail.ts` — which also has
   * to trim the path to however much of it the reader has been shown, a
   * question an investigation's walk does not have.
   *
   * **It takes the lighting over from both the selection and the walk.** A
   * flow, a neighbourhood and an investigation are three answers to "what am I
   * looking at", and two of them on screen at once leaves the reader to work
   * out which one their question produced — `scene.ts`'s own warning about a
   * second private idea of "near", applied to the third.
   */
  flow?: Trail | null;
  /**
   * The item the reader is on right now, which the camera keeps in view.
   *
   * Only moves the camera when the item is **not already on screen**. At the
   * resting zoom the whole map fits, so a camera that recentred on every step
   * would slide the picture under someone who can already see where the step
   * went — motion with nothing gained, which is the one kind this product does
   * not spend. Under `prefers-reduced-motion` the move is instant, the rule
   * `zoomToDistrict` already follows.
   */
  centreOn?: string | null;
  /**
   * A set of items to light instead of whatever is typed, when one is set.
   *
   * This is the same light the query produces, aimed by something else — a
   * change picked in the 변경 기록 band lights the places that live in the
   * files it touched, which is "this set of items matches", which is what the
   * beam already means. See `beamOf` in `beam.ts` for why it is not a fourth
   * dimming path of its own.
   *
   * It replaces the query rather than combining with it, and the two are kept
   * mutually exclusive by whoever owns them, so the map never dims for two
   * reasons at once.
   */
  highlight?: ReadonlySet<string> | null;
  className?: string;
};

const FIT_PADDING = 56;

function sayWhatWasHeldBack(
  element: HTMLParagraphElement | null,
  report: FrameReport,
): void {
  if (!element) return;
  const sentence = heldBackSentence(report);
  // Compared before writing: a `textContent` assignment is a DOM mutation and
  // this runs on every frame of a drag.
  if (element.textContent !== sentence) element.textContent = sentence;
  element.hidden = sentence === "";
}

const TWEEN_MS = 260;

/**
 * How many of a district's items get a real button underneath the canvas.
 *
 * Enough that every project we can analyse today is fully reachable without a
 * mouse, capped so a pathological repo cannot put ten thousand buttons in the
 * document. The remainder is counted out loud rather than silently dropped.
 */
const SR_ITEMS_PER_DISTRICT = 300;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function DistrictMap({
  items,
  connections,
  query = "",
  grouping = DEFAULT_GROUPING,
  selectedId = null,
  onSelect,
  onOpen,
  onHoverChange,
  trail: qaTrail = null,
  flow = null,
  centreOn = null,
  highlight = null,
  className,
}: DistrictMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * The canvas is sized from its CONTAINER, never from the window.
   *
   * D61, learned on the landing page: `window.innerWidth` includes the vertical
   * scrollbar and the content box does not, so a self-sizing canvas lands wider
   * than the space it occupies and puts a horizontal scrollbar on the page. A
   * ResizeObserver rather than a resize listener, because this container also
   * changes width when the workspace's side panels move, and that fires no
   * window resize event at all.
   */
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      setSize((previous) =>
        previous && previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Which grouping is actually drawable, and whether colour is allowed to mean
   * anything under it.
   *
   * Both answers come from `grouping.ts`. The cost is that `groupingOptions`
   * groups the project once per grouping — five cheap passes, memoised on the
   * graph rather than on the chosen grouping, so switching grouping does not
   * pay it again and a keystroke never pays it at all.
   */
  const options = useMemo(() => groupingOptions(items, connections), [items, connections]);
  const inForce = useMemo(() => resolveGrouping(options, grouping), [options, grouping]);

  const layout = useMemo(
    () => layoutMap(items, districtLookup(groupItems(items, connections, inForce))),
    [items, connections, inForce],
  );

  /**
   * The founder's "묶는 기준이 정의 되었을 때만", as a condition the picture checks.
   *
   * When it is false every territory is drawn in one quiet colour instead of
   * six. Six colours that distinguish nothing look exactly like six colours
   * that do, and this map is read by someone who will reasonably assume the
   * colours mean something.
   */
  const grouped = useMemo(
    () =>
      colourCarriesGrouping(
        options.find((option) => option.id === inForce),
        layout.districts.length,
      ),
    [options, inForce, layout],
  );

  const itemsById = useMemo(() => {
    const map = new Map<string, GraphItem>();
    for (const item of items) map.set(item.id, item);
    return map;
  }, [items]);

  /**
   * Roads: every connection that leaves its district, added up.
   *
   * At the resting zoom the map draws roads between territories rather than a
   * line per connection — which is the entire difference between a district map
   * and the hairball D59 exists to avoid. `contains` never appears here: a file
   * and the pieces inside it always share a district, so that relationship is
   * already said by the pieces sitting inside the territory.
   *
   * Certain and inferred are counted apart and drawn apart, because a road that
   * merged them would have to pick one texture and would be lying either way.
   */
  const roads = useMemo(() => {
    const tally = new Map<string, Road>();
    for (const connection of connections) {
      const from = layout.byItemId.get(connection.from);
      const to = layout.byItemId.get(connection.to);
      if (!from || !to || from.districtId === to.districtId) continue;
      const a = layout.byDistrictId.get(from.districtId);
      const b = layout.byDistrictId.get(to.districtId);
      if (!a || !b) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const existing = tally.get(key) ?? {
        a: a.id < b.id ? a : b,
        b: a.id < b.id ? b : a,
        certain: 0,
        inferred: 0,
      };
      if (connection.certainty === "certain") existing.certain++;
      else existing.inferred++;
      tally.set(key, existing);
    }
    return [...tally.values()];
  }, [connections, layout]);

  /** Every drawable connection, in rank order, with its lane and its direction. */
  const links = useMemo(() => buildLinks(items, connections, layout), [items, connections, layout]);
  const adjacency = useMemo(() => buildAdjacency(links), [links]);
  const hubs = useMemo(() => hubsOf(layout, items), [layout, items]);
  /**
   * The order items get their names in when there is not room for all of them.
   *
   * Memoised on the layout rather than computed per frame: it is a fact about
   * the graph and the grouping, and a pan or a zoom changes neither.
   */
  const nameRank = useMemo(() => nameRanks(layout, items), [layout, items]);

  const beamIndex = useMemo(() => buildBeamIndex(items), [items]);
  /*
   * One light, two switches. A highlight handed in replaces the typed query
   * rather than adding to it — see `beamOf` for why a change's items are a
   * beam and not a fourth way of dimming the map.
   *
   * An EMPTY highlight is not a highlight. It is the common answer on a
   * shallowly-analysed project, where a commit to a README or a config touches
   * nothing the map holds, and treating it as one would take the query's light
   * away and put nothing in its place: the person's own search would go out
   * because of a change they clicked on. The set being empty is said in words
   * by the band instead.
   */
  const highlighting = highlight !== null && highlight.size > 0;
  const beam = useMemo(
    () => (highlighting && highlight ? beamOf(highlight) : runBeam(beamIndex, query)),
    [highlighting, highlight, beamIndex, query],
  );

  /**
   * Where the map says how much it held back.
   *
   * Written straight into the DOM from the draw pass rather than through
   * React state, and that is not an optimisation — it is the only way the
   * sentence can be *true*. The counts belong to a frame, and frames happen
   * under a dragging hand at sixty a second; routing them through `setState`
   * would put a React render inside every one of those frames, which is the
   * whole budget (the same measurement that made `MapOutline` a memo).
   *
   * Not a live region. It changes while the user pans, and a live region would
   * read the number aloud on every frame of the drag.
   */
  const heldRef = useRef<HTMLParagraphElement>(null);

  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const tweenRef = useRef<{ from: Camera; to: Camera; started: number } | null>(null);
  const frameRef = useRef(0);
  const paletteRef = useRef<Palette>(FALLBACK);
  /** The zoom that last showed the whole map, which every level of detail is measured against. */
  const fitScaleRef = useRef(1);
  const fontRef = useRef("system-ui, sans-serif");
  const userMovedRef = useRef(false);

  /**
   * The hovered item, with the screen position its tooltip hangs from.
   *
   * The position is worked out in the pointer handler, where the camera is
   * readable, rather than while rendering — and it is why panning and zooming
   * drop the hover rather than leaving a label floating away from its item.
   */
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoverRef = useRef<string | null>(null);
  const hoverId = hover?.id ?? null;

  /**
   * Two neighbourhoods, one rule.
   *
   * `selection` is what the user chose, and it is **the only thing that dims
   * the rest of the map**: dimming is an answer to a decision. `pointed` is
   * what the pointer happens to be over, and it only adds brightness — a map
   * that dimmed under the pointer would flash the whole picture every time a
   * hand crossed it, which reads as a fault rather than as an answer.
   *
   * Both are one hop, which is `focusOf`'s decision and not a second one: the
   * connections panel beside this map defaults to one hop, and two different
   * ideas of "near" on one screen is two answers to one question.
   */
  const selection = useMemo(
    () => focusOf(selectedId, adjacency),
    [selectedId, adjacency],
  );
  const pointed = useMemo(
    () => focusOf(hoverId ?? selectedId, adjacency),
    [hoverId, selectedId, adjacency],
  );

  // Translated once per change rather than per frame: the draw pass runs at 60
  // a second and this builds two sets. A flow arrives already translated — by
  // `flow/trail.ts`, the same kind of join `render/walk.ts` is — and wins,
  // because it is the more recent answer to the reader's question.
  const walked = useMemo(() => trailFrom(qaTrail), [qaTrail]);
  const trail = flow ?? walked;

  /**
   * Everything the draw pass reads, in one ref.
   *
   * Drawing reads from a ref rather than from props so that a pan, a zoom or a
   * hover can repaint without a React render — at 60 frames a second while
   * dragging, a render per frame is the whole budget.
   */
  const sceneRef = useRef<Scene>({
    layout,
    roads,
    links,
    itemsById,
    hubs,
    nameRank,
    grouped,
    beam,
    selection: NO_FOCUS,
    pointed: NO_FOCUS,
    selectedId,
    trail,
    size,
  });

  // Kept in step after every render, and declared before every effect that asks
  // for a frame, so a frame is never drawn from one render behind.
  useEffect(() => {
    sceneRef.current = {
      layout,
      roads,
      links,
      itemsById,
      hubs,
      nameRank,
      grouped,
      beam,
      selection,
      pointed,
      selectedId,
      trail,
      size,
    };
  });

  // The scheduler and the painter refer to each other, so the painter is reached
  // through a ref: one rAF is in flight at most, and it is always the current one.
  const drawRef = useRef<() => void>(() => {});

  const requestDraw = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      drawRef.current();
    });
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    const measured = scene.size;
    if (!canvas || !measured || measured.width === 0 || measured.height === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Cap the pixel ratio: a 3x phone screen triples the fill cost for a
    // difference nobody can see on a map made of soft shapes.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = measured;
    const pixelWidth = Math.floor(width * dpr);
    const pixelHeight = Math.floor(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const tween = tweenRef.current;
    if (tween) {
      const t = clamp((performance.now() - tween.started) / TWEEN_MS, 0, 1);
      const eased = t * t * (3 - 2 * t);
      cameraRef.current = {
        x: tween.from.x + (tween.to.x - tween.from.x) * eased,
        y: tween.from.y + (tween.to.y - tween.from.y) * eased,
        scale: tween.from.scale + (tween.to.scale - tween.from.scale) * eased,
      };
      if (t >= 1) tweenRef.current = null;
    }

    const report = drawMap(ctx, scene, {
      width,
      height,
      dpr,
      camera: cameraRef.current,
      palette: paletteRef.current,
      font: fontRef.current,
      fitScale: fitScaleRef.current,
    });
    sayWhatWasHeldBack(heldRef.current, report);

    // The only thing that ever asks for another frame. When the tween ends the
    // loop stops completely, which is what "idle at rest" means here.
    if (tweenRef.current) requestDraw();
  }, [requestDraw]);

  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  /** Colours and the font come from the document, once. */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    paletteRef.current = readPalette(el);
    const family = getComputedStyle(el).fontFamily;
    if (family) fontRef.current = family;
    requestDraw();
  }, [requestDraw]);

  const fitToBounds = useCallback(() => {
    const scene = sceneRef.current;
    const measured = scene.size;
    if (!measured) return;
    /*
     * A container with no width is a measurement, not a view to fit.
     *
     * The workspace's panes are resizable and one of them can be dragged shut
     * or maximised over this one, and a ResizeObserver reports that as a real
     * 0×0 box. Fitting to it would set `fitScaleRef` to the minimum zoom — and
     * `fitScaleRef` is what every level of detail is measured against, so the
     * map would come back with item lines and their words switched on at the
     * resting zoom: the exact tangle the thresholds exist to prevent, arriving
     * with no error and no obvious cause. Ignoring the measurement leaves the
     * last good fit in place, and the observer fires again with a real box the
     * moment the pane reopens, which re-fits properly.
     */
    if (measured.width <= 0 || measured.height <= 0) return;
    const { bounds } = scene.layout;
    const worldWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const worldHeight = Math.max(bounds.maxY - bounds.minY, 1);
    const scale = clamp(
      Math.min(
        (measured.width - FIT_PADDING * 2) / worldWidth,
        (measured.height - FIT_PADDING * 2) / worldHeight,
      ),
      MIN_SCALE,
      MAX_SCALE,
    );
    fitScaleRef.current = scale;
    cameraRef.current = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      scale,
    };
    tweenRef.current = null;
    requestDraw();
  }, [requestDraw]);

  /**
   * Keep the whole map in view while it is being built, and stop the moment the
   * user takes the wheel. During a live run items arrive in batches and the map
   * grows; re-fitting is what makes that look like a map filling in rather than
   * a picture jumping around. But once someone has panned somewhere on purpose,
   * moving their view out from under them is the rudest thing this screen could
   * do.
   */
  const groupingRef = useRef(inForce);
  useEffect(() => {
    /*
     * A new grouping is a new picture, so the view is fitted again even for
     * someone who had panned somewhere on purpose. The territory they were
     * looking into does not exist under the next grouping — keeping their
     * camera would leave them staring at blank paper and wondering where their
     * project went. Everything else about their place is kept: the selection
     * stands, and the item they had chosen is still on screen.
     */
    if (groupingRef.current !== inForce) {
      groupingRef.current = inForce;
      userMovedRef.current = false;
    }
    if (userMovedRef.current) {
      requestDraw();
      return;
    }
    fitToBounds();
  }, [layout, size, inForce, fitToBounds, requestDraw]);

  useEffect(() => {
    requestDraw();
  }, [beam, selection, pointed, grouped, roads, links, hubs, trail, requestDraw]);

  /**
   * Keep the step the reader is on where they can see it.
   *
   * **Only when it is off screen.** At the resting zoom the whole map fits, so
   * a camera that recentred on every step of a flow would slide the picture
   * sideways under somebody who can already see exactly where the step went:
   * motion with nothing gained, on a product whose one rule about motion is
   * that it has to be carrying information. The test is the real one — is this
   * item's dot inside the window, with the same `FIT_PADDING` margin the fit
   * uses — rather than a guess about zoom.
   *
   * `userMovedRef` is set for the same reason `zoomToDistrict` sets it: the
   * camera is now somewhere on purpose, and the fit effect must not pull it
   * back to the middle of the project between one step and the next.
   *
   * Reduced motion jumps instead of easing, which is the rule this file already
   * follows one function down.
   */
  const centredRef = useRef<string | null>(null);
  useEffect(() => {
    if (centreOn === null) {
      centredRef.current = null;
      return;
    }
    if (centredRef.current === centreOn) return;
    centredRef.current = centreOn;

    const placed = layout.byItemId.get(centreOn);
    const measured = sceneRef.current.size;
    if (!placed || !measured || measured.width <= 0 || measured.height <= 0) return;

    const camera = cameraRef.current;
    const offX = Math.abs(placed.x - camera.x) * camera.scale;
    const offY = Math.abs(placed.y - camera.y) * camera.scale;
    if (
      offX <= Math.max(measured.width / 2 - FIT_PADDING, 0) &&
      offY <= Math.max(measured.height / 2 - FIT_PADDING, 0)
    ) {
      return;
    }

    // The scale is kept. Zooming in on each step would change how much of the
    // project is on screen from one step to the next, which is the reader
    // losing the picture the path is drawn on.
    const target: Camera = { ...camera, x: placed.x, y: placed.y };
    userMovedRef.current = true;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      cameraRef.current = target;
      tweenRef.current = null;
    } else {
      tweenRef.current = { from: cameraRef.current, to: target, started: performance.now() };
    }
    requestDraw();
  }, [centreOn, layout, requestDraw]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      // Zeroed, not just cancelled. `requestDraw` treats a non-zero handle as
      // "a frame is already coming" and returns, so a handle left behind by a
      // cleanup silences the painter for the rest of the component's life. In
      // development that is every mount, because React runs effects twice: the
      // first pass schedules a frame, the cleanup cancels it, and the second
      // pass then never draws anything. The map came up blank exactly once —
      // on the real page, in dev — and this is why.
      frameRef.current = 0;
    };
  }, []);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const measured = sceneRef.current.size;
    if (!canvas || !measured) return null;
    const rect = canvas.getBoundingClientRect();
    const camera = cameraRef.current;
    return {
      x: (clientX - rect.left - measured.width / 2) / camera.scale + camera.x,
      y: (clientY - rect.top - measured.height / 2) / camera.scale + camera.y,
    };
  }, []);

  /** Which item is under the pointer, if any. Only ones currently drawn count. */
  const itemAt = useCallback((worldX: number, worldY: number): string | null => {
    const scene = sceneRef.current;
    const scale = cameraRef.current.scale;
    // A small grab radius in SCREEN pixels, so a 3px dot is still clickable.
    const slack = 5 / scale;
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const placed of scene.layout.items) {
      // A hub is drawn larger and therefore survives one zoom band longer than
      // its neighbours; the same boost has to be here or the thing on screen
      // would not be the thing under the pointer.
      const hub = scene.hubs.get(placed.districtId) === placed.id;
      const reach = placed.r * (hub ? HUB_BOOST : 1);
      if (itemAlphaFor(reach, scale) <= 0.02) continue;
      const dx = placed.x - worldX;
      const dy = placed.y - worldY;
      const distance = Math.hypot(dx, dy);
      if (distance <= reach + slack && distance < bestDistance) {
        best = placed.id;
        bestDistance = distance;
      }
    }
    return best;
  }, []);

  const districtAt = useCallback((worldX: number, worldY: number): PlacedDistrict | null => {
    for (const district of sceneRef.current.layout.districts) {
      if (Math.hypot(district.x - worldX, district.y - worldY) <= district.r) return district;
    }
    return null;
  }, []);

  /**
   * A stable way to call `onSelect`, so a parent that passes a fresh arrow
   * function on every render cannot invalidate the memoised outline below.
   */
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });
  const selectItem = useCallback((id: string | null) => onSelectRef.current?.(id), []);

  /** Same trick for opening, and for the same reason: the outline is memoised. */
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  });
  const openItem = useCallback((id: string) => {
    onOpenRef.current?.(id);
  }, []);
  const canOpen = onOpen !== undefined;

  const changeHover = useCallback(
    (next: string | null) => {
      // Guarded by a ref rather than by the state: a pointer crossing an item
      // fires dozens of moves a second, and only the crossings are renders.
      if (hoverRef.current === next) return;
      hoverRef.current = next;
      if (next === null) {
        setHover(null);
        onHoverChange?.(null);
        return;
      }
      const scene = sceneRef.current;
      const placed = scene.layout.byItemId.get(next);
      const measured = scene.size;
      if (!placed || !measured) {
        setHover(null);
      } else {
        const camera = cameraRef.current;
        setHover({
          id: next,
          x: (placed.x - camera.x) * camera.scale + measured.width / 2,
          y: (placed.y - camera.y) * camera.scale + measured.height / 2,
        });
      }
      onHoverChange?.(next);
    },
    [onHoverChange],
  );

  const dragRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);

  /**
   * Every finger currently on the canvas, and the pinch between two of them.
   *
   * A phone has no wheel, so without this the only way to zoom a map is the
   * two buttons in the corner — and a map is a thing people zoom constantly.
   * The pointer events are already being delivered (`touch-none` on the canvas
   * means the browser does not take them for page scrolling), so what was
   * missing was only the arithmetic.
   */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; x: number; y: number } | null>(null);

  /** The gap between two fingers and the point halfway between them. */
  const pinchOf = useCallback(() => {
    const [a, b] = [...pointersRef.current.values()];
    if (!a || !b) return null;
    return {
      distance: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      tweenRef.current = null;

      if (pointersRef.current.size >= 2) {
        // A second finger ends the pan rather than fighting it, and the release
        // then selects nothing — a pinch is not a tap that went on too long.
        dragRef.current = null;
        pinchRef.current = pinchOf();
        changeHover(null);
        return;
      }
      dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    },
    [changeHover, pinchOf],
  );

  /**
   * Two fingers: the gap between them sets the zoom, the point between them
   * stays under them, and moving both together pans.
   *
   * Anchored exactly the way the wheel is, on the point the gesture is centred
   * on rather than on the middle of the canvas, because a map that zoomed away
   * from the thing you were pinching would be unusable with one hand.
   */
  const applyPinch = useCallback(() => {
    const now = pinchOf();
    const before = pinchRef.current;
    const canvas = canvasRef.current;
    const measured = sceneRef.current.size;
    if (!now || !before || !canvas || !measured) return;

    const rect = canvas.getBoundingClientRect();
    const camera = cameraRef.current;
    const next = clamp(camera.scale * (now.distance / before.distance), MIN_SCALE, MAX_SCALE);
    const pointerX = now.x - rect.left - measured.width / 2;
    const pointerY = now.y - rect.top - measured.height / 2;
    cameraRef.current = {
      scale: next,
      x: camera.x + pointerX / camera.scale - pointerX / next - (now.x - before.x) / next,
      y: camera.y + pointerY / camera.scale - pointerY / next - (now.y - before.y) / next,
    };
    pinchRef.current = now;
    userMovedRef.current = true;
    requestDraw();
  }, [pinchOf, requestDraw]);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (pointersRef.current.has(event.pointerId)) {
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (pinchRef.current && pointersRef.current.size >= 2) {
        applyPinch();
        return;
      }
      const drag = dragRef.current;
      if (drag && drag.id === event.pointerId) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        drag.x = event.clientX;
        drag.y = event.clientY;
        const camera = cameraRef.current;
        cameraRef.current = {
          ...camera,
          x: camera.x - dx / camera.scale,
          y: camera.y - dy / camera.scale,
        };
        userMovedRef.current = true;
        changeHover(null);
        requestDraw();
        return;
      }
      const world = toWorld(event.clientX, event.clientY);
      if (!world) return;
      changeHover(itemAt(world.x, world.y));
    },
    [applyPinch, changeHover, itemAt, requestDraw, toWorld],
  );

  const zoomToDistrict = useCallback(
    (district: PlacedDistrict) => {
      const measured = sceneRef.current.size;
      if (!measured) return;
      const scale = clamp(
        Math.min(
          (measured.width - FIT_PADDING * 2) / (district.r * 2),
          (measured.height - FIT_PADDING * 2) / (district.r * 2),
        ),
        MIN_SCALE,
        MAX_SCALE,
      );
      const target: Camera = { x: district.x, y: district.y, scale };
      userMovedRef.current = true;
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        cameraRef.current = target;
        tweenRef.current = null;
      } else {
        tweenRef.current = { from: cameraRef.current, to: target, started: performance.now() };
      }
      requestDraw();
    },
    [requestDraw],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current = null;
      // A finger lifted from a pinch leaves the other one on the glass. It must
      // not become a pan that starts from wherever that finger happens to be,
      // and it must not select whatever is under it.
      if (pointersRef.current.size >= 1) {
        dragRef.current = null;
        return;
      }
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.moved) return;
      const world = toWorld(event.clientX, event.clientY);
      if (!world) return;
      const hit = itemAt(world.x, world.y);
      if (hit) {
        selectItem(hit);
        return;
      }
      const district = districtAt(world.x, world.y);
      if (district) {
        // Going into a district is how you get to its items when the map is
        // zoomed far enough out that they are not drawn yet.
        zoomToDistrict(district);
        selectItem(null);
        return;
      }
      selectItem(null);
    },
    [districtAt, itemAt, selectItem, toWorld, zoomToDistrict],
  );

  /**
   * A second click on the same item opens it.
   *
   * The first click has already selected it, so by the time this fires the
   * right panel is showing what the file is — and "누른 걸 한 번 더 누르면 열린다"
   * is the one gesture a person brings with them from every file manager they
   * have ever used. It is not the only way in: the panel has a button, the
   * left list has one per row, and the reachable list below this canvas has
   * one too, because a keyboard cannot double click.
   */
  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      if (!canOpen) return;
      const world = toWorld(event.clientX, event.clientY);
      if (!world) return;
      const hit = itemAt(world.x, world.y);
      if (hit) openItem(hit);
    },
    [canOpen, itemAt, openItem, toWorld],
  );

  /**
   * Wheel zoom, anchored on the pointer.
   *
   * Attached by hand rather than with `onWheel` because React registers wheel
   * listeners as passive, and a passive listener may not call
   * `preventDefault()` — the page would scroll behind the map.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const measured = sceneRef.current.size;
      if (!measured) return;
      const rect = canvas.getBoundingClientRect();
      const camera = cameraRef.current;
      const factor = Math.exp(-event.deltaY * 0.0016);
      const next = clamp(camera.scale * factor, MIN_SCALE, MAX_SCALE);
      const pointerX = event.clientX - rect.left - measured.width / 2;
      const pointerY = event.clientY - rect.top - measured.height / 2;
      cameraRef.current = {
        scale: next,
        x: camera.x + pointerX / camera.scale - pointerX / next,
        y: camera.y + pointerY / camera.scale - pointerY / next,
      };
      userMovedRef.current = true;
      tweenRef.current = null;
      // The tooltip hangs off a position worked out when the pointer crossed
      // the item, so it has to go rather than drift away from what it labels.
      changeHover(null);
      requestDraw();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [changeHover, requestDraw]);

  const nudgeZoom = useCallback(
    (factor: number) => {
      const camera = cameraRef.current;
      cameraRef.current = { ...camera, scale: clamp(camera.scale * factor, MIN_SCALE, MAX_SCALE) };
      userMovedRef.current = true;
      tweenRef.current = null;
      changeHover(null);
      requestDraw();
    },
    [changeHover, requestDraw],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
      const step = 60 / cameraRef.current.scale;
      const camera = cameraRef.current;
      if (event.key === "ArrowLeft") cameraRef.current = { ...camera, x: camera.x - step };
      else if (event.key === "ArrowRight") cameraRef.current = { ...camera, x: camera.x + step };
      else if (event.key === "ArrowUp") cameraRef.current = { ...camera, y: camera.y - step };
      else if (event.key === "ArrowDown") cameraRef.current = { ...camera, y: camera.y + step };
      else if (event.key === "+" || event.key === "=") nudgeZoom(1.25);
      else if (event.key === "-" || event.key === "_") nudgeZoom(0.8);
      else if (event.key === "0") {
        userMovedRef.current = false;
        fitToBounds();
        return;
      } else return;
      event.preventDefault();
      userMovedRef.current = true;
      requestDraw();
    },
    [fitToBounds, nudgeZoom, requestDraw],
  );

  /*
   * One line per item, computed once for the whole graph.
   *
   * Per-row would be `connections.filter` inside a render — thousands of
   * connections multiplied by every row on screen — which is the shape
   * `buildGraphView` already refuses for the same reason.
   */
  const descriptions = useMemo(
    () => describeAll({ items, connections }),
    [items, connections],
  );

  const hoveredItem = hover ? itemsById.get(hover.id) ?? null : null;
  const tooltip = hover && hoveredItem ? { left: hover.x, top: hover.y, item: hoveredItem } : null;

  /** The districts and their items as reachable DOM, grouped once rather than per district. */
  const districtItems = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const placed of layout.items) {
      const list = grouped.get(placed.districtId);
      if (list) list.push(placed.id);
      else grouped.set(placed.districtId, [placed.id]);
    }
    return grouped;
  }, [layout]);

  /**
   * What the picture is doing right now, in one sentence, for someone who
   * cannot see it.
   *
   * Deliberately OUTSIDE the memoised outline below. It changes on every
   * keystroke, and the outline is several hundred buttons whose whole reason
   * for being memoised is that re-reconciling them per keypress was measured at
   * 14.8ms while a Korean IME was composing. One paragraph is free.
   *
   * Not a live region. A sentence that re-announced itself on every keystroke
   * would talk over the person typing; this is here to be read when the list
   * below it is reached, which is when someone actually wants to know what the
   * picture is currently showing.
   */
  const selectedName = selectedId ? itemsById.get(selectedId) : undefined;
  const status = [
    `묶는 기준은 ${GROUPING_WORDS[inForce].name}, 동네는 ${layout.districts.length.toLocaleString("ko-KR")}곳이에요.`,
    grouped
      ? "동네마다 색을 따로 썼어요."
      : "동네가 하나뿐이라 색으로는 나누지 않았어요.",
    // Same light, so the same shape of sentence — but it has to name which
    // switch is on. "찾는 말과 맞는 것" beside a change nobody searched for
    // would be the one sentence on this screen that is not true.
    beam.active
      ? highlighting
        ? `고른 변경이 건드린 곳은 ${beam.matched.size.toLocaleString("ko-KR")}개예요. 나머지는 흐리게 보일 뿐 그대로 있어요.`
        : `찾는 말과 맞는 것은 ${beam.matched.size.toLocaleString("ko-KR")}개예요. 나머지는 흐리게 보일 뿐 그대로 있어요.`
      : null,
    selectedName
      ? `지금 고른 것은 ${displayNameOf(selectedName)}, 바로 이어진 것은 ${Math.max(selection.lit.size - 1, 0).toLocaleString("ko-KR")}개예요. 나머지는 흐리게 보일 뿐 그대로 있고, 아래 목록에서 모두 고를 수 있어요.`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join(" ");

  if (items.length === 0) {
    return (
      <div
        ref={wrapRef}
        className={`flex h-full w-full items-center justify-center bg-ink-sunk ${className ?? ""}`}
      >
        <p className="max-w-[26ch] text-center text-[14px] leading-[1.8] text-said-faint text-pretty">
          아직 지도에 올릴 게 없어요. 살펴보기가 끝나면 여기에 프로젝트 지도가 그려져요.
        </p>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={`relative h-full w-full overflow-hidden bg-ink-sunk ${className ?? ""}`}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={`프로젝트 지도. 동네 ${layout.districts.length}곳, ${items.length}개가 있어요.`}
        style={{ width: size?.width ?? 0, height: size?.height ?? 0 }}
        className="block cursor-crosshair touch-none outline-none focus-visible:outline-2 focus-visible:outline-lamp"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => changeHover(null)}
        onKeyDown={onKeyDown}
      />

      {tooltip ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-[6px] border-[0.8px] border-edge-lit bg-ink px-2.5 py-1.5 shadow-[0_12px_28px_-14px_rgba(0,0,0,0.95)]"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <p className="text-[13px] leading-[1.5] text-said">{displayNameOf(tooltip.item)}</p>
          {/*
            What it is, not how many edges it has. "파일 · 5개와 이어져
            있어요" is a measurement; someone who cannot read code is looking
            at a name they did not choose and asking what the thing does.
          */}
          <p className="mt-0.5 max-w-[26ch] text-[11px] leading-[1.5] text-said-faint text-pretty">
            {descriptions.get(tooltip.item.id)?.line ?? KIND_WORDS[tooltip.item.kind]}
          </p>
          {/*
            Said on the thing itself, because a gesture nobody mentions is a
            gesture nobody finds. Only where it is true: a package has no file.
          */}
          {canOpen && previewTargetFor(tooltip.item) ? (
            <p className="text-[11px] leading-[1.5] text-said-faint">
              두 번 누르면 열어볼 수 있어요
            </p>
          ) : null}
        </div>
      ) : null}

      {/*
        The honesty key. Solid band versus hatch, matching what the map draws,
        and the arrowhead beside them — the direction is the whole meaning of a
        line, so it needs saying once rather than being left to be guessed.
      */}
      {/*
        The two corners of the canvas share one row at the bottom, and at 375px
        they were measured overlapping by 45 × 28 pixels — the legend running
        from 12 to 316 and the zoom controls from 271 to 363. That is the
        founder's 겹침, on the one screen with no room to hide it.

        Fixed by giving this column the width that is actually left over rather
        than all of it, and letting the legend wrap inside it. Both numbers are
        the same number said twice: the zoom group is three 44px buttons and two
        4px gaps, which is 140, plus the 12px it sits in from the right edge and
        a gap of its own.
      */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-10.75rem)] flex-col items-start gap-1.5 md:max-w-[calc(100%-7rem)]">
        {/*
          What the picture is not showing, and why.

          Two mechanisms in the renderer decline to draw things on purpose: the
          link budget holds back lines that would make the picture unreadable,
          and the label field drops a word rather than laying it over another
          word. Both are right, and both would be a quiet lie without this line
          — a map that omits in silence tells someone their project has fewer
          connections than it has. It is the same promise the connections panel
          keeps when it prints "N개는 줄였어요", and it ends by saying what to do
          about it, because a number with no remedy is just bad news.

          Filled by the draw pass through `heldRef`; empty and hidden otherwise.
        */}
        <p
          ref={heldRef}
          hidden
          className="max-w-[34ch] rounded-lg border-[0.8px] border-edge bg-ink/80 px-2.5 py-1.5 text-[11px] leading-[1.6] text-said-faint backdrop-blur-[2px] text-pretty"
        />
        <div className="flex flex-wrap gap-x-3 gap-y-1 rounded-lg border-[0.8px] border-edge bg-ink/80 px-2.5 py-1.5 text-[11px] text-said-faint backdrop-blur-[2px]">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[3px] w-6 rounded-full bg-wire" />
            확실해요
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-[7px] w-6"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(90deg, var(--color-guess) 0 1px, transparent 1px 5px)",
              }}
            />
            짐작이에요
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="text-said-soft">
              →
            </span>
            화살표 쪽으로 이어져요
          </span>
        </div>
      </div>

      <div className="absolute bottom-3 right-3 flex items-center gap-1">
        <MapButton label="더 크게 보기" onClick={() => nudgeZoom(1.25)}>
          +
        </MapButton>
        <MapButton label="더 작게 보기" onClick={() => nudgeZoom(0.8)}>
          −
        </MapButton>
        <MapButton
          label="전체 보기"
          onClick={() => {
            userMovedRef.current = false;
            fitToBounds();
          }}
        >
          <span className="px-0.5 text-[11px]">전체</span>
        </MapButton>
      </div>

      <p className="sr-only">{status}</p>

      <MapOutline
        districts={layout.districts}
        districtItems={districtItems}
        itemsById={itemsById}
        selectedId={selectedId}
        lit={selection.lit}
        onSelect={selectItem}
        onOpen={canOpen ? openItem : undefined}
      />
    </div>
  );
}

/**
 * The same map as reachable DOM.
 *
 * A canvas is invisible to a screen reader and unreachable by keyboard, so
 * every district and every item is also a real element — the buttons select
 * exactly what a click on the canvas selects.
 *
 * **Dimming is said, never done.** When something is selected the canvas pushes
 * everything unrelated back to 30%; here the corresponding item keeps its
 * button, its place in its district and its 열어보기, and the one sentence above
 * this list says that the rest are faint rather than gone. Removing a row, or
 * disabling one, would turn a visual emphasis into a loss of function for the
 * people who cannot see the emphasis in the first place. What is marked instead
 * is the positive state: which row is the selection, and which rows it is
 * joined to.
 *
 * Memoised, and this is not a micro-optimisation. It depends on the shape of
 * the graph and on the selection — a batch arriving, or a click — and never on
 * the beam, which changes on every keystroke. Left inline, React reconciled
 * several hundred buttons per keypress while a Korean IME was composing —
 * measured at 14.8ms a keystroke on a 320-item project, which fell to 1.5ms
 * once this stopped re-rendering.
 */
const MapOutline = memo(function MapOutline({
  districts,
  districtItems,
  itemsById,
  selectedId,
  lit,
  onSelect,
  onOpen,
}: {
  districts: PlacedDistrict[];
  districtItems: Map<string, string[]>;
  itemsById: Map<string, GraphItem>;
  selectedId: string | null;
  /** The selection and everything one step from it: the rows drawn at full strength. */
  lit: ReadonlySet<string>;
  onSelect: (id: string) => void;
  /** Undefined when nothing can be opened from here. */
  onOpen?: (id: string) => void;
}) {
  return (
    <ul className="sr-only">
      {districts.map((district) => (
        <li key={district.id}>
          {district.name} ({district.folder || "이름 없는 곳"}) · {district.count}개
          <ul>
            {(districtItems.get(district.id) ?? []).slice(0, SR_ITEMS_PER_DISTRICT).map((id) => {
              const item = itemsById.get(id);
              if (!item) return null;
              // A package has no file behind it, so it gets no way to open
              // one — an offer that cannot be honoured is worse than none.
              const openable = onOpen !== undefined && previewTargetFor(item) !== null;
              const selected = id === selectedId;
              const near = !selected && selectedId !== null && lit.has(id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelect(id)}
                  >
                    {displayNameOf(item)} · {KIND_WORDS[item.kind]}
                    {selected ? " · 지금 고른 것" : null}
                    {near ? " · 고른 것과 바로 이어져 있어요" : null}
                  </button>
                  {openable ? (
                    <button type="button" onClick={() => onOpen(id)}>
                      {displayNameOf(item)} 열어보기
                    </button>
                  ) : null}
                </li>
              );
            })}
            {district.count > SR_ITEMS_PER_DISTRICT ? (
              <li>그 밖에 {district.count - SR_ITEMS_PER_DISTRICT}개가 더 있어요.</li>
            ) : null}
          </ul>
        </li>
      ))}
    </ul>
  );
});

function MapButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      /*
        28px is a comfortable target for a mouse and too small for a thumb.
        `max-md:` takes it to 44, which is the size every other control in this
        product uses on a phone, and leaves the desktop picture alone.
      */
      className="flex h-7 min-w-7 items-center justify-center rounded-[5px] border-[0.8px] border-edge bg-ink/80 text-[13px] text-said-soft backdrop-blur-[2px] transition-colors hover:border-edge-lit hover:bg-ink hover:text-said max-md:h-11 max-md:min-w-11"
    >
      {children}
    </button>
  );
}
