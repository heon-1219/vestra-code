import { z } from "zod";

import {
  buildBeamIndex,
  runBeam,
  type BeamIndex,
} from "@/components/workspace/map/beam";
import { buildNeighbourhood } from "@/components/workspace/panel/neighbourhood";
import {
  CERTAINTY_WORDS,
  KIND_WORDS,
  RELATION_WORDS,
  type Certainty,
  type ConnectionRelation,
  type GraphConnection,
  type GraphItem,
} from "@/lib/graph/view";
import type { LlmToolSpec } from "@/lib/llm/types";

import { buildCatalog, itemLine, type Catalog } from "./catalog";
import {
  DEFAULT_WINDOW_LINES,
  MAX_WINDOW_LINES,
  normalisePath,
  renderWindow,
  SOURCE_REFUSAL_WORDS,
  windowOf,
  type SourceReader,
  type SourceResult,
} from "./source";
import type { QaToolName } from "./types";

/**
 * The four things the model may do, and the one way it may finish.
 *
 * Chosen so that each answers a different question a person asks when they are
 * looking for a defect they can describe but cannot locate:
 *
 *   - `find_items` — "where is the thing I have a word for?" It is the beam
 *     the map already uses (D59), not a second search: the same 초성 and
 *     wrong-IME handling, so `rufwp` finds 결제 here exactly as it does on
 *     screen. A second implementation would answer the user's own words
 *     differently from the map they are looking at.
 *   - `open_item` — "what is around it?" The panel's own walk, with the same
 *     rules: a walk never turns around, certainty is the weakest link on the
 *     path, and the cap is reported rather than silent.
 *   - `list_files` — "I have no word for it, show me the place." The way a
 *     person narrows when search fails, and the only tool that works when the
 *     user's vocabulary and the code's have nothing in common.
 *   - `read_source` — "show me the actual lines." The only tool that can make a
 *     finding `certain`, and the only one that can cost real tokens, which is
 *     why it is a window and never a file.
 *   - `report` — finishing. A tool rather than prose because the answer has a
 *     shape we validate (D47 puts the validation in our hands regardless of
 *     what the endpoint advertises), and because "give the answer" has to be a
 *     deliberate act the loop can tell apart from thinking out loud.
 *
 * Every result is small, and every result states its own caps. A tool that
 * quietly returns the top ten of forty has told the model there are ten.
 */

export type QaGraph = {
  items: readonly GraphItem[];
  connections: readonly GraphConnection[];
};

/**
 * A place this investigation actually fetched.
 *
 * `read` is the whole distinction the answer rests on: true when `read_source`
 * returned these lines, false when the graph merely told us a thing lives
 * there. A `certain` finding needs the first; `inferred` may stand on the
 * second. Checked in `answer.ts`, never taken on trust.
 */
export type LedgerEntry = {
  path: string;
  startLine: number;
  endLine: number;
  read: boolean;
};

/**
 * A connection this result actually walked.
 *
 * Only `open_item` produces these, because it is the only tool that traverses:
 * it stands on one item and is handed what the graph links it to. A search that
 * happens to return two connected items did not cross the link between them,
 * and reporting it here would turn "these both matched 결제" into "the walk went
 * this way" — which the trail then draws.
 */
export type RevealedHop = {
  connectionId: string;
  from: string;
  to: string;
  relation: ConnectionRelation;
  certainty: Certainty;
};

export type ToolOutcome = {
  /** What goes back to the model. */
  text: string;
  /** One short Korean line for the trace, so a person can watch this happen. */
  note: string;
  /** What this result put on the record, if anything. */
  ledger: LedgerEntry[];
  /**
   * The items this result put the loop in front of, by id, in the order they
   * were shown. Deduplicated later; ordered here, because the order is the
   * walk.
   */
  items: string[];
  /** The links it crossed to get there. Empty for every tool but `open_item`. */
  hops: RevealedHop[];
};

