"use client";

import { FLOW_SPEEDS, type FlowSpeed, type Player } from "./player";

/**
 * The transport: 처음부터, 이전, 따라가기 / 잠깐 멈춤, 다음, and 1x / 2x.
 *
 * The founder asked for this by name — "1x 2x 이런식으로 play speed 조정
 * 가능하게, replay 가능하게" — so it is a real control with real buttons rather
 * than a line of text that advances on its own.
 *
 * ## What it is not allowed to look like
 *
 * **Not progress.** Nothing is being waited for: the whole path was computed
 * before the first step was drawn, in microseconds, with no model and no
 * network. A bar filling up would say the product was working, and
 * `FLOW_TRACKING.md` §1 forbids implying duration by "a progress-looking
 * element" for the same reason it forbids the word 실시간. So the slider is
 * labelled as **몇 번째 걸음** and the readout beside it counts steps of a total
 * — a position in something finished, which is what a scrubber through a
 * document is.
 *
 * ## Why every word is also a picture
 *
 * The four transport marks are the ones every player anyone has used draws, so
 * they are readable before the label is; the label is the accessible name and
 * the tooltip, because this column is 240px at its narrowest and five Korean
 * verbs in a row do not fit in it. The speeds are written out, because there is
 * no mark for "twice as fast" that anybody reads the same way.
 *
 * ## 44px, and the row wraps rather than shrinking
 *
 * Every control here is 44px on a phone (D129's rule, applied to the newest
 * targets in the product) and 32px above `md`. At 320px the four marks and the
 * two speeds are 276px against about 296px of panel, so they fit — and the row
 * is `flex-wrap` anyway, because D72's lesson is that an overflow guard hides
 * the overflow from us as well as from the user.
 */

export function PlayerControls({
  player,
  hops,
  reduced,
  onPlayPause,
  onStep,
  onReplay,
  onSeek,
  onShowAll,
  onSpeed,
}: {
  player: Player;
  hops: number;
  /** True when this person asked for less motion. Changes what is said, not what is offered. */
  reduced: boolean;
  onPlayPause: () => void;
  onStep: (delta: number) => void;
  onReplay: () => void;
  onSeek: (to: number) => void;
  onShowAll: () => void;
  onSpeed: (speed: FlowSpeed) => void;
}) {
  const atEnd = player.revealed >= hops;

  return (
    <div className="mt-3">
      <div
        role="group"
        aria-label="걸음 따라가기 조작"
        className="flex flex-wrap items-center gap-1"
      >
        <TransportButton label="처음부터" onClick={onReplay} disabled={hops === 0}>
          <MarkReplay />
        </TransportButton>

        <TransportButton
          label="한 걸음 뒤로"
          onClick={() => onStep(-1)}
          disabled={player.revealed <= 0}
        >
          <MarkBack />
        </TransportButton>

        {/*
          The one that changes its word. `aria-pressed` would be wrong here —
          this is not a toggle between two states of one thing, it is two
          different actions sharing a button, which is how every player does it
          and which a name change announces correctly.
        */}
        <TransportButton
          label={player.playing ? "잠깐 멈추기" : atEnd ? "처음부터 다시 보기" : "따라가기"}
          onClick={onPlayPause}
          disabled={hops === 0}
          filled
        >
          {player.playing ? <MarkPause /> : <MarkPlay />}
        </TransportButton>

        <TransportButton
          label="한 걸음 앞으로"
          onClick={() => onStep(1)}
          disabled={player.revealed >= hops}
        >
          <MarkForward />
        </TransportButton>

        <div className="ml-auto flex items-center gap-1">
          {FLOW_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              onClick={() => onSpeed(speed)}
              aria-pressed={player.speed === speed}
              aria-label={speed === 1 ? "보통 빠르기로" : `${speed}배 빠르기로`}
              className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-[12px] font-medium tabular-nums transition-colors max-md:h-11 max-md:min-w-11 ${
                player.speed === speed
                  ? "bg-ink text-said"
                  : "text-said-faint hover:text-said-soft"
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        {/*
          Position, not progress. `max` is the number of steps the path has, so
          the far right is the end of a finished path rather than "done".
        */}
        <input
          type="range"
          min={0}
          max={Math.max(hops, 0)}
          step={1}
          value={Math.min(player.revealed, hops)}
          onChange={(event) => onSeek(Number(event.currentTarget.value))}
          disabled={hops === 0}
          aria-label="몇 번째 걸음까지 볼지"
          aria-valuetext={`${hops === 0 ? 0 : Math.min(player.revealed, hops)}번째 걸음, 전체 ${hops}걸음`}
          className="h-11 min-w-0 flex-1 cursor-pointer accent-lamp disabled:opacity-55 md:h-6"
        />
        <span className="shrink-0 text-[12px] text-said-faint tabular-nums">
          {Math.min(player.revealed, hops)} / {hops}걸음
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onShowAll}
          disabled={hops === 0 || atEnd}
          className="-mx-1.5 inline-flex min-h-11 items-center rounded-md px-1.5 text-[12px] text-said-faint transition-colors hover:text-said-soft disabled:opacity-40 md:min-h-0"
        >
          한 번에 다 보기
        </button>
        {reduced ? (
          /*
            Said rather than silently done. Someone who asked their system for
            less motion and then finds a path already fully written should know
            that is the setting being honoured and not the feature failing to
            do the thing it just described.
          */
          <span className="text-[12px] leading-[1.7] text-said-faint text-pretty">
            움직임을 줄이는 설정이 켜져 있어서, 걸음을 한 번에 다 펼쳐 뒀어요.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TransportButton({
  label,
  onClick,
  disabled,
  filled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  filled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      /*
        `active:scale-95` and colour only, which is the rule `globals.css` sets
        for everything that moves in this product — and the global reduced
        motion block flattens the duration, so the two states arrive without
        the travel between them for anyone who asked for that.
      */
      className={`inline-grid h-8 w-8 origin-center place-items-center rounded-lg transition duration-150 active:scale-95 max-md:h-11 max-md:w-11 ${
        filled
          ? "bg-paper text-ink hover:bg-lamp disabled:bg-edge-lit disabled:text-said-faint"
          : "border border-edge-lit text-said-soft hover:border-said-faint hover:bg-ink hover:text-said disabled:opacity-40"
      }`}
    >
      {children}
    </button>
  );
}

/*
 * The four marks.
 *
 * Inline, `currentColor`, `aria-hidden` — the convention `SendMark`,
 * `language-mark.tsx` and `reread-button.tsx` set. None of them is ever the
 * only thing saying what a button does: the verb is on `aria-label` and on the
 * tooltip.
 */

function MarkPlay() {
  return (
    <Mark>
      <path d="M4.5 2.6 12.4 8 4.5 13.4z" fill="currentColor" stroke="none" />
    </Mark>
  );
}

function MarkPause() {
  return (
    <Mark>
      <path d="M5.2 3v10M10.8 3v10" />
    </Mark>
  );
}

function MarkBack() {
  return (
    <Mark>
      <path d="M10.5 3.4 5.6 8l4.9 4.6" />
    </Mark>
  );
}

function MarkForward() {
  return (
    <Mark>
      <path d="M5.5 3.4 10.4 8l-4.9 4.6" />
    </Mark>
  );
}

function MarkReplay() {
  return (
    <Mark>
      <path d="M11.5 3.4 6.6 8l4.9 4.6" />
      <path d="M4.2 3v10" />
    </Mark>
  );
}

function Mark({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
    >
      {children}
    </svg>
  );
}
