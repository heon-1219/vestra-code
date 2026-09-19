"use client";

import { MODE_WORDS, PANEL_MODES, type PanelMode } from "./mode";

/**
 * Which of the three the request box is doing, as one control.
 *
 * ## A row of words, not a dropdown
 *
 * `GroupingControl` on the map is a dropdown, and for five groupings that was
 * right: five Korean words in a row leaves no space to say what any of them
 * means. Three is a different problem, and two things decided it the other way.
 *
 * First, the panel already teaches this exact shape one screen above — 목록 /
 * 그림, a row of words with the current one filled in. Reusing it means nobody
 * has to learn a second idiom for "choose how you are looking at this".
 *
 * Second, and the one with teeth: the chosen mode's sentence is the only place
 * this panel admits that none of the three works yet. A dropdown hides the
 * choice behind a click, and it would hide that sentence behind the same click
 * — the honesty would be one interaction further away than the button that
 * cannot honour it. The row keeps choice, action and admission on screen at
 * once.
 *
 * ## Two details that are decisions
 *
 *   - **It wraps.** The panel column is `minmax(272px, 25%)`, so about 240px of
 *     content at its narrowest, and three Korean words plus their padding do
 *     not reliably fit in that. D72's lesson is that an overflow guard hides
 *     the overflow from us as well as from the user, so the row is allowed to
 *     take a second line instead of being made to fit one.
 *   - **Nothing here is ever `disabled`.** Choosing a mode changes nothing but
 *     what the next click will do, so there is no state of the app in which the
 *     choice is unsafe — not even mid-run. Disabling it would take it off the
 *     keyboard for no gain, which is the trade `GroupingControl` refused for
 *     the same reason.
 *
 * Focus is the global `:focus-visible` amber outline from `globals.css`; there
 * is deliberately no local ring, because a second focus style on one screen is
 * how the first one stops meaning anything.
 */
export function ModeSelect({
  value,
  onChange,
  className,
}: {
  value: PanelMode;
  onChange: (mode: PanelMode) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="이 상자로 무엇을 할지"
      className={`flex flex-wrap items-center gap-1 ${className ?? ""}`}
    >
      {PANEL_MODES.map((mode) => {
        const chosen = mode === value;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            // Toggle buttons rather than a listbox: a listbox owns arrow keys
            // and needs roving tabindex to be correct, and gets announced as a
            // list the user is navigating. Three verbs where exactly one is on
            // is what `aria-pressed` is for, and it is what the tabs above this
            // already do.
            aria-pressed={chosen}
            className={`rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
              chosen ? "bg-ink text-said" : "text-said-faint hover:text-said-soft"
            }`}
          >
            {MODE_WORDS[mode].name}
          </button>
        );
      })}
    </div>
  );
}