export type ToolContext = {
  graph: QaGraph;
  catalog: Catalog;
  beam: BeamIndex;
  /** By path, and only files. The map is the authority for what may be read. */
  files: Map<string, GraphItem>;
  /**
   * Everything with a line range, by the file it sits in, in graph order.
   *
   * Reading sixty lines of a file puts the loop in front of whatever is written
   * on those lines, and those pieces are what the map draws. Without this the
   * trail could only ever say "it read this file", and a file is the least
   * useful thing to light on a map of a project.
   */
  ranged: Map<string, GraphItem[]>;
  /** Every connection touching an item, in graph order. Both directions. */
  links: Map<string, GraphConnection[]>;
  /** Null when this project's source cannot be reached at all. */
  read: SourceReader | null;
  signal?: AbortSignal;
  /**
   * One file, fetched once.
   *
   * A real investigation reads the same file at two windows — the imports at
   * the top and the thing that went wrong at line 200 — and on a GitHub
   * project each read is a round trip across the internet counted against the
   * wall-clock ceiling. Bounded, because holding source is the thing this
   * product is careful about and an unbounded map would quietly become a copy
   * of the repository.
   */
  cache: Map<string, SourceResult>;
};

/** How many files one investigation may hold text for at a time. */
const CACHE_FILES = 8;

/** Ten lines is a screenful to choose from; forty is a wall to skim past. */
const FIND_LIMIT = 10;
/** Per direction, so forty things inside a file cannot push out its two callers. */
const NEIGHBOUR_LIMIT = 6;
/** Past this a listing becomes folders with counts, which is how a person narrows. */
const LIST_LIMIT = 30;

export function createToolContext(
  graph: QaGraph,
  read: SourceReader | null,
  signal?: AbortSignal,
): ToolContext {
  const files = new Map<string, GraphItem>();
  const ranged = new Map<string, GraphItem[]>();
  for (const item of graph.items) {
    if (!item.path) continue;
    if (item.kind === "file") files.set(item.path, item);
    if (item.startLine !== null) push(ranged, item.path, item);
  }

  const links = new Map<string, GraphConnection[]>();
  for (const connection of graph.connections) {
    push(links, connection.from, connection);
    push(links, connection.to, connection);
  }

  return {
    graph,
    catalog: buildCatalog(graph.items),
    beam: buildBeamIndex(graph.items),
    files,
    ranged,
    links,
    read,
    signal,
    cache: new Map(),
  };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const held = map.get(key);
  if (held) held.push(value);
  else map.set(key, [value]);
}

// --- What the model is told it may do --------------------------------------

/**
 * `why` and `learned` ride on every tool.
 *
 * `why` is the hypothesis, and the reason this loop is watchable at all: it
 * costs about fifteen tokens and it turns a sequence of tool calls into a
 * sentence a non-developer can follow.
 *
 * `learned` is the conclusion of the PREVIOUS step, written one turn late on
 * purpose. Asking "what did that tell you?" as its own round trip would double
 * the steps and the tokens to learn something the model is about to act on
 * anyway; carrying it on the next call gets the same sentence for free. When
 * it is missing we record nothing rather than guessing — a trace that invents
 * the model's reasoning is worse than one with a gap in it.
 */
const COMMON_PROPERTIES = {
  why: {
    type: "string",
    description: "지금 무엇을 확인하려는지 한 문장으로.",
  },
  learned: {
    type: "string",
    description: "바로 앞 결과에서 알게 된 것 한 문장으로. 첫 호출이면 비워 두세요.",
  },
} as const;

function spec(
  name: QaToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): LlmToolSpec {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: { ...COMMON_PROPERTIES, ...properties },
      required: ["why", ...required],
      additionalProperties: false,
    },
  };
}

const FIND_SPEC = spec(
  "find_items",
  "낱말로 프로젝트 안을 찾아요. 파일 이름, 코드 이름, 사람이 읽는 이름을 한꺼번에 봐요. 한국어 낱말도 되고 초성만 써도 돼요.",
  { words: { type: "string", description: "찾을 낱말. 예: 결제, PayButton, ㄱㅈ" } },
  ["words"],
);

const OPEN_SPEC = spec(
  "open_item",
  "번호 하나를 펼쳐서, 그게 무엇을 쓰고 어디에서 쓰이는지 봐요. 번호는 find_items나 list_files가 알려준 대괄호 안 숫자예요.",
  { item: { type: "integer", description: "대괄호 안 번호. 예: 7" } },
  ["item"],
);

