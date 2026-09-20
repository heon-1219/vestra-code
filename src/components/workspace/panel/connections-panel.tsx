"use client";

import { useId, useImperativeHandle, useMemo, useRef, useState } from "react";

import {
  CERTAINTY_WORDS,
  KIND_WORDS,
  type GraphItem,
  type GraphView,
} from "@/lib/graph/view";
// Type only. A runtime import of `config.ts` reaches `env.ts`, which validates
// eleven server variables at import and throws — not something a component
// bundled for the browser can survive. See the note at the top of `model.ts`.
import type { ProviderId } from "@/lib/llm/config";

import {
  CertaintyLegend,
  ConnectionRow,
  displayName,
  distanceWord,
  lockOf,
  type ConnectionLock,
  type LockMap,
} from "./connection-row";
import {
  buildNeighbourhood,
  DEFAULT_HOPS,
  DEFAULT_LIMIT,
  isAlone,
  MAX_HOPS,
  MIN_HOPS,
  type Neighbour,
  type Neighbourhood,
} from "./neighbourhood";
import { describeAll } from "@/lib/graph/describe";

import { DEFAULT_PANEL_MODE, MODE_WORDS, type PanelMode } from "./mode";
import { ModeSelect } from "./mode-select";
import {
  chooseModel,
  DEFAULT_PANEL_EFFORT,
  type ModelChoice,
  type PanelEffort,
  type PanelRequest,
} from "./model";
import { ModelSelect } from "./model-select";
import { previewTargetFor } from "../preview/file-preview";
import {
  AnalysisRunningState,
  AnswerState,
  NoKnownConnections,
  NothingSelectedState,
  PromptState,
  RunFailedState,
  type PanelAnswer,
  type PanelPrompt,
  type RunProgress,
} from "./states";

export type { ConnectionLock, LockMap } from "./connection-row";
export { DEFAULT_LOCK, lockOf } from "./connection-row";
export type { PanelAnswer, PanelCitation, PanelPrompt, RunProgress } from "./states";
export type { PanelMode } from "./mode";
export type { ModelChoice, PanelEffort, PanelRequest } from "./model";

/**
 * The right panel: what happens when someone points at a part of their app.
 *
 * Reading order is the brief's and it is deliberate — see what is connected,
 * decide what may change, type the request. So the panel is one column, and
 * the request box is the last thing in it.
 *
 * **The request box is mounted once, at the bottom of this component, for
 * every state.** Moving a React input to a different parent unmounts and
 * remounts it: new DOM node, lost focus, lost caret, and — the one with teeth
 * for a Korean-first product — lost IME composition state, which means a
 * half-typed 한글 syllable vanishes mid-word. Everything above it swaps; the
 * box itself only ever moves by layout.
 */

export type PanelTab = "list" | "graph";

export type RightPanelProps = {
  /** Null while the map is still loading. */
  view: GraphView | null;
  selectedId: string | null;
  /** The live run, if one is going. Null once the map is the thing on screen. */
  run?: RunProgress | null;
  locks: LockMap;
  onLockChange: (id: string, lock: ConnectionLock) => void;
  onSelect: (id: string) => void;
  onRetry?: () => void;
  /** Open the selected item's file. Undefined hides the offer entirely. */
  onOpen?: (id: string) => void;
  /**
   * One per mode. Step 4 wires them; until a mode has one, that mode's own
   * sentence says it cannot do its job yet rather than the button pretending.
   *
   * The model and the effort travel with the text rather than being read back
   * out of the panel afterwards, because they are part of what was asked: a
   * request answered by whatever the picker happens to say a second later is
   * a different request than the one the person sent.
   */
  onAsk?: (text: string, request: PanelRequest) => void;
  onMakePrompt?: (text: string, request: PanelRequest) => void;
  onExplain?: (text: string, request: PanelRequest) => void;
  /**
   * The models this installation actually has a key for, default first —
   * `availableProviders()` from `@/lib/llm`, handed down from the server
   * because only the server may read the environment.
   *
   * Defaulting to none is not a placeholder, it is the honest reading of an
   * unwired screen: there is no key on this machine today, and the box says so
   * rather than showing a control over nothing.
   */
  models?: readonly ModelChoice[];
  answer?: PanelAnswer | null;
  prompt?: PanelPrompt | null;
  /** How many connections one direction may show before the panel says it capped. */
  limit?: number;
  /**
   * False when the workspace is already showing the phase checklist in the
   * centre. The panel then shows the counts and the file list without
   * repeating the steps beside them.
   */
  showRunSteps?: boolean;
};

