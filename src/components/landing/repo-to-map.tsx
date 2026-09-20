import {
  RELATION_WORDS,
  type Certainty,
  type ConnectionRelation,
} from "@/lib/graph/view";

/**
 * The product in one picture: a list of files on the left, the same project as
 * a map on the right.
 *
 * This claim is the page's whole thesis and it was carried entirely by a
 * paragraph — which is the one medium it cannot be carried in. The reader we
 * are addressing cannot read code, and asking them to read three lines of prose
 * about what reading code produces is asking them to take it on faith. The
 * picture is checkable in two seconds: six files go in, three named places come
 * out, and you can read a sentence off the arrow between two of them.
 *
 * **The right panel is the workspace's own map, small.** It used to be three
 * rounded plates joined by plain lines, which is a second visual language for
 * an object the product already draws: `render/paint.ts` draws a place as a
 * circle with a soft fill and a rim, the things inside it as filled dots each
 * with a ring in the sheet's own colour, and a connection as a line with a
 * filled arrowhead and the relation's own words lying on it at the midpoint,
 * in a gap cut exactly as wide as the words. All of that is borrowed here,
 * including the two alphas (fill 0.15, rim 0.42) — a visitor who signs up
 * should meet the picture they were shown, not a cousin of it.
 *
 * **Where the words live.** Everywhere else on this page the rule is that HTML
 * holds every word and the SVG holds only the marks, because Korean inside a
 * `viewBox` scales with the box and a caption inside a drawing cannot be
 * selected, translated or found. Two kinds of word break that rule here, and
 * both break it for the same reason: they are measured against the drawing's
 * own units. A circle is sized to the name it holds, and the gap cut in a line
 * is sized to the words that sit in it. An HTML box is in CSS pixels and stays
 * put while this drawing scales — 287px wide at a 375px viewport, 465px at
 * 1440 — so a label that fitted its line on a phone would cover half of it on
 * a desktop, and a circle sized to its text on a phone would swim around it on
 * a desktop. Set in the viewBox, both stay true at every width. The small end
 * is the one to check, and it is the comfortable one: below `md` the panels
 * stack, so this drawing gets 287 of a phone's 375 and an 11-unit label lands
 * at about 12 CSS px, against a page whose smallest type is 13. Everything the
 * drawing says is in the figcaption as well, in prose, built from the same
 * table the arrows are drawn from.
 *
 * **The colours are the point of the left panel.** Each file row carries the
 * swatch of the place it ends up in, and the dots inside each circle on the
 * right ARE the rows that fed it — counted from `FILES`, not typed in twice.
 * Six in, six out, and a seventh file added to the list puts a seventh dot on
 * the map. That correspondence is what makes this a transformation rather than
 * two unrelated illustrations side by side, and it is the reason the file paths
 * are the demo repo's real ones (D5) rather than invented names.
 *
 * **Both panels are drawn on the same shape.** 10:7 each, so at equal column
 * widths they come out the same height and the two boxes are level top and
 * bottom with nothing padded out to make it so. See `FILES_BOX` / `MAP_BOX`.
 *
 * **No lamp amber anywhere.** The accent means "you act here"; a decoration
 * that borrows it puts every button on the page into competition with a
 * picture. The place hues are the map's own six (`--color-c1`…), which is
 * also what the visitor will see when their own map opens.
 *
 * Server component, no motion of its own. The hero already drifts and every
 * section already enters on `.rise`; a second thing that moves would make the
 * page restless, and the entrance this needs is the one the page already has —
 * pass `rise` in `className`.
 */

/** The map's three places, in the order they are drawn. */
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

/*
 * The two drawing boxes, and the one number they share.
 *
 * 240:168 and 260:182 are both exactly 10:7. Since the grid gives the two
 * panels equal widths, equal shapes make equal heights — which is the whole of
 * the alignment: the boxes end level at the bottom as well as the top, and
 * neither one is stretched over empty space to get there. Change one of these
 * and you have to change the other.
 */
const FILES_BOX = { width: 240, height: 168 };
const MAP_BOX = { width: 260, height: 182 };

/* A sheet with a folded corner, 12 × 14, drawn at the origin so a row can just
   translate it. Stroked rather than filled: a filled glyph at this size on a
   near-black ground reads as a solid block. */
const SHEET = "M1.5 0.75h6l3.75 3.75v8.75h-9.75Z";
const SHEET_FOLD = "M7.5 0.75v3.75h3.75";

/** Row pitch inside the files panel, and the y of the first row. */
const ROW_PITCH = 22;
const ROW_TOP = 4;

