import { describe, expect, it } from "vitest";

import type { ChangeScope } from "../incremental";

import {
  buildPurposeAsks,
  DEFAULT_PURPOSE_BUDGET,
  outputCeilingFor,
  selectPurposes,
  type NodeText,
} from "./ask";
import { calls, renders, sharedHelperGraph } from "./__fixtures__/graph";
import {
  contains,
  file,
  imports,
  pkg,
  symbol,
  usesPackage,
} from "../semantic/__fixtures__/graph";

const FULL: ChangeScope = { mode: "full", reason: "no_base_run" };

function touched(...paths: string[]): ChangeScope {
  return { mode: "incremental", base: "before", head: "after", changed: new Set(paths) };
}

function askFor(
  asks: ReturnType<typeof buildPurposeAsks>["asks"],
  relation: string,
  name: string,
) {
  const found = asks.find((ask) => ask.relation === relation && ask.targetName === name);
  if (!found) throw new Error(`no ${relation} ask for ${name}`);
  return found;
}

describe("turning a graph into one question per purpose", () => {
  it("asks about twelve callers once, and keeps every one of their connections", () => {
    const { asks, groups } = buildPurposeAsks(sharedHelperGraph(12));

    const ask = askFor(asks, "calls", "formatPrice");
    expect(ask.sources).toBe(12);

    const group = groups.find((entry) => entry.key === ask.key);
    expect(group?.edgeIds).toHaveLength(12);
  });

  it("never asks about structure, because the picture already says it", () => {
    const { asks } = buildPurposeAsks(sharedHelperGraph(3));
    expect(asks.map((ask) => ask.relation)).not.toContain("contains");
    expect(asks.map((ask) => ask.relation)).not.toContain("belongs_to");
  });

  it("puts the most-reached-for thing first, and does it the same way twice", () => {
    const graph = sharedHelperGraph(6);
    const first = buildPurposeAsks(graph).asks;
    const second = buildPurposeAsks(graph).asks;

    expect(first.map((ask) => ask.key)).toEqual(second.map((ask) => ask.key));
    expect(first[0].sources).toBeGreaterThanOrEqual(first[first.length - 1].sources);
  });

  it("shows two example callers and stops, because a list is not context", () => {
    const { asks } = buildPurposeAsks(sharedHelperGraph(12));
    expect(askFor(asks, "calls", "formatPrice").examples).toEqual(["Card0", "Card1"]);
  });

  it("carries the Korean Pass 2 wrote, for the target and for its file", () => {
    const text = new Map<string, NodeText>([
      [
        JSON.stringify(["symbol", "src/lib/format.ts", "", "formatPrice"]),
        { label: "값 모양 만들기", summary: "값을 보기 좋게 바꿔요." },
      ],
      [
        JSON.stringify(["file", "src/lib/format.ts", "", ""]),
        { label: "모양 다듬는 곳", summary: null },
      ],
    ]);

    const ask = askFor(buildPurposeAsks(sharedHelperGraph(2), text).asks, "calls", "formatPrice");
    expect(ask.targetLabel).toBe("값 모양 만들기");
    expect(ask.targetSummary).toBe("값을 보기 좋게 바꿔요.");
    expect(ask.homeLabel).toBe("모양 다듬는 곳");
  });

  it("drops a purpose whose target is not on the map, from the questions AND the groups", () => {
    const ghost = {
      nodes: [file("a.ts"), symbol("a.ts", "go")],
      edges: [
        contains("a.ts", symbol("a.ts", "go")),
        calls("a.ts", "go", "gone.ts", "vanished"),
      ],
    };

    const { asks, groups } = buildPurposeAsks(ghost);
    expect(asks).toHaveLength(0);
    // The group must go too. A sentence spread onto a connection whose far end
    // is not on the map is a row nobody can be shown.
    expect(groups).toHaveLength(0);
  });

  it("tells a renders apart from a calls, even to the same piece", () => {
    const widget = symbol("src/Widget.tsx", "Widget", "component", 1);
    const graph = {
      nodes: [file("src/Widget.tsx"), widget, file("src/Page.tsx"), symbol("src/Page.tsx", "Page", "component", 1)],
      edges: [
        contains("src/Widget.tsx", widget),
        contains("src/Page.tsx", symbol("src/Page.tsx", "Page", "component", 1)),
        calls("src/Page.tsx", "Page", "src/Widget.tsx", "Widget"),
        renders("src/Page.tsx", "Page", "src/Widget.tsx", "Widget"),
      ],
    };

    const { asks } = buildPurposeAsks(graph);
    expect(asks.map((ask) => ask.relation).sort()).toEqual(["calls", "renders"]);
    expect(new Set(asks.map((ask) => ask.key)).size).toBe(2);
  });
});

