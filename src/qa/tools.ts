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
  matchesIn,
  MAX_WINDOW_LINES,
  normalisePath,
  probablyText,
  renderWindow,
  SOURCE_REFUSAL_WORDS,
  windowOf,
  WHOLE_FILE_CHARS,
  WHOLE_FILE_LINES,
  type SourceReader,
  type SourceResult,
} from "./source";
import type { QaToolName } from "./types";

/**
 * The eight things the model may do, and the one way it may finish.
 *
 * Chosen so that each answers a different question a person asks when they are
 * looking for a defect they can describe but cannot locate:
 *
 *   - `find_items` — "where is the thing I have a word for?" It is the beam
 *     the map already uses (D59), not a second search: the same 초성 and
 *     wrong-IME handling, so `rufwp` finds 결제 here exactly as it does on
 *     screen. A second implementation would answer the user's own words
 *     differently from the map they are looking at.
 *   - `search_source` — "where is that word actually written?" The beam
 *     matches names; this matches the bytes. It is the difference between
 *     knowing the project has no file called 결제 and knowing that `stripe`
 *     appears on line 41 of `checkout.py`, and it is the tool the founder's
 *     own example needs.
 *   - `open_item` — "what is around it?" The panel's own walk, with the same
 *     rules: a walk never turns around, certainty is the weakest link on the
 *     path, and the cap is reported rather than silent.
 *   - `follow_import` — "and where does the thing it reaches for live?" One
 *     step for what used to be three: read a line, guess a path, list a
 *     folder. It crosses a connection the graph already holds, so the trail
 *     draws it as a traversal rather than as a coincidence.
 *   - `list_files` — "I have no word for it, show me the place." The way a
 *     person narrows when search fails, and the only tool that works when the
 *     user's vocabulary and the code's have nothing in common.
 *   - `list_tree` — the same question asked of the whole project at once, so
 *     orienting costs one step rather than one step per folder.
 *   - `read_source` — "show me the actual lines." A window, never a file.
 *   - `read_file` — the same, for a file short enough that a window is just a
 *     second round trip to the same bytes.
 *   - `report` — finishing. A tool rather than prose because the answer has a
 *     shape we validate (D47 puts the validation in our hands regardless of
 *     what the endpoint advertises), and because "give the answer" has to be a
 *     deliberate act the loop can tell apart from thinking out loud.
 *
 * ## The two rules a new tool has to keep
 *
 * **Every result is small, and every result states its own caps.** A tool that
 * quietly returns the top ten of forty has told the model there are ten. Each
 * one here lands within about a window's worth of tokens, and the budget
 * arithmetic in `types.ts` is measured against that.
 *
 * **A tool that returns the text of a line registers that line as read.** The
 * ledger is what `answer.ts` checks a citation against, and `certain` means
 * the bytes came back — whichever tool fetched them. A tool that returned
 * source and forgot to say so would have its findings correctly refused; a
 * tool that claimed `read` for lines it only summarised would launder a guess
 * into a fact, which is the one failure this module exists to prevent.
 *
 * ## A note for 흐름 따라가기
 *
 * `follow_import` is the shape a flow-walking tool would take
 * (`docs/FLOW_TRACKING.md` §2.3): it stands on an item, crosses connections
 * the graph already holds, and reports them as `RevealedHop`s so `trail.ts`
 * draws real edges by their own ids. A `follow_flow` tool built on
 * `src/lib/graph/flow.ts` slots in beside it with no change to the ledger, the
 * trail or the loop — which is why that walk is not built here.
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
  /** Every item by id, so a connection's far end can be named without a scan. */
  byId: Map<string, GraphItem>;
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
  /**
   * What a content search has already looked inside, for as long as this one
   * question lasts.
   *
   * Separate from `cache` and bigger, because the two hold files for opposite
   * reasons. `cache` holds the handful the loop is working with; this holds
   * the tens a search swept past, most of which matched nothing — and putting
   * those through an eight-file LRU would evict the very window the model just
   * asked about.
   *
   * It exists because of a measured failure: a search looks inside forty-eight
   * files, and the next search looks inside the same forty-eight. On a GitHub
   * project that is ninety-six requests against a limit of sixty an hour, and
   * the whole rest of the investigation then reads nothing at all. With this,
   * the first search pays for the project and every later one is free.
   *
   * Bounded by bytes and by count, never written anywhere, and gone with the
   * request — the same bargain `read_source` makes, in the same quantity the
   * read cache could already reach. Failures are held too, deliberately: a
   * file that just refused will refuse again, and asking it twice is how a
   * rate limit turns into a rate limit for everybody.
   */
  held: Map<string, SourceResult>;
  /** Bytes in `held`, so the ceiling is a number rather than a hope. */
  heldBytes: { total: number };
  /**
   * How many reads in a row came back rate limited or unreachable.
   *
   * Counted so the loop can be told, in words, that opening files is not
   * working right now — instead of spending its remaining steps discovering it
   * one file at a time.
   */
  unreadable: { run: number };
};

