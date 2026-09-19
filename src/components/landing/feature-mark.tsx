/**
 * A mark for each of the four capabilities — 지도 · 질문 · 연결 · 프롬프트.
 *
 * Those four words are the page's only summary of what the product does, and
 * as bare eyebrows they are four abstractions in a row: a reader who cannot
 * read code has no picture attached to "연결" until they have read the two
 * sentences under it. Each mark draws the mechanism rather than a category
 * icon — the beam falling on one place, the hub with its neighbours, the
 * prompt with one part allowed and one part locked — so the eyebrow arrives
 * already meaning something.
 *
 * Decorative, always. The eyebrow it sits beside is the label; a screen reader
 * that announced both would read the same word twice.
 *
 * `currentColor` only, and never the lamp amber. These sit inside cards that
 * already lift on hover, and a coloured picture in each one would turn a
 * four-card mosaic into four competing advertisements.
 *
 * Keyed by the eyebrow's own text, so the integration is one line inside the
 * page's existing `.map()` and no data has to change. An unknown word renders
 * nothing rather than guessing: a mark that tells a different story from the
 * words beside it is worse than no mark. `landing-visuals.test.ts` pins all
 * four words, so renaming an eyebrow without renaming its mark turns a test
 * red instead of quietly emptying a card.
 */
function markFor(name: string): React.ReactNode {
  switch (name) {
    // 지도 — a sheet with named places on it and a road between them. Not a
    // globe or a pin: this map has no geography, and the thing worth drawing
    // is that two areas are joined.
    case "지도":
      return (
        <>
          <rect x="1.5" y="3.5" width="21" height="17" rx="2.5" />
          <rect x="4.5" y="6.5" width="7.5" height="5.5" rx="1.8" />
          <rect x="13.5" y="12.5" width="6" height="5" rx="1.8" />
          <path d="M8.5 12v2.5a2 2 0 0 0 2 2h2.5" opacity="0.55" />
        </>
      );
    // 질문 — a typed line, and below it one place lit while the others stay
    // dim. The product's answer to a question is not text appearing under a
    // box; it is the map re-lighting, and that is what this draws.
    case "질문":
      return (
        <>
          <path d="M3.5 5.5h13" />
          <path d="M19 3.8v3.4" />
          <rect x="2.5" y="13" width="5.5" height="5.5" rx="1.6" opacity="0.4" />
          <rect x="9.25" y="13" width="5.5" height="5.5" rx="1.6" fill="currentColor" />
          <rect x="16" y="13" width="5.5" height="5.5" rx="1.6" opacity="0.4" />
        </>
      );
    // 연결 — one thing chosen and everything attached to it, which is the
    // picture the panel actually draws when you select something.
    case "연결":
      return (
        <>
          <path d="M12 12 4.8 5.6M12 12l7.6-4.4M12 12l4.4 7.4" opacity="0.6" />
          <circle cx="12" cy="12" r="2.8" fill="currentColor" />
          <circle cx="4" cy="5" r="2" />
          <circle cx="20.2" cy="6.8" r="2" />
          <circle cx="17" cy="20" r="2" />
        </>
      );
    // 프롬프트 — a written instruction with one part allowed and one part shut.
    // The tick and the cross are the sentence "어디를 고쳐도 되고 어디는
    // 건드리면 안 되는지까지 적힌" drawn, which is the only part of this feature a
    // reader will not already assume.
    case "프롬프트":
      return (
        <>
          <rect x="2.5" y="3.5" width="19" height="17" rx="2.5" />
          <path d="M5.6 9.4 7 10.8l2.6-2.8" />
          <path d="M11.8 9.6h6.6" />
          <path d="m6 13.9 2.4 2.4M8.4 13.9 6 16.3" opacity="0.7" />
          <path d="M11.8 15.1h6.6" opacity="0.5" />
        </>
      );
    default:
      return null;
  }
}

export function FeatureMark({ name, className = "" }: { name: string; className?: string }) {
  const mark = markFor(name);
  if (mark === null) return null;

  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={`h-6 w-6 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {mark}
    </svg>
  );
}
