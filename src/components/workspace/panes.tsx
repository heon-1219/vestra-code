"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * The workspace's panes: how wide each one is, and which one has the screen.
 *
 * Three columns and a band along the bottom. The proportions used to be fixed
 * — `15% / 1fr / 25%` — which is a guess about what someone is doing, made once
 * by us. Reading a long file wants the left panel wide; following connections
 * wants the right one wide; neither is a default, they are two different
 * minutes of the same session.
 *
 * Two things are therefore adjustable and one is not. The dividers move and the
 * sizes persist. What does NOT happen is unmounting: a pane at zero width is
 * still mounted, still holds its scroll position and its half-typed search, and
 * the 한글 being composed in the beam survives the screen being rearranged
 * around it. That constraint is why this module hands out numbers rather than
 * rendering the panes itself — the shell keeps one JSX tree for every layout,
 * so React never sees a pane move to a different parent.
 *
 * Sizes are fractions, not pixels. A layout saved on a 27-inch monitor and
 * restored on a laptop has to be the same layout, and pixels are the one unit
 * that cannot survive that.
 */

export type PaneId = "places" | "map" | "panel" | "history";

/** The word for each pane, for the control and for screen readers. */
export const PANE_LABELS: Record<PaneId, string> = {
  places: "파일",
  map: "지도",
  panel: "연결",
  history: "변경 기록",
};

export type PaneLayout = {
  /** Column widths as fractions of the row. Always three, always sum to 1. */
  columns: [number, number, number];
  /** The bottom band, as a fraction of the workspace height. */
  history: number;
  /** The pane currently filling the workspace, or null for all of them. */
  maximized: PaneId | null;
};

/**
 * The proportions the product opens with — the ones that were hard-coded, kept
 * as the starting point so nothing moves for someone who never touches a
 * divider, and as the answer to a double-click on one.
 */
export const DEFAULT_LAYOUT: PaneLayout = {
  columns: [0.17, 0.58, 0.25],
  history: 0.045,
  maximized: null,
};

/**
 * Smallest useful width for each column, in pixels.
 *
 * Fractions cannot express these: 15% of a 2560px monitor is a comfortable file
 * list and 15% of a 1024px laptop is a column of truncated filenames. The
 * minimum a pane needs is a property of its contents, so it is measured in the
 * unit its contents are drawn in, and converted to a fraction against the
 * container at the moment of the drag.
 */
const MIN_PX: Record<"places" | "map" | "panel", number> = {
  places: 170,
  map: 260,
  panel: 280,
};

/** The band is a strip, not a pane, until someone drags it open. */
const MIN_HISTORY_PX = 34;
const MAX_HISTORY_FRACTION = 0.6;

const STORAGE_KEY = "vestra:panes:v1";

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Whatever was stored, turned into something safe to render.
 *
 * localStorage is user-writable and survives deploys, so this has to treat what
 * it finds as a stranger's input rather than as something we wrote: a layout
 * from a future version, a hand-edited one, a truncated one. Anything that does
 * not parse into three finite positive fractions is discarded silently in
 * favour of the default — a broken layout is not worth an error message, but it
 * is absolutely worth not rendering.
 */
function readStored(): PaneLayout | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;

    const columns = (parsed as { columns?: unknown }).columns;
    if (!Array.isArray(columns) || columns.length !== 3) return null;
    if (!columns.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)) {
      return null;
    }
    const total = columns[0] + columns[1] + columns[2];
    if (total <= 0) return null;

    const history = (parsed as { history?: unknown }).history;
    return {
      // Normalised rather than trusted: three numbers that happen not to sum to
      // 1 would render as a layout nobody chose.
      columns: [columns[0] / total, columns[1] / total, columns[2] / total],
      history:
        typeof history === "number" && Number.isFinite(history)
          ? clamp(history, 0, MAX_HISTORY_FRACTION)
          : DEFAULT_LAYOUT.history,
      // Deliberately not restored. Coming back to a workspace where one pane
      // fills the screen and the others are simply gone reads as the app having
      // lost them; maximising is a thing you do for a minute, not a preference.
      maximized: null,
    };
  } catch {
    return null;
  }
}

/*
 * The layout lives in a module-level store rather than in component state.
 *
 * It has to survive server rendering, and the two obvious shapes both break:
 * reading localStorage during render gives the server one answer and the
 * browser another, which React resolves by discarding the markup — on this page
 * that means the map's container is built twice and the canvas measures the
 * wrong one. Reading it in an effect and calling setState is the other shape,
 * and React 19 rejects it outright (`set-state-in-effect`), for the good reason
 * that it renders once with the wrong layout and then again with the right one.
 *
 * `useSyncExternalStore` is what the pattern is for: the server and the first
 * client render both use the default, the store hydrates itself the moment
 * React subscribes, and React re-reads and re-renders once, before paint.
 */
