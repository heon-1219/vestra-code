"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { z } from "zod";

import { useAnalysisStream, type AnalysisCoverage } from "@/hooks/use-analysis-stream";
import { useAsk } from "@/hooks/use-ask";
import { explainKey, useExplain } from "@/hooks/use-explain";
import { usePromptMaker } from "@/hooks/use-prompt";
import { locksShown, type ScopeOpened } from "@/components/workspace/prompt/scope-open";
import { describeAll } from "@/lib/graph/describe";
import type { GraphView } from "@/lib/graph/view";

import { AnalysisScreen } from "./analysis-screen";
import { describeCoverage } from "./coverage";
import { useFlow } from "./flow/use-flow";
import { HistoryBand, type ChangeLight } from "./history/history-band";
import { DistrictMap } from "./map/district-map";
import { beamOf, buildBeamIndex, runBeam, IDLE_BEAM } from "./map/beam";
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
  PANE_PANEL_ID,
  PaneChips,
  resizeColumns,
  resizeHistory,
  usePaneLayout,
  usePhoneLayout,
  usePhonePane,
  type PaneId,
  type PaneLayout,
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

  /**
   * What the model did not open in the run that drew the map on screen.
   *
   * Held here rather than read off the stream where it is used, because
   * `onArrive` drops the run id and the stream's state goes with it — which
   * would take this sentence off the screen at the exact moment the person
   * starts reading the map it qualifies. Cleared when a new reading is asked
   * for, so the caveat can never outlive the map it was true of.
   */
  const [coverage, setCoverage] = useState<AnalysisCoverage | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [locks, setLocks] = useState<LockMap>({});
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The change from the 변경 기록 band that is lighting the map, if any.
   *
   * Owned here rather than in the band because the map has **one** light and
   * two switches for it — the search box in this toolbar and a change picked
   * in the band — and only one may be on. Keeping both in one component is
   * what makes that enforceable: picking a change empties the box, typing in
   * the box drops the change, and neither can be left set and invisible. See
   * `beamOf` for why a change's places are the beam rather than a fourth way
   * of dimming the map.
   */
  const [change, setChange] = useState<ChangeLight | null>(null);

  const onLight = useCallback((light: ChangeLight | null) => {
    setChange(light);
    if (!light) return;
    // The input is uncontrolled, so its value is cleared the same way the
    // 지우기 button clears it: written once, never written back during render,
    // so a 한글 syllable being composed is never replaced mid-word.
    if (inputRef.current) inputRef.current.value = "";
    setQuery("");
  }, []);

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

  /*
   * Asking, and watching the answer be found.
   *
   * Owned here rather than inside the panel because two things need it: the
   * panel says what is happening, and the map lights the walk it is happening
   * on. A hook inside the panel would leave the map with no way to see the
   * trail short of passing it back up, which is this, with more steps.
   */
  const { session: walk, ask } = useAsk(project.id);

  /*
   * 프롬프트 만들기 and 설명하기.
   *
   * Here beside `useAsk` rather than in the panel, for the rule the panel
   * keeps about its results: one screen, one meaning. Only the component that
   * owns all three can decide which one is in front.
   *
   * `front` is that decision, and it is the only thing starting another answer
   * changes. Nothing is cleared: an investigation still running when the person
   * pressed 설명하기 kept running and kept its tokens, where it used to be
   * aborted and lost (D167). A hidden result comes back when the person
   * picks its mode again (`onModeChange` below).
   *
   * `front === "explain"` is the free half's switch. It is not a request —
   * nothing is fetched — it says the panel should explain whatever is
   * selected, and it stays on as the selection moves, because explaining the
   * next thing costs nothing. `explainAsked` is whatever was typed alongside,
   * **with the place it was typed about**: it goes with that place's deep read
   * and no other, where it used to ride along with the deep read of whatever
   * was clicked next.
   */
  const promptMaker = usePromptMaker(project.id);
  const { clear: clearPrompt } = promptMaker;
  const { sessions: deepExplains, explain } = useExplain(project.id);
  const [front, setFront] = useState<"ask" | "prompt" | "explain" | null>(null);
  const [explainAsked, setExplainAsked] = useState<{ itemId: string | null; text: string }>({
    itemId: null,
    text: "",
  });
  const questionFor = useCallback(
    (itemId: string) => (explainAsked.itemId === itemId ? explainAsked.text : ""),
    [explainAsked],
  );

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
    /*
     * The shortfall is deliberately NOT cleared here.
     *
     * It reads "…그래서 열어 보지 못한 파일 안의 연결은 지도에 없어요" — a
     * statement about the map currently on screen, not about the run being
     * started. That map is still standing, and stays standing if this run
     * fails, so the sentence stays true for exactly as long as the thing it
     * describes is in front of the person.
     *
     * Clearing it here cost nothing when the run succeeded — `onArrive` hands
     * over the new run's coverage, or null where there is none — and on a
     * failed run it silently deleted a true caveat from a map that still had
     * it. The band's re-read button does not clear it either; this is the two
     * paths agreeing, and agreeing on the more correct answer.
     */

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

  /*
   * The place an "only here" answer opened, for the prompt that answer made.
   *
   * Not written into `locks`. It used to be, and a lock map is remembered by id
   * for the whole visit, so the place stayed open for every later prompt that
   * listed it — including an "everywhere" prompt about the same selection,
   * which then read "열어 둔 1개는 같이 고쳐도 된다고 했어요" about a switch
   * the person never touched (1,165 of 1,180 such choices on this repository's
   * map). It is shown on that place's switch while that prompt is in front and
   * its selection is selected, so the list the person sees still says what the
   * agent reads, and it ends with the next request or with a click on that
   * switch, which is the person taking the switch back (D172).
   */
  const [scopeOpened, setScopeOpened] = useState<ScopeOpened | null>(null);

  const onLockChange = useCallback((id: string, lock: ConnectionLock) => {
    setScopeOpened((opened) => (opened?.placeId === id ? null : opened));
    setLocks((previous) => ({ ...previous, [id]: lock }));
  }, []);

  // The left panel lights with the same word the map does. Its own index,
  // because the map's lives inside the canvas component — both are rebuilt only
  // when the items change, and cost well under a millisecond at this size.
  const beamIndex = useMemo(() => buildBeamIndex(view.items), [view.items]);

  /*
   * 흐름 따라가기 — the path from one place, and the player that reveals it.
   *
   * Owned here rather than inside the panel for the same reason `useAsk` is:
   * **two** things need it. The panel reads the path as a list of steps, and
   * the map lights the same path as a picture, and a hook inside the panel
   * would leave the map with no way to see it short of handing it back up.
   *
   * It is given the beam index this toolbar already built rather than building
   * a second one. `qa/tools.ts` states the rule — the beam that answers a typed
   * question has to be the beam that lights the map, or the product answers the
   * user's own words differently from the picture they are looking at — and two
   * indexes over the same items would be the first step towards exactly that.
   *
   * Nothing here is in flight: the walk is pure arithmetic over `view`, which
   * the browser is already holding. No model, no network, no loading state.
   */
  const flow = useFlow(view, beamIndex);
  // Pulled out so the selection handler depends on one stable callback rather
  // than on the whole controls object, which is rebuilt every render.
  const { clear: clearFlow, follow: followFlow, ask: askFlow } = flow;

  /*
   * Starting one kind of answer puts it in front of the others.
   *
   * The panel shows one account at a time — two answers to two different
   * requests stacked in one column is what `scene.ts` and §6 both refuse — and
   * the map has one light. The others are hidden, not ended: an answer being
   * found, a prompt whose goal a model restated and a deep read the person
   * paid for all cost something, and each comes back (D167). A flow is the
   * one thing ended, because it costs nothing to walk again and while one is
   * showing it IS the panel.
   */
  const onlyThis = useCallback(
    (keep: "ask" | "prompt" | "explain" | "flow") => {
      if (keep !== "flow") clearFlow();
      setFront(keep === "flow" ? null : keep);
    },
    [clearFlow],
  );

  /*
   * Picking a mode brings back what that mode was showing, if anything is kept.
   *
   * 물어보기 and 프롬프트 만들기 only: their results cost a model's time and are
   * not asked for again by pressing the button with an empty box, which is how
   * 설명하기 comes back. Nothing is brought back that is not there — picking a
   * mode with no result of its own leaves the panel as it was.
   */
  const panelLocks = useMemo(
    () => locksShown(locks, scopeOpened, { promptInFront: front === "prompt", selectedId }),
    [locks, scopeOpened, front, selectedId],
  );

  const promptKept = promptMaker.phase !== null;
  const onModeChange = useCallback(
    (mode: "ask" | "prompt" | "explain" | "flow") => {
      if (mode === "ask" && walk) setFront("ask");
      else if (mode === "prompt" && promptKept) setFront("prompt");
    },
    [walk, promptKept],
  );

  const onSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      /*
       * Choosing a place ends the flow that was showing.
       *
       * One screen, one meaning. While a flow is on, the map's lighting IS the
       * flow and the panel IS the flow, so a click that selected something
       * without clearing it would leave the person looking at a path and a
       * panel about something else, with nothing saying which of the two their
       * click produced. The flow's own rows do not go through here — they move
       * the player instead — so this only fires for a real change of subject.
       */
      if (id !== null) clearFlow();
    },
    [clearFlow],
  );
  /*
   * One light, two switches — and the file list lights with the same one the
   * map does, whichever switch is on.
   *
   * A change that touched nothing the map holds is not a switch being on. It
   * is the ordinary answer on a project whose analyzer only places files — a
   * commit to a README, a lockfile, a config — and it hands the light back to
   * the box rather than taking it away and lighting nothing. The band says the
   * set was empty in words; the lighting does not try to.
   */
  const changeLit = change !== null && change.ids.size > 0;
  const beam = useMemo(
    () =>
      changeLit && change
        ? beamOf(change.ids)
        : query.trim() === ""
          ? IDLE_BEAM
          : runBeam(beamIndex, query),
    [changeLit, change, beamIndex, query],
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
  /** Null whenever there is nothing to admit, which is most runs. */
  const missed = describeCoverage(coverage);

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

  /*
   * The phone shape, and the one rule that decides how it is built.
   *
   * Three columns and a canvas do not fit in 375px — measured, before this:
   * the canvas came out **211 × 668**, six controls sat past the right edge,
   * and 이 프로젝트, 많이 쓰이는 것 and 프롬프트 만들 were all cut mid-word. So below
   * `md` the workspace shows one pane at a time, chosen by the chips that
   * already existed for maximising one.
   *
   * It is the SAME JSX. Nothing is rendered conditionally, nothing moves to a
   * different parent, and the three panes that are not on screen are at zero
   * width rather than unmounted — which is the constraint the whole module was
   * written around (UI_DIRECTION §5.2): the request box in the 연결 pane holds a
   * half-typed 한글 syllable, and a React component that changes parent is
   * unmounted and remounted with its IME composition thrown away. Switching to
   * 지도 and back must not eat a syllable, so switching cannot be a remount.
   *
   * Which is also why the two templates are handed over as custom properties
   * and chosen by a media query in CSS, rather than by branching on
   * `phone` here: an inline `grid-template-columns` would be the server's
   * guess about a width the server does not have, and the first paint on every
   * phone would be the three-column layout for one frame.
   */
  const phone = usePhoneLayout();
  const [phonePane, selectPhonePane] = usePhonePane();

  /** The layout as the phone sees it: one pane filling the workspace, always. */
  const phoneLayout: PaneLayout = { ...layout, maximized: phonePane };

  /** The pane actually on screen right now, whichever shape we are in. */
  const shownPane: PaneId | null = phone ? phonePane : layout.maximized;

  /**
   * A pane nobody can see should not be reachable by the Tab key.
   *
   * Only on a phone. Above the breakpoint a maximised pane's neighbours are
   * also at zero width, but that is a state someone chose for a minute and the
   * keyboard is how they chose it; on a phone the other three panes are not a
   * state, they are simply elsewhere, and tabbing into a 0px 연결 panel to find
   * a question box you cannot see is not a thing to leave in.
   *
   * `inert` rather than unmounting, for the reason above: it takes the subtree
   * out of the tab order and out of the accessibility tree without touching a
   * single piece of its state.
   */
  const hidden = (pane: PaneId) => phone && phonePane !== pane;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col border-b-[0.8px] border-edge">
        <div className="flex items-center gap-2 px-3 py-1.5 md:gap-4 md:px-4 md:py-2.5">
        {/*
          44px tall on a phone and the same 13px line it always was above `md`.
          The padding is negative-margined back out so the larger target does
          not move the link away from the screen edge it is anchored to — a
          back control that sits 8px in from the corner on a phone is a back
          control your thumb has to aim at.
        */}
        <Link
          href="/app"
          className="-mx-2 flex min-h-11 shrink-0 items-center rounded-lg px-2 text-[13px] text-said-faint transition-colors hover:text-said-soft md:mx-0 md:min-h-0 md:px-0"
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
          {/*
            `display-kr`, the same voice the panel's headline and the band's
            title now use, so the project's name is set the way this product
            sets a name rather than in a weight and a tracking written here.
          */}
          <h1 className="display-kr truncate text-[15px]">{project.displayName}</h1>
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
            className="flex min-h-11 shrink-0 items-center rounded-lg border border-edge-lit px-3 py-1.5 text-[13px] text-said-soft transition-colors hover:border-said-faint hover:bg-ink-raised hover:text-said disabled:opacity-55 md:min-h-0"
          >
            {starting ? "시작하는 중…" : "다시 읽기"}
          </button>
        ) : null}
        </div>

        {/*
          The same four words as the chips above, in the shape a phone needs.

          Rendered always and hidden by CSS rather than by `phone`, so the
          markup the server sends is already right for whichever width opens
          it — the grid below chooses its shape the same way, and the two have
          to agree in the first frame or the workspace changes shape once after
          hydration, under the finger of someone who has just tapped.
        */}
        <PaneChips maximized={phonePane} onToggle={selectPhonePane} phone />
      </header>

      {/*
        The body is the flex column that the row and the bottom band divide
        between them, and it is what both dividers measure against.
      */}
      <div className="flex min-h-0 flex-1 flex-col">
      <div
        /*
          Both shapes are handed over at once and CSS picks one.

          `grid-template-columns` is set by a utility reading a custom property
          rather than written into `style`, because an inline property beats
          every class and there would then be no way for a media query to have
          the last word. The values are still computed here — they are
          fractions from a drag — so they travel as `--pane-cols` and
          `--pane-cols-phone`, and the `max-md:` variant swaps which one is
          read. Nothing about the layout is decided by JavaScript that knows
          the width, which is what keeps the first paint on a phone from being
          the desktop layout.
        */
        className="grid min-h-0 [grid-template-columns:var(--pane-cols)] [flex:var(--pane-row-flex)] max-md:[grid-template-columns:var(--pane-cols-phone)] max-md:[flex:var(--pane-row-flex-phone)]"
        style={
          {
            "--pane-cols": columnTemplate(layout),
            "--pane-cols-phone": columnTemplate(phoneLayout),
            // The row gives up its height entirely when the band is the pane
            // filling the screen.
            "--pane-row-flex":
              layout.maximized === "history" ? "0 0 0px" : "1 1 0px",
            "--pane-row-flex-phone":
              phonePane === "history" ? "0 0 0px" : "1 1 0px",
          } as CSSProperties
        }
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
        <div
          id={PANE_PANEL_ID.places}
          role={phone ? "tabpanel" : undefined}
          aria-label={phone ? "파일" : undefined}
          inert={hidden("places")}
          className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden"
        >
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
          collapsed={shownPane !== null}
        />

        <section
          id={PANE_PANEL_ID.map}
          role={phone ? "tabpanel" : undefined}
          aria-label={phone ? "지도" : undefined}
          inert={hidden("map")}
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          {/*
            One row above `md`, two below it.

            At 375px the beam and 묶는 기준 together want about 330px of the 343
            available, which leaves the search box 150px — narrower than the
            sentence it asks for. Wrapping is not truncation: both controls keep
            their full label and the row grows by 44px, on a screen that has the
            height because it is no longer spending it on two other columns.
          */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b-[0.8px] border-edge px-3 py-2 md:flex-nowrap md:px-4">
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
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                // Typing takes the light back from the band. Done here rather
                // than by a precedence rule in the map, so a picked change is
                // never left set and unlit — which would look like a search
                // that did nothing.
                setChange(null);
              }}
              disabled={running || !hasGraph}
              placeholder={
                running ? "다 읽으면 찾아볼 수 있어요" : "찾고 싶은 것을 적어 보세요"
              }
              aria-label="지도에서 찾기"
              /*
                `grow shrink basis-0` rather than `flex-1`, so that
                `max-md:basis-full` has a basis of its own to override — the
                `flex` shorthand writes `flex-basis: 0%` and which of the two
                declarations wins would then be a question about the order
                Tailwind happens to emit them in.

                Full width on a phone because the alternative is 146px at
                320px, which cuts "찾고 싶은 것을 적어 보세요" in half — and the
                placeholder is the only thing on this screen that says what the
                beam is for.
              */
              className="min-w-0 grow shrink basis-0 rounded-lg border border-edge bg-ink px-3 py-1.5 text-[13px] text-said transition-colors placeholder:text-said-faint hover:border-edge-lit focus:border-lamp-dim focus:outline-none disabled:opacity-55 max-md:min-h-11 max-md:basis-full"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  if (inputRef.current) inputRef.current.value = "";
                  setQuery("");
                }}
                className="flex min-h-11 shrink-0 items-center rounded-lg px-2 text-[12px] text-said-faint transition-colors hover:text-said-soft md:min-h-0 md:px-0"
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

          {/*
            How much of this map the model actually looked at.

            On the map rather than only on the screen that announced it, because
            this is the room where the wrong conclusion gets drawn: a file with
            no connections drawn on it reads as a file connected to nothing, and
            the person cannot open the code to find out which it is. It stays
            for as long as the map it qualifies is on screen, and it is absent
            entirely — no empty row, no reassuring line — whenever the model
            opened everything or there was no model to open anything.
          */}
          {!running && hasGraph && missed ? (
            /*
              The caveat is marked as a caveat rather than as a third toolbar.
              It sat between two `border-b` rules in the same colour, so the one
              qualification on the map read as another strip of chrome. The rail
              gives it an edge of its own; `lamp-dim` because this is the
              product speaking about the limits of what it did, which is the
              same voice the focus ring and the send button use.
            */
            <div className="shrink-0 border-b-[0.8px] border-edge bg-ink-raised/40 px-4 py-2.5 shadow-[inset_2px_0_0_var(--color-lamp-dim)]">
              <p className="text-[12px] leading-[1.7] text-said-soft tabular-nums text-pretty">
                <span className="text-said">{missed.said}</span> {missed.because}
              </p>
              <p className="mt-0.5 text-[12px] leading-[1.7] text-said-faint text-pretty">
                {missed.caution}
              </p>
            </div>
          ) : null}

          <div className="relative min-h-0 flex-1">
            {running ? (
              <AnalysisScreen
                projectName={project.displayName}
                source={project.source}
                progress={progress}
                onArrive={() => {
                  /*
                   * Taken out of the stream on the way past.
                   *
                   * Dropping the run id drops the stream's state with it, and
                   * this is the one fact on it that is still true of the map
                   * the person is about to read. Handed over here rather than
                   * watched from an effect, because the handover is exactly
                   * when it changes owners — and it is reached only for a run
                   * that completed, so a failed run cannot leave its shortfall
                   * over the older map that is still standing.
                   */
                  setCoverage(stream.coverage);
                  setRunId(null);
                }}
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
                // Only once the walk is known. While the loop is still working
                // the map stays as it was: lighting places one at a time as
                // they arrive would show a path being walked that may yet turn
                // out to be a dead end, and the person cannot tell the
                // difference until it stops.
                trail={front === "ask" ? (walk?.trail ?? null) : null}
                // The flow being followed, trimmed to the steps the reader has
                // been shown. It takes the lighting over from both the walk and
                // the selection while it is set, and `centreOn` keeps the step
                // they are on in view — only when it is off screen, which at
                // the resting zoom is almost never.
                flow={flow.session ? flow.trail : null}
                centreOn={flow.session ? flow.here : null}
                // The places a picked change touched. The same light the beam
                // is, aimed by the band instead of by the box.
                highlight={change?.ids ?? null}
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
                className="hairline absolute inset-x-4 bottom-4 rounded-xl bg-ink-raised p-4 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.9)]"
              >
                <p className="text-[13px] leading-[1.7] text-c4 text-pretty">{startError.message}</p>
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
                className="hairline absolute inset-x-4 bottom-4 rounded-xl bg-ink-raised p-4 text-[13px] leading-[1.7] text-c4 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.9)] text-pretty"
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
          collapsed={shownPane !== null}
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
        <div
          id={PANE_PANEL_ID.panel}
          role={phone ? "tabpanel" : undefined}
          aria-label={phone ? "연결" : undefined}
          inert={hidden("panel")}
          className="grid min-h-0 min-w-0 overflow-hidden"
        >
        <RightPanel
          // Always the real view, even when it is empty: an empty graph is an
          // answer the panel knows how to say, and `null` would show "loading"
          // beside a project nobody has asked us to read yet.
          view={view}
          selectedId={selectedId}
          run={running ? runProgress : null}
          locks={panelLocks}
          onLockChange={onLockChange}
          onSelect={onSelect}
          onRetry={start}
          onOpen={openItem}
          // The centre is already showing the checklist while a run goes; the
          // same five steps twice reads as two things happening.
          showRunSteps={false}
          models={models}
          /*
           * The model and the effort travel with the question, exactly as the
           * box sent them. `null` means nothing is connected on this machine,
           * and the route refuses in plain language rather than answering with
           * some other model — the name is on screen beside the answer, and
           * quietly swapping it is a difference the person has no way to see.
           */
          onAsk={(text, request) => {
            onlyThis("ask");
            void ask(text, {
              ...(request.model ? { model: request.model } : {}),
              effort: request.effort,
            });
          }}
          walk={front === "ask" ? walk : null}
          onModeChange={onModeChange}
          /*
           * 프롬프트 만들기. The prompt is built in the browser from the graph on
           * screen and the switches as they are at this moment (D23's
           * snapshot); the model is asked only to restate the goal, and not at
           * all when none is connected.
           */
          onMakePrompt={(text, request) => {
            if (!selectedId) return;
            onlyThis("prompt");
            // A new request asks "only here or everywhere?" again, so the
            // last answer's opened place goes with the last prompt.
            setScopeOpened(null);
            promptMaker.make({
              graph: view,
              selectionId: selectedId,
              request: text,
              hops: request.hops,
              locks,
              model: request.model,
            });
          }}
          promptPhase={front === "prompt" ? promptMaker.phase : null}
          onChooseScope={(scope) => {
            /*
             * "Only on the checkout screen" cannot be done without touching the
             * checkout screen, so `buildPrompt` opens that place for this
             * prompt, and its switch shows it open while this prompt is in
             * front — the list the person sees and the list the agent reads
             * say the same thing. Nothing is written into the remembered locks
             * (see `scopeOpened`).
             */
            const selectionId = promptMaker.phase?.selectionId ?? selectedId;
            setScopeOpened(
              scope.kind === "only_here" && selectionId
                ? { selectionId, placeId: scope.placeId }
                : null,
            );
            promptMaker.choose(scope, locks);
          }}
          onCancelPrompt={() => {
            setScopeOpened(null);
            clearPrompt();
          }}
          /*
           * 설명하기. Pressing it costs nothing: it turns on the explanation of
           * whatever is selected, computed in the panel from the graph already
           * here. The deep read is the card's own button.
           */
          onExplain={(text) => {
            onlyThis("explain");
            setExplainAsked({ itemId: selectedId, text: text.trim() });
          }}
          explainOn={front === "explain"}
          deepExplainFor={(itemId) => deepExplains[explainKey(itemId, questionFor(itemId))] ?? null}
          onDeepExplain={(itemId, request) => {
            const question = questionFor(itemId);
            void explain(itemId, {
              ...(request.model ? { model: request.model } : {}),
              effort: request.effort,
              ...(question ? { question } : {}),
            });
          }}
          /*
           * 흐름 따라가기. No model and no network, so nothing from the request
           * is read — the walk is arithmetic over the graph already on screen.
           * The typed text is resolved against the map by the map's own beam,
           * and falls back to whatever is selected when the box is empty.
           */
          onFlow={(text) => {
            onlyThis("flow");
            askFlow(text, selectedId);
          }}
          onFollow={(itemId) => followFlow(itemId, "listed")}
          flow={flow}
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
          /*
            On a phone there is nothing to divide — the band is either the whole
            workspace or it is not on screen — and a 5px bar you can drag is a
            5px bar you can hit by accident while scrolling past it. It stays
            in the tree because the desktop's `maximized` state is a separate
            question from the phone's, and only CSS knows which width we are at.
          */
          collapsed={phone}
        />
      ) : null}

      <div
        id={PANE_PANEL_ID.history}
        role={phone ? "tabpanel" : undefined}
        aria-label={phone ? "변경 기록" : undefined}
        inert={hidden("history")}
        className="rule-t flex items-center gap-3 overflow-hidden bg-ink-raised px-4 py-1.5 text-[11px] text-said-faint [flex:var(--pane-band-flex)] max-md:[flex:var(--pane-band-flex-phone)] max-md:items-stretch max-md:px-3 max-md:py-3"
        style={
          {
            "--pane-band-flex":
              layout.maximized === "history"
                ? "1 1 0px"
                : layout.maximized === null
                  ? `0 0 ${layout.history * 100}%`
                  : "0 0 0px",
            // On a phone the band is a pane like the other three: all of the
            // workspace, or none of it. There is no strip along the bottom,
            // because a 4.5% strip of a 812px screen is 36px of a list nobody
            // can read and 36px the map cannot have.
            "--pane-band-flex-phone":
              phonePane === "history" ? "1 1 0px" : "0 0 0px",
          } as CSSProperties
        }
      >
        {/*
          The band reads its own runs rather than being handed them, because
          the graph the rest of this screen works from is one snapshot and the
          band is about the sequence of them. What it takes from here is when
          to go and read again: a run starting, and a finished run's graph
          arriving, are the only two moments its list changes.
        */}
        <HistoryBand
          projectId={project.id}
          expanded={shownPane === "history"}
          activeRunId={runId}
          lastRunId={view.lastRun?.id ?? null}
          lastRunStatus={view.lastRun?.status ?? null}
          /*
            The band's 다시 읽기 starts a real run, and this is where its id
            lands. Adopted exactly as `start` adopts its own — the graph fetch
            armed again first, then `runId` — so a run begun down there and one
            begun by the button above are the same event to this screen.

            Without it the run would be happening with nothing on screen saying
            so, and the person would press again.
          */
          onStarted={(startedRunId) => {
            loaded.current = null;
            setRunId(startedRunId);
          }}
          selectedSha={change?.sha ?? null}
          onLight={onLight}
        />
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
        <p className="mt-3 text-[14px] leading-[1.8] text-said-soft text-pretty">
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
          className="mt-6 rounded-lg bg-paper px-5 py-2.5 text-[14px] font-semibold text-ink transition duration-150 hover:bg-lamp active:scale-[0.98] disabled:opacity-55"
        >
          {starting ? "시작하는 중…" : failed ? "다시 해보기" : "지도 그리기"}
        </button>
      </div>
    </div>
  );
}
