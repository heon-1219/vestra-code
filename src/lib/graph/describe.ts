import {
  KIND_WORDS,
  type ConnectionRelation,
  type GraphConnection,
  type GraphItem,
} from "./view";

/**
 * One line saying what a thing is for.
 *
 * The map's tooltip said "파일 · 5개와 이어져 있어요", which is a measurement
 * rather than an answer. Someone who cannot read code is looking at a name they
 * did not choose — `use-analysis-stream.ts` — and the question in their head is
 * "what is this", not "how many edges does it have".
 *
 * **When Pass 2 has written a summary, that summary is the line.** This is the
 * fallback, and it is a real one rather than a placeholder: it is built from
 * what the parser measured, so it is true before any model has run, true when
 * there is no key, and true when Pass 2 failed. The product should read as
 * finished without an LLM and better with one, not broken without one.
 *
 * Everything here is `certain` by construction — it describes what a file
 * contains and how often it is used, both of which were counted rather than
 * guessed. That is why the sentences never hedge: there is nothing to hedge
 * about. A model's summary is a different matter and is marked where it is
 * shown.
 */

/** What one item's line says, and who wrote it. */
export type Description = {
  line: string;
  /** True when this is Pass 2's sentence rather than our arithmetic. */
  fromModel: boolean;
};

/** The relations that mean "something reaches for this". Mirrors `load.ts`. */
const USES: ReadonlySet<ConnectionRelation> = new Set<ConnectionRelation>([
  "calls",
  "renders",
  "fetches",
  "imports",
  "uses_package",
]);

/**
 * The word for a piece, from the shape the parser recorded.
 *
 * Deliberately not guessed from a file extension: a `.js` file can be anything,
 * and sorting one into "꾸미기" because of its name is a guess presented as a
 * fact. A piece with no recorded shape is just 조각.
 */
const SHAPE_WORDS: Record<string, string> = {
  component: "화면 조각",
  hook: "화면 도우미",
  function: "일 처리",
  class: "설계도",
  constant: "정해 둔 값",
  type: "정해 둔 모양",
  style: "꾸미기",
};

/**
 * Which kind leads the sentence when counts tie.
 *
 * Alphabetical was the first answer and it is meaningless to a reader: a file
 * holding one component and one function would lead with 일 처리 because ㅇ
 * sorts before ㅎ. A file is best described by the most visible thing in it —
 * what appears on a screen, then what answers an address, then the machinery.
 */
const LEAD_ORDER = [
  "화면 조각",
  "페이지",
  "서버 주소",
  "화면 도우미",
  "일 처리",
  "설계도",
  "정해 둔 모양",
  "정해 둔 값",
  "꾸미기",
  "조각",
];

/**
 * Every item's line, in one pass over the graph.
 *
 * One pass rather than a function called per row, for the same reason
 * `buildGraphView` counts both ends of an edge while it is already looking at
 * it: a 300-file project is thousands of connections, and `connections.filter`
 * inside a render is that number multiplied by every row on screen.
 */
export function describeAll(graph: {
  items: readonly GraphItem[];
  connections: readonly GraphConnection[];
}): Map<string, Description> {
  const itemsById = new Map(graph.items.map((item) => [item.id, item]));

  /** What each file holds, by the word we would use for it. */
  const holds = new Map<string, Map<string, number>>();
  /** Which files reach for this one, so a leaf can say nobody does. */
  const reachedBy = new Map<string, number>();

  for (const connection of graph.connections) {
    if (connection.relation === "contains") {
      const child = itemsById.get(connection.to);
      if (!child) continue;
      const word = wordForChild(child);
      if (!word) continue;
      const counts = holds.get(connection.from) ?? new Map<string, number>();
      counts.set(word, (counts.get(word) ?? 0) + 1);
      holds.set(connection.from, counts);
      continue;
    }
    if (USES.has(connection.relation)) {
      reachedBy.set(connection.to, (reachedBy.get(connection.to) ?? 0) + 1);
    }
  }

  const described = new Map<string, Description>();
  for (const item of graph.items) {
    described.set(item.id, describeOne(item, holds.get(item.id), reachedBy.get(item.id) ?? 0));
  }
  return described;
}