let currentLayout: PaneLayout = DEFAULT_LAYOUT;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function write(next: PaneLayout) {
  currentLayout = next;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columns: next.columns, history: next.history }),
    );
  } catch {
    // Private mode, a full quota, or storage switched off. The layout still
    // works for this session; only remembering it fails, and that is not worth
    // interrupting anyone over.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  // First subscription is the earliest moment there is certainly a browser.
  if (!hydrated) {
    hydrated = true;
    const stored = readStored();
    if (stored) currentLayout = stored;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Both snapshots return a stable reference until something actually changes.
 * Returning a fresh object here is the documented way to make React loop.
 */
const getSnapshot = () => currentLayout;
const getServerSnapshot = () => DEFAULT_LAYOUT;

export function usePaneLayout() {
  const layout = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setColumns = useCallback((columns: [number, number, number]) => {
    write({ ...currentLayout, columns });
  }, []);

  const setHistory = useCallback((history: number) => {
    write({
      ...currentLayout,
      history: clamp(history, 0, MAX_HISTORY_FRACTION),
    });
  }, []);

  /** Pressing the pane that is already filling the screen puts it back. */
  const toggleMaximized = useCallback((pane: PaneId) => {
    // Not persisted, and deliberately: coming back to a workspace where one
    // pane fills the screen and the others are simply gone reads as the app
    // having lost them. Maximising is something you do for a minute.
    currentLayout = {
      ...currentLayout,
      maximized: currentLayout.maximized === pane ? null : pane,
    };
    emit();
  }, []);

  const reset = useCallback(() => {
    write({ ...DEFAULT_LAYOUT, maximized: currentLayout.maximized });
  }, []);

  return { layout, setColumns, setHistory, toggleMaximized, reset };
}

/**
 * How wide each column should actually be right now.
 *
 * Returns a grid template rather than three numbers because the dividers are
 * grid items too — a divider drawn as a border cannot be grabbed, and one
 * drawn as an absolutely positioned overlay does not move when the thing it
 * divides does.
 *
 * A maximised pane takes the row and the others go to zero. Zero, not unmounted:
 * they keep their state and their scroll, and the map re-measures itself from
 * its container the moment it has width again.
 */
export function columnTemplate(layout: PaneLayout): string {
  const { columns, maximized } = layout;
  if (maximized && maximized !== "history") {
    const index = maximized === "places" ? 0 : maximized === "map" ? 1 : 2;
    return [0, 1, 2]
      .map((i) => (i === index ? "minmax(0, 1fr)" : "0px"))
      .join(" 0px ");
  }
  if (maximized === "history") {
    // Nothing above the band, so the columns collapse together rather than one
    // of them being arbitrarily chosen to survive.
    return "0px 0px 0px 0px 0px";
  }
  return `minmax(0, ${columns[0]}fr) 5px minmax(0, ${columns[1]}fr) 5px minmax(0, ${columns[2]}fr)`;
}

/**
 * A divider you can drag, tab to, and reset.
 *
 * `role="separator"` with a `tabIndex` is the ARIA window-splitter pattern, and
 * the keyboard half is not optional: a divider that only responds to a pointer
 * makes the layout unreachable for anyone who cannot use one, and this is the
 * control that decides how much of the screen each part of the product gets.
 *
 * Pointer capture, not a window listener. Dragging fast enough to leave the
 * 5px divider is the normal case, not the edge case, and capture is what keeps
 * the moves coming to the element that started the drag — including when the
 * pointer crosses the canvas, which has its own handlers.
 */
export function Divider({
  orientation,
  label,
  valueNow,
  onDelta,
  onReset,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  /** Percent of the container taken by the pane before the divider, for AT. */
  valueNow: number;
  /**
   * Movement in pixels along the divider's axis, and the size of the box being
   * divided — measured here rather than by the caller.
   *
   * A divider is always a child of the thing it divides, so its own parent is
   * the container, and an event handler is the only correct moment to measure
   * one: reading a ref from a function built during render is what React 19's
   * `react-hooks/refs` rule forbids, and it is right to, because the element
   * that ref points at may not be the one on screen by the time it is read.
   */
  onDelta: (pixels: number, containerPx: number) => void;
  onReset: () => void;
}) {
  const vertical = orientation === "vertical";
  const last = useRef(0);

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(valueNow)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={(event) => {
        // Only the primary button, and never a touch that is actually a scroll
        // gesture starting on the divider.
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        last.current = vertical ? event.clientX : event.clientY;
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const position = vertical ? event.clientX : event.clientY;
        const delta = position - last.current;
        if (delta === 0) return;
        last.current = position;
        onDelta(delta, containerOf(event.currentTarget, vertical));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onKeyDown={(event) => {
        // 16px a press, 64 with shift. Big enough to get somewhere, small
        // enough to land on something.
        const step = event.shiftKey ? 64 : 16;
        const back = vertical ? "ArrowLeft" : "ArrowUp";
        const forward = vertical ? "ArrowRight" : "ArrowDown";
        if (event.key === back) {
          event.preventDefault();
          onDelta(-step, containerOf(event.currentTarget, vertical));
        } else if (event.key === forward) {
          event.preventDefault();
          onDelta(step, containerOf(event.currentTarget, vertical));
        } else if (event.key === "Home" || event.key === "Enter") {
          event.preventDefault();
          onReset();
        }
      }}
      onDoubleClick={onReset}
      className={`group relative shrink-0 bg-edge transition-colors hover:bg-edge-lit focus-visible:bg-lamp-dim focus-visible:outline-none ${
        vertical ? "cursor-col-resize" : "cursor-row-resize"
      }`}
    >
      {/*
        The grab area is larger than the line.
        A 5px target is a target people miss; extending it invisibly past the
        divider on both sides costs nothing and roughly triples the hit area.
        `pointer-events: none` is NOT set on it — that is the point — but it is
        `absolute` so it never affects the grid track's size.
      */}
      <span
        aria-hidden="true"
        className={`absolute ${vertical ? "-inset-x-[5px] inset-y-0" : "-inset-y-[5px] inset-x-0"}`}
      />
    </div>
  );
}

/**
 * The size of the box a divider sits in, along the axis it moves on.
 *
 * Zero if there is no parent, which `resizeColumns` treats as "not measured
 * yet" and answers by changing nothing — a drag that begins before layout must
 * not divide by zero and hand back NaN widths.
 */
function containerOf(element: HTMLElement, vertical: boolean): number {
  const box = element.parentElement?.getBoundingClientRect();
  if (!box) return 0;
  return vertical ? box.width : box.height;
}

/**
 * The control that gives one pane the whole workspace.
 *
 * In the header rather than in each pane's own corner, for one plain reason:
 * the panes are written by other parts of this codebase and two of them have
 * something in the top-right already. A control that has to negotiate for a
 * corner in three different components ends up in three different places.
 *
 * It is a set of toggles, not tabs. Tabs would say only one pane can be on
 * screen, which is the opposite of what this workspace is; these say "give this
 * one everything for a moment", and pressing the lit one gives it back.
 */
export function PaneChips({
  maximized,
  onToggle,
}: {
  maximized: PaneId | null;
  onToggle: (pane: PaneId) => void;
}) {
  const panes: PaneId[] = ["places", "map", "panel", "history"];

  return (
    <div className="hidden shrink-0 items-center gap-1 md:flex">
      <span className="mr-1 text-[11px] text-said-faint">화면 채우기</span>
      {panes.map((pane) => {
        const on = maximized === pane;
        return (
          <button
            key={pane}
            type="button"
            onClick={() => onToggle(pane)}
            aria-pressed={on}
            className={`rounded-md px-2 py-1 text-[12px] transition-colors ${
              on
                ? "bg-paper text-ink"
                : "text-said-faint hover:bg-ink hover:text-said-soft"
            }`}
          >
            {PANE_LABELS[pane]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Moving a divider between two columns, in pixels, with both minimums honoured.
 *
 * Kept out of the component because it is the part that can be wrong in a way
 * you cannot see: a drag that silently steals width from the column on the far
 * side, or one that lets a pane reach zero and strands its contents. Pure, so
 * it is tested rather than demonstrated.
 */
export function resizeColumns(
  columns: readonly [number, number, number],
  index: 0 | 1,
  deltaPx: number,
  containerPx: number,
): [number, number, number] {
  if (containerPx <= 0) return [...columns] as [number, number, number];

  const delta = deltaPx / containerPx;
  const left = index;
  const right = index + 1;

  const minLeft = MIN_PX[left === 0 ? "places" : "map"] / containerPx;
  const minRight = MIN_PX[right === 1 ? "map" : "panel"] / containerPx;

  const pair = columns[left] + columns[right];
  // The pair's total is invariant: a divider moves width between its two
  // neighbours and must never touch the third column. Clamping the new left
  // value and deriving the right one from the sum is what guarantees that,
  // where clamping both independently would quietly change the total.
  const nextLeft = clamp(columns[left] + delta, minLeft, pair - minRight);

  const next = [...columns] as [number, number, number];
  next[left] = nextLeft;
  next[right] = pair - nextLeft;
  return next;
}

/** The same, for the band along the bottom. */
export function resizeHistory(
  current: number,
  deltaPx: number,
  containerPx: number,
): number {
  if (containerPx <= 0) return current;
  // Dragging the divider down makes the band smaller, so the delta inverts.
  const next = current - deltaPx / containerPx;
  return clamp(next, MIN_HISTORY_PX / containerPx, MAX_HISTORY_FRACTION);
}