/** How many files one investigation may hold text for at a time. */
const CACHE_FILES = 8;

/** Ten lines is a screenful to choose from; forty is a wall to skim past. */
const FIND_LIMIT = 10;
/** Per direction, so forty things inside a file cannot push out its two callers. */
const NEIGHBOUR_LIMIT = 6;
/** Past this a listing becomes folders with counts, which is how a person narrows. */
const LIST_LIMIT = 30;

/**
 * The content search, bounded four ways, and each bound is a different way it
 * could go wrong.
 *
 * **Files looked inside.** The only bound that costs wall clock: on a GitHub
 * project every one of these is a round trip, and the loop is inside a request
 * somebody is watching. Sixty at six at a time is a second or two.
 *
 * **Bytes pulled.** Sixty files is cheap until one of them is a 400 KB
 * generated module. The byte ceiling stops early and the result says so.
 *
 * **Matches shown**, and **matches per file.** Ten rows is about a window's
 * worth of tokens, which is the discipline every other tool here keeps. Three
 * per file so one generated file with four hundred hits cannot crowd out the
 * nine other files that matched once each — which is precisely the case where
 * the answer is in one of the nine.
 *
 * What is NOT bounded is honesty about the bound: the result always says how
 * many files it looked inside out of how many exist, because "I searched the
 * project" and "I searched sixty of its three hundred files" are different
 * statements about somebody's code.
 */
const SEARCH_FILES = 60;
const SEARCH_BYTES = 1_000_000;
const SEARCH_MATCHES = 10;
const SEARCH_PER_FILE = 3;
/** Fetched in waves of this size, in ranked order, so the result is the same twice. */
const SEARCH_AT_ONCE = 6;
/**
 * How much scanned text one investigation may hold, and how many files.
 *
 * Within what the read cache could already reach on its own — eight files at
 * the reader's own half-megabyte ceiling — so this is not a new bargain, only
 * a differently shaped one. Past either number the search keeps working and
 * simply stops remembering, which costs a re-fetch and never a wrong answer.
 */
const SCAN_HOLD_BYTES = 1_500_000;
const SCAN_HOLD_FILES = 200;

/**
 * Reads in a row that could not be opened before the loop is told to stop
 * trying.
 *
 * Two is a coincidence — a deleted file, a binary. Three in a row is the
 * repository being unreachable, and the honest thing to do with that is say
 * so once rather than let the model find out eight more times.
 */
const UNREADABLE_RUN = 3;

/** Rows in a tree. Past this it stops being an orientation and becomes a listing. */
const TREE_ROWS = 40;
/** How deep the tree goes. Three levels reaches `src/components/workspace/`. */
const TREE_DEPTH = 3;

/** How much of a followed file comes back. Enough to see what it holds. */
const FOLLOW_LINES = 40;
/** Imports named back at the model when the one it asked for is not among them. */
const IMPORT_LIMIT = 10;

