"use client";

import {
  CERTAINTY_WORDS,
  KIND_WORDS,
  RELATION_WORDS,
  type Certainty,
  type GraphItem,
} from "@/lib/graph/view";

import type { Neighbour } from "./neighbourhood";

/**
 * One line of the connections list.
 *
 * The line is the product's honesty guarantee in its smallest form, so it
 * carries the same fact three ways: a texture on the left, the relation as a
 * verb, and the word 확실해요 or 짐작이에요 spelled out. Redundant on purpose —
 * a texture survives a projector and a screenshot, a word survives a texture
 * being missed, and neither of them is a 1px dashed line that disappears at
 * the size a real repo is read at.
 *
 * The wording itself is never invented here. Every verb comes from
 * RELATION_WORDS and every certainty word from CERTAINTY_WORDS, so a new kind
 * of connection cannot reach the screen without someone writing its sentence.
 */

/** Whether the coding agent may touch this item. Step 4 snapshots it (D23). */
export type ConnectionLock = "editable" | "locked";

/**
 * Everything connected starts locked.
 *
 * The user pointed at one thing. Letting an agent edit its neighbours because
 * nobody said otherwise is exactly the sprawl this product exists to stop, and
 * "stop and explain why" (brief 6.4) is a much better failure than a change
 * nobody asked for. Opening a neighbour is one click and it is the user's
 * choice to make.
 */
export const DEFAULT_LOCK: ConnectionLock = "locked";

export type LockMap = Readonly<Record<string, ConnectionLock>>;

export function lockOf(locks: LockMap, id: string): ConnectionLock {
  return locks[id] ?? DEFAULT_LOCK;
}

/**
 * How far away, in words rather than in a count.
 *
 * The number is what the user sets; this is what it MEANS, and both are on
 * screen at once. "2" tells someone who does not think in hops nothing at all.
 */
const DISTANCE_WORDS: Record<number, string> = {
  1: "바로 옆",
  2: "한 다리 건너",
  3: "두 다리 건너",
};

export function distanceWord(hops: number): string {
  const known = DISTANCE_WORDS[hops];
  if (known) return known;
  // Past the named few it stays regular: n steps away is (n-1) 다리 건너.
  return hops > 1 ? `${hops - 1}다리 건너` : DISTANCE_WORDS[1];
}

/** The name a person reads: the plain one if Pass 2 has written it yet. */
export function displayName(item: GraphItem): string {
  return item.label ?? item.name;
}

export function ConnectionRow({
  neighbour,
  lock,
  onLockChange,
  onSelect,
}: {
  neighbour: Neighbour;
  lock: ConnectionLock;
  onLockChange: (id: string, lock: ConnectionLock) => void;
  onSelect: (id: string) => void;
}) {
  const { item, direction, relation, certainty, hops, via } = neighbour;
  const verb = RELATION_WORDS[relation][direction === "uses" ? "forward" : "backward"];
  const editable = lock === "editable";
  const name = displayName(item);

  return (
    /*
      The row has a hover surface now. It was a `group` whose only hover effect
      was the name turning amber — a target two lines tall with nothing under
      the pointer to say it was a target, sitting next to a file list where
      every row lights. `bg-ink` at 60% rather than flat: this row carries a
      switch on its right that has its own hover, and a fully opaque wash would
      make the two read as one pressed object.
    */
    <li className="group flex items-start gap-2 border-b-[0.8px] border-edge transition-colors last:border-b-0 hover:bg-ink/60">
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        className="flex min-w-0 flex-1 items-start gap-2.5 py-2.5 pr-1 text-left"
      >
        <CertaintyMark certainty={certainty} className="mt-[7px] h-[15px] w-[3px] shrink-0" />

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="truncate text-[14px] font-medium text-said group-hover:text-lamp">
              {item.label ? name : <code className="text-[13px]">{name}</code>}
            </span>
            <span className="text-[13px] text-said-soft">{verb}</span>
          </span>

          {/*
            The certainty word is lifted out of the dot-joined run.

            It used to be the fourth item in `파일 · 한 다리 건너 · … · 확실해요`,
            set in the same size and the same grey as everything beside it — so
            the one claim on this row that the whole product rests on was
            rendered as another attribute of the row, and the eye had nothing to
            stop on. It now sits on its own at the end of the line, one step
            brighter than the incidental facts in front of it.

            **Both values get the identical treatment**, and that is the point.
            Making 짐작이에요 quieter than 확실해요 would teach the eye to read the
            guess as "less" rather than as "different" — the same mistake
            `Swatch` in `analysis-screen.tsx` refuses when it keeps both
            swatches one colour and lets only the texture carry the difference.
            The difference is carried by `CertaintyMark` on the left, which is a
            texture and survives being small, dim or projected; here it is
            carried by the word itself, which is the other half of the same
            redundancy.
          */}
          <span className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[12px]">
            <span className="min-w-0 truncate text-said-faint">
              {[
                KIND_WORDS[item.kind],
                hops > 1 ? distanceWord(hops) : null,
                via ? `${displayName(via)} 거쳐서` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span className="shrink-0 text-said-soft">{CERTAINTY_WORDS[certainty]}</span>
          </span>
        </span>
      </button>

      <button
        type="button"
        role="switch"
        aria-checked={editable}
        aria-label={`${name} 편집 허용`}
        onClick={() => onLockChange(item.id, editable ? "locked" : "editable")}
        className={`mt-2 shrink-0 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors ${
          editable
            ? "border-lamp-dim bg-lamp/10 text-lamp"
            : "border-edge-lit text-said-faint hover:text-said-soft"
        }`}
      >
        {editable ? "편집 허용" : "잠금"}
      </button>
    </li>
  );
}

/**
 * The texture that says how sure we are.
 *
 * A hatch rather than a dash, per the UI direction: at the zoom where a real
 * repo fits on screen a 1px dashed stroke and a 1px solid stroke are the same
 * stroke, so the distinction the whole product rests on would quietly stop
 * existing exactly where it matters. A band with a texture in it does not.
 */
export function CertaintyMark({
  certainty,
  className = "h-[3px] w-4",
}: {
  certainty: Certainty;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block rounded-[1px] ${className}`}
      style={
        certainty === "certain"
          ? { backgroundColor: "var(--color-wire)" }
          : {
              // 45 degrees, 3px pitch: still legible at a quarter of this size,
              // which a dash is not.
              backgroundImage:
                "repeating-linear-gradient(45deg, var(--color-guess) 0 1.5px, transparent 1.5px 3px)",
            }
      }
    />
  );
}

/** The two textures with their words, wherever the panel needs to explain them. */
export function CertaintyLegend({ className = "" }: { className?: string }) {
  return (
    <p className={`flex items-center gap-4 text-[12px] text-said-faint ${className}`}>
      <span className="flex items-center gap-1.5">
        <CertaintyMark certainty="certain" />
        {CERTAINTY_WORDS.certain}
      </span>
      <span className="flex items-center gap-1.5">
        <CertaintyMark certainty="inferred" />
        {CERTAINTY_WORDS.inferred}
      </span>
    </p>
  );
}
