"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

/**
 * `ssr: false` is illegal in a Server Component in the App Router, so the
 * dynamic import lives here, inside a client component (DECISIONS D21).
 *
 * The decision to load it happens BEFORE the import: three.js plus the graph
 * renderer is a large download, and a phone or a visitor who asked for reduced
 * motion gets the still picture instead and never pays for the bundle. Step 1's
 * done-when is that this page stays smooth on a mid-range laptop.
 */
const HeroGraphScene = dynamic(() => import("./hero-graph-scene"), {
  ssr: false,
  loading: () => <HeroGraphStill />,
});

function useShouldAnimate(): boolean | null {
  // null while undecided, so nothing renders on the first paint but the still.
  const [should, setShould] = useState<boolean | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const wide = window.matchMedia("(min-width: 900px)");
    const decide = () => setShould(!reduced.matches && wide.matches);
    decide();
    reduced.addEventListener("change", decide);
    wide.addEventListener("change", decide);
    return () => {
      reduced.removeEventListener("change", decide);
      wide.removeEventListener("change", decide);
    };
  }, []);

  return should;
}

/**
 * The still. Not a spinner and not a placeholder box — it is the same picture
 * at its resolved state, so a phone visitor sees the product's thesis rather
 * than an empty rectangle.
 */
function HeroGraphStill() {
  const clusters = [
    { cx: 300, cy: 150, r: 74, fill: "#d98e5f" },
    { cx: 470, cy: 250, r: 62, fill: "#7fa88c" },
    { cx: 250, cy: 330, r: 66, fill: "#8a9bc4" },
    { cx: 460, cy: 90, r: 48, fill: "#c08497" },
    { cx: 130, cy: 220, r: 44, fill: "#b9a45c" },
    { cx: 380, cy: 400, r: 40, fill: "#7e9ba8" },
  ];
  return (
    <svg
      viewBox="0 0 600 480"
      className="h-full w-full opacity-80"
      aria-hidden="true"
    >
      {clusters.map((a, i) =>
        clusters.slice(i + 1).map((b, j) => (
          <line
            key={`${i}-${j}`}
            x1={a.cx}
            y1={a.cy}
            x2={b.cx}
            y2={b.cy}
            stroke="#46423b"
            strokeWidth={j % 2 ? 0.6 : 1}
            strokeDasharray={j % 2 ? "3 4" : undefined}
          />
        )),
      )}
      {clusters.map((c) => (
        <g key={`${c.cx}-${c.cy}`}>
          <circle cx={c.cx} cy={c.cy} r={c.r} fill={c.fill} opacity={0.13} />
          <circle cx={c.cx} cy={c.cy} r={5.5} fill={c.fill} />
        </g>
      ))}
    </svg>
  );
}

export function HeroGraph() {
  const shouldAnimate = useShouldAnimate();
  const progressRef = useRef(0);
  const sectionRef = useRef<HTMLDivElement>(null);

  /**
   * Scroll drives the untangle. Written to a ref and read inside the scene's
   * animation loop, so scrolling never triggers a React render.
   */
  useEffect(() => {
    const onScroll = () => {
      const el = sectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const travel = rect.height - window.innerHeight;
      if (travel <= 0) {
        progressRef.current = 1;
        return;
      }
      const scrolled = Math.min(Math.max(-rect.top, 0), travel);
      progressRef.current = scrolled / travel;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div ref={sectionRef} className="absolute inset-0">
      <div className="sticky top-0 h-screen w-full">
        {shouldAnimate === true ? (
          <HeroGraphScene progressRef={progressRef} />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-8">
            <div className="h-full max-h-[520px] w-full max-w-[600px]">
              <HeroGraphStill />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
