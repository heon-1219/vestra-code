"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { useAnalysisStream } from "@/hooks/use-analysis-stream";
import { describeAll } from "@/lib/graph/describe";
import type { GraphView } from "@/lib/graph/view";

import { AnalysisScreen } from "./analysis-screen";
import { DistrictMap } from "./map/district-map";
import { buildBeamIndex, runBeam, IDLE_BEAM } from "./map/beam";
import {
  DEFAULT_GROUPING,
  groupingOptions,
  resolveGrouping,
  type Grouping,
} from "./map/grouping";
import { GroupingControl } from "./map/grouping-control";
import {
  columnTemplate,
  Divider,
  PaneChips,
  resizeColumns,
  resizeHistory,
  usePaneLayout,
} from "./panes";
import { PlacesPanel } from "./places-panel";
import {
  RightPanel,
  type ConnectionLock,
  type LockMap,
  type ModelChoice,
} from "./panel/connections-panel";
import { FilePreview, previewTargetFor, type PreviewTarget } from "./preview/file-preview";
import { toAnalysisProgress, toRunProgress } from "./stream-adapter";

/**
 * The workspace: one project, one screen.
 *
 * The shell is section 3's wireframe — left about 15%, centre the rest, right
 * about 25% — and the centre stays wide because in Step 6 it holds a live
 * preview of the user's own site, which does not survive being squeezed into
 * half a column. The map is the tenant of that frame, not its owner.
 *
 * Three things here are decisions rather than plumbing:
 *
 *   - **The beam input is mounted once, in the centre toolbar, and never
 *     moves.** Section 5's warning 2: a React input that changes parent is
 *     unmounted and remounted, which throws away the IME's composition state —
 *     a half-typed 한글 syllable disappears mid-word. It is also uncontrolled,
 *     so React never writes a value back into an input that is composing.
 *   - **The centre swaps between the analysis screen and the map; everything
 *     around it stays put.** The left and right panels are mounted for every
 *     state, which is what keeps the right panel's request box (and its own
 *     composition state) alive across the end of a run.
 *   - **The graph is fetched when the run finishes, not polled.** The run
 *     writes its rows before it writes `run.completed`, so the event is the
 *     signal that one read will now return everything.
 */

export type WorkspaceProject = {
  id: string;
  displayName: string;
  source: "github" | "upload";
  repoOwner: string | null;
  repoName: string | null;
};

export type WorkspaceProps = {
  project: WorkspaceProject;
  /** Rendered on the server, so the map is on screen in the first paint. */
  initialView: GraphView;
  /** A run the server found already in flight. This is what survives a refresh. */
  activeRunId: string | null;
  /**
   * The account row, rendered by the page that already holds the session and
   * dropped into the foot of the file list.
   *
   * A node rather than the session itself, so this shell never learns who is
   * signed in — it is handed something to put in a corner. That keeps the one
   * client component on this screen free of anything worth protecting.
   */
  account?: ReactNode;
  /**
   * The models this installation has a key for, default first.
   *
   * Computed on the server by the page, because deciding it needs the
   * environment and `env.ts` throws for anything that imports it without a full
   * one. Passed through untouched: the shell does not choose a model, it hands
   * the panel the list of ones that exist.
   */
  models?: readonly ModelChoice[];
};

const startedSchema = z.object({ runId: z.uuid(), started: z.boolean() });
const messageSchema = z.object({ message: z.string() });

const GENERIC_START_ERROR = "지금은 시작하지 못했어요. 잠시 후에 다시 시도해 주세요.";
const OFFLINE_START_ERROR = "연결이 끊겼어요. 인터넷 연결을 확인하고 다시 시도해 주세요.";
const RELOAD_FAILED = "새로 그린 지도를 불러오지 못했어요. 페이지를 새로고침해 주세요.";

type StartError = { status: number; message: string };

