import {
  projectEntryPoints,
  type FlowGraph,
  type FlowRefusal,
  type FlowSpine,
  HOP_RELATIONS,
} from "@/lib/graph/flow";
import type { Certainty, GraphItem, ItemKind } from "@/lib/graph/view";

import { runBeam, type BeamIndex } from "../map/beam";

/**
 * Where a flow starts when the user typed a sentence instead of clicking a dot.
 *
 * The founder's own example is a sentence, not a click: "이 구매 기능 어떻게
 * 동작하는지 말해줘". `FLOW_TRACKING.md` §2.3 ranks three ways to start — a
 * route, the selection, and what the user typed — and this file is the third.
 *
 * ## It is the map's beam, and not a second search
 *
 * `runBeam` is the matcher, the same one that lights the map and the same one
 * `qa/tools.ts` gives `find_items`: the same 초성 handling, so `ㄱㅈ` finds 결제,
 * and the same wrong-IME handling, so `rufwp` does too. The reason is stated
 * there and it is not about saving code — "a second implementation would answer
 * the user's own words differently from the map they are looking at", and this
 * screen has the map beside it.
 *
 * What this file adds is not a second matcher. It is the step before one: a
 * person types a **sentence**, and `runBeam` takes a **word**. Handing it the
 * whole sentence matches nothing, because it asks whether an item's text
 * contains the needle and no item is called 이 구매 기능 어떻게 동작하는지 말해줘.
 * So the sentence is cut into words, each word goes to the beam unchanged, and
 * ranking is by how many of the question's words landed on the same place.
 *
 * ## Two things that go wrong in Korean and are handled here
 *
 * **Particles.** 결제가 is 결제 with 가 stuck to it, and `"결제 화면".includes("결제가")`
 * is false — the word the user typed does not appear anywhere, spelled that
 * way. So each word is offered to the beam **twice**, once as typed and once
 * with a trailing particle taken off, and the matches are unioned. Offering
 * both rather than replacing is deliberate: 지도 ends in 도, which is also a
 * particle, and a rule that rewrote it to 지 would stop the word 지도 finding
 * anything.
 *
 * **Asking words.** 어떻게, 알려줘, 기능 and their friends are about the act of
 * asking, not about the project, and they match labels by accident — 기능 alone
 * would light every feature on a project that has any. They are dropped, and
 * the list is kept short and dull on purpose: a long stopword list is a second
 * search with extra steps, and anything wrongly dropped is recoverable because
 * the panel offers the project's own entry points when nothing matches.
 *
 * ## Nothing here calls a model
 *
 * §4's arithmetic is the reason: the walk costs zero model calls, warm or cold,
 * and a language model asked to pick a start would make the cheapest part of
 * this feature the expensive one. Pure, no React, no environment.
 */

/** Where the start came from, in the shape the panel needs to explain it. */
export type StartOrigin =
  /** The user's typed words matched it. */
  | "typed"
  /** It was already chosen on the map. */
  | "selection"
  /** It was picked out of the project's own list of entry points. */
  | "listed";

export type FlowChoice = {
  item: GraphItem;
  origin: StartOrigin;
  /** Distinct words from the question that landed here. Zero unless `typed`. */
  hits: number;
  /** The words that landed, in the order they were typed. For the note. */
  words: string[];
  /** Other places the same words matched, which the panel says out loud. */
  others: number;
  /**
   * The feature whose name the words actually matched, when the start was
   * reached through one rather than named directly.
   *
   * This is the founder's own sentence working: "이 구매 기능 어떻게 동작하는지
   * 말해줘" has one word in it about the project, 구매, and on a project where
   * Pass 2 has named a 구매 feature that word matches the **feature** and
   * nothing else — no file, no route and no symbol is called that. A feature
   * cannot be a start (`entryPointsOf` refuses one, because a grouping we made
   * is not something the code does), so the word would find something and then
   * lead nowhere.
   *
   * §3 and §9's Phase 5 already say what it should lead to: "its entry points
   * are the routes and endpoints that `belongs_to` it, and the walk is
   * unchanged". So a matched feature is expanded into exactly those, each one
   * carrying the feature here so the panel can say where the name came from.
   */
  via: GraphItem | null;
};

/**
 * Words that are about asking rather than about the project.
 *
 * Deliberately short. Every entry earns its place by being a word that would
 * match something on a real project for the wrong reason — 기능 matches every
 * feature Pass 2 named, 화면 matches every page — or by being pure grammar.
 * A word wrongly dropped costs a match; the panel then offers the project's
 * entry points, which is the same place someone who typed nothing lands.
 */