/**
 * One array, so that a panel rendered without models does not make a new empty
 * one on every keystroke — and so "no model" is a named thing rather than a
 * literal repeated wherever it is needed.
 */
const NO_MODELS: readonly ModelChoice[] = [];

export function RightPanel({
  view,
  selectedId,
  run = null,
  locks,
  onLockChange,
  onSelect,
  onRetry,
  onOpen,
  onAsk,
  onMakePrompt,
  onExplain,
  models = NO_MODELS,
  answer = null,
  prompt = null,
  limit = DEFAULT_LIMIT,
  showRunSteps = true,
}: RightPanelProps) {
  // Tab, depth and mode live here rather than inside the connections view or
  // the request box, so that clicking a second item does not throw away the way
  // the user was looking at the first one. Mode belongs in that list for the
  // same reason the other two do: someone who came to the panel to have things
  // explained is still there after they click the next thing to be explained.
  const [tab, setTab] = useState<PanelTab>("list");
  const [hops, setHops] = useState<number>(DEFAULT_HOPS);
  const [mode, setMode] = useState<PanelMode>(DEFAULT_PANEL_MODE);
  // Null is "nobody has chosen", which is different from a name: it lets the
  // box follow this installation's default instead of pinning the first model
  // the panel happened to be given.
  const [model, setModel] = useState<ProviderId | null>(null);
  const [effort, setEffort] = useState<PanelEffort>(DEFAULT_PANEL_EFFORT);
  const requestRef = useRef<RequestBoxHandle>(null);

  const selected = view?.items.find((item) => item.id === selectedId) ?? null;
  const running = run?.status === "running";

  let body: React.ReactNode;
  if (run && (run.status === "running" || (run.status === "completed" && !view))) {
    body = <AnalysisRunningState run={run} showSteps={showRunSteps} />;
  } else if (run?.status === "failed" && !selected) {
    body = <RunFailedState message={run.message} onRetry={onRetry} />;
  } else if (!view) {
    body = <PanelLoading />;
  } else if (selected) {
    body = (
      <ConnectionsPanel
        view={view}
        selected={selected}
        tab={tab}
        onTabChange={setTab}
        hops={hops}
        onHopsChange={setHops}
        locks={locks}
        onLockChange={onLockChange}
        onSelect={onSelect}
        onOpen={onOpen}
        limit={limit}
      />
    );
  } else {
    body = (
      <NothingSelectedState
        view={view}
        onSelect={onSelect}
        // A suggestion is a question, so taking one puts the box in 물어보기.
        // Dropping the text in while the box was set to 설명하기 would leave it
        // sitting under a button that has no use for it.
        onSuggestion={
          onAsk
            ? (text) => {
                setMode("ask");
                requestRef.current?.fill(text);
              }
            : undefined
        }
      />
    );
  }

  return (
    <aside
      aria-label="연결 패널"
      className="flex h-full min-h-0 flex-col border-l border-edge bg-ink-raised"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {body}

        {answer ? (
          <div className="mt-5">
            <AnswerState answer={answer} onSelect={onSelect} />
          </div>
        ) : null}

        {prompt ? (
          <div className="mt-4">
            <PromptState prompt={prompt} />
          </div>
        ) : null}
      </div>

      <RequestBox
        ref={requestRef}
        selected={selected}
        disabled={running || !view}
        mode={mode}
        onModeChange={setMode}
        models={models}
        model={model}
        onModelChange={setModel}
        effort={effort}
        onEffortChange={setEffort}
        onAsk={onAsk}
        onMakePrompt={onMakePrompt}
        onExplain={onExplain}
      />
    </aside>
  );
}

/* ------------------------------------------------------------ item chosen */

