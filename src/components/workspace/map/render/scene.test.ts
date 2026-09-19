import { describe, expect, it } from "vitest";

import type { GraphConnection, GraphItem } from "@/lib/graph/view";

import { IDLE_BEAM, type BeamResult } from "../beam";
import type { GroupingOption } from "../grouping";
import { layoutMap } from "../layout";

import {
  buildAdjacency,
  buildLinks,
  colourCarriesGrouping,
  focusOf,
  hubsOf,
  itemStrength,
  linkStrength,
  touchesFocus,
  DIM,
  NO_FOCUS,
} from "./scene";

function item(partial: Partial<GraphItem> & { id: string }): GraphItem {
  return {
    kind: "file",
    shape: null,
    name: partial.id,
    label: null,
    summary: null,
    path: null,
    startLine: null,
    endLine: null,
    fromUser: false,
    usedBy: 0,
    uses: 0,
    ...partial,
  };
}

function link(
  partial: Partial<GraphConnection> & { id: string; from: string; to: string },
): GraphConnection {
  return {
    relation: "calls",
    certainty: "certain",
    ...partial,
  };
}

const ITEMS: GraphItem[] = [
  item({ id: "a", path: "src/lib/a.ts", usedBy: 3 }),
  item({ id: "b", path: "src/lib/b.ts", usedBy: 1 }),
  item({ id: "c", path: "src/components/c.tsx" }),
  item({ id: "d", path: "src/components/d.tsx" }),
];

const LAYOUT = layoutMap(ITEMS);

const beamFor = (matched: string[]): BeamResult => ({
  active: true,
  matched: new Set(matched),
});

describe("buildLinks", () => {
  it("drops a connection to something that is not on the map", () => {
    const links = buildLinks(
      ITEMS,
      [link({ id: "1", from: "a", to: "ghost" }), link({ id: "2", from: "a", to: "b" })],
      LAYOUT,
    );
    expect(links).toHaveLength(1);
    expect(links[0].to).toBe("b");
  });

  it("drops a connection from a thing to itself", () => {
    expect(buildLinks(ITEMS, [link({ id: "1", from: "a", to: "a" })], LAYOUT)).toHaveLength(0);
  });

  it("keeps the direction, because the direction is the fact", () => {
    const links = buildLinks(ITEMS, [link({ id: "1", from: "b", to: "a" })], LAYOUT);
    expect(links[0].from).toBe("b");
    expect(links[0].to).toBe("a");
  });

  /**
   * Two items really can be connected twice — a file that both imports another
   * and calls into it is two true statements. Drawn on top of each other they
   * would read as one line with one word on it, which is a third statement
   * that is not true.
   */
  it("gives two connections between the same pair their own lanes", () => {
    const links = buildLinks(
      ITEMS,
      [
        link({ id: "1", from: "a", to: "b", relation: "calls" }),
        link({ id: "2", from: "a", to: "b", relation: "imports" }),
      ],
      LAYOUT,
    );
    expect(links).toHaveLength(2);
    const lanes = links.map((one) => one.lane).sort((x, y) => x - y);
    expect(lanes[0]).toBeLessThan(0);
    expect(lanes[1]).toBeGreaterThan(0);
    expect(lanes[0] + lanes[1]).toBeCloseTo(0, 9);
  });

  it("leaves a single connection on the centre line", () => {
    const links = buildLinks(ITEMS, [link({ id: "1", from: "a", to: "b" })], LAYOUT);
    expect(links[0].lane).toBe(0);
  });

  it("says which connection is worth a word first, and it is not 가지고 있어요", () => {
    const links = buildLinks(
      ITEMS,
      [
        link({ id: "1", from: "a", to: "b", relation: "contains" }),
        link({ id: "2", from: "c", to: "d", relation: "fetches" }),
      ],
      LAYOUT,
    );
    const byRelation = new Map(links.map((one) => [one.relation, one.rank]));
    expect(byRelation.get("fetches")).toBeLessThan(byRelation.get("contains") ?? Infinity);
  });

  it("marks a connection that leaves its territory", () => {
    const links = buildLinks(
      ITEMS,
      [link({ id: "1", from: "a", to: "b" }), link({ id: "2", from: "a", to: "c" })],
      LAYOUT,
    );
    expect(links.find((one) => one.to === "b")?.crossing).toBe(false);
    expect(links.find((one) => one.to === "c")?.crossing).toBe(true);
  });

  /**
   * Same promise `layout.ts` makes: a run that streams its connections in a
   * different order still draws the identical picture, so a refresh mid-run
   * looks like nothing happened.
   */
  it("draws the same picture whatever order the connections arrived in", () => {
    const connections = [
      link({ id: "1", from: "a", to: "b", relation: "imports" }),
      link({ id: "2", from: "c", to: "d", relation: "renders" }),
      link({ id: "3", from: "a", to: "c", relation: "calls" }),
    ];
    const forwards = buildLinks(ITEMS, connections, LAYOUT);
    const backwards = buildLinks(ITEMS, [...connections].reverse(), LAYOUT);
    expect(backwards).toEqual(forwards);
  });
});

