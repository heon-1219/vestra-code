import { FORBIDDEN_WORDS } from "@/qa/answer";

import {
  KIND_WORDS,
  RELATION_RANK,
  RELATION_WORDS,
  type Certainty,
  type ConnectionRelation,
  type GraphConnection,
  type GraphItem,
  type ItemKind,
} from "./view";

/**
 * 흐름 따라가기 — the walk, headless.
 *
 * A user picks a place in their app — 결제, 로그인, `/checkout` — and this
 * computes the path the code makes possible from there, hop by hop, with one
 * plain sentence per hop. `docs/FLOW_TRACKING.md` is the design; this is §2,
 * §5 and §7 of it.
 *
 * ## What this refuses to claim, as rules rather than as a paragraph
 *
 * **We never run the user's code.** Not here, not anywhere in the product. So:
 *
 *   - No hop is phrased in the past tense of execution. A hop says 사용해요,
 *     never 불렀어요 — it describes a connection the parser read, not an event
 *     that happened.
 *   - Nothing counts how often anything runs or how long it takes, and no
 *     field here could be mistaken for either.
 *   - Nothing says which branch a condition takes. The parser recorded that A
 *     can reach B, not under what condition, and `catch` blocks are not in the
 *     graph at all.
 *   - The branch count travels on every hop, because one path out of many
 *     presented alone is a claim that it is the only one.
 *   - 실행 · 추적 · 실시간 join 안전 · 노드 · 엣지 on the forbidden list for
 *     every sentence this module produces. `flowSentenceIssues` is the check
 *     and `flow.test.ts` runs it over every sentence the module can emit.
 *
 * ## Pure, and importable with no environment
 *
 * No React, no model, no database, no clock, no randomness. It takes a loaded
 * graph as a parameter and never fetches one — `src/lib/env.ts` validates 21
 * variables at import time and throws, and `@/db` and `@/lib/llm` both pull it
 * in transitively. A test of this file must be able to run with no environment
 * at all, so nothing here may reach for either.
 *
 * ## Determinism
 *
 * Two walks over an unchanged graph produce byte-identical paths and
 * byte-identical event sequences, including the order of the branch lists.
 * Same promise `load.ts`, `layout.ts` and `grouping.ts` each make, and the
 * mechanism is the same: every list is given a total order, nothing sorts by
 * `localeCompare`, and the last tiebreak everywhere is an id.
 */

// ---------------------------------------------------------------------------
// Bounds (§2.5)
// ---------------------------------------------------------------------------

/**
 * Twelve, where the neighbourhood's `MAX_HOPS` is six.
 *
 * Not an inconsistency: six is a *radius* and a radius doubles its reach at
 * every step, so past five or six you have selected the whole project. A path
 * is one-directional and does not. Twelve is about what fits in a panel, and
 * about how long a story stays a story.
 */
export const MAX_FLOW_HOPS = 12;

/**
 * Four partial paths survive each depth.
 *
 * Greedy (beam 1) was the first answer and it is wrong: it dead-ends early
 * while a sibling branch reached the server. Full enumeration is exponential
 * and unnecessary. Four is enough to survive one bad-looking first hop, and it
 * is also where the "other paths" list comes from, so it is not a second cost.
 */
export const BEAM = 4;

/** A hard stop for a pathological graph, checked rather than assumed. */
export const MAX_EXPANSIONS = 400;

/**
 * How many other paths the panel lists.
 *
 * The `hidden` pattern from `neighbourhood.ts`: a list that stops at three
 * with no note reads as "that is all there is", which on this product is a
 * false statement about somebody's code. `FlowTrace.found` is the total and
 * the UI must say it.
 */
export const BRANCHES_SHOWN = 3;

/**
 * The relations a flow may walk (§2.2).
 *
 * `imports` is excluded, and this is the decision that makes the feature work
 * at all: it is the same reach at a coarser grain, and admitting it makes
 * everything reach everything — every file that imports a barrel imports the
 * whole folder.
 *
 * `contains` and `belongs_to` are structure, not something the code does.
 * `uses_package` is an annotation on a hop, never a path member, which keeps
 * `react` out of every path while still saying where the project's edge is.
 */
export const HOP_RELATIONS: ReadonlySet<ConnectionRelation> = new Set<ConnectionRelation>([
  "renders",
  "calls",
  "fetches",
]);

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** What the walk needs. A `GraphView` satisfies it. */
export type FlowGraph = {
  items: readonly GraphItem[];
  connections: readonly GraphConnection[];
};

/** Where the flow's start came from. `feature` is Phase 5 and unused today. */
export type FlowSpine = "route" | "selection" | "feature";

/** Why the walk stopped (§2.6). Five, each with a sentence. */
export type FlowTerminal = "endpoint" | "leaf" | "package" | "bound" | "cycle";

/**
 * The two places — and the only two — where `contains` is read backwards.
 *
 * `neighbourhood.ts` rule 1 is that a walk never changes direction, because
 * otherwise A and C look connected merely for both touching B. These are two
 * named exceptions to that rule, not a general permission, and both are
 * narrated as the structural facts they are: "이 주소는 이 파일이 맡고 있어요",
 * never "이 주소가 이걸 불러요".
 */
export type FlowJoint = "entry" | "server";

/** Who wrote a hop's sentence. Phase 0 only ever writes `measured`. */
export type FlowNarrator = "measured" | "purpose" | "model";

export type FlowRefusal =
  | "no-entry-point"
  | "no-behaviour"
  | "nothing-leaves"
  | "not-a-start"
  | "unknown-start";

export type FlowHop = {
  /** 1-based, and what gets drawn on the line. */
  index: number;
  fromId: string;
  toId: string;
  /**
   * `contains` on a joint hop, and that is the only place it appears.
   *
   * A joint hop is not one edge: it is `route → (its file) → symbol`, two
   * `contains` edges read in opposite directions with the file collapsed out.
   * So there is no connection in the graph whose ends are this hop's ends —
   * which is why the map must draw a joint hop with `connected: false` and
   * `scene.ts`'s `stepFor` must not match it to a line. Drawing one would
   * invent an edge the graph does not have.
   */
  relation: ConnectionRelation;
  /** This hop alone. The map draws each line on its own merits. */
  certainty: Certainty;
  /**
   * The weakest link from the start up to and including this hop.
   *
   * This is what the user reads. `neighbourhood.ts` rule 2, restated and for
   * the same reason: reporting the last hop, or the first, would launder a
   * guess into a fact at depth 6.
   */
  pathCertainty: Certainty;
  /** Where the call is written, in the FROM end's file. Null on a joint. */
  line: number | null;
  /**
   * Outside tools brought in where this hop lands. Names only.
   *
   * **File-grained, deliberately.** `analyzer.ts` writes `uses_package` from
   * the FILE to the package, never from a symbol, so attributing `stripe` to
   * one symbol in a file that imports it would be a claim we cannot back. Any
   * sentence built from this has to say 파일, and `flowTerminalSentence` does.
   */
  packages: string[];
  /**
   * How many other ways out of `fromId` there were, counted in distinct
   * places rather than in edges — two connections to the same piece is one
   * other way to go, as a person reads it.
   *
   * Said out loud at every hop. One path out of many, presented alone, is a
   * claim that it is the only one.
   */
  branches: number;
  joint: FlowJoint | null;
  narrator: FlowNarrator;
  /** The measured sentence. Short enough for a row; §7's long forms are notes. */
  text: string;
};