export function ConnectionsPanel({
  view,
  selected,
  tab,
  onTabChange,
  hops,
  onHopsChange,
  locks,
  onLockChange,
  onSelect,
  onOpen,
  limit = DEFAULT_LIMIT,
}: {
  view: GraphView;
  selected: GraphItem;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  hops: number;
  onHopsChange: (hops: number) => void;
  locks: LockMap;
  onLockChange: (id: string, lock: ConnectionLock) => void;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
  limit?: number;
}) {
  const around = useMemo(
    () => buildNeighbourhood(view, selected.id, { hops, limit }),
    [view, selected.id, hops, limit],
  );

  // Memoised on the graph, not recomputed per render: it walks every
  // connection, and this panel re-renders on every hop change and every
  // selection.
  const described = useMemo(
    () => describeAll({ items: view.items, connections: view.connections }),
    [view],
  );

  if (!around) return <PanelLoading />;

  const name = selected.label ?? selected.name;
  // A file's name IS its path, and printing it twice reads as two facts.
  const showPath = selected.path !== null && selected.path !== name;
  // 외부 도구 and, later, a feature have no file behind them. The offer only
  // appears where it can be kept.
  const canOpen = onOpen !== undefined && previewTargetFor(selected) !== null;

  return (
    <div>
      <header>
        <p className="text-[12px] text-said-faint">{KIND_WORDS[selected.kind]}</p>
        <h2 className="mt-0.5 text-[18px] font-semibold tracking-[-0.02em] text-said">
          {selected.label ? (
            displayName(selected)
          ) : (
            <code className="text-[16px]">{selected.name}</code>
          )}
        </h2>

        {/*
          What this is for, always — not only when a model has written a
          sentence about it. `describeAll` falls back to what the parser
          measured, so clicking a file answers "what is this" before Pass 2 has
          ever run, with no key, and when Pass 2 failed. The same sentence the
          map shows on hover, so pointing at a thing and choosing it never say
          two different things about it.
        */}
        <p className="mt-2 text-[13px] leading-[1.8] text-said-soft">
          {described.get(selected.id)?.line ?? KIND_WORDS[selected.kind]}
        </p>

        {showPath ? (
          <p className="mt-2 truncate font-mono text-[11px] text-said-faint" title={selected.path ?? ""}>
            {selected.path}
            {selected.startLine
              ? ` · ${selected.startLine}–${selected.endLine ?? selected.startLine}줄`
              : ""}
          </p>
        ) : null}

        <p className="mt-3 text-[13px] text-said-soft">
          {reachSentence(around.reach.places, around.reach.pages)}
        </p>

        {canOpen ? (
          /*
            Reading the map is one thing and looking at the file is another, so
            the way in is a button rather than something that happens when you
            click. For a piece of a file it says which lines it will land on,
            because that is the answer to "어디를 말하는 거예요?" before it opens.
          */
          <button
            type="button"
            onClick={() => onOpen(selected.id)}
            className="mt-3 rounded-lg border border-edge-lit px-3 py-1.5 text-[13px] text-said-soft transition-colors hover:text-said"
          >
            {selected.kind === "file" || selected.startLine === null
              ? "파일 열어보기"
              : `${selected.startLine}줄부터 열어보기`}
          </button>
        ) : null}
      </header>

      <div className="mt-4 flex items-center gap-1 border-b border-edge pb-2">
        <TabButton active={tab === "list"} onClick={() => onTabChange("list")}>
          목록
        </TabButton>
        <TabButton active={tab === "graph"} onClick={() => onTabChange("graph")}>
          그림
        </TabButton>
      </div>

      {/*
        The depth control sits outside both tabs on purpose. The two tabs are
        two drawings of the same neighbourhood, so the depth belongs to the
        neighbourhood, not to the tab — and a control that appears when you
        switch tabs makes the same facts look like different facts.
      */}
      <HopControl hops={around.hops} onChange={onHopsChange} />

      {isAlone(around) ? (
        <div className="mt-4">
          <NoKnownConnections />
        </div>
      ) : tab === "list" ? (
        <ConnectionList
          around={around}
          locks={locks}
          onLockChange={onLockChange}
          onSelect={onSelect}
        />
      ) : (
        <NeighbourhoodGraph around={around} onSelect={onSelect} />
      )}
    </div>
  );
}

