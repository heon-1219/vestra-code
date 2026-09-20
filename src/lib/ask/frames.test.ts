import { describe, expect, it } from "vitest";

import { toSseFrame } from "@/analysis/events";

import { createFrameReader, type AskFrame } from "./frames";

/**
 * The framing, driven by the thing that actually breaks it: chunk boundaries.
 *
 * A hand-rolled SSE reader almost never fails on a well-formed frame. It fails
 * when the network hands it half of one, which a fast local server will not do
 * and a real connection does constantly. So most of this file feeds the same
 * bytes in different splits and demands the same frames out — including the
 * cruel split, one character at a time.
 *
 * Frames are built with `toSseFrame`, the same function the server writes with.
 * A test that hand-wrote the wire format would keep passing after the server
 * changed it.
 */

function framesFrom(chunks: readonly string[]): AskFrame[] {
  const reader = createFrameReader();
  const out: AskFrame[] = [];
  for (const chunk of chunks) out.push(...reader.push(chunk));
  out.push(...reader.flush());
  return out;
}

const STEP = toSseFrame({
  seq: 1,
  type: "step.taken",
  payload: { step: 1, tool: "read_source", items: ["s-format"] },
});
const ANSWER = toSseFrame({
  seq: 2,
  type: "qa.answer",
  payload: { summary: "여기가 문제예요." },
});

describe("reading the answer stream", () => {
  it("reads a frame the server wrote", () => {
    expect(framesFrom([STEP])).toEqual([
      {
        seq: 1,
        type: "step.taken",
        payload: { step: 1, tool: "read_source", items: ["s-format"] },
      },
    ]);
  });

  it("reads two frames that arrived in one chunk", () => {
    const frames = framesFrom([STEP + ANSWER]);
    expect(frames.map((frame) => frame.type)).toEqual(["step.taken", "qa.answer"]);
  });

  it("holds a frame that is only half here", () => {
    const reader = createFrameReader();
    const half = Math.floor(STEP.length / 2);

    // Nothing may be emitted from an incomplete frame. A reader that guessed
    // here would put a truncated step on screen and then correct itself.
    expect(reader.push(STEP.slice(0, half))).toEqual([]);
    expect(reader.push(STEP.slice(half))).toHaveLength(1);
  });

  it("reads the same frames however the bytes were split", () => {
    const whole = STEP + ANSWER;
    const expected = framesFrom([whole]);

    // Every split point, including inside the blank line that separates the two
    // frames — the one boundary a naive `indexOf` gets wrong.
    for (let at = 1; at < whole.length; at++) {
      expect(framesFrom([whole.slice(0, at), whole.slice(at)]), `split at ${at}`).toEqual(
        expected,
      );
    }
  });

  it("reads the same frames one character at a time", () => {
    expect(framesFrom([...STEP + ANSWER])).toEqual(framesFrom([STEP + ANSWER]));
  });

  it("ignores a keepalive without mistaking it for an event", () => {
    // Arrives on a timer during a long step. A reader that treated it as a
    // frame would emit an event with no type every few seconds.
    expect(framesFrom([": keepalive\n\n" + STEP])).toHaveLength(1);
  });

  it("survives line endings a proxy rewrote", () => {
    const rewritten = STEP.replace(/\n/g, "\r\n");
    expect(framesFrom([rewritten])).toEqual(framesFrom([STEP]));
  });

  it("drops a frame it cannot read rather than ending the stream", () => {
    // One bad frame must not throw away the steps already on screen or the
    // answer still coming.
    const frames = framesFrom([
      "id: 1\nevent: step.taken\ndata: {not json\n\n" + ANSWER,
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("qa.answer");
  });

  it("keeps a payload that begins with a space", () => {
    // Exactly one space after the colon belongs to the format. A reader that
    // trimmed would corrupt any payload whose own text starts with one.
    const frames = framesFrom(['id: 1\nevent: t\ndata: " hi"\n\n']);
    expect(frames[0].payload).toBe(" hi");
  });

  it("gives back a last frame the server did not close", () => {
    // A stream that ends without its blank line. The final frame is usually the
    // answer, and losing it in silence is the worst way for this to fail.
    const frames = framesFrom([STEP.trimEnd()]);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("step.taken");
  });

  it("has nothing left to flush after a well-formed stream", () => {
    const reader = createFrameReader();
    reader.push(STEP + ANSWER);
    expect(reader.flush()).toEqual([]);
  });
});
