"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";

/**
 * The hero graph is the pitch, so it carries the same three facts the real
 * product's map carries — and nothing else.
 *
 * `kind` decides size: a hub is a piece of code many things lean on, and on the
 * real map those are the ones a change ripples out from. `certain` decides how
 * a link is drawn, because the whole promise is that we say what we know and
 * what we are guessing. Everything else the product tracks is deliberately not
 * here: an illustration that encodes six channels is a diagram nobody reads.
 */
type HeroNode = {
  id: string;
  cluster: number;
  kind: "hub" | "piece" | "leaf";
};

type HeroLink = { source: string; target: string; certain: boolean };

const CLUSTER_COLORS = [
  "#d98e5f",
  "#7fa88c",
  "#8a9bc4",
  "#c08497",
  "#b9a45c",
  "#7e9ba8",
];

/** What each cluster becomes once the map resolves. Product areas, not code. */
const CLUSTER_LABELS = ["결제", "로그인", "장바구니", "상품", "주문", "알림"];

/** Uneven on purpose: a real app is not six equal piles. */
const CLUSTER_SIZES = [26, 18, 22, 31, 15, 20];

/** The colour every node starts as: undifferentiated, before we know anything. */
const TANGLED_COLOR = new THREE.Color("#5c574c");

const BASE_DISTANCE = 470;

const RADIUS: Record<HeroNode["kind"], number> = {
  hub: 5.4,
  piece: 3.1,
  leaf: 2.1,
};

/**
 * A synthetic graph shaped like a small real app: a few hub pieces shared
 * across areas, most things local to one. Illustrative, not a real analysis —
 * the page says so in copy, because the brief forbids presenting anything
 * fabricated as real.
 */
function buildGraph(): { nodes: HeroNode[]; links: HeroLink[] } {
  const nodes: HeroNode[] = [];
  const links: HeroLink[] = [];

  // A small deterministic generator. Math.random would reshuffle the picture on
  // every render and make the scroll-driven resolve look different each visit.
  let seed = 20260919;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let c = 0; c < CLUSTER_SIZES.length; c++) {
    const size = CLUSTER_SIZES[c];
    for (let i = 0; i < size; i++) {
      nodes.push({
        id: `n${c}-${i}`,
        cluster: c,
        kind: i === 0 ? "hub" : i < Math.max(3, size / 4) ? "piece" : "leaf",
      });
    }
  }

  for (let c = 0; c < CLUSTER_SIZES.length; c++) {
    const size = CLUSTER_SIZES[c];
    for (let i = 1; i < size; i++) {
      // Attach toward the front of the cluster, so hubs accumulate degree the
      // way a genuinely shared helper does.
      const target = Math.floor(Math.sqrt(i) * rand());
      links.push({
        source: `n${c}-${i}`,
        target: `n${c}-${target}`,
        certain: rand() > 0.16,
      });
      if (rand() > 0.62 && i + 2 < size) {
        links.push({
          source: `n${c}-${i}`,
          target: `n${c}-${i + 2}`,
          certain: rand() > 0.3,
        });
      }
    }
  }

  // The shared pieces — why the resolved picture still has structure between
  // areas rather than six disconnected balls.
  for (let c = 0; c < CLUSTER_SIZES.length; c++) {
    const next = (c + 1) % CLUSTER_SIZES.length;
    const far = (c + 2) % CLUSTER_SIZES.length;
    links.push({ source: `n${c}-0`, target: `n${next}-0`, certain: true });
    links.push({ source: `n${c}-2`, target: `n${next}-4`, certain: false });
    if (c % 2 === 0) {
      links.push({ source: `n${c}-1`, target: `n${far}-3`, certain: rand() > 0.5 });
    }
  }

  return { nodes, links };
}

type SimNode = HeroNode & {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
};

/**
 * Pulls each node toward its cluster's centre. Strength is read from a ref on
 * every tick, so scrolling changes the force without rebuilding the simulation.
 */
function makeClusterForce(
  centers: { x: number; y: number; z: number }[],
  strengthRef: React.RefObject<number>,
) {
  let nodes: SimNode[] = [];
  const force = (alpha: number) => {
    const k = alpha * strengthRef.current * 0.55;
    if (k <= 0) return;
    for (const n of nodes) {
      const c = centers[n.cluster];
      n.vx = (n.vx ?? 0) + (c.x - (n.x ?? 0)) * k;
      n.vy = (n.vy ?? 0) + (c.y - (n.y ?? 0)) * k;
      n.vz = (n.vz ?? 0) + (c.z - (n.z ?? 0)) * k;
    }
  };
  force.initialize = (ns: SimNode[]) => {
    nodes = ns;
  };
  return force;
}

