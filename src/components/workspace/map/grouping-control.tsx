"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { GROUPING_WORDS, type Grouping, type GroupingOption } from "./grouping";

/**
 * How someone changes what the map is grouped by.
 *
 * A button and a small panel, because the alternative — five tabs in a row — is
 * five Korean words sitting side by side with no room to say what any of them
 * means, and this user may not know what a 조각 is, let alone which of 종류 and
 * 역할 they want. In the panel each choice gets its sentence, and a grouping we
 * cannot draw gets the reason instead. That reason is the point of the whole
 * control: "58개가 “파일” 하나에 몰려 있어서, 이렇게 묶으면 한 덩어리가 돼요" tells someone
 * something true about their own site, which is more than a greyed-out row ever
 * does.
 *
 * Three things here are decisions rather than markup:
 *
 *   - **It contains no text input.** It sits in the same toolbar as the beam,
 *     and section 5's warning 2 is about that input: opening and closing this
 *     panel must never remount, move or focus it, or a half-typed 한글 syllable
 *     dies. Nothing here touches it; focus goes to this panel and comes back to
 *     this button.
 *   - **An unavailable choice is focusable, not `disabled`.** A `disabled`
 *     button cannot be reached by keyboard, which would put the reason out of
 *     reach of exactly the people who most need it read to them. `aria-disabled`
 *     keeps it reachable and announced, and the click does nothing.
 *   - **The count is on screen before you commit.** "묶으면 6곳이 돼요" is the
 *     honest preview of a choice whose result is a whole new picture.
 */

export type GroupingControlProps = {
  /** Every grouping, already judged against the project. From `groupingOptions`. */
  options: readonly GroupingOption[];
  value: Grouping;
  onChange: (grouping: Grouping) => void;
  /** True while a run is filling the map — there is nothing settled to regroup. */
  disabled?: boolean;
  className?: string;
};

export function GroupingControl({
  options,
  value,
  onChange,
  disabled = false,
  className,
}: GroupingControlProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const current = options.find((option) => option.id === value) ?? null;
  const currentName = current?.name ?? GROUPING_WORDS[value].name;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Escape closes and hands focus back; a pointer anywhere else just closes.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const wrap = wrapRef.current;
      if (wrap && event.target instanceof Node && !wrap.contains(event.target)) {
        close(false);
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);

  // A run starting under an open panel would leave it hanging over a screen
  // that is no longer the one it was opened on. Adjusted during the render that
  // sees the prop change rather than in an effect: an effect would paint the
  // stale panel once first, and React 19 rightly refuses to have setState in
  // one anyway.
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled);
    if (disabled && open) setOpen(false);
  }

  return (
    <div ref={wrapRef} className={`relative shrink-0 ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`묶는 기준: ${currentName}. 바꾸려면 누르세요`}
        className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-[13px] text-said-soft transition-colors hover:border-edge-lit hover:text-said disabled:opacity-55"
      >
        <span className="text-said-faint">묶는 기준</span>
        <span className="text-said">{currentName}</span>
        <span aria-hidden className="text-[10px] text-said-faint">
          ▾
        </span>
      </button>

      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="지도를 묶는 기준"
          className="absolute right-0 top-[calc(100%+6px)] z-20 w-[19rem] max-w-[calc(100vw-2rem)] rounded-xl border border-edge bg-ink-raised p-1.5 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.9)]"
        >
          <p className="px-2 pb-1 pt-1.5 text-[12px] text-said-faint">
            무엇끼리 묶어서 볼까요?
          </p>

          <ul>
            {options.map((option) => {
              const selected = option.id === value;
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-disabled={!option.available}
                    onClick={() => {
                      if (!option.available) return;
                      onChange(option.id);
                      close(true);
                    }}
                    className={`w-full rounded-lg px-2 py-2 text-left transition-colors ${
                      selected ? "bg-edge-lit" : "hover:bg-edge"
                    } ${option.available ? "" : "opacity-60"}`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span
                        className={`text-[13px] ${
                          option.available ? "text-said" : "text-said-soft"
                        }`}
                      >
                        {option.name}
                      </span>
                      {option.available ? (
                        <span className="ml-auto shrink-0 text-[11px] text-said-faint">
                          {selected
                            ? "보고 있어요"
                            : `묶으면 ${option.districtCount.toLocaleString("ko-KR")}곳`}
                        </span>
                      ) : (
                        <span className="ml-auto shrink-0 text-[11px] text-said-faint">
                          지금은 어려워요
                        </span>
                      )}
                    </span>
                    <span
                      className={`mt-0.5 block text-[12px] leading-[1.7] ${
                        option.available ? "text-said-soft" : "text-said-faint"
                      }`}
                    >
                      {option.unavailable ?? option.meaning}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/*
            Said once, here, because the first time anyone touches this control
            they are about to watch the whole picture rearrange, and the thing
            they will worry about is whether they just lost the file they had
            open. They did not.
          */}
          <p className="border-t border-edge px-2 pb-1.5 pt-2 text-[11px] leading-[1.7] text-said-faint">
            기준을 바꿔도 고른 것은 그대로예요. 있던 것이 사라지지도 않아요.
          </p>
        </div>
      ) : null}
    </div>
  );
}
