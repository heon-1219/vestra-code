import { describe, expect, it } from "vitest";

import type { NodeRef } from "@/analysis/ids";
import type { AnalyzedEdge } from "@/analysis/types";

import { groupByPurpose, groupsWorthAsking, purposeKey, spreadPurpose } from "./groups";

/**
 * Which connections count as the same connection.
 *
 * This is the whole economics of the feature and also its honesty: get the
 * grouping too coarse and one sentence is applied to jobs that are not the same
 * job, which is a false statement about someone's code repeated across a dozen
 * edges at once.
 */

const symbol = (name: string, file = "src/a.ts"): NodeRef => ({
  type: "symbol",
  filePath: file,
  name,
});

let n = 0;
function edge(
  source: NodeRef,
  target: NodeRef,
  type: AnalyzedEdge["type"],
): AnalyzedEdge {
  n += 1;
  return { source, target, type, confidence: "certain", metadata: { n } };
}

const idOf = (e: AnalyzedEdge) => String(e.metadata?.n);
const targetOf = (e: AnalyzedEdge) => `${e.target.filePath}#${e.target.name}`;

describe("groupByPurpose", () => {
  it("puts every caller of one function in one group", () => {
    // Twelve components calling formatPrice are twelve edges and one purpose.
    // Asking about each separately would cost twelve questions and return
    // twelve wordings of the same fact.
    const target = symbol("formatPrice", "src/price.ts");
    const edges = [
      edge(symbol("PayButton", "src/Pay.tsx"), target, "calls"),
      edge(symbol("Receipt", "src/Receipt.tsx"), target, "calls"),
      edge(symbol("Total", "src/Total.tsx"), target, "calls"),
    ];

    const groups = groupByPurpose(edges, idOf, targetOf);

    expect(groups).toHaveLength(1);
    expect(groups[0].edgeIds).toHaveLength(3);
    expect(groups[0].sources).toBe(3);
  });

  it("keeps two different jobs apart even under one relation", () => {
    // Every `calls` edge in a project is not one purpose. Collapsing them
    // produces a sentence so general it says nothing — which is the generic
    // verb this feature exists to replace.
    const caller = symbol("Checkout", "src/Checkout.tsx");
    const groups = groupByPurpose(
      [
        edge(caller, symbol("formatPrice", "src/price.ts"), "calls"),
        edge(caller, symbol("chargeCard", "src/pay.ts"), "calls"),
      ],
      idOf,
      targetOf,
    );

    expect(groups).toHaveLength(2);
  });

  it("separates two relations that happen to share a target", () => {
    // Rendering a component and importing its file are different statements
    // about the same thing.
    const target = symbol("PriceTag", "src/PriceTag.tsx");
    const from = symbol("Cart", "src/Cart.tsx");
    const groups = groupByPurpose(
      [edge(from, target, "renders"), edge(from, target, "imports")],
      idOf,
      targetOf,
    );

    expect(groups).toHaveLength(2);
  });

  it("counts places rather than edges", () => {
    // One file calling the same helper twice is one place doing one thing,
    // not two places agreeing — and `sources` is what decides which groups
    // are worth a question.
    const target = symbol("formatPrice", "src/price.ts");
    const once = symbol("Receipt", "src/Receipt.tsx");
    const groups = groupByPurpose(
      [edge(once, target, "calls"), edge(once, target, "calls")],
      idOf,
      targetOf,
    );

    expect(groups[0].edgeIds).toHaveLength(2);
    expect(groups[0].sources).toBe(1);
  });

  it("explains nothing about a file holding a piece", () => {
    // `contains` is the structure read back aloud. The map says it by drawing
    // one inside the other; a sentence saying it again is noise with a cost.
    const groups = groupByPurpose(
      [edge(symbol("a.ts"), symbol("thing"), "contains")],
      idOf,
      targetOf,
    );
    expect(groups).toHaveLength(0);
  });

  it("orders by how many places reach for it, deterministically", () => {
    const busy = symbol("formatPrice", "src/price.ts");
    const quiet = symbol("rarely", "src/rare.ts");
    const groups = groupByPurpose(
      [
        edge(symbol("A", "a.tsx"), quiet, "calls"),
        edge(symbol("B", "b.tsx"), busy, "calls"),
        edge(symbol("C", "c.tsx"), busy, "calls"),
      ],
      idOf,
      targetOf,
    );

    expect(groups[0].targetId).toContain("formatPrice");
    expect(groups.map((g) => g.sources)).toEqual([2, 1]);
  });
});

describe("groupsWorthAsking", () => {
  it("takes the most-reached-for, and nothing when there is no budget", () => {
    const groups = groupByPurpose(
      [
        edge(symbol("A"), symbol("x", "x.ts"), "calls"),
        edge(symbol("B"), symbol("x", "x.ts"), "calls"),
        edge(symbol("C"), symbol("y", "y.ts"), "calls"),
      ],
      idOf,
      targetOf,
    );

    expect(groupsWorthAsking(groups, 1)).toHaveLength(1);
    expect(groupsWorthAsking(groups, 1)[0].targetId).toContain("x");
    expect(groupsWorthAsking(groups, 0)).toHaveLength(0);
  });
});

describe("spreadPurpose", () => {
  it("gives one answer to every edge that shares it", () => {
    // The reuse: the twelfth caller is told the same thing as the first, for
    // free and in the same words.
    const target = symbol("formatPrice", "src/price.ts");
    const groups = groupByPurpose(
      [
        edge(symbol("A", "a.tsx"), target, "calls"),
        edge(symbol("B", "b.tsx"), target, "calls"),
      ],
      idOf,
      targetOf,
    );

    const spread = spreadPurpose(
      groups,
      new Map([[groups[0].key, "가격을 사람이 읽는 모양으로 바꿔요"]]),
    );

    expect([...spread.values()]).toEqual([
      "가격을 사람이 읽는 모양으로 바꿔요",
      "가격을 사람이 읽는 모양으로 바꿔요",
    ]);
  });

  it("leaves an unanswered group alone rather than inventing one", () => {
    const groups = groupByPurpose(
      [edge(symbol("A"), symbol("x", "x.ts"), "calls")],
      idOf,
      targetOf,
    );
    expect(spreadPurpose(groups, new Map()).size).toBe(0);
  });
});

describe("purposeKey", () => {
  it("cannot confuse two different pairs", () => {
    // Without a separator, ("calls", "x") and ("call", "sx") are the same key.
    // Harmless with today's relation names and a silent wrong answer the day
    // one of them changes — which is precisely the kind of bug that gets
    // written once and found years later.
    expect(purposeKey("calls", "x")).not.toBe(purposeKey("call", "sx"));
  });
});
