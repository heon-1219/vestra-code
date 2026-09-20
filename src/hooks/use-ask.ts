"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createFrameReader } from "@/lib/ask/frames";
import {
  applyFrame,
  failSession,
  startSession,
  type AskSession,
} from "@/lib/ask/session";

/**
 * Asking one question and watching it be answered.
 *
 * The analysis stream next door uses the browser's own `EventSource`, which is
 * the right tool for a GET you want reconnected for you. This cannot: a
 * question carries a body — the text, the chosen model, the effort — so it is a
 * POST, and a POST means reading the response stream by hand.
 *
 * Everything hard about that lives in two tested modules and not here.
 * `frames.ts` does the framing, `session.ts` does the fold. What is left is the
 * part that genuinely needs React: one request at a time, cancelled when the
 * person asks something else or leaves the page.
 *
 * ## One question at a time, on purpose
 *
 * A new question aborts the one before it rather than queueing. An
 * investigation costs the person tokens and takes real seconds, and two running
 * at once would put two sets of steps on one screen with the map lit by
 * whichever finished last. If someone wants both answers they can ask twice.
 */

export type AskOptions = {
  model?: "mimo" | "gemini" | "custom";
  effort?: "fast" | "deep";
};

const DROPPED = "답을 받아오는 도중에 연결이 끊겼어요. 다시 물어봐 주세요.";
const UNREADABLE = "답을 받아오지 못했어요. 잠시 후에 다시 물어봐 주세요.";

export function useAsk(projectId: string) {
  const [session, setSession] = useState<AskSession | null>(null);
  const runningRef = useRef<AbortController | null>(null);

  // Unconditional. A stream left open after unmount holds a connection and goes
  // on calling `setState` on a component that is gone.
  useEffect(() => () => runningRef.current?.abort(), []);

  const clear = useCallback(() => {
    runningRef.current?.abort();
    runningRef.current = null;
    setSession(null);
  }, []);

  const ask = useCallback(
    async (question: string, options: AskOptions = {}) => {
      const asked = question.trim();
      if (asked.length === 0) return;

      runningRef.current?.abort();
      const controller = new AbortController();
      runningRef.current = controller;

      /*
       * Every write below goes through this.
       *
       * An aborted request does not stop the `await` it is sitting in from
       * resolving, so a slow previous stream can deliver a chunk after a new
       * question has already replaced the state. Checking the controller is
       * what keeps the old investigation's steps from appearing under the new
       * question — which would not look like a bug, it would look like the loop
       * doing something incomprehensible.
       */
      const update = (change: (previous: AskSession) => AskSession) => {
        if (runningRef.current !== controller) return;
        setSession((previous) => (previous ? change(previous) : previous));
      };

      setSession(startSession(asked));

      try {
        const response = await fetch(`/api/projects/${projectId}/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: asked, ...options }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // The route refuses in plain language — no model, no map, no such
          // project — and that sentence is the whole point of the refusal.
          // A generic message here would throw away the one thing that tells
          // the person what to do next.
          const said = await response
            .json()
            .then((body: unknown) =>
              typeof body === "object" && body !== null && "message" in body
                ? String((body as { message: unknown }).message)
                : null,
            )
            .catch(() => null);
          update((previous) => failSession(previous, said ?? UNREADABLE));
          return;
        }

        const reader = response.body.getReader();
        /*
         * `stream: true` is not optional here.
         *
         * A Korean character is three bytes and a chunk boundary lands in the
         * middle of one regularly. Decoding each chunk independently turns that
         * into a replacement character in the middle of a sentence the person
         * is reading — the kind of fault that only shows up over a real
         * connection, and only sometimes.
         */
        const decoder = new TextDecoder("utf-8");
        const frames = createFrameReader();

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of frames.push(decoder.decode(value, { stream: true }))) {
            update((previous) => applyFrame(previous, frame));
          }
        }

        for (const frame of frames.flush()) {
          update((previous) => applyFrame(previous, frame));
        }

        // Ended without an answer. Not an error anyone caused, and not
        // something to leave spinning either.
        update((previous) =>
          previous.status === "asking" ? failSession(previous, DROPPED) : previous,
        );
      } catch {
        // An abort is somebody asking something else or leaving. Nothing to
        // report: the state it would report into has already been replaced.
        if (controller.signal.aborted) return;
        update((previous) => failSession(previous, DROPPED));
      } finally {
        if (runningRef.current === controller) runningRef.current = null;
      }
    },
    [projectId],
  );

  return {
    session,
    ask,
    clear,
    asking: session?.status === "asking",
  };
}
