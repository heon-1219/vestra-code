"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { GraphItem } from "@/lib/graph/view";
// Type only: a runtime import of `config.ts` reaches `env.ts`, which throws in a
// browser bundle. See the note at the top of `panel/model.ts`.
import type { ProviderId } from "@/lib/llm/config";
import {
  buildPrompt,
  canPromptAbout,
  scopeQuestion,
  type BuiltPrompt,
  type PromptGraph,
  type SharedScope,
} from "@/lib/prompt/build";
import { GOAL_NOTES } from "@/lib/prompt/goal";
import type { LockMap } from "@/components/workspace/panel/connection-row";

/**
 * 프롬프트 만들기, as a sequence the panel can show.
 *
 * Three states, in the order §6.4's flowchart draws them:
 *
 *   1. **choosing** — the selection is used in several places, so before a
 *      word is generated the person is asked "only here, or everywhere?". The
 *      request they typed is held here, not in the box: the box is uncontrolled
 *      and must stay that way (UI_DIRECTION §5), so it is never written back to.
 *   2. **writing** — one short model call restates their goal. The only
 *      network in this feature, and optional: with no model connected this
 *      state is skipped in the same frame.
 *   3. **ready** — the prompt, built by `buildPrompt` from the graph on screen
 *      and the locks **as they were at the moment of generation** (D23).
 *
 * There is no failed state, on purpose. Every part of the prompt but the Goal
 * line is built here, so a model that did not answer — not connected, refused,
 * timed out, wrote something unusable — costs only the restatement: the
 * prompt is built with the person's own words as its goal, and the card says
 * which of the two they are reading.
 *
 * Nothing is stored (D154). The prompt lives here until the next one, and in
 * the person's clipboard after they copy it.
 */

export type PromptPhase =
  | {
      status: "choosing";
      selectionId: string;
      request: string;
      places: GraphItem[];
    }
  | { status: "writing"; selectionId: string; request: string }
  | {
      status: "ready";
      selectionId: string;
      built: BuiltPrompt;
      /** The model's restatement, when there is one. */
      goal: string | null;
      /** Why the goal is the person's own words, when it is. */
      note: string | null;
    };

export type MakePromptInput = {
  graph: PromptGraph;
  selectionId: string;
  request: string;
  hops: number;
  locks: LockMap;
  /** Null when nothing is connected here, which skips the one network call. */
  model: ProviderId | null;
};

type Pending = Omit<MakePromptInput, "locks">;

export function usePromptMaker(projectId: string) {
  const [phase, setPhase] = useState<PromptPhase | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const runningRef = useRef<AbortController | null>(null);

  useEffect(() => () => runningRef.current?.abort(), []);

  const clear = useCallback(() => {
    runningRef.current?.abort();
    runningRef.current = null;
    pendingRef.current = null;
    setPhase(null);
  }, []);

  const generate = useCallback(
    async (pending: Pending, locks: LockMap, scope: SharedScope | null) => {
      runningRef.current?.abort();
      const controller = new AbortController();
      runningRef.current = controller;
      const current = () => runningRef.current === controller;

      setPhase({ status: "writing", selectionId: pending.selectionId, request: pending.request });

      let goal: string | null = null;
      let note: string | null = null;
      if (pending.model === null) {
        note = GOAL_NOTES.no_model;
      } else {
        try {
          const response = await fetch(`/api/projects/${projectId}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              request: pending.request,
              selectionIds: [pending.selectionId],
              model: pending.model,
            }),
            signal: controller.signal,
          });
          const body: unknown = await response.json().catch(() => null);
          const record =
            typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
          if (response.ok && typeof record.goal === "string" && record.goal.trim()) {
            goal = record.goal.trim();
          } else if (response.ok && typeof record.note === "string") {
            note = record.note;
          } else {
            // A refusal from the route is still not a reason to withhold the
            // prompt — every part of it but the Goal line is built right here.
            note = response.status === 409 ? GOAL_NOTES.no_model : GOAL_NOTES.failed;
          }
        } catch {
          if (controller.signal.aborted) return;
          note = GOAL_NOTES.failed;
        }
      }
      if (!current()) return;

      /*
       * Built after the goal arrives but from the locks handed in at the
       * moment of generation, not whatever the switches say by now. A person
       * who flips a switch while the goal is being written has changed the
       * next prompt, not this one — which is what a snapshot means.
       */
      const built = buildPrompt({
        graph: pending.graph,
        selectionIds: [pending.selectionId],
        hops: pending.hops,
        locks,
        request: pending.request,
        goal: goal ? { text: goal, fromModel: true } : null,
        scope,
      });
      runningRef.current = null;
      setPhase({ status: "ready", selectionId: pending.selectionId, built, goal, note });
    },
    [projectId],
  );

  const make = useCallback(
    (input: MakePromptInput) => {
      const request = input.request.trim();
      if (request.length === 0) return;
      // A feature or a package is not a place to change. The panel's button is
      // already off for one, with the sentence saying why; this is the same
      // rule for any other caller.
      const target = input.graph.items.find((item) => item.id === input.selectionId);
      if (!target || !canPromptAbout(target)) return;
      const pending: Pending = {
        graph: input.graph,
        selectionId: input.selectionId,
        request,
        hops: input.hops,
        model: input.model,
      };
      pendingRef.current = pending;

      // §6.4: ask "only here or everywhere?" BEFORE generating.
      const question = scopeQuestion(input.graph, [input.selectionId]);
      if (question) {
        runningRef.current?.abort();
        runningRef.current = null;
        setPhase({
          status: "choosing",
          selectionId: input.selectionId,
          request,
          places: question.places,
        });
        return;
      }
      void generate(pending, input.locks, null);
    },
    [generate],
  );

  /** The person's answer to the scope question, and the locks at that moment. */
  const choose = useCallback(
    (scope: SharedScope, locks: LockMap) => {
      const pending = pendingRef.current;
      if (!pending) return;
      void generate(pending, locks, scope);
    },
    [generate],
  );

  return { phase, make, choose, clear };
}
