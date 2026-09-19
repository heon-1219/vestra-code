/**
 * The product in one picture: a list of files on the left, the same project as
 * a map on the right.
 *
 * This claim is the page's whole thesis and it was carried entirely by a
 * paragraph — which is the one medium it cannot be carried in. The reader we
 * are addressing cannot read code, and asking them to read three lines of prose
 * about what reading code produces is asking them to take it on faith. The
 * picture is checkable in two seconds: six files go in, three named places come
 * out, the lines between them are visible.
 *
 * **HTML holds every word, SVG holds only the marks.** Korean text inside a
 * `viewBox` scales with the box, so a figure wide enough for a desktop sets its
 * labels at four pixels on a phone — and a caption that is part of the drawing
 * cannot be selected, translated or found. So the two panels are drawn, the
 * sentence under them is written, and the drawings are `aria-hidden`: a screen
 * reader gets the caption, which says everything the picture says.
 *
 * **The colours are the point of the left panel.** Each file row carries the
 * swatch of the district it ends up in, and the dot count inside each district
 * on the right equals the number of rows that fed it. Six in, six out. That
 * correspondence is what makes this a transformation rather than two unrelated
 * illustrations side by side, and it is the reason the file paths are the demo
 * repo's real ones (D5) rather than invented names.
 *
 * **No lamp amber anywhere.** The accent means "you act here"; a decoration
 * that borrows it puts every button on the page into competition with a
 * picture. The district hues are the map's own six (`--color-c1`…), which is
 * also what the visitor will see when their own map opens.
 *
 * Server component, no motion of its own. The hero already drifts and every
 * section already enters on `.rise`; a second thing that moves would make the
 * page restless, and the entrance this needs is the one the page already has —
 * pass `rise` in `className`.
 */

/** The map's three districts, in the order they are drawn. */
const PAYMENTS = "var(--color-c1)";
const CART = "var(--color-c2)";
const LOGIN = "var(--color-c3)";

/**
 * Real paths from the demo repository rather than invented ones. A made-up
 * file list is the kind of small lie that a reader who owns a Next.js project
 * would catch, on the page whose argument is that we do not make things up.
 */
const FILES: readonly { path: string; district: string }[] = [
  { path: "app/checkout/page.jsx", district: PAYMENTS },
  { path: "components/PayButton.jsx", district: PAYMENTS },
  { path: "app/api/orders/route.js", district: PAYMENTS },
  { path: "app/login/page.jsx", district: LOGIN },
  { path: "components/CartItem.jsx", district: CART },
  { path: "lib/kv.js", district: CART },
];

/* A sheet with a folded corner, 12 × 14, drawn at the origin so a row can just
   translate it. Stroked rather than filled: a filled glyph at this size on a
   near-black ground reads as a solid block. */
const SHEET = "M1.5 0.75h6l3.75 3.75v8.75h-9.75Z";
const SHEET_FOLD = "M7.5 0.75v3.75h3.75";

/** Row pitch inside the files panel, and the y of the first row. */
const ROW_PITCH = 22;
const ROW_TOP = 4;

export function RepoToMap({ className = "" }: { className?: string }) {
  return (
    <figure className={className}>
      {/*
        `minmax(0, 1fr)` rather than `1fr`. A bare `1fr` track is
        `minmax(auto, 1fr)`, and an SVG's `auto` minimum is its intrinsic size,
        so the track refuses to go below it and the grid pushes past its parent.
        That is the same family of bug as D72's twelve-column gutters, and this
        page has had a horizontal scrollbar twice already.
      */}
      <div className="grid items-center gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-8">
        <Panel label="파일 목록">
          <FilesPanel />
        </Panel>

        {/* Two arrows, one per axis, because the panels stack on a phone and a
            right-pointing arrow between two stacked boxes points at nothing.
            Both decorative — the caption says "읽어서 … 그립니다", which is the
            arrow's whole content. */}
        <svg
          viewBox="0 0 24 30"
          aria-hidden="true"
          focusable="false"
          className="mx-auto h-[30px] w-6 text-said-faint md:hidden"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2v24M5.5 20.5 12 27l6.5-6.5" />
        </svg>
        <svg
          viewBox="0 0 30 24"
          aria-hidden="true"
          focusable="false"
          className="hidden h-6 w-[30px] text-said-faint md:block"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 12h24M20.5 5.5 27 12l-6.5 6.5" />
        </svg>

        <Panel label="한 장의 지도">
          <MapPanel />
        </Panel>
      </div>

      {/*
        The text equivalent, and not a decoration on one. Everything the drawing
        asserts is here in words: what each side is, what the grouping is for,
        and what a line between two places means. If the SVG never loaded, this
        paragraph would still make the page's argument.
      */}
      <figcaption className="mt-7 max-w-[62ch] text-copy text-said-soft">
        왼쪽은 프로젝트에 들어 있는 파일이고, 오른쪽은 같은 프로젝트를 한 번
        읽어서 그린 지도입니다. 파일은 결제·로그인·장바구니처럼 사람이 쓰는 말로
        묶이고, 사이의 선은 무엇이 무엇과 이어져 있는지를 나타냅니다.
      </figcaption>

      <CertaintyKey className="mt-4" />
    </figure>
  );
}

/**
 * One drawn panel with its name written above it. The name is HTML, so it sits
 * at the page's own type size on every screen instead of scaling with the
 * drawing — and it is what makes the drawing safe to hide from a screen reader.
 */