describe("which purposes a run pays for", () => {
  const { asks } = buildPurposeAsks(sharedHelperGraph(4));
  const answered = (ask: { key: string }) => new Map([[ask.key, "여기서 값을 다듬어요."]]);

  it("does not ask again about a purpose nothing touched", () => {
    const helper = askFor(asks, "calls", "formatPrice");
    const selection = selectPurposes(asks, answered(helper), touched("src/other.ts"));

    expect(selection.carried.map((ask) => ask.key)).toContain(helper.key);
    expect(selection.asks.map((ask) => ask.key)).not.toContain(helper.key);
  });

  it("asks again when the file the target lives in moved", () => {
    const helper = askFor(asks, "calls", "formatPrice");
    const selection = selectPurposes(asks, answered(helper), touched("src/lib/format.ts"));

    expect(selection.asks.map((ask) => ask.key)).toContain(helper.key);
    expect(selection.carried).toHaveLength(0);
  });

  it("re-asks everything on a full run, because a full run does not know what moved", () => {
    const helper = askFor(asks, "calls", "formatPrice");
    const selection = selectPurposes(asks, answered(helper), FULL);

    expect(selection.carried).toHaveLength(0);
    expect(selection.asks.map((ask) => ask.key)).toContain(helper.key);
  });

  it("cuts at the budget and says which purposes it gave up on", () => {
    const selection = selectPurposes(asks, new Map(), FULL, {
      ...DEFAULT_PURPOSE_BUDGET,
      maxGroups: 2,
    });

    expect(selection.asks).toHaveLength(2);
    expect(selection.skipped.length).toBe(asks.length - 2);
    // What it gave up on is what fewest places reach for, which is the one the
    // structural verb costs least on.
    expect(selection.asks[0].sources).toBeGreaterThanOrEqual(selection.skipped[0].sources);
  });

  it("leaves an outside tool alone when nothing about it changed", () => {
    const { asks: withPackage } = buildPurposeAsks({
      nodes: [file("a.ts"), pkg("stripe")],
      edges: [usesPackage("a.ts", "stripe")],
    });
    const tool = withPackage[0];
    // A package has no file of ours, so no edit to the repository can make its
    // sentence untrue — `react` is what it was.
    const selection = selectPurposes(withPackage, new Map([[tool.key, "결제를 맡겨요."]]), touched("a.ts"));
    expect(selection.carried).toHaveLength(1);
  });

  it("asks for a completion ceiling that grows with the batch", () => {
    const one = outputCeilingFor(asks.slice(0, 1));
    const many = outputCeilingFor(asks);
    expect(many).toBeGreaterThan(one);
    expect(many).toBeLessThanOrEqual(DEFAULT_PURPOSE_BUDGET.maxOutputTokens);
  });
});

describe("the imports relation, which is the only one whose target already has words", () => {
  it("still gets its own question", () => {
    const { asks } = buildPurposeAsks({
      nodes: [file("a.ts"), file("b.ts")],
      edges: [imports("a.ts", "b.ts")],
    });
    expect(asks).toHaveLength(1);
    expect(asks[0].relation).toBe("imports");
    expect(asks[0].targetKind).toBe("file");
  });
});
