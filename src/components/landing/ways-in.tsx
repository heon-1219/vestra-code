/**
 * The three ways in, with a mark on each.
 *
 * The page says "GitHub 저장소를 고르거나 폴더를 올리면" and leaves it there, which
 * quietly costs us the third door and most of the first one: a visitor whose
 * project was never pushed anywhere reads that sentence and concludes the
 * product is not for them, when for this product's user an un-pushed folder is
 * arguably the common case (D62). Three marks in a row say "there are three
 * doors and one of them is yours" before a word is read.
 *
 * The order is the order of the front door, not of the implementation: picking
 * a repository from a list you already recognise first, pasting an address as
 * the fallback it is (D60), uploading a folder last because it is the one a
 * visitor will not expect.
 *
 * Marks are `aria-hidden` and the words carry everything — each mark is a
 * 24×24 stroke drawing in `currentColor`, so it takes the colour of the text
 * beside it and can never be the only place something is said. No lamp amber:
 * the accent means "you act here", and these sit beside the one button that
 * does.
 *
 * Server component. Nothing here has state, and nothing animates — the section
 * entrance the page already applies (`rise`) is the only motion this needs.
 */

type Way = {
  readonly title: string;
  readonly body: string;
  /** Drawn at the origin of a 24×24 box, stroked, no fill. */
  readonly mark: React.ReactNode;
};

const WAYS: readonly Way[] = [
  {
    title: "GitHub 저장소 고르기",
    body: "로그인하면 내 저장소가 목록으로 나옵니다. 이름을 알아보고 고르기만 하면 됩니다.",
    // A list with one row picked out. Not a GitHub logo: a brand mark here
    // would be the biggest thing in the row and would say "GitHub" rather than
    // "고르기", which is the part that is new to the reader.
    mark: (
      <>
        <path d="M3.5 5.5h17M3.5 12h17M3.5 18.5h17" opacity="0.45" />
        <rect x="1.5" y="9" width="21" height="6" rx="2" opacity="1" />
        <path d="M17.5 12h2.5" />
      </>
    ),
  },
  {
    title: "주소 붙여넣기",
    body: "목록에 없는 저장소는 주소를 붙여넣어서 연결합니다.",
    // Two links of a chain. The field it gets pasted into is the product's
    // chrome; the address itself is the idea.
    mark: (
      <>
        <path d="M10 14a4 4 0 0 1 0-5.66l2.5-2.5a4 4 0 0 1 5.66 5.66l-1.4 1.4" />
        <path d="M14 10a4 4 0 0 1 0 5.66l-2.5 2.5a4 4 0 0 1-5.66-5.66l1.4-1.4" />
      </>
    ),
  },
  {
    title: "폴더 올리기",
    body: "GitHub에 올린 적 없는 프로젝트는 내 컴퓨터의 폴더를 그대로 올립니다.",
    // A folder with an arrow going up out of it. The arrow points out of the
    // opening rather than down into it, because the direction is the whole
    // difference between "올리기" and "받기".
    mark: (
      <>
        <path d="M2.5 19V6.5a1 1 0 0 1 1-1h5.6l2 2.5h9.4a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1Z" />
        <path d="M12 17.5v-6M9 14l3-3 3 3" />
      </>
    ),
  },
];

export function WaysIn({ className = "" }: { className?: string }) {
  return (
    /*
      One column until there is room for three. The gutter stays small below
      `sm` for the same reason the page's own grids do (D72): a generous gutter
      at 375px eats the content box rather than the space between things.
    */
    <ul className={`grid grid-cols-1 gap-x-2 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:gap-x-8 ${className}`}>
      {WAYS.map((way) => (
        <li key={way.title}>
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
            className="h-6 w-6 shrink-0 text-said-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {way.mark}
          </svg>
          <h3 className="mt-4 text-[16px] font-semibold tracking-[-0.022em]">{way.title}</h3>
          <p className="mt-2 text-copy text-said-soft">{way.body}</p>
        </li>
      ))}
    </ul>
  );
}
