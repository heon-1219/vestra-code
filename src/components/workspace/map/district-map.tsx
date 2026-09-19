"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import type { Certainty, GraphConnection, GraphItem } from "@/lib/graph/view";
import { KIND_WORDS } from "@/lib/graph/view";

import { buildBeamIndex, runBeam, type BeamResult } from "./beam";
import { layoutMap, type MapLayout, type PlacedDistrict } from "./layout";

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
 *     converted to screen coordinates here, and the hatch pitch is a constant
 *     number of screen pixels by construction. There is nothing left to get
 *     wrong at a different zoom.
 *  2. **The beam repaints everything on every keystroke.** In canvas that is
 *     one clear and one pass. In SVG it is hundreds of attribute mutations and
 *     a style recalc, per keystroke, while a Korean IME is composing.
 *  3. **300+ items must stay smooth.** One `<canvas>` against 300+ elements
 *     plus their labels.
 *
 * The cost of canvas is that nothing in it is reachable by a screen reader or
 * the keyboard, so the picture is mirrored as real DOM underneath it — a list
 * of districts and their items, each one a button that selects the same thing a
 * click would. It is not decoration; it is the only way in for anyone not using
 * a mouse.
 *
 * ## What is idle
 *
 * There is no animation loop. A frame is drawn when something changed — a pan,
 * a zoom, a hover crossing an item, a keystroke, a batch of new items during a
 * live run — and then nothing runs at all until the next change. The one
 * exception is the short camera tween when you click a district, which stops
 * itself, and which is skipped entirely under `prefers-reduced-motion`.
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
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onHoverChange?: (id: string | null) => void;
  className?: string;
};

type Camera = { x: number; y: number; scale: number };

type Road = {
  a: PlacedDistrict;
  b: PlacedDistrict;
  certain: number;
  inferred: number;
};

type Neighbourhood = Map<string, { id: string; certainty: Certainty }[]>;

/** Everything a frame is drawn from. Held in a ref, never read from props. */
type Scene = {
  layout: MapLayout;
  roads: Road[];
  neighbours: Neighbourhood;
  itemsById: Map<string, GraphItem>;
  beam: BeamResult;
  selectedId: string | null;
  hoverId: string | null;
  size: { width: number; height: number } | null;
};

type Palette = {
  surface: string;
  hues: string[];
  wire: string;
  guess: string;
  said: string;
  saidSoft: string;
  saidFaint: string;
  lamp: string;
};

const MIN_SCALE = 0.06;
const MAX_SCALE = 6;
const FIT_PADDING = 56;

/** Screen pixels between two hatch ticks. Constant at every zoom — that is the point. */
const HATCH_PITCH = 5;

/** Below this many screen pixels a district's name is noise, so it is not drawn. */
const LABEL_MIN_SCREEN_R = 22;

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
const ITEM_LINES_ZOOM_FACTOR = 2.2;

/** A guard for a pathological repo: never draw more thin lines than this in a frame. */
const MAX_ITEM_LINES = 2500;

const TWEEN_MS = 260;

/**
 * How many of a district's items get a real button underneath the canvas.
 *
 * Enough that every project we can analyse today is fully reachable without a
 * mouse, capped so a pathological repo cannot put ten thousand buttons in the
 * document. The remainder is counted out loud rather than silently dropped.
 */
const SR_ITEMS_PER_DISTRICT = 300;

const FALLBACK: Palette = {
  surface: "#080706",
  hues: ["#d98e5f", "#7fa88c", "#8a9bc4", "#c08497", "#b9a45c", "#7e9ba8"],
  wire: "#6b6659",
  guess: "#46423b",
  said: "#e8e2d6",
  saidSoft: "#a9a294",
  saidFaint: "#6f6a5e",
  lamp: "#f0c97f",
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * `rgba()` from a token's hex, memoised.
 *
 * Colours come from the CSS variables in globals.css rather than being written
 * again here, so the map cannot drift from the rest of the product. Parsing
 * them per primitive per frame would be thousands of string operations a frame,
 * hence the cache.
 */
const alphaCache = new Map<string, string>();
function withAlpha(hex: string, alpha: number): string {
  const key = `${hex}|${alpha}`;
  const hit = alphaCache.get(key);
  if (hit) return hit;
  const clean = hex.trim().replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const value = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  alphaCache.set(key, value);
  return value;
}

function readPalette(el: HTMLElement): Palette {
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };
  return {
    surface: read("--color-ink-sunk", FALLBACK.surface),
    hues: FALLBACK.hues.map((fallback, i) => read(`--color-c${i + 1}`, fallback)),
    wire: read("--color-wire", FALLBACK.wire),
    guess: read("--color-guess", FALLBACK.guess),
    said: read("--color-said", FALLBACK.said),
    saidSoft: read("--color-said-soft", FALLBACK.saidSoft),
    saidFaint: read("--color-said-faint", FALLBACK.saidFaint),
    lamp: read("--color-lamp", FALLBACK.lamp),
  };
}

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

