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

/**
 * The order the panes are offered in on a phone, which is not the order they
 * are laid out in on a desktop.
 *
 * On a wide screen the chips read left to right across the screen they
 * describe, so 파일 comes first because the file list is the left column. On a
 * phone there are no columns to describe: the row is a table of contents, and
 * the first entry should be the thing the product is for. 지도 is what someone
 * opened the project to see.
 */
export const PHONE_PANE_ORDER: readonly PaneId[] = ["map", "places", "panel", "history"];

/**
 * Stable ids so the phone's tab row can point at the pane it switches to.
 *
 * The panes are rendered by the shell and the control lives here, so the two
 * would otherwise have to agree on a string written twice.
 */
export const PANE_PANEL_ID: Record<PaneId, string> = {
  places: "pane-places",
  map: "pane-map",
  panel: "pane-panel",
  history: "pane-history",
};

const PANE_TAB_ID: Record<PaneId, string> = {
  places: "panetab-places",
  map: "panetab-map",
  panel: "panetab-panel",
  history: "panetab-history",
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

/**
 * Below this width the workspace stops being three columns and becomes one
 * pane at a time. 768px is Tailwind's `md`, deliberately: the same number is
 * written as a `md:` variant on the chrome around the panes, and a layout whose
 * JavaScript breakpoint and CSS breakpoint disagree changes shape in two steps.
 *
 * `767.98` rather than `767`, because a viewport can be a fraction of a pixel
 * wide — a zoomed page, a desktop at 125% — and `max-width: 767px` leaves a
 * sliver where neither query matches and the screen is in neither layout.
 */
const PHONE_QUERY = "(max-width: 767.98px)";

let phoneQuery: MediaQueryList | null = null;
let onPhone = false;

/**
 * Whether the workspace is in its one-pane-at-a-time shape.
 *
 * A media query rather than a measured width, and read through the same
 * `useSyncExternalStore` the layout is read through, for the same reason: the
 * server has no width, so the server and the first client render must agree on
 * something (the desktop shape), and React must then re-read and re-render
 * once, before paint. Reading `window.innerWidth` in an effect and calling
 * setState is the shape React 19 rejects outright, and it would also paint the
 * three-column layout for a frame on every phone that opens the page.
 */
function subscribePhone(listener: () => void): () => void {
  if (!phoneQuery) {
    phoneQuery = window.matchMedia(PHONE_QUERY);
    onPhone = phoneQuery.matches;
  }
  const query = phoneQuery;
  const handle = () => {
    onPhone = query.matches;
    listener();
  };
  query.addEventListener("change", handle);
  return () => query.removeEventListener("change", handle);
}

const getPhone = () => onPhone;
const getServerPhone = () => false;

export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribePhone, getPhone, getServerPhone);
}

/**
 * Which pane the phone is showing.
 *
 * Held apart from `maximized` rather than reusing it, and the reason is a bug
 * that reusing it would create: on a phone one pane is *always* filling the
 * screen, so `maximized` would never be null again — and someone who rotated a
 * tablet back to a wide layout would find a workspace with two of its three
 * columns collapsed and no memory of having asked for that. The two states
 * answer different questions ("give this one everything for a minute" against
 * "which of the four am I looking at"), so they are two values.
 *
 * Not persisted, for the reason `maximized` is not: coming back to a phone
 * that opens on 변경 기록 rather than on the map is the app having lost the map.
 * The default is 지도, which is what the product is.
 */
let phonePane: PaneId = "map";
const getPhonePane = () => phonePane;
const getServerPhonePane = (): PaneId => "map";

