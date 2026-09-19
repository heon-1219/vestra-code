/**
 * The language a repository is written in, drawn rather than spelled.
 *
 * A word per row turned the list into a table of metadata, and the word is the
 * least useful thing in it — someone scanning for a project recognises it by
 * name, and the language is a glance. A coloured dot is also the treatment
 * GitHub itself uses in its own repository lists, so it arrives already learned
 * for anyone who has looked at one.
 *
 * The colours are GitHub's own linguist colours, written in here by value. That
 * matters twice: nothing is downloaded at runtime, and the dot beside a
 * TypeScript repository is the blue that reader has seen beside every other
 * TypeScript repository.
 *
 * **The name never leaves the page, it only stops being visible.** A colour on
 * its own tells a screen reader nothing at all and tells a colour-blind reader
 * very little, so it stays as the accessible name and as the hover title.
 *
 * A language we have no colour for is drawn as a ring rather than as a guessed
 * colour. A wrong colour would be worse than an honest blank, because these
 * colours are the only thing that makes the dot readable at all.
 */

/**
 * GitHub's linguist colours, for the languages this product's users actually
 * ship in. Adding one is adding a line; the ring is what covers the rest.
 */
const LANGUAGE_COLOURS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  HTML: "#e34c26",
  CSS: "#663399",
  SCSS: "#c6538c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Astro: "#ff5a03",
  MDX: "#fcb32c",
  Python: "#3572a5",
  Ruby: "#701516",
  PHP: "#4f5d95",
  Java: "#b07219",
  Kotlin: "#a97bff",
  Swift: "#f05138",
  Dart: "#00b4ab",
  Go: "#00add8",
  Rust: "#dea584",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  Shell: "#89e051",
  Lua: "#000080",
  Elixir: "#6e4a7e",
  Haskell: "#5e5086",
  Scala: "#c22d40",
  Perl: "#0298c3",
  R: "#198ce7",
  Solidity: "#aa6746",
  Zig: "#ec915c",
  Nix: "#7e7eff",
  "Jupyter Notebook": "#da5b0b",
};

export function LanguageMark({ language }: { language: string | null }) {
  // GitHub reports no language for an empty repository and for one made only of
  // files it does not count. Nothing is the honest mark for that.
  if (!language) return null;

  const colour = LANGUAGE_COLOURS[language];

  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      role="img"
      aria-label={`주로 쓰인 언어: ${language}`}
      className="shrink-0 text-said-faint"
    >
      {/* Shown as a tooltip. `aria-label` above is what a screen reader reads,
          so this one is written for the eye and stays short. */}
      <title>{language}</title>
      {colour ? (
        <circle cx="6" cy="6" r="6" fill={colour} />
      ) : (
        <circle
          cx="6"
          cy="6"
          r="5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      )}
    </svg>
  );
}