export function createToolContext(
  graph: QaGraph,
  read: SourceReader | null,
  signal?: AbortSignal,
): ToolContext {
  const files = new Map<string, GraphItem>();
  const ranged = new Map<string, GraphItem[]>();
  const byId = new Map<string, GraphItem>();
  for (const item of graph.items) {
    byId.set(item.id, item);
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
    byId,
    ranged,
    links,
    read,
    signal,
    cache: new Map(),
    held: new Map(),
    heldBytes: { total: 0 },
    unreadable: { run: 0 },
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

const SEARCH_SPEC = spec(
  "search_source",
  `파일 **안의 글자**를 찾아요. 이름이 아니라 코드에 실제로 적힌 말을 찾을 때 쓰세요. 예: stripe, checkout, TODO, 환불. 한 번에 파일 ${SEARCH_FILES}개까지 들여다보고, 찾은 줄 ${SEARCH_MATCHES}개까지 보여드려요.`,
  {
    words: {
      type: "string",
      description: "파일 안에서 찾을 글자. 대소문자는 가리지 않아요.",
    },
    where: {
      type: "string",
      description:
        "폴더 경로를 적으면 그 아래만, 파일 경로를 적으면 그 파일 안만 찾아요. 비우면 프로젝트 전체. 예: strategies/, bot.py",
    },
  },
  ["words"],
);

const TREE_SPEC = spec(
  "list_tree",
  `폴더 구조를 한눈에 봐요. 어느 폴더에 파일이 몇 개 있는지 ${TREE_DEPTH}단계까지 한 번에 보여드려요. 처음에 어디부터 볼지 정할 때 쓰세요.`,
  {
    prefix: {
      type: "string",
      description: "여기 아래만 볼 폴더 경로. 비우면 맨 위부터.",
    },
  },
  [],
);

const FOLLOW_SPEC = spec(
  "follow_import",
  `어떤 파일이 불러오는 다른 파일로 건너가요. 코드 맨 위의 import 줄에 적힌 이름을 그대로 넣으면, 그게 어느 파일인지 찾아서 앞 ${FOLLOW_LINES}줄을 같이 읽어 줘요. 이름을 비우면 그 파일이 무엇들을 불러오는지 알려드려요.`,
  {
    path: { type: "string", description: "지금 보고 있는 파일 경로." },
    name: {
      type: "string",
      description:
        "따라갈 이름. import 줄에 적힌 그대로. 예: strategies.base, ./utils, broker",
    },
  },
  ["path"],
);

const READ_FILE_SPEC = spec(
  "read_file",
  `짧은 파일을 통째로 읽어요. ${WHOLE_FILE_LINES}줄이 넘으면 앞부분만 읽고 알려드려요. 파일 전체를 봐야 할 때 read_source를 여러 번 부르는 대신 쓰세요.`,
  { path: { type: "string", description: "파일 경로. 목록에 나온 그대로." } },
  ["path"],
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

/**
 * Every spec, including `report`. The loop hands this straight to the model.
 *
 * Ordered the way an investigation tends to go — find, search, open, follow,
 * list, read, finish — because a list of tools is also a suggestion about how
 * to use them, and the first two are the ones a question usually starts with.
 */
export const QA_TOOL_SPECS: readonly LlmToolSpec[] = [
  FIND_SPEC,
  SEARCH_SPEC,
  OPEN_SPEC,
  FOLLOW_SPEC,
  LIST_SPEC,
  TREE_SPEC,
  READ_SPEC,
  READ_FILE_SPEC,
  REPORT_SPEC,
];

/**
 * The tools that cannot work without a reader, and are removed rather than
 * left in to refuse.
 *
 * A tool that always fails is a step the user pays for to be told no. With
 * these gone the loop can only ever produce `inferred` findings — the honest
 * ceiling for an investigation that could not open a single file, and the
 * shape of the answer says so without anyone having to write a disclaimer.
 *
 * `follow_import` is deliberately NOT in this list. Resolving a name to the
 * file it refers to is a question about the graph, and the graph is there
 * whether or not the bytes are; without a reader it answers with the file it
 * landed on and says it cannot open it, which is one fewer step than
 * `find_items` and `open_item` would have taken to say the same thing.
 */
const NEEDS_SOURCE: readonly QaToolName[] = [
  "read_source",
  "read_file",
  "search_source",
];

export function toolSpecsFor(hasSource: boolean): LlmToolSpec[] {
  return QA_TOOL_SPECS.filter(
    (tool) =>
      hasSource || !(NEEDS_SOURCE as readonly string[]).includes(tool.name),
  );
}

/** The names, for the sentence told to a model that invented one. */
export function toolNamesFor(hasSource: boolean): string[] {
  return toolSpecsFor(hasSource).map((tool) => tool.name);
}

export function isQaToolName(name: string): name is QaToolName {
  return (
    name === "find_items" ||
    name === "open_item" ||
    name === "list_files" ||
    name === "list_tree" ||
    name === "read_source" ||
    name === "read_file" ||
    name === "search_source" ||
    name === "follow_import" ||
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
 * `"40"` for line 40 spends one of twenty steps on punctuation. Coercion here
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
const pathArgs = z.object({ path: z.string().trim().min(1).max(1024) });
/**
 * Two characters at least, and it is not fussiness: a one-character search
 * matches most of a file and returns ten rows of nothing, having spent sixty
 * fetches to do it. The message says so, so the next step is a better search
 * rather than the same one.
 */
const searchArgs = z.object({
  words: z.string().trim().min(2).max(120),
  where: z.string().max(300).optional(),
});
const followArgs = z.object({
  path: z.string().trim().min(1).max(1024),
  name: z.string().trim().max(200).optional(),
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
    case "list_tree":
      return listTree(context, args);
    case "search_source":
      return searchSource(context, args);
    case "follow_import":
      return followImport(context, args);
    case "read_source":
      return readSource(context, args);
    case "read_file":
      return readWholeFile(context, args);
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

/**
 * The shape of the project in one step, instead of one step per folder.
 *
 * `list_files` answers "what is in here?"; this answers "where is here?" —
 * which is the question a loop actually has on its first turn, and which it
 * was previously answering by spending a step on a thirty-row listing and then
 * another on the folder that listing revealed. Measured on a real
 * investigation, two of eleven steps went on exactly that.
 *
 * Folders only, with counts. A tree that also listed files would be a listing
 * with indentation, and `list_files` is already the better listing. Three
 * levels because that reaches `src/components/workspace/` on this codebase and
 * `strategies/` on a flat Python one; deeper is a folder you narrow into.
 *
 * Nothing goes on the ledger and nothing goes on the trail, for exactly the
 * reason `list_files` gives: seeing a folder's name is not reading anything,
 * and counting thirty folders as places visited would draw a sweep across a
 * project the loop never opened.
 */
function listTree(
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

  /*
   * Every folder gets the count of everything beneath it, not just of what
   * sits directly inside.
   *
   * `src/` saying 3 because three files happen to live at its root, while 211
   * more sit two levels down, is the number that sends a loop into the wrong
   * folder. The total is what says where the project is.
   */
  const totals = new Map<string, number>();
  let direct = 0;

  for (const file of matches) {
    const rest = (file.path ?? "").slice(prefix.length);
    const parts = rest.split("/");
    if (parts.length === 1) {
      direct += 1;
      continue;
    }
    const depth = Math.min(parts.length - 1, TREE_DEPTH);
    for (let level = 1; level <= depth; level += 1) {
      const folder = parts.slice(0, level).join("/") + "/";
      totals.set(folder, (totals.get(folder) ?? 0) + 1);
    }
  }

  const folders = [...totals.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );
  const shown = folders.slice(0, TREE_ROWS);

  const rows = shown.map(([folder, count]) => {
    const parts = folder.split("/").filter((part) => part !== "");
    const indent = "  ".repeat(parts.length);
    return `${indent}${parts[parts.length - 1]}/ — 파일 ${count}개`;
  });

  const head = `${prefix || "맨 위"} 아래 파일 ${matches.length}개예요. 폴더는 ${TREE_DEPTH}단계까지 보여드려요.`;
  const tail: string[] = [];
  if (direct > 0) tail.push(`  (이 폴더 바로 아래 파일 ${direct}개)`);
  // The cap is said out loud, like every other cap here. A tree that stops at
  // forty rows without a note reads as the whole shape of somebody's project.
  if (folders.length > shown.length) {
    tail.push(`폴더 ${folders.length - shown.length}개는 줄였어요. prefix로 좁혀서 다시 보세요.`);
  }

  return {
    text: [head, ...rows, ...tail].join("\n"),
    note: `"${prefix || "맨 위"}" 아래 폴더 ${folders.length}개, 파일 ${matches.length}개를 봤어요.`,
    ledger: [],
    items: [],
    hops: [],
  };
}

/**
 * The word, inside the files rather than on them.
 *
 * `find_items` runs the map's own beam over names, labels and paths, which is
 * right for "where is PayButton" and useless for "결제가 어디서 이뤄져요" on a
 * project whose word for it is `stripe`. This is the tool that answers the
 * second question, and it is the one thing a curious reader could not do here
 * at all.
 *
 * ## What it costs, and what it keeps
 *
 * Every file it looks inside is a fetch — a round trip to GitHub, or a row out
 * of `project_files` for an upload. What it scans is held in memory for the
 * rest of the question (`ToolContext.held`, bounded by bytes and by count) so
 * that a second search does not fetch the same files again; on a GitHub
 * project that was ninety-six requests against a limit of sixty an hour, and
 * it left the whole rest of the investigation unable to read anything.
 *
 * Nothing is written anywhere and nothing outlives the request. That is the
 * same bargain `read_source` already makes — the eight-file read cache could
 * reach four megabytes on its own — and it is what keeps a GitHub project's
 * source unstored (D77) rather than merely unmentioned.
 *
 * ## Why the order is what it is
 *
 * Sixty files out of three hundred is a real limit, so which sixty matters.
 * Files whose own path contains the word come first, because a search for
 * `broker` on a project with a `broker.py` should not depend on luck. Then by
 * reach, the same ordering `find_items` uses — the thing named in a complaint
 * is usually the one many places touch. Then by path, so two runs of one
 * question look inside the same sixty files.
 */
async function searchSource(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const parsed = searchArgs.safeParse(args);
  if (!parsed.success) {
    return refusal(
      `파일 안에서 찾을 글자가 필요해요. 두 글자 이상으로 적어 주세요. (${issuesOf(parsed.error)})`,
    );
  }
  if (!context.read) {
    return refusal(
      "이 프로젝트는 파일을 직접 열어볼 수 없어서 안쪽 글자는 찾을 수 없어요. find_items로 이름을 찾아보세요.",
    );
  }

  const words = parsed.data.words;
  const wanted = words.toLowerCase();

  /*
   * `where` naming one file means "inside that file", not "no such folder".
   *
   * Measured: a real investigation spent a step on
   * `search_source(words: "_PICKED_SYMBOLS", where: "bot.py")` and got back
   * "폴더 경로를 다시 확인해 주세요". The model was not confused — it wanted to
   * search one file, which is a reasonable thing to want and which this can
   * simply do. Checked before the prefix is normalised, because
   * `normalisePrefix` turns `bot.py` into `bot.py/` and nothing lives there.
   */
  const asked = normalisePath(parsed.data.where ?? "");
  const one = context.files.get(asked);
  const where = one ? asked : normalisePrefix(asked);

  const under = one
    ? [one]
    : [...context.files.values()].filter(
        (file) => file.path !== null && file.path.startsWith(where),
      );
  if (under.length === 0) {
    return refusal(
      `"${where}" 아래에는 파일이 없어요. 폴더 경로나 파일 경로를 다시 확인해 주세요.`,
    );
  }

  const eligible = under.filter((file) => probablyText(file.path ?? ""));
  const ranked = [...eligible].sort((a, b) => {
    const inA = (a.path ?? "").toLowerCase().includes(wanted);
    const inB = (b.path ?? "").toLowerCase().includes(wanted);
    if (inA !== inB) return inA ? -1 : 1;
    return byReach(a, b);
  });
  const candidates = ranked.slice(0, SEARCH_FILES);

  const hits: { file: GraphItem; matches: { line: number; text: string }[] }[] =
    [];
  let found = 0;
  /** Files whose text actually came back. The only number "없었어요" may rest on. */
  let opened = 0;
  /** Files that would not open. Never silently folded into the one above. */
  let closed = 0;
  let bytes = 0;
  let stoppedForBytes = false;

  for (let at = 0; at < candidates.length; at += SEARCH_AT_ONCE) {
    if (found >= SEARCH_MATCHES) break;
    if (bytes >= SEARCH_BYTES) {
      stoppedForBytes = true;
      break;
    }
    if (context.signal?.aborted) break;

    const wave = candidates.slice(at, at + SEARCH_AT_ONCE);
    // Fetched together, folded in order. The concurrency is what keeps this
    // one step on the clock rather than sixty; the ordered fold is what keeps
    // the same question returning the same rows.
    const texts = await Promise.all(
      wave.map((file) => scanned(context, file.path ?? "")),
    );

    for (const [index, result] of texts.entries()) {
      if (!result || !result.ok) {
        closed += 1;
        continue;
      }
      opened += 1;
      bytes += result.text.length;
      const file = wave[index];
      const matches = matchesIn(result.text, words, SEARCH_PER_FILE);
      if (matches.length === 0) continue;
      hits.push({ file, matches });
      found += matches.length;
      // Also into the small read cache, because a file that matched is the one
      // the next step is about to open.
      putCache(context, file.path ?? "", result);
    }
  }

  const scope = one ? `"${where}"` : where === "" ? "프로젝트" : `"${where}" 아래`;
  const coverage =
    candidates.length < eligible.length
      ? `${scope} 파일 ${eligible.length}개 중 ${opened}개를 들여다봤어요.`
      : `${scope} 파일 ${opened}개를 들여다봤어요.`;
  const unopened = closed > 0 ? ` ${closed}개는 열어보지 못했어요.` : "";

  /*
   * Nothing opened is not the same as nothing found, and saying the second
   * when the first happened is a false statement about somebody's code.
   *
   * This was real: with GitHub rate limiting every read, the search reported
   * `"stop_loss"를 파일 48개에서 찾아봤는데 없었어요` on a project that
   * contains it. The model believed it, and so would the person reading the
   * trace. A tool may say what it saw; it may never turn what it could not see
   * into an absence.
   */
  if (opened === 0) {
    return refusal(
      `${scope} 파일을 하나도 열어보지 못해서 "${words}"가 있는지 없는지 말할 수 없어요. ${closed}개를 열어보려 했어요. 지금은 지도에 있는 이름과 연결만으로 답해 주세요.`,
    );
  }

  if (hits.length === 0) {
    const why = stoppedForBytes
      ? " 분량이 커서 중간에 멈췄어요."
      : candidates.length < eligible.length
        ? " where로 폴더를 좁히면 더 볼 수 있어요."
        : "";
    return {
      // "들여다본 파일에는 없었어요" — bounded by what was opened, on purpose.
      text: `들여다본 파일에는 "${words}"가 적힌 줄이 없었어요. ${coverage}${unopened}${why}`,
      note: `"${words}"를 파일 ${opened}개에서 찾아봤는데 없었어요.`,
      ledger: [],
      items: [],
      hops: [],
    };
  }

  const rows: string[] = [];
  const ledger: LedgerEntry[] = [];
  const items: string[] = [];
  let shown = 0;

  for (const hit of hits) {
    const path = hit.file.path ?? "";
    let listed = false;
    for (const match of hit.matches) {
      if (shown >= SEARCH_MATCHES) break;
      shown += 1;
      // The file first, then what is written on the line — the same order
      // `read_source` puts on the trail, so the map animates them the same way.
      if (!listed) {
        items.push(hit.file.id);
        listed = true;
      }
      rows.push(`${path}:${match.line}| ${match.text}`);
      /*
       * One line, and exactly the one whose text came back.
       *
       * The bytes of this line were returned to the model, so a claim about
       * this line is a claim about something it read — the same standard
       * `read_source` meets. The range is the single line and not a
       * neighbourhood of it: `coverageOf` demands containment, so a model that
       * wants to say something about the three lines around this one has to
       * go and read them, which is the correct amount of work.
       */
      ledger.push({ path, startLine: match.line, endLine: match.line, read: true });
      items.push(
        ...touched(context, path, { startLine: match.line, endLine: match.line }).map(
          (item) => item.id,
        ),
      );
    }
    if (shown >= SEARCH_MATCHES) break;
  }

  const notes: string[] = [];
  if (found > shown || stoppedForBytes || candidates.length < eligible.length) {
    notes.push("더 있을 수 있어요. where로 폴더를 좁혀서 다시 찾아보세요.");
  }

  return {
    text: [
      `"${words}"가 적힌 줄 ${shown}개를 찾았어요. ${coverage}${unopened}`,
      ...rows,
      ...notes,
    ].join("\n"),
    note: `"${words}"를 파일 ${opened}개에서 찾아 ${shown}줄을 봤어요.`,
    ledger,
    // The file each match sits in, and whatever the map draws on that line.
    // A match is a place the loop was genuinely put in front of — unlike a
    // listing, it came back with the bytes.
    items: [...new Set(items)],
    hops: [],
  };
}

/**
 * One file's text for the scan, from whatever this investigation already has.
 *
 * Deliberately not `readCached`: that one inserts into the eight-file working
 * cache, and a sixty-file sweep through it would evict everything the loop has
 * been reading in order to hold fifty-two files nobody asked for. This puts
 * them in `held` instead, which is what makes a second search of the same
 * project free.
 */
async function scanned(
  context: ToolContext,
  path: string,
): Promise<SourceResult | null> {
  if (path === "" || !context.read) return null;
  const working = context.cache.get(path);
  if (working) return working;
  const already = context.held.get(path);
  if (already) return already;

  let result: SourceResult;
  try {
    result = await context.read(path, context.signal);
  } catch {
    // One unreachable file is not a failed search. It is one fewer file
    // looked inside, and the count in the result already says how many.
    return null;
  }

  hold(context, path, result);
  return result;
}

/** Remember one scanned file, while there is room to. */
function hold(context: ToolContext, path: string, result: SourceResult): void {
  if (context.held.has(path)) return;
  if (context.held.size >= SCAN_HOLD_FILES) return;
  const size = result.ok ? result.text.length : 0;
  if (context.heldBytes.total + size > SCAN_HOLD_BYTES) return;
  context.heldBytes.total += size;
  context.held.set(path, result);
}

/**
 * The import, followed — one step for what used to be three.
 *
 * Reading a file shows `from strategies.base import Strategy` on line 4, and
 * before this the only way on was to guess the path, list the folder, and then
 * read. Each of those is a step out of twenty, and the measured loop spent two
 * of them on exactly that, twice.
 *
 * This crosses a connection the graph already holds, which is what makes it a
 * traversal rather than a lookup: the hop comes back with the connection's own
 * id, so `trail.ts` draws an edge the map already knows instead of inventing
 * one. `uses_package` is followed too, and answers with "that came from
 * outside" — which is a real answer and stops the loop hunting for a file that
 * was never in this project.
 */
async function followImport(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const parsed = followArgs.safeParse(args);
  if (!parsed.success) {
    return refusal(`어느 파일에서 따라갈지 경로가 필요해요. (${issuesOf(parsed.error)})`);
  }

  const path = normalisePath(parsed.data.path);
  const from = context.files.get(path);
  if (!from) return refusal(`${path}: ${SOURCE_REFUSAL_WORDS.not_in_project}`);

  const outgoing = (context.links.get(from.id) ?? []).filter(
    (connection) =>
      connection.from === from.id &&
      (connection.relation === "imports" ||
        connection.relation === "uses_package"),
  );

  const reachable = outgoing.flatMap((connection) => {
    const item = context.byId.get(connection.to);
    return item ? [{ connection, item }] : [];
  });

  if (reachable.length === 0) {
    return refusal(
      `${path}이 불러오는 파일은 지도에 없어요. 지도가 못 알아본 import일 수 있어요. search_source로 이름을 찾아보세요.`,
    );
  }

  const wanted = parsed.data.name?.trim() ?? "";
  const best = wanted === "" ? null : pickImport(reachable, wanted);

  if (!best) {
    // Not a failure: naming what this file actually reaches is the answer to
    // "which of these did I mean", and it costs the same step either way.
    const rows = reachable
      .slice(0, IMPORT_LIMIT)
      .map((one) => `  ${itemLine(context.catalog, one.item)}`);
    const head =
      wanted === ""
        ? `${path}은(는) 이것들을 불러와요.`
        : `${path}에서 "${wanted}"은(는) 못 찾았어요. 불러오는 건 이것들이에요.`;
    const tail =
      reachable.length > IMPORT_LIMIT
        ? [`${reachable.length - IMPORT_LIMIT}개는 줄였어요.`]
        : [];
    return {
      text: [head, ...rows, ...tail].join("\n"),
      note: `${path}이 불러오는 것 ${reachable.length}개를 봤어요.`,
      ledger: reachable.slice(0, IMPORT_LIMIT).flatMap((one) => placeOf(one.item)),
      // The file stood on, then what it reaches — the order `open_item` uses,
      // and the order that lets `trail.ts` recognise a hop as a crossing
      // rather than as two places that happen to be connected.
      items: [from.id, ...reachable.slice(0, IMPORT_LIMIT).map((one) => one.item.id)],
      hops: reachable.slice(0, IMPORT_LIMIT).map((one) => hopOf(one.connection)),
    };
  }

  const hop = hopOf(best.connection);
  const line = itemLine(context.catalog, best.item);

  if (best.item.kind === "package" || !best.item.path) {
    return {
      text: `${line}\n이건 밖에서 가져온 도구라서 이 프로젝트 안에는 파일이 없어요.`,
      note: `${path}에서 ${best.item.name}(으)로 건너갔어요. 밖에서 가져온 도구예요.`,
      ledger: placeOf(best.item),
      items: [from.id, best.item.id],
      hops: [hop],
    };
  }

  const opened = await openWindow(context, best.item.path, 1, FOLLOW_LINES);
  // The landing is real whether or not the file would open; the reading is
  // not. A note that says 읽었어요 over a refusal is a false sentence in the
  // trace a person is watching, and the trace is most of what makes this
  // trustworthy.
  const read = opened.ledger.some((entry) => entry.read);

  return {
    text: `${line}\n${opened.text}`,
    note: read
      ? `${path}에서 ${best.item.name}(으)로 건너가 앞부분을 읽었어요.`
      : `${path}에서 ${best.item.name}(으)로 건너갔는데 파일은 열지 못했어요.`,
    ledger: [...placeOf(best.item), ...opened.ledger],
    // The file stood on, the file landed on, then whatever the head window
    // touched. The first of those is what makes the hop a crossing on the
    // trail: `trail.ts` drops an edge whose other end is not on the walk, and
    // a `follow_import` that only reported where it arrived would have its own
    // traversal redrawn as a coincidence.
    items: [...new Set([from.id, best.item.id, ...opened.items])],
    hops: [hop],
  };
}

function hopOf(connection: GraphConnection): RevealedHop {
  return {
    connectionId: connection.id,
    from: connection.from,
    to: connection.to,
    relation: connection.relation,
    certainty: connection.certainty,
  };
}

/**
 * Which of a file's imports the model meant, scored rather than guessed.
 *
 * An import is written differently in every language a project might be in:
 * `strategies.base`, `./strategies/base`, `../base`, `base`, `Strategy`. All
 * of them are trying to name one file, so the name is reduced to its bare
 * shape — quotes off, leading dots off, dots to slashes, extension off — and
 * matched against the same shape of each candidate.
 *
 * Scored, so the longest true match wins: `base` should not beat
 * `strategies/base` when both are in the list, and the exact path should beat
 * both. A tie goes to the shorter path, so two runs agree.
 */
function pickImport(
  reachable: readonly { connection: GraphConnection; item: GraphItem }[],
  wanted: string,
): { connection: GraphConnection; item: GraphItem } | null {
  const asked = bareName(wanted);
  if (asked === "") return null;

  let best: {
    one: { connection: GraphConnection; item: GraphItem };
    score: number;
  } | null = null;

  for (const one of reachable) {
    const score = importScore(one.item, asked);
    if (score === 0) continue;
    if (
      best === null ||
      score > best.score ||
      (score === best.score &&
        (one.item.path ?? one.item.name) < (best.one.item.path ?? best.one.item.name))
    ) {
      best = { one, score };
    }
  }

  return best?.one ?? null;
}

function importScore(item: GraphItem, asked: string): number {
  const path = item.path === null ? "" : normalisePath(item.path).toLowerCase();
  const bare = withoutExtension(path);
  const base = bare.slice(bare.lastIndexOf("/") + 1);
  const name = item.name.toLowerCase();

  if (path !== "" && path === asked) return 5;
  if (bare !== "" && bare === asked) return 4;
  // `x/y/base` asked for as `base`, or `a/b/c` asked for as `b/c`.
  if (bare !== "" && bare.endsWith(`/${asked}`)) return 3;
  if (name === asked) return 2;
  if (base !== "" && base === asked) return 1;
  // `alpaca.trading.client` naming the `alpaca` package. A package has no path
  // of its own, so its name is the only thing a deep module path can match.
  if (path === "" && name !== "" && asked.startsWith(`${name}/`)) return 1;
  return 0;
}

/**
 * `"./strategies/base.py"` and `strategies.base` both become `strategies/base`.
 *
 * The one trap: a dot means two different things. In `base.py` it starts an
 * extension, and in `strategies.base` it separates module names — and the same
 * three characters can be either. So a trailing segment is treated as an
 * extension only when it IS one, from a list; `strategies.base` keeps its
 * `base` and `base.py` loses its `py`. Getting this backwards turns every
 * Python import in the project into a lookup for a file called `strategies`.
 */
function bareName(raw: string): string {
  let text = raw.trim().replace(/^["'`]+|["'`]+$/g, "").toLowerCase();
  text = text.replace(/\\/g, "/");
  // A leading `.` or `..` is "relative to me", which the graph has already
  // resolved — dropping it is what lets `./utils` match `src/lib/utils.ts`.
  text = text.replace(/^\.+\/?/, "");
  /*
   * And a leading `@/`, `~/` or `#/` is a path alias pointing at the project
   * root, which this codebase itself uses everywhere.
   *
   * Only when a slash follows immediately: `@scope/package` is a published
   * package and its `@` is part of its name, so stripping that would turn
   * every scoped dependency into a lookup for a folder called `scope`.
   */
  text = text.replace(/^[@~#]\//, "");
  text = withoutExtension(normalisePath(text));
  // Dotted module paths, once the extension is out of the way and only when
  // there is no slash to say it was a path all along.
  if (!text.includes("/")) text = text.replace(/\./g, "/");
  return text.replace(/\/+$/, "");
}

/**
 * Extensions this product actually meets. A suffix that is not one of these is
 * part of the name.
 */
const EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "pyi", "rb", "go", "rs", "java", "kt", "swift", "php", "cs",
  "c", "h", "cc", "cpp", "hpp", "m", "mm",
  "vue", "svelte", "astro",
  "css", "scss", "sass", "less", "html", "htm", "xml", "svg",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "env",
  "md", "mdx", "txt", "sh", "bash", "zsh", "sql", "graphql", "gql",
]);

function withoutExtension(path: string): string {
  const cut = path.lastIndexOf("/");
  const base = path.slice(cut + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return path;
  if (!EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) return path;
  return path.slice(0, cut + 1) + base.slice(0, dot);
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
  return openWindow(
    context,
    parsed.data.path,
    parsed.data.fromLine,
    parsed.data.lines ?? DEFAULT_WINDOW_LINES,
  );
}

/**
 * A whole short file, which is a window that was allowed to be longer.
 *
 * Not a second reader: the same guards, the same ledger entry, the same
 * clamping, and `renderWindow` already says where to continue when the file
 * was too long to finish. The only difference is the ceiling, and a file over
 * it comes back as its opening lines rather than as a refusal — which is what
 * `read_source` would have returned anyway, so a mistaken call costs a step
 * and not a step plus a retry.
 */
async function readWholeFile(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const parsed = pathArgs.safeParse(args);
  if (!parsed.success) {
    return refusal(`읽을 파일 경로가 필요해요. (${issuesOf(parsed.error)})`);
  }
  return openWindow(context, parsed.data.path, 1, WHOLE_FILE_LINES, {
    maxLines: WHOLE_FILE_LINES,
    maxChars: WHOLE_FILE_CHARS,
  });
}

/**
 * Fetch a file the map knows about and return one bounded window of it.
 *
 * Shared by `read_source`, `read_file` and the head `follow_import` opens, so
 * that "which files may be read" and "what a read puts on the ledger" have one
 * answer rather than three that could drift apart. Every caller of this
 * registers `read: true` for exactly the lines it printed.
 */
async function openWindow(
  context: ToolContext,
  rawPath: string,
  from: number,
  want: number,
  limits?: { maxLines: number; maxChars: number },
): Promise<ToolOutcome> {
  if (!context.read) {
    return refusal(
      "이 프로젝트는 파일을 직접 열어볼 수 없어요. 지도에 있는 이름과 연결만으로 답해야 해서, 확인한 것은 모두 inferred예요.",
    );
  }

  const path = normalisePath(rawPath);

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
    /*
     * Say once that reading is not working, rather than letting the loop find
     * out one file at a time.
     *
     * Measured: with GitHub rate limiting, an investigation spent seven of its
     * twenty steps opening seven different files and being told the same thing
     * about each, then answered `inferred` on a project whose source is
     * perfectly readable. The budget it burned was the user's.
     *
     * Only for the two failures that are about the repository rather than
     * about the file: a binary and a deleted file are facts about that one
     * path, and the next path is worth trying.
     */
    const repositoryWide =
      result.reason === "rate_limited" || result.reason === "unavailable";
    context.unreadable.run = repositoryWide ? context.unreadable.run + 1 : 0;
    const giveUp =
      repositoryWide && context.unreadable.run >= UNREADABLE_RUN
        ? " 파일을 여는 게 계속 안 되고 있어요. 다른 파일도 마찬가지일 거예요. 지금은 지도에 있는 이름과 연결만으로 답하고, 확인한 것은 inferred로 적어 주세요."
        : "";
    return refusal(`${path}: ${SOURCE_REFUSAL_WORDS[result.reason]}${giveUp}`);
  }
  context.unreadable.run = 0;

  const window = windowOf(path, result.text, from, want, limits);
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
  const working = context.cache.get(path);
  if (working) return working;
  // A file a search already swept past, which is most of them by the time the
  // loop decides to read one.
  const already = context.held.get(path);
  if (already) return already;

  const result = await read(path, context.signal);
  putCache(context, path, result);
  return result;
}

/**
 * Hold one file, and drop the one held longest.
 *
 * Oldest out first. `Map` iterates in insertion order, so the first key is the
 * file we have gone longest without needing. The ceiling is the point: holding
 * source is the thing this product is careful about, and an unbounded map
 * would quietly become a copy of the repository.
 */
function putCache(
  context: ToolContext,
  path: string,
  result: SourceResult,
): void {
  if (path === "") return;
  if (context.cache.has(path)) return;
  if (context.cache.size >= CACHE_FILES) {
    const oldest = context.cache.keys().next();
    if (!oldest.done) context.cache.delete(oldest.value);
  }
  context.cache.set(path, result);
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
