import type {
  Certainty,
  ConnectionRelation,
  GraphConnection,
  GraphItem,
} from "@/lib/graph/view";
/*
 * The one ranking, imported rather than restated.
 *
 * It used to be a private copy here with the same seven numbers in it, and
 * `flow.ts` now reads the same order to decide which way a walk turns. Two
 * rankings for one idea is exactly the D69 failure — `usedBy` counted one way
 * in `load.ts` and another in the panel, and the product told someone `kv` was
 * used in 7 places where the parser had measured 6. `flow.test.ts` pins this by
 * measuring the order `buildLinks` actually sorts into, so a drift between the
 * map and the walk now fails a test instead of quietly disagreeing on screen.
 */
import { RELATION_RANK } from "@/lib/graph/view";

import type { BeamResult } from "../beam";
import type { GroupingOption } from "../grouping";
import { HUB_MIN_MEMBERS, type MapLayout } from "../layout";

/**
 * Everything the map needs to know about a graph before it can draw one frame,
 * worked out once and then read on every frame.
 *
 * Pure, and in its own file for the same reason `layout.ts` is: these are
 * *rules* — what counts as connected, what counts as lit, which thing in a
 * territory is its centre — and a rule that lives inside a draw call cannot be
 * tested, only looked at.
 *
 * Nothing here reads a clock, a random number, the DOM or the camera.
 */

/** One drawn line between two items. Directed, because the direction is the fact. */
export type MapLink = {
  from: string;
  to: string;
  relation: ConnectionRelation;
  certainty: Certainty;
  /**
   * Screen pixels to slide the line sideways.
   *
   * Two items can be connected twice — a file that both imports and calls into
   * another is two different true statements — and drawing them on top of each
   * other would show one line with one word on it, which is a third statement
   * that is not true. They are laid in lanes instead, the same way the roads
   * between territories keep 확실해요 and 짐작이에요 apart rather than averaging
   * them into one stroke.
   */
  lane: number;
  /**
   * Which links get their words first when there is not room for every one.
   * Lower is said sooner. Fixed per link, which is what stops the set of
   * labelled links changing as the map is panned.
   */
  rank: number;
  /** True when the two ends live in different territories. */
  crossing: boolean;
};

/** Screen pixels between two lanes. Just wide enough to read as two lines at 11px text. */
const LANE_STEP = 3.4;

/** What the map dims to. Never zero — D59: a map that goes black says the project vanished. */
export const DIM = 0.3;

/**
 * A key for a pair of items.
 *
 * JSON rather than a joined string, which is D42: any separator has to be a
 * character that cannot appear in an id, which means a control character, and
 * this codebase has now twice had a control character rewritten in transit into
 * something that silently collides. JSON encodes the boundary structurally.
 */
function pairKey(a: string, b: string): string {
  return a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);
}

/**
 * Every connection that can actually be drawn, in one flat array.
 *
 * Flat rather than the adjacency map the renderer used to walk, because the
 * draw loop runs this list once per frame and a map of arrays costs an
 * allocation-free but pointer-chasing iteration per item — measured as the
 * single largest line item in a full repaint on a 300-item project.
 */
