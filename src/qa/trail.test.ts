import { describe, expect, it } from "vitest";

import type { Certainty, GraphItem } from "@/lib/graph/view";

import { GRAPH } from "./__fixtures__/project";
import { buildCatalog } from "./catalog";
import type { QaGraph, RevealedHop } from "./tools";
import { buildTrail, type TrailStep } from "./trail";
import type { Finding } from "./types";

/**
 * The fold that turns what the loop did into what the map can draw.
 *
 * Every assertion here is a way the picture could agree with the answer more
 * than the evidence does, which is the only failure mode this file really has.
 * A trail that draws a line where the graph has none, or lights a place the
 * answer does not rest on, is worse than no picture: it is a claim the person
 * cannot check, made in the one part of the product they were told to trust.
 *
 * The fixture is the six-item project — a page renders a button, the button
 * calls a formatter, the formatter has the defect. Item numbers are positions
 * in that array (D46), so `[6]` is `formatPrice` here and everywhere else.
 */

function trailOf(
  steps: TrailStep[],
  findings: Finding[] = [],
  graph: QaGraph = GRAPH,
) {
  return buildTrail({
    graph,
    catalog: buildCatalog(graph.items),
    steps,
    findings,
  });
}

function step(n: number, items: string[], hops: RevealedHop[] = []): TrailStep {
  return { step: n, items, hops };
}

/** The one link in the fixture the loop can actually cross: PayButton → formatPrice. */
const PAY_CALLS_FORMAT: RevealedHop = {
  connectionId: "c5",
  from: "s-pay",
  to: "s-format",
  relation: "calls",
  certainty: "inferred",
};

function cites(path: string, startLine: number, endLine = startLine): Finding {
  return {
    claim: "여기가 문제예요.",
    certainty: "certain",
    citations: [{ path, startLine, endLine }],
  };
}

function pointFor(
  trail: ReturnType<typeof trailOf>,
  id: string,
) {
  const point = trail.points.find((candidate) => candidate.id === id);
  expect(point, `${id} should be on the trail`).toBeDefined();
  return point!;
}

describe("where the walk went", () => {
  it("keeps the first arrival, not the last", () => {
    const trail = trailOf([
      step(1, ["f-page"]),
      step(3, ["f-page", "s-checkout"]),
    ]);

    expect(trail.points.map((point) => point.id)).toEqual(["f-page", "s-checkout"]);
    // Seeing a place again is not arriving at it again. A step number that
    // crept forward would put the walk's beginning in the wrong place.
    expect(pointFor(trail, "f-page").step).toBe(1);
    expect(pointFor(trail, "s-checkout").step).toBe(3);
  });

  it("carries the number the model itself saw", () => {
    const trail = trailOf([step(1, ["s-format"])]);
    expect(pointFor(trail, "s-format").number).toBe(6);
  });

  it("starts a new leg when a landing touches nothing already on the walk", () => {
    // `f-page` reaches only `s-checkout` and `f-pay`; `s-format` only
    // `f-format` and `s-pay`. Nothing joins them, so this is a fresh search
    // after a dead end — and the map has to show a gap, not a line.
    const trail = trailOf([step(1, ["f-page"]), step(2, ["s-format"])]);

    expect(pointFor(trail, "f-page").leg).toBe(1);
    expect(pointFor(trail, "s-format").leg).toBe(2);
  });

  it("continues the same leg when the graph joins the landing to the walk", () => {
    const trail = trailOf([step(1, ["s-pay"]), step(2, ["s-format"])]);

    expect(pointFor(trail, "s-pay").leg).toBe(1);
    expect(pointFor(trail, "s-format").leg).toBe(1);
  });

  it("adds nothing for a step that only re-shows places already on the walk", () => {
    const trail = trailOf([step(1, ["s-pay"]), step(2, ["s-pay"])]);

    expect(trail.points).toHaveLength(1);
    // And in particular does not read as a restart: the loop did not go
    // anywhere, so there is no gap to draw.
    expect(pointFor(trail, "s-pay").leg).toBe(1);
  });
});

