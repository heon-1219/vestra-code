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
 * Everything connected starts locked — everything *around* the selection.
 *
 * The user pointed at one thing. Letting an agent edit its neighbours because
 * nobody said otherwise is exactly the sprawl this product exists to stop, and
 * "stop and explain why" (brief 6.4) is a much better failure than a change
 * nobody asked for. Opening a neighbour is one click and it is the user's
 * choice to make.
 *
 * What is written *inside* the selection is not a neighbour, and `lockFor`
 * opens it. A file's pieces locked by default made every prompt
 * about a file contradict itself — 238 of 238 such files on this repository's
 * own map: 고쳐도 되는 것 said the whole file, 건드리지 말 것 said every line
 * of it.
 */
export const DEFAULT_LOCK: ConnectionLock = "locked";

export type LockMap = Readonly<Record<string, ConnectionLock>>;

/** The lock as the user set it, with no regard to what is selected. */
export function lockOf(locks: LockMap, id: string): ConnectionLock {
  return locks[id] ?? DEFAULT_LOCK;
}

/**
 * Where a row's code sits against the selection's, read off path and lines.
 *
 *   - `same`   — the same lines. A Next.js `page.tsx` is both a file and the
 *                page it serves, and a Streamlit `pages/log.py` both a file and
 *                `/log`; the map holds each twice, and selecting one of the pair
 *                makes the other the very code being changed.
 *   - `inside` — lines within the selection's: a piece written in the selected
 *                file, a method inside the selected class.
 *   - `around` — everything else, including the file a selected piece is
 *                written in, which *holds* the selection rather than sitting in
 *                it.
 *
 * By lines rather than by `contains`, because the question is "would changing
 * the selection change this?", and that is a question about where the code is.
 * A page and its file are joined by `contains` in one direction only, and would
 * have come out as one inside the other.
 */
export type Standing = "same" | "inside" | "around";

export function standingOf(item: GraphItem, selected: GraphItem): Standing {
  if (item.id === selected.id) return "same";
  if (!item.path || item.path !== selected.path) return "around";
  if (selected.startLine === null) return item.startLine === null ? "same" : "inside";
  if (item.startLine === null) return "around";
  const selectedEnd = selected.endLine ?? selected.startLine;
  const itemEnd = item.endLine ?? item.startLine;
  if (item.startLine === selected.startLine && itemEnd === selectedEnd) return "same";
  return selected.startLine <= item.startLine && itemEnd <= selectedEnd ? "inside" : "around";
}

/** The closest standing among several selections: same, then inside, then around. */
export function standingAmong(item: GraphItem, selection: readonly GraphItem[]): Standing {
  let best: Standing = "around";
  for (const selected of selection) {
    const standing = standingOf(item, selected);
    if (standing === "same") return "same";
    if (standing === "inside") best = "inside";
  }
  return best;
}

/**
 * The lock a row is under while `selection` is selected.
 *
 * `same` is always open and cannot be closed — it is the selection. `inside`
 * starts open and can be closed ("this file, but leave that component alone"),
 * which the prompt then words as a carve-out rather than as a contradiction.
 * `around` starts locked, as it always has. What the person set by hand wins
 * over both defaults, and is remembered by id as before.
 */
export function lockFor(
  locks: LockMap,
  item: GraphItem,
  selection: readonly GraphItem[],
): ConnectionLock {
  const standing = standingAmong(item, selection);
  if (standing === "same") return "editable";
  return locks[item.id] ?? (standing === "inside" ? "editable" : DEFAULT_LOCK);
}

/**
 * Whether a row has a lock at all.
 *
 * A feature is a grouping a model made, not code anyone can edit, so a switch
 * on it changed nothing an agent could act on — and the prompt printed its
 * internal id under 건드리지 말 것 for every file that belonged to one (152
 * prompts on this repository's map).
 */
export function hasLock(item: GraphItem): boolean {
  return item.kind !== "feature";
}

