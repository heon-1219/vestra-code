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
          /*
            The graph is masked, not dimmed, and the difference matters.

            Full bleed, it ran at the same strength under the headline as it
            did in the open, and the two smallest lines in the hero — the
            paragraph and the caption beside the button — were being read
            across lit links. The obvious fix is a dark panel behind the text,
            but everything in this hero paints ABOVE the sky, so a panel takes
            the aurora with it, and the crown light is upper left: exactly
            where the words are. A mask is applied to this layer alone, so the
            web thins out over the reading column and the sky behind it is
            untouched.

            It thins to a quarter rather than to nothing. At zero the hero
            reads as two unrelated halves, a page and a picture; at a quarter
            the same tangle runs behind the sentence that describes it, which
            is the whole reason it is there. A mask changes paint only, so a
            node under the faded part is still hoverable.
          */
          <div
            className="h-full w-full"
            style={{
              maskImage:
                "linear-gradient(100deg, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.28) 28%, rgba(0,0,0,0.72) 50%, rgba(0,0,0,1) 68%)",
              WebkitMaskImage:
                "linear-gradient(100deg, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.28) 28%, rgba(0,0,0,0.72) 50%, rgba(0,0,0,1) 68%)",
            }}
          >
            <HeroGraphScene progressRef={progressRef} />
          </div>
        ) : (
          /*
            Below `scene` the still is the whole picture, and the copy above it
            runs the full width of the screen — so the still is pushed to the
            bottom of the sticky box rather than centred in it. Centred, it
            landed exactly under the lede and the paragraph, which is the one
            place on a 375px screen where a drawing costs more than it gives.
            Sitting low it reads as a horizon under the sentence instead of a
            texture behind it.
          */
          <div
            className="flex h-full w-full items-end justify-center px-6 pb-12"
            style={{
              // Same idea as the scene's mask, turned through ninety degrees
              // because the copy above it runs the full width here: the
              // drawing arrives from underneath rather than from the side.
              maskImage:
                "linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.62) 34%, rgba(0,0,0,1) 62%)",
              WebkitMaskImage:
                "linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.62) 34%, rgba(0,0,0,1) 62%)",
            }}
          >
            <div className="h-full max-h-[380px] w-full max-w-[560px]">
              <HeroGraphStill />
            </div>
          </div>
        )}

        {/*
          The floor of the hero.

          The scene is a full-bleed canvas and the section under it is an
          opaque surface, so without this the sky, the links and the nodes are
          all cut by one straight horizontal line at the moment the hero stops
          sticking — spheres sliced in half across the full width of the page.
          Fading to the ink the next section sits on makes the same boundary a
          horizon. Decorative, and never in the way of the pointer, so hovering
          a node near the bottom edge still works.

          Shorter below `scene`, where the still is anchored to the bottom of
          this same box: at 26vh the floor swallowed the lower third of the one
          picture a phone visitor gets of what the product makes.
        */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[18vh] scene:h-[26vh]"
          style={{
            background:
              "linear-gradient(to top, var(--color-ink) 0%, color-mix(in oklab, var(--color-ink) 72%, transparent) 42%, transparent 100%)",
          }}
        />
      </div>
    </div>
  );
}