describe("the lines drawn", () => {
  it("records a link the step itself crossed as a traversal", () => {
    // What `open_item` produces: the item stood on, its neighbour, and the
    // connection between them, all in one step.
    const trail = trailOf([step(1, ["s-pay", "s-format"], [PAY_CALLS_FORMAT])]);

    expect(trail.hops).toHaveLength(1);
    expect(trail.hops[0].connectionId).toBe("c5");
    expect(trail.hops[0].via).toBe("opened");
  });

  it("records a link only the graph knew about as adjacency", () => {
    // Arrived by some other route — a search, a read — and the graph turned out
    // to already hold a link. The picture is connected because the code is.
    const trail = trailOf([step(1, ["s-pay"]), step(2, ["s-format"])]);

    expect(trail.hops).toHaveLength(1);
    expect(trail.hops[0].connectionId).toBe("c5");
    expect(trail.hops[0].via).toBe("adjacent");
  });

  it("drops a hop whose other end never joined the walk", () => {
    // An edge hanging off the picture is worse than a missing one: there is
    // nothing at the far end of it for a person to look at.
    const trail = trailOf([step(1, ["s-pay"], [PAY_CALLS_FORMAT])]);

    expect(trail.points.map((point) => point.id)).toEqual(["s-pay"]);
    expect(trail.hops).toEqual([]);
  });

  it("keeps a connection once, at the crossing that happened first", () => {
    const trail = trailOf([
      step(1, ["s-pay", "s-format"], [PAY_CALLS_FORMAT]),
      step(3, ["f-format"], [PAY_CALLS_FORMAT]),
    ]);

    const crossings = trail.hops.filter((hop) => hop.connectionId === "c5");
    expect(crossings).toHaveLength(1);
    expect(crossings[0].step).toBe(1);
    // And the first crossing keeps its label. A later, weaker sighting of the
    // same link must not downgrade a traversal to a coincidence.
    expect(crossings[0].via).toBe("opened");
  });

  it("prefers a known connection over a guess, whichever the graph lists first", () => {
    // Two items can be joined more than once and one line has to be chosen.
    // Drawing the guess where a known connection also exists would make the
    // walk look weaker than it is.
    for (const order of [
      ["inferred", "certain"],
      ["certain", "inferred"],
    ] satisfies Certainty[][]) {
      const trail = trailOf(
        [step(1, ["a"]), step(2, ["b"])],
        [],
        pair(order),
      );

      expect(trail.hops).toHaveLength(1);
      expect(trail.hops[0].certainty, `listed ${order.join(" then ")}`).toBe(
        "certain",
      );
    }
  });
});

describe("what the answer stands on", () => {
  const walk = [step(1, ["f-format", "s-format"])];

  it("lights the narrowest place on the walk that contains the citation", () => {
    // Line 7 is inside `formatPrice` (3-8), which is on the walk. Lighting the
    // file instead would point a person at a hundred lines and call it an
    // answer.
    const trail = trailOf(walk, [cites("src/lib/format.ts", 7)]);

    expect(pointFor(trail, "s-format").critical).toBe(true);
    expect(pointFor(trail, "f-format").critical).toBe(false);
  });

  it("falls back to the file when no piece on the walk covers the lines", () => {
    // `formatCount` is not in this graph. The file genuinely is where those
    // lines are, and saying so is a smaller claim than lighting the wrong
    // piece inside it.
    const trail = trailOf(walk, [cites("src/lib/format.ts", 10, 11)]);

    expect(pointFor(trail, "f-format").critical).toBe(true);
    expect(pointFor(trail, "s-format").critical).toBe(false);
  });

  it("leaves a visited place uncritical when nothing cites it", () => {
    // Visited and abandoned is exactly as uncritical as never visited. This is
    // the whole difference between "where it looked" and "what it found".
    const trail = trailOf(walk);

    expect(trail.points.every((point) => !point.critical)).toBe(true);
    expect(trail.unplaced).toEqual([]);
  });

  it("reports a citation the walk never reached rather than drawing it", () => {
    const trail = trailOf([step(1, ["s-pay"])], [cites("src/lib/format.ts", 7)]);

    expect(trail.points.every((point) => !point.critical)).toBe(true);
    // Surfaced as a number somebody can see, not swallowed. The finding still
    // carries the citation; the map simply cannot place it.
    expect(trail.unplaced).toEqual([
      { path: "src/lib/format.ts", startLine: 7, endLine: 7 },
    ]);
  });
});

// --- A two-item graph, for the cases the fixture cannot express -------------

function pair(certainties: readonly Certainty[]): QaGraph {
  return {
    items: [bare("a"), bare("b")],
    connections: certainties.map((certainty, index) => ({
      id: `x${index}`,
      from: "a",
      to: "b",
      relation: "imports" as const,
      certainty,
    })),
  };
}

function bare(id: string): GraphItem {
  return {
    id,
    kind: "file",
    shape: null,
    name: `${id}.ts`,
    label: null,
    summary: null,
    path: `${id}.ts`,
    startLine: null,
    endLine: null,
    fromUser: false,
    usedBy: 0,
    uses: 0,
  };
}