/**
 * One named place on the map: a filled circle with its name written inside.
 *
 * The centres are hand-placed rather than solved for, because three circles and
 * two arrows is a composition, not a layout problem — and a fixed picture that
 * is checked once is worth more here than a solver nobody can predict. What is
 * NOT hand-placed is the radius (it comes from the name) or the dots (they come
 * from `FILES`).
 */
type Place = { name: string; colour: string; x: number; y: number };

const PLACES: readonly Place[] = [
  { name: "결제", colour: PAYMENTS, x: 36, y: 74 },
  { name: "로그인", colour: LOGIN, x: 214, y: 34 },
  { name: "장바구니", colour: CART, x: 168, y: 146 },
];

/**
 * What the map says about those places, in the product's own vocabulary.
 *
 * `relation` and `certainty` are the workspace's types, and the words on each
 * arrow come from `RELATION_WORDS[...].short` rather than being typed out here:
 * the landing page is not allowed a private set of verbs for the thing the app
 * names in one table. `short` is the form meant to be read ALONG an arrow, so
 * each row is a sentence in the order it is drawn — from, word, to.
 *
 * One certain and one inferred, because the certainty encoding below the figure
 * is the first place on this site where that distinction is shown rather than
 * asserted, and a legend for a mark the picture does not contain teaches
 * nothing.
 */
const ROADS: readonly {
  from: string;
  to: string;
  relation: ConnectionRelation;
  certainty: Certainty;
}[] = [
  { from: "결제", to: "장바구니", relation: "calls", certainty: "certain" },
  { from: "결제", to: "로그인", relation: "fetches", certainty: "inferred" },
];

/**
 * Type sizes inside the map drawing, in the drawing's own units.
 *
 * A Hangul syllable sets one per em, and -0.02em of tracking (the same the
 * renderer sets on a canvas) takes the advance to about 0.98 — which is what
 * lets a circle be sized to its name and a gap be cut to the width of the words
 * without measuring anything at runtime.
 */
const NAME_SIZE = 11.5;
const LABEL_SIZE = 11;
const HANGUL_ADVANCE = 0.98;

/** Ink left between a name and the rim of the circle holding it. */
const NAME_PAD = 8.5;

/** How far outside a circle's rim a line starts or an arrowhead lands. */
const RIM_GAP = 3.2;

/** Bare line left either side of an arrow's words, so the text is not struck through. */
const LABEL_CLEARANCE = 6;

/** The arrowhead, in the same proportion the renderer uses. */
const ARROW_LENGTH = 7.5;
const ARROW_HALF_WIDTH = 3.2;

/** One file, drawn inside the place it belongs to. */
const DOT_R = 2.4;
const DOT_PITCH = 8.5;

/** Shorter markup, and coordinates a person can read in view-source. */
const round = (value: number) => Math.round(value * 100) / 100;

const widthOf = (text: string, size: number) => text.length * size * HANGUL_ADVANCE;

const radiusOf = (name: string) => widthOf(name, NAME_SIZE) / 2 + NAME_PAD;