function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="hairline rounded-xl bg-ink-raised p-5 md:p-6">
      <span className="label-kr block text-micro text-said-faint">{label}</span>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function FilesPanel() {
  return (
    <svg
      viewBox="0 0 240 168"
      aria-hidden="true"
      focusable="false"
      className="h-auto w-full text-said-faint"
    >
      {FILES.map((file, index) => (
        <g key={file.path} transform={`translate(0 ${ROW_TOP + index * ROW_PITCH})`}>
          {/* The district swatch, before the file rather than after it: the eye
              picks up three colours down the left edge and has already grouped
              the list before it reads a single path. */}
          <rect x="0" y="3" width="3" height="12" rx="1.5" fill={file.district} />
          <g
            transform="translate(12 1)"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinejoin="round"
          >
            <path d={SHEET} />
            <path d={SHEET_FOLD} />
          </g>
          {/* Mono for a Latin path, where mono is the right family and the only
              place on this page it is allowed (D73). */}
          <text
            x="32"
            y="13"
            fontSize="10.5"
            className="font-mono"
            fill="var(--color-said-soft)"
          >
            {file.path}
          </text>
        </g>
      ))}
      {/* "and more", without a number. An invented count on a page arguing that
          we do not invent things is not worth the extra realism. */}
      <g fill="var(--color-said-faint)">
        <circle cx="34" cy="147" r="1.6" />
        <circle cx="42" cy="147" r="1.6" />
        <circle cx="50" cy="147" r="1.6" />
      </g>
    </svg>
  );
}

function MapPanel() {
  return (
    <svg viewBox="0 0 260 168" aria-hidden="true" focusable="false" className="h-auto w-full">
      {/* Roads first, so a plate always sits on top of the line entering it and
          the joins never need to be trimmed. */}
      <line x1="70" y1="66" x2="106" y2="96" stroke="var(--color-wire)" strokeWidth="1.6" />
      <line x1="170" y1="62" x2="170" y2="96" stroke="var(--color-wire)" strokeWidth="1.6" />
      {/*
        The guessed road, drawn as the product draws it: a band with a texture,
        not a dashed hairline. At the size a whole project is looked at, a 1px
        dash and a 1px solid stroke are the same stroke, so the one distinction
        this product's honesty rests on would quietly stop existing (D59). A
        5-wide stroke with a 1.5/3 dash pattern IS a hatch — each dash is a tick
        across the band — and it survives being made smaller.
      */}
      <line
        x1="124"
        y1="38"
        x2="150"
        y2="38"
        stroke="var(--color-guess)"
        strokeWidth="5"
        strokeDasharray="1.5 3"
        strokeLinecap="butt"
      />

      <District x={14} y={10} width={110} height={56} colour={PAYMENTS} name="결제" dots={3} />
      <District x={150} y={14} width={96} height={48} colour={LOGIN} name="로그인" dots={1} />
      <District x={54} y={96} width={124} height={56} colour={CART} name="장바구니" dots={2} />
    </svg>
  );
}

/**
 * A named place with the files that live in it drawn inside as dots. The dot
 * count is the number of rows on the left carrying this colour, which is the
 * one thing that makes the two panels a single sentence: nothing appears on the
 * right that did not come from the left.
 */
function District({
  x,
  y,
  width,
  height,
  colour,
  name,
  dots,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  colour: string;
  name: string;
  dots: number;
}) {
  const centre = x + width / 2;
  return (
    <g>
      {/* 0.13 fill under a 0.45 stroke, the same weighting the hero's still
          picture uses, so the two drawings on this page read as one map. A
          flat fill at full strength turns a district into a button. */}
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx="10"
        fill={colour}
        fillOpacity="0.13"
        stroke={colour}
        strokeOpacity="0.45"
        strokeWidth="1"
      />
      <text
        x={centre}
        y={y + height / 2 - 2}
        textAnchor="middle"
        fontSize="13"
        fontWeight="600"
        fill="var(--color-said)"
      >
        {name}
      </text>
      {Array.from({ length: dots }, (_, index) => (
        <circle
          key={index}
          cx={centre + (index - (dots - 1) / 2) * 16}
          cy={y + height - 16}
          r="2.6"
          fill={colour}
        />
      ))}
    </g>
  );
}

/**
 * What the two kinds of road mean, in the page's own voice.
 *
 * This is the only place on the landing page where the certainty encoding is
 * shown rather than asserted, and it is worth its four lines: the 우리가 하지
 * 않는 것 band claims we never mix what we checked with what we guessed, and a
 * reader can now see what that looks like before they believe it.
 *
 * 합니다체, because this is the product speaking (D74) — the workspace's own
 * legend says 확실해요 / 짐작이에요, and that register belongs to the app.
 */
function CertaintyKey({ className = "" }: { className?: string }) {
  return (
    <p className={`flex flex-wrap items-center gap-x-5 gap-y-2 text-micro text-said-faint ${className}`}>
      <span className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-[3px] w-5 rounded-[1px]"
          style={{ backgroundColor: "var(--color-wire)" }}
        />
        코드에서 확인한 연결
      </span>
      <span className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-[5px] w-5 rounded-[1px]"
          style={{
            // 45 degrees at a 3px pitch, identical to the workspace's own mark,
            // so the texture a visitor learns here is the texture they meet in
            // their map.
            backgroundImage:
              "repeating-linear-gradient(45deg, var(--color-guess) 0 1.5px, transparent 1.5px 3px)",
          }}
        />
        정황으로 짐작한 연결
      </span>
    </p>
  );
}
