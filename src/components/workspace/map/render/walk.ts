import type { QaTrail } from "@/qa";

import { NO_TRAIL, type Trail, type TrailStep } from "./scene";

/**
 * The investigation's walk, in the shape the map draws.
 *
 * Two modules describe the same journey and neither can use the other's words.
 * `src/qa/trail.ts` speaks in points and hops because that is what an account
 * of an investigation is: places the loop stood, links it crossed, and which of
 * them the answer turned out to rest on. `scene.ts` speaks in lit sets and
 * ordered steps because that is what a renderer can act on at sixty frames a
 * second. This file is the join, and it is deliberately the only one — every
 * other option puts QA vocabulary inside the renderer or canvas vocabulary
 * inside the loop, and the two have to be separately testable.
 *
 * It is a translation and never an embellishment. Nothing here infers a hop,
 * promotes a place, or fills a gap. If the walk restarted, the drawing has a
 * gap in it, because the walk did.
 */

export function trailFrom(qa: QaTrail | null): Trail {
  if (!qa || qa.points.length === 0) return NO_TRAIL;

  const lit = new Set<string>();
  const critical = new Set<string>();
  for (const point of qa.points) {
    lit.add(point.id);
    if (point.critical) critical.add(point.id);
  }

  const steps: TrailStep[] = qa.hops.map((hop, index) => ({
    // Numbered by crossing, not by the loop's step number. A step that opened
    // one item and was handed four connections is four lines on the map, and
    // four lines all wearing the same number read as one thing drawn wrongly.
    order: index + 1,
    fromId: hop.from,
    toId: hop.to,
    /*
     * A line is evidence only when both the places it joins are.
     *
     * The narrower rule on purpose. It would be easy to mark the hop that
     * arrives at a cited place — "this is how we got to the proof" — and it
     * would usually even be true, but the trail does not record the walk's
     * direction of travel, only the code's. Drawing a conclusion from an arrow
     * that means something else is how a picture ends up asserting more than
     * the citations do, which is the single thing this feature must not do.
     */
    critical: critical.has(hop.from) && critical.has(hop.to),
    /*
     * Always. A hop exists only where the graph has a connection, so there is
     * always a line to draw for one.
     *
     * A restart is the absence of a hop rather than a step marked
     * disconnected, and it needs no special drawing: the place is in `lit`, so
     * the map lights it, and no line arrives at it. A lit point with nothing
     * leading to it is exactly what "it gave up and started looking somewhere
     * else" looks like, and it says so without a legend.
     */
    connected: true,
  }));

  return { steps, lit, critical };
}
