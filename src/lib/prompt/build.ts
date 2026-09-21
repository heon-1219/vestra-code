import {
  CERTAINTY_WORDS,
  KIND_WORDS,
  RELATION_WORDS,
  type Certainty,
  type ConnectionRelation,
  type GraphConnection,
  type GraphItem,
} from "@/lib/graph/view";
import {
  distanceWord,
  hasLock,
  lockFor,
  standingAmong,
  standingOf,
  type LockMap,
  type Standing,
} from "@/components/workspace/panel/connection-row";
import {
  buildNeighbourhood,
  DEFAULT_LIMIT,
  type Neighbour,
  type Neighbourhood,
} from "@/components/workspace/panel/neighbourhood";
import { buildBeamIndex, runBeam } from "@/components/workspace/map/beam";
import { questionWords, withoutParticle } from "@/components/workspace/flow/start";

/**
 * 프롬프트 만들기: the part of the product the brief calls "the point of it".
 *
 * Someone who cannot read code points at one thing on the map, opens the few
 * neighbours they are willing to see changed, and writes one sentence in their
 * own words. This file turns that into a set of instructions a coding agent
 * (Claude Code, Cursor, Lovable) can act on without a follow-up question, and
 * it does so **with code and a template, not with a model** (§6.4). The model's
 * only job is the Goal line, and even that is optional: `goal: null` builds the
 * same prompt with the person's own words in its place.
 *
 * ## Why the prompt is Korean
 *
 * D153. The agent reading it is fluent in both languages; the person pasting it
 * is not. Two things follow. The prompt sits behind 프롬프트 보기 so the person
 * *can* check what they are sending on their behalf, and a check they cannot
 * read is not a check. And the agent answers in the language it was briefed in:
 * the one rule every prompt carries is "stop and explain why before doing it",
 * and the explanation it produces is read by someone who cannot read an
 * English one. Identifiers, paths and the shape of a piece stay in the code's
 * own spelling, because that is what the agent will grep for.
 *
 * ## Four rules this file keeps, each a way it could mislead an agent
 *
 *   1. **Nothing is allowed that the person did not select or open.** The
 *      allowed list is the selection — with what is written inside it, which
 *      starts open because it is part of what was selected (D162) — plus
 *      neighbours switched to 편집 허용, plus the one place a person picked
 *      when they answered "여기서만". Everything else the neighbourhood holds
 *      goes under 건드리지 말 것, and the rule at the end covers everything the
 *      neighbourhood does not. **No line is both allowed and forbidden**: when
 *      one of the two is written inside the other, the outer one's line says
 *      so (D171).
 *   2. **The lock state is a snapshot** (D23). `lockState` is what was in force
 *      at the moment of generation, by id, so "did the agent touch something
 *      you locked?" has something to compare against later — and the prompt
 *      text is built from the same snapshot, so the two cannot disagree.
 *   3. **Every connection says how sure we are**, in the two words the map
 *      uses, and every sentence a model wrote is marked `(짐작)`. An agent that
 *      cannot tell a parsed call from a guessed one will treat both as fact.
 *   4. **A cap is said out loud.** The neighbourhood is capped per direction
 *      exactly as the panel caps it, and what was left out is counted — a list
 *      that stops silently reads as "that is everything".
 */

/* ------------------------------------------------------------------ types */

export type PromptGraph = {
  items: readonly GraphItem[];
  connections: readonly GraphConnection[];
};

/**
 * What the person answered to "여기서만 바꿀까요, 쓰이는 곳 모두에서 바꿀까요?".
 *
 * `only_here` carries the place, because on this map "here" is not implied: the
 * person selected the piece itself, not one of the screens it appears on, so
 * "only here" is only meaningful once they have said which one.
 */
export type SharedScope =
  | { kind: "everywhere" }
  | { kind: "only_here"; placeId: string };

/** The Goal line, and who wrote it. */
export type PromptGoal = { text: string; fromModel: boolean };

export type PromptInput = {
  graph: PromptGraph;
  /** What the person selected. One today; the shape allows more. */
  selectionIds: readonly string[];
  /** The depth the panel was showing, 1–6. */
  hops: number;
  /** Per direction, the panel's own cap. */
  limit?: number;
  /** The locks at the moment of generation. */
  locks: LockMap;
  /** The person's own words, exactly as typed. */
  request: string;
  /** The model's restatement, or null to use the person's words as the goal. */
  goal: PromptGoal | null;
  /** Null when the selection is not used in several places. */
  scope: SharedScope | null;
};

/** D23's snapshot, by item id. The same shape as `generated_prompts.lock_state`. */
export type LockSnapshot = { editable: string[]; locked: string[] };

/**
 * What one generation produced.
 *
 * The first five fields are `generated_prompts`' columns, name for name, so
 * that storing a generation is one insert and never a translation (D154 says
 * why nothing stores it today).
 */
export type BuiltPrompt = {
  selectionNodeIds: string[];
  lockState: LockSnapshot;
  sharedScope: "only_here" | "everywhere" | null;
  userRequest: string;
  promptText: string;
  /** The one sentence the person reads instead of the prompt. */
  confirmationText: string;
  /** Counts the card shows beside the confirmation. */
  counts: { allowed: number; locked: number; context: number; reuse: number; hidden: number };
};

/* ------------------------------------------------------------ constants */

/** The section titles, in the order §6.4 lists them. Exported for the test. */
export const PROMPT_SECTIONS = [
  "## 1. 목표",
  "## 2. 바꿀 곳",
  "## 3. 이어진 것",
  "## 4. 고쳐도 되는 것",
  "## 5. 건드리지 말 것",
  "## 6. 다시 쓸 것",
  "## 7. 여러 곳에서 쓰이는 조각",
  "## 8. 규칙",
] as const;

