import { heartbeatFrame, SSE_HEADERS, toSseFrame } from "@/analysis/events";

/**
 * The transport half of the answer stream.
 *
 * `/api/projects/:id/ask` streams an investigation over SSE and the analysis
 * events route streams a run over SSE, and for a while they disagreed about
 * what that means on our host. The events route was written against D17 and
 * carries all three of its requirements; the ask route was written later, spelt
 * its own headers out by hand, and **had no heartbeat at all**.
 *
 * That was a live fault, not a tidiness one. Railway closes an HTTP request
 * after five minutes with no data transferred (D17), and the investigation loop
 * is silent for exactly as long as the model takes to think — a `deep` run on a
 * large project is routinely minutes inside one step, and there is no frame to
 * send while it happens. Silence past five minutes and the connection is closed
 * under an answer that was on its way. To the person watching, the steps stop
 * and the panel says the connection dropped.
 *
 * So the heartbeat is the feature, and it goes out **on a timer, unconditionally
 * of whether anything happened** — the same shape `events/route.ts` uses, for
 * the same reason.
 *
 * ## Why this module exists rather than a second copy in the route
 *
 * Nothing here is new machinery. `toSseFrame`, `heartbeatFrame` and
 * `SSE_HEADERS` all come from `@/analysis/events`, which is the one description
 * of what an SSE frame is in this codebase. What this adds is the *pump* — the
 * timer, and turning it off — and it lives here rather than inline in the route
 * for one specific reason: the route imports `@/db`, `@/qa` and `@/lib/llm`,
 * and `@/lib/env` sits underneath all three and **throws at import time** if any
 * of 21 environment variables is missing. A test that imported the route would
 * be testing the environment. This module imports one dependency-free module, so
 * the heartbeat can be tested for what it is.
 */

/**
 * Headers for the answer stream.
 *
 * `SSE_HEADERS` spread first so `Content-Type`, `Connection` and
 * `X-Accel-Buffering` have exactly one definition in the codebase — a second
 * spelling of `X-Accel-Buffering` is a spelling that can drift, and the way it
 * drifts is that one of two streams silently starts arriving in one burst at
 * the end.
 *
 * `Cache-Control` is then **strengthened rather than replaced**. It keeps
 * `no-cache` and `no-transform` from the shared value — `no-transform` is what
 * stops a gzipping proxy buffering the whole stream, which is most of why this
 * endpoint streams — and adds `no-store`, `private` and `must-revalidate`,
 * which the analysis stream does not need and this one does: an analysis event
 * is a count, and this carries one person's question and quotations from one
 * person's source. Nothing between them and us may hold a copy of it.
 */
export const ASK_SSE_HEADERS = {
  ...SSE_HEADERS,
  "Cache-Control":
    "no-store, no-cache, no-transform, must-revalidate, max-age=0, private",
} as const;

/**
 * How long the stream may be silent.
 *
 * Twenty seconds, matching `events/route.ts`. The number is set by Railway's
 * five-minute idle close (D17) with an order of magnitude of margin, not by
 * anything about the investigation loop — so a slow model, a paused proxy or a
 * step that takes a minute all cost nothing.
 */
export const ASK_HEARTBEAT_INTERVAL_MS = 20_000;

/** What the investigation calls to put one frame on the wire. */
export type AskEmit = (type: string, payload: unknown) => void;

export type AskStreamOptions = {
  /**
   * The investigation. Everything it emits is numbered and framed here, so the
   * caller never has to think about `seq` — a second numbering is a second
   * chance to skip one, and the browser reads gaps in `seq` as lost frames.
   */
  run: (emit: AskEmit) => Promise<void>;
  /** Silence budget. Overridden only by tests. */
  heartbeatMs?: number;
  /** The request's signal, so a client that leaves stops the timer. */
  signal?: AbortSignal;
};

/**
 * One investigation, as a stream of SSE frames.
 *
 * The contract, in the order it matters:
 *
 *   1. A keepalive goes out **first**, before the run starts. The response
 *      headers are flushed with it, so the browser has an open stream while the
 *      digest and the first model call are still happening — rather than a
 *      `fetch` that has not resolved yet.
 *   2. A keepalive goes out every `heartbeatMs` of silence thereafter, and a
 *      real frame resets the clock. Nothing on the wire is wasted while the
 *      loop is actually talking.
 *   3. The timer is cleared in a `finally`, and on abort. An interval left
 *      running against a closed controller is a handle per abandoned question.
 */
export function askEventStream(options: AskStreamOptions): ReadableStream<Uint8Array> {
  const heartbeatMs = options.heartbeatMs ?? ASK_HEARTBEAT_INTERVAL_MS;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastWriteAt = Date.now();

      const send = (frame: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
          lastWriteAt = Date.now();
        } catch {
          // The reader went away mid-answer. The run's own abort signal is what
          // stops the work; there is nothing to do about an enqueue on a closed
          // stream except not crash the request that owns it.
          closed = true;
        }
      };

      let seq = 0;
      const emit: AskEmit = (type, payload) => {
        seq += 1;
        send(toSseFrame({ seq, type, payload }));
      };

      // Before the run, so the stream is open while the first model call is
      // still thinking.
      send(heartbeatFrame());

      /*
       * Ticking faster than the budget on purpose.
       *
       * A timer that fires exactly every `heartbeatMs` and sends only after
       * `heartbeatMs` of silence races itself: a frame written a millisecond
       * before the tick pushes the next keepalive a whole period out. Checking
       * four times per period bounds the worst silence at 1.25x the budget
       * instead of 2x, for three extra wakeups a minute.
       */
      const timer = setInterval(
        () => {
          if (Date.now() - lastWriteAt >= heartbeatMs) send(heartbeatFrame());
        },
        Math.max(1, Math.ceil(heartbeatMs / 4)),
      );

      const stopTimer = () => clearInterval(timer);
      options.signal?.addEventListener("abort", stopTimer);

      try {
        await options.run(emit);
      } finally {
        stopTimer();
        options.signal?.removeEventListener("abort", stopTimer);
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a cancel. Nothing to do and nothing to report.
        }
      }
    },
  });
}
