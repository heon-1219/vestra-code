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
  /**
   * The line the call, render or fetch is written on, in the FROM end's file.
   *
   * Absent rather than null when we do not have one, so there is exactly one
   * way to say "no line" — `imports`, `contains`, `uses_package` and
   * `belongs_to` never carry one, and neither does an edge written before
   * `analyzer.ts` started recording it.
   *
   * Optional because this arrived after three other modules were already
   * constructing this type. Additive only: nothing that builds a connection
   * today has to change, and nothing that reads one may assume it is there.
   *
   * It is worth carrying. "PayButton.tsx 34줄에서" is the difference between a
   * sentence a person can go and check and one they have to believe, and the
   * number was already sitting in `edges.metadata` — measured by the parser,
   * stored by `persist.ts`, and dropped on the floor by `load.ts` until now.
   */
  line?: number;
  /**
   * One sentence for what this connection is *for*, in plain Korean.
   *
   * Shared by every connection that reaches the same thing by the same
   * relation, which is the whole design: twelve components calling
   * `formatPrice` are one fact, and a map that words one fact twelve ways is
   * a map nobody believes. `smoothstep` and `circleTouchesBox` both read
   * 범위 안에 가두기 because they are both doing that.
   *
   * Written by Pass 3 and therefore always `inferred` — it is a model's
   * reading of the code, never the compiler's. The relation verb stays as the
   * fallback and is never wrong, so a connection without one loses nothing it
   * had before.
   *
   * Absent, not empty, when Pass 3 has not answered — same rule as `line`.
   */
  purpose?: string;
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
 * Which connection tells you the most, when something has to choose.
 *
 * ONE ranking, for the whole product. `fetches` crosses the gap between the
 * screens and the server and is the connection a non-developer asks about by
 * name; `contains` is last because every picture has already said it.
 *
 * It lives here rather than in a renderer because it is now read by two
 * unrelated things — the map, which decides which lines get their words first,
 * and `flow.ts`, which decides which way a walk turns. Two rankings for one
 * idea is the D69 failure: `usedBy` was counted one way in `load.ts` and
 * another way in the panel, and the product told a user `kv` was used in 7
 * places when the parser had measured 6.
 *
 * `map/render/scene.ts` still declares a private copy of this table with the
 * same numbers. `flow.test.ts` pins the two together by measuring the order
 * `buildLinks` actually sorts into; that copy should be deleted in favour of
 * this export by whoever next touches that file.
 */
export const RELATION_RANK: Record<ConnectionRelation, number> = {
  fetches: 0,
  renders: 1,
  belongs_to: 2,
  calls: 3,
  imports: 4,
  uses_package: 5,
  contains: 6,
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