/**
 * The one sentence the product is sold on: "this is used in N places".
 *
 * Said without a number when we found none — "아직 찾지 못했어요" is a statement
 * about our reading, where "0곳에서 쓰여요" would be a statement about their
 * code, and only one of those is something we know.
 */
function reachSentence(places: number, pages: number): string {
  if (places === 0) return "쓰는 곳은 아직 찾지 못했어요";
  if (pages === places) return `화면 ${places.toLocaleString("ko-KR")}곳에서 쓰여요`;
  if (pages > 0) {
    return `${places.toLocaleString("ko-KR")}곳에서 쓰여요 · 화면 ${pages.toLocaleString("ko-KR")}곳 포함`;
  }
  return `${places.toLocaleString("ko-KR")}곳에서 쓰여요`;
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg px-3 py-1.5 text-[14px] font-medium transition-colors ${
        active ? "bg-ink text-said" : "text-said-faint hover:text-said-soft"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * How far to look, as a number the user types.
 *
 * It was three buttons — 바로 옆 / 한 다리 건너 / 두 다리 건너 — which showed
 * every option and its meaning at once, and that was its virtue. The cost was
 * that the range WAS the control: asking for four steps meant adding a fourth
 * button, so the ceiling was set by what fits on a row rather than by anything
 * about the graph.
 *
 * A field keeps the meaning visible by printing the words BESIDE the number
 * rather than instead of it, and the steppers keep the common case a single
 * click. "2" on its own tells someone who does not think in steps nothing;
 * "2" next to "한 다리 건너" tells them both.
 */
function HopControl({ hops, onChange }: { hops: number; onChange: (hops: number) => void }) {
  // The field is uncontrolled between commits so a half-typed value is not
  // fought with on every keystroke — someone clearing the box to type "12"
  // passes through empty, and snapping that to 1 mid-keystroke is maddening.
  const [draft, setDraft] = useState(String(hops));

  // Re-synced during render, not in an effect. An effect would paint one frame
  // showing the old number, and the React compiler rules reject setState there
  // for exactly that reason. This is the documented way to adjust state when a
  // prop changes, and it does not remount the input, so a focused field stays
  // focused.
  const [lastHops, setLastHops] = useState(hops);
  if (hops !== lastHops) {
    setLastHops(hops);
    setDraft(String(hops));
  }

  const commit = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      setDraft(String(hops));
      return;
    }
    const next = Math.min(Math.max(parsed, MIN_HOPS), MAX_HOPS);
    setDraft(String(next));
    onChange(next);
  };

  const step = (delta: number) => {
    const next = Math.min(Math.max(hops + delta, MIN_HOPS), MAX_HOPS);
    if (next !== hops) onChange(next);
  };

  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="text-[12px] text-said-faint">얼마나 멀리까지</span>

      <div className="flex items-center rounded-md border border-edge-lit">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={hops <= MIN_HOPS}
          aria-label="한 단계 가깝게"
          className="px-2 py-1 text-[13px] text-said-faint transition-colors hover:text-said disabled:opacity-40"
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={MIN_HOPS}
          max={MAX_HOPS}
          value={draft}
          aria-label={`얼마나 멀리까지 볼지, ${MIN_HOPS}에서 ${MAX_HOPS} 사이`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget.value);
          }}
          className="w-9 bg-transparent py-1 text-center text-[13px] tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <button
          type="button"
          onClick={() => step(1)}
          disabled={hops >= MAX_HOPS}
          aria-label="한 단계 멀리"
          className="px-2 py-1 text-[13px] text-said-faint transition-colors hover:text-said disabled:opacity-40"
        >
          +
        </button>
      </div>

      {/* The number and what it means, together. */}
      <span className="text-[12px] text-said-soft">{distanceWord(hops)}</span>
    </div>
  );
}

/* ------------------------------------------------------------- list tab */

