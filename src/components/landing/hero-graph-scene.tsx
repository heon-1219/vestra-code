"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";

type HeroNode = {
  id: string;
  cluster: number;
  isHub: boolean;
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

/** The colour every node starts as: undifferentiated, before we know anything. */
const TANGLED_COLOR = new THREE.Color("#5c574c");

const BASE_DISTANCE = 470;

/**
 * A synthetic graph shaped like a small real app: a few hub symbols shared
 * across clusters, most nodes local to one. Illustrative, not a real analysis —
 * the page says so in copy, because the brief forbids presenting anything
 * fabricated as real.
 */
function buildGraph(): { nodes: HeroNode[]; links: HeroLink[] } {
  const nodes: HeroNode[] = [];
  const links: HeroLink[] = [];
  const perCluster = 13;

  for (let c = 0; c < CLUSTER_COLORS.length; c++) {
    for (let i = 0; i < perCluster; i++) {
      nodes.push({ id: `n${c}-${i}`, cluster: c, isHub: i === 0 });
    }
  }

  for (let c = 0; c < CLUSTER_COLORS.length; c++) {
    for (let i = 1; i < perCluster; i++) {
      links.push({
        source: `n${c}-${i}`,
        target: `n${c}-${Math.floor(Math.sqrt(i))}`,
        certain: i % 5 !== 0,
      });
      if (i % 4 === 0 && i + 2 < perCluster) {
        links.push({
          source: `n${c}-${i}`,
          target: `n${c}-${i + 2}`,
          certain: i % 3 !== 0,
        });
      }
    }
  }

  // The shared helpers — why the resolved picture still has structure between
  // districts rather than six disconnected balls.
  for (let c = 0; c < CLUSTER_COLORS.length; c++) {
    const next = (c + 1) % CLUSTER_COLORS.length;
    links.push({ source: `n${c}-0`, target: `n${next}-0`, certain: true });
    links.push({ source: `n${c}-3`, target: `n${next}-5`, certain: false });
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
  const pointerRef = useRef({ x: 0, y: 0 });
  const visibleRef = useRef(true);
  const engineReadyRef = useRef(false);
  const idleFramesRef = useRef(0);
  const wakeRef = useRef<(() => void) | null>(null);

  const data = useMemo(buildGraph, []);

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
    return new THREE.Mesh(
      new THREE.SphereGeometry(node.isHub ? 4.6 : 2.7, 12, 10),
      material,
    );
  }, []);

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
   * One loop drives everything scroll changes: the cluster force, the node
   * colours, and a small parallax from the pointer. Reading refs here rather
   * than re-rendering means scrolling never re-renders React.
   *
   * It stops when there is nothing to do — hero off screen, tab hidden, or
   * neither progress nor pointer moved. A permanently running rAF next to a
   * simulation that never cools is what turns a landing page into a
   * fan-spinner, and Step 1's done-when is that this stays smooth on a
   * mid-range laptop.
   */
  useEffect(() => {
    let raf = 0;
    let running = false;
    let shownProgress = -1;
    let shownYaw = Number.NaN;
    let shownPitch = Number.NaN;
    const target = new THREE.Color();

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

      if (Math.abs(eased - shownProgress) > 0.0015) {
        shownProgress = eased;
        strengthRef.current = eased;
        for (const node of data.nodes) {
          const material = materialsRef.current.get(node.id);
          if (!material) continue;
          target.set(CLUSTER_COLORS[node.cluster]);
          material.color.copy(TANGLED_COLOR).lerp(target, eased);
        }
        if (fg && engineReadyRef.current) fg.d3ReheatSimulation();
        didWork = true;
      }

      const yaw = pointerRef.current.x * 0.22;
      const pitch = pointerRef.current.y * 0.14;
      if (
        didWork ||
        Math.abs(yaw - shownYaw) > 0.0015 ||
        Math.abs(pitch - shownPitch) > 0.0015
      ) {
        shownYaw = yaw;
        shownPitch = pitch;
        // Drive the three.js camera directly. cameraPosition() goes through
        // the library's transition machinery, which is not meant to be called
        // every frame.
        const camera = fg?.camera();
        if (camera) {
          const distance = BASE_DISTANCE - eased * 90;
          camera.position.set(
            Math.sin(yaw) * distance,
            Math.sin(pitch) * distance * 0.5,
            Math.cos(yaw) * distance,
          );
          camera.lookAt(0, 0, 0);
        }
        didWork = true;
      }

      idleFramesRef.current = didWork ? 0 : idleFramesRef.current + 1;

      // Keep rendering a tail of frames so the layout visibly settles.
      if (idleFramesRef.current > 90) {
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
  }, [data.nodes, progressRef]);

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
    <div ref={wrapRef} className="h-full w-full" aria-hidden="true">
      <ForceGraph3D<HeroNode, HeroLink>
        ref={fgRef}
        graphData={data}
        backgroundColor="rgba(0,0,0,0)"
        showNavInfo={false}
        enableNodeDrag={false}
        enablePointerInteraction={false}
        enableNavigationControls={false}
        nodeThreeObject={nodeThreeObject}
        linkColor={(link: HeroLink) => (link.certain ? "#6b6659" : "#3c3831")}
        linkWidth={(link: HeroLink) => (link.certain ? 0.7 : 0.35)}
        linkOpacity={0.5}
        warmupTicks={8}
        cooldownTime={6000}
        onEngineTick={handleEngineTick}
      />
    </div>
  );
}
