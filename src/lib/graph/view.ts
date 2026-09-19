/**
 * The graph, as the workspace sees it.
 *
 * Deliberately not the database rows. Three reasons, and each one is a rule the
 * UI would otherwise have to remember:
 *
 *   1. The forbidden vocabulary (section 1) stops here. Past this boundary
 *      nothing is called a node or an edge — a thing is an `item`, a link is a
 *      `connection`, and the words the user reads are on the item itself.
 *   2. `certain` and `inferred` travel WITH each connection rather than being
 *      looked up, because the renderer draws them differently and a lookup is a
 *      chance to forget.
 *   3. The client never receives a file path it did not ask for. Section 3
 *      promises we do not keep source; the map holds paths and line ranges, and
 *      sending them is fine — sending content would not be.
 */

export type ItemKind =
  | "file"
  | "symbol"
  | "route"
  | "api_endpoint"
  | "package"
  | "feature";

/** How sure we are. Two values, never three (section 3). */
export type Certainty = "certain" | "inferred";

export type GraphItem = {
  id: string;
  kind: ItemKind;
  /** Component/function kind for a symbol: component, function, hook, class, type, style_rule. */
  shape: string | null;
  /** The name in the code. Always present. */
  name: string;
  /** Plain-language name, once Pass 2 has run. Null before that. */
  label: string | null;
  /** One plain sentence, once Pass 2 has run. */
  summary: string | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  /** True when a person, not the machine, put this here. */
  fromUser: boolean;
  /** Count of connections in each direction, for sizing and for "used in N places". */
  usedBy: number;
  uses: number;
};

/**
 * One link between two items.
 *
 * `relation` is the user-facing verb, resolved here rather than in the
 * renderer: "uses", "is used by", "sends data to", "saves to" are the words the
 * brief allows, and mapping an edge type to one of them is a decision, not a
 * formatting detail.
 */
export type GraphConnection = {
  id: string;
  from: string;
  to: string;
  relation: ConnectionRelation;
  certainty: Certainty;
};

export type ConnectionRelation =
  | "contains"
  | "imports"
  | "calls"
  | "renders"
  | "fetches"
  | "uses_package"
  | "belongs_to";

/** What the map renders. */
export type GraphView = {
  projectId: string;
  items: GraphItem[];
  connections: GraphConnection[];
  /** Null until a run has completed. */
  lastRun: {
    id: string;
    status: "pending" | "running" | "completed" | "failed";
    finishedAt: string | null;
    filesParsed: number;
    filesSkipped: string[];
    error: string | null;
  } | null;
};

/**
 * The Korean a person reads for each kind of connection.
 *
 * Kept next to the type so a new relation cannot be added without someone
 * having to write its sentence — which is the point. The brief's rule is that
 * connections are described as "uses", "is used by", "sends data to", "saves
 * to", never as edge types.
 *
 * ## Three forms, and why `short` is not just `forward` cut down
 *
 * `forward` and `backward` are read **standing on one item and looking at the
 * other**, which is what the connections panel does: it prints the far item's
 * name and then the verb, so "Button.tsx 불러와요" is the selected file
 * speaking. `short` is read **along the arrow**, which is what the map does:
 * the words sit on the line between the two things with an arrowhead at the
 * `to` end, so the sentence is "`from` → short → `to`" and the subject is
 * always `from`.
 *
 * That difference is not cosmetic, and `contains` is where it bites. Its
 * `forward` sentence, 안에 있어요, is spoken by the thing that is inside; put the
 * same words on an arrow pointing file → 조각 and the map would be saying the
 * file is inside the piece it holds — backwards, on the one encoding
 * (direction) the whole picture is built from. So `contains` gets 가지고 있어요
 * instead, which is the same fact said by the other end.
 *
 * The rest are the same verb as `forward` with the scene-setting dropped
 * (화면에 그려요 → 그려요), because a line can carry about five 글자 before the map
 * stops being a map. They must never say something `forward` does not: two
 * words for one fact is the failure D69 and the grouping table both exist to
 * avoid.
 */
export const RELATION_WORDS: Record<
  ConnectionRelation,
  {
    forward: string;
    backward: string;
    /** Short enough to sit on a line, read from `from` to `to`. */
    short: string;
  }
> = {
  contains: { forward: "안에 있어요", backward: "이 안에 있어요", short: "가지고 있어요" },
  imports: { forward: "불러와요", backward: "여기서 불러가요", short: "불러와요" },
  calls: { forward: "사용해요", backward: "여기서 쓰여요", short: "사용해요" },
  renders: { forward: "화면에 그려요", backward: "여기에 그려져요", short: "그려요" },
  fetches: {
    forward: "데이터를 받아와요",
    backward: "여기로 데이터를 보내요",
    short: "받아와요",
  },
  // 가져다 써요 rather than 써요, so it echoes the 밖에서 가져온 것 that names the
  // package territory on the map: one idea, said the same way in both places.
  uses_package: { forward: "이 도구를 써요", backward: "이 도구를 쓰는 곳", short: "가져다 써요" },
  belongs_to: { forward: "이 기능에 속해요", backward: "여기에 속한 것", short: "속해요" },
};

/**
 * What the user reads instead of `certain` / `inferred`.
 *
 * Never "safe". The brief is explicit: the UI may say there are no known
 * connections, and may not say that changing something is safe.
 */
export const CERTAINTY_WORDS: Record<Certainty, string> = {
  certain: "확실해요",
  inferred: "짐작이에요",
};

export const KIND_WORDS: Record<ItemKind, string> = {
  file: "파일",
  symbol: "조각",
  route: "페이지",
  api_endpoint: "서버 주소",
  package: "외부 도구",
  feature: "기능",
};
