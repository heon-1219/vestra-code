import { describe, expect, it } from "vitest";

import {
  LabelField,
  lineBox,
  nameCandidates,
  MAX_LINES_THROUGH_A_WORD,
  RELATION_STOPS,
  WORD_AVOID,
} from "./labels";

/**
 * The rule this file exists for, as tests.
 *
 * **A label drawn over another label is worse than no label.** Everything below
 * is that sentence taken apart: a word takes the first free place from a fixed
 * list, it is refused rather than moved somewhere meaningless, and the answer
 * does not depend on anything but the boxes and the order they arrived in.
 */

const box = (cx: number, cy: number, width = 40, height = 14, angle = 0) => ({
  cx,
  cy,
  width,
  height,
  angle,
});

describe("the label field", () => {
  it("gives a word the first place on its list that is free", () => {
    const field = new LabelField(400, 400);
    const first = field.place([box(100, 100), box(100, 200)], "name", ["name"]);
    expect(first?.cy).toBe(100);
  });

  it("moves a word to its next place rather than laying it on one already there", () => {
    const field = new LabelField(400, 400);
    field.place([box(100, 100)], "name", ["name"]);
    const second = field.place([box(100, 104), box(100, 200)], "name", ["name"]);
    expect(second?.cy).toBe(200);
  });

  it("draws nothing at all when no place on the list is free", () => {
    const field = new LabelField(400, 400);
    field.place([box(100, 100)], "name", ["name"]);
    field.place([box(100, 200)], "name", ["name"]);
    // Both candidates land on something already placed. Null is the answer, and
    // the caller has to honour it.
    expect(field.place([box(100, 102), box(100, 198)], "name", ["name"])).toBeNull();
  });

  it("lets a name sit against the dot it belongs to and no other", () => {
    const field = new LabelField(400, 400);
    field.block(box(100, 100, 20, 20), "dot", "mine");
    field.block(box(160, 100, 20, 20), "dot", "yours");
    expect(field.place([box(100, 100)], "name", ["dot"], "mine")).not.toBeNull();
    expect(field.place([box(160, 100)], "name", ["dot"], "mine")).toBeNull();
  });

  it("refuses a place that is off the edge of the canvas", () => {
    const field = new LabelField(400, 400);
    // A word beyond the right edge is a text layout and a fill for nobody. At a
    // deep zoom, measured on a 1,442-item project, 512 of these a frame.
    expect(field.place([box(900, 100)], "relation", ["name"])).toBeNull();
    expect(field.place([box(395, 100)], "relation", ["name"])).not.toBeNull();
  });

  it("only cares about the classes it was asked to avoid", () => {
    const field = new LabelField(400, 400);
    field.block(box(100, 100), "line", null);
    expect(field.place([box(100, 100)], "relation", ["line"])).toBeNull();
    expect(field.place([box(100, 100)], "relation", WORD_AVOID)).not.toBeNull();
  });

  it("counts how crowded a place is rather than only whether it is free", () => {
    const field = new LabelField(400, 400);
    field.blockLine(0, 100, 400, 100, "a");
    field.blockLine(0, 98, 400, 102, "b");
    field.blockLine(200, 0, 200, 400, "c");
    // Three lines cross the middle, and one of them is the word's own.
    expect(field.count(box(200, 100), ["line"], null)).toBe(3);
    expect(field.count(box(200, 100), ["line"], "c")).toBe(2);
    expect(field.count(box(40, 300), ["line"], null)).toBe(0);
  });

  it("insists where a walk's own numbers are concerned, and blocks what follows", () => {
    const field = new LabelField(400, 400);
    field.place([box(100, 100)], "name", ["name"]);
    // A walk with step 2 missing is not a smaller picture, it is a wrong one.
    const forced = field.insist(box(100, 100), "relation");
    expect(forced.cy).toBe(100);
    // And everything after it avoids the spot it took.
    expect(field.place([box(100, 100)], "name", ["relation"])).toBeNull();
  });

  it("knows a turned word from an upright one", () => {
    const upright = new LabelField(400, 400);
    upright.place([box(100, 100, 80, 14)], "relation", ["relation"]);
    // Same centre, a quarter turn apart: their bounding boxes overlap almost
    // entirely and the words themselves cross in a small X, which is a real
    // collision. A box turned far enough away, though, misses.
    expect(upright.place([box(100, 100, 80, 14, Math.PI / 2)], "relation", ["relation"]))
      .toBeNull();

    const apart = new LabelField(400, 400);
    apart.place([box(100, 100, 80, 14)], "relation", ["relation"]);
    // Offset along the first word's length: an upright test on bounding boxes
    // would still call this a collision, and it is not one.
    expect(apart.place([box(100, 130, 14, 80, Math.PI / 2)], "relation", ["relation"]))
      .not.toBeNull();
  });

  it("gives the same answer twice for the same boxes in the same order", () => {
    const run = () => {
      const field = new LabelField(400, 400);
      const out: (number | null)[] = [];
      for (let i = 0; i < 40; i++) {
        const spot = field.place(
          [box(100 + (i % 7) * 12, 100 + (i % 5) * 9), box(300, 100 + i * 3)],
          "name",
          ["name"],
        );
        out.push(spot ? spot.cx * 1000 + spot.cy : null);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe("where a name may go", () => {
  it("offers under the dot first, because that is where names have always been", () => {
    const [first] = nameCandidates(100, 100, 6, 40, 14);
    expect(first.cy).toBeGreaterThan(100);
    expect(first.align).toBe("center");
  });

  it("offers four places, and each one clears the dot", () => {
    const candidates = nameCandidates(100, 100, 6, 40, 14);
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) {
      const dx = Math.max(0, Math.abs(candidate.cx - 100) - candidate.width / 2);
      const dy = Math.max(0, Math.abs(candidate.cy - 100) - candidate.height / 2);
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(6);
    }
  });

  it("aligns a name pushed out sideways away from its dot", () => {
    const candidates = nameCandidates(100, 100, 6, 40, 14);
    const right = candidates.find((one) => one.cx > 100);
    const left = candidates.find((one) => one.cx < 100);
    expect(right?.align).toBe("left");
    expect(left?.align).toBe("right");
  });
});

describe("where a word on a line may go", () => {
  it("starts at the middle and never leaves the line", () => {
    expect(RELATION_STOPS[0]).toBe(0.5);
    for (const stop of RELATION_STOPS) {
      expect(stop).toBeGreaterThan(0);
      expect(stop).toBeLessThan(1);
    }
  });

  it("never allows a word over a word or over a dot, at any density", () => {
    expect(WORD_AVOID).toContain("name");
    expect(WORD_AVOID).toContain("relation");
    expect(WORD_AVOID).toContain("district");
    expect(WORD_AVOID).toContain("dot");
    // Lines are the one thing judged by how many rather than whether: refusing
    // every crossed spot took the relation words on a 1,442-item project to
    // one, and accepting any spot put seventeen lines through the average word.
    expect(WORD_AVOID).not.toContain("line");
    expect(MAX_LINES_THROUGH_A_WORD).toBeGreaterThan(0);
    expect(MAX_LINES_THROUGH_A_WORD).toBeLessThan(5);
  });
});

describe("a line, as something to stay off", () => {
  it("lies along the line it was made from", () => {
    const flat = lineBox(0, 0, 100, 0);
    expect(flat.cx).toBe(50);
    expect(flat.cy).toBe(0);
    expect(flat.width).toBe(100);
    expect(flat.angle).toBeCloseTo(0, 6);

    const diagonal = lineBox(0, 0, 30, 40);
    expect(diagonal.width).toBeCloseTo(50, 6);
    expect(diagonal.angle).toBeCloseTo(Math.atan2(40, 30), 6);
  });
});
