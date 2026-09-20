import type { GraphConnection, GraphItem } from "@/lib/graph/view";

import type { Catalog } from "./catalog";
import { normalisePath } from "./source";
import type { QaGraph, RevealedHop } from "./tools";
import type { Citation, Finding, QaTrail, TrailHop, TrailPoint } from "./types";

/**
 * Turning what the loop did into something the map can draw.
 *
 * The founder asked to see the graph being walked, and only the points the
 * answer stands on. Both halves of that are already decided elsewhere in this
 * module and this file is where the two are put on top of each other: the tools
 * say which items each result put the loop in front of, the citation check says
 * which claims survived, and a point is critical exactly when a surviving claim
 * cites it.
 *
 * Nothing here consults a model, reads a file or looks at the ledger. It is a
 * fold over things already established, which is what makes "same question,
 * same graph, same replies, byte-identical trail" a property rather than a
 * hope.
 *
 * The one thing it is careful not to do is make the picture tidier than the
 * investigation was. A search that landed nowhere near the previous step really
 * was a restart; two points with no connection between them really have no
 * connection; a place that was opened and abandoned really is not part of the
 * answer. Every one of those would look better smoothed over, and every one of
 * them would be the picture agreeing with the answer more than the evidence
 * does.
 */

/** One step's worth of what the tools revealed, in the order they revealed it. */
export type TrailStep = {
  step: number;
  items: readonly string[];
  hops: readonly RevealedHop[];
};

export type TrailInput = {
  graph: QaGraph;
  catalog: Catalog;
  steps: readonly TrailStep[];
  /** Only the ones that survived checking. Refused claims mark nothing. */
  findings: readonly Finding[];
};

export const EMPTY_TRAIL: QaTrail = { points: [], hops: [], unplaced: [] };

export function buildTrail(input: TrailInput): QaTrail {
  const byId = new Map<string, GraphItem>();
  for (const item of input.graph.items) byId.set(item.id, item);

  const links = new Map<string, GraphConnection[]>();
  for (const connection of input.graph.connections) {
    append(links, connection.from, connection);
    append(links, connection.to, connection);
  }

  const points: TrailPoint[] = [];
  const placed = new Map<string, TrailPoint>();
  const hops: TrailHop[] = [];
  const drawn = new Set<string>();
  let leg = 0;

  for (const step of input.steps) {
    const fresh = step.items.filter((id) => !placed.has(id) && byId.has(id));
    if (fresh.length === 0) {
      // A step that only re-showed places already on the walk is not a restart
      // and not a new leg. It happened, and the trace records it; the trail has
      // nothing to add.
      recordHops(step, hops, drawn, placed, "opened");
      continue;
    }

    /*
     * Did this step continue the walk, or start again somewhere else?
     *
     * Asked once per step rather than once per point, because a search that
     * returns ten results is one landing with ten things in view — scoring each
     * result separately would turn a single restart into nine of them and make
     * the picture read as a scatter.
     *
     * "Continued" is a fact about the graph, not about the model's intent: this
     * step touched something the previous walk is connected to. It deliberately
     * does not require that the loop crossed that link — see `via` on a hop for
     * where that distinction is kept.
     */
    const continues =
      points.length > 0 &&
      (fresh.some((id) => connectionInto(links, id, placed) !== null) ||
        step.items.some((id) => placed.has(id)));

    if (!continues) leg += 1;

    for (const id of fresh) {
      /*
       * How this point was reached, in the order the answer is most true.
       *
       * A link the step itself crossed beats one merely found in the graph,
       * because it is what happened. Checked first for a reason that is easy to
       * miss: `open_item` reveals the item it stood on AND its neighbours in a
       * single step, so both are fresh here and the graph lookup below would
       * find the very same connection and label it `adjacent` — a traversal
       * recorded as a coincidence. The deduplication in `addHop` would then
       * keep that first, wrong label, and `opened` would almost never appear.
       *
       * Found before the point is added, so a point cannot be its own entrance.
       */
      const walked = hopInto(step.hops, id, placed);
      const entrance = walked ?? asRevealed(connectionInto(links, id, placed));
      const point: TrailPoint = {
        id,
        number: input.catalog.numberOf(id) ?? 0,
        step: step.step,
        leg,
        critical: false,
      };
      points.push(point);
      placed.set(id, point);

      if (entrance) {
        addHop(hops, drawn, {
          ...entrance,
          step: step.step,
          via: walked ? "opened" : "adjacent",
        });
      }
    }

    // After the points, so a hop can never name an end that is not on the walk.
    recordHops(step, hops, drawn, placed, "opened");
  }

  const unplaced = markCritical(input.findings, points, byId);
  return { points, hops, unplaced };
}

/**
 * The links the step itself walked.
 *
 * Added after the step's points so that both ends are already on the trail. A
 * hop whose end is missing is dropped rather than drawn: the map would have
 * nothing to attach it to, and an edge hanging off the picture is worse than a
 * missing one.
 */