export type FlowPath = {
  hops: readonly FlowHop[];
  terminal: FlowTerminal;
  /**
   * Whether the path ever touched a server address, which is a different
   * question from where it stopped: a path that crossed to `/api/orders` and
   * then dead-ended inside the handler reached the server, and ranks above one
   * that merely dead-ended (§2.4).
   */
  reachedEndpoint: boolean;
  /** The weakest link on the whole path. */
  weakest: Certainty;
  /** The last item. Equal to `startId` only on an empty path. */
  endId: string;
  /** The terminal's sentence, already written. */
  text: string;
};

/** Which criterion separated the top path from the runner-up (§8.4). */
export type PathCriterion =
  | "endpoint"
  | "terminal"
  | "length"
  | "certainty"
  | "steps"
  | "id";

export type FlowMargin = {
  /** Null when there was no second path to compare against. */
  criterion: PathCriterion | null;
  /** The numeric gap at that criterion, where there is one. */
  gap: number | null;
  /** Complete paths the beam finished. Never the number of paths that exist. */
  found: number;
  /**
   * True when the top path is not clearly ahead of the second, which is when
   * the panel says "이 길 말고도 비슷하게 그럴듯한 길이 N개 더 있어요".
   *
   * The rule is measured rather than chosen (§8.4): the three things a reader
   * can actually perceive about a path — where it ends, how long it is, and
   * how sure we are of it — all tied, and only a hop-level tiebreak separated
   * them. There is no threshold constant here on purpose. A lexicographic
   * ranking has no scalar score to threshold, which is most of the reason it
   * was chosen over a weighted sum.
   */
  close: boolean;
};

/** A §7 sentence that is about the flow rather than about one hop's verb. */
export type FlowNoteKind = "guessed-address" | "certainty" | "alternatives";

export type FlowNote = {
  kind: FlowNoteKind;
  /** The hop this is about, 1-based. Null when it is about the whole flow. */
  hop: number | null;
  text: string;
};

// ---------------------------------------------------------------------------
// Events (§5)
// ---------------------------------------------------------------------------

/**
 * The same `{ seq, type, payload }` shape as `analysis/events.ts` and
 * `qa/types.ts`, so the existing SSE machinery can carry these without a
 * second format.
 *
 * **No source, ever.** A hop carries ids, a line number and one short
 * sentence. Same rule both existing event modules state, for the same reason:
 * a trace that carried the code it walked would be larger than the answer and
 * would put somebody's source into a log we promised not to keep.
 */
export type FlowEventType =
  | "flow.started"
  | "flow.hop"
  | "flow.narrated"
  | "flow.ended"
  | "flow.refused";

export type FlowEventPayloads = {
  "flow.started": {
    startId: string;
    startName: string;
    startKind: ItemKind;
    spine: FlowSpine;
    maxHops: number;
  };
  "flow.hop": {
    index: number;
    fromId: string;
    toId: string;
    relation: ConnectionRelation;
    /** This hop alone. */
    certainty: Certainty;
    /** Weakest so far — what the user reads. */
    pathCertainty: Certainty;
    /** Call-site line, when we have one. */
    line: number | null;
    /** Outside tools at this hop. Names only, file-grained. */
    packages: string[];
    /** How many other ways out of here. */
    branches: number;
    joint: FlowJoint | null;
    /**
     * Who wrote `text`.
     *
     * On the wire because the UI has to be able to say so, exactly as
     * `Description.fromModel` already does. A model's sentence and an
     * arithmetic one look alike and must not read alike.
     */
    narrator: FlowNarrator;
    text: string;
  };
  /**
   * A hop's sentence, replaced by a better one.
   *
   * Declared and never emitted in Phase 0: Layer 2 (`purpose/groups.ts`) and
   * Layer 3 (`investigate()`) are what produce these, and neither is wired.
   * It is in the type now so the UI can be built against the final shape
   * rather than against a shape that grows under it.
   */
  "flow.narrated": { index: number; text: string; narrator: "purpose" | "model" };
  "flow.ended": {
    reason: FlowTerminal;
    hops: number;
    weakest: Certainty;
    alternatives: number;
  };
  "flow.refused": { reason: FlowRefusal };
};

export type FlowEvent<T extends FlowEventType = FlowEventType> = {
  seq: number;
  type: T;
  payload: FlowEventPayloads[T];
};

/**
 * A live listener. Optional everywhere, exactly as `QaEventSink` is: the trace
 * comes back in full whether or not anyone is watching, so a caller that only
 * wants the path does not have to collect events to get one.
 *
 * The walk is microseconds and the whole path is known before hop 1 is drawn,
 * so the default is synchronous. A paced reveal is the UI's business, and it
 * is an animation of a computed answer — which is why the copy never calls it
 * 실시간.
 */
export type FlowEventSink = <T extends FlowEventType>(
  type: T,
  payload: FlowEventPayloads[T],
) => void;

// ---------------------------------------------------------------------------
// Entry points (§2.3)
// ---------------------------------------------------------------------------

export type EntryPoints = {
  /** What the user actually selected. Null when the id is not on the map. */
  item: GraphItem | null;
  /** Where a walk may begin, best first. Empty when `refusal` is set. */
  starts: GraphItem[];
  refusal: FlowRefusal | null;
};

/**
 * Every place in the project a flow can start from, unprompted.
 *
 * Routes and endpoints only. They exist in every run of the deep analyzer,
 * need no model, and a route is the one item kind in the graph a
 * non-developer already understands as a place — `/checkout`, `/login`.
 *
 * Considered and deferred: items with `usedBy === 0` as probable entry points.
 * Attractive on a repo with no routes, and wrong in a way we could not detect
 * — `usedBy === 0` also means "we failed to resolve the thing that uses it",
 * and `describe.ts` is explicit that we may not turn that into a verdict.
 */
export function projectEntryPoints(graph: FlowGraph): GraphItem[] {
  return graph.items
    .filter((item) => item.kind === "route" || item.kind === "api_endpoint")
    .sort(
      (a, b) =>
        kindRank(a.kind) - kindRank(b.kind) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.id < b.id ? -1 : 1),
    );
}

function kindRank(kind: ItemKind): number {
  // A page a person can visit before an address only a machine calls.
  return kind === "route" ? 0 : 1;
}

/**
 * What the user selected, turned into somewhere a walk can begin.
 *
 * A route or an endpoint is itself — the joint that gets it moving is inside
 * the walk, because the joint is a hop the user reads rather than a detail of
 * resolution. A symbol is itself. A file offers the symbols it holds, most
 * outgoing behaviour first, because a file is not a place in a flow: the code
 * that reaches for other code lives in the pieces. A package or a feature is
 * refused, for two different reasons that both come out as one sentence.
 */
export function entryPointsOf(graph: FlowGraph, itemId: string): EntryPoints {
  const index = indexFlowGraph(graph);
  return entryPointsIn(index, itemId);
}

function entryPointsIn(index: FlowIndex, itemId: string): EntryPoints {
  const item = index.itemsById.get(itemId) ?? null;
  if (!item) return { item: null, starts: [], refusal: "unknown-start" };

  switch (item.kind) {
    case "route":
    case "api_endpoint":
    case "symbol":
      return { item, starts: [item], refusal: null };
    case "file": {
      const symbols = index.symbolsOf.get(item.id) ?? [];
      const ranked = [...symbols].sort(
        (a, b) =>
          outDegree(index, b.id) - outDegree(index, a.id) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
          (a.id < b.id ? -1 : 1),
      );
      return { item, starts: ranked, refusal: ranked.length > 0 ? null : "nothing-leaves" };
    }
    // A package is somebody else's code we never read, and a feature is a
    // grouping we made rather than something the code does — `purpose/groups.ts`
    // draws that same line for the same reason.
    case "package":
    case "feature":
      return { item, starts: [], refusal: "not-a-start" };
    default:
      return { item, starts: [], refusal: "not-a-start" };
  }
}