/** §6.4's rule, in the words the agent will read. Pinned by the test. */
export const STOP_RULE =
  "4번 목록 밖의 것을 바꿔야 한다면, 바꾸기 전에 멈추고 왜 필요한지 먼저 설명해 주세요.";

/** From this many places, a change to the selection is a change to all of them. */
export const SHARED_FROM = 2;

/** How many places the scope question and section 7 name before counting the rest. */
export const PLACES_SHOWN = 6;

/** How many things to offer under 다시 쓸 것, from each of its two sources. */
const REUSE_ALREADY = 6;
const REUSE_MATCHED = 3;

/**
 * A word that lands on more pieces than this is a flood, not a pointer.
 *
 * Measured, not chosen by taste (D153): on this repository's own map the word
 * 글자, from "이 부분 글자 색을 파란색으로 바꿔줘", landed on a time formatter, a
 * text-width probe and a byte formatter — every one of them a real helper and
 * none of them anything an agent changing a colour should be told to reuse. The
 * beam draws the same line for a single 초성, which "would light every item
 * beginning with it, which is not a beam, it is a flood".
 */
export const REUSE_FLOOD = 8;

/**
 * A piece matched by the request's words is offered only if two places already
 * use it — a helper somebody has reused, rather than a private detail of one
 * file that happens to share a word with the request.
 *
 * The flood rule alone did not do it. The same request's 글자 landed on seven
 * pieces, under the flood line, and they were `strip`, `formatBytes`,
 * `lineBox` and `visible`: every one used in a single place, and none of them a
 * thing to reuse for a colour change (D153).
 */
export const REUSE_MIN_USES = 2;

/**
 * The relations that mean "that place reaches for this one".
 *
 * `describe.ts`'s set, restated because it is private there. `contains` is where
 * a thing lives rather than a place that uses it, and `belongs_to` is a grouping
 * we made — neither is a screen the change would show up on.
 */
const USING: ReadonlySet<ConnectionRelation> = new Set<ConnectionRelation>([
  "calls",
  "renders",
  "fetches",
  "imports",
  "uses_package",
]);

/** The shapes an agent would duplicate if nobody told it they exist. */
const REUSABLE_SHAPES: ReadonlySet<string> = new Set(["component", "hook", "function"]);

/**
 * Words that say "change something" and nothing about what.
 *
 * `questionWords` already drops the words for *asking*; a change request has
 * its own filler, and 바꿔줘 matching a label with 바꾸기 in it would put an
 * unrelated helper under 다시 쓸 것. Short and dull on purpose, for the reason
 * `flow/start.ts` gives for its own list.
 */
const CHANGE_WORDS: ReadonlySet<string> = new Set([
  "바꿔",
  "바꿔줘",
  "바꿔요",
  "바꿔주세요",
  "바꾸고",
  "바꾸기",
  "바꿀",
  "고쳐",
  "고쳐줘",
  "고쳐주세요",
  "고치기",
  "수정",
  "수정해",
  "수정해줘",
  "변경",
  "변경해줘",
  "추가",
  "추가해",
  "추가해줘",
  "넣어",
  "넣어줘",
  "빼줘",
  "없애줘",
  "지워줘",
  "만들어",
  "만들어줘",
  "해줘",
  "해주세요",
  "싶어",
  "싶어요",
  "주세요",
  "그리고",
  "make",
  "change",
  "add",
  "remove",
  "fix",
  "please",
  "it",
  "to",
]);

/* ------------------------------------------------------------- targets */

/**
 * Whether a prompt can be about this at all.
 *
 * A feature is a grouping a model made and a package is somebody else's code,
 * so neither is a place an agent can be sent to change. The panel refuses to
 * start one (`MODE_WORDS.prompt.cannot`) with a sentence saying what to pick
 * instead; this is the same rule where no button stands in front of it. Before
 * it, a feature's prompt named `feature:1c8e949eccd7` as the place to change
 * and a package's gave an agent permission to edit `dotenv`.
 */
export function canPromptAbout(item: GraphItem): boolean {
  return item.kind !== "package" && item.kind !== "feature";
}

/* ---------------------------------------------------------- shared places */

/**
 * Every distinct place that reaches for this item directly, pages first.
 *
 * Uncapped: this list is the question the person answers before generating,
 * and a question built from the panel's first 24 rows would quietly leave some
 * screens out of "everywhere".
 */