export default function HeroGraphScene({
  progressRef,
}: {
  /** 0 = tangled, 1 = resolved into clusters. Driven by scroll. */
  progressRef: React.RefObject<number>;
}) {
  const fgRef = useRef<ForceGraphMethods<HeroNode, HeroLink> | undefined>(
    undefined,
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const strengthRef = useRef(0);
  const materialsRef = useRef(new Map<string, THREE.MeshLambertMaterial>());
  const meshesRef = useRef(new Map<string, THREE.Mesh>());
  /** The id under the pointer, and everything one step from it. */
  const hoverRef = useRef<{ id: string; near: Set<string> } | null>(null);
  /** One label per area, positioned each frame by projecting its centre. */
  const labelsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const pointerRef = useRef({ x: 0, y: 0 });
  const visibleRef = useRef(true);
  const engineReadyRef = useRef(false);
  const idleFramesRef = useRef(0);
  const wakeRef = useRef<(() => void) | null>(null);

  /**
   * The canvas is sized from the WRAPPER, never left to size itself.
   *
   * Without an explicit width the renderer falls back to the window, and
   * `window.innerWidth` includes the vertical scrollbar while the content box
   * does not. The canvas then lands wider than the space it sits in and
   * produces a horizontal scrollbar — measured here at 1280px CSS inside a
   * 1238px viewport.
   *
   * A ResizeObserver rather than a resize listener, because the wrapper also
   * changes width when the vertical scrollbar itself appears or disappears,
   * and that fires no window resize event at all.
   */
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

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

  const data = useMemo(() => buildGraph(), []);

  /**
   * Who is one step from whom.
   *
   * Built once. Hovering asks this question on every pointer move, and the
   * answer is the product's whole pitch in a single gesture — point at a thing,
   * see what it touches — so it has to be instant.
   */
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      const set = map.get(a) ?? new Set<string>();
      set.add(b);
      map.set(a, set);
    };
    for (const link of data.links) {
      add(link.source, link.target);
      add(link.target, link.source);
    }
    return map;
  }, [data.links]);

  const centers = useMemo(() => {
    const radius = 170;
    return CLUSTER_COLORS.map((_, i) => {
      const angle = (i / CLUSTER_COLORS.length) * Math.PI * 2;
      return {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius * 0.62,
        z: Math.sin(angle * 2) * 48,
      };
    });
  }, []);

  const nodeThreeObject = useCallback((node: HeroNode) => {
    const material = new THREE.MeshLambertMaterial({
      color: TANGLED_COLOR.clone(),
      transparent: true,
      opacity: 0.92,
    });
    materialsRef.current.set(node.id, material);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS[node.kind], 12, 10),
      material,
    );
    meshesRef.current.set(node.id, mesh);
    return mesh;
  }, []);

  /**
   * Point at a thing and its connections light up while everything else steps
   * back. This is the one interaction the product is actually about, so the
   * landing page demonstrates it rather than describing it.
   *
   * Nothing is ever hidden — unrelated pieces fall to 18% rather than to zero.
   * A map that blanks out is a map that has stopped telling you the truth about
   * the rest of your app, and that is the habit this product is trying to break.
   */
  const handleNodeHover = useCallback(
    (node: HeroNode | null) => {
      hoverRef.current = node
        ? { id: node.id, near: neighbours.get(node.id) ?? new Set() }
        : null;
      wakeRef.current?.();
    },
    [neighbours],
  );

  /**
   * Forces are registered on the engine's first tick, not in a mount effect.
   *
   * Two reasons. A mount effect that starts `if (!fg) return` fails silently
   * when the ref is not populated yet — the cluster force is never registered,
   * the graph never untangles, and nothing explains why. And the engine is
   * only safe to poke once it has ticked at least once: calling
   * d3ReheatSimulation() before then reaches into a layout that does not exist
   * yet and throws from inside the library.
   */
  const handleEngineTick = useCallback(() => {
    if (engineReadyRef.current) return;
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("cluster", makeClusterForce(centers, strengthRef));
    fg.d3Force("charge")?.strength(-58);
    engineReadyRef.current = true;
    wakeRef.current?.();
  }, [centers]);

  /**
   * One loop drives everything: the cluster force, the node colours, a small
   * parallax from the pointer, and the scene's own slow drift. Reading refs
   * here rather than re-rendering means none of it ever re-renders React.
   *
   * **The drift is why this no longer parks itself.** The loop used to stop
   * after ninety idle frames, so the graph held perfectly still until the page
   * scrolled or the pointer moved — which read as a screenshot that reacts to
   * scrolling rather than as a living thing. It now turns continuously: a
   * revolution takes about two and a half minutes, and the distance breathes on
   * a period that shares no factor with it, so the scene never repeats a pose.
   *
   * What it does NOT do is keep the simulation hot. The force layout is the
   * expensive half — reheating it every frame is what turns a landing page into
   * a fan-spinner — so the nodes hold the shape they settled into and the
   * camera is what moves. Parallax does the rest: every node's position on
   * screen changes every frame, which is the thing the eye reads as alive.
   *
   * It still stops dead when the hero is off screen or the tab is hidden, and
   * it never starts when the reader has asked for reduced motion.
   */
  useEffect(() => {
    let raf = 0;
    let running = false;
    let shownProgress = -1;
    let shownHover = "";
    let shownYaw = Number.NaN;
    let shownPitch = Number.NaN;
    const target = new THREE.Color();
    const projected = new THREE.Vector3();
    let placeLabels = true;

    /*
     * Someone who has asked their system for less motion gets the old
     * behaviour: everything still responds, nothing moves on its own.
     */
    const alive = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const started = performance.now();
    /**
     * Radians per second. A full turn in about four minutes.
     *
     * Slower than the first version, which turned in two and a half. The pass
     * that made this run continuously also made every one of its numbers into
     * something a reader sees for as long as they are on the page, rather than
     * for the second they spend scrolling — and at that exposure the difference
     * between "drifting" and "being moved" is most of the effect.
     */
    const DRIFT_RATE = 0.026;

    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      running = false;
    };

    function tick() {
      if (!visibleRef.current || document.hidden) {
        stop();
        return;
      }

      const fg = fgRef.current;
      const p = progressRef.current;
      // Smoothstep, so the untangle accelerates rather than moving linearly.
      const eased = p * p * (3 - 2 * p);
      let didWork = false;

      const hover = hoverRef.current;
      const hoverKey = hover ? hover.id : "";

      if (Math.abs(eased - shownProgress) > 0.0015 || hoverKey !== shownHover) {
        shownProgress = eased;
        shownHover = hoverKey;
        strengthRef.current = eased;

        for (const node of data.nodes) {
          const material = materialsRef.current.get(node.id);
          if (!material) continue;

          target.set(CLUSTER_COLORS[node.cluster]);
          material.color.copy(TANGLED_COLOR).lerp(target, eased);

          // Nothing is hidden: unrelated pieces fall to 18%, never to zero.
          const related =
            !hover || node.id === hover.id || hover.near.has(node.id);
          material.opacity = related ? 0.94 : 0.18;

          const mesh = meshesRef.current.get(node.id);
          if (mesh) {
            const scale = hover && node.id === hover.id ? 1.6 : 1;
            mesh.scale.setScalar(scale);
          }
        }

        if (fg && engineReadyRef.current) fg.d3ReheatSimulation();
        didWork = true;
      }

      /*
       * Three motions on periods that share no factor, so the composite never
       * comes back around: the turn, a slow nod, and the breath in and out.
       * Small amplitudes — this is a background, and a camera that swings is a
       * camera the reader has to wait for before they can read the headline.
       */
      const t = (performance.now() - started) / 1000;
      const yaw = pointerRef.current.x * 0.22 + (alive ? t * DRIFT_RATE : 0);
      const pitch =
        pointerRef.current.y * 0.14 + (alive ? Math.sin(t * 0.071) * 0.035 : 0);
      const breath = alive ? Math.sin(t * 0.049) * 10 : 0;
      /*
       * `alive` first, and it is not an optimisation — it is the fix for a
       * visible judder.
       *
       * The thresholds below exist so that a pointer resting still does not
       * redraw the scene sixty times a second. They are fine for input, which
       * either moves or does not, and wrong for a drift, which moves
       * continuously and slowly: at 0.026 rad/s a frame advances the yaw by
       * 0.00043 rad, which is under the 0.0015 gate, so the camera sat still
       * for three or four frames and then jumped the accumulated amount. A jump
       * every ~58ms is not slow motion, it is vibration — and because it is the
       * camera, every node and every name vibrated together, which is exactly
       * what it looked like.
       *
       * With the drift on, something has always changed, so the gate has
       * nothing left to protect and is skipped.
       */
      if (
        alive ||
        didWork ||
        Math.abs(yaw - shownYaw) > 0.0015 ||
        Math.abs(pitch - shownPitch) > 0.0015
      ) {
        shownYaw = yaw;
        shownPitch = pitch;
        placeLabels = true;
        // Drive the three.js camera directly. cameraPosition() goes through
        // the library's transition machinery, which is not meant to be called
        // every frame.
        const camera = fg?.camera();
        if (camera) {
          const distance = BASE_DISTANCE - eased * 90 + breath;
          camera.position.set(
            Math.sin(yaw) * distance,
            Math.sin(pitch) * distance * 0.5,
            Math.cos(yaw) * distance,
          );
          camera.lookAt(0, 0, 0);
        }
        didWork = true;
      }

      /**
       * The names arrive with the map.
       *
       * This is the whole pitch in one gesture: a tangle of grey becomes six
       * named places. The labels are HTML over the canvas rather than sprites
       * in the scene — real text, selectable, readable by a screen reader, and
       * it costs no texture memory. Positions are written straight to the DOM
       * because doing it through React state would re-render the tree sixty
       * times a second for six numbers.
       */
      if (placeLabels || didWork) {
        const camera = fg?.camera();
        const box = size;
        if (camera && box) {
          const visibleFrom = 0.45;
          const strength = Math.max(0, (eased - visibleFrom) / (1 - visibleFrom));
          for (let c = 0; c < centers.length; c++) {
            const el = labelsRef.current[c];
            if (!el) continue;
            projected.set(centers[c].x, centers[c].y, centers[c].z);
            projected.project(camera);
            const x = (projected.x * 0.5 + 0.5) * box.width;
            const y = (-projected.y * 0.5 + 0.5) * box.height;
            // Behind the camera projects to a mirrored point; hide rather than
            // draw a name in the wrong place.
            const behind = projected.z > 1;
            /*
             * Subpixel, not rounded.
             *
             * Rounding was there to keep the text crisp, and it was right while
             * the labels only moved during a scroll. With the scene drifting on
             * its own they move about sixteen pixels a second — which in whole
             * pixels is a visible step every sixty milliseconds, and a word
             * stepping at that rate does not read as travelling, it reads as
             * vibrating. `will-change: transform` (set on the element) puts each
             * label on its own compositor layer, so the glyphs are rasterised
             * once and the GPU moves the layer, and the motion is continuous.
             */
            el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) translate(-50%, -50%)`;
            el.style.opacity = behind ? "0" : String(strength * 0.9);
          }
        }
      }

      idleFramesRef.current = didWork ? 0 : idleFramesRef.current + 1;

      // Keep rendering a tail of frames so the layout visibly settles. With the
      // drift on there is always something to do, so this is the reduced-motion
      // path — and the guard is written against `alive` rather than left to the
      // frame counter never reaching 90, because a condition that happens to be
      // unreachable is not the same as one that says what it means.
      if (!alive && idleFramesRef.current > 90) {
        stop();
        return;
      }

      raf = requestAnimationFrame(tick);
    }

    const start = () => {
      if (running || !visibleRef.current || document.hidden) return;
      running = true;
      idleFramesRef.current = 0;
      raf = requestAnimationFrame(tick);
    };

    wakeRef.current = start;

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      wakeRef.current = null;
      stop();
    };
  }, [data.nodes, progressRef, centers, size]);

  /** Only animate while the hero is actually on screen. */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = entry.isIntersecting;
        if (entry.isIntersecting) wakeRef.current?.();
      },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointerRef.current = {
        x: (event.clientX / window.innerWidth) * 2 - 1,
        y: (event.clientY / window.innerHeight) * 2 - 1,
      };
      wakeRef.current?.();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useEffect(() => {
    const materials = materialsRef.current;
    return () => {
      for (const material of materials.values()) material.dispose();
      materials.clear();
    };
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden" aria-hidden="true">
      {size === null ? null : (
      <ForceGraph3D<HeroNode, HeroLink>
        ref={fgRef}
        width={size.width}
        height={size.height}
        graphData={data}
        backgroundColor="rgba(0,0,0,0)"
        showNavInfo={false}
        enableNodeDrag={false}
        enablePointerInteraction={true}
        onNodeHover={handleNodeHover}
        enableNavigationControls={false}
        nodeThreeObject={nodeThreeObject}
        // A guess reads as a guess even at a glance: thinner, dimmer, cooler.
        // This is the page making the product's central promise visually, not
        // in copy — we tell you what we know and what we are only guessing.
        linkColor={(link: HeroLink) => (link.certain ? "#7d776a" : "#46423b")}
        linkWidth={(link: HeroLink) => (link.certain ? 0.85 : 0.3)}
        linkOpacity={0.55}
        warmupTicks={8}
        cooldownTime={6000}
        onEngineTick={handleEngineTick}
      />
      )}

      {/*
        Real text over the canvas, not sprites in the scene. It is selectable,
        it is in the accessibility tree, and it needs no texture memory. Hidden
        from assistive tech only because the whole hero is decorative — the
        headline beside it carries the meaning.
      */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {CLUSTER_LABELS.map((label, index) => (
          <span
            key={label}
            ref={(el) => {
              labelsRef.current[index] = el;
            }}
            className="absolute top-0 left-0 text-[13px] font-semibold tracking-[0.14em] whitespace-nowrap opacity-0 transition-opacity duration-500 [will-change:transform]"
            style={{ color: CLUSTER_COLORS[index] }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