export function RepoToMap({ className = "" }: { className?: string }) {
  return (
    <figure className={className}>
      {/*
        `items-stretch`, not `items-center`: the two panels are boxes with a
        visible edge, and two boxes centred against each other are level on
        neither edge. Stretching is only a guarantee here — the drawings are the
        same shape, so the panels already come out the same height and nothing
        is padded to fill a gap.

        `minmax(0, 1fr)` rather than `1fr`. A bare `1fr` track is
        `minmax(auto, 1fr)`, and an SVG's `auto` minimum is its intrinsic size,
        so the track refuses to go below it and the grid pushes past its parent.
        That is the same family of bug as D72's twelve-column gutters, and this
        page has had a horizontal scrollbar twice already.
      */}
      <div className="grid items-stretch gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-8">
        <Panel label="파일 목록">
          <FilesPanel />
        </Panel>

        {/* Two arrows, one per axis, because the panels stack on a phone and a
            right-pointing arrow between two stacked boxes points at nothing.
            `self-center` because the row is now as tall as the panels and an
            arrow that stretched with them would sit at their top edge. Both
            decorative — the caption says "읽어서 … 그립니다", which is the
            arrow's whole content. */}
        <svg
          viewBox="0 0 24 30"
          aria-hidden="true"
          focusable="false"
          className="mx-auto h-[30px] w-6 self-center text-said-faint md:hidden"
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
          className="hidden h-6 w-[30px] self-center text-said-faint md:block"
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
        and what each arrow says — spelled out from `ROADS` itself, so the
        sentence a screen reader gets and the sentence lying on the line cannot
        drift apart. If the SVG never loaded, this paragraph would still make
        the page's argument.
      */}
      <figcaption className="mt-7 max-w-[62ch] text-copy text-said-soft">
        왼쪽은 프로젝트에 들어 있는 파일이고, 오른쪽은 같은 프로젝트를 한 번
        읽어서 그린 지도입니다. 파일은 결제·로그인·장바구니처럼 사람이 쓰는 말로
        묶이고, 사이의 화살표는 무엇이 무엇과 이어져 있는지를 나타냅니다 —{" "}
        {ROADS.map(
          (road) => `${road.from} → ${RELATION_WORDS[road.relation].short} → ${road.to}`,
        ).join(", ")}
        .
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
      viewBox={`0 0 ${FILES_BOX.width} ${FILES_BOX.height}`}
      aria-hidden="true"
      focusable="false"
      className="h-auto w-full text-said-faint"
    >
      {FILES.map((file, index) => (
        <g key={file.path} transform={`translate(0 ${ROW_TOP + index * ROW_PITCH})`}>
          {/* The place swatch, before the file rather than after it: the eye
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

/** A place with its radius and its files resolved. */
type Drawn = Place & { r: number; files: number };

/** The line between two places, cut back to their rims — `geometry.ts`'s span. */
type Span = {
  x0: number;
  y0: number;
  ux: number;
  uy: number;
  length: number;
};

function spanOf(from: Drawn, to: Drawn): Span {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const ux = dx / distance;
  const uy = dy / distance;
  const startTrim = from.r + RIM_GAP;
  return {
    x0: from.x + ux * startTrim,
    y0: from.y + uy * startTrim,
    ux,
    uy,
    // A line stops at each rim, because one that ran under a circle and out the
    // other side would read as crossing the place rather than arriving at it,
    // and an arrowhead buried under the thing it points at says nothing.
    length: distance - startTrim - (to.r + RIM_GAP),
  };
}

const pointAt = (span: Span, t: number): [number, number] => [
  round(span.x0 + span.ux * t),
  round(span.y0 + span.uy * t),
];

function MapPanel() {
  const drawn: Drawn[] = PLACES.map((place) => ({
    ...place,
    r: radiusOf(place.name),
    // Counted, never typed: the number of dots in a circle IS the number of
    // rows on the left wearing its colour, and a file added to the list above
    // has to show up here.
    files: FILES.filter((file) => file.district === place.colour).length,
  }));
  const byName = new Map(drawn.map((place) => [place.name, place]));

  return (
    <svg
      viewBox={`0 0 ${MAP_BOX.width} ${MAP_BOX.height}`}
      aria-hidden="true"
      focusable="false"
      className="h-auto w-full text-said-soft"
    >
      {/* Arrows first, so a place always sits on top of the line entering it
          and no join ever needs trimming. */}
      {ROADS.map((road) => {
        const from = byName.get(road.from);
        const to = byName.get(road.to);
        if (!from || !to) return null;
        return (
          <Road
            key={`${road.from}-${road.to}`}
            span={spanOf(from, to)}
            words={RELATION_WORDS[road.relation].short}
            certainty={road.certainty}
          />
        );
      })}

      {drawn.map((place) => (
        <PlaceMark key={place.name} place={place} />
      ))}
    </svg>
  );
}

/**
 * One connection, drawn the way the workspace draws one: a line with a filled
 * arrowhead at the far end and the relation's own words lying along it at the
 * midpoint, in a gap cut in the line exactly as wide as the words.
 *
 * The words sit ON the line rather than on a plate behind them, because a plate
 * would be a dark box parked on a tinted circle — visible as a box. Cutting the
 * line costs one extra segment and looks like the line was drawn around the
 * words.
 *
 * The guessed line is a band with a texture, not a dashed hairline. At the size
 * a whole project is looked at, a 1px dash and a 1px solid stroke are the same
 * stroke, so the one distinction this product's honesty rests on would quietly
 * stop existing (D59). A 5-wide stroke with a 1.5/3 dash pattern IS a hatch —
 * each dash is a tick across the band — and it survives being made smaller.
 */
function Road({
  span,
  words,
  certainty,
}: {
  span: Span;
  words: string;
  certainty: Certainty;
}) {
  const hole = widthOf(words, LABEL_SIZE) / 2 + LABEL_CLEARANCE;
  const middle = span.length / 2;
  const [ax, ay] = pointAt(span, 0);
  const [bx, by] = pointAt(span, Math.max(0, middle - hole));
  const [cx, cy] = pointAt(span, Math.min(span.length, middle + hole));
  const [ex, ey] = pointAt(span, span.length);

  const colour = certainty === "certain" ? "var(--color-wire)" : "var(--color-guess)";
  const backX = ex - span.ux * ARROW_LENGTH;
  const backY = ey - span.uy * ARROW_LENGTH;
  const px = -span.uy * ARROW_HALF_WIDTH;
  const py = span.ux * ARROW_HALF_WIDTH;

  // The words are turned to lie along the line, and flipped a half turn when
  // the line runs right to left — text following a leftward arrow is upside
  // down and simply cannot be read. Flipping the words never flips the head, so
  // the sentence still reads in the direction the arrow points.
  const radians = Math.atan2(span.uy, span.ux);
  const quarter = Math.PI / 2;
  const upright =
    radians > quarter
      ? radians - Math.PI
      : radians < -quarter
        ? radians + Math.PI
        : radians;

  return (
    <g>
      {certainty === "certain" ? (
        <g stroke={colour} strokeWidth="1.6" strokeLinecap="round">
          <line x1={ax} y1={ay} x2={bx} y2={by} />
          <line x1={cx} y1={cy} x2={ex} y2={ey} />
        </g>
      ) : (
        <>
          <g
            stroke={colour}
            strokeWidth="5"
            strokeDasharray="1.5 3"
            strokeLinecap="butt"
          >
            <line x1={ax} y1={ay} x2={bx} y2={by} />
            <line x1={cx} y1={cy} x2={ex} y2={ey} />
          </g>
          {/* A faint spine holds the ticks together as one line rather than a
              fence. */}
          <g stroke={colour} strokeWidth="0.6" strokeOpacity="0.55">
            <line x1={ax} y1={ay} x2={bx} y2={by} />
            <line x1={cx} y1={cy} x2={ex} y2={ey} />
          </g>
        </>
      )}

      {/* Filled, not a stroked chevron: direction IS the meaning of a
          connection — "결제 uses 장바구니" and the reverse are different facts
          about someone's code — and two thin strokes vanish before a solid
          triangle does. */}
      <polygon
        points={`${ex},${ey} ${round(backX + px)},${round(backY + py)} ${round(backX - px)},${round(backY - py)}`}
        fill={colour}
      />

      <text
        transform={`translate(${round(span.x0 + span.ux * middle)} ${round(span.y0 + span.uy * middle)}) rotate(${round((upright * 180) / Math.PI)})`}
        textAnchor="middle"
        // Baseline rather than `dominant-baseline`: a Hangul block sits roughly
        // 0.35em above the baseline at its optical centre, and an explicit
        // number renders identically in every engine.
        y={round(LABEL_SIZE * 0.35)}
        fontSize={LABEL_SIZE}
        fontWeight="500"
        letterSpacing="-0.02em"
        fill="currentColor"
      >
        {words}
      </text>
    </g>
  );
}

/**
 * A named place: a filled circle with its name inside, sized to that name, and
 * the files that live in it drawn inside as dots.
 *
 * The ring outside the rim is in the panel's own surface colour, which is how
 * the renderer separates a thing from whatever it is sitting on — here it is
 * what keeps an arrow passing behind a circle from touching it.
 *
 * The dot count is the number of rows on the left carrying this colour, which
 * is the one thing that makes the two panels a single sentence: nothing appears
 * on the right that did not come from the left.
 */
function PlaceMark({ place }: { place: Drawn }) {
  const { x, y, r, colour, name, files } = place;
  return (
    <g>
      <circle
        cx={x}
        cy={y}
        r={round(r + 1.7)}
        fill="none"
        stroke="var(--color-ink-raised)"
        strokeWidth="2.6"
      />
      {/* 0.15 under a 0.42 rim, the alphas the renderer fills a place with, so
          the picture on this page and the one in the product are the same
          picture. A flat fill at full strength turns a place into a button. */}
      <circle
        cx={x}
        cy={y}
        r={round(r)}
        fill={colour}
        fillOpacity="0.15"
        stroke={colour}
        strokeOpacity="0.42"
        strokeWidth="1.2"
      />
      <text
        x={x}
        y={round(y - r * 0.06)}
        textAnchor="middle"
        fontSize={NAME_SIZE}
        fontWeight="600"
        letterSpacing="-0.02em"
        fill="var(--color-said)"
      >
        {name}
      </text>
      {Array.from({ length: files }, (_, index) => (
        <circle
          key={index}
          cx={round(x + (index - (files - 1) / 2) * DOT_PITCH)}
          cy={round(y + r * 0.42)}
          r={DOT_R}
          fill={colour}
        />
      ))}
    </g>
  );
}

/**
 * What the two kinds of line mean, in the page's own voice.
 *
 * This is the only place on the landing page where the certainty encoding is
 * shown rather than asserted, and it is worth its four lines: the 우리가 하지
 * 않는 것 band claims we never mix what we checked with what we guessed, and a
 * reader can now see what that looks like before they believe it. The two marks
 * are the two the figure above actually draws, at the weights it draws them.
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
