import { describe, expect, it } from "vitest";

import type { AskFrame } from "./frames";
import { applyFrame, failSession, itemsSeen, startSession, type AskSession } from "./session";

/**
 * The fold, driven by arrival order.
 *
 * Almost everything that can go wrong here is a lateness bug: a conclusion that
 * belongs to step 2 landing on step 3, a trail that arrives before the last
 * step, an answer that overwrites something the person already read. None of
 * those are visible by using the product once — they need a particular order —
 * so they are pinned here instead.
 */

let seq = 0;
function frame(type: string, payload: unknown): AskFrame {
  seq += 1;
  return { seq, type, payload };
}

function fold(frames: readonly AskFrame[], question = "가격이 이상해요"): AskSession {
  return frames.reduce(applyFrame, startSession(question));
}

const took = (step: number, note: string, items: string[] = []) =>
  frame("step.taken", { step, tool: "read_source", hypothesis: "가설", note, items });

describe("one question, folded from its frames", () => {
  it("starts with the question and nothing else", () => {
    const session = startSession("가격이 이상해요");

    expect(session.status).toBe("asking");
    expect(session.question).toBe("가격이 이상해요");
    expect(session.steps).toEqual([]);
    expect(session.answer).toBeNull();
    expect(session.trail).toBeNull();
  });

  it("keeps the steps in the order they were taken", () => {
    const session = fold([took(1, "하나"), took(2, "둘"), took(3, "셋")]);
    expect(session.steps.map((step) => step.note)).toEqual(["하나", "둘", "셋"]);
  });

  it("attaches a conclusion to the step it names, not the latest one", () => {
    /*
     * The whole reason this is a fold and not an append. The loop gets step 1's
     * conclusion out of step 2's tool call, so it always arrives late — a
     * reader that put it at the end would caption every step with the meaning
     * of the one before it.
     */
    const session = fold([
      took(1, "하나"),
      took(2, "둘"),
      frame("step.concluded", { step: 1, conclusion: "여기는 아니었어요" }),
    ]);

    expect(session.steps[0].conclusion).toBe("여기는 아니었어요");
    expect(session.steps[1].conclusion).toBeNull();
  });

  it("leaves the last step unconcluded rather than inventing one", () => {
    const session = fold([took(1, "하나")]);
    expect(session.steps[0].conclusion).toBeNull();
  });

  it("keeps a conclusion when its step is taken again", () => {
    // A report step that failed its check is retried under the same number.
    // The row is replaced, not doubled — and what was already learned about it
    // does not disappear on the retry.
    const session = fold([
      took(1, "처음"),
      frame("step.concluded", { step: 1, conclusion: "배운 것" }),
      took(1, "다시"),
    ]);

    expect(session.steps).toHaveLength(1);
    expect(session.steps[0].note).toBe("다시");
    expect(session.steps[0].conclusion).toBe("배운 것");
  });

  it("collects what each step put the loop in front of, each place once", () => {
    const session = fold([
      took(1, "하나", ["a", "b"]),
      took(2, "둘", ["b", "c"]),
    ]);

    expect(itemsSeen(session)).toEqual(["a", "b", "c"]);
  });

  it("keeps a claim that did not survive checking", () => {
    // Hiding this would make the product look more certain than it is. Showing
    // it is the plainest evidence the citation check is real.
    const session = fold([
      frame("finding.refused", { claim: "여기가 문제예요", reason: "uncited" }),
    ]);

    expect(session.refused).toEqual([{ claim: "여기가 문제예요", reason: "uncited" }]);
  });

  it("takes the walk and the answer", () => {
    const trail = { points: [{ id: "a", number: 1, step: 1, leg: 1, critical: true }], hops: [], unplaced: [] };
    const session = fold([
      took(1, "하나", ["a"]),
      frame("qa.trail", trail),
      frame("qa.answer", {
        summary: "여기가 문제예요.",
        findings: [],
        ruledOut: [],
        stop: "answered",
        spent: { steps: 1, inputTokens: 100, outputTokens: 20, millis: 900 },
      }),
    ]);

    expect(session.status).toBe("answered");
    expect(session.answer?.summary).toBe("여기가 문제예요.");
    expect(session.trail?.points[0].critical).toBe(true);
  });

  it("ignores a frame it does not know", () => {
    // New event types get added to the loop. An older screen must go on
    // showing what it does understand rather than falling over.
    const session = fold([took(1, "하나"), frame("qa.something.new", { a: 1 })]);
    expect(session.steps).toHaveLength(1);
  });

  it("ignores a frame whose payload does not make sense", () => {
    const session = fold([
      frame("step.taken", { step: "첫번째" }),
      frame("step.concluded", { conclusion: "누구의?" }),
      frame("qa.answer", { findings: [] }),
    ]);

    expect(session.steps).toEqual([]);
    expect(session.answer).toBeNull();
    expect(session.status).toBe("asking");
  });
});

describe("when the stream breaks", () => {
  it("says so when nothing had been answered", () => {
    const session = failSession(fold([took(1, "하나")]), "연결이 끊겼어요.");

    expect(session.status).toBe("failed");
    expect(session.error).toBe("연결이 끊겼어요.");
    // What it managed to show is still there. The person watched those happen.
    expect(session.steps).toHaveLength(1);
  });

  it("leaves an answer that already arrived alone", () => {
    // A socket that dropped after the answer still answered. Replacing that
    // with an error would throw away something true the person already read.
    const answered = fold([
      frame("qa.answer", { summary: "여기가 문제예요.", findings: [], ruledOut: [] }),
    ]);
    const session = failSession(answered, "연결이 끊겼어요.");

    expect(session.status).toBe("answered");
    expect(session.answer?.summary).toBe("여기가 문제예요.");
    expect(session.error).toBeNull();
  });
});
