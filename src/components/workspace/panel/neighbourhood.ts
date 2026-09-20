import type {
  Certainty,
  ConnectionRelation,
  GraphConnection,
  GraphItem,
} from "@/lib/graph/view";

/**
 * What sits around one item on the map.
 *
 * Pure on purpose: the panel renders it, the graph tab draws it, and Step 4's
 * prompt builder needs the same answer with the same cap, so it cannot live
 * inside a component.
 *
 * Three rules are load-bearing here, and each one is a way this module could
 * quietly tell someone something false about their own code:
 *
 *   1. **A walk never changes direction.** "What this uses" follows links
 *      outward only; "what uses this" follows them inward only. If a two-hop
 *      walk were allowed to turn around, A and C would appear connected
 *      because both happen to touch B — which is not a fact about anyone's
 *      code, and the user has no way to tell the difference.
 *   2. **Certainty is the weakest link on the path.** A certain hop followed
 *      by a guessed one is a guess. Reporting the last hop, or the first,
 *      would launder a guess into a fact at depth 2.
 *   3. **The cap is reported, never silent.** A list that stops at 24 with no
 *      note reads as "that is all there is", which on this product is a false
 *      statement about someone's code. `hidden` exists so the panel has to say
 *      it out loud.
 */

/** Which way the link points, relative to the item in hand. */
export type NeighbourDirection = "uses" | "used-by";

export type Neighbour = {
  item: GraphItem;
  direction: NeighbourDirection;
  /** 1 is next door. Never larger than the requested depth. */
  hops: number;
  /**
   * The relation on the hop that touches THIS item — the far end of the walk.
   * With `via` it reads as one sentence: "by way of Button.tsx, uses it".
   */
  relation: ConnectionRelation;
  /** Weakest certainty along the whole path. This is what the user reads. */
  certainty: Certainty;
  /**
   * Certainty of the far hop alone. Only the graph tab wants this: it draws
   * one line per hop, and that line is either solid or hatched on its own
   * merits. Never show this as a label — rule 2 above.
   */
  hopCertainty: Certainty;
  /**
   * What the far hop is *for*, in a sentence, when Pass 3 wrote one.
   *
   * Off the same connection `hopCertainty` comes from, and for the same
   * reason: it is a fact about that one link, not about the chain that reached
   * it. 사용해요 is true of every `calls` edge in the project and says almost
   * nothing; 여기서 가격을 사람이 읽는 모양으로 바꿔요 is the same fact worth
   * reading.
   *
   * Optional, and the relation's verb stays as the fallback everywhere it is
   * read — a project that has never run Pass 3, or one where the model declined
   * this group, loses nothing it had. `flow.ts` makes the same substitution in
   * `hopSentence` with the same fallback, so the panel and the walk say one
   * thing about one edge.
   */
  purpose?: string;
  /** The item one step closer to the selection. Null at one hop. */
  via: GraphItem | null;
};

export type Neighbourhood = {
  selected: GraphItem;
  /** The depth actually walked, after clamping. */
  hops: number;
  uses: Neighbour[];
  usedBy: Neighbour[];
  /** How many exist within this depth, before the cap. */
  found: { uses: number; usedBy: number };
  /** How many the cap left out. The panel must say this. */
  hidden: { uses: number; usedBy: number };
  /**
   * The headline: how many separate places use this, and how many of those are
   * pages someone can visit.
   *
   * Counted BEFORE the cap, and that is the whole reason it lives here rather
   * than being derived from `usedBy` by whoever renders it. Counting the rows
   * on screen would have a helper used in thirty places announce itself as
   * "24곳에서 쓰여요" — a smaller number than the truth, in the one sentence
   * this product is sold on.
   */
  reach: { places: number; pages: number };
};

export const MIN_HOPS = 1;
/**
 * Six, not three.
 *
 * The control is now a number someone types, so the ceiling is no longer set by
 * how many buttons fit. It is still a ceiling: on a connected graph the reach
 * doubles at every step, and past five or six you have selected the whole
 * project, which answers nothing. The result cap and its "N개는 줄였어요" line
 * are what actually protect the panel; this just stops a typo asking for 900.
 */
export const MAX_HOPS = 6;
export const DEFAULT_HOPS = 1;

/**
 * Per direction, not in total, so a file with forty things inside it does not
 * push out the two places that use it — those two are the answer to the
 * question the user actually asked.
 */
export const DEFAULT_LIMIT = 24;

export type NeighbourhoodInput = {
  items: readonly GraphItem[];
  connections: readonly GraphConnection[];
};

export type NeighbourhoodOptions = {
  hops?: number;
  limit?: number;
};