export function buildLinks(
  items: readonly GraphItem[],
  connections: readonly GraphConnection[],
  layout: MapLayout,
): MapLink[] {
  const degree = new Map<string, number>();
  for (const item of items) degree.set(item.id, item.usedBy + item.uses);

  const drawable: {
    from: string;
    to: string;
    relation: ConnectionRelation;
    certainty: Certainty;
    crossing: boolean;
    weight: number;
  }[] = [];

  for (const connection of connections) {
    const from = layout.byItemId.get(connection.from);
    const to = layout.byItemId.get(connection.to);
    // A connection to something that is not on the map cannot be drawn, and a
    // line to nowhere is worse than no line.
    if (!from || !to) continue;
    if (connection.from === connection.to) continue;
    drawable.push({
      from: connection.from,
      to: connection.to,
      relation: connection.relation,
      certainty: connection.certainty,
      crossing: from.districtId !== to.districtId,
      weight: (degree.get(connection.from) ?? 0) + (degree.get(connection.to) ?? 0),
    });
  }

  // A total order, so a run that streams its connections in a different order
  // still produces the identical picture — the same promise `layout.ts` makes.
  drawable.sort((a, b) => {
    const byRelation = RELATION_RANK[a.relation] - RELATION_RANK[b.relation];
    if (byRelation !== 0) return byRelation;
    if (a.weight !== b.weight) return b.weight - a.weight;
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0;
  });

  const perPair = new Map<string, number>();
  for (const link of drawable) {
    const key = pairKey(link.from, link.to);
    perPair.set(key, (perPair.get(key) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return drawable.map((link, rank) => {
    const key = pairKey(link.from, link.to);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const total = perPair.get(key) ?? 1;
    return {
      from: link.from,
      to: link.to,
      relation: link.relation,
      certainty: link.certainty,
      crossing: link.crossing,
      rank,
      lane: (index - (total - 1) / 2) * LANE_STEP,
    };
  });
}

/** Who is one step from whom, both ways, for lighting a selection's neighbourhood. */
export function buildAdjacency(
  links: readonly MapLink[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const list = map.get(from);
    if (!list) map.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const link of links) {
    add(link.from, link.to);
    add(link.to, link.from);
  }
  return map;
}

export type Focus = {
  id: string | null;
  /** The focused item and everything one step from it. Empty when nothing is focused. */
  lit: ReadonlySet<string>;
};

export const NO_FOCUS: Focus = { id: null, lit: new Set<string>() };

/**
 * What stays bright when something is selected.
 *
 * **One hop, and not a number of our own.** The connections panel beside this
 * map already asks the user how far to look and already defaults to one
 * (`DEFAULT_HOPS`), so the map lighting one hop means the picture and the list
 * are answering the same question with the same answer. A second, private idea
 * of "near" would put two different neighbourhoods on screen at once with
 * nothing to tell the user which is which — the same failure D69 fixed when the
 * panel said 7곳 and the parser had measured 6.
 *
 * One hop is also the honest depth. At two hops a connected project is mostly
 * lit, which is not a selection; it is the map with extra steps.
 */
export function focusOf(
  id: string | null,
  adjacency: ReadonlyMap<string, readonly string[]>,
): Focus {
  if (id === null) return NO_FOCUS;
  const lit = new Set<string>([id]);
  for (const neighbour of adjacency.get(id) ?? []) lit.add(neighbour);
  return { id, lit };
}

/**
 * How strongly one item is drawn, given the beam and the selection.
 *
 * The weaker of the two, never the product of them: an item that is both
 * unmatched and unrelated is still drawn at 30%, because the rule the user
 * learns is "the map dims what it is not talking about", and two dimmings
 * compounding to 9% would be the map going black — which D59 forbids for a
 * reason that has nothing to do with contrast.
 */
/**
 * A walk through the graph, drawn as a path rather than as a lit cloud.
 *
 * This is what the question-answering loop produces: it started somewhere,
 * moved to a neighbour, read something, moved again. Lighting the items it
 * touched is not enough to show that — a set of bright dots says "these are
 * related", where the thing actually being shown is "it went here, then here,
 * and the answer rests on these two".
 *
 * **Why a list of links and not a set of ids.** `linkStrength` lights any line
 * whose two ends are both lit. So a walk A → B → C on a graph that also has a
 * direct A → C would draw the shortcut at exactly the same brightness as the
 * path, and nothing on screen would say which one was walked. An ordered list
 * of the hops themselves is the only shape that cannot be ambiguous.
 *
 * **`critical` is not decoration.** The loop distinguishes where it looked from
 * what the answer stands on — a place it opened and abandoned is in the walk
 * and is not evidence. Drawing both the same way would make the picture agree
 * with the answer more than the evidence does, which is the one thing a picture
 * of a chain of reasoning must not do.
 */
export type TrailStep = {
  /** 1-based, and what gets drawn on the line. */
  order: number;
  fromId: string;
  toId: string;
  /** True when a surviving finding cites this hop, rather than merely passing through it. */
  critical: boolean;
  /**
   * False when the walk restarted here — a fresh search after a dead end,
   * rather than a move along a connection. There is no line to draw for one of
   * these, and drawing one would invent an edge the graph does not have.
   */
  connected: boolean;
};

export type Trail = {
  steps: readonly TrailStep[];
  /** Every item the walk touched. */
  lit: ReadonlySet<string>;
  /** The ones the answer rests on. */
  critical: ReadonlySet<string>;
};

export const NO_TRAIL: Trail = {
  steps: [],
  lit: new Set<string>(),
  critical: new Set<string>(),
};

/**
 * Whether a walk is showing at all.
 *
 * Asked of the places, not the hops, and that distinction is load-bearing: an
 * investigation that found everything by searching crosses no connections, so
 * it has points and an empty `steps`. Gating on `steps` — which both callers
 * below originally did — meant such a walk lit nothing whatsoever and the map
 * silently fell back to the selection, showing a walk as if none had happened.
 */
export function walking(trail: Trail): boolean {
  return trail.lit.size > 0;
}

/** The two lookup sets, built once from the hops rather than at every draw. */
export function trailOf(steps: readonly TrailStep[]): Trail {
  const lit = new Set<string>();
  const critical = new Set<string>();
  for (const step of steps) {
    lit.add(step.fromId);
    lit.add(step.toId);
    if (step.critical) {
      critical.add(step.fromId);
      critical.add(step.toId);
    }
  }
  return { steps, lit, critical };
}

/**
 * The hop this link is, or null.
 *
 * Matched on direction as well as ends. A walk that went A → B is not the same
 * statement as the edge B → A, and a map that drew the number on whichever line
 * happened to exist would put the story's arrow the wrong way round.
 */
export function stepFor(link: MapLink, trail: Trail): TrailStep | null {
  for (const step of trail.steps) {
    if (!step.connected) continue;
    if (step.fromId === link.from && step.toId === link.to) return step;
  }
  return null;
}

export function itemStrength(
  id: string,
  focus: Focus,
  beam: BeamResult,
  trail: Trail = NO_TRAIL,
): number {
  const beamPart = beam.active && !beam.matched.has(id) ? DIM : 1;

  /*
   * A walk replaces the selection's lighting rather than adding to it.
   *
   * One screen, one meaning of "near". `focusOf` lights a hop around whatever
   * is selected, and a walk lights the walk; both at once would put two
   * different neighbourhoods on the map with nothing to tell the reader which
   * is which — the same warning this file already gives about a second private
   * idea of near.
   */
  const litPart = walking(trail)
    ? (trail.lit.has(id) ? 1 : DIM)
    : (focus.id === null || focus.lit.has(id) ? 1 : DIM);

  // The weaker of the two, never their product: two dimmings compounding to 9%
  // is the map going black, which D59 forbids.
  return Math.min(beamPart, litPart);
}

/** A link is as strong as its weaker end: a line into the dark would point at nothing. */
export function linkStrength(
  link: MapLink,
  focus: Focus,
  beam: BeamResult,
  trail: Trail = NO_TRAIL,
): number {
  /*
   * While a walk is showing, only the hops themselves are bright.
   *
   * Without this the map would draw a shortcut at full strength: a walk
   * A → B → C on a graph that also holds A → C has three lit items, and the
   * rule below — as strong as its weaker end — makes all three lines equal.
   * The picture would then show a triangle where a path was walked, and
   * nothing on it would say which line was taken.
   */
  if (walking(trail)) {
    return stepFor(link, trail) ? 1 : DIM;
  }
  return Math.min(
    itemStrength(link.from, focus, beam, trail),
    itemStrength(link.to, focus, beam, trail),
  );
}

/**
 * True for the links that touch the selection itself.
 *
 * These always carry their words, at any zoom where the line exists. It is the
 * one case where a label is certainly worth drawing: the user has just asked
 * what this thing is connected to, and the answer is written on the lines
 * leaving it.
 */
export function touchesFocus(link: MapLink, focus: Focus): boolean {
  return focus.id !== null && (link.from === focus.id || link.to === focus.id);
}

/**
 * The busiest item in each territory, which is drawn as its hub.
 *
 * By the same `usedBy + uses` the right panel counts with (D69), so the largest
 * dot in a place is the thing the panel would also call the most used. Ties go
 * to the lower id, so it never depends on arrival order.
 */
export function hubsOf(
  layout: MapLayout,
  items: readonly GraphItem[],
): Map<string, string> {
  const degree = new Map<string, number>();
  for (const item of items) degree.set(item.id, item.usedBy + item.uses);

  const best = new Map<string, { id: string; degree: number }>();
  for (const placed of layout.items) {
    const mine = degree.get(placed.id) ?? 0;
    const current = best.get(placed.districtId);
    if (
      !current ||
      mine > current.degree ||
      (mine === current.degree && placed.id < current.id)
    ) {
      best.set(placed.districtId, { id: placed.id, degree: mine });
    }
  }

  const hubs = new Map<string, string>();
  for (const district of layout.districts) {
    if (district.count < HUB_MIN_MEMBERS) continue;
    const winner = best.get(district.id);
    if (winner) hubs.set(district.id, winner.id);
  }
  return hubs;
}

/**
 * Whether colour is allowed to mean anything on this map.
 *
 * The founder's rule — "묶는 기준이 정의 되었을 때만" — read as a condition the
 * picture can check for itself. Colour on this map has exactly one job, which
 * is to say which territory a thing belongs to, so it is only spent when the
 * grouping in force has actually split the project: `grouping.ts` has already
 * judged whether it can (that is what `available` is for, and it is the same
 * judgement the control shows the user before they commit), and a map with one
 * territory has nothing for six colours to distinguish.
 *
 * When the answer is no, everything is drawn in one quiet colour. A picture
 * that keeps the colours and drops the meaning looks exactly like a picture
 * that has one, which is the worse of the two failures.
 */
export function colourCarriesGrouping(
  option: GroupingOption | undefined,
  districtCount: number,
): boolean {
  if (!option || !option.available) return false;
  return districtCount >= 2;
}

/**
 * The order items get their names, when there is not room for every name.
 *
 * ## Why there has to be an order at all
 *
 * `lod.ts` caps how many names may be expected on screen, and the cap is only
 * meaningful if *which* names are eligible is fixed — decided by the zoom and
 * the graph, never by what is currently in the viewport. Otherwise panning
 * towards a crowd changes the answer and every word on screen strobes, which is
 * the failure `lod.ts` is written to prevent.
 *
 * ## Why it is not simply "busiest first"
 *
 * That was the obvious answer and it is wrong in a way that only shows at
 * scale. Global degree order concentrates the whole allowance in whichever
 * territories happen to hold the busy things: on a 1,442-item project the top
 * three hundred by degree are almost all in two districts, so zooming into any
 * of the other thirteen shows a field of dots with **no names at all**, at a
 * zoom whose entire purpose is to let you read them. The user's reasonable
 * conclusion is that the map does not know what those things are called.
 *
 * ## The order, and the one correction it needed
 *
 * The order is **by how far up its own territory an item stands**: an item at
 * the thirtieth percentile of its district, by importance, ranks alongside
 * every other district's thirtieth percentile. Any prefix of that order holds
 * the same *share* of every territory, so zooming into any of them finds it
 * named to the same depth.
 *
 * The obvious version of that — plain round robin, the busiest thing in every
 * district, then the second busiest in every district — is wrong at scale, and
 * measurably. It gives every territory the same **number** of names rather than
 * the same share, and a district's share of the map's area is its share of the
 * items. So on a 1,442-item project zoomed into a territory holding 420 of
 * them, fourteen fifteenths of the name allowance was being spent on
 * territories that were not on screen: **12 names drawn against a budget of
 * 36**, with the rest of the allowance sitting off the edge of the canvas.
 * Weighting by the district's own size is the whole fix.
 *
 * Ranks are then handed out by position in one total order — percentile first,
 * then the district's placed index, then the id — so no two items share a rank
 * and the answer is the same on every render, which is the promise `layout.ts`
 * and `buildLinks` make.
 */
export function nameRanks(
  layout: MapLayout,
  items: readonly GraphItem[],
): Map<string, number> {
  const degree = new Map<string, number>();
  for (const item of items) degree.set(item.id, item.usedBy + item.uses);

  const order = new Map<string, number>();
  layout.districts.forEach((district, index) => order.set(district.id, index));

  const perDistrict = new Map<string, string[]>();
  for (const placed of layout.items) {
    const list = perDistrict.get(placed.districtId);
    if (list) list.push(placed.id);
    else perDistrict.set(placed.districtId, [placed.id]);
  }

  const everyone: { id: string; share: number; lane: number }[] = [];
  for (const [districtId, members] of perDistrict) {
    members.sort((a, b) => {
      const byDegree = (degree.get(b) ?? 0) - (degree.get(a) ?? 0);
      if (byDegree !== 0) return byDegree;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const lane = order.get(districtId) ?? 0;
    // How far up its own territory this item stands, in [0, 1). A district of
    // ten and a district of four hundred both run the whole range, which is
    // what makes a prefix of the final order proportional rather than equal.
    members.forEach((id, place) =>
      everyone.push({ id, share: (place + 0.5) / members.length, lane }),
    );
  }

  everyone.sort((a, b) => {
    if (a.share !== b.share) return a.share - b.share;
    if (a.lane !== b.lane) return a.lane - b.lane;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const ranks = new Map<string, number>();
  everyone.forEach((one, rank) => ranks.set(one.id, rank));
  return ranks;
}
