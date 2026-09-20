"use client";

import { useCallback, useState } from "react";

import {
  adoptedRunId,
  noteIsWrong,
  readStartResponse,
  rereadState,
  startNote,
  type StartOutcome,
} from "./reread";

/**
 * Read this project again, from the band.
 *
 * The button is the small part. The part that matters is the last line of
 * `press`: the run id goes **up**, to the workspace that owns `runId` and
 * therefore owns the reading screen. A button that posted to the endpoint and
 * kept the answer to itself would leave a run genuinely running with nothing on
 * screen saying so — the worst outcome available here, because the person then
 * presses it again, and the only reason a second run does not start is that the
 * server happens to refuse one. Correctness by someone else's accident.
 *
 * It does not have its own way of starting a run. There is one endpoint, it
 * already checks the session and the owner, and a second path would be a second
 * place for those checks to be forgotten.
 *
 * No confirmation, and nothing about it drawn as dangerous. Reading a project
 * again costs time and changes nothing that cannot be drawn again — D20 keeps
 * the previous map standing if the new run fails — so a dialog here would be
 * ceremony around a safe act, which teaches people to click through dialogs.
 */

export type RereadButtonProps = {
  projectId: string;
  /**
   * True when the band is the maximised pane. At rest the band is a strip of
   * roughly 19–31px with most of that spent on its own padding, so the label is
   * read out rather than drawn; maximised, there is room for the word.
   */
  expanded: boolean;
  /** True when a run is already happening, whoever started it. */
  going: boolean;
  /** True when this project has a map already. Changes one word, nothing else. */
  drawn: boolean;
  /**
   * Hand the run up to whoever owns the screen.
   *
   * Required rather than optional, so the compiler is what stops this button
   * from being mounted somewhere that ignores the run it starts.
   */
  onStarted: (runId: string) => void;
};

export function RereadButton({
  projectId,
  expanded,
  going,
  drawn,
  onStarted,
}: RereadButtonProps) {
  const [starting, setStarting] = useState(false);
  /**
   * The last answer, kept whole rather than as a string: the sentence and the
   * colour it is printed in are two readings of the same fact, and keeping one
   * of them in state is how they come apart.
   */
  const [outcome, setOutcome] = useState<StartOutcome | null>(null);

  const state = rereadState({ starting, going, drawn });

  const press = useCallback(async () => {
    setStarting(true);
    setOutcome(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/analyze`, {
        method: "POST",
      });

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A body we cannot read is an `unreadable` outcome below, not a crash.
      }

      const answer = readStartResponse(response.status, body);
      setOutcome(answer);

      // Both a run we started and one that was already going. See the note on
      // `adoptedRunId`: the id is the whole point of the request.
      const runId = adoptedRunId(answer);
      if (runId !== null) onStarted(runId);
    } catch {
      // A throw from `fetch` is the request never arriving — no network, or the
      // page going away under it. `workspace.tsx` draws the same line, and the
      // instruction on this side of it is about the connection, not the project.
      setOutcome({ kind: "offline" });
    } finally {
      setStarting(false);
    }
  }, [projectId, onStarted]);

  const note = outcome ? startNote(outcome) : null;
  /*
   * 이미 읽고 있어요 is a sentence about a run that is going, so it goes when the
   * run does. Derived rather than cleared in an effect: an effect would leave
   * one rendered frame of a sentence that had already stopped being true, which
   * on this screen is the one thing that must not happen.
   */
  const show = note !== null && outcome !== null && (outcome.kind !== "already" || going);
  const wrong = outcome !== null && noteIsWrong(outcome);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => void press()}
        disabled={!state.pressable}
        // The name is carried by the span below, which is the same string in
        // both shapes — read aloud at rest, read and seen when maximised. The
        // hover says it too, since at rest there is nothing else to go on.
        title={state.label}
        className={`flex shrink-0 items-center gap-1.5 rounded-md border border-edge-lit text-said-soft transition-colors hover:text-said disabled:opacity-55 ${
          expanded ? "px-2 py-1 text-[12px]" : "px-1.5 leading-[1.5]"
        }`}
      >
        <RefreshMark turning={state.turning} />
        <span className={expanded ? "" : "sr-only"}>{state.label}</span>
      </button>

      {show ? (
        <p
          role="alert"
          // The whole sentence on the hover, because at rest this strip is one
          // line and a refusal is the one thing here worth reading in full.
          title={note ?? undefined}
          className={`min-w-0 ${wrong ? "text-c4" : "text-said-faint"} ${
            expanded ? "text-[12px] leading-[1.7]" : "truncate leading-[1.5]"
          }`}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One arrow going round: the arc, and the head where it stops.
 *
 * Inline, `currentColor`, `aria-hidden` — the convention `language-mark.tsx`
 * and `provider-mark.tsx` set, and the reason is the same one: an icon that is
 * a file is a request that lands after the row it belongs to, and an icon with
 * its own colour is one more thing to theme. The button already says what it
 * does in words, so the mark is for the people who read the shape faster.
 *
 * It turns only while something is actually happening, and it turns with CSS so
 * that the global `prefers-reduced-motion` rule in `globals.css` flattens it to
 * a still arrow — the same way `phase-checklist.tsx`'s pulse is flattened. A
 * spinner driven from JavaScript would be the one piece of motion on this
 * screen somebody who asked for less of it could not get away from.
 */
function RefreshMark({ turning }: { turning: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      // The arc is centred on (8, 8), which is the centre of the box, so the
      // rotation is about the arrow's own middle and not about a point beside
      // it.
      className={`h-3.5 w-3.5 shrink-0 ${turning ? "animate-spin" : ""}`}
    >
      <path d="M11.9 11.9A5.5 5.5 0 1 1 11.9 4.1L14.2 6.4" />
      <path d="M14.2 2.8V6.4H10.6" />
    </svg>
  );
}
