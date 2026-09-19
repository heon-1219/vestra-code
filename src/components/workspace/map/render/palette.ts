/**
 * The map's colours, read from the document rather than written again here.
 *
 * Lifted out of `district-map.tsx` when the renderer was split up, unchanged in
 * behaviour. Two things in it are load-bearing:
 *
 *  - **Nothing invents a colour.** Every value comes from a CSS variable in
 *    globals.css, so the map cannot drift from the rest of the product, and
 *    D76's rule (the palette has exactly one accent and it means "you act
 *    here") holds on the canvas as well as in the DOM.
 *  - **`withAlpha` is memoised.** Parsing a hex string per primitive per frame
 *    is thousands of string operations a frame on a 300-item project.
 */

export type Palette = {
  surface: string;
  /** The six territory hues, in order. Which one a territory wears is `layout.ts`'s call. */
  hues: string[];
  /**
   * What an item is drawn in when colour is NOT carrying the grouping — see
   * `isGrouped` in `scene.ts`. A single quiet colour, because the alternative
   * (keep the hues, drop the meaning) is a picture that looks like it is saying
   * something and is not.
   */
  plain: string;
  wire: string;
  guess: string;
  said: string;
  saidSoft: string;
  saidFaint: string;
  lamp: string;
};

export const FALLBACK: Palette = {
  surface: "#080706",
  hues: ["#d98e5f", "#7fa88c", "#8a9bc4", "#c08497", "#b9a45c", "#7e9ba8"],
  plain: "#a9a294",
  wire: "#6b6659",
  guess: "#46423b",
  said: "#e8e2d6",
  saidSoft: "#a9a294",
  saidFaint: "#6f6a5e",
  lamp: "#f0c97f",
};

const alphaCache = new Map<string, string>();

/** `rgba()` from a token's hex, memoised. */
export function withAlpha(hex: string, alpha: number): string {
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

export function readPalette(el: HTMLElement): Palette {
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };
  return {
    surface: read("--color-ink-sunk", FALLBACK.surface),
    hues: FALLBACK.hues.map((fallback, i) => read(`--color-c${i + 1}`, fallback)),
    plain: read("--color-said-soft", FALLBACK.plain),
    wire: read("--color-wire", FALLBACK.wire),
    guess: read("--color-guess", FALLBACK.guess),
    said: read("--color-said", FALLBACK.said),
    saidSoft: read("--color-said-soft", FALLBACK.saidSoft),
    saidFaint: read("--color-said-faint", FALLBACK.saidFaint),
    lamp: read("--color-lamp", FALLBACK.lamp),
  };
}

/**
 * The colour a territory and the things in it are drawn in.
 *
 * `grouped` is the whole of the founder's "묶는 기준이 정의 되었을 때만": when the
 * grouping in force is not actually splitting this project, every territory
 * gets the same quiet colour instead of six that look like six answers.
 */
export function hueFor(palette: Palette, hue: number, grouped: boolean): string {
  if (!grouped) return palette.plain;
  return palette.hues[hue % palette.hues.length];
}
