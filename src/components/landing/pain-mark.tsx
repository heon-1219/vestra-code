/**
 * A mark for each of the three numbered pains.
 *
 * The numerals 01 / 02 / 03 are the only non-text on that band today, and a
 * numeral carries no meaning of its own — it says "there are three" and stops.
 * These three drawings say what each one is before the sentence under it does:
 * three of the same thing, a break that travelled down a wire, lines going
 * somewhere you cannot see. A reader scanning the page gets the shape of the
 * argument without reading it, which is the entire complaint being answered.
 *
 * Every mark is decorative and says so. The title and body beside it already
 * make the claim in the user's own voice (해요체, quoted — D74), so a screen
 * reader that also announced the picture would hear the same thing twice.
 *
 * `currentColor` and nothing else, so each mark takes the colour of the numeral
 * it sits beside and follows it on hover, in a future light theme, anywhere.
 * Explicitly not the lamp amber: these are not places you act.
 *
 * Keyed by index because the page's own `.map()` already computes one for the
 * numeral, which keeps the integration to one line. An index with no mark
 * renders nothing rather than falling back to a neighbour's picture — a mark
 * that tells a different story from the words beside it is worse than no mark.
 */

/** In the order the page lists them: 중복, 연쇄 파손, 알 수 없는 연결. */
function markFor(index: number): React.ReactNode {
  switch (index) {
    // "이미 있는 걸 또 만들었어요" — three identical shapes, evenly spaced. The
    // duplication IS the drawing: nothing distinguishes them, which is exactly
    // the complaint ("어느 게 진짜인지는 아무도 모릅니다").
    case 0:
      return (
        <>
          <rect x="1.5" y="8.5" width="7" height="7" rx="2" />
          <rect x="8.5" y="8.5" width="7" height="7" rx="2" />
          <rect x="15.5" y="8.5" width="7" height="7" rx="2" />
        </>
      );
    // "작은 수정이 다른 데를 부쉈어요" — two places joined by a line, with the
    // break drawn travelling along the join rather than sitting on either end.
    // The damage happened in between, which is the part nobody sees coming.
    case 1:
      return (
        <>
          <rect x="1" y="8.5" width="7" height="7" rx="2" />
          <rect x="16" y="8.5" width="7" height="7" rx="2" />
          <path d="M8 12h1.6l1.1-3 1.8 6 1.1-3H16" />
        </>
      );
    // "내 앱인데 건드리기가 무서워요" — one thing you can see, and four
    // connections running off the edge of what you can see. The rays end in
    // nothing on purpose; drawing a target at the far end would answer the
    // question the sentence says is unanswered.
    case 2:
      return (
        <>
          <circle cx="12" cy="12" r="3.2" />
          <g strokeDasharray="1 2.6">
            <path d="M14.5 9.9 21.5 5" />
            <path d="M14.3 14.3 20.8 19.2" />
            <path d="M9.4 13.8 3 17.6" />
            <path d="M9.6 9.8 4.2 5.2" />
          </g>
        </>
      );
    default:
      return null;
  }
}

export function PainMark({ index, className = "" }: { index: number; className?: string }) {
  const mark = markFor(index);
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
