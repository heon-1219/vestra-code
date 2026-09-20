import type { FlowHop } from "@/lib/graph/flow";

import { NO_TRAIL, type Trail, type TrailStep } from "../map/render/scene";

/**
 * A flow, in the shape the map draws.
 *
 * The same join `map/render/walk.ts` is for the investigation's walk, and for
 * the same reason: `lib/graph/flow.ts` speaks in hops, joints and certainty
 * because that is what a path through somebody's code is, and `scene.ts` speaks
 * in lit sets and ordered steps because that is what a renderer can act on at
 * sixty frames a second. Neither may use the other's words, so there is exactly
 * one file where they meet.
 *
 * A translation and never an embellishment. Nothing here infers a hop, joins
 * two that were not joined, or fills a gap.
 *
 * ## The joint rule, which is the one thing that would invent a connection
 *
 * A `FlowHop` whose `joint` is not null is **not one edge**. It is
 * `route → (its file) → symbol`, two `contains` edges read in opposite
 * directions with the file collapsed out of the middle, so no connection in the
 * graph has that hop's two ends. It becomes a `TrailStep` with
 * `connected: false` (D79, D126), which `stepFor` refuses to match to any line
 * — so the map draws no stroke and no number for it, because drawing one would
 * put an edge on screen that the project does not have.
 *
 * Both ends are still lit. The places are real; it is the line between them
 * that is not.
 *
 * ## `critical` means "the step you are on"
 *
 * The field exists because the investigation loop separates where it looked
 * from what its answer stands on, and a picture that drew both alike would
 * agree with the answer more than the evidence does. **A flow has no such
 * split** — every hop is the path, there is no hop it merely passed through.
 *
 * So the one distinction a paced reveal actually has to draw is where the
 * reader is *now*, and that is what this spends the field on: the newest step
 * is drawn at double weight, the ones behind it at single. It is what makes
 * "the current hop is the map's focus" true on the canvas as well as in the
 * panel, and it is the same fact the panel's highlighted row is saying, so the
 * two halves of the screen cannot disagree about which step is being read.
 */

/**
 * The first `revealed` hops of a path, lit and numbered.
 *
 * `startId` is lit even at `revealed === 0`, which is a state a flow really has
 * — the start standing alone, before its first step. Building the lit set from
 * the steps alone (which is what `trailOf` does) would leave that state with
 * nothing lit at all, and `walking()` would hand the map back to the selection
 * mid-flow: the reader would watch the map answer a different question for one
 * frame and then answer theirs again.
 */
export function trailOfFlow(
  startId: string | null,
  hops: readonly FlowHop[],
  revealed: number,
): Trail {
  if (startId === null) return NO_TRAIL;

  const shown = hops.slice(0, Math.max(0, revealed));

  const lit = new Set<string>([startId]);
  for (const hop of shown) {
    lit.add(hop.fromId);
    lit.add(hop.toId);
  }

  const last = shown.length - 1;
  const steps: TrailStep[] = shown.map((hop, at) => ({
    // The walk's own number, not this list's index. They are the same today and
    // taking it from the hop is what keeps them the same if a path ever arrives
    // already trimmed.
    order: hop.index,
    fromId: hop.fromId,
    toId: hop.toId,
    critical: at === last,
    connected: hop.joint === null,
  }));

  const current = shown[last];
  const critical = new Set<string>();
  if (current) {
    critical.add(current.fromId);
    critical.add(current.toId);
  } else {
    critical.add(startId);
  }

  return { steps, lit, critical };
}

/**
 * The item the reader is looking at right now: where the newest step landed,
 * or the start before there is one.
 *
 * The panel highlights this row and the map centres on it, from one function,
 * so the two can never point at different places.
 */
export function hereIn(
  startId: string | null,
  hops: readonly FlowHop[],
  revealed: number,
): string | null {
  if (startId === null) return null;
  const at = Math.min(Math.max(revealed, 0), hops.length) - 1;
  return at < 0 ? startId : (hops[at]?.toId ?? startId);
}
