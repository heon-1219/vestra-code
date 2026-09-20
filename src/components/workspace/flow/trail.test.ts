import { describe, expect, it } from "vitest";

import { traceFlow, type FlowHop } from "@/lib/graph/flow";

import { IDLE_BEAM } from "../map/beam";
import { districtLookup, groupItems } from "../map/grouping";
import { layoutMap } from "../map/layout";
import {
  buildLinks,
  DIM,
  itemStrength,
  linkStrength,
  NO_FOCUS,
  stepFor,
  walking,
} from "../map/render/scene";
import { SHOP } from "./__fixtures__/shop";
import { hereIn, trailOfFlow } from "./trail";

/**
 * A flow, in the shape the map draws.
 *
 * The rule this file exists to keep is §2.1's, and it is the one that would
 * silently put a line on screen that the project does not have: **a joint hop
 * has no edge behind it.** `route → (its file) → symbol` is two `contains`
 * edges read in opposite directions with the file collapsed out, so no
 * connection in the graph has that hop's two ends (D79, D126).
 */

/** The real placement, through the real grouping, so `buildLinks` is the real one. */
function mapLayout() {
  return layoutMap(
    SHOP.items,
    districtLookup(groupItems(SHOP.items, SHOP.connections, "folder")),
  );
}

const trace = traceFlow(SHOP, { startId: "r-checkout" });
const hops: readonly FlowHop[] = trace.path?.hops ?? [];
const START = "r-checkout";

describe("the fixture this is measured on", () => {
  it("has a path with both joints on it", () => {
    expect(hops.length).toBe(4);
    expect(hops[0].joint).toBe("entry");
    expect(hops[3].joint).toBe("server");
    expect(hops.filter((hop) => hop.joint === null)).toHaveLength(2);
  });
});

describe("the joint rule", () => {
  it("draws no line for a joint", () => {
    const trail = trailOfFlow(START, hops, hops.length);
    const joints = trail.steps.filter((step) => !step.connected);

    expect(joints).toHaveLength(2);
    expect(joints.map((step) => step.order)).toEqual([1, 4]);
  });

  it("lights both ends of a joint even so", () => {
    // The places are real. It is the line between them that is not.
    const trail = trailOfFlow(START, hops, hops.length);
    expect(trail.lit.has("r-checkout")).toBe(true);
    expect(trail.lit.has("s-pay")).toBe(true);
    expect(trail.lit.has("e-orders")).toBe(true);
    expect(trail.lit.has("s-save")).toBe(true);
  });

  it("cannot be matched to any line on the map", () => {
    /*
     * The real check, through the renderer's own `stepFor` and the real
     * `buildLinks`: there is no drawable link whose ends are a joint's ends,
     * so even a renderer that tried could not draw one.
     */
    const links = buildLinks(SHOP.items, SHOP.connections, mapLayout());
    const trail = trailOfFlow(START, hops, hops.length);

    const drawn = links.map((link) => stepFor(link, trail)).filter((step) => step !== null);
    expect(drawn.map((step) => step?.order).sort()).toEqual([2, 3]);
    for (const step of drawn) expect(step?.connected).toBe(true);
  });

  it("keeps the numbers the walk gave, so nothing is renumbered to hide a gap", () => {
    // The panel lists 1–4; the map draws 2 and 3, because 1 and 4 are joints.
    // The numbers must be the walk's own, not this list's index — a step
    // renumbered to close the gap would put a different number on the map than
    // the panel says.
    const trail = trailOfFlow(START, hops, hops.length);
    expect(trail.steps.map((step) => step.order)).toEqual([1, 2, 3, 4]);
  });
});

describe("revealing the path a step at a time", () => {
  it("shows exactly as many steps as the player has revealed", () => {
    for (let revealed = 0; revealed <= hops.length; revealed += 1) {
      expect(trailOfFlow(START, hops, revealed).steps).toHaveLength(revealed);
    }
  });

  it("lights the start alone before the first step", () => {
    /*
     * A real state, and the one that would otherwise break the map. Building
     * the lit set from the steps alone leaves nothing lit at zero, `walking()`
     * returns false, and the map hands itself back to the selection in the
     * middle of a flow.
     */
    const trail = trailOfFlow(START, hops, 0);
    expect([...trail.lit]).toEqual([START]);
    expect(walking(trail)).toBe(true);
  });

  it("lights nothing when there is no start", () => {
    expect(walking(trailOfFlow(null, hops, 3))).toBe(false);
  });

  it("marks the newest step as the one being read", () => {
    for (let revealed = 1; revealed <= hops.length; revealed += 1) {
      const trail = trailOfFlow(START, hops, revealed);
      const critical = trail.steps.filter((step) => step.critical);
      expect(critical).toHaveLength(1);
      expect(critical[0].order).toBe(hops[revealed - 1].index);
    }
  });
});

describe("where the reader is", () => {
  it("is the start before the first step", () => {
    expect(hereIn(START, hops, 0)).toBe(START);
  });

  it("is where the newest step landed", () => {
    expect(hereIn(START, hops, 1)).toBe(hops[0].toId);
    expect(hereIn(START, hops, hops.length)).toBe(hops[hops.length - 1].toId);
  });

  it("clamps rather than falling off either end", () => {
    expect(hereIn(START, hops, -5)).toBe(START);
    expect(hereIn(START, hops, 99)).toBe(hops[hops.length - 1].toId);
  });
});

describe("what the map does with it", () => {
  const links = buildLinks(SHOP.items, SHOP.connections, mapLayout());

  it("dims everything off the path, and never to nothing", () => {
    const trail = trailOfFlow(START, hops, hops.length);
    // `s-cart` is the branch the walk did not take. It is still drawn — D59:
    // a map that goes black says the project vanished.
    expect(itemStrength("s-cart", NO_FOCUS, IDLE_BEAM, trail)).toBe(DIM);
    expect(itemStrength("s-pay", NO_FOCUS, IDLE_BEAM, trail)).toBe(1);
  });

  it("keeps a step that has not been revealed dim", () => {
    const early = trailOfFlow(START, hops, 2);
    const late = trailOfFlow(START, hops, 3);
    const crossing = links.find(
      (link) => link.from === "s-create" && link.to === "e-orders",
    );
    expect(crossing).toBeDefined();
    expect(linkStrength(crossing!, NO_FOCUS, IDLE_BEAM, early)).toBe(DIM);
    expect(linkStrength(crossing!, NO_FOCUS, IDLE_BEAM, late)).toBe(1);
  });

  it("leaves a shortcut between two lit places dim", () => {
    // The reason `Trail` is a list of links and not a set of ids. Nothing on
    // this fixture is a shortcut, so the check is the general one: every line
    // that is not one of the revealed hops is dim.
    const trail = trailOfFlow(START, hops, hops.length);
    for (const link of links) {
      const strength = linkStrength(link, NO_FOCUS, IDLE_BEAM, trail);
      expect(strength).toBe(stepFor(link, trail) ? 1 : DIM);
    }
  });
});
