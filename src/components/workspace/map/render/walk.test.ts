import { describe, expect, it } from "vitest";

import type { QaTrail } from "@/qa";

import { NO_TRAIL, linkStrength, stepFor, type MapLink } from "./scene";
import { trailFrom } from "./walk";

/**
 * The join between the account and the picture.
 *
 * Small on purpose: everything load-bearing about the walk is already tested on
 * one side or the other — that the loop records the right points in
 * `src/qa/trail.test.ts`, that the renderer dims everything off the path in
 * `scene.test.ts`. What is left is the translation itself, and the way a
 * translation goes wrong is by saying slightly more than the original did.
 */

function qaTrail(partial: Partial<QaTrail> = {}): QaTrail {
  return { points: [], hops: [], unplaced: [], ...partial };
}

function point(id: string, critical = false) {
  return { id, number: 0, step: 1, leg: 1, critical };
}

function hop(from: string, to: string) {
  return {
    connectionId: `${from}-${to}`,
    from,
    to,
    relation: "calls" as const,
    certainty: "certain" as const,
    step: 1,
    via: "opened" as const,
  };
}

function link(from: string, to: string): MapLink {
  return {
    from,
    to,
    relation: "calls",
    certainty: "certain",
    rank: 0,
    lane: 0,
    crossing: false,
  };
}

describe("the walk, translated for the map", () => {
  it("is nothing at all when there was no walk", () => {
    expect(trailFrom(null)).toBe(NO_TRAIL);
    expect(trailFrom(qaTrail())).toBe(NO_TRAIL);
  });

  it("lights every place the walk touched", () => {
    const trail = trailFrom(
      qaTrail({ points: [point("a"), point("b"), point("c")] }),
    );

    expect([...trail.lit].sort()).toEqual(["a", "b", "c"]);
  });

  it("marks only the places the answer rests on", () => {
    // Visited and abandoned has to look different from visited and cited, or
    // the picture claims more than the citations do.
    const trail = trailFrom(
      qaTrail({ points: [point("a", true), point("b"), point("c", true)] }),
    );

    expect([...trail.critical].sort()).toEqual(["a", "c"]);
  });

  it("numbers the crossings, not the loop's steps", () => {
    // One step that opened an item and was handed three connections is three
    // lines. Three lines wearing the same number read as one thing drawn wrong.
    const trail = trailFrom(
      qaTrail({
        points: [point("a"), point("b"), point("c")],
        hops: [hop("a", "b"), hop("a", "c")],
      }),
    );

    expect(trail.steps.map((step) => step.order)).toEqual([1, 2]);
  });

  it("calls a line evidence only when both places it joins are", () => {
    const trail = trailFrom(
      qaTrail({
        points: [point("a", true), point("b", true), point("c")],
        hops: [hop("a", "b"), hop("b", "c")],
      }),
    );

    expect(trail.steps[0].critical).toBe(true);
    // `c` was walked to and never cited. The line into it is not evidence.
    expect(trail.steps[1].critical).toBe(false);
  });

  it("leaves a restart as a gap rather than inventing a line", () => {
    // Two places, nothing between them: the loop gave up and searched again.
    // The map lights both and draws nothing, which is what happened.
    const trail = trailFrom(
      qaTrail({ points: [point("a"), point("b")], hops: [] }),
    );

    expect(trail.lit.has("b")).toBe(true);
    expect(trail.steps).toEqual([]);
  });

  it("keeps the shortcut dark when the walk went the long way", () => {
    /*
     * The reason the renderer takes an ordered list of hops and not a set of
     * lit ids. A walk a → b → c on a graph that also holds a → c has three lit
     * items, and "a line is as strong as its weaker end" would draw the
     * shortcut exactly as brightly as the path that was actually taken.
     */
    const trail = trailFrom(
      qaTrail({
        points: [point("a"), point("b"), point("c")],
        hops: [hop("a", "b"), hop("b", "c")],
      }),
    );
    const focus = { id: null, lit: new Set<string>() };
    const beam = { active: false, matched: new Set<string>() };

    expect(stepFor(link("a", "b"), trail)).not.toBeNull();
    expect(stepFor(link("a", "c"), trail)).toBeNull();
    expect(linkStrength(link("a", "b"), focus, beam, trail)).toBe(1);
    expect(linkStrength(link("a", "c"), focus, beam, trail)).toBeLessThan(1);
  });
});