describe("buildAdjacency", () => {
  it("answers in both directions, once each", () => {
    const links = buildLinks(
      ITEMS,
      [
        link({ id: "1", from: "a", to: "b", relation: "calls" }),
        link({ id: "2", from: "a", to: "b", relation: "imports" }),
      ],
      LAYOUT,
    );
    const adjacency = buildAdjacency(links);
    expect(adjacency.get("a")).toEqual(["b"]);
    expect(adjacency.get("b")).toEqual(["a"]);
  });
});

describe("focusOf", () => {
  const links = buildLinks(
    ITEMS,
    [
      link({ id: "1", from: "a", to: "b" }),
      link({ id: "2", from: "b", to: "c" }),
      link({ id: "3", from: "c", to: "d" }),
    ],
    LAYOUT,
  );
  const adjacency = buildAdjacency(links);

  it("lights one step and stops, which is what the panel beside it defaults to", () => {
    const focus = focusOf("b", adjacency);
    expect([...focus.lit].sort()).toEqual(["a", "b", "c"]);
  });

  it("lights nothing at all when nothing is chosen", () => {
    expect(focusOf(null, adjacency)).toBe(NO_FOCUS);
  });

  it("still lights the thing itself when it is joined to nothing", () => {
    expect([...focusOf("lonely", adjacency).lit]).toEqual(["lonely"]);
  });
});

describe("itemStrength", () => {
  const adjacency = buildAdjacency(
    buildLinks(ITEMS, [link({ id: "1", from: "a", to: "b" })], LAYOUT),
  );
  const focus = focusOf("a", adjacency);

  it("leaves everything alone while nothing is chosen and nothing is typed", () => {
    expect(itemStrength("d", NO_FOCUS, IDLE_BEAM)).toBe(1);
  });

  it("keeps the chosen thing and its neighbour at full strength", () => {
    expect(itemStrength("a", focus, IDLE_BEAM)).toBe(1);
    expect(itemStrength("b", focus, IDLE_BEAM)).toBe(1);
  });

  it("pushes everything else back without taking it away", () => {
    expect(itemStrength("d", focus, IDLE_BEAM)).toBe(DIM);
    expect(itemStrength("d", focus, IDLE_BEAM)).toBeGreaterThan(0);
  });

  /**
   * D59's floor is 30%, and two dimmings compounding would put it at 9% — a
   * map that has, for the person looking at it, gone black.
   */
  it("never goes below the floor even when both the beam and a choice dim it", () => {
    expect(itemStrength("d", focus, beamFor(["a"]))).toBe(DIM);
  });
});

describe("linkStrength and touchesFocus", () => {
  const links = buildLinks(
    ITEMS,
    [link({ id: "1", from: "a", to: "b" }), link({ id: "2", from: "c", to: "d" })],
    LAYOUT,
  );
  const focus = focusOf("a", buildAdjacency(links));
  const near = links.find((one) => one.from === "a");
  const far = links.find((one) => one.from === "c");

  it("keeps a line between two lit things bright and pushes the rest back", () => {
    expect(near && linkStrength(near, focus, IDLE_BEAM)).toBe(1);
    expect(far && linkStrength(far, focus, IDLE_BEAM)).toBe(DIM);
  });

  it("knows which lines are the answer to the question just asked", () => {
    expect(near && touchesFocus(near, focus)).toBe(true);
    expect(far && touchesFocus(far, focus)).toBe(false);
    expect(near && touchesFocus(near, NO_FOCUS)).toBe(false);
  });
});

describe("hubsOf", () => {
  it("picks the busiest thing in a territory", () => {
    const many = [
      item({ id: "h", path: "src/lib/h.ts", usedBy: 9 }),
      item({ id: "i", path: "src/lib/i.ts", usedBy: 1 }),
      item({ id: "j", path: "src/lib/j.ts" }),
      item({ id: "k", path: "src/lib/k.ts" }),
    ];
    const layout = layoutMap(many);
    expect([...hubsOf(layout, many).values()]).toEqual(["h"]);
  });

  it("breaks a tie the same way every time", () => {
    const many = [
      item({ id: "z", path: "src/lib/z.ts", usedBy: 2 }),
      item({ id: "a", path: "src/lib/a.ts", usedBy: 2 }),
      item({ id: "m", path: "src/lib/m.ts" }),
      item({ id: "n", path: "src/lib/n.ts" }),
    ];
    const layout = layoutMap(many);
    expect([...hubsOf(layout, many).values()]).toEqual(["a"]);
  });

  it("gives a territory too small to have a crowd no hub at all", () => {
    const few = [item({ id: "p", path: "src/lib/p.ts", usedBy: 5 })];
    expect(hubsOf(layoutMap(few), few).size).toBe(0);
  });
});

describe("colourCarriesGrouping", () => {
  const option = (over: Partial<GroupingOption> = {}): GroupingOption => ({
    id: "folder",
    name: "폴더",
    meaning: "",
    available: true,
    unavailable: null,
    districtCount: 4,
    ...over,
  });

  it("spends colour when the grouping actually split the project", () => {
    expect(colourCarriesGrouping(option(), 4)).toBe(true);
  });

  it("does not, when grouping.ts has already said this one draws one blob", () => {
    expect(colourCarriesGrouping(option({ available: false }), 4)).toBe(false);
  });

  it("does not, when there is only one place for the colours to tell apart", () => {
    expect(colourCarriesGrouping(option(), 1)).toBe(false);
  });

  it("does not, when it was handed no judgement at all", () => {
    expect(colourCarriesGrouping(undefined, 8)).toBe(false);
  });
});
