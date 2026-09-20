import { describe, expect, it } from "vitest";

import { layoutChanges, type ChangeGraph, type LaneCommit } from "./lanes";

/**
 * Where each change sits, and which lines join which.
 *
 * This is the half of the band that is wrong without looking wrong. A lane
 * assignment that is off still renders a tidy branch graph; it is simply a
 * branch graph of a history that is not the user's, and there is nothing on
 * the screen to check it against. So the cases here are the ones where the
 * picture and the truth can come apart quietly: a merge, a branch point seen
 * from below, a parent that was never sent, and a list that is not in ancestry
 * order because GitHub sorts by date.
 */

/** `a` with parents `b`, `c`. Full SHAs are noise in a fixture. */
const c = (sha: string, ...parents: string[]): LaneCommit => ({ sha, parents });

const laneOf = (graph: ChangeGraph, sha: string) =>
  graph.nodes.find((node) => node.sha === sha)?.lane;

const nodeOf = (graph: ChangeGraph, sha: string) =>
  graph.nodes.find((node) => node.sha === sha);

const edgeBetween = (graph: ChangeGraph, from: string, to: string) =>
  graph.edges.find((edge) => edge.fromSha === from && edge.toSha === to);

describe("layoutChanges", () => {
  it("draws nothing for a project with no changes", () => {
    expect(layoutChanges([])).toEqual({ nodes: [], edges: [], laneCount: 0 });
  });

  it("keeps a straight history in one lane", () => {
    const graph = layoutChanges([c("c", "b"), c("b", "a"), c("a")]);

    expect(graph.laneCount).toBe(1);
    expect(graph.nodes.map((node) => node.lane)).toEqual([0, 0, 0]);
    expect(graph.nodes.map((node) => node.row)).toEqual([0, 1, 2]);
    expect(graph.edges).toHaveLength(2);
  });

  it("puts a merge's second parent in its own lane and says it is a merge", () => {
    /*
     *   m      merge of `side` into `main`
     *   |\
     *   | s    the branch
     *   |/
     *   b      where they split
     */
    const graph = layoutChanges([
      c("m", "main", "side"),
      c("main", "base"),
      c("side", "base"),
      c("base"),
    ]);

    expect(nodeOf(graph, "m")?.merge).toBe(true);
    expect(laneOf(graph, "m")).toBe(0);
    expect(laneOf(graph, "main")).toBe(0);
    // The second parent cannot share the first parent's column, or the picture
    // would show one line of work where there were two.
    expect(laneOf(graph, "side")).toBe(1);
    expect(graph.laneCount).toBe(2);

    expect(edgeBetween(graph, "m", "side")?.parentIndex).toBe(1);
    expect(edgeBetween(graph, "m", "main")?.parentIndex).toBe(0);
  });

  it("calls a change with two children a split, and only that change", () => {
    const graph = layoutChanges([
      c("m", "main", "side"),
      c("main", "base"),
      c("side", "base"),
      c("base"),
    ]);

    expect(nodeOf(graph, "base")?.split).toBe(true);
    expect(nodeOf(graph, "main")?.split).toBe(false);
    expect(nodeOf(graph, "side")?.split).toBe(false);
    // And the merge itself is not a split: two lines arrived, none left.
    expect(nodeOf(graph, "m")?.split).toBe(false);
  });

  it("frees a lane once both its children have been passed", () => {
    // After `base` collapses the two lanes, a later unrelated tip should be
    // able to reuse the column rather than widening the picture forever.
    const graph = layoutChanges([
      c("m", "main", "side"),
      c("main", "base"),
      c("side", "base"),
      c("base", "root"),
      c("root"),
    ]);

    expect(laneOf(graph, "base")).toBe(0);
    expect(laneOf(graph, "root")).toBe(0);
    expect(graph.laneCount).toBe(2);
  });

  it("draws no line to a parent it was never sent, and says the line goes on", () => {
    const graph = layoutChanges([c("b", "a"), c("a", "older")]);

    expect(graph.edges).toHaveLength(1);
    expect(edgeBetween(graph, "a", "older")).toBeUndefined();
    expect(nodeOf(graph, "a")?.continues).toBe(true);
    expect(nodeOf(graph, "b")?.continues).toBe(false);
  });

  it("refuses to draw a line upwards when a parent is dated after its child", () => {
    /*
     * A rebase or a cherry-pick can date a parent later than its own child, and
     * GitHub returns commits by date. An upward line in a picture whose whole
     * grammar is "older is further down" would have the picture contradicting
     * itself.
     */
    const graph = layoutChanges([c("parent"), c("child", "parent")]);

    expect(edgeBetween(graph, "child", "parent")).toBeUndefined();
    expect(graph.edges).toHaveLength(0);
    // Not "continues" either: the parent is in the window, we simply will not
    // draw a line backwards to it.
    expect(nodeOf(graph, "child")?.continues).toBe(false);
  });

  it("gives every change exactly one row, even if a sha arrives twice", () => {
    const graph = layoutChanges([c("b", "a"), c("b", "a"), c("a")]);

    expect(graph.nodes.map((node) => node.sha)).toEqual(["b", "a"]);
    expect(graph.nodes.map((node) => node.row)).toEqual([0, 1]);
  });

  it("does not count a repeated parent as two children", () => {
    // Degenerate but legal. Two parents that are the same commit is not a
    // branch point, and calling it one would print 여기에서 갈라졌어요 on a
    // change nothing split at.
    const graph = layoutChanges([c("m", "a", "a"), c("a")]);

    expect(nodeOf(graph, "a")?.split).toBe(false);
    expect(nodeOf(graph, "m")?.merge).toBe(false);
    expect(graph.laneCount).toBe(1);
  });

  it("holds three concurrent lines apart", () => {
    /*
     * Two merges in a row, which is what a week of a real project looks like.
     * The point of the case is that nothing collapses early: three separate
     * lines of work must occupy three columns while all three are open.
     */
    const graph = layoutChanges([
      c("m2", "m1", "third"),
      c("m1", "main", "second"),
      c("main", "base"),
      c("second", "base"),
      c("third", "base"),
      c("base"),
    ]);

    const lanes = new Set([
      laneOf(graph, "main"),
      laneOf(graph, "second"),
      laneOf(graph, "third"),
    ]);
    expect(lanes.size).toBe(3);
    expect(graph.laneCount).toBe(3);
    expect(nodeOf(graph, "base")?.split).toBe(true);
  });

  it("gives a parent every line that leads to it", () => {
    const graph = layoutChanges([
      c("m", "main", "side"),
      c("main", "base"),
      c("side", "base"),
      c("base"),
    ]);

    const intoBase = graph.edges.filter((edge) => edge.toSha === "base");
    expect(intoBase.map((edge) => edge.fromSha).sort()).toEqual(["main", "side"]);
    // Both arrive at the lane `base` actually sits in, or one of them would be
    // drawn pointing at empty space beside it.
    for (const edge of intoBase) {
      expect(edge.toLane).toBe(laneOf(graph, "base"));
    }
  });
});