/** The word a parent would use for this child when listing what it holds. */
function wordForChild(child: GraphItem): string | null {
  if (child.kind === "symbol") return SHAPE_WORDS[child.shape ?? ""] ?? "조각";
  if (child.kind === "route") return "페이지";
  if (child.kind === "api_endpoint") return "서버 주소";
  return null;
}

function describeOne(
  item: GraphItem,
  holds: Map<string, number> | undefined,
  usedBy: number,
): Description {
  // Pass 2's sentence wins wherever it exists. It read the code; this did not.
  if (item.summary && item.summary.trim().length > 0) {
    return { line: item.summary.trim(), fromModel: true };
  }

  const parts: string[] = [];

  const what = whatItIs(item, holds);
  if (what) parts.push(what);

  const use = howItIsUsed(item, usedBy);
  if (use) parts.push(use);

  // Nothing measurable to say. Better the kind alone than an empty tooltip
  // that looks like a failure to load.
  if (parts.length === 0) return { line: KIND_WORDS[item.kind], fromModel: false };
  return { line: parts.join(", "), fromModel: false };
}

function whatItIs(item: GraphItem, holds: Map<string, number> | undefined): string | null {
  switch (item.kind) {
    case "route":
      return `${item.name} 주소로 열리는 페이지예요`;
    case "api_endpoint":
      return `${item.name} 주소에 답하는 곳이에요`;
    case "package":
      return "밖에서 가져온 도구예요";
    case "feature":
      return "기능 하나로 묶어 둔 것이에요";
    case "symbol": {
      const shape = SHAPE_WORDS[item.shape ?? ""];
      return shape ? `${shape}예요` : "코드 조각이에요";
    }
    case "file": {
      if (!holds || holds.size === 0) {
        // An asset is a file we recorded and never read, which is exactly why
        // "nothing uses this photo" is answerable at all.
        return item.path && isAssetPath(item.path) ? "그림이나 파일이에요" : "안을 읽지 않은 파일이에요";
      }
      /*
       * "화면 조각 2개와 일 처리 3개가 들어 있어요".
       *
       * Sorted by count and capped at two kinds: a file holding six sorts of
       * thing produces a sentence nobody finishes reading, and the two biggest
       * are what it is actually for.
       */
      const top = [...holds.entries()]
        .sort(
          (a, b) =>
            b[1] - a[1] ||
            (LEAD_ORDER.indexOf(a[0]) + 1 || LEAD_ORDER.length + 1) -
              (LEAD_ORDER.indexOf(b[0]) + 1 || LEAD_ORDER.length + 1),
        )
        .slice(0, 2)
        .map(([word, count]) => `${word} ${count}개`);
      return `${top.join("와 ")}가 들어 있어요`;
    }
    default:
      return null;
  }
}

function howItIsUsed(item: GraphItem, usedBy: number): string | null {
  // A feature is a grouping we made; "쓰인다"는 말이 맞지 않아요.
  if (item.kind === "feature") return null;

  if (usedBy === 0) {
    /*
     * Never "안 쓰여요".
     *
     * Section 3 lets us say we found no connection. It does not let us turn
     * that into a verdict on the user's code — an entry point is used by the
     * browser, and a file loaded by a name we never resolved is used by
     * something we did not see.
     */
    return "쓰는 곳을 아직 못 찾았어요";
  }
  return `${usedBy}곳에서 써요`;
}

/** Only the extensions the ingest already treats as assets. */
function isAssetPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf|pdf|zip|xlsx|csv|tsv)$/i.test(
    path,
  );
}

/** The same thing for one item, when a caller has only one. */
export function describeItem(
  item: GraphItem,
  connections: readonly GraphConnection[],
): Description {
  return (
    describeAll({
      items: [item],
      connections: connections.filter(
        (connection) => connection.from === item.id || connection.to === item.id,
      ),
    }).get(item.id) ?? { line: KIND_WORDS[item.kind], fromModel: false }
  );
}