const LIST_SPEC = spec(
  "list_files",
  "폴더 아래에 어떤 파일이 있는지 봐요. 낱말이 떠오르지 않을 때 쓰세요.",
  {
    prefix: {
      type: "string",
      description: "폴더 경로. 비우면 맨 위부터. 예: src/components/",
    },
  },
  [],
);

const READ_SPEC = spec(
  "read_source",
  `파일의 한 구간을 줄 번호와 함께 읽어요. 한 번에 최대 ${MAX_WINDOW_LINES}줄이에요. 직접 읽은 줄만 certain으로 말할 수 있어요.`,
  {
    path: { type: "string", description: "파일 경로. 목록에 나온 그대로." },
    fromLine: { type: "integer", description: "읽기 시작할 줄 번호. 기본 1." },
    lines: {
      type: "integer",
      description: `읽을 줄 수. 기본 ${DEFAULT_WINDOW_LINES}, 최대 ${MAX_WINDOW_LINES}.`,
    },
  },
  ["path"],
);

const REPORT_SPEC = spec(
  "report",
  "조사를 끝내고 답을 내요. 항목마다 실제로 열어본 파일과 줄 번호를 붙여야 해요. 원인을 못 찾았으면 못 찾았다고 적어도 돼요.",
  {
    answer: {
      type: "string",
      description: "코드를 모르는 사람이 읽을 답. 한국어 해요체로 두세 문장.",
    },
    findings: {
      type: "array",
      description: "확인한 것들. 근거가 없으면 비워 두세요.",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "한 문장짜리 사실 하나." },
          certainty: {
            type: "string",
            enum: ["certain", "inferred"],
            description:
              "그 줄을 직접 읽고 확인했으면 certain, 이름이나 연결만 보고 짐작했으면 inferred.",
          },
          citations: {
            type: "array",
            description: "실제로 읽거나 펼쳐본 자리. 한 곳, 많아야 두 곳.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                startLine: { type: "integer" },
                endLine: { type: "integer" },
              },
              required: ["path", "startLine", "endLine"],
              additionalProperties: false,
            },
          },
        },
        required: ["claim", "certainty", "citations"],
        additionalProperties: false,
      },
    },
    ruledOut: {
      type: "array",
      description: "찾아보고 원인이 아니라고 본 곳들. 한 줄씩.",
      items: { type: "string" },
    },
    unresolved: { type: "string", description: "끝내 확인하지 못한 것." },
  },
  ["answer", "findings"],
);

/** Every spec, including `report`. The loop hands this straight to the model. */
export const QA_TOOL_SPECS: readonly LlmToolSpec[] = [
  FIND_SPEC,
  OPEN_SPEC,
  LIST_SPEC,
  READ_SPEC,
  REPORT_SPEC,
];

/**
 * The specs for a project whose source cannot be reached.
 *
 * `read_source` is removed rather than left in to refuse, because a tool that
 * always fails is a step the user pays for to be told no. With it gone the
 * loop can only ever produce `inferred` findings — which is the honest ceiling
 * for an investigation that could not open a single file, and the shape of the
 * answer says so without anyone having to write a disclaimer.
 */
export function toolSpecsFor(hasSource: boolean): LlmToolSpec[] {
  return QA_TOOL_SPECS.filter(
    (tool) => hasSource || tool.name !== "read_source",
  );
}

export function isQaToolName(name: string): name is QaToolName {
  return (
    name === "find_items" ||
    name === "open_item" ||
    name === "list_files" ||
    name === "read_source" ||
    name === "report"
  );
}

// --- Arguments -------------------------------------------------------------

/**
 * The model's arguments, whatever it actually sent.
 *
 * `LlmToolCall.arguments` is `unknown` because it is parsed from the model's
 * own JSON and is wrong sometimes. Some endpoints hand back the raw string
 * rather than a parsed object, so both are accepted here; anything else is
 * null, and the caller says so in words instead of crashing on a property.
 */
export function toArgumentObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(raw) ? raw : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The hypothesis and the previous step's conclusion, pulled off any call. */
export function commonOf(args: Record<string, unknown> | null): {
  why: string;
  learned: string | null;
} {
  const why = typeof args?.why === "string" ? args.why.trim() : "";
  const learned = typeof args?.learned === "string" ? args.learned.trim() : "";
  return { why, learned: learned === "" ? null : learned };
}