function recordHops(
  step: TrailStep,
  hops: TrailHop[],
  drawn: Set<string>,
  placed: Map<string, TrailPoint>,
  via: TrailHop["via"],
): void {
  for (const hop of step.hops) {
    if (!placed.has(hop.from) || !placed.has(hop.to)) continue;
    addHop(hops, drawn, { ...hop, step: step.step, via });
  }
}

/**
 * First in, kept.
 *
 * A connection reached twice — opened from one end and then from the other — is
 * one line on the map either way, and the first crossing is the one that
 * happened first. Keeping both would make a two-step detour look like two
 * different links.
 */
function addHop(hops: TrailHop[], drawn: Set<string>, hop: TrailHop): void {
  if (drawn.has(hop.connectionId)) return;
  drawn.add(hop.connectionId);
  hops.push(hop);
}

/**
 * The link this step itself crossed to arrive at a new point, if any.
 *
 * Only `open_item` reports hops, so this is the walk in the strict sense: the
 * loop stood on one item and was handed what the graph joins it to. The other
 * end has to be on the trail already — a hop between two points that both
 * arrive in this step is ordered, and the one placed first is the one that was
 * stood on.
 *
 * First match wins. A pair joined twice is one line on the map either way, and
 * unlike the graph lookup below there is nothing to prefer between them: both
 * were crossed in the same step, by the same tool, at the same moment.
 */
function hopInto(
  stepHops: readonly RevealedHop[],
  id: string,
  placed: Map<string, TrailPoint>,
): RevealedHop | null {
  for (const hop of stepHops) {
    if (hop.from === hop.to) continue;
    if (hop.to === id && placed.has(hop.from)) return hop;
    if (hop.from === id && placed.has(hop.to)) return hop;
  }
  return null;
}

function asRevealed(connection: GraphConnection | null): RevealedHop | null {
  return connection === null
    ? null
    : {
        connectionId: connection.id,
        from: connection.from,
        to: connection.to,
        relation: connection.relation,
        certainty: connection.certainty,
      };
}

/**
 * The link by which a new point joins what is already there, if any.
 *
 * `certain` before `inferred`, then graph order. Two items can be linked more
 * than once and one line has to be chosen; drawing a guess where a known
 * connection also exists would make the walk look weaker than it is. The trail
 * says a link exists, never that it is the only one — the map holds the rest
 * and can draw them itself.
 */
function connectionInto(
  links: Map<string, GraphConnection[]>,
  id: string,
  placed: Map<string, TrailPoint>,
): GraphConnection | null {
  let best: GraphConnection | null = null;
  for (const connection of links.get(id) ?? []) {
    const other = connection.from === id ? connection.to : connection.from;
    // A self-link joins nothing to anything.
    if (other === id) continue;
    if (!placed.has(other)) continue;
    if (best === null) best = connection;
    else if (best.certainty === "inferred" && connection.certainty === "certain") {
      best = connection;
    }
  }
  return best;
}

/**
 * Which points the answer stands on.
 *
 * A citation is a path and a line range; the map lights items. The resolution
 * is the narrowest point on the trail whose own range contains that citation —
 * so a claim about line 7 of `format.ts` marks `formatPrice`, not the file, if
 * `formatPrice` is on the walk. The file is the fallback, because a file
 * genuinely is where the lines are and lighting the file is a smaller claim
 * than lighting the wrong piece inside it.
 *
 * Only points already on the trail are eligible. A citation that resolves to
 * nothing on the walk is returned as `unplaced` rather than quietly adding a
 * point: the trail is an account of where the loop was, and a place it reached
 * by no step is not one of them. In practice this is rare — a citation has
 * already been checked against the ledger, and every tool that writes a ledger
 * entry also reveals the item it came from — so a non-empty `unplaced` is worth
 * looking at rather than tolerating.
 */
function markCritical(
  findings: readonly Finding[],
  points: readonly TrailPoint[],
  byId: Map<string, GraphItem>,
): Citation[] {
  const unplaced: Citation[] = [];

  for (const finding of findings) {
    for (const citation of finding.citations) {
      const point = resolve(citation, points, byId);
      if (point) point.critical = true;
      else unplaced.push(citation);
    }
  }

  return unplaced;
}

function resolve(
  citation: Citation,
  points: readonly TrailPoint[],
  byId: Map<string, GraphItem>,
): TrailPoint | null {
  const path = normalisePath(citation.path);
  let best: { point: TrailPoint; span: number } | null = null;
  let file: TrailPoint | null = null;

  for (const point of points) {
    const item = byId.get(point.id);
    if (!item || !item.path || normalisePath(item.path) !== path) continue;

    if (item.startLine === null) {
      // The file itself. First one wins; a project has one item per path.
      if (item.kind === "file" && file === null) file = point;
      continue;
    }

    const end = item.endLine ?? item.startLine;
    if (item.startLine > citation.startLine || end < citation.endLine) continue;

    const span = end - item.startLine;
    // Narrowest wins, and on a tie the one reached first — which is trail order
    // and therefore the same on every run.
    if (best === null || span < best.span) best = { point, span };
  }

  return best?.point ?? file;
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const held = map.get(key);
  if (held) held.push(value);
  else map.set(key, [value]);
}
