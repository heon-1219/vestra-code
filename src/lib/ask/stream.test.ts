import { describe, expect, it } from "vitest";

import { SSE_HEADERS } from "@/analysis/events";
import { createFrameReader } from "@/lib/ask/frames";
import {
  ASK_HEARTBEAT_INTERVAL_MS,
  ASK_SSE_HEADERS,
  askEventStream,
} from "@/lib/ask/stream";

/**
 * The answer stream's transport, which went to production without a heartbeat.
 *
 * These are regression tests for a live fault rather than unit tests of a
 * helper, so they are written against the two things that were actually wrong
 * and would be wrong again if someone inlined this back into the route:
 *
 *   1. **The headers.** Railway needs `no-transform` (a gzipping proxy buffers
 *      the whole stream without it, and every step arrives at once after the
 *      answer is already finished) and `X-Accel-Buffering: no`. Asserted
 *      against `SSE_HEADERS` itself rather than against string literals, so a
 *      change to the shared value cannot leave this endpoint behind — which is
 *      exactly the drift that produced the bug.
 *   2. **The heartbeat.** Railway closes a request after five minutes with no
 *      data transferred, and a `deep` investigation is silent for as long as
 *      the model thinks.
 *
 * This file imports `@/lib/ask/stream` and `@/analysis/events` and nothing
 * else from the app. Importing the route would drag in `@/db` and `@/lib/llm`,
 * both of which sit on `@/lib/env` — 21 variables validated at import time,
 * and a throw if one is missing.
 *
 * No millisecond budget is asserted anywhere below. The heartbeat test drives
 * the clock by *reading* rather than by waiting: it holds the run open until
 * the keepalives it is looking for have arrived, so it cannot be flaked by a
 * machine that is busy building four other agents' branches.
 */

/** Read frames until `enough` says stop, then return everything seen. */
async function collect(
  stream: ReadableStream<Uint8Array>,
  enough: (chunks: string[]) => boolean,
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
    if (enough(chunks)) break;
  }
  return chunks;
}

const keepalives = (chunks: string[]) =>
  chunks.filter((c) => c.startsWith(":")).length;

describe("ASK_SSE_HEADERS", () => {
  it("carries every header the analysis stream carries", () => {
    // Value-for-value, not key-for-key: a `Content-Type` that lost its charset
    // or an `X-Accel-Buffering` spelt `off` would pass a key check.
    for (const [name, value] of Object.entries(SSE_HEADERS)) {
      if (name === "Cache-Control") continue;
      expect(ASK_SSE_HEADERS[name as keyof typeof ASK_SSE_HEADERS]).toBe(value);
    }
  });

  it("keeps no-transform, which is what stops a proxy buffering the stream", () => {
    expect(ASK_SSE_HEADERS["Cache-Control"]).toContain("no-transform");
  });

  it("refuses to be stored anywhere, unlike the analysis stream", () => {
    // One person's question and quotations from one person's source. This is
    // the one directive where the ask stream is deliberately stricter than the
    // shared value, so it is asserted rather than inherited.
    expect(ASK_SSE_HEADERS["Cache-Control"]).toContain("no-store");
    expect(ASK_SSE_HEADERS["Cache-Control"]).toContain("private");
  });

  it("tells nginx not to buffer", () => {
    expect(ASK_SSE_HEADERS["X-Accel-Buffering"]).toBe("no");
  });

  it("stays well inside Railway's five-minute idle close", () => {
    // The heartbeat may fire late by a quarter of its own period; five minutes
    // is the wall. Compared as numbers so a future edit to the constant has to
    // be a deliberate one.
    expect(ASK_HEARTBEAT_INTERVAL_MS * 1.25).toBeLessThan(5 * 60 * 1000);
  });
});

describe("askEventStream", () => {
  it("opens with a keepalive before the run has emitted anything", async () => {
    let release = () => {};
    const stream = askEventStream({
      run: () => new Promise<void>((resolve) => (release = resolve)),
    });

    const chunks = await collect(stream, (c) => c.length >= 1);
    expect(chunks[0]).toBe(": keepalive\n\n");
    release();
  });

  it("keeps sending keepalives while the run is silent", async () => {
    let release = () => {};
    const stream = askEventStream({
      // Short enough that the test does not sit still, and never asserted on.
      heartbeatMs: 20,
      run: () => new Promise<void>((resolve) => (release = resolve)),
    });

    // Three, not one: the first is the opening frame, and a stream that sent
    // exactly one and then went quiet is the bug this file exists for.
    const chunks = await collect(stream, (c) => keepalives(c) >= 3);
    expect(keepalives(chunks)).toBeGreaterThanOrEqual(3);
    release();
  });

  it("numbers the frames it is given, in order, from one", async () => {
    const stream = askEventStream({
      heartbeatMs: 10_000,
      async run(send) {
        send("qa.step", { step: 1 });
        send("qa.step", { step: 2 });
        send("qa.answer", { summary: "찾았어요" });
      },
    });

    const text = (await collect(stream, () => false)).join("");
    const reader = createFrameReader();
    const frames = [...reader.push(text), ...reader.flush()];

    // The keepalives are dropped by the reader, which is the other half of the
    // contract: a comment frame must not reach the fold as an empty event.
    expect(frames.map((f) => [f.seq, f.type])).toEqual([
      [1, "qa.step"],
      [2, "qa.step"],
      [3, "qa.answer"],
    ]);
  });

  it("stops the timer when the run ends", async () => {
    const stream = askEventStream({
      heartbeatMs: 5,
      async run(send) {
        send("qa.answer", { summary: "끝났어요" });
      },
    });

    // The stream closing at all is the assertion: an interval still running
    // against a closed controller never lets the reader see `done`.
    const before = await collect(stream, () => false);
    expect(before.join("")).toContain("qa.answer");
  });

  it("survives a reader that goes away mid-answer", async () => {
    let sent = 0;
    const stream = askEventStream({
      heartbeatMs: 10_000,
      async run(send) {
        for (let i = 0; i < 50; i += 1) {
          send("qa.step", { step: i });
          sent += 1;
        }
      },
    });

    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    // The person closed the panel. Enqueueing into a cancelled stream must not
    // take the request down with it — the run finishes and is discarded.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toBe(50);
  });
});