/**
 * Numbers arrive as strings from some models more often than not, and refusing
 * `"40"` for line 40 spends one of twelve steps on punctuation. Coercion here
 * is not laxity: the bounds below are what actually protect us, and they are
 * checked either way.
 */
const integer = z.coerce.number().int();

const findArgs = z.object({ words: z.string().trim().min(1).max(80) });
const openArgs = z.object({ item: integer.min(1) });
const listArgs = z.object({ prefix: z.string().max(300).optional() });
const readArgs = z.object({
  path: z.string().trim().min(1).max(1024),
  fromLine: integer.min(1).max(10_000_000).default(1),
  lines: integer.min(1).max(MAX_WINDOW_LINES).optional(),
});

// --- Running one ------------------------------------------------------------

/**
 * One tool call, or a sentence explaining why it did not run.
 *
 * A bad argument is never thrown. The model gets told what was wrong in the
 * same channel it would have got a result in, and tries again on its next step
 * — which the budget is already counting. Throwing would end an investigation
 * over a missing field.
 */
export async function runTool(
  context: ToolContext,
  name: QaToolName,
  args: Record<string, unknown> | null,
): Promise<ToolOutcome> {
  if (args === null) {
    return refusal("도구에 넘긴 값을 읽지 못했어요. JSON 객체로 다시 보내 주세요.");
  }

  switch (name) {
    case "find_items":
      return findItems(context, args);
    case "open_item":
      return openItem(context, args);
    case "list_files":
      return listFiles(context, args);
    case "read_source":
      return readSource(context, args);
    case "report":
      // The loop handles `report` before it ever gets here. Reaching this means
      // a caller wired it wrong, and a sentence beats a silent empty result.
      return refusal("report는 조사를 끝낼 때만 쓸 수 있어요.");
  }
}