export function usePhonePane(): [PaneId, (pane: PaneId) => void] {
  const pane = useSyncExternalStore(subscribe, getPhonePane, getServerPhonePane);
  const select = useCallback((next: PaneId) => {
    if (phonePane === next) return;
    phonePane = next;
    emit();
  }, []);
  return [pane, select];
}

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
  collapsed = false,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  /**
   * The track this divider sits in has been squeezed to 0px — by a maximised
   * pane, or by the phone layout, where there is nothing to divide at all.
   *
   * A zero-width separator is still in the tab order and still announced, so
   * without this a phone user tabbing through the workspace meets two controls
   * that are not on the screen and cannot do anything. It stays mounted rather
   * than being removed, because the grid template names five tracks in every
   * state and a template whose track count changes is a template that reflows.
   */
  collapsed?: boolean;
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
      role={collapsed ? "presentation" : "separator"}
      aria-orientation={collapsed ? undefined : orientation}
      aria-label={collapsed ? undefined : label}
      aria-valuenow={collapsed ? undefined : Math.round(valueNow)}
      aria-valuemin={collapsed ? undefined : 0}
      aria-valuemax={collapsed ? undefined : 100}
      aria-hidden={collapsed ? true : undefined}
      tabIndex={collapsed ? -1 : 0}
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
      /*
        Three states, and the middle one is the one that was missing.
        At rest the divider was `bg-edge` — the same token every hairline border
        on this screen uses — so a 5px bar you can drag and a 0.8px rule you
        cannot looked like the same object, one of them simply thicker. It now
        rests on the seam colour and lights on hover, and `active:` gives it the
        accent while it is actually being dragged, which is the feedback that
        says the grab landed. `lamp` rather than a grey: this is a control, and
        on this product lit means "you act here".
      */
      className={`group relative shrink-0 bg-edge transition-colors hover:bg-edge-lit focus-visible:bg-lamp-dim focus-visible:outline-none active:bg-lamp-dim ${
        vertical ? "cursor-col-resize" : "cursor-row-resize"
      } ${collapsed ? "pointer-events-none" : ""}`}
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

      {/*
        The grip: a short mark across the middle of the bar, so a divider is
        recognisable as one while the pointer is somewhere else entirely.

        Visible at rest rather than revealed on hover — a control you can only
        find by already having found it is not discoverable — and it brightens
        with the bar. `pointer-events-none` because the bar and its oversized
        grab area own the pointer; this is only ever a picture of a handle.

        Centred with `left-1/2 -translate-x-1/2` on the vertical bar, which is
        a transform on a 1px-wide element and therefore cannot drift the way a
        margin would at fractional device pixel ratios.
      */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute rounded-full bg-said-faint/35 transition-colors group-hover:bg-said-faint/70 ${
          vertical
            ? "left-1/2 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2"
            : "left-1/2 top-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2"
        }`}
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
  phone = false,
}: {
  maximized: PaneId | null;
  onToggle: (pane: PaneId) => void;
  /**
   * The same four words, doing a different job.
   *
   * Below `md` there is no room for three columns and a canvas — measured at
   * 375px, the canvas came out 211px wide and six controls sat off the right
   * edge of the screen — so the workspace shows one pane at a time and this
   * becomes the only way to reach the other three. That makes it navigation
   * rather than a convenience, and navigation has to say which of the four you
   * are in: it is a `tablist` here, one of the four is always selected, and
   * pressing the selected one does nothing rather than returning to a layout
   * this width cannot draw.
   */
  phone?: boolean;
}) {
  const panes: PaneId[] = ["places", "map", "panel", "history"];

  if (phone) {
    const order = PHONE_PANE_ORDER;
    const move = (from: PaneId, step: number) => {
      const at = order.indexOf(from);
      // Wraps, which is what a tablist does: pressing → on the last tab lands
      // on the first rather than on nothing.
      onToggle(order[(at + step + order.length) % order.length]);
    };

    return (
      <div
        role="tablist"
        aria-label="보고 있는 화면"
        className="flex shrink-0 items-stretch gap-1 border-t-[0.8px] border-edge bg-ink px-2 py-1.5 md:hidden"
      >
        {order.map((pane) => {
          const on = maximized === pane;
          return (
            <button
              key={pane}
              type="button"
              role="tab"
              id={PANE_TAB_ID[pane]}
              aria-selected={on}
              aria-controls={PANE_PANEL_ID[pane]}
              /*
                Roving tabindex: the four chips are one stop, and the arrow keys
                move within it. A row of four buttons that each take a tab stop
                is four presses to get past a control you were not using.
              */
              tabIndex={on ? 0 : -1}
              onClick={() => onToggle(pane)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  move(pane, 1);
                } else if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  move(pane, -1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  onToggle(order[0]);
                } else if (event.key === "End") {
                  event.preventDefault();
                  onToggle(order[order.length - 1]);
                }
              }}
              /*
                `min-h-11` is 44px, the smallest target a thumb reliably lands
                on, and it is a minimum rather than a height so a label that
                wraps at 320px makes the row taller instead of being cut.

                `whitespace-nowrap` on 변경 기록: it is the only two-word label
                here, and at 320px each chip is 74px, which is wide enough for
                it on one line but not by much. Breaking it would put 변경 on one
                line and 기록 on the next inside a 44px button — the label
                mid-word failure this layout exists to remove.

                No `label-kr`: its 0.14em tracking is set for a heading with
                space around it, and on a chip 74px wide it is the difference
                between a label that fits and one that does not.
              */
              className={`flex min-h-11 flex-1 items-center justify-center rounded-lg px-1 text-[13px] whitespace-nowrap transition-colors ${
                on
                  ? "bg-paper font-semibold text-ink"
                  : "text-said-soft active:bg-ink-raised"
              }`}
            >
              {PANE_LABELS[pane]}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="hidden shrink-0 items-center gap-1 md:flex">
      {/*
        `label-kr`, the same small-label voice the panels' section headings use,
        so the one label in the header is not its own third treatment.

        The lit chip stays `bg-paper` and is deliberately the loudest control on
        this screen. It is the only thing that says a pane is filling the
        workspace — the other panes are at zero width, not unmounted, and the
        state is not persisted — so it is a status indicator wearing a button's
        clothes, and quieting it into the panel's `bg-ink` toggle family would
        cost the one signal that explains where everything went.
      */}
      <span className="label-kr mr-1 text-[11px] text-said-faint">화면 채우기</span>
      {panes.map((pane) => {
        const on = maximized === pane;
        return (
          <button
            key={pane}
            type="button"
            onClick={() => onToggle(pane)}
            aria-pressed={on}
            /*
              `bg-ink-raised` on hover, not `bg-ink`. The header has no surface
              of its own, so it is painted in `ink` by the body — which is
              exactly what the unlit chip was asking for on hover, and a chip
              that hovers to the colour it is already sitting on has no hover
              state at all. It has to go up from the header, not match it.
            */
            className={`rounded-md px-2 py-1 text-[12px] transition-colors ${
              on
                ? "bg-paper text-ink"
                : "text-said-faint hover:bg-ink-raised hover:text-said-soft"
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