const ASKING_WORDS: ReadonlySet<string> = new Set([
  // The question itself.
  "어떻게",
  "어디서",
  "어디로",
  "어디",
  "언제",
  "무엇",
  "뭐가",
  "뭐",
  "왜",
  "어떤",
  "어느",
  // What is being asked for.
  "동작",
  "동작하는지",
  "되는지",
  "하는지",
  "돌아가는지",
  "이뤄지나요",
  "되나요",
  "하나요",
  "인가요",
  "알려줘",
  "알려주세요",
  "말해줘",
  "말해주세요",
  "보여줘",
  "보여주세요",
  "설명",
  "설명해줘",
  "궁금해요",
  "궁금",
  // Words this product uses about itself, which would match its own vocabulary
  // back at the user rather than their project.
  "기능",
  "부분",
  "코드",
  "흐름",
  "순서",
  "과정",
  "관련",
  "대해",
  "대한",
  "관한",
  // Pointing words with nothing in them.
  "이거",
  "그거",
  "저거",
  "여기",
  "거기",
  "저기",
  "이것",
  "그것",
  "저것",
  // English, for a question typed in it.
  "how",
  "does",
  "do",
  "the",
  "this",
  "that",
  "what",
  "where",
  "when",
  "why",
  "is",
  "are",
  "work",
  "works",
  "tell",
  "show",
  "me",
  "about",
  "and",
  "for",
  "from",
  "with",
  "flow",
  "code",
]);

/**
 * Particles that can be taken off the end of a Korean word.
 *
 * Longest first, so 에서 is tried before 서 would be — and 서 is not on the list
 * at all, because a one-syllable strip off a two-syllable word leaves a
 * fragment that matches half the project.
 */
const PARTICLES: readonly string[] = [
  "에서는",
  "으로는",
  "에게서",
  "이랑",
  "에서",
  "에게",
  "한테",
  "까지",
  "부터",
  "보다",
  "으로",
  "라는",
  "이란",
  "라고",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "로",
  "도",
  "만",
  "과",
  "와",
  "랑",
];

/** Two characters is where a needle stops being a flood. The beam's own rule. */
const MIN_WORD = 2;

/** Anything that is not a letter or a digit ends a word. */
const NOT_A_WORD = /[^\p{L}\p{N}]+/u;

const HANGUL = /[가-힣]/;

/**
 * The words in a question that are about the project.
 *
 * In the order they were typed, without duplicates, so the sentence the panel
 * writes back reads in the order the person wrote it.
 */