function outDegree(index: FlowIndex, id: string): number {
  return (index.out.get(id) ?? []).length;
}

// ---------------------------------------------------------------------------
// The index, computed once per graph
// ---------------------------------------------------------------------------

export type FlowIndex = {
  itemsById: ReadonlyMap<string, GraphItem>;
  /** Behaviour connections out of each item, in a fixed order. */
  out: ReadonlyMap<string, readonly GraphConnection[]>;
  /** The file an item is written in, via `contains`. */
  fileOf: ReadonlyMap<string, GraphItem>;
  /** The symbols a file holds, sorted. */
  symbolsOf: ReadonlyMap<string, readonly GraphItem[]>;
  /** The outside tools a file brings in, sorted by name. */
  packagesOf: ReadonlyMap<string, readonly string[]>;
  /**
   * Hops from each item to the nearest `api_endpoint`, over behaviour edges.
   *
   * One reverse BFS from every endpoint at once, `O(V+E)`, computed here
   * rather than inside the walk because the walk asks for it once per
   * candidate hop. This is the criterion that turns wandering into a story:
   * "주문이 어떻게 되나요" means "where does it leave the screen", and without
   * it the walk has no reason to prefer the branch that gets there.
   *
   * Absent means no endpoint is reachable. Read through `distanceOf`.
   */
  distanceToEndpoint: ReadonlyMap<string, number>;
  /** How many `renders`/`calls`/`fetches` the graph carries at all. */
  behaviourEdges: number;
  /** How many `imports`. Only ever used to say "all N of them are imports". */
  importEdges: number;
  entryPoints: readonly GraphItem[];
};

const NO_DISTANCE = Number.POSITIVE_INFINITY;

function distanceOf(index: FlowIndex, id: string): number {
  return index.distanceToEndpoint.get(id) ?? NO_DISTANCE;
}

/**
 * Everything the walk needs to know about a graph, worked out once.
 *
 * Exported because `traceFlow` is called once per entry point when the panel
 * lists flows, and rebuilding this per call would make listing the project's
 * flows quadratic in the graph. Pass it back in through `TraceFlowInput.index`.
 */
export function indexFlowGraph(graph: FlowGraph): FlowIndex {
  const itemsById = new Map<string, GraphItem>();
  for (const item of graph.items) itemsById.set(item.id, item);

  const out = new Map<string, GraphConnection[]>();
  const incoming = new Map<string, GraphConnection[]>();
  const fileOf = new Map<string, GraphItem>();
  /**
   * The pieces of a file where something actually happens — **type
   * declarations excluded**, which is not a tidiness rule.
   *
   * Measured on this repository's own graph. `/app/:projectId` ranked six
   * complete paths and the winner was `ProjectPageProps`, one hop, terminal
   * `package` — a prop type. It beat
   * `ProjectPage → Workspace → HistoryBand → RereadButton → RefreshMark` on
   * the `length` criterion with a gap of 2, because neither path reaches a
   * server, so `endpoint` and `terminal` both tie and shortest wins.
   *
   * The ranking was working exactly as written. The defect is upstream of it:
   * a `type` has no runtime behaviour at all — it cannot call, render or
   * fetch — so it can never be anything but a one-hop dead end, and offering
   * it as a joint target spends the start of a flow on a declaration. It is
   * the same line `belongs_to` and `contains` are already on: structure is
   * not something the code does.
   *
   * Filtered here rather than at the two call sites because `entryPointsIn`
   * and `jointTargets` both ask this map the same question, and a rule that
   * has to be remembered twice is a rule that will one day be applied once.
   */
  const symbolsOf = new Map<string, GraphItem[]>();
  const packagesOf = new Map<string, string[]>();
  let behaviourEdges = 0;
  let importEdges = 0;

  for (const connection of graph.connections) {
    const from = itemsById.get(connection.from);
    const to = itemsById.get(connection.to);
    // A connection to something not on the map cannot be walked or named, and
    // a hop onto a blank row is worse than no hop.
    if (!from || !to) continue;

    if (connection.relation === "imports") {
      importEdges += 1;
      continue;
    }

    if (connection.relation === "contains") {
      if (from.kind !== "file") continue;
      fileOf.set(to.id, from);
      if (to.kind === "symbol" && to.shape !== "type") push(symbolsOf, from.id, to);
      continue;
    }

    if (connection.relation === "uses_package") {
      push(packagesOf, from.id, to.name);
      continue;
    }

    if (!HOP_RELATIONS.has(connection.relation)) continue;
    // A self-loop is not a hop; it is a recursive function, and a path that
    // stepped onto it would be standing where it already stands.
    if (connection.from === connection.to) continue;

    behaviourEdges += 1;
    push(out, connection.from, connection);
    push(incoming, connection.to, connection);
  }

  for (const [, list] of out) list.sort(compareConnections);
  for (const [, list] of symbolsOf) {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  }
  for (const [key, list] of packagesOf) {
    packagesOf.set(key, [...new Set(list)].sort());
  }

  return {
    itemsById,
    out,
    fileOf,
    symbolsOf,
    packagesOf,
    distanceToEndpoint: reverseBfsFromEndpoints(graph.items, incoming),
    behaviourEdges,
    importEdges,
    entryPoints: projectEntryPoints(graph),
  };
}

/** One BFS from every server address at once, over behaviour edges reversed. */
function reverseBfsFromEndpoints(
  items: readonly GraphItem[],
  incoming: ReadonlyMap<string, readonly GraphConnection[]>,
): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier: string[] = [];

  for (const item of items) {
    if (item.kind !== "api_endpoint") continue;
    distance.set(item.id, 0);
    frontier.push(item.id);
  }

  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const id of frontier) {
      for (const connection of incoming.get(id) ?? []) {
        if (distance.has(connection.from)) continue;
        distance.set(connection.from, depth);
        next.push(connection.from);
      }
    }
    frontier = next;
  }

  return distance;
}

/**
 * A total order over connections out of one item.
 *
 * Only so the candidate list is the same array on two runs before anything
 * ranks it. The ranking itself is `compareHopKeys`.
 */
