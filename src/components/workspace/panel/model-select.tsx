"use client";

// Type only: a runtime import of `config.ts` would pull `env.ts` into the
// browser bundle, and `env.ts` throws unless all eleven server variables are
// present. See the note at the top of `model.ts`.
import type { ProviderId } from "@/lib/llm/config";

import {
  chooseModel,
  effortHonoured,
  EFFORT_WORDS,
  hasModelChoice,
  NO_EFFORT_WORDS,
  NO_MODEL_WORDS,
  PANEL_EFFORTS,
  type ModelChoice,
  type PanelEffort,
} from "./model";

/**
 * Which model answers and how hard it thinks, as one row inside the box.
 *
 * ## Why it is in the composer and not in settings
 *
 * The founder asked for exactly this — "이 고르는 섹션은 채팅창 일부로 claude 가
 * 하듯이 넣어보자" — and the reason it is the right shape is that both of these
 * choices belong to the request, not to the project. A settings page would make
 * them stick to the account, and the next question would be answered by
 * whatever the last one was, with nothing on screen saying so.
 *
 * It sits **below** the box while the mode selector sits above it, and that is
 * the same rule read twice: the mode changes what there is to type, so it comes
 * before typing; the model changes who answers, which is only decided when
 * something is sent. It lands beside the button that sends it, which is where
 * Claude's own box puts it.
 *
 * ## The three things it will not do
 *
 *   - **It never lists a model we have no key for.** With nothing connected
 *     there is no control at all, only `NO_MODEL_WORDS` — an empty dropdown is
 *     a promise of a choice, and a disabled one is a promise it is coming.
 *   - **It does not turn one model into a question.** A single option is shown
 *     as a fact, because a control with one answer reads as a decision the
 *     person has to make.
 *   - **It withdraws 빠르게/깊게 where the endpoint has no such control**, and
 *     says why instead. That parameter is dropped on the wire for a `"none"`
 *     provider, so the two settings would send identical requests.
 *
 * Nothing here is ever `disabled`, for `ModeSelect`'s reason: choosing changes
 * only what the next send will do, so there is no state in which the choice is
 * unsafe — not even mid-run — and a disabled button is off the keyboard.
 * Focus is the global `:focus-visible` amber outline from `globals.css`.
 */
export function ModelSelect({
  models,
  model,
  onModelChange,
  effort,
  onEffortChange,
  className,
}: {
  models: readonly ModelChoice[];
  /** What was picked, which may no longer be connected. */
  model: ProviderId | null;
  onModelChange: (model: ProviderId) => void;
  effort: PanelEffort;
  onEffortChange: (effort: PanelEffort) => void;
  className?: string;
}) {
  const chosen = chooseModel(models, model);

  return (
    <div
      // Wrapping rather than shrinking: the panel column is minmax(272px, 25%),
      // so two names and two words do not reliably fit one line, and D72's
      // lesson is that an overflow guard hides the overflow from us too.
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] ${className ?? ""}`}
    >
      {chosen === null ? (
        <p className="text-said-faint">{NO_MODEL_WORDS}</p>
      ) : (
        <>
          {hasModelChoice(models) ? (
            <div role="group" aria-label="어떤 모델로 할지" className="flex flex-wrap items-center gap-1">
              {models.map((option) => {
                const on = option.id === chosen.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onModelChange(option.id)}
                    // Toggle buttons, like the mode row above: exactly one of a
                    // short list is on, which is what aria-pressed says without
                    // a listbox's roving tabindex and arrow-key contract.
                    aria-pressed={on}
                    className={pill(on)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-said-faint">
              모델 <span className="text-said-soft">{chosen.label}</span>
            </p>
          )}

          {effortHonoured(chosen) ? (
            <div role="group" aria-label="빠르게 할지 깊게 할지" className="flex flex-wrap items-center gap-1">
              {PANEL_EFFORTS.map((option) => {
                const on = option === effort;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onEffortChange(option)}
                    aria-pressed={on}
                    className={pill(on)}
                  >
                    {EFFORT_WORDS[option]}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-said-faint">{NO_EFFORT_WORDS}</p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The same pill in both groups, one size down from the mode row.
 *
 * Smaller because it is the secondary choice on that row: the mode decides what
 * the button does, and this decides who does it. Same two colours though — a
 * second way of showing "this one is on" in one footer is how the first one
 * stops being read.
 */
function pill(on: boolean): string {
  return `inline-flex items-center rounded-md px-2 py-1 font-medium transition-colors max-md:min-h-11 max-md:px-3 ${
    on ? "bg-ink text-said" : "text-said-faint hover:text-said-soft"
  }`;
}
