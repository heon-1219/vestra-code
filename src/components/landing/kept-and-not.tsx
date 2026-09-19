/**
 * What is kept and what is not, drawn as the two-by-three thing it actually is.
 *
 * This is the page's most consequential claim — a sentence about someone's own
 * code, on the band whose whole argument is that we do not overstate — and
 * until now it was a paragraph that had to be read twice. The reason it is hard
 * to read is that it is not one promise: since D77 it is **two**, one per way
 * in, and the difference between them is the interesting part. A GitHub project
 * stores no source because the source can always be fetched again; an uploaded
 * folder has no origin to fetch from, so keeping its files is the only way its
 * map opens on a second computer. A relationship between two columns is drawn
 * far more honestly than it is described, and here the shape of the table is
 * itself the argument: two columns that agree, and one row where they do not.
 *
 * **A real `<table>`, not a picture of one.** Every word in every cell is text
 * — the mark beside it is a second channel for the same fact, not the only
 * one. A screen reader gets the row header and the answer ("파일 내용,
 * GitHub 저장소, 남지 않습니다") in the right order for free, which no SVG
 * arrangement of ticks and crosses can do. The marks are `aria-hidden` because
 * the word beside each one already says it.
 *
 * **The wording is lifted from the promise it illustrates, deliberately.** The
 * two notes under the table are the second and third sentences of the page's
 * own first promise, unchanged. A diagram that paraphrases a claim about a
 * user's own code is a diagram that will eventually disagree with it, and D77
 * records what that costs.
 *
 * `currentColor` throughout, so the two marks are the colour of the sentence
 * beside them: full text colour where something is kept, faint where it is
 * not. No lamp amber — nothing in this table is a place you act.
 */

type Row = {
  readonly what: string;
  readonly repo: boolean;
  readonly upload: boolean;
};

/**
 * Ordered least to most surprising, so the eye learns the two columns agree
 * before it reaches the row where they part.
 */
const ROWS: readonly Row[] = [
  { what: "지도", repo: true, upload: true },
  { what: "파일 경로와 줄 번호", repo: true, upload: true },
  { what: "파일 내용", repo: false, upload: true },
];

const REPO = "GitHub 저장소";
const UPLOAD = "올려주신 폴더";

export function KeptAndNot({ className = "" }: { className?: string }) {
  return (
    <div className={className}>
      {/*
        `table-fixed` with explicit column widths rather than automatic layout.
        An auto-laid-out table sizes itself from its content's minimum width,
        which at 375px is how a three-column table walks out of its container —
        the same failure mode as D72's grid, arrived at from the other side.
        With fixed columns the cells wrap instead, and Korean wraps on word
        boundaries, so nothing is cut off.
      */}
      {/*
        Centred as a block, with the row labels still left-aligned.
        
        Centring every cell too was the other option and it is worse: the first
        column is the question being asked of each row, and a column of
        questions ragged on both edges is one a reader has to hunt down rather
        than run down. The answers are centred under their own headings, which
        is what makes the one row where the two columns disagree visible
        without reading any of the words.
      */}
      <table className="w-full table-fixed border-collapse text-left">
        <caption className="mx-auto mb-7 max-w-[54ch] text-center text-copy text-said-soft">
          무엇이 남는지는 어떻게 연결했는지에 따라 다릅니다. 둘 중 어느 쪽인지
          언제나 먼저 말씀드립니다.
        </caption>
        <colgroup>
          <col className="w-[40%]" />
          <col className="w-[30%]" />
          <col className="w-[30%]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="pb-3">
              {/* The empty corner cell still needs a name, or a screen reader
                  reading the table's headers hears a blank where the question
                  is. */}
              <span className="sr-only">남는 것</span>
            </th>
            <th scope="col" className="pb-3 text-center text-micro font-medium text-said-faint">
              {REPO}
            </th>
            <th scope="col" className="pb-3 text-center text-micro font-medium text-said-faint">
              {UPLOAD}
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.what}>
              <th
                scope="row"
                className="rule-t py-4 pr-3 align-top text-copy font-normal text-said"
              >
                {row.what}
              </th>
              <Answer kept={row.repo} />
              <Answer kept={row.upload} />
            </tr>
          ))}
        </tbody>
      </table>

      {/*
        The reasons, per column, because a promise without its reason is a thing
        to be taken on trust and this band's whole point is that it should not
        have to be. Both sentences are the page's own, word for word.
      */}
      <dl className="mt-8 grid grid-cols-1 gap-x-2 gap-y-4 text-center sm:grid-cols-2 sm:gap-x-6 md:gap-x-8">
        <div>
          <dt className="text-micro font-medium text-said-faint">{REPO}</dt>
          <dd className="mt-1.5 text-copy text-said-soft">
            코드는 필요할 때 GitHub에서 가져와 읽고 곧바로 버립니다.
          </dd>
        </div>
        <div>
          <dt className="text-micro font-medium text-said-faint">{UPLOAD}</dt>
          <dd className="mt-1.5 text-copy text-said-soft">
            다시 가져올 곳이 없어서, 다른 컴퓨터에서도 열어보실 수 있게 파일을
            함께 보관합니다.
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * One cell. The mark sits above the word below `sm` rather than beside it: at
 * 375px a 30% column is about 98px, and "남지 않습니다" beside a mark on one line
 * would wrap into a two-line stub against a mark pinned to the middle of it.
 */
function Answer({ kept }: { kept: boolean }) {
  return (
    <td className={`rule-t py-4 align-top ${kept ? "text-said" : "text-said-faint"}`}>
      <span className="flex flex-col items-center gap-2 text-copy sm:flex-row sm:justify-center sm:gap-2.5">
        <KeepMark kept={kept} />
        {kept ? "남습니다" : "남지 않습니다"}
      </span>
    </td>
  );
}

/**
 * Two marks with the same outer ring, so the difference reads as a state of one
 * thing rather than as two unrelated symbols: a filled centre, or a line
 * through it.
 */
function KeepMark({ kept }: { kept: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="6.4" />
      {kept ? <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" /> : null}
      {kept ? null : <path d="M4.6 11.4 11.4 4.6" />}
    </svg>
  );
}
