"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyFrame,
  failSession,
  startSession,
  type AskSession,
} from "@/lib/ask/session";

import { streamInvestigation } from "./investigation-stream";

/**
 * 설명하기's deep read: one place, opened by a model and explained, watched as
 * it happens.
 *
 * The same frames as `/ask`, folded by the same reducer — `session.ts` does not
 * know which route it is reading — so a step, a conclusion, a refused claim and
 * the walk all arrive and render exactly as they do for a question.
 *
 * ## Kept per place and question, for as long as the page is open
 *
 * A deep read costs the person real tokens and real seconds, and somebody who
 * clicks away and back should not pay for the same explanation twice. So a
 * finished read is kept against the item it was about **and the question typed
 * with it**, in memory, and nowhere else (D154): the founder's words were that
 * this does not need a database, and a tab that closes takes it with it. By
 * item alone, a second question about the same place came back with the first
 * question's answer (D167).
 *
 * One read runs at a time. A second one aborts the first, which is then
 * dropped rather than kept half-finished — a half-read explanation shown later
 * as though it were the answer is the thing the loop's stop reasons exist to
 * prevent.
 */

export type ExplainOptions = {
  model?: "mimo" | "gemini" | "custom";
  effort?: "fast" | "deep";
  /** What the person typed alongside, if anything. */
  question?: string;
};

const DROPPED = "읽어 오는 도중에 연결이 끊겼어요. 다시 눌러 주세요.";
const UNREADABLE = "지금은 읽어 오지 못했어요. 잠시 후에 다시 눌러 주세요.";

/** What the card says while the first frame is on its way. */
export const EXPLAIN_STARTED = "코드를 직접 열어서 읽어 볼게요.";

/** Where a read is kept: one place, and what was asked about it. */
export function explainKey(itemId: string, question = ""): string {
  return `${itemId}\u0000${question.trim()}`;
}

export function useExplain(projectId: string) {
  const [sessions, setSessions] = useState<Readonly<Record<string, AskSession>>>({});
  const runningRef = useRef<{ controller: AbortController; key: string } | null>(null);

  useEffect(() => () => runningRef.current?.controller.abort(), []);

  const clear = useCallback(() => {
    runningRef.current?.controller.abort();
    runningRef.current = null;
    setSessions({});
  }, []);

  const explain = useCallback(
    async (itemId: string, options: ExplainOptions = {}) => {
      const asked = options.question?.trim() ?? "";
      const key = explainKey(itemId, asked);
      const previous = runningRef.current;
      if (previous) {
        previous.controller.abort();
        // A read that did not finish is not kept: it would come back on the
        // next visit looking like an answer.
        setSessions((all) => withoutUnfinished(all, previous.key));
      }
      const controller = new AbortController();
      runningRef.current = { controller, key };

      const update = (change: (session: AskSession) => AskSession) => {
        if (runningRef.current?.controller !== controller) return;
        setSessions((all) => {
          const session = all[key];
          return session ? { ...all, [key]: change(session) } : all;
        });
      };

      setSessions((all) => ({
        ...all,
        [key]: startSession(asked.length > 0 ? asked : EXPLAIN_STARTED),
      }));

      try {
        const refusal = await streamInvestigation({
          url: `/api/projects/${projectId}/explain`,
          body: {
            itemId,
            ...(asked.length > 0 ? { question: asked } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
          },
          signal: controller.signal,
          onFrame: (frame) => update((session) => applyFrame(session, frame)),
        });
        if (refusal) {
          update((session) => failSession(session, refusal.refused ?? UNREADABLE));
          return;
        }
        update((session) =>
          session.status === "asking" ? failSession(session, DROPPED) : session,
        );
      } catch {
        if (controller.signal.aborted) return;
        update((session) => failSession(session, DROPPED));
      } finally {
        if (runningRef.current?.controller === controller) runningRef.current = null;
      }
    },
    [projectId],
  );

  return { sessions, explain, clear };
}

function withoutUnfinished(
  all: Readonly<Record<string, AskSession>>,
  key: string,
): Readonly<Record<string, AskSession>> {
  const session = all[key];
  if (!session || session.status !== "asking") return all;
  const next = { ...all };
  delete next[key];
  return next;
}