export function Workspace({
  project,
  initialView,
  activeRunId,
  account,
  models,
}: WorkspaceProps) {
  const [view, setView] = useState<GraphView>(initialView);
  const [runId, setRunId] = useState<string | null>(activeRunId);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<StartError | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [locks, setLocks] = useState<LockMap>({});
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * What the map is grouped by.
   *
   * Two pieces of state, not one. `wanted` is what the person asked for and it
   * is kept even while it cannot be drawn — re-read a project, let Pass 2 name
   * its first feature, and the 기능 map they asked for once comes back on its
   * own. `grouping` is what is actually drawable right now; `resolveGrouping`
   * falls back to 폴더, which cannot fail.
   */
  const [wantedGrouping, setWantedGrouping] = useState<Grouping>(DEFAULT_GROUPING);

  /** The file being looked at, if any. Null is the normal state. */
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  const stream = useAnalysisStream(project.id, runId);

  // Both consumers want the same numbers under different names; the translation
  // is one pure function so nobody has to remember which is which.
  const progress = useMemo(() => toAnalysisProgress(stream), [stream]);
  const runProgress = useMemo(() => toRunProgress(stream), [stream]);

  /**
   * The finished run's graph, fetched once.
   *
   * Before the arrival dwell is over, so the map is already on hand when the
   * screen hands over rather than appearing a beat later.
   */
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!runId || !stream.finished || stream.failure) return;
    if (loaded.current === runId) return;
    loaded.current = runId;

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${project.id}/graph`, {
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error(String(response.status));
        const next: unknown = await response.json();
        if (cancelled) return;
        // The server wrote this from the same `GraphView` type the page used,
        // so it is shape-checked at the one place it can be: the boundary.
        setView(next as GraphView);
        setReloadError(null);
      } catch {
        if (!cancelled) setReloadError(RELOAD_FAILED);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [project.id, runId, stream.finished, stream.failure]);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    setReloadError(null);

    try {
      const response = await fetch(`/api/projects/${project.id}/analyze`, {
        method: "POST",
      });

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Handled by the generic message below.
      }

      if (response.status === 202) {
        const accepted = startedSchema.safeParse(body);
        if (!accepted.success) {
          setStartError({ status: 0, message: GENERIC_START_ERROR });
          return;
        }
        loaded.current = null;
        setRunId(accepted.data.runId);
        return;
      }

      // Every refusal this endpoint returns is already a plain Korean sentence
      // written for this person — an uploaded project is asked for the folder
      // again, a signed-out one is asked to sign in. Showing it is the job.
      const told = messageSchema.safeParse(body);
      setStartError({
        status: response.status,
        message: told.success ? told.data.message : GENERIC_START_ERROR,
      });
    } catch {
      setStartError({ status: 0, message: OFFLINE_START_ERROR });
    } finally {
      setStarting(false);
    }
  }, [project.id]);

  const onLockChange = useCallback((id: string, lock: ConnectionLock) => {
    setLocks((previous) => ({ ...previous, [id]: lock }));
  }, []);

  const onSelect = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  // The left panel lights with the same word the map does. Its own index,
  // because the map's lives inside the canvas component — both are rebuilt only
  // when the items change, and cost well under a millisecond at this size.
  const beamIndex = useMemo(() => buildBeamIndex(view.items), [view.items]);
  const beam = useMemo(
    () => (query.trim() === "" ? IDLE_BEAM : runBeam(beamIndex, query)),
    [beamIndex, query],
  );

  const groupings = useMemo(
    () => groupingOptions(view.items, view.connections),
    [view.items, view.connections],
  );
  const grouping = resolveGrouping(groupings, wantedGrouping);

  /*
   * What each thing is for, in one sentence, computed once for the screen.
   *
   * Here rather than in each panel so the file list and the map can never
   * describe the same file differently — and because the list is given items
   * without connections, and would otherwise have to claim that nothing in the
   * project is used by anything.
   */
  const descriptions = useMemo(() => describeAll(view), [view]);

  /**
   * Open a file from wherever someone pointed at it.
   *
   * One handler for the left list, the map and the right panel, so all three
   * open the same thing the same way — and so a piece of a file always opens
   * its file at its own lines rather than at the top.
   */
  const openItem = useCallback(
    (id: string) => {
      const item = view.items.find((candidate) => candidate.id === id);
      if (!item) return;
      const target = previewTargetFor(item);
      // A package or a feature has no file behind it. Nothing opens, and
      // nothing pretends to.
      if (!target) return;
      setPreview(target);
    },
    [view.items],
  );

  const running = runId !== null;
  const hasGraph = view.items.length > 0;

  /*
   * How the workspace is divided, and which pane has the screen.
   *
   * The container is measured inside the drag, by the divider, from its own
   * parent — the shell holds no ref for it. A drag lasts a second and the
   * container cannot change size during one, so a ResizeObserver here would
   * maintain a number all session to be read twice; and a ref read from a
   * function built during render is what React 19 rejects outright.
   */
  const { layout, setColumns, setHistory, toggleMaximized, reset } =
    usePaneLayout();

  const dragColumn =
    (index: 0 | 1) => (deltaPx: number, containerPx: number) =>
      setColumns(resizeColumns(layout.columns, index, deltaPx, containerPx));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-edge px-4 py-2.5">
        <Link
          href="/app"
          className="shrink-0 text-[13px] text-said-faint transition-colors hover:text-said-soft"
        >
          ← 내 프로젝트
        </Link>
        {/*
          Where the project came from belongs under its name, not across the
          header. On the right it was a second thing competing with the pane
          control for the same corner, and the two say nothing to each other —
          one is a fact about the project, the other is a control for the
          screen. Under the title it reads as the subtitle it always was.
        */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold tracking-[-0.02em]">
            {project.displayName}
          </h1>
          <p className="truncate text-[11px] text-said-faint">
            {project.source === "upload" ? (
              "내 컴퓨터에서 올린 폴더"
            ) : (
              <span className="font-mono">
                {project.repoOwner}/{project.repoName}
              </span>
            )}
          </p>
        </div>

        {/* The right side is the pane control, and only that. */}
        <PaneChips maximized={layout.maximized} onToggle={toggleMaximized} />

        {!running && hasGraph ? (
          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="shrink-0 rounded-lg border border-edge-lit px-3 py-1.5 text-[13px] text-said-soft transition-colors hover:text-said disabled:opacity-55"
          >
            {starting ? "시작하는 중…" : "다시 읽기"}
          </button>
        ) : null}
      </header>

      {/*
        The body is the flex column that the row and the bottom band divide
        between them, and it is what both dividers measure against.
      */}
      <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="grid min-h-0"
        style={{
          gridTemplateColumns: columnTemplate(layout),
          // The row gives up its height entirely when the band is the pane
          // filling the screen. `flex` rather than a class because both values
          // are computed, and a class string built from state is a class
          // Tailwind never generates.
          flex: layout.maximized === "history" ? "0 0 0px" : "1 1 0px",
        }}
      >
        {/*
          Each pane is wrapped rather than placed directly in the grid. A pane
          at zero width still has its contents — that is the whole point, it
          keeps its scroll and its half-typed search — and without a wrapper
          that clips, those contents would spill across the pane that took the
          screen. The panels themselves are not touched: a pane should not have
          to know it is in a resizable layout.
        */}
        {/*
          `grid`, not `flex`, and that one word is the whole fix.

          A flex row stretches its children on the cross axis only, so the panel
          inside kept its content width and the rest of the column was simply
          empty — drag a divider wider and you got a gap rather than a wider
          panel. A single grid item stretches on BOTH axes by default, so the
          panel is always exactly the width the divider gave it. Doing it here
          rather than by adding `w-full` inside each panel keeps the panels
          unaware that they are in a resizable layout, which is what lets them
          be edited independently.
        */}
        {/*
          Two rows: the list, then the account strip pinned under it. The list
          takes `minmax(0, 1fr)` so it is the part that shrinks when the pane
          is dragged narrow — a strip that gave up its height instead would
          disappear at exactly the width where a person is least able to find
          anything else.
        */}
        <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
          <PlacesPanel
            items={view.items}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpen={openItem}
            beam={beam}
            loading={running}
            descriptions={descriptions}
          />
          {account}
        </div>

        <Divider
          orientation="vertical"
          label="파일과 지도 사이 너비"
          valueNow={layout.columns[0] * 100}
          onDelta={dragColumn(0)}
          onReset={reset}
        />

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-3 border-b border-edge px-4 py-2">
            {/*
              The beam. Uncontrolled on purpose: React never writes a value back
              into this input, so a 한글 syllable that is mid-composition cannot
              be replaced by what React last saw. It is also mounted for every
              state of the centre, including while a run is going, so that it is
              never remounted under a different parent (section 5, warning 2).
            */}
            <input
              ref={inputRef}
              type="search"
              defaultValue=""
              onChange={(event) => setQuery(event.currentTarget.value)}
              disabled={running || !hasGraph}
              placeholder={
                running ? "다 읽으면 찾아볼 수 있어요" : "찾고 싶은 것을 적어 보세요"
              }
              aria-label="지도에서 찾기"
              className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 py-1.5 text-[13px] text-said placeholder:text-said-faint focus:border-edge-lit focus:outline-none disabled:opacity-55"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  if (inputRef.current) inputRef.current.value = "";
                  setQuery("");
                }}
                className="shrink-0 text-[12px] text-said-faint transition-colors hover:text-said-soft"
              >
                지우기
              </button>
            ) : null}

            {/*
              Beside the beam, in the same toolbar, and mounted for every state
              of the centre — the same reason the beam is. Opening its panel
              touches nothing else in this row, so a 한글 syllable being typed
              into the beam survives it.
            */}
            <GroupingControl
              options={groupings}
              value={grouping}
              onChange={setWantedGrouping}
              disabled={running || !hasGraph}
            />
          </div>

          <div className="relative min-h-0 flex-1">
            {running ? (
              <AnalysisScreen
                projectName={project.displayName}
                source={project.source}
                progress={progress}
                onArrive={() => setRunId(null)}
                // Offered for an uploaded folder too, now that one can be read
                // again from the copy we kept. The browser cannot tell whether
                // this particular project has that copy — it is a row count —
                // so the attempt is offered and the server answers with a
                // sentence when there is nothing to read.
                onRetry={start}
              />
            ) : hasGraph ? (
              <DistrictMap
                items={view.items}
                connections={view.connections}
                query={query}
                grouping={grouping}
                selectedId={selectedId}
                onSelect={onSelect}
                onOpen={openItem}
                className="absolute inset-0"
              />
            ) : (
              <EmptyCentre
                failed={view.lastRun?.status === "failed"}
                error={view.lastRun?.error ?? null}
                source={project.source}
                starting={starting}
                onStart={start}
              />
            )}

            {startError ? (
              <div
                role="alert"
                className="absolute inset-x-4 bottom-4 rounded-xl border border-edge bg-ink-raised p-4"
              >
                <p className="text-[13px] leading-[1.7] text-c4">{startError.message}</p>
                {startError.status === 401 ? (
                  <Link
                    href="/sign-in"
                    className="mt-2 inline-block text-[13px] font-medium text-lamp underline underline-offset-4"
                  >
                    다시 로그인하기
                  </Link>
                ) : null}
                {startError.status === 400 && project.source === "upload" ? (
                  <Link
                    href="/app"
                    className="mt-2 inline-block text-[13px] font-medium text-lamp underline underline-offset-4"
                  >
                    폴더 다시 올리기
                  </Link>
                ) : null}
              </div>
            ) : null}

            {reloadError ? (
              <p
                role="alert"
                className="absolute inset-x-4 bottom-4 rounded-xl border border-edge bg-ink-raised p-4 text-[13px] leading-[1.7] text-c4"
              >
                {reloadError}
              </p>
            ) : null}
          </div>
        </section>

        <Divider
          orientation="vertical"
          label="지도와 연결 사이 너비"
          valueNow={(layout.columns[0] + layout.columns[1]) * 100}
          onDelta={dragColumn(1)}
          onReset={reset}
        />

        {/*
          `grid`, not `flex`, and that one word is the whole fix.

          A flex row stretches its children on the cross axis only, so the panel
          inside kept its content width and the rest of the column was simply
          empty — drag a divider wider and you got a gap rather than a wider
          panel. A single grid item stretches on BOTH axes by default, so the
          panel is always exactly the width the divider gave it. Doing it here
          rather than by adding `w-full` inside each panel keeps the panels
          unaware that they are in a resizable layout, which is what lets them
          be edited independently.
        */}
        <div className="grid min-h-0 min-w-0 overflow-hidden">
        <RightPanel
          // Always the real view, even when it is empty: an empty graph is an
          // answer the panel knows how to say, and `null` would show "loading"
          // beside a project nobody has asked us to read yet.
          view={view}
          selectedId={selectedId}
          run={running ? runProgress : null}
          locks={locks}
          onLockChange={onLockChange}
          onSelect={onSelect}
          onRetry={start}
          onOpen={openItem}
          // The centre is already showing the checklist while a run goes; the
          // same five steps twice reads as two things happening.
          showRunSteps={false}
          models={models}
        />
        </div>
      </div>

      {/*
        The band along the bottom, and the divider that gives it room.
        Hidden entirely while another pane has the screen: a strip that stays
        visible under a maximised pane is the maximised pane not actually
        filling anything.
      */}
      {layout.maximized === null || layout.maximized === "history" ? (
        <Divider
          orientation="horizontal"
          label="변경 기록 높이"
          valueNow={(1 - layout.history) * 100}
          onDelta={(deltaPx, containerPx) =>
            setHistory(resizeHistory(layout.history, deltaPx, containerPx))
          }
          onReset={reset}
        />
      ) : null}

      <div
        className="flex items-center gap-3 overflow-hidden border-t border-edge px-4 py-1.5 text-[11px] text-said-faint"
        style={{
          flex:
            layout.maximized === "history"
              ? "1 1 0px"
              : layout.maximized === null
                ? `0 0 ${layout.history * 100}%`
                : "0 0 0px",
        }}
      >
        <span>변경 기록</span>
        <span aria-hidden className="flex items-center gap-1.5 opacity-40">
          <span className="h-1.5 w-1.5 rounded-full bg-said-faint" />
          <span className="h-px w-5 bg-edge-lit" />
          <span className="h-1.5 w-1.5 rounded-full bg-said-faint" />
          <span className="h-px w-5 bg-edge-lit" />
          <span className="h-1.5 w-1.5 rounded-full bg-said-faint" />
        </span>
        <span>아직 준비 중인 자리예요</span>
      </div>
      </div>

      {preview ? (
        <FilePreview
          projectId={project.id}
          source={project.source}
          repo={
            project.repoOwner && project.repoName
              ? { owner: project.repoOwner, name: project.repoName }
              : null
          }
          target={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}

    </div>
  );
}

function EmptyCentre({
  failed,
  error,
  source,
  starting,
  onStart,
}: {
  failed: boolean;
  error: string | null;
  source: "github" | "upload";
  starting: boolean;
  onStart: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="max-w-[46ch] text-center">
        <h2 className="display-kr text-[21px]">
          {failed ? "지도를 그리다가 멈췄어요" : "아직 읽지 않은 프로젝트예요"}
        </h2>
        <p className="mt-3 text-[14px] leading-[1.8] text-said-soft">
          {failed && error
            ? error
            : source === "upload"
              ? "코드를 한 번 읽어서 앱의 지도를 그릴게요. 올려주신 파일은 함께 보관해서, 나중에 열어보거나 다시 읽을 때 폴더를 또 고르지 않으셔도 돼요."
              : "코드를 한 번 읽어서 앱의 지도를 그릴게요. 파일과 그 사이의 연결만 저장하고, 코드 자체는 보관하지 않아요."}
        </p>

        {/*
          Offered whatever the project's source is. An uploaded folder used to
          be a dead end here — the sentence in this slot asked the person to go
          and find the folder again — and it no longer is, because the files we
          kept are enough to read it. A project uploaded before we kept anything
          still cannot be, and the server says so in a sentence when it happens
          rather than the button quietly disappearing for reasons only we know.
        */}
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="mt-6 rounded-lg bg-paper px-5 py-2.5 text-[14px] font-semibold text-ink transition-colors hover:bg-lamp disabled:opacity-55"
        >
          {starting ? "시작하는 중…" : failed ? "다시 해보기" : "지도 그리기"}
        </button>
      </div>
    </div>
  );
}