/** Said on hover where a row's switch would be, when the row is the selection's own code. */
export const SAME_CODE = "고른 것과 같은 코드라서 따로 잠글 수 없어요.";

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
  standing = "around",
  onLockChange,
  onSelect,
}: {
  neighbour: Neighbour;
  lock: ConnectionLock;
  /** How this row's code stands to the selection's. `same` has no switch. */
  standing?: Standing;
  onLockChange: (id: string, lock: ConnectionLock) => void;
  onSelect: (id: string) => void;
}) {
  const { item, direction, relation, certainty, hops, via, purpose } = neighbour;
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
            What this connection is *for*, when Pass 3 wrote a sentence for it.

            Its own line, under the name, rather than in place of the verb. The
            verb is two words and carries the **direction** — 사용해요 against
            여기서 쓰여요 is the whole difference between the two halves of this
            panel — and a sentence put where it was would be both too long for
            the line and silent about which way the arrow points. So the verb
            stays where it is and this goes underneath, which is also what
            happens when there is no sentence: nothing moves, the row is one
            line shorter, and a project that has never run Pass 3 loses nothing
            it had.

            Marked, because a model wrote it. Same rule `flow-state.tsx` keeps
            and the same two words, imported from here so the product has one
            wording for one idea.
          */}
          {purpose ? (
            <span className="mt-1 flex items-baseline gap-1.5 text-[12px] leading-[1.7] text-said-soft text-pretty">
              <ModelMark />
              <span className="min-w-0">{purpose}</span>
            </span>
          ) : null}

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

      {/*
        No switch where one would change nothing. A feature is our grouping,
        not code; a row that IS the selection's own code (a page and the file
        it is) cannot be locked without locking the thing being changed. The
        second says so in the switch's place, so the row does not look like one
        whose switch failed to render.
      */}
      {!hasLock(item) ? null : standing === "same" ? (
        <span
          title={SAME_CODE}
          className="mt-2 shrink-0 rounded-md border border-lamp-dim/60 px-2 py-1 text-[12px] font-medium text-lamp"
        >
          바꿀 곳
        </span>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={editable}
          aria-label={`${name} 편집 허용`}
          onClick={() => onLockChange(item.id, editable ? "locked" : "editable")}
          // 44 px on a phone, both ways (D174): this switch is 프롬프트 만들기's
          // one input, and at 30 px tall it was the smallest thing on the panel.
          className={`mt-2 flex shrink-0 items-center justify-center rounded-md border px-2 py-1 text-[12px] font-medium transition-colors max-md:mt-1 max-md:min-h-11 max-md:min-w-11 ${
            editable
              ? "border-lamp-dim bg-lamp/10 text-lamp"
              : "border-edge-lit text-said-faint hover:text-said-soft"
          }`}
        >
          {editable ? "편집 허용" : "잠금"}
        </button>
      )}
    </li>
  );
}

/**
 * Two words that say a model wrote the line beside them.
 *
 * `FLOW_TRACKING.md` §5 states the rule and it is not about flows: **an LLM
 * sentence and an arithmetic sentence look alike and must not read alike.** A
 * reader who cannot check either one is entitled to know which of the two they
 * are reading, which is the same line `Description.fromModel` draws and the
 * reason that field exists.
 *
 * The mark goes on the model's sentence rather than on the measured one,
 * because measured is this product's floor: every row has a line the parser
 * counted before any model has ever run, and marking the normal case would say
 * nothing. 모델 is a word this panel has already taught — the request box says
 * 아직 모델이 연결되지 않았어요 — rather than a new one introduced here.
 *
 * Exported with its sentence so the flow panel can use the same two words. One
 * idea, one wording, which is the rule D69 was written for.
 */
export const MODEL_TAG = "모델이 쓴 말";

export const MODEL_WROTE_IT =
  "이 줄은 저희가 코드를 읽고 모델에게 풀어 쓰게 한 말이에요. 표시가 없는 줄은 읽은 것만 가지고 적은 거예요.";

export function ModelMark({ className = "" }: { className?: string }) {
  return (
    <span
      title={MODEL_WROTE_IT}
      className={`shrink-0 rounded-[3px] bg-lamp/10 px-1.5 text-[10px] leading-[1.6] text-lamp ${className}`}
    >
      {MODEL_TAG}
    </span>
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