function ConnectionList({
  around,
  locks,
  onLockChange,
  onSelect,
}: {
  around: Neighbourhood;
  locks: LockMap;
  onLockChange: (id: string, lock: ConnectionLock) => void;
  onSelect: (id: string) => void;
}) {
  // `contains` gets its own headings rather than being filed under "what this
  // uses". A file does not USE the component written in it, it HOLDS it — and
  // forty rows reading 안에 있어요 under a heading that says 쓰는 것 is the kind
  // of small wrongness that teaches someone their map cannot be trusted.
  const inside = around.uses.filter((n) => n.relation === "contains");
  const uses = around.uses.filter((n) => n.relation !== "contains");
  const home = around.usedBy.filter((n) => n.relation === "contains");
  const usedBy = around.usedBy.filter((n) => n.relation !== "contains");
  const cap = capNotice(around);

  return (
    <div className="mt-4">
      <p className="text-[12px] leading-[1.7] text-said-faint">
        연결된 것은 처음엔 모두 잠겨 있어요. 같이 고쳐도 되는 것만 열어 주세요.
      </p>

      <Section title="여기가 있는 곳" rows={home} locks={locks} onLockChange={onLockChange} onSelect={onSelect} />
      <Section title="안에 있는 것" rows={inside} locks={locks} onLockChange={onLockChange} onSelect={onSelect} />
      <Section title="여기서 쓰는 것" rows={uses} locks={locks} onLockChange={onLockChange} onSelect={onSelect} />
      <Section title="여기를 쓰는 곳" rows={usedBy} locks={locks} onLockChange={onLockChange} onSelect={onSelect} />

      {cap ? (
        <p className="mt-4 rounded-lg border border-edge bg-ink px-3 py-2.5 text-[12px] leading-[1.75] text-said-soft">
          {cap}
        </p>
      ) : null}

      <CertaintyLegend className="mt-4 border-t border-edge pt-3" />
    </div>
  );
}