export function placesUsing(graph: PromptGraph, itemId: string): GraphItem[] {
  const byId = new Map(graph.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const places: GraphItem[] = [];
  for (const connection of graph.connections) {
    if (connection.to !== itemId || !USING.has(connection.relation)) continue;
    if (connection.from === itemId || seen.has(connection.from)) continue;
    const place = byId.get(connection.from);
    if (!place) continue;
    seen.add(place.id);
    places.push(place);
  }
  return places.sort(comparePlaces);
}

/** Pages first — they are what a person means by "a screen" — then by name. */
function comparePlaces(a: GraphItem, b: GraphItem): number {
  const rank = (item: GraphItem) => (item.kind === "route" ? 0 : item.kind === "symbol" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const an = a.label ?? a.name;
  const bn = b.label ?? b.name;
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * Whether the person has to be asked "only here or everywhere?" first, and
 * about which places.
 *
 * §6.4 puts the question *before* generating, and that order is the point:
 * a prompt that assumed "everywhere" would be handed to an agent that then
 * changes a button on eleven screens because somebody wanted it blue on one.
 *
 * A package and a feature are never asked about. One is somebody else's code
 * and the other is a grouping we made; neither is something a person changes.
 *
 * Asked for anything two places reach for, not only for a component two
 * screens render. §6.4 words it for a shared component because that is the
 * case a person can see, but the same question stands for a function two
 * callers share: changing it changes both. Measured on this repository's map
 * (D163): of the 379 selections that get the question, 12 are components and
 * 243 functions — leaving those out would leave out most of the changes that
 * reach further than the person meant. What was wrong was the question's
 * wording, which asked where the change should be *seen*; `prompt-card.tsx`
 * now asks where it should *apply*.
 */
export function scopeQuestion(
  graph: PromptGraph,
  selectionIds: readonly string[],
): { selectionId: string; places: GraphItem[] } | null {
  const byId = new Map(graph.items.map((item) => [item.id, item]));
  for (const id of selectionIds) {
    const item = byId.get(id);
    if (!item || !canPromptAbout(item)) continue;
    const places = placesUsing(graph, id).filter((place) => !selectionIds.includes(place.id));
    if (places.length >= SHARED_FROM) return { selectionId: id, places };
  }
  return null;
}

/* ------------------------------------------------------------- reuse */

export type ReuseEntry = {
  item: GraphItem;
  /** Why this one is offered, in the prompt's own words. */
  why: "already" | "matched";
  /** The request's words that landed on it, when `matched`. */
  words: string[];
};

/**
 * What already exists that the agent should use instead of writing again.
 *
 * Two sources, both measured rather than guessed:
 *
 *   1. **What the selection already reaches for, one step out — by a
 *      connection the parser read.** An agent asked to change a price display
 *      that is not told `formatPrice` exists writes a second `formatPrice`.
 *      These are relevant because the code being changed already calls them,
 *      which is only true of a `certain` connection: an `inferred` one is a
 *      name matched to a name, and the list is worded as an instruction. Before
 *      this rule 28 of 2,055 entries on this repository's map rested on
 *      inferred connections alone — `materializeFixture` was told to reuse a
 *      private `byteLength` in `file-preview.tsx`, when its code calls Node's
 *      `Buffer.byteLength`. Section 3 still lists every inferred connection,
 *      marked 짐작이에요, so nothing is hidden from the agent (D165).
 *   2. **Pieces elsewhere in the project whose names the request's own words
 *      land on**, by the map's beam — the same matcher that lights the map, so
 *      "버튼" finds here exactly what it finds when typed into the search box.
 *      Only components, hooks and functions: those are what gets duplicated.
 */
export function reuseCandidates(
  graph: PromptGraph,
  selectionIds: readonly string[],
  request: string,
): ReuseEntry[] {
  const selected = new Set(selectionIds);
  const byId = new Map(graph.items.map((item) => [item.id, item]));
  const selection = selectionIds
    .map((id) => byId.get(id))
    .filter((item): item is GraphItem => item !== undefined);

  // The selection's own insides are the thing being changed, not something to
  // reuse — by `contains`, and by lines, which also catches a page that is the
  // same file as the one selected.
  const inside = new Set<string>();
  for (const connection of graph.connections) {
    if (connection.relation === "contains" && selected.has(connection.from)) {
      inside.add(connection.to);
    }
  }
  const partOfSelection = (item: GraphItem) =>
    selected.has(item.id) || inside.has(item.id) || standingAmong(item, selection) !== "around";

  const already: ReuseEntry[] = [];
  const offered = new Set<string>();
  for (const connection of graph.connections) {
    if (!selected.has(connection.from)) continue;
    if (!USING.has(connection.relation) || connection.certainty !== "certain") continue;
    const target = byId.get(connection.to);
    if (!target || partOfSelection(target) || offered.has(target.id)) continue;
    offered.add(target.id);
    already.push({ item: target, why: "already", words: [] });
  }
  already.sort((a, b) => compareReuse(a.item, b.item));

  const words = requestWords(request);
  const matched: ReuseEntry[] = [];
  if (words.length > 0) {
    const pool = graph.items.filter(
      (item) =>
        item.kind === "symbol" &&
        REUSABLE_SHAPES.has(item.shape ?? "") &&
        item.usedBy >= REUSE_MIN_USES &&
        !partOfSelection(item) &&
        !offered.has(item.id),
    );
    const index = buildBeamIndex(pool);
    const hits = new Map<string, string[]>();
    for (const word of words) {
      const needles = [word];
      const stem = withoutParticle(word);
      if (stem) needles.push(stem);
      const landed = new Set<string>();
      for (const needle of needles) {
        for (const id of runBeam(index, needle).matched) landed.add(id);
      }
      if (landed.size > REUSE_FLOOD) continue;
      for (const id of landed) hits.set(id, [...(hits.get(id) ?? []), word]);
    }
    /*
     * Two of the request's words on one piece, or its only word.
     *
     * Measured on this repository's own map with seven requests a person
     * might type (D153): a single landed word produced 14 leads, and reading
     * them, about three had anything to do with the request — `keys` and
     * `measureTextWidth` for a colour change, `classify` for a strip's height.
     * Two words produced one lead, `chooseModel` for "모델 고르는 버튼을 하나 더
     * 추가해줘", which is the helper that request is about. A wrong lead is
     * worse than none here: it is read by an agent as a suggestion, and the
     * list of what the selection already uses is always there beside it.
     */
    const needed = Math.min(2, words.length);
    for (const [id, landedWords] of hits) {
      const item = byId.get(id);
      if (item && landedWords.length >= needed) {
        matched.push({ item, why: "matched", words: landedWords });
      }
    }
    matched.sort(
      (a, b) => b.words.length - a.words.length || compareReuse(a.item, b.item),
    );
  }

  return [...already.slice(0, REUSE_ALREADY), ...matched.slice(0, REUSE_MATCHED)];
}

/** The request's words that could name something, without the change filler. */
export function requestWords(request: string): string[] {
  return questionWords(request).filter((word) => !CHANGE_WORDS.has(word.toLowerCase()));
}

/** Busiest first — a helper used in twelve places is the one to reuse — then by name. */
function compareReuse(a: GraphItem, b: GraphItem): number {
  if (a.usedBy !== b.usedBy) return b.usedBy - a.usedBy;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/* ----------------------------------------------------------- the build */

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const byId = new Map(input.graph.items.map((item) => [item.id, item]));
  // Only code: `canPromptAbout` says why a feature or a package is never a
  // place to change.
  const selection = input.selectionIds
    .map((id) => byId.get(id))
    .filter((item): item is GraphItem => item !== undefined && canPromptAbout(item));
  const selectionIds = selection.map((item) => item.id);
  const selected = new Set(selectionIds);
  const limit = input.limit ?? DEFAULT_LIMIT;

  const around = mergeNeighbourhoods(
    selection
      .map((item) => buildNeighbourhood(input.graph, item.id, { hops: input.hops, limit }))
      .filter((n): n is Neighbourhood => n !== null),
    selected,
  );

  const hops = around.hops;
  const shared = scopeQuestion(input.graph, selectionIds);
  const scope = shared ? input.scope : null;
  const scopePlace =
    scope?.kind === "only_here" ? (byId.get(scope.placeId) ?? null) : null;

  /*
   * Which rows are code at all, and where each one stands.
   *
   * A feature row is a grouping a model made — said once in section 3, by its
   * plain name, and never put on either list: printing its internal id under
   * 건드리지 말 것 told an agent to leave alone something it cannot find.
   *
   * `standing` is the panel's own rule (`standingOf`), read by lines: a piece
   * written inside the selected file is part of what is being changed, and a
   * page that is the selected file is the selected file.
   */
  const rows = around.rows.filter((n) => hasLock(n.item));
  const features = around.rows.filter((n) => !hasLock(n.item) && n.hops === 1);
  const standing = new Map<string, Standing>(
    rows.map((n) => [n.item.id, standingAmong(n.item, selection)]),
  );
  const partOfSelection = (id: string) => (standing.get(id) ?? "around") !== "around";
  /** A row whose lines hold a selection: the file it is written in, or a class around a method. */
  const holdsSelection = (item: GraphItem) =>
    selection.some((one) => standingOf(one, item) === "inside");

  /*
   * The snapshot. Everything the neighbourhood shows has a lock and goes in one
   * of the two lists, by `lockFor` — the function the panel's switches read,
   * so the switch a person saw and the list the agent reads cannot differ. The
   * selection is always editable, because it is the thing the person asked to
   * have changed, and so is what is written inside it until the person closes
   * it. A place picked as "here" is opened, because "only on the checkout
   * screen" cannot be done without touching the checkout screen; the panel
   * opens it visibly too.
   */
  const editable = new Set<string>(selected);
  const locked = new Set<string>();
  for (const neighbour of rows) {
    const id = neighbour.item.id;
    if (scopePlace && id === scopePlace.id) continue;
    if (lockFor(input.locks, neighbour.item, selection) === "editable") editable.add(id);
    else locked.add(id);
  }
  if (scopePlace) editable.add(scopePlace.id);
  for (const id of editable) locked.delete(id);
  const allowedItems = [...editable]
    .map((id) => byId.get(id))
    .filter((item): item is GraphItem => item !== undefined);

  /*
   * What the cap left out (D171).
   *
   * Those rows have no switch on screen, so each one follows the place it is
   * written in. Inside something allowed — a piece of the selected file past
   * the 24th row, or a page that is the selected file — it changes with that
   * place, and the cap sentence says so; before this, the same sentence told
   * the agent to leave every unlisted thing alone right under a line allowing
   * the whole file (11 selections on this repository's map, 3 of 3 capped ones
   * on `Kim-and-Chang-`). A piece the person locked by hand is still locked,
   * and goes under 5 by name. Everything else is covered by the cap sentence,
   * which forbids only what lies outside 4 — so a file that holds the
   * selection, if the cap drops it, is not forbidden whole.
   */
  const leftOut = around.hidden > 0 ? leftOutOf(input.graph, selection, input.hops, around.rows) : [];
  const lockedByHandOffList: GraphItem[] = [];
  let alongside = 0;
  let outsideLeftOut = 0;
  for (const neighbour of leftOut) {
    const id = neighbour.item.id;
    if (!hasLock(neighbour.item) || editable.has(id) || locked.has(id)) continue;
    const within = allowedItems.some((place) => standingOf(neighbour.item, place) !== "around");
    if (!within) {
      outsideLeftOut += 1;
    } else if (standingAmong(neighbour.item, selection) !== "same" && input.locks[id] === "locked") {
      locked.add(id);
      lockedByHandOffList.push(neighbour.item);
    } else {
      alongside += 1;
    }
  }
  const lockedItems = [
    ...rows.filter((n) => locked.has(n.item.id)).map((n) => n.item),
    ...lockedByHandOffList,
  ].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
  /** Locked things written inside `place`: 4 has to carve them out of it. */
  const lockedWithin = (place: GraphItem) =>
    lockedItems.filter((one) => standingOf(one, place) === "inside");
  const carveOut = (place: GraphItem) =>
    lockedWithin(place).length > 0 ? " (5번에 적은 잠긴 줄은 빼고)" : "";

  const reuse = reuseCandidates(input.graph, selectionIds, input.request);
  const request = input.request.trim();
  const goal = input.goal && input.goal.text.trim().length > 0 ? input.goal : null;

  const lines: string[] = [];
  const push = (...more: string[]) => lines.push(...more);

  push(
    "# 코딩 도우미에게 맡기는 일",
    "",
    "이 글은 Vestra Code가 프로젝트 지도를 보고 만든 작업 지시예요. 아래 순서대로 읽고, 적힌 범위 안에서만 고쳐 주세요.",
    `표시 읽는 법: '${CERTAINTY_WORDS.certain}'는 코드를 분석해서 직접 확인한 연결이고, '${CERTAINTY_WORDS.inferred}'는 이름이나 모델의 판단으로 짐작한 연결이에요. '(짐작)'이 붙은 설명은 모델이 풀어 쓴 말이라 틀릴 수 있어요. 코드와 다르면 코드를 믿어 주세요.`,
    "",
  );

  // 1. Goal
  push(PROMPT_SECTIONS[0]);
  if (goal) {
    push(goal.text.trim(), `- 사용자가 직접 쓴 말: "${request}"`);
    if (goal.fromModel) {
      push(
        "- 위 문장은 모델이 사용자의 말을 다시 적은 거예요. 둘이 다르게 읽히면 사용자가 쓴 말을 따라 주세요.",
      );
    }
  } else {
    push(`"${request}"`, "- 사용자가 직접 쓴 말 그대로예요.");
  }
  push("");

  // 2. Where
  push(PROMPT_SECTIONS[1]);
  if (selection.length === 0) {
    // Nothing left that is code: the selection vanished with a redrawn map, or
    // was a feature or a package, which `canPromptAbout` keeps out.
    push("- 바꿀 곳이 정해지지 않았어요. 무엇을 바꿀지 사용자에게 먼저 물어봐 주세요.");
  }
  const sameRows = uniqueById(rows.filter((n) => standing.get(n.item.id) === "same"));
  for (const item of selection) {
    push(
      isPathNamed(item)
        ? `- ${whereOf(item)} — ${kindOf(item)}`
        : `- ${nameOf(item)} — ${kindOf(item)} · ${whereOf(item)}`,
    );
    if (item.label && item.label !== item.name) push(`  - 쉬운 이름(짐작): ${item.label}`);
    if (item.summary) push(`  - 하는 일(짐작): ${item.summary.trim()}`);
    // The same lines under a second name: a page and the file it is.
    for (const same of sameRows) {
      if (standingOf(same.item, item) === "same") {
        push(`  - 같은 코드가 지도에 한 번 더 있어요: ${nameOf(same.item)} (${kindOf(same.item)})`);
      }
    }
  }
  push("");

  // 3. Connected context
  push(`${PROMPT_SECTIONS[2]} (${distanceWord(hops)}까지)`);
  if (rows.length === 0) {
    push("- 지금까지 읽은 것 중에는 이어진 곳을 찾지 못했어요. 못 본 연결이 있을 수도 있어요.");
  } else {
    const groups: { title: string; rows: Neighbour[] }[] = [
      { title: "여기가 있는 곳", rows: rows.filter((n) => n.direction === "used-by" && n.relation === "contains") },
      { title: "안에 있는 것", rows: rows.filter((n) => n.direction === "uses" && n.relation === "contains") },
      { title: "여기서 쓰는 것", rows: rows.filter((n) => n.direction === "uses" && n.relation !== "contains") },
      { title: "여기를 쓰는 곳", rows: rows.filter((n) => n.direction === "used-by" && n.relation !== "contains") },
    ];
    const anchor = selection.length === 1 ? nameOf(selection[0]) : "고른 곳";
    for (const group of groups) {
      if (group.rows.length === 0) continue;
      push(`${group.title}:`);
      for (const neighbour of group.rows) {
        push(`- ${contextRow(neighbour, anchor)}`);
        if (neighbour.purpose) push(`  - 무엇을 위한 연결인지(짐작): ${neighbour.purpose}`);
      }
    }
  }
  if (features.length > 0) {
    // By the plain name a person reads, never by id: an agent cannot grep for
    // a grouping, and the id is ours.
    const names = uniqueById(features).map((n) => n.item.label ?? "이름을 아직 못 붙인 기능");
    push(
      `- 묶어 둔 기능(짐작): ${names.join(", ")} — 모델이 비슷한 파일끼리 묶은 이름이라, 코드에서 찾을 수는 없어요.`,
    );
  }
  if (around.hidden > 0) {
    const said = [`- 연결이 많아서 ${around.hidden.toLocaleString("ko-KR")}개는 목록에서 뺐어요.`];
    const rest = outsideLeftOut + lockedByHandOffList.length;
    if (alongside > 0) {
      said.push(
        rest === 0
          ? "모두 4번에 적은 곳 안에 적힌 것이라, 그 곳과 함께 고쳐도 돼요."
          : `그중 ${alongside.toLocaleString("ko-KR")}개는 4번에 적은 곳 안에 적힌 것이라, 그 곳과 함께 고쳐도 돼요.`,
      );
    }
    if (alongside === 0 || rest > 0) {
      said.push("목록에서 뺀 것이라도 4번에 적은 곳 밖에 있는 것은 건드리지 마세요.");
    }
    push(said.join(" "));
  }
  push("");

  /*
   * 4. Allowed / 5. Do not touch — and never the same lines in both (D162,
   * D171).
   *
   * Two nestings, each worded rather than left to contradict. A locked thing
   * written inside an allowed place (a piece the person closed inside the
   * selected file, a piece left locked inside a file they opened) is carved
   * out of that place's line in 4. An allowed thing written inside a locked one
   * (the selection inside the file it lives in, a method left open inside a
   * class they closed) turns the locked line in 5 into "the rest of it".
   * Before both rules covered opened neighbours too, opening a file whose
   * other pieces were on the list allowed the file and forbade those pieces
   * with no carve-out: on this repository's map, 1,547 of the 7,609 single
   * switch flips a person can make did it, on 808 of 1,961 selections. The
   * other nesting (closing a class inside the selected file, with a method
   * inside it left open) did it on 27 flips here and 25 on `Kim-and-Chang-`.
   */
  push(PROMPT_SECTIONS[3]);
  for (const item of selection) {
    push(`- ${placeOf(item)} — 바꿀 곳${carveOut(item)}`);
  }
  // A Set, because the merged neighbourhood can hold one place in both
  // directions, and a file and the page that is that file word the same line.
  const allowedLines = new Set<string>();
  for (const neighbour of rows) {
    const id = neighbour.item.id;
    // What is part of the selection is already the line above.
    if (!editable.has(id) || selected.has(id) || partOfSelection(id)) continue;
    const except = carveOut(neighbour.item);
    if (holdsSelection(neighbour.item)) {
      allowedLines.add(
        neighbour.item.kind === "file"
          ? `- ${pathOf(neighbour.item)}의 다른 부분 — 바꿀 곳이 들어 있는 파일, 사용자가 열어 둠${except}`
          : `- ${placeOf(neighbour.item)} — 바꿀 곳을 감싼 조각, 사용자가 열어 둠${except}`,
      );
    } else if (scopePlace && id === scopePlace.id) {
      allowedLines.add(`- ${placeOf(neighbour.item)} — 이 곳에서만 바꾸기로 해서 함께 열었어요${except}`);
    } else {
      allowedLines.add(`- ${placeOf(neighbour.item)} — 사용자가 열어 둠${except}`);
    }
  }
  if (scopePlace && !rows.some((n) => n.item.id === scopePlace.id)) {
    allowedLines.add(
      `- ${placeOf(scopePlace)} — 이 곳에서만 바꾸기로 해서 함께 열었어요${carveOut(scopePlace)}`,
    );
  }
  push(...allowedLines);
  push("");

  push(PROMPT_SECTIONS[4]);
  const lockedLines = new Set<string>();
  for (const item of lockedItems) {
    const held = allowedItems.filter((place) => standingOf(place, item) === "inside");
    lockedLines.add(
      held.length > 0
        ? `- ${outsideOf(item, outermost(held), held.some((one) => partOfSelection(one.id) || selected.has(one.id)))}`
        : `- ${placeOf(item)}`,
    );
  }
  if (lockedLines.size === 0) push("- 따로 잠가 둔 것은 없어요.");
  push(...lockedLines);
  const carvedFromSelection = selection.some((item) => lockedWithin(item).length > 0);
  const carvedFromOpened = allowedItems.some(
    (place) => !selected.has(place.id) && !partOfSelection(place.id) && lockedWithin(place).length > 0,
  );
  if (carvedFromSelection) {
    push(
      "- 위에 적은 것 가운데 바꿀 곳 안에 적힌 것은 사용자가 직접 잠갔어요. 바꿀 곳을 고치더라도 그 줄들은 그대로 두세요.",
    );
  }
  if (carvedFromOpened) {
    push(
      "- 위에 적은 것 가운데 4번에서 열어 둔 곳 안에 적힌 것은 잠긴 채로 남아 있어요. 열어 둔 곳을 고치더라도 그 줄들은 그대로 두세요.",
    );
  }
  push("- 4번에 적은 곳 밖의 파일과 조각은 모두 그대로 두세요.");
  push("");

  // 6. Reuse these
  push(PROMPT_SECTIONS[5]);
  const already = reuse.filter((entry) => entry.why === "already");
  const matchedReuse = reuse.filter((entry) => entry.why === "matched");
  const reuseRow = (entry: ReuseEntry, reason: string | null) => {
    const used = entry.item.usedBy > 0 ? ` · ${entry.item.usedBy}곳에서 쓰여요` : "";
    push(`- ${placeOf(entry.item)}${reason ? ` · ${reason}` : ""}${used}`);
    if (entry.item.summary) push(`  - 하는 일(짐작): ${entry.item.summary.trim()}`);
  };
  if (reuse.length === 0) {
    push(
      "- 요청과 관련해서 다시 쓸 만한 것을 지도에서 찾지 못했어요. 새로 만들기 전에 비슷한 것이 이미 있는지 먼저 찾아봐 주세요.",
    );
  }
  /*
   * Two lists with two different instructions, because they are two different
   * kinds of knowing. What the selection already calls is certain to be
   * relevant and is an instruction; a name that shares a word with the request
   * is a lead, and an agent told to "use these" about a lead will use it.
   */
  if (already.length > 0) {
    push("바꿀 곳이 이미 쓰고 있는 것이에요. 같은 일을 하는 것을 새로 만들지 말고 이것을 써 주세요.");
    for (const entry of already) reuseRow(entry, null);
  }
  if (matchedReuse.length > 0) {
    push(
      "요청에 적힌 낱말과 이름이 겹치는, 여러 곳에서 쓰이는 것이에요. 요청과 관련이 있을 때만 새로 만들지 말고 이것을 써 주세요.",
    );
    for (const entry of matchedReuse) {
      reuseRow(entry, `겹치는 낱말: ${entry.words.map((word) => `"${word}"`).join(", ")}`);
    }
  }
  push("");

  // 7. Shared component warning
  if (shared) {
    const subject = byId.get(shared.selectionId);
    push(PROMPT_SECTIONS[6]);
    push(
      `${subject ? nameOf(subject) : "고른 곳"} — 쓰이는 곳이 ${shared.places.length.toLocaleString("ko-KR")}곳이에요.`,
    );
    for (const place of shared.places.slice(0, PLACES_SHOWN)) {
      push(`- ${placeOf(place)}`);
    }
    if (shared.places.length > PLACES_SHOWN) {
      push(`- 이 밖에 ${(shared.places.length - PLACES_SHOWN).toLocaleString("ko-KR")}곳이 더 있어요.`);
    }
    if (scopePlace) {
      push(
        `사용자가 고른 범위: ${nameOf(scopePlace)}에서만 바꿔요.`,
        "- 다른 곳에서는 지금과 똑같이 보이고 똑같이 동작해야 해요.",
        `- 여럿이 함께 쓰는 부분의 기본 동작은 그대로 두고, ${nameOf(scopePlace)}에서만 달라지게 해 주세요. 예를 들면 고를 수 있는 값을 하나 더하고, 그 기본값은 지금과 같게 두는 식이에요.`,
      );
    } else if (scope?.kind === "everywhere") {
      push(
        "사용자가 고른 범위: 쓰이는 모든 곳에서 함께 바뀌어요.",
        "- 바꾼 뒤 위의 곳들에서 모양이나 동작이 깨지지 않는지 확인해 주세요.",
      );
    } else {
      push(
        "사용자가 아직 범위를 고르지 않았어요. 바꾸기 전에 모든 곳에서 바꿀지, 한 곳에서만 바꿀지 사용자에게 먼저 물어봐 주세요.",
      );
    }
    push("");
  }

  // 8. Rule
  push(
    PROMPT_SECTIONS[7],
    `- ${STOP_RULE}`,
    "- 사용자는 코드를 읽지 못해요. 설명과 끝난 뒤의 보고는 코드를 모르는 사람이 읽을 수 있는 쉬운 한국어로 해 주세요.",
  );

  // "열어 둔" counts what the person opened, not what came open because it is
  // written inside the selection — they did not open those, they selected them
  // — nor the "only here" place, which the sentence before it already names.
  const editableNeighbours = [...editable].filter(
    (id) => !selected.has(id) && !partOfSelection(id) && id !== scopePlace?.id,
  ).length;

  return {
    selectionNodeIds: selection.map((item) => item.id),
    lockState: { editable: [...editable].sort(), locked: [...locked].sort() },
    sharedScope: scope ? scope.kind : null,
    userRequest: request,
    promptText: lines.join("\n"),
    confirmationText: confirmationFor({
      selection,
      scope,
      scopePlace,
      sharedCount: shared?.places.length ?? 0,
      editable: editableNeighbours,
      locked: locked.size,
    }),
    counts: {
      allowed: editable.size,
      locked: locked.size,
      context: rows.length,
      reuse: reuse.length,
      hidden: around.hidden,
    },
  };
}

/* ---------------------------------------------------------- confirmation */

/**
 * The sentence the person reads instead of the prompt.
 *
 * Every particle that follows a name here is one whose spelling does not
 * depend on the name — 만, 의, 에서 — because the name is often a Latin
 * identifier and whether `PayButton` takes 을 or 를 depends on how it is read
 * aloud, which we do not know. `describe.ts`'s `copula` makes the same choice
 * for the same reason; this file simply avoids needing one.
 *
 * "Everywhere" is not said with 만. It read "오로라 화면만 바꾸라고 적었어요.
 * 쓰이는 3곳 모두 함께 바뀌어요" — only, then all — on every one of the 379
 * selections on this repository's map that are asked the question. The name
 * stands before a dash instead, the construction the scope question uses.
 */
function confirmationFor(input: {
  selection: readonly GraphItem[];
  scope: SharedScope | null;
  scopePlace: GraphItem | null;
  sharedCount: number;
  editable: number;
  locked: number;
}): string {
  const names = input.selection.map(displayOf);
  const subject = names.length === 0 ? "고른 곳" : names.join(", ");
  const sentences: string[] = [];

  if (input.scopePlace) {
    sentences.push(`${displayOf(input.scopePlace)}의 ${subject}만 바꾸라고 적었어요.`);
  } else if (input.scope?.kind === "everywhere") {
    sentences.push(
      `${subject} — 쓰이는 ${input.sharedCount.toLocaleString("ko-KR")}곳 모두에서 함께 바꾸라고 적었어요.`,
    );
  } else {
    sentences.push(`${subject}만 바꾸라고 적었어요.`);
  }

  if (input.editable > 0) {
    sentences.push(`열어 둔 ${input.editable.toLocaleString("ko-KR")}개는 같이 고쳐도 된다고 했어요.`);
  }
  if (input.locked > 0) {
    sentences.push(`잠긴 ${input.locked.toLocaleString("ko-KR")}개는 건드리지 말라고 했어요.`);
  }
  return sentences.join(" ");
}

/* ---------------------------------------------------------- neighbourhood */

type Merged = { hops: number; rows: Neighbour[]; hidden: number };

/**
 * One neighbourhood from one or more selections, in the panel's own order.
 *
 * With one selection this is exactly the panel's list — same walk, same cap,
 * same sort — which is the point: the rows the agent is told about are the rows
 * the person set switches on.
 */
function mergeNeighbourhoods(all: readonly Neighbourhood[], selected: ReadonlySet<string>): Merged {
  if (all.length === 0) return { hops: 1, rows: [], hidden: 0 };
  const seen = new Map<string, Neighbour>();
  let hidden = 0;
  for (const around of all) {
    hidden += around.hidden.uses + around.hidden.usedBy;
    for (const neighbour of [...around.usedBy, ...around.uses]) {
      if (selected.has(neighbour.item.id)) continue;
      const key = `${neighbour.direction}:${neighbour.item.id}`;
      const existing = seen.get(key);
      if (!existing || neighbour.hops < existing.hops) seen.set(key, neighbour);
    }
  }
  return { hops: all[0].hops, rows: [...seen.values()], hidden };
}

/** One row per place, first arrival kept: the merged list can hold a place in both directions. */
function uniqueById(rows: readonly Neighbour[]): Neighbour[] {
  const seen = new Set<string>();
  return rows.filter((n) => (seen.has(n.item.id) ? false : (seen.add(n.item.id), true)));
}

/**
 * What the cap left off the list, one row per place.
 *
 * The same walk as the panel's with no cap, minus what the list shows. Built
 * only when something was capped, so the common case pays nothing for it.
 */
function leftOutOf(
  graph: PromptGraph,
  selection: readonly GraphItem[],
  hops: number,
  shown: readonly Neighbour[],
): Neighbour[] {
  const listed = new Set(shown.map((n) => n.item.id));
  const selected = new Set(selection.map((item) => item.id));
  const out: Neighbour[] = [];
  const seen = new Set<string>();
  for (const item of selection) {
    const all = buildNeighbourhood(graph, item.id, { hops, limit: Number.MAX_SAFE_INTEGER });
    if (!all) continue;
    for (const neighbour of [...all.usedBy, ...all.uses]) {
      const id = neighbour.item.id;
      if (selected.has(id) || listed.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(neighbour);
    }
  }
  return out;
}

/** Drop anything written inside another one of these: naming the outer one says it. */
function outermost(items: readonly GraphItem[]): GraphItem[] {
  return items.filter(
    (item) => !items.some((other) => other.id !== item.id && standingOf(item, other) === "inside"),
  );
}

/** How many allowed places a "the rest of it" line names before counting the others. */
const HELD_SHOWN = 3;

/**
 * A locked place that holds something allowed, worded as the rest of it.
 *
 * Not "do not touch PayButton.tsx" — that would forbid the very lines the
 * agent was told to change. What it holds is named with its lines: the
 * selection inside the file it lives in, a place the person opened inside a
 * file or a class they left locked. A file says so in its own words; a piece
 * (a class around a method) is named, then its path.
 */
function outsideOf(holder: GraphItem, held: readonly GraphItem[], holdsSelection: boolean): string {
  const named = held.slice(0, HELD_SHOWN).map((one) => `${nameOf(one)}${linesOf(one)}`);
  const more =
    held.length > HELD_SHOWN ? ` 외 ${(held.length - HELD_SHOWN).toLocaleString("ko-KR")}곳` : "";
  const inside = `${named.join(", ")}${more} 밖의 부분`;
  if (holder.kind !== "file") return `${placeOf(holder)}에서 ${inside}`;
  const what = holdsSelection ? "바꿀 곳" : "열어 둔 곳";
  return `${pathOf(holder)}에서 ${inside} — ${what}이 들어 있는 파일`;
}

/**
 * One row of section 3, read along the arrow.
 *
 * An arrow rather than the panel's standing-on-one-end verbs: the agent is not
 * looking at a panel, and `A → B · 사용해요` is unambiguous about which of the
 * two does the using. The verb is `short`, which `view.ts` defines as read
 * from `from` to `to` for exactly this.
 */
function contextRow(neighbour: Neighbour, anchor: string): string {
  const far = nameOf(neighbour.item);
  const via = neighbour.via ? nameOf(neighbour.via) : null;
  const middle = via ? (neighbour.hops > 2 ? ` → … → ${via}` : ` → ${via}`) : "";
  const arrow =
    neighbour.direction === "uses"
      ? `${anchor}${middle} → ${far}`
      : `${far}${reverse(middle)} → ${anchor}`;
  const verb = RELATION_WORDS[neighbour.relation].short;
  const label =
    neighbour.item.label && neighbour.item.label !== neighbour.item.name
      ? ` · 쉬운 이름(짐작): ${neighbour.item.label}`
      : "";
  // A file's name is its path, and the arrow has already said it.
  const where = isPathNamed(neighbour.item) ? "" : ` · ${whereOf(neighbour.item)}`;
  return `${arrow} · ${verb} · ${certaintyOf(neighbour.certainty)}${where}${label}`;
}

function reverse(middle: string): string {
  if (!middle) return "";
  const parts = middle.split(" → ").filter(Boolean);
  return ` → ${parts.reverse().join(" → ")}`;
}

/* ----------------------------------------------------------- formatting */

function certaintyOf(certainty: Certainty): string {
  return CERTAINTY_WORDS[certainty];
}

/** The code's own name, fenced so the agent can search for it. */
function nameOf(item: GraphItem): string {
  return `\`${item.name}\``;
}

/** A file whose name is its path, which is every file the parser records. */
function isPathNamed(item: GraphItem): boolean {
  return item.kind === "file" && item.path !== null && item.name === item.path;
}

/**
 * The name and where it is, without saying a file's path twice.
 *
 * A file is named by its path, so "`src/lib/format.ts` · `src/lib/format.ts`
 * (파일 전체)" was the same fact printed twice on every file row.
 */
function placeOf(item: GraphItem): string {
  return isPathNamed(item) ? whereOf(item) : `${nameOf(item)} · ${whereOf(item)}`;
}

/** The name a person reads. */
function displayOf(item: GraphItem): string {
  return item.label ?? item.name;
}

/**
 * 조각(component), 페이지, 파일 — the product's word, and the code's word for a
 * piece beside it, because 조각 alone does not tell an agent whether to look for
 * a component or a hook.
 */
function kindOf(item: GraphItem): string {
  const word = KIND_WORDS[item.kind];
  return item.kind === "symbol" && item.shape ? `${word}(${item.shape})` : word;
}

function pathOf(item: GraphItem): string {
  return item.path ? `\`${item.path}\`` : KIND_WORDS[item.kind];
}

function linesOf(item: GraphItem): string {
  if (item.startLine === null) return "";
  const end = item.endLine ?? item.startLine;
  return end === item.startLine ? `(${item.startLine}줄)` : `(${item.startLine}–${end}줄)`;
}

/**
 * Path and line range, the two things a citation is made of.
 *
 * A file has no range — the whole file is its range — and says so rather than
 * printing nothing, so "파일 전체" is a claim an agent can act on. A package has
 * no path in this project at all, which is itself the useful fact.
 */
function whereOf(item: GraphItem): string {
  if (!item.path) return item.kind === "package" ? "이 프로젝트 밖의 도구" : KIND_WORDS[item.kind];
  if (item.startLine === null) return `\`${item.path}\` (파일 전체)`;
  const end = item.endLine ?? item.startLine;
  return end === item.startLine
    ? `\`${item.path}\` ${item.startLine}줄`
    : `\`${item.path}\` ${item.startLine}–${end}줄`;
}