export function buildNeighbourhood(
  graph: NeighbourhoodInput,
  selectedId: string,
  options: NeighbourhoodOptions = {},
): Neighbourhood | null {
  const itemsById = new Map<string, GraphItem>();
  for (const item of graph.items) itemsById.set(item.id, item);

  const selected = itemsById.get(selectedId);
  if (!selected) return null;

  const hops = clamp(Math.trunc(options.hops ?? DEFAULT_HOPS), MIN_HOPS, MAX_HOPS);
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT));

  const outgoing = new Map<string, GraphConnection[]>();
  const incoming = new Map<string, GraphConnection[]>();
  for (const connection of graph.connections) {
    // A link to something that is not on the map cannot be drawn or named, and
    // a row with a blank name is worse than no row.
    if (!itemsById.has(connection.from) || !itemsById.has(connection.to)) continue;
    append(outgoing, connection.from, connection);
    append(incoming, connection.to, connection);
  }

  const uses = walk("uses", outgoing, itemsById, selected, hops);
  const usedBy = walk("used-by", incoming, itemsById, selected, hops);

  // Counted on the full walk, not on what survives the cap.
  const places = usedBy.filter(isAPlaceUsingIt);
  const pages = places.filter((neighbour) => neighbour.item.kind === "route");

  return {
    selected,
    hops,
    uses: uses.slice(0, limit),
    usedBy: usedBy.slice(0, limit),
    found: { uses: uses.length, usedBy: usedBy.length },
    hidden: {
      uses: Math.max(0, uses.length - limit),
      usedBy: Math.max(0, usedBy.length - limit),
    },
    reach: { places: places.length, pages: pages.length },
  };
}

/**
 * `contains` is excluded deliberately: the file a component is written in is
 * where it LIVES, not a place that uses it, and counting it would inflate every
 * symbol on the map by one.
 */
function isAPlaceUsingIt(neighbour: Neighbour): boolean {
  return neighbour.hops === 1 && neighbour.relation !== "contains";
}

function walk(
  direction: NeighbourDirection,
  links: Map<string, GraphConnection[]>,
  itemsById: Map<string, GraphItem>,
  selected: GraphItem,
  maxHops: number,
): Neighbour[] {
  const found = new Map<string, Neighbour>();
  let frontier: GraphItem[] = [selected];
  // Carries the weakest certainty seen on the way to each frontier item.
  let frontierCertainty = new Map<string, Certainty>([[selected.id, "certain"]]);

  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop += 1) {
    const nextFrontier: GraphItem[] = [];
    const nextCertainty = new Map<string, Certainty>();

    for (const from of frontier) {
      const soFar = frontierCertainty.get(from.id) ?? "certain";

      for (const connection of links.get(from.id) ?? []) {
        const otherId = direction === "uses" ? connection.to : connection.from;
        // A link that loops back to the selection is not a neighbour of it.
        if (otherId === selected.id) continue;
        const item = itemsById.get(otherId);
        if (!item) continue;

        const certainty = weakest(soFar, connection.certainty);
        const existing = found.get(otherId);

        // Shortest path wins; at equal length, the one we are surer of wins.
        if (existing && existing.hops < hop) continue;
        if (existing && existing.hops === hop && !isStronger(certainty, existing.certainty)) {
          continue;
        }

        found.set(otherId, {
          item,
          direction,
          hops: hop,
          relation: connection.relation,
          certainty,
          hopCertainty: connection.certainty,
          // Absent rather than null when there is none, so there is exactly
          // one way to say "no sentence" — the same rule `GraphConnection.line`
          // follows one file over.
          ...(connection.purpose ? { purpose: connection.purpose } : {}),
          via: hop === 1 ? null : from,
        });

        // Expand from the first arrival only; a later, longer path to the same
        // item would re-walk ground the shorter one already covered.
        if (!existing) nextFrontier.push(item);
        const known = nextCertainty.get(otherId);
        if (!known || isStronger(certainty, known)) nextCertainty.set(otherId, certainty);
      }
    }

    frontier = nextFrontier;
    frontierCertainty = nextCertainty;
  }

  return [...found.values()].sort(compareNeighbours);
}

/**
 * Nearest first, then what we are sure of, then the busiest item, then by
 * name. Fully deterministic: the same selection must read the same way every
 * time it is opened, or the list stops being something a person can learn.
 */
function compareNeighbours(a: Neighbour, b: Neighbour): number {
  if (a.hops !== b.hops) return a.hops - b.hops;
  if (a.certainty !== b.certainty) return a.certainty === "certain" ? -1 : 1;

  const aDegree = a.item.uses + a.item.usedBy;
  const bDegree = b.item.uses + b.item.usedBy;
  if (aDegree !== bDegree) return bDegree - aDegree;

  // Not localeCompare: its ordering depends on the machine's collation, and
  // two environments disagreeing about the order of a list is a bug we would
  // only ever see in a screenshot.
  if (a.item.name !== b.item.name) return a.item.name < b.item.name ? -1 : 1;
  return a.item.id < b.item.id ? -1 : 1;
}

function weakest(a: Certainty, b: Certainty): Certainty {
  return a === "inferred" || b === "inferred" ? "inferred" : "certain";
}

function isStronger(a: Certainty, b: Certainty): boolean {
  return a === "certain" && b === "inferred";
}

function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function append(
  map: Map<string, GraphConnection[]>,
  key: string,
  connection: GraphConnection,
): void {
  const list = map.get(key);
  if (list) list.push(connection);
  else map.set(key, [connection]);
}

/** True when nothing at all came back, at any depth, in either direction. */
export function isAlone(neighbourhood: Neighbourhood): boolean {
  return neighbourhood.found.uses === 0 && neighbourhood.found.usedBy === 0;
}