function refusal(text: string): ToolOutcome {
  return { text, note: text, ledger: [], items: [], hops: [] };
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "값"}: ${issue.message}`)
    .join(", ");
}

function findItems(
  context: ToolContext,
  args: Record<string, unknown>,
): ToolOutcome {
  const parsed = findArgs.safeParse(args);
  if (!parsed.success) {
    return refusal(`찾을 낱말이 필요해요. (${issuesOf(parsed.error)})`);
  }

  const words = parsed.data.words;
  const beam = runBeam(context.beam, words);
  const matched = context.graph.items.filter((item) => beam.matched.has(item.id));

  if (matched.length === 0) {
    return refusal(
      `"${words}"로는 아무것도 못 찾았어요. 다른 낱말로 다시 찾아보거나 list_files로 폴더를 훑어보세요.`,
    );
  }

  // Busiest first: on a real repo the thing named in a complaint is usually the
  // one many places touch, and a deterministic tie-break keeps two runs of the
  // same question comparable.
  const ranked = [...matched].sort(byReach);
  const shown = ranked.slice(0, FIND_LIMIT);

  const head =
    ranked.length > FIND_LIMIT
      ? `"${words}"로 ${ranked.length}곳을 찾았어요. 많이 쓰이는 ${shown.length}개만 보여드려요.`
      : `"${words}"로 ${ranked.length}곳을 찾았어요.`;

  return {
    text: [head, ...shown.map((item) => itemLine(context.catalog, item))].join("\n"),
    note: `"${words}"로 ${ranked.length}곳을 찾았어요.`,
    ledger: shown.flatMap(placeOf),
    // The ones shown, not the ones ranked out. A match the model never saw is
    // not a place the walk went.
    items: shown.map((item) => item.id),
    hops: [],
  };
}

function byReach(a: GraphItem, b: GraphItem): number {
  const reach = b.usedBy + b.uses - (a.usedBy + a.uses);
  if (reach !== 0) return reach;
  // Not localeCompare: its ordering depends on the machine's collation, and two
  // environments disagreeing about a list is a bug only ever seen in a
  // screenshot.
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

function openItem(
  context: ToolContext,
  args: Record<string, unknown>,
): ToolOutcome {
  const parsed = openArgs.safeParse(args);
  if (!parsed.success) {
    return refusal(`펼칠 번호가 필요해요. (${issuesOf(parsed.error)})`);
  }

  const item = context.catalog.at(parsed.data.item);
  if (!item) {
    return refusal(
      `${parsed.data.item}번은 없는 번호예요. find_items나 list_files로 먼저 번호를 찾아 주세요.`,
    );
  }

  const around = buildNeighbourhood(context.graph, item.id, {
    hops: 1,
    limit: NEIGHBOUR_LIMIT,
  });
  if (!around) return refusal("그 번호를 지도에서 찾지 못했어요.");

  const lines: string[] = [itemLine(context.catalog, item)];
  if (item.summary) lines.push(`설명: ${item.summary}`);

  /*
   * Neutral headings, and the verb on each row carries what the link actually
   * is.
   *
   * "쓰이는 곳" over a `contains` link would say a file that holds a piece is a
   * place that uses it — D69's exact inflation, in the one sentence this
   * product is sold on, said to the thing that is about to write the answer.
   * The direction is in the heading because direction is what a one-hop walk
   * establishes; whether it is a use is in the verb, where it belongs.
   */
  lines.push(
    ...side("여기서 나가는 연결", around.uses, around.hidden.uses, context, "forward"),
  );
  lines.push(
    ...side(
      "여기로 들어오는 연결",
      around.usedBy,
      around.hidden.usedBy,
      context,
      "backward",
    ),
  );
  if (around.found.uses === 0 && around.found.usedBy === 0) {
    // The panel's own sentence. "연결이 없어요" is a fact; "쓰이지 않아요" would
    // be a claim about the user's code that a one-hop walk cannot support.
    lines.push("아직 알려진 연결이 없어요.");
  }

  const shownNeighbours = [...around.uses, ...around.usedBy];

  return {
    text: lines.join("\n"),
    note: `${item.name}을(를) 펼쳤어요. 나가는 연결 ${around.found.uses}개, 들어오는 연결 ${around.found.usedBy}개.`,
    ledger: [
      ...placeOf(item),
      ...around.uses.flatMap((n) => placeOf(n.item)),
      ...around.usedBy.flatMap((n) => placeOf(n.item)),
    ],
    // The item stood on, then what it was shown links to — which is the order
    // the walk went, and the order the map should animate.
    items: [item.id, ...shownNeighbours.map((n) => n.item.id)],
    hops: shownNeighbours.flatMap((n) => hopFor(context, item.id, n)),
  };
}

/**
 * The connection behind one neighbour row.
 *
 * `buildNeighbourhood` returns the relation and the certainty but not the
 * connection's own id, and the map draws edges by id — so it is looked up here
 * rather than reconstructed there. At one hop the pair and the relation
 * identify it: `neighbourhood` reports `relation` as the hop that touches the
 * selected item, which at depth 1 is the only hop there is.
 *
 * Nothing is invented when the lookup fails. A neighbour whose connection
 * cannot be named is still a point on the trail — the loop genuinely saw it —
 * it simply arrives with no line drawn to it, which is what "we cannot say
 * which link this was" looks like on a map.
 */
function hopFor(
  context: ToolContext,
  selected: string,
  neighbour: {
    item: GraphItem;
    direction: "uses" | "used-by";
    relation: ConnectionRelation;
    hopCertainty: Certainty;
  },
): RevealedHop[] {
  const from = neighbour.direction === "uses" ? selected : neighbour.item.id;
  const to = neighbour.direction === "uses" ? neighbour.item.id : selected;
  const match = (context.links.get(selected) ?? []).find(
    (connection) =>
      connection.from === from &&
      connection.to === to &&
      connection.relation === neighbour.relation,
  );
  if (!match) return [];
  return [
    {
      connectionId: match.id,
      from,
      to,
      relation: match.relation,
      // The connection's own certainty, not the path's. At one hop they are the
      // same thing, and taking it from the row keeps them so.
      certainty: neighbour.hopCertainty,
    },
  ];
}

type Side = {
  item: GraphItem;
  relation: keyof typeof RELATION_WORDS;
  certainty: keyof typeof CERTAINTY_WORDS;
};

function side(
  heading: string,
  neighbours: readonly Side[],
  hidden: number,
  context: ToolContext,
  direction: "forward" | "backward",
): string[] {
  if (neighbours.length === 0) return [];
  const rows = neighbours.map(
    (n) =>
      `  ${itemLine(context.catalog, n.item)} — ${RELATION_WORDS[n.relation][direction]} · ${CERTAINTY_WORDS[n.certainty]}`,
  );
  // The cap is said out loud. A list that stops at six with no note reads as
  // "that is all there is", which on this product is a false statement about
  // somebody's code.
  const head =
    hidden > 0 ? `${heading} (${hidden}개는 줄였어요):` : `${heading}:`;
  return [head, ...rows];
}

function listFiles(
  context: ToolContext,
  args: Record<string, unknown>,
): ToolOutcome {
  const parsed = listArgs.safeParse(args);
  if (!parsed.success) {
    return refusal(`폴더 경로를 읽지 못했어요. (${issuesOf(parsed.error)})`);
  }

  const prefix = normalisePrefix(parsed.data.prefix ?? "");
  const matches = [...context.files.values()].filter(
    (file) => file.path !== null && file.path.startsWith(prefix),
  );

  if (matches.length === 0) {
    const tops = topFolders(context, "");
    const hint =
      tops.length > 0 ? ` 맨 위에는 ${tops.join(", ")}이(가) 있어요.` : "";
    return refusal(`"${prefix}" 아래에는 파일이 없어요.${hint}`);
  }

  const note = `"${prefix}" 아래 파일 ${matches.length}개를 봤어요.`;

  if (matches.length <= LIST_LIMIT) {
    return {
      text: [`${prefix || "맨 위"} 아래 파일 ${matches.length}개예요.`,
        ...matches.map((file) => itemLine(context.catalog, file))].join("\n"),
      note,
      // A listing shows no line numbers, so nothing here becomes citable. That
      // is deliberate: seeing a file's name is not reading it.
      ledger: [],
      /*
       * And for the same reason, no points.
       *
       * A listing is orientation, not traversal: it tells the model what
       * exists, not what is in anything. Counting these as places visited would
       * put thirty files on the trail the loop never opened, and the picture
       * would show a sweep across the project where the account shows a person
       * checking a folder. The next step's real landing shows as a restart,
       * which is exactly what happened.
       */
      items: [],
      hops: [],
    };
  }

  // Too many to read: fold into the next path segment, which is what a person
  // does when a folder is too big — narrow, then look again.
  const folders = new Map<string, number>();
  const direct: GraphItem[] = [];
  for (const file of matches) {
    const rest = (file.path ?? "").slice(prefix.length);
    const cut = rest.indexOf("/");
    if (cut === -1) direct.push(file);
    else {
      const folder = rest.slice(0, cut + 1);
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
  }

  const folderRows = [...folders.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([folder, count]) => `폴더 ${prefix}${folder} — 파일 ${count}개`);
  const fileRows = direct
    .slice(0, LIST_LIMIT)
    .map((file) => itemLine(context.catalog, file));

  const head = `${prefix || "맨 위"} 아래에 파일이 ${matches.length}개라 폴더로 묶어 보여드려요.`;
  const tail =
    direct.length > LIST_LIMIT
      ? [`이 폴더 바로 아래 파일 ${direct.length - LIST_LIMIT}개는 줄였어요.`]
      : [];

  return {
    text: [head, ...folderRows, ...fileRows, ...tail].join("\n"),
    note,
    ledger: [],
    items: [],
    hops: [],
  };
}

function topFolders(context: ToolContext, prefix: string): string[] {
  const tops = new Set<string>();
  for (const file of context.files.values()) {
    const rest = (file.path ?? "").slice(prefix.length);
    const cut = rest.indexOf("/");
    if (cut !== -1) tops.add(rest.slice(0, cut + 1));
  }
  return [...tops].sort().slice(0, 8);
}

/**
 * A folder, spelled the way the map spells paths, with the trailing slash the
 * prefix test needs. Without the slash, `src/app` would also match
 * `src/apply.ts` — a listing that silently includes a neighbouring folder.
 */
function normalisePrefix(raw: string): string {
  const prefix = normalisePath(raw);
  if (prefix === "" || prefix.endsWith("/")) return prefix;
  return prefix + "/";
}

async function readSource(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const parsed = readArgs.safeParse(args);
  if (!parsed.success) {
    return refusal(`읽을 파일 경로가 필요해요. (${issuesOf(parsed.error)})`);
  }
  if (!context.read) {
    return refusal(
      "이 프로젝트는 파일을 직접 열어볼 수 없어요. 지도에 있는 이름과 연결만으로 답해야 해서, 확인한 것은 모두 inferred예요.",
    );
  }

  const path = normalisePath(parsed.data.path);

  /*
   * The map is the authority for what may be read.
   *
   * Exactly the rule the file endpoint enforces, and for exactly the same
   * reason: a path the model produced is a request, not a permission. Without
   * this, a tool meant to read one project's files is a reader for the whole
   * repository — harmless on a public repo, a real leak on a private one
   * reachable with the signed-in user's token.
   */
  const known = context.files.get(path);
  if (!known) {
    return refusal(`${path}: ${SOURCE_REFUSAL_WORDS.not_in_project}`);
  }

  const result = await readCached(context, context.read, path);
  if (!result.ok) {
    return refusal(`${path}: ${SOURCE_REFUSAL_WORDS[result.reason]}`);
  }

  const window = windowOf(
    path,
    result.text,
    parsed.data.fromLine,
    parsed.data.lines ?? DEFAULT_WINDOW_LINES,
  );

  const empty = window.lines.length === 0;

  return {
    text: renderWindow(window),
    note: `${path} ${window.startLine}-${window.endLine}줄을 읽었어요.`,
    // An empty window is not a place: citing it would cite nothing.
    ledger: empty
      ? []
      : [
          {
            path,
            startLine: window.startLine,
            endLine: window.endLine,
            read: true,
          },
        ],
    /*
     * The file, and whatever is written on the lines that came back.
     *
     * The file alone would be a true but useless point — a map of a project
     * lights 조각, and "it read this file" is the one thing the person could
     * already see. Intersection rather than containment, because every piece
     * the window touched had at least one of its lines on screen, and a window
     * that stops in the middle of a function still read part of that function.
     * Whether the answer rests on any of them is a different question, decided
     * by the citations rather than by this.
     */
    items: empty ? [] : [known.id, ...touched(context, path, window).map((i) => i.id)],
    hops: [],
  };
}

/** Everything with a line range in this file that the window overlapped. */
function touched(
  context: ToolContext,
  path: string,
  window: { startLine: number; endLine: number },
): GraphItem[] {
  const inFile = context.ranged.get(path) ?? [];
  return inFile.filter((item) => {
    const start = item.startLine ?? 0;
    const end = item.endLine ?? start;
    return start <= window.endLine && end >= window.startLine;
  });
}

async function readCached(
  context: ToolContext,
  // Passed in rather than read off the context, so the null check that already
  // happened at the call site is the only one and no assertion is needed here.
  read: SourceReader,
  path: string,
): Promise<SourceResult> {
  const held = context.cache.get(path);
  if (held) return held;

  const result = await read(path, context.signal);

  // Oldest out first. `Map` iterates in insertion order, so the first key is
  // the file we have gone longest without needing.
  if (context.cache.size >= CACHE_FILES) {
    const oldest = context.cache.keys().next();
    if (!oldest.done) context.cache.delete(oldest.value);
  }
  context.cache.set(path, result);
  return result;
}

/**
 * The citable range of an item the graph showed us, or nothing.
 *
 * A file node has no line range, so seeing a file in a search result never
 * makes any line of it citable. That is the rule that forces `read_source`
 * before anyone can say anything about what a file contains.
 */
function placeOf(item: GraphItem): LedgerEntry[] {
  if (!item.path || item.startLine === null) return [];
  return [
    {
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine ?? item.startLine,
      read: false,
    },
  ];
}

/** Kind words, for the prompt's one-line description of the project. */
export function kindTally(items: readonly GraphItem[]): string {
  const counts = new Map<GraphItem["kind"], number>();
  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([kind, count]) => `${KIND_WORDS[kind]} ${count}개`)
    .join(", ");
}
