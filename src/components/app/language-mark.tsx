/**
 * The language a repository is written in, as its own mark.
 *
 * This was a coloured dot using GitHub's linguist palette, and the palette was
 * the problem. Those colours are chosen to be distinguishable against GitHub's
 * white list, not to sit in a dark, near-monochrome interface with one accent —
 * dropped in here, a yellow dot beside a red one beside a violet one reads as
 * three stickers rather than as three facts, and the brightest thing in the row
 * ends up being the metadata rather than the project's own name.
 *
 * So the mark keeps the shape and gives up the colour. **JS and TS are letters
 * in a square in their own logos**, which is what makes this honest rather than
 * a retreat to text: the tile IS the mark for most of what this list shows, and
 * the ones whose real logo is a drawing are given the same tile so the column
 * reads as one set instead of an assortment.
 *
 * Every tile is `currentColor`, so it takes the row's own colour and brightens
 * with it on hover rather than being separately themed. Nothing is downloaded:
 * no icon font, no CDN, no dependency, and no `<img>` that would flash in after
 * the row it belongs to.
 *
 * **The full name never leaves the page, it only stops being visible.** Two
 * letters tell a screen reader nothing, so the name is the accessible text and
 * the hover title; the tile itself is `aria-hidden`.
 *
 * A language we have no short form for gets its own first two letters rather
 * than a placeholder. It is occasionally an odd pair, and it is always the
 * truth about what GitHub reported — which beats a generic mark that says only
 * "some language".
 */

/**
 * The conventional short form per language, which is the one a person already
 * reads on a file tab or a syntax badge. Deliberately not derived — `Jupyter
 * Notebook` shortens to `JN` by rule and to `PY` by what it actually contains,
 * and `C++` is two characters that are not its first two.
 */
const SHORT_NAMES: Record<string, string> = {
  TypeScript: "TS",
  JavaScript: "JS",
  HTML: "HT",
  CSS: "CSS",
  SCSS: "SC",
  Less: "LE",
  Vue: "VUE",
  Svelte: "SV",
  Astro: "AS",
  MDX: "MD",
  Markdown: "MD",
  Python: "PY",
  "Jupyter Notebook": "PY",
  Ruby: "RB",
  PHP: "PHP",
  Java: "JV",
  Kotlin: "KT",
  Swift: "SW",
  "Objective-C": "OC",
  Dart: "DT",
  Go: "GO",
  Rust: "RS",
  C: "C",
  "C++": "C++",
  "C#": "C#",
  Shell: "SH",
  PowerShell: "PS",
  Dockerfile: "DK",
  Makefile: "MK",
  SQL: "SQL",
  Elixir: "EX",
  Haskell: "HS",
  Lua: "LUA",
  Perl: "PL",
  R: "R",
  Scala: "SC",
  Solidity: "SOL",
  Zig: "ZIG",
};

/**
 * How wide the tile's text may be before it stops being a tile.
 *
 * Three characters is the ceiling — `C++`, `CSS`, `PHP`, `VUE` — and the text
 * is tracked in rather than shrunk, because a tile whose type size changes per
 * language makes a column of them look ragged.
 */
function shortNameFor(language: string): string {
  const known = SHORT_NAMES[language];
  if (known) return known;
  return language.slice(0, 2).toUpperCase();
}

export function LanguageMark({ language }: { language: string | null }) {
  // No language at all is normal: an empty repository, or one of only data
  // files. Nothing is drawn rather than a mark meaning "we do not know", which
  // would be one more thing in the row to decode.
  if (!language) return null;

  const short = shortNameFor(language);

  return (
    <span title={language} className="inline-flex shrink-0 items-center">
      <span
        aria-hidden="true"
        className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[5px] border border-edge px-1 font-mono text-[9px] leading-none font-semibold tracking-[0.02em] text-said-faint"
      >
        {short}
      </span>
      <span className="sr-only">주로 쓰인 언어: {language}</span>
    </span>
  );
}