function Section({
  title,
  rows,
  locks,
  onLockChange,
  onSelect,
}: {
  title: string;
  rows: Neighbour[];
  locks: LockMap;
  onLockChange: (id: string, lock: ConnectionLock) => void;
  onSelect: (id: string) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="mt-4">
      <h3 className="text-[12px] text-said-faint">
        {title} {rows.length.toLocaleString("ko-KR")}
      </h3>
      <ul className="mt-1">
        {rows.map((neighbour) => (
          <ConnectionRow
            key={`${neighbour.direction}:${neighbour.item.id}`}
            neighbour={neighbour}
            lock={lockOf(locks, neighbour.item.id)}
            onLockChange={onLockChange}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * What the cap left out, in the user's numbers.
 *
 * A list that silently stops reads as "that is all there is", which on this
 * product is a false statement about someone's own code — the one kind of
 * mistake we cannot make.
 */
export function capNotice(around: Neighbourhood): string | null {
  const parts: string[] = [];
  // Said by direction rather than by heading: the cap is applied to everything
  // going one way, and the headings below split that into two. Naming a
  // heading here would attach a number to a list it does not describe.
  if (around.hidden.uses > 0) {
    parts.push(
      `여기서 이어진 것 ${around.found.uses.toLocaleString("ko-KR")}개 중 ${around.uses.length.toLocaleString("ko-KR")}개`,
    );
  }
  if (around.hidden.usedBy > 0) {
    parts.push(
      `여기로 이어진 곳 ${around.found.usedBy.toLocaleString("ko-KR")}개 중 ${around.usedBy.length.toLocaleString("ko-KR")}개`,
    );
  }
  if (parts.length === 0) return null;

  const hidden = around.hidden.uses + around.hidden.usedBy;
  return `연결이 많아서 ${parts.join(", ")}만 보여 드려요. 나머지 ${hidden.toLocaleString("ko-KR")}개도 있어요.`;
}

/* ------------------------------------------------------------ graph tab */

/** Per row, so labels keep room to be read. Anything over this is counted out loud. */
const PER_ROW = 7;
const ROW_HEIGHT = 62;
const WIDTH = 360;

type Placed = { neighbour: Neighbour; x: number; y: number };

/**
 * The same neighbourhood, drawn.
 *
 * Laid out rather than simulated: rows by distance, what uses this above, what
 * this uses below, the selection in the middle. A force layout here would move
 * every item each time the panel opened, and a picture that will not sit still
 * cannot be pointed at — which is the only thing this tab is for.
 */
function NeighbourhoodGraph({
  around,
  onSelect,
}: {
  around: Neighbourhood;
  onSelect: (id: string) => void;
}) {
  const rawId = useId();
  // Colons are legal in an id and awkward everywhere else, url(#…) included.
  const hatchId = `hatch-${rawId.replace(/:/g, "")}`;

  const aboveRows: Neighbour[][] = [];
  const belowRows: Neighbour[][] = [];
  let hiddenInPicture = 0;

  for (let hop = 1; hop <= around.hops; hop += 1) {
    const up = around.usedBy.filter((n) => n.hops === hop);
    const down = around.uses.filter((n) => n.hops === hop);
    hiddenInPicture += Math.max(0, up.length - PER_ROW) + Math.max(0, down.length - PER_ROW);
    if (up.length > 0) aboveRows.push(up.slice(0, PER_ROW));
    if (down.length > 0) belowRows.push(down.slice(0, PER_ROW));
  }

  const height = ROW_HEIGHT * (aboveRows.length + belowRows.length) + 76;
  const cy = ROW_HEIGHT * aboveRows.length + 38;
  const placed = new Map<string, Placed>();

  // Furthest row first going up, so row 0 of `aboveRows` (one hop) ends up
  // nearest the centre.
  aboveRows.forEach((row, index) => {
    const y = cy - ROW_HEIGHT * (index + 1);
    row.forEach((neighbour, column) => {
      placed.set(key(neighbour), { neighbour, x: columnX(column, row.length), y });
    });
  });
  belowRows.forEach((row, index) => {
    const y = cy + ROW_HEIGHT * (index + 1);
    row.forEach((neighbour, column) => {
      placed.set(key(neighbour), { neighbour, x: columnX(column, row.length), y });
    });
  });

  const centre = { x: WIDTH / 2, y: cy };

  return (
    <div className="mt-4">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full"
        role="img"
        aria-label={`${displayName(around.selected)} 주변 연결 그림. 같은 내용을 목록 탭에서 글로 볼 수 있어요.`}
      >
        <defs>
          {/*
            The guessed connection is a hatched ribbon, not a dashed hairline.
            At the size a real project is looked at, a 1px dash and a 1px solid
            line are the same line — the distinction the product rests on would
            quietly stop existing. A band with texture in it survives being
            made smaller, and survives a projector.
          */}
          <pattern
            id={hatchId}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="4" height="4" fill="var(--color-ink-raised)" />
            <rect width="1.6" height="4" fill="var(--color-guess)" />
          </pattern>
        </defs>

        {[...placed.values()].map(({ neighbour, x, y }) => {
          const from = neighbour.via ? placed.get(keyOf(neighbour.via.id, neighbour.direction)) : null;
          const anchor = from ? { x: from.x, y: from.y } : centre;
          return (
            <line
              key={`line-${key(neighbour)}`}
              x1={anchor.x}
              y1={anchor.y}
              x2={x}
              y2={y}
              stroke={
                neighbour.hopCertainty === "certain" ? "var(--color-wire)" : `url(#${hatchId})`
              }
              strokeWidth={neighbour.hopCertainty === "certain" ? 1.4 : 5}
              strokeLinecap="butt"
            />
          );
        })}

        {[...placed.values()].map(({ neighbour, x, y }) => (
          <GraphDot
            key={`dot-${key(neighbour)}`}
            x={x}
            y={y}
            item={neighbour.item}
            below={neighbour.direction === "uses"}
            onSelect={onSelect}
          />
        ))}

        <circle cx={centre.x} cy={centre.y} r="8" fill="var(--color-lamp)" />
        <text
          x={centre.x}
          y={centre.y + 22}
          textAnchor="middle"
          className="fill-[var(--color-said)]"
          fontSize="11"
          fontWeight="600"
        >
          {truncate(displayName(around.selected), 20)}
        </text>
      </svg>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <p className="text-[12px] text-said-faint">위: 여기를 쓰는 곳 · 아래: 여기서 쓰는 것</p>
        <CertaintyLegend />
      </div>

      {hiddenInPicture > 0 ? (
        <p className="mt-2 text-[12px] leading-[1.75] text-said-soft">
          그림이 좁아서 {hiddenInPicture.toLocaleString("ko-KR")}개는 그리지 못했어요. 목록 탭에는
          다 있어요.
        </p>
      ) : null}

      {capNotice(around) ? (
        <p className="mt-2 text-[12px] leading-[1.75] text-said-soft">{capNotice(around)}</p>
      ) : null}
    </div>
  );
}

function GraphDot({
  x,
  y,
  item,
  below,
  onSelect,
}: {
  x: number;
  y: number;
  item: GraphItem;
  below: boolean;
  onSelect: (id: string) => void;
}) {
  const name = displayName(item);
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${name}, ${KIND_WORDS[item.kind]}`}
      onClick={() => onSelect(item.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(item.id);
        }
      }}
      className="cursor-pointer"
    >
      <title>{`${name} · ${KIND_WORDS[item.kind]}`}</title>
      <circle cx={x} cy={y} r="5" fill="var(--color-ink-raised)" stroke="var(--color-wire)" strokeWidth="1.5" />
      <text
        x={x}
        y={below ? y + 17 : y - 10}
        textAnchor="middle"
        className="fill-[var(--color-said-soft)]"
        fontSize="10"
      >
        {truncate(lastPart(name), 10)}
      </text>
    </g>
  );
}

function columnX(column: number, count: number): number {
  const usable = WIDTH - 36;
  return 18 + ((column + 0.5) * usable) / count;
}

function key(neighbour: Neighbour): string {
  return keyOf(neighbour.item.id, neighbour.direction);
}

function keyOf(id: string, direction: Neighbour["direction"]): string {
  return `${direction}:${id}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The end of a path, for a label with room for about ten characters.
 *
 * `app/checkout/page.jsx` cut from the front is "app/chec…", which is the part
 * every file in the folder shares. The tail is the part that identifies it, and
 * the full name is still on hover and in the list.
 */
function lastPart(name: string): string {
  const cut = name.lastIndexOf("/");
  return cut === -1 || cut === name.length - 1 ? name : name.slice(cut + 1);
}

/* ----------------------------------------------------------- request box */

export type RequestBoxHandle = {
  /** Put text in the box and focus it, without sending anything. */
  fill: (text: string) => void;
};

/**
 * The box at the bottom, mounted once for the life of the panel.
 *
 * Uncontrolled on purpose. A controlled textarea re-renders this whole panel on
 * every keystroke — with a Korean IME that is every keystroke of every syllable
 * — and the panel is sitting next to a live map. The only thing React needs to
 * know is whether the box is empty, so that is the only thing it is told.
 */
function RequestBox({
  ref,
  selected,
  disabled,
  mode,
  onModeChange,
  models,
  model,
  onModelChange,
  effort,
  onEffortChange,
  onAsk,
  onMakePrompt,
  onExplain,
}: {
  ref: React.RefObject<RequestBoxHandle | null>;
  selected: GraphItem | null;
  disabled: boolean;
  mode: PanelMode;
  onModeChange: (mode: PanelMode) => void;
  models: readonly ModelChoice[];
  model: ProviderId | null;
  onModelChange: (model: ProviderId) => void;
  effort: PanelEffort;
  onEffortChange: (effort: PanelEffort) => void;
  onAsk?: (text: string, request: PanelRequest) => void;
  onMakePrompt?: (text: string, request: PanelRequest) => void;
  onExplain?: (text: string, request: PanelRequest) => void;
}) {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const [hasText, setHasText] = useState(false);

  useImperativeHandle(ref, () => ({
    fill(text: string) {
      const box = boxRef.current;
      if (!box) return;
      box.value = text;
      setHasText(text.trim().length > 0);
      box.focus();
    },
  }));

  function read(): string {
    return boxRef.current?.value.trim() ?? "";
  }

  const words = MODE_WORDS[mode];

  // The chosen mode decides what the one button does. This is the whole point
  // of the change: a handler per mode still exists, but the user picks which
  // one they are in rather than reading a row of buttons and guessing.
  const act: ((text: string, request: PanelRequest) => void) | undefined = {
    ask: onAsk,
    prompt: onMakePrompt,
    explain: onExplain,
  }[mode];

  // 설명하기 works on the thing already chosen, so it must not sit greyed out
  // waiting for text it never promised to read.
  const enough = words.needs === "text" ? hasText : selected !== null;

  function fire() {
    const text = read();
    if (!act) return;
    if (words.needs === "text" && text.length === 0) return;
    // What the row underneath actually shows, resolved the same way it resolves
    // it — not the raw `model`, which can name a provider whose key has since
    // been taken away. Null means nothing is connected, and it is the caller's
    // job to refuse rather than to pick something on the user's behalf.
    act(text, { model: chooseModel(models, model)?.id ?? null, effort });
  }

  return (
    <div className="shrink-0 border-t border-edge bg-ink-raised px-4 py-3">
      {/*
        Above the box, because the mode changes what there is to type — a
        question, a change you want made, or nothing at all. Choosing after
        typing would be choosing after the decision it governs.
      */}
      <ModeSelect value={mode} onChange={onModeChange} className="mb-2" />

      <textarea
        ref={boxRef}
        rows={2}
        disabled={disabled}
        onInput={(event) => {
          const next = event.currentTarget.value.trim().length > 0;
          // Same value means React bails out, so a long sentence re-renders
          // this component once, not once per character.
          setHasText(next);
        }}
        onKeyDown={(event) => {
          // isComposing is the whole point: Enter while a 한글 syllable is
          // being assembled belongs to the IME, not to us.
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            fire();
          }
        }}
        // Left naming only questions and changes, which is what the box is for
        // in the two modes that read it. 설명하기 does not, and saying so here
        // would be advertising the box as useless in a third of its states.
        placeholder={
          selected
            ? `${displayName(selected)}에 대해 묻거나, 바꾸고 싶은 걸 적어 주세요`
            : "이 프로젝트에 대해 물어보세요"
        }
        aria-label="질문이나 바꾸고 싶은 내용"
        className="w-full resize-none rounded-xl border border-edge-lit bg-ink px-3 py-2.5 text-[14px] leading-[1.7] text-said placeholder:text-said-faint focus:border-lamp-dim focus:outline-none disabled:opacity-55"
      />

      {/*
        Below the box, unlike the mode row above it, and the same rule read
        twice: the mode changes what there is to type, so it is chosen before
        typing; who answers and how hard is only settled at the moment of
        sending, and this sits where sending happens.

        Its own line rather than sharing one with the button, which is where
        Claude's box puts it: at this column's width — minmax(272px, 25%) — two
        model names, two efforts and a Korean verb do not fit one line, so they
        would wrap anyway, and a row that has the button on it at one width and
        not at another is harder to read than one that never does.
      */}
      <ModelSelect
        className="mt-2"
        models={models}
        model={model}
        onModelChange={onModelChange}
        effort={effort}
        onEffortChange={onEffortChange}
      />

      {/*
        One button, named by the mode rather than by a neutral 보내기, so what is
        about to happen is readable before it happens and not only after.
      */}
      <button
        type="button"
        onClick={fire}
        disabled={disabled || !act || !enough}
        className="mt-2 rounded-lg bg-paper px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:bg-lamp disabled:opacity-45"
      >
        {words.name}
      </button>

      {/*
        The one line that has to be true. While this mode has nothing behind it,
        it says what this mode will do and that it cannot yet; once it is wired,
        the same sentence without the apology. Never a shared "준비 중" — the
        person reading it has just chosen one of three things, and a sentence
        about the other two is not an answer to them.
      */}
      <p className="mt-2 text-[12px] leading-[1.7] text-said-faint">
        {act ? words.promise : words.notYet}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- loading */

function PanelLoading() {
  return (
    <div>
      <p className="text-[14px] text-said-soft">지도를 불러오는 중이에요.</p>
      <p className="mt-1.5 text-[12px] text-said-faint">
        {CERTAINTY_WORDS.certain}와 {CERTAINTY_WORDS.inferred}를 구분해서 보여 드려요.
      </p>
    </div>
  );
}