function displayNameOf(item: GraphItem): string {
  if (item.label) return item.label;
  if (item.kind === "file" && item.path) {
    const cut = item.path.lastIndexOf("/");
    return cut === -1 ? item.path : item.path.slice(cut + 1);
  }
  return item.name;
}

export function DistrictMap({
  items,
  connections,
  query = "",
  selectedId = null,
  onSelect,
  onHoverChange,
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

  const layout = useMemo(() => layoutMap(items), [items]);

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

  /** Who each item is connected to, for lighting a selection's neighbourhood. */
  const neighbours = useMemo<Neighbourhood>(() => {
    const map: Neighbourhood = new Map();
    const add = (from: string, to: string, certainty: Certainty) => {
      const list = map.get(from);
      if (list) list.push({ id: to, certainty });
      else map.set(from, [{ id: to, certainty }]);
    };
    for (const connection of connections) {
      add(connection.from, connection.to, connection.certainty);
      add(connection.to, connection.from, connection.certainty);
    }
    return map;
  }, [connections]);

  const beamIndex = useMemo(() => buildBeamIndex(items), [items]);
  const beam = useMemo(() => runBeam(beamIndex, query), [beamIndex, query]);

  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const tweenRef = useRef<{ from: Camera; to: Camera; started: number } | null>(null);
  const frameRef = useRef(0);
  const paletteRef = useRef<Palette>(FALLBACK);
  /** The zoom that last showed the whole map, which item lines are measured against. */
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
   * Everything the draw pass reads, in one ref.
   *
   * Drawing reads from a ref rather than from props so that a pan, a zoom or a
   * hover can repaint without a React render — at 60 frames a second while
   * dragging, a render per frame is the whole budget.
   */
  const sceneRef = useRef<Scene>({
    layout,
    roads,
    neighbours,
    itemsById,
    beam,
    selectedId,
    hoverId: null,
    size,
  });

  // Kept in step after every render, and declared before every effect that asks
  // for a frame, so a frame is never drawn from one render behind.
  useEffect(() => {
    sceneRef.current = {
      layout,
      roads,
      neighbours,
      itemsById,
      beam,
      selectedId,
      hoverId,
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

    drawMap(ctx, scene, {
      width,
      height,
      dpr,
      camera: cameraRef.current,
      palette: paletteRef.current,
      font: fontRef.current,
      fitScale: fitScaleRef.current,
    });

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
  useEffect(() => {
    if (userMovedRef.current) {
      requestDraw();
      return;
    }
    fitToBounds();
  }, [layout, size, fitToBounds, requestDraw]);

  useEffect(() => {
    requestDraw();
  }, [beam, selectedId, hoverId, roads, requestDraw]);

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
      if (itemAlphaFor(placed.r, scale) <= 0.02) continue;
      const dx = placed.x - worldX;
      const dy = placed.y - worldY;
      const distance = Math.hypot(dx, dy);
      if (distance <= placed.r + slack && distance < bestDistance) {
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

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    tweenRef.current = null;
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
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
    [changeHover, itemAt, requestDraw, toWorld],
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

  if (items.length === 0) {
    return (
      <div
        ref={wrapRef}
        className={`flex h-full w-full items-center justify-center bg-ink-sunk ${className ?? ""}`}
      >
        <p className="max-w-[26ch] text-center text-[14px] leading-[1.8] text-said-faint">
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
        onPointerLeave={() => changeHover(null)}
        onKeyDown={onKeyDown}
      />

      {tooltip ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-[6px] border border-edge-lit bg-ink px-2.5 py-1.5 shadow-lg"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <p className="text-[13px] leading-[1.5] text-said">{displayNameOf(tooltip.item)}</p>
          <p className="text-[11px] leading-[1.5] text-said-faint">
            {KIND_WORDS[tooltip.item.kind]}
            {" · "}
            {tooltip.item.usedBy + tooltip.item.uses === 0
              ? "아는 연결이 없어요"
              : `${tooltip.item.usedBy + tooltip.item.uses}개와 이어져 있어요`}
          </p>
        </div>
      ) : null}

      {/* The honesty key. Solid band versus hatch, matching what the map draws. */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex gap-3 text-[11px] text-said-faint">
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

      <MapOutline
        districts={layout.districts}
        districtItems={districtItems}
        itemsById={itemsById}
        onSelect={selectItem}
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
 * Memoised, and this is not a micro-optimisation. It depends only on the shape
 * of the graph, which changes when a run delivers a batch; the beam changes on
 * every keystroke. Left inline, React reconciled several hundred buttons per
 * keypress while a Korean IME was composing — measured at 14.8ms a keystroke on
 * a 320-item project, which fell to 1.5ms once this stopped re-rendering.
 */
const MapOutline = memo(function MapOutline({
  districts,
  districtItems,
  itemsById,
  onSelect,
}: {
  districts: PlacedDistrict[];
  districtItems: Map<string, string[]>;
  itemsById: Map<string, GraphItem>;
  onSelect: (id: string) => void;
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
              return (
                <li key={id}>
                  <button type="button" onClick={() => onSelect(id)}>
                    {displayNameOf(item)} · {KIND_WORDS[item.kind]}
                  </button>
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
      className="flex h-7 min-w-7 items-center justify-center rounded-[5px] border border-edge bg-ink/80 text-[13px] text-said-soft transition-colors hover:border-edge-lit hover:text-said"
    >
      {children}
    </button>
  );
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
function itemAlphaFor(worldRadius: number, scale: number): number {
  return smoothstep(1.2, 2.2, worldRadius * scale);
}

type View = {
  width: number;
  height: number;
  dpr: number;
  camera: Camera;
  palette: Palette;
  font: string;
  /** The zoom at which the whole map last fitted the container. */
  fitScale: number;
};

function drawMap(ctx: CanvasRenderingContext2D, scene: Scene, view: View): void {
  const { width, height, dpr, camera, palette } = view;
  const { layout, roads, beam } = scene;

  // No transform on the context beyond the device pixel ratio. Everything below
  // converts to screen coordinates itself, which is what makes line widths,
  // text sizes and above all the hatch pitch independent of the zoom.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, width, height);

  const sx = (x: number) => (x - camera.x) * camera.scale + width / 2;
  const sy = (y: number) => (y - camera.y) * camera.scale + height / 2;

  const focusId = scene.hoverId ?? scene.selectedId;
  const focusNeighbours = focusId ? scene.neighbours.get(focusId) ?? [] : [];

  /** How many lit items each district holds, so a territory reacts to the beam too. */
  const litPerDistrict = new Map<string, number>();
  if (beam.active) {
    for (const placed of layout.items) {
      if (beam.matched.has(placed.id)) {
        litPerDistrict.set(placed.districtId, (litPerDistrict.get(placed.districtId) ?? 0) + 1);
      }
    }
  }

  // 1. The territories.
  for (const district of layout.districts) {
    const cx = sx(district.x);
    const cy = sy(district.y);
    const r = district.r * camera.scale;
    if (cx + r < -40 || cx - r > width + 40 || cy + r < -40 || cy - r > height + 40) continue;

    const hue = palette.hues[district.hue % palette.hues.length];
    // Dimmed, never dark: an unlit district is still a place on the map.
    const lit = !beam.active || (litPerDistrict.get(district.id) ?? 0) > 0;
    const strength = lit ? 1 : 0.3;

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

    const gradient = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    gradient.addColorStop(0, withAlpha(hue, 0.17 * strength));
    gradient.addColorStop(1, withAlpha(hue, 0.05 * strength));
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = withAlpha(hue, 0.42 * strength);
    ctx.stroke();
  }

  // 2. The roads between them, under the names.
  for (const road of roads) {
    drawRoad(ctx, road, sx, sy, camera.scale, palette, beam.active ? 0.55 : 1);
  }

  // 3. The names, lying flat on the surface.
  const spacing = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  for (const district of layout.districts) {
    const cx = sx(district.x);
    const cy = sy(district.y);
    const r = district.r * camera.scale;
    if (r < LABEL_MIN_SCREEN_R) continue;
    if (cx + r < 0 || cx - r > width || cy + r < 0 || cy - r > height) continue;

    const lit = !beam.active || (litPerDistrict.get(district.id) ?? 0) > 0;
    const size = clamp(r * 0.24, 11, 30);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    // Korean wants tighter tracking than a Latin default; the canvas does not
    // inherit the rule globals.css sets for the DOM, so it is set again here.
    spacing.letterSpacing = "-0.03em";
    ctx.font = `800 ${size}px ${view.font}`;
    // A halo in the surface colour, so a name stays readable over its own items.
    ctx.shadowColor = palette.surface;
    ctx.shadowBlur = 8;
    ctx.fillStyle = withAlpha(palette.said, lit ? 0.92 : 0.34);
    ctx.fillText(district.name, cx, cy - r * 0.58);

    ctx.font = `500 ${Math.max(10, size * 0.46)}px ${view.font}`;
    ctx.fillStyle = withAlpha(palette.saidFaint, lit ? 0.95 : 0.4);
    ctx.fillText(`${district.count}개 · ${district.folder}`, cx, cy - r * 0.58 + size * 0.92);
    ctx.shadowBlur = 0;
    spacing.letterSpacing = "0px";
  }

  // 4. Item-level lines, but only once you have come in close enough that they
  //    describe a neighbourhood instead of covering the map in string.
  if (camera.scale >= view.fitScale * ITEM_LINES_ZOOM_FACTOR) {
    let drawn = 0;
    for (const [from, list] of scene.neighbours) {
      const a = layout.byItemId.get(from);
      if (!a) continue;
      for (const link of list) {
        // Each pair appears twice in `neighbours`; draw the one ordering.
        if (from >= link.id) continue;
        const b = layout.byItemId.get(link.id);
        if (!b) continue;
        const ax = sx(a.x);
        const ay = sy(a.y);
        const bx = sx(b.x);
        const by = sy(b.y);
        if (Math.max(ax, bx) < 0 || Math.min(ax, bx) > width) continue;
        if (Math.max(ay, by) < 0 || Math.min(ay, by) > height) continue;
        const alpha =
          0.4 *
          Math.min(itemAlphaFor(a.r, camera.scale), itemAlphaFor(b.r, camera.scale)) *
          (beam.active && !(beam.matched.has(from) && beam.matched.has(link.id)) ? 0.3 : 1);
        if (alpha <= 0.02) continue;
        drawThread(ctx, ax, ay, bx, by, link.certainty, palette, alpha, 1);
        if (++drawn > MAX_ITEM_LINES) break;
      }
      if (drawn > MAX_ITEM_LINES) break;
    }
  }

  // 5. The items.
  for (const placed of layout.items) {
    const alpha = itemAlphaFor(placed.r, camera.scale);
    if (alpha <= 0.02) continue;
    const cx = sx(placed.x);
    const cy = sy(placed.y);
    const r = Math.max(placed.r * camera.scale, 1.4);
    if (cx + r < 0 || cx - r > width || cy + r < 0 || cy - r > height) continue;

    const district = layout.byDistrictId.get(placed.districtId);
    const hue = palette.hues[(district?.hue ?? 0) % palette.hues.length];
    // The beam's one rule: unmatched goes to 30%, never to nothing.
    const beamAlpha = beam.active && !beam.matched.has(placed.id) ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(hue, alpha * beamAlpha * 0.95);
    ctx.fill();
  }

  // 6. The neighbourhood of whatever is hovered or selected, over everything.
  if (focusId) {
    const centre = layout.byItemId.get(focusId);
    if (centre) {
      const cx = sx(centre.x);
      const cy = sy(centre.y);
      for (const neighbour of focusNeighbours) {
        const other = layout.byItemId.get(neighbour.id);
        if (!other) continue;
        drawThread(ctx, cx, cy, sx(other.x), sy(other.y), neighbour.certainty, palette, 0.92, 1.6, true);
      }
      for (const neighbour of focusNeighbours) {
        const other = layout.byItemId.get(neighbour.id);
        if (!other) continue;
        ctx.beginPath();
        ctx.arc(sx(other.x), sy(other.y), Math.max(other.r * camera.scale, 2.6) + 1.6, 0, Math.PI * 2);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = withAlpha(palette.said, 0.8);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(centre.r * camera.scale, 3) + 4, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = palette.lamp;
      ctx.stroke();
    }
  }

  // The selection keeps its ring even while the pointer is over something else.
  if (scene.selectedId && scene.selectedId !== focusId) {
    const placed = layout.byItemId.get(scene.selectedId);
    if (placed) {
      ctx.beginPath();
      ctx.arc(sx(placed.x), sy(placed.y), Math.max(placed.r * camera.scale, 3) + 4, 0, Math.PI * 2);
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
): void {
  const ax = sx(road.a.x);
  const ay = sy(road.a.y);
  const bx = sx(road.b.x);
  const by = sy(road.b.y);
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length < 6) return;

  const ux = dx / length;
  const uy = dy / length;
  // Start and end at the rims, so a road never runs under a district's name.
  const startTrim = road.a.r * scale * 0.94;
  const endTrim = road.b.r * scale * 0.94;
  const span = length - startTrim - endTrim;
  if (span < 8) return;

  const x0 = ax + ux * startTrim;
  const y0 = ay + uy * startTrim;
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
    ctx.lineTo(x0 + ux * span + px * certainOffset, y0 + uy * span + py * certainOffset);
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
    for (let t = 0; t <= span; t += HATCH_PITCH) {
      const hx = x0 + ux * t + px * inferredOffset;
      const hy = y0 + uy * t + py * inferredOffset;
      ctx.moveTo(hx - px * half, hy - py * half);
      ctx.lineTo(hx + px * half, hy + py * half);
    }
    ctx.stroke();
    // A faint spine holds the ticks together as one road rather than a fence.
    ctx.beginPath();
    ctx.moveTo(x0 + px * inferredOffset, y0 + py * inferredOffset);
    ctx.lineTo(x0 + ux * span + px * inferredOffset, y0 + uy * span + py * inferredOffset);
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = withAlpha(palette.guess, 0.45 * strength);
    ctx.stroke();
  }
}

/**
 * One item-to-item line. Same encoding as a road, at the scale of a single link.
 *
 * `bright` is for the neighbourhood of whatever is hovered or selected. The
 * resting wire colours are deliberately quiet so the territories read first,
 * and at that weight a line from a selected item to its three neighbours was
 * measured as invisible against the roads already crossing the same space —
 * which is the one moment the line is the answer to the user's question.
 */
function drawThread(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  certainty: Certainty,
  palette: Palette,
  alpha: number,
  weight: number,
  bright = false,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length < 2) return;

  const solid = bright ? palette.said : palette.wire;
  const dotted = bright ? palette.saidSoft : palette.guess;

  if (certainty === "certain") {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineWidth = weight;
    ctx.lineCap = "round";
    ctx.strokeStyle = withAlpha(solid, alpha);
    ctx.stroke();
    return;
  }

  // A guess is a ladder, not a dashed line: at the zoom where a whole repo fits
  // on screen a dash and a solid stroke look identical, and this must not.
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const half = 1.4 + weight;
  ctx.beginPath();
  for (let t = 0; t <= length; t += HATCH_PITCH) {
    const hx = ax + ux * t;
    const hy = ay + uy * t;
    ctx.moveTo(hx - px * half, hy - py * half);
    ctx.lineTo(hx + px * half, hy + py * half);
  }
  ctx.lineWidth = bright ? 1.2 : 0.9;
  ctx.lineCap = "butt";
  ctx.strokeStyle = withAlpha(dotted, alpha);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = withAlpha(dotted, alpha * 0.5);
  ctx.stroke();
}