export function questionWords(question: string): string[] {
  const out: string[] = [];
  for (const raw of question.split(NOT_A_WORD)) {
    const word = raw.trim();
    if (word.length < MIN_WORD) continue;
    if (ASKING_WORDS.has(word.toLowerCase())) continue;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

/**
 * The same word with a trailing particle removed, or null when there is none
 * worth removing.
 *
 * Null rather than the word itself, so a caller can tell "there was nothing to
 * strip" from "stripping produced the same thing" — and so the two forms are
 * always offered to the beam as two needles rather than one.
 */
export function withoutParticle(word: string): string | null {
  if (!HANGUL.test(word)) return null;
  for (const particle of PARTICLES) {
    if (!word.endsWith(particle)) continue;
    const stem = word.slice(0, word.length - particle.length);
    // A one-character stem is a fragment, and a fragment lights the map rather
    // than pointing at something on it.
    if (stem.length < MIN_WORD) continue;
    return stem;
  }
  return null;
}

/** Places a route or endpoint before a piece of code, which is §2.3's order. */
function kindRank(kind: ItemKind): number {
  switch (kind) {
    case "route":
      return 0;
    case "api_endpoint":
      return 1;
    case "symbol":
      return 2;
    case "file":
      return 3;
    default:
      return 4;
  }
}

/**
 * How many behaviour connections leave each item, counted once for the graph.
 *
 * Once rather than per candidate: a typed question on this repository's own
 * map can match a hundred items across three thousand connections, and asking
 * the connection list a hundred times is the same work a hundred times.
 *
 * A route scores zero here and always will — that is §2.1's joint rule, the
 * route being a sibling of its page's pieces rather than their parent — which
 * is why kind outranks this and not the other way round.
 */
function leavingCounts(graph: FlowGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const connection of graph.connections) {
    if (!HOP_RELATIONS.has(connection.relation)) continue;
    counts.set(connection.from, (counts.get(connection.from) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether a walk may begin here at all.
 *
 * The same line `entryPointsOf` draws, read off the kind rather than by
 * resolving each candidate: a package is somebody else's code we never read,
 * and a feature is a grouping we made rather than something the code does.
 * Offering either would be offering a start whose only possible answer is a
 * refusal. Resolving properly would mean `indexFlowGraph` per candidate, which
 * is `O(V+E)` each, on a graph that can hold three thousand connections.
 */
function couldStart(kind: ItemKind): boolean {
  return kind === "route" || kind === "api_endpoint" || kind === "symbol" || kind === "file";
}

/**
 * Every place the typed question could start a flow, best first.
 *
 * Ranked lexicographically, the way `flow.ts` ranks its hops and for the same
 * reason — a weighted sum is where arbitrary constants hide and where a test
 * cannot tell you which criterion fired:
 *
 *   1. **How many of the question's words landed here.** Two words pointing at
 *      one place is a stronger statement than one word pointing at two.
 *   2. **What kind of place it is.** A route is the only item kind in the graph
 *      a non-developer already reads as a place (§2.3), so `/checkout` wins
 *      over a function called `checkout` that it holds.
 *   3. **How much leaves it**, descending. A start with nothing leaving it can
 *      only produce a refusal, and there is usually a sibling that cannot.
 *   4. **Name, then id.** So the same question over an unchanged graph gives
 *      the same answer twice — the promise `load.ts`, `layout.ts`, `grouping.ts`
 *      and `flow.ts` all make.
 */
export function startsForQuestion(
  graph: FlowGraph,
  index: BeamIndex,
  question: string,
): FlowChoice[] {
  const words = questionWords(question);
  if (words.length === 0) return [];

  /** Which of the question's words landed on each item. */
  const landed = new Map<string, string[]>();

  for (const word of words) {
    const needles = [word];
    const stem = withoutParticle(word);
    if (stem !== null) needles.push(stem);

    const hit = new Set<string>();
    for (const needle of needles) {
      // The map's beam, unchanged. Two needles for one typed word is still one
      // word landing — hence the set.
      for (const id of runBeam(index, needle).matched) hit.add(id);
    }

    for (const id of hit) {
      const list = landed.get(id);
      if (list) list.push(word);
      else landed.set(id, [word]);
    }
  }

  /*
   * A word that matched a feature is expanded into the addresses inside it.
   *
   * Built lazily: `flowsByFeature` walks the whole connection list, and a
   * question that matched no feature — which is most of them — should not pay
   * for it.
   */
  let groups: FlowGroup[] | null = null;
  const startsInFeature = (feature: GraphItem): GraphItem[] => {
    groups ??= flowsByFeature(graph);
    return groups.find((group) => group.feature?.id === feature.id)?.starts ?? [];
  };

  const candidates: FlowChoice[] = [];
  const seen = new Set<string>();

  const offer = (item: GraphItem, hitWords: string[], via: GraphItem | null) => {
    if (!couldStart(item.kind)) return;
    if (seen.has(item.id)) return;
    seen.add(item.id);
    candidates.push({ item, origin: "typed", hits: hitWords.length, words: hitWords, others: 0, via });
  };

  // Two passes, and the order is the point: a place the words named directly
  // beats the same place reached through a feature's name, so it is offered
  // first and `offer` will not overwrite it with the inherited version.
  for (const item of graph.items) {
    const hitWords = landed.get(item.id);
    if (!hitWords || item.kind === "feature") continue;
    offer(item, hitWords, null);
  }
  for (const item of graph.items) {
    const hitWords = landed.get(item.id);
    if (!hitWords || item.kind !== "feature") continue;
    for (const start of startsInFeature(item)) offer(start, hitWords, item);
  }

  const leavingOf = leavingCounts(graph);

  candidates.sort(
    (a, b) =>
      b.hits - a.hits ||
      kindRank(a.item.kind) - kindRank(b.item.kind) ||
      (leavingOf.get(b.item.id) ?? 0) - (leavingOf.get(a.item.id) ?? 0) ||
      (a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0) ||
      (a.item.id < b.item.id ? -1 : 1),
  );

  const others = Math.max(candidates.length - 1, 0);
  return candidates.map((candidate) => ({ ...candidate, others }));
}

/** The project's flows, gathered under the feature each one belongs to. */
export type FlowGroup = {
  /** Null for the flows no feature claims, and for a project with no features. */
  feature: GraphItem | null;
  starts: GraphItem[];
};

/**
 * Every flow the project offers, grouped by feature where there are features.
 *
 * `FLOW_TRACKING.md` §3 planned for features to arrive later and they have:
 * Pass 2 writes `feature` rows now, and production holds eight on this
 * repository. §9's Phase 5 says what a feature is then worth — "its entry
 * points are the routes and endpoints that `belongs_to` it, and the walk is
 * unchanged" — and that is exactly what this does. **One new entry rule, no new
 * algorithm**: the flows offered are still routes and endpoints, still walked
 * by `traceFlow` with nothing passed differently. A feature is a heading over
 * them and never a start, because `entryPointsOf` refuses a feature on purpose
 * — a grouping we made is not something the code does, and offering one as a
 * start would put a button on screen whose only answer is a refusal.
 *
 * **Direction is not assumed.** `belongs_to` is written member → feature, and
 * the feature is found by looking at which end *is* a feature — the same rule
 * `grouping.ts#byFeature` states, because a reversed edge should put nothing
 * anywhere rather than quietly putting the feature inside the file.
 *
 * **The claim is inherited through `contains`, which is D52.** Pass 2 is asked
 * about files, so a `belongs_to` hangs off the file and not off the route node
 * inside it. Reading only the route's own edges would find a feature for
 * approximately nothing.
 */
export function flowsByFeature(graph: FlowGraph): FlowGroup[] {
  const byId = new Map(graph.items.map((item) => [item.id, item]));

  const featureOf = new Map<string, GraphItem>();
  const fileOf = new Map<string, string>();

  for (const connection of graph.connections) {
    if (connection.relation === "contains") {
      if (byId.get(connection.from)?.kind === "file") fileOf.set(connection.to, connection.from);
      continue;
    }
    if (connection.relation !== "belongs_to") continue;
    const from = byId.get(connection.from);
    const to = byId.get(connection.to);
    if (from?.kind === "feature" && to) featureOf.set(to.id, from);
    else if (to?.kind === "feature" && from) featureOf.set(from.id, to);
  }

  const groups = new Map<string, FlowGroup>();
  const loose: GraphItem[] = [];

  for (const start of projectEntryPoints(graph)) {
    const owner =
      featureOf.get(start.id) ?? featureOf.get(fileOf.get(start.id) ?? "") ?? null;
    if (!owner) {
      loose.push(start);
      continue;
    }
    const group = groups.get(owner.id);
    if (group) group.starts.push(start);
    else groups.set(owner.id, { feature: owner, starts: [start] });
  }

  // By the feature's own name, then its id: the same total order everything
  // else in this product sorts by, so two readings of one graph list the
  // project's flows in the same order.
  const named = [...groups.values()].sort((a, b) => {
    const left = a.feature?.label ?? a.feature?.name ?? "";
    const right = b.feature?.label ?? b.feature?.name ?? "";
    return left < right ? -1 : left > right ? 1 : (a.feature?.id ?? "") < (b.feature?.id ?? "") ? -1 : 1;
  });

  // The unclaimed ones last and never dropped. A flow the naming pass did not
  // reach is still a flow, and a list that silently omitted it would be telling
  // someone their project has fewer ways in than it has.
  if (loose.length > 0) named.push({ feature: null, starts: loose });
  return named;
}

/** The project's own entry points, as choices the discovery block can offer. */
export function listedStarts(graph: FlowGraph): FlowChoice[] {
  return projectEntryPoints(graph).map((item) => ({
    item,
    origin: "listed" as const,
    hits: 0,
    words: [],
    others: 0,
    via: null,
  }));
}

/**
 * Why a project offers no flows at all, or null when it offers some.
 *
 * **This is the primary path, not the error path.** Measured against
 * production on 2026-09-21: three of the four real projects — a Streamlit app,
 * an OpenCV tray app and a static site — have no entry point whatsoever, so
 * §7's first refusal is what most people meet first, and it is written to be
 * acted on rather than apologised with.
 *
 * The order is `traceFlow`'s own, and the order matters: a project whose every
 * connection is an `imports` has a more specific thing wrong with it than "we
 * found no address", and saying the vaguer one first would send someone looking
 * for a page they do not have when the real answer is that we did not read
 * their code deeply enough to follow anything anywhere.
 */
export function discoveryRefusal(graph: FlowGraph): FlowRefusal | null {
  let behaviour = 0;
  let imports = 0;
  for (const connection of graph.connections) {
    if (HOP_RELATIONS.has(connection.relation)) behaviour += 1;
    else if (connection.relation === "imports") imports += 1;
  }

  if (behaviour === 0 && imports > 0) return "no-behaviour";
  if (projectEntryPoints(graph).length === 0) return "no-entry-point";
  return null;
}

/** How many `imports` the project has. §7's shallow-analyzer sentence says it. */
export function importCountOf(graph: FlowGraph): number {
  let imports = 0;
  for (const connection of graph.connections) {
    if (connection.relation === "imports") imports += 1;
  }
  return imports;
}

/**
 * How sure we are that the **start itself** is there.
 *
 * Not the same question as how sure we are of the path, and on a real project
 * it is the one that gets missed. A Next.js address is the file system —
 * `app/checkout/page.tsx` is `/checkout` and there is no other possibility — so
 * `routes.ts` writes it `certain`. A Streamlit address is not: which pages
 * exist depends on which script somebody ran, `streamlit run dashboard.py`,
 * and that is a command line rather than a file in the repository. So
 * `python/streamlit.ts` writes every one of its routes `inferred`, and
 * production holds three of them today.
 *
 * The walk cannot say this, and deliberately: the entry joint is `certain`
 * because reversing a `contains` is a structural fact rather than a claim, and
 * that is the right answer to the question the joint is asking. It leaves this
 * one unasked, which is why the panel asks it here — off the `contains` edge
 * that holds the item, the same edge the map draws hatched.
 *
 * `certain` for anything with no holder at all: a symbol the parser read out of
 * a file it opened is not a guess for having no `contains` recorded.
 */
export function startCertainty(graph: FlowGraph, itemId: string): Certainty {
  for (const connection of graph.connections) {
    if (connection.relation !== "contains") continue;
    if (connection.to !== itemId) continue;
    return connection.certainty;
  }
  return "certain";
}

/**
 * Said when the address we are starting from is itself a guess.
 *
 * Never about one framework by name — the panel has no business knowing what
 * Streamlit is, and the next analyzer that has to guess an address will hit
 * exactly this sentence. It says what we did (read the convention) and what we
 * therefore cannot promise (that this is the address).
 */
export const GUESSED_START_NOTE =
  "이 주소가 있다는 것부터가 짐작이에요. 파일이 놓인 모양을 보고 주소를 읽어낸 거라, " +
  "딱 이 주소로 열린다고는 말씀드리지 못해요.";

/** The weaker of two, which is the only honest way to combine them. */
export function weaker(a: Certainty, b: Certainty): Certainty {
  return a === "inferred" || b === "inferred" ? "inferred" : "certain";
}

/** Which spine a start sits on, in `flow.ts`'s vocabulary. */
export function spineOf(item: GraphItem): FlowSpine {
  return item.kind === "route" || item.kind === "api_endpoint" ? "route" : "selection";
}

/**
 * Why the walk began where it began, said out loud.
 *
 * Two sentences at most, and the second one is §3's: a route's name is its
 * address, `/checkout` reads as 결제 to the person who built it, and saying
 * where the name came from is the same move `grouping.ts` makes with
 * `folder: "직접 붙인 이름"` against `"기능"`. A name we took off an address is
 * not a name anybody chose, and the difference is the user's to know.
 *
 * Every sentence here is checked by `flowSentenceIssues` in the tests: 실행 ·
 * 추적 · 실시간 · 안전 · 노드 · 엣지 appear in none of them.
 */
export function startNote(choice: FlowChoice): string {
  const parts: string[] = [];

  switch (choice.origin) {
    case "typed": {
      /*
       * `…라는 말로`, and never `${word}로`.
       *
       * The particle would have to be 로 or 으로 depending on the last sound of
       * the word, and the words here are whatever somebody typed — 결제가, ㄱㅁ,
       * `rnao`, `PayButton`. `flow.ts` states the rule this follows: a name we
       * did not choose never takes a particle in these sentences, because there
       * is no honest way to pick one for `stripe` without knowing how the
       * reader says it. A noun goes after the name instead, and 말 carries the
       * particle — which is always 로, because 말 ends in ㄹ.
       */
      const said = choice.words.map((word) => `"${word}"`).join(", ");
      if (choice.via) {
        // The word named a feature, and a feature is a heading rather than a
        // place. Saying so is the same move §3 makes about a route's name: a
        // name inherited from somewhere else is not a name this thing has.
        const feature = choice.via.label ?? choice.via.name;
        parts.push(`적어 주신 ${said}라는 말로 찾은 "${feature}" 기능에 속한 자리예요.`);
      } else {
        parts.push(`적어 주신 ${said}라는 말로 찾은 자리에서부터 따라가요.`);
      }
      if (choice.others > 0) {
        parts.push(`같은 말로 찾은 자리가 ${choice.others}곳 더 있어요.`);
      }
      break;
    }
    case "selection":
      parts.push("지도에서 고르신 자리에서부터 따라가요.");
      break;
    case "listed":
      parts.push("이 프로젝트가 가진 주소 중 하나예요.");
      break;
  }

  if (choice.item.kind === "route" || choice.item.kind === "api_endpoint") {
    parts.push("이 이름은 주소에서 가져왔어요.");
  }

  return parts.join(" ");
}