function compareConnections(a: GraphConnection, b: GraphConnection): number {
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  if (a.relation !== b.relation) return RELATION_RANK[a.relation] - RELATION_RANK[b.relation];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------
// Ranking (§2.4) — lexicographic, never a weighted sum
// ---------------------------------------------------------------------------

/**
 * The five criteria a candidate hop is ranked by, in order. Lower wins.
 *
 * **Lexicographic, and that is a decision with teeth.** A weighted sum is
 * where arbitrary constants hide — and worse, where a failing test cannot tell
 * you which criterion fired, because every criterion fired a little. Here the
 * comparison reports the criterion that decided, and `flow.test.ts` asserts
 * on it by name.
 *
 *   1. `certainty`  — `certain` before `inferred`. A guess is never preferred
 *                     to something the compiler resolved.
 *   2. `distance`   — does this hop get closer to a server address.
 *   3. `relation`   — `RELATION_RANK` from `view.ts`, NOT a second ranking of
 *                     our own. `fetches` (0) then `renders` (1) then `calls`
 *                     (3): the crossing to the server, then what the screen
 *                     draws, then the machinery. Two rankings for one idea is
 *                     the D69 failure.
 *   4. `usedBy`     — lower first. A helper used in twelve places is shared
 *                     machinery; a function used in one is this feature's
 *                     spine. Free, because `load.ts` already counts it under
 *                     D69's rule. Plausible and, at the time of writing,
 *                     untested on anything larger than 68 items.
 *   5. `id`         — so two runs produce a byte-identical path.
 */
export type HopCriterion = "certainty" | "distance" | "relation" | "usedBy" | "id";

export const HOP_CRITERIA: readonly HopCriterion[] = [
  "certainty",
  "distance",
  "relation",
  "usedBy",
  "id",
];

/**
 * One candidate hop's place in each of the five criteria.
 *
 * A record rather than a tuple so the comparison can name the criterion that
 * decided. That name is the point: a test asserts "the distance criterion
 * chose this hop", which is a thing a weighted sum could never be asked.
 */
type HopKey = {
  certainty: number;
  distance: number;
  relation: number;
  usedBy: number;
  id: string;
};

function compareHopKeys(
  a: HopKey,
  b: HopKey,
  ignore: ReadonlySet<HopCriterion>,
): { order: number; criterion: HopCriterion | null } {
  for (const criterion of HOP_CRITERIA) {
    if (ignore.has(criterion)) continue;
    if (criterion === "id") {
      if (a.id !== b.id) return { order: a.id < b.id ? -1 : 1, criterion };
      continue;
    }
    const left = a[criterion];
    const right = b[criterion];
    if (left === right) continue;
    // Compared rather than subtracted: `distance` can be Infinity at both
    // ends, and `Infinity - Infinity` is NaN, which makes a comparator return
    // a different array order on a different engine — a determinism bug that
    // only ever shows up in somebody else's screenshot.
    return { order: left < right ? -1 : 1, criterion };
  }
  return { order: 0, criterion: null };
}

function compareHopKeySequences(
  a: readonly HopKey[],
  b: readonly HopKey[],
  ignore: ReadonlySet<HopCriterion>,
): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const { order } = compareHopKeys(a[i], b[i], ignore);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/**
 * Where a terminal ranks when two complete paths are compared.
 *
 * A three-hop path to the server beats a nine-hop one that wandered through
 * utilities to get there, and a six-hop path that reaches the server beats a
 * one-hop path that dead-ended — which is why the terminal is compared before
 * the length rather than after it.
 */
const TERMINAL_RANK: Record<FlowTerminal, number> = {
  endpoint: 0,
  leaf: 1,
  package: 2,
  bound: 3,
  cycle: 4,
};

/**
 * The order two complete paths are compared in. Exported so a panel that
 * shows why one path won can name the criterion rather than restate the list.
 */
export const PATH_CRITERIA: readonly PathCriterion[] = [
  "endpoint",
  "terminal",
  "length",
  "certainty",
  "steps",
  "id",
];

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export type TraceFlowInput = {
  /** What the user selected. A route, an endpoint, a symbol or a file. */
  startId: string;
  /** Built once per graph by `indexFlowGraph`, when a caller has one. */
  index?: FlowIndex;
  /** A live listener. The trace comes back in full either way. */
  onEvent?: FlowEventSink;
  /**
   * Criteria to leave OUT of the hop ranking.
   *
   * This exists to be measured, not to be configured. §8.3 requires the
   * endpoint arrival rate with and without `distance`, on the stated
   * understanding that a criterion which does not move a number is decoration
   * and comes out. Production callers pass nothing.
   */
  ignore?: readonly HopCriterion[];
};

export type FlowTrace = {
  /** What the user selected, which is not always where the walk began. */
  selected: { id: string; name: string; kind: ItemKind } | null;
  /** Where the walk actually began. */
  start: { id: string; name: string; kind: ItemKind } | null;
  /**
   * Other places the selection could have started from, best first.
   *
   * Non-empty only for a file, which holds several pieces and is not itself a
   * place in a flow. The panel offers these; it does not pick silently.
   */
  otherStarts: GraphItem[];
  spine: FlowSpine;
  path: FlowPath | null;
  /** Runner-ups, at most `BRANCHES_SHOWN`. `margin.found` is the total. */
  alternatives: FlowPath[];
  margin: FlowMargin;
  refusal: FlowRefusal | null;
  /** §7's longer sentences, already written. */
  notes: FlowNote[];
  events: FlowEvent[];
  /** Candidate hops considered. For §8.6, and for nothing a user sees. */
  expansions: number;
};

/** One partial path in the beam. */
type Partial = {
  hops: FlowHop[];
  keys: HopKey[];
  visited: Set<string>;
  endId: string;
  weakest: Certainty;
  reachedEndpoint: boolean;
  /** Set once the server joint has been taken, so it is taken exactly once. */
  serverJoint: boolean;
};

/**
 * The flow from one place, as a path and as a sequence of events.
 *
 * Synchronous, and deliberately: the walk is microseconds and the whole path
 * is known before hop 1 is drawn, so there is nothing to stream. `onEvent`
 * fires as the trace is built, for a caller that wants to pace the reveal.
 */
export function traceFlow(graph: FlowGraph, input: TraceFlowInput): FlowTrace {
  const index = input.index ?? indexFlowGraph(graph);
  const ignore = new Set<HopCriterion>(input.ignore ?? []);

  const events: FlowEvent[] = [];
  let seq = 0;
  const emit: FlowEventSink = (type, payload) => {
    seq += 1;
    events.push({ seq, type, payload } as FlowEvent);
    input.onEvent?.(type, payload);
  };

  const empty = (
    refusal: FlowRefusal,
    selected: GraphItem | null,
  ): FlowTrace => {
    emit("flow.refused", { reason: refusal });
    return {
      selected: selected ? stamp(selected) : null,
      start: null,
      otherStarts: [],
      spine: "selection",
      path: null,
      alternatives: [],
      margin: { criterion: null, gap: null, found: 0, close: false },
      refusal,
      notes: [],
      events,
      expansions: 0,
    };
  };

  const resolved = entryPointsIn(index, input.startId);
  if (!resolved.item) return empty("unknown-start", null);
  if (resolved.refusal) return empty(resolved.refusal, resolved.item);

  /*
   * The shallow analyzer produces only `imports` and `uses_package`, so a
   * project it analysed has no flows at all. That is a refusal with a sentence
   * (§7), not a degraded flow wearing the same name — D68 is the precedent: a
   * feature that half works must say which half.
   */
  if (index.behaviourEdges === 0 && index.importEdges > 0) {
    return empty("no-behaviour", resolved.item);
  }

  const [start, ...otherStarts] = resolved.starts;
  const spine: FlowSpine =
    start.kind === "route" || start.kind === "api_endpoint" ? "route" : "selection";

  emit("flow.started", {
    startId: start.id,
    startName: start.name,
    startKind: start.kind,
    spine,
    maxHops: MAX_FLOW_HOPS,
  });

  const walk = runBeam(index, start, ignore);

  if (walk.ranked.length === 0) {
    // Nothing left the start at all. Never 아무것도 안 해요 — this is
    // `describe.ts`'s 쓰는 곳을 아직 못 찾았어요 rule, said forward.
    emit("flow.refused", { reason: "nothing-leaves" });
    return {
      selected: stamp(resolved.item),
      start: stamp(start),
      otherStarts,
      spine,
      path: null,
      alternatives: [],
      margin: { criterion: null, gap: null, found: 0, close: false },
      refusal: "nothing-leaves",
      notes: [],
      events,
      expansions: walk.expansions,
    };
  }

  const best = walk.ranked[0].path;
  const rest = walk.ranked.slice(1).map((entry) => entry.path);
  const margin = marginBetween(walk.ranked, ignore);

  for (const hop of best.hops) {
    emit("flow.hop", {
      index: hop.index,
      fromId: hop.fromId,
      toId: hop.toId,
      relation: hop.relation,
      certainty: hop.certainty,
      pathCertainty: hop.pathCertainty,
      line: hop.line,
      packages: hop.packages,
      branches: hop.branches,
      joint: hop.joint,
      narrator: hop.narrator,
      text: hop.text,
    });
  }

  const alternatives = rest.slice(0, BRANCHES_SHOWN);

  emit("flow.ended", {
    reason: best.terminal,
    hops: best.hops.length,
    weakest: best.weakest,
    alternatives: rest.length,
  });

  return {
    selected: stamp(resolved.item),
    start: stamp(start),
    otherStarts,
    spine,
    path: best,
    alternatives,
    margin,
    refusal: null,
    notes: notesFor(index, best, margin, rest.length),
    events,
    expansions: walk.expansions,
  };
}

function stamp(item: GraphItem): { id: string; name: string; kind: ItemKind } {
  return { id: item.id, name: item.name, kind: item.kind };
}

/**
 * Bounded beam search.
 *
 * Keep the best `BEAM` partial paths at each depth, expand each by its
 * outgoing behaviour edges, stop at `MAX_FLOW_HOPS` or when the expansion
 * budget runs out. Cost is `O(BEAM × MAX_FLOW_HOPS × max out-degree)`, bounded
 * above by a constant — which is the whole reason this shape was chosen over
 * enumerating paths, of which there are thousands.
 */
function runBeam(
  index: FlowIndex,
  start: GraphItem,
  ignore: ReadonlySet<HopCriterion>,
): { ranked: Ranked[]; expansions: number } {
  const budget = { spent: 0, out: false };
  const complete: Partial[] = [];

  let frontier = seedFrom(index, start, budget);

  while (frontier.length > 0 && !budget.out) {
    const next: Partial[] = [];

    for (const partial of frontier) {
      if (partial.hops.length >= MAX_FLOW_HOPS) {
        complete.push(partial);
        continue;
      }
      if (budget.out) {
        complete.push(partial);
        continue;
      }

      const grown = expand(index, partial, budget);
      if (grown.length === 0) {
        complete.push(partial);
        continue;
      }
      next.push(...grown);
    }

    next.sort((a, b) => compareHopKeySequences(a.keys, b.keys, ignore) || tieOn(a, b));
    // The ones the beam cuts are dropped rather than completed. That is what a
    // beam is: four live guesses, not a record of everywhere we looked.
    frontier = next.slice(0, BEAM);
    if (budget.out) {
      complete.push(...frontier);
      frontier = [];
    }
  }

  complete.push(...frontier);

  const ranked = complete
    // A partial with no hops is the start standing still. It is not a path,
    // and returning one would answer "where does this go" with "here".
    .filter((partial) => partial.hops.length > 0)
    .map((partial) => ({ path: finish(index, partial, budget), keys: partial.keys }))
    .sort((a, b) => comparePaths(a, b, ignore).order);

  return { ranked, expansions: budget.spent };
}

/**
 * A finished path with the ranking keys that produced it.
 *
 * The keys stay on this side of the boundary. A `FlowPath` crosses to the UI
 * and to an event payload, and a ranking key is neither something the UI can
 * draw nor something a user could check.
 */
type Ranked = { path: FlowPath; keys: readonly HopKey[] };

/**
 * The first move, which is where a naive implementation silently returns
 * nothing on a repository that obviously has a flow.
 *
 * A `route` node is a SIBLING of its file's symbols, not their parent:
 * `analyzer.ts` writes `file --contains--> route` and `file --contains-->
 * symbol` side by side, and the route has no outgoing `calls`, `renders` or
 * `fetches` of its own — those hang off the symbols. A forward-only walk from
 * a route therefore reaches nothing, on every project, forever.
 *
 * So the entry joint reverses `contains` once, at the start, and the server
 * joint does the same when the path arrives at an `api_endpoint`. Those two
 * and no others.
 *
 * The file is collapsed out rather than made a path member: the joint is one
 * hop from the address to the piece, and the file's name goes in the sentence
 * — "이 주소는 checkout/page.tsx 가 맡고 있어요" — which is the structural fact
 * stated as one, rather than "이 주소가 이걸 불러요", which would not be true.
 */
function seedFrom(
  index: FlowIndex,
  start: GraphItem,
  budget: { spent: number; out: boolean },
): Partial[] {
  const bare: Partial = {
    hops: [],
    keys: [],
    visited: new Set([start.id]),
    endId: start.id,
    weakest: "certain",
    reachedEndpoint: start.kind === "api_endpoint",
    serverJoint: false,
  };

  if (start.kind !== "route" && start.kind !== "api_endpoint") return [bare];

  const joint = start.kind === "route" ? "entry" : "server";
  const siblings = jointTargets(index, start);
  if (siblings.length === 0) return [];

  const seeds: Partial[] = [];
  for (const symbol of siblings) {
    budget.spent += 1;
    if (budget.spent > MAX_EXPANSIONS) {
      budget.out = true;
      break;
    }
    seeds.push(
      extend(index, bare, {
        to: symbol,
        relation: "contains",
        certainty: "certain",
        line: null,
        // A joint is not a connection, so there is no edge for a purpose to
        // be about. The structural sentence in `hopSentence` is the whole
        // truth of this hop.
        purpose: null,
        joint,
        branches: siblings.length - 1,
      }),
    );
  }
  return seeds;
}

/** The symbols an address's file holds. Empty when we never read that file. */
function jointTargets(index: FlowIndex, address: GraphItem): GraphItem[] {
  const file = index.fileOf.get(address.id);
  if (!file) return [];
  return [...(index.symbolsOf.get(file.id) ?? [])];
}

type Step = {
  to: GraphItem;
  relation: ConnectionRelation;
  certainty: Certainty;
  line: number | null;
  /**
   * Pass 3's sentence for this connection, when it has one.
   *
   * Null at both joints, always: a joint is not a connection, it is the
   * structural fact that a file answers for an address, and there is no edge
   * for a purpose to be about.
   */
  purpose: string | null;
  joint: FlowJoint | null;
  branches: number;
};

function extend(index: FlowIndex, partial: Partial, step: Step): Partial {
  const weakest = weaker(partial.weakest, step.certainty);
  const from = index.itemsById.get(partial.endId);
  const packages = [...(index.packagesOf.get(fileIdOf(index, step.to.id)) ?? [])];

  const hop: FlowHop = {
    index: partial.hops.length + 1,
    fromId: partial.endId,
    toId: step.to.id,
    relation: step.relation,
    certainty: step.certainty,
    pathCertainty: weakest,
    line: step.line,
    packages,
    branches: step.branches,
    joint: step.joint,
    // Who wrote the sentence, on the wire. §5: an arithmetic sentence and a
    // model's sentence look alike and must not read alike, and the panel has
    // to be able to say which it is showing.
    narrator: step.purpose ? "purpose" : "measured",
    text: hopSentence(index, from ?? null, step),
  };

  const key: HopKey = {
    certainty: step.certainty === "certain" ? 0 : 1,
    distance: distanceOf(index, step.to.id),
    relation: RELATION_RANK[step.relation],
    usedBy: step.to.usedBy,
    id: step.to.id,
  };

  const visited = new Set(partial.visited);
  visited.add(step.to.id);

  return {
    hops: [...partial.hops, hop],
    keys: [...partial.keys, key],
    visited,
    endId: step.to.id,
    weakest,
    reachedEndpoint: partial.reachedEndpoint || step.to.kind === "api_endpoint",
    serverJoint: partial.serverJoint || step.joint === "server",
  };
}

/**
 * Every viable continuation of one partial path.
 *
 * A path never visits the same item twice. When the only continuation is back
 * onto the path, this returns nothing and the walk stops — and 돌고 도는 구조 is
 * one of the more useful things the feature says, because it is a real fact
 * about the code that the user can act on.
 */
function expand(
  index: FlowIndex,
  partial: Partial,
  budget: { spent: number; out: boolean },
): Partial[] {
  const here = index.itemsById.get(partial.endId);
  if (!here) return [];

  // The server joint, taken exactly once: the path has arrived at an address,
  // and the pieces that answer it are siblings of it, not children.
  if (here.kind === "api_endpoint" && !partial.serverJoint) {
    const siblings = jointTargets(index, here).filter((item) => !partial.visited.has(item.id));
    const grown: Partial[] = [];
    for (const symbol of siblings) {
      budget.spent += 1;
      if (budget.spent > MAX_EXPANSIONS) {
        budget.out = true;
        break;
      }
      grown.push(
        extend(index, partial, {
          to: symbol,
          relation: "contains",
          certainty: "certain",
          line: null,
          // The server joint, same rule as the entry joint: no edge, so no
          // purpose.
          purpose: null,
          joint: "server",
          branches: siblings.length - 1,
        }),
      );
    }
    return grown;
  }

  const connections = index.out.get(partial.endId) ?? [];
  const places = new Set(connections.map((connection) => connection.to));
  const grown: Partial[] = [];

  for (const connection of connections) {
    budget.spent += 1;
    if (budget.spent > MAX_EXPANSIONS) {
      budget.out = true;
      break;
    }
    if (partial.visited.has(connection.to)) continue;
    const to = index.itemsById.get(connection.to);
    if (!to) continue;

    grown.push(
      extend(index, partial, {
        to,
        relation: connection.relation,
        certainty: connection.certainty,
        line: connection.line ?? null,
        purpose: connection.purpose ?? null,
        joint: null,
        // Counted in places rather than in edges: two connections to the same
        // piece is one other way to go, as a person reads it.
        branches: places.size - 1,
      }),
    );
  }

  return grown;
}

/** Why this path stopped, and the sentence for it. */
function finish(
  index: FlowIndex,
  partial: Partial,
  budget: { spent: number; out: boolean },
): FlowPath {
  const here = index.itemsById.get(partial.endId);
  const terminal = terminalFor(index, partial, budget);
  return {
    hops: partial.hops,
    terminal,
    reachedEndpoint: partial.reachedEndpoint,
    weakest: partial.weakest,
    endId: partial.endId,
    text: flowTerminalSentence(terminal, {
      hops: partial.hops.length,
      address: here?.kind === "api_endpoint" ? here.name : null,
      back: cycleTargetName(index, partial),
      file: fileNameOf(index, partial.endId),
      pkg: (index.packagesOf.get(fileIdOf(index, partial.endId)) ?? [])[0] ?? null,
    }),
  };
}

function terminalFor(
  index: FlowIndex,
  partial: Partial,
  budget: { spent: number; out: boolean },
): FlowTerminal {
  const here = index.itemsById.get(partial.endId);

  // Arrived at a server address and has not yet gone through it. The clearest
  // terminal the feature has, and the one the founder's question is about.
  if (here?.kind === "api_endpoint" && !partial.serverJoint) {
    // It only reads as an arrival if there was in fact nowhere further to go
    // through the joint; otherwise the bound or the budget stopped us.
    if (partial.hops.length >= MAX_FLOW_HOPS || budget.out) return "bound";
    return "endpoint";
  }

  if (partial.hops.length >= MAX_FLOW_HOPS || budget.out) return "bound";

  const onward = index.out.get(partial.endId) ?? [];
  if (onward.length === 0) {
    // Nothing leaves this piece at all. If the file it lives in brings in an
    // outside tool, that is very often where the work went — said at file
    // grain, because `uses_package` is a fact about the file.
    const packages = index.packagesOf.get(fileIdOf(index, partial.endId)) ?? [];
    return packages.length > 0 ? "package" : "leaf";
  }

  // Everything onward is somewhere we have already been.
  return "cycle";
}

function cycleTargetName(index: FlowIndex, partial: Partial): string | null {
  for (const connection of index.out.get(partial.endId) ?? []) {
    if (!partial.visited.has(connection.to)) continue;
    return index.itemsById.get(connection.to)?.name ?? null;
  }
  return null;
}

/**
 * Which of two complete paths is the flow.
 *
 * Six criteria, in order, and the comparison reports which one decided. The
 * first is not the terminal but whether the path reached the server at all: a
 * path that crossed to `/api/orders` and dead-ended inside the handler
 * answered "where does the order go", and one that merely dead-ended in a
 * formatter did not (§2.4).
 */
function comparePaths(
  a: Ranked,
  b: Ranked,
  ignore: ReadonlySet<HopCriterion>,
): { order: number; criterion: PathCriterion | null; gap: number | null } {
  if (a.path.reachedEndpoint !== b.path.reachedEndpoint) {
    return { order: a.path.reachedEndpoint ? -1 : 1, criterion: "endpoint", gap: 1 };
  }
  const terminal = TERMINAL_RANK[a.path.terminal] - TERMINAL_RANK[b.path.terminal];
  if (terminal !== 0) {
    return { order: terminal, criterion: "terminal", gap: Math.abs(terminal) };
  }
  /*
   * Shorter wins **only when the path got somewhere**. Otherwise longer does.
   *
   * §2.4 argued length ascending with one example — "a three-hop path to the
   * server beats a nine-hop one that wandered through utilities to get there"
   * — and that example is about *wandering on the way to a destination*. It
   * says nothing about two paths that both simply stop, and applied to them
   * it selects for the least informative answer the walk can give.
   *
   * Measured twice on this repository's own graph, and it is not a corner
   * case. At 1,495 items `/app/:projectId` opened on `ProjectPageProps` — a
   * prop type — at one hop. Excluding type declarations fixed that instance
   * and not the rule, so at 1,821 items it opened on `generateMetadata`,
   * which is a real function that calls nothing, beating
   * `ProjectPage → Workspace → GroupingControl` by the same criterion with
   * the same gap. The shortest thing a file holds is always the thing that
   * does least, so "shortest wins" will keep finding a new one of them.
   *
   * `endpoint` and `terminal` have already had their say by this point, so
   * both paths here stopped the same way; between two that both stop, the one
   * that walked further is the one that showed more of the code. `MAX_FLOW_HOPS`
   * bounds it, and a path that ran out of hops is ranked below one that ended
   * on its own by `terminal`, so this cannot become a preference for rambling.
   */
  const length = a.path.reachedEndpoint
    ? a.path.hops.length - b.path.hops.length
    : b.path.hops.length - a.path.hops.length;
  if (length !== 0) return { order: length, criterion: "length", gap: Math.abs(length) };

  if (a.path.weakest !== b.path.weakest) {
    return { order: a.path.weakest === "certain" ? -1 : 1, criterion: "certainty", gap: 1 };
  }

  const steps = compareHopKeySequences(a.keys, b.keys, ignore);
  if (steps !== 0) return { order: steps, criterion: "steps", gap: null };

  const left = trailOf(a.path);
  const right = trailOf(b.path);
  if (left === right) return { order: 0, criterion: null, gap: null };
  return { order: left < right ? -1 : 1, criterion: "id", gap: null };
}

function trailOf(path: FlowPath): string {
  return path.hops.map((hop) => hop.toId).join(">");
}

function tieOn(a: Partial, b: Partial): number {
  const left = a.hops.map((hop) => hop.toId).join(">");
  const right = b.hops.map((hop) => hop.toId).join(">");
  return left === right ? 0 : left < right ? -1 : 1;
}

function marginBetween(ranked: readonly Ranked[], ignore: ReadonlySet<HopCriterion>): FlowMargin {
  if (ranked.length < 2) {
    return { criterion: null, gap: null, found: ranked.length, close: false };
  }
  const { criterion, gap } = comparePaths(ranked[0], ranked[1], ignore);
  return {
    criterion,
    gap,
    found: ranked.length,
    // Measured, not chosen: the top two agreed on where they end, how long
    // they are and how sure we are of them, and only a hop-level tiebreak
    // separated them. See `FlowMargin.close`.
    close: criterion === "steps" || criterion === "id" || criterion === null,
  };
}

export function notesFor(
  index: FlowIndex,
  path: FlowPath,
  margin: FlowMargin,
  others: number,
): FlowNote[] {
  const notes: FlowNote[] = [];

  for (const hop of path.hops) {
    if (hop.relation !== "fetches" || hop.certainty !== "inferred") continue;
    const address = index.itemsById.get(hop.toId)?.name ?? null;
    if (!address) continue;
    notes.push({ kind: "guessed-address", hop: hop.index, text: guessedAddressNote(address) });
  }

  const guessed = path.hops.filter((hop) => hop.certainty === "inferred").length;
  if (guessed > 0) {
    notes.push({ kind: "certainty", hop: null, text: certaintyNote(path.hops.length, guessed) });
  }

  if (others > 0 && margin.close) {
    notes.push({ kind: "alternatives", hop: null, text: alternativesNote(others) });
  }

  return notes;
}

function weaker(a: Certainty, b: Certainty): Certainty {
  return a === "inferred" || b === "inferred" ? "inferred" : "certain";
}

function fileIdOf(index: FlowIndex, itemId: string): string {
  const item = index.itemsById.get(itemId);
  if (item?.kind === "file") return item.id;
  return index.fileOf.get(itemId)?.id ?? itemId;
}

function filePathOf(index: FlowIndex, itemId: string): string | null {
  const item = index.itemsById.get(itemId);
  const file = item?.kind === "file" ? item : index.fileOf.get(itemId);
  return file ? (file.path ?? file.name) : null;
}

/** For a call site, on a row that has to stay one line: `PayButton.tsx`. */
function fileNameOf(index: FlowIndex, itemId: string): string | null {
  const path = filePathOf(index, itemId);
  return path === null ? null : lastSegments(path, 1);
}

/**
 * For a joint, where the file is named as the owner of an address:
 * `checkout/page.tsx`.
 *
 * Two segments rather than one, because in an App Router project EVERY route's
 * file is called `page.tsx`. "이 주소는 page.tsx 가 맡고 있어요" names a file the
 * user cannot find, in the one sentence whose whole job is to say where an
 * address lives.
 */
function ownerNameOf(index: FlowIndex, itemId: string): string | null {
  const path = filePathOf(index, itemId);
  return path === null ? null : lastSegments(path, 2);
}

function lastSegments(path: string, count: number): string {
  const parts = path.split("/");
  return parts.slice(Math.max(0, parts.length - count)).join("/");
}

// ---------------------------------------------------------------------------
// The words (§7)
// ---------------------------------------------------------------------------

/**
 * The one sentence the panel says before anything else.
 *
 * It is the only string in this module allowed to contain 실행, and the reason
 * is that it is a DENIAL of the thing the word names. A rule that banned the
 * word from the sentence that says we do not do it would have banned the
 * honesty rather than the claim. `flowSentenceIssues` is applied to flow
 * sentences — hops, terminals, refusals, notes — and not to this.
 */
export const FLOW_NOTICE =
  "앱을 실행해 보는 게 아니에요. 코드를 읽어서, 어느 자리가 어느 자리를 부르는지 적어 둔 것뿐이에요. " +
  "그래서 여기서 보여드리는 건 실제로 지나간 길이 아니라, 코드가 이어 놓은 길이에요.";

/**
 * Phase 3's sentence, for when no model is configured.
 *
 * Kept here rather than in the panel so the flow's vocabulary test covers it,
 * and so the sentence exists before the layer that needs it does.
 */
export const FLOW_NO_MODEL_NOTE =
  "지금은 각 자리가 무슨 일을 하는지까지는 못 풀어 드려요. 대신 어디서 어디로 가는지는 그대로 보여드려요.";

/**
 * The forbidden vocabulary, extended for this feature.
 *
 * `FORBIDDEN_WORDS` is imported rather than restated: 안전 because we walked a
 * graph and do not know what is safe to change, 노드 and 엣지 because
 * `view.ts` stops those words at its boundary. Three copies of that list
 * already exist in this codebase (`qa/answer.ts`, `lib/context/digest.ts`,
 * `analysis/python/llm.ts`) and a fourth would be the same drift by another
 * name.
 *
 * 실행 · 추적 · 실시간 are this feature's own. The founder wrote 실시간으로
 * 트래킹, and that phrase has two readings: live narration of a static walk,
 * which is true, and runtime tracing, which we do not do and are not building.
 * An arrow sliding along a line under the word 추적 would be D68's failure with
 * animation on top.
 */
export const FLOW_FORBIDDEN_WORDS: readonly string[] = [
  ...FORBIDDEN_WORDS,
  "실행",
  "추적",
  "실시간",
];

/** Which forbidden words a flow sentence contains. Empty is the only pass. */
export function flowSentenceIssues(text: string): string[] {
  return FLOW_FORBIDDEN_WORDS.filter((word) => text.includes(word));
}

/**
 * 한 · 두 · 세 · 네, not 1 · 2 · 3 · 4.
 *
 * "네 걸음 중에 한 군데는 짐작이에요" is how a person counts steps in Korean,
 * and the attributive native forms are the ones that go in front of a counter.
 * Bounded at twelve because `MAX_FLOW_HOPS` is, and anything past the table
 * falls back to the digit rather than inventing a form.
 */
const NATIVE_NUMERALS = [
  "",
  "한",
  "두",
  "세",
  "네",
  "다섯",
  "여섯",
  "일곱",
  "여덟",
  "아홉",
  "열",
  "열한",
  "열두",
];

function numeral(count: number): string {
  return NATIVE_NUMERALS[count] ?? String(count);
}

/**
 * 이 or 가, worked out from the last syllable rather than guessed.
 *
 * Only ever applied to a word from `KIND_WORDS`, which is Hangul. A Latin
 * identifier never takes a particle in these sentences — every one of them
 * puts a noun after the name instead ("PayButton.tsx 파일이", "Cart 쪽으로"),
 * because there is no honest way to pick 이 or 가 for `stripe` without knowing
 * how the reader pronounces it.
 */
function subjectParticle(word: string): string {
  const last = word.codePointAt(word.length - 1) ?? 0;
  if (last < 0xac00 || last > 0xd7a3) return "가";
  return (last - 0xac00) % 28 === 0 ? "가" : "이";
}

/** One hop's line. Short: the row it sits on is one line in a panel. */
function hopSentence(index: FlowIndex, from: GraphItem | null, step: Step): string {
  if (step.joint) {
    const file = from ? ownerNameOf(index, from.id) : null;
    // A structural fact stated as one. Never "이 주소가 이걸 불러요" — an address
    // does not call anything; a file answers for it.
    return file ? `이 주소는 ${file} 가 맡고 있어요` : "이 주소를 맡고 있는 자리예요";
  }

  /*
   * Pass 3's sentence, where there is one, in place of the relation's verb.
   *
   * 사용해요 is true and says almost nothing; 여기서 가격을 사람이 읽는 모양으로
   * 바꿔요 is the same fact worth reading. The verb stays as the fallback and
   * is never wrong, so a project that has never run Pass 3 — or one where the
   * model declined this group — loses nothing it had.
   *
   * The line and the certainty still follow: the purpose says what this
   * connection is for, and neither of those is part of that.
   */
  /*
   * The purpose's own full stop comes off before the join.
   *
   * Pass 3 writes whole sentences, and this row is a list separated by ` · `,
   * so keeping it produced "…창을 보여줘요. · page.tsx 99줄" — a sentence that
   * has ended, followed by more of it.
   */
  const parts: string[] = [
    step.purpose?.replace(/[.。]\s*$/, "") ?? RELATION_WORDS[step.relation].forward,
  ];
  const file = from ? fileNameOf(index, from.id) : null;
  if (step.line !== null && file) parts.push(`${file} ${step.line}줄`);
  // Never asserted on a hop we are sure of; `CERTAINTY_WORDS.certain` is the
  // panel's label and repeating it on every row says nothing.
  if (step.certainty === "inferred") parts.push("짐작이에요");
  return parts.join(" · ");
}

export type TerminalFacts = {
  hops: number;
  /** The address, when the walk stopped at one. */
  address: string | null;
  /** The already-visited piece the walk would have gone back to. */
  back: string | null;
  /** The file the last piece lives in. */
  file: string | null;
  /** One outside tool that file brings in. */
  pkg: string | null;
};

/** The sentence for each of the five terminals (§2.6, §7). */
export function flowTerminalSentence(terminal: FlowTerminal, facts: TerminalFacts): string {
  switch (terminal) {
    case "endpoint":
      return "여기가 끝이에요 — 서버가 받는 곳까지 왔어요.";

    case "leaf":
      // Never 아무것도 안 해요. `describe.ts`'s rule, said forward: we may say
      // we found no connection, and may not turn that into a verdict on
      // somebody's code.
      return (
        "여기가 끝이에요. 여기서 더 나가는 연결은 못 찾았어요. " +
        "아무 일도 안 한다는 뜻은 아니고, 저희가 읽어서 이어붙이지 못했다는 뜻이에요."
      );

    case "package": {
      const tool = facts.pkg ? `\`${facts.pkg}\` 쪽` : "밖에서 가져온 도구 쪽";
      const where = facts.file ? `${facts.file} 파일이 가져다 쓰는 도구예요. ` : "";
      return (
        `여기서부터는 ${tool}이 맡아요. ${where}` +
        "그 안은 읽지 않아서, 여기까지만 보여드릴 수 있어요."
      );
    }

    case "bound":
      return (
        `${numeral(facts.hops)} 걸음까지 따라갔는데 아직 끝이 아니에요. ` +
        "더 가면 이야기가 너무 길어져서 여기서 끊었어요. " +
        "이어서 보시려면 마지막 자리부터 다시 따라가 주세요."
      );

    case "cycle": {
      const back = facts.back ? `${facts.back} 쪽으로` : "아까 지나온 자리로";
      return (
        `여기서 아까 지나온 ${back} 다시 돌아가요. ` +
        "같은 자리를 두 번 지나지 않으려고 여기서 멈췄어요. 돌고 도는 구조라는 뜻이에요."
      );
    }
  }
}

export type RefusalFacts = {
  /** The name of what the user selected. */
  name: string;
  kind: ItemKind;
  /** How many `imports` the project has, for the shallow-analyzer sentence. */
  imports: number;
};

/**
 * The sentence for each refusal (§7).
 *
 * Each one is something a non-developer can act on, and each one carries the
 * project's own numbers where it has them — the way `grouping.ts`'s
 * unavailable sentences do. "읽은 연결 57개" is a fact about their site, not an
 * apology from us.
 */
export function flowRefusalSentence(refusal: FlowRefusal, facts: RefusalFacts): string {
  switch (refusal) {
    case "no-entry-point":
      return (
        "이 프로젝트에서는 아직 시작점을 찾지 못했어요. " +
        "사람이 여는 주소를 못 찾아서, 어디서부터 따라가야 할지 정할 수가 없어요. " +
        "파일을 하나 골라 주시면 거기서부터 따라가 볼게요."
      );

    case "no-behaviour":
      return (
        `이 프로젝트에서 읽은 연결 ${facts.imports}개는 모두 "이 파일이 저 파일을 불러와요"예요. ` +
        "어느 자리에서 어느 자리로 넘어가는지까지는 아직 읽지 못해서, 순서대로 따라가 드리긴 어려워요."
      );

    case "nothing-leaves": {
      const word = KIND_WORDS[facts.kind];
      return (
        `"${facts.name}"에서 나가는 연결을 못 찾았어요. ` +
        `이 ${word}${subjectParticle(word)} 아무 일도 안 한다는 뜻은 아니고, ` +
        "저희가 읽어서 이어붙이지 못했다는 뜻이에요."
      );
    }

    case "not-a-start":
      if (facts.kind === "package") {
        return (
          `"${facts.name}"는 밖에서 가져온 도구예요. 그 안은 읽지 않아서, 여기서부터는 따라가 드릴 수가 없어요. ` +
          "이 도구를 쓰는 자리를 골라 주시면 거기서부터 따라가 볼게요."
        );
      }
      return (
        `"${facts.name}"는 저희가 묶어 둔 이름이에요. 코드가 이어 놓은 길은 아니라서 여기서부터는 따라가지 않아요. ` +
        "안에 있는 주소나 파일을 골라 주시면 거기서부터 따라가 볼게요."
      );

    case "unknown-start":
      return "고르신 자리를 지도에서 찾지 못했어요. 한 번만 다시 골라 주시겠어요?";
  }
}

/** A `fetches` whose address had a `${…}` in it (§7). */
export function guessedAddressNote(address: string): string {
  return (
    `여기서 "${address}" 주소로 보내는 것 같아요. ` +
    "주소 가운데가 그때그때 바뀌게 적혀 있어서, 딱 이 주소가 맞다고는 말씀드리지 못해요. 짐작이에요."
  );
}

/**
 * Said once, at the top of the whole flow.
 *
 * Because certainty is the weakest link and not the last one: a path whose
 * sixth hop is a guess is a guess, and a label taken from hop twelve would
 * launder it.
 */
export function certaintyNote(hops: number, guessed: number): string {
  return `이 길 ${numeral(hops)} 걸음 중에 ${numeral(guessed)} 군데는 짐작이에요.`;
}

export function alternativesNote(others: number): string {
  return `이 길 말고도 비슷하게 그럴듯한 길이 ${others}개 더 있어요. 아래에서 바꿔 볼 수 있어요.`;
}

/**
 * How many other ways there were out of one hop.
 *
 * Said at every hop, not only where it is interesting. "이게 이 기능의 전부예요"
 * is a claim we cannot make, and a hop shown alone makes it by omission.
 */
export function branchesNote(branches: number): string {
  if (branches <= 0) return "여기서 갈라지는 다른 길은 없어요.";
  return `여기서 갈라지는 다른 길이 ${branches}개 더 있어요.`;
}
