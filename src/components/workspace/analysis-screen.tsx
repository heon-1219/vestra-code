"use client";

import { useEffect, useRef, useState } from "react";

import { CERTAINTY_WORDS } from "@/lib/graph/view";

import { buildPhaseRows, PhaseChecklist } from "./phase-checklist";

/**
 * The screen a person watches while we read their project.
 *
 * It is the first thing this product ever does in front of someone, so it has
 * one job beyond reporting: it has to be worth watching without lying. Every
 * number here came off the event stream. Nothing is on a timer, nothing eases
 * up to a number it was told in advance, and the one stretch where we genuinely
 * know nothing — the download, which reports no progress at all — says so in
 * words instead of borrowing a bar from somewhere else.
 *
 * The screen takes its whole state as props. The stream hook lives elsewhere
 * and drives this; the split is what lets every state below, including the ones
 * that need a repository to fail halfway through a download, be rendered on
 * demand.
 */

export type AnalysisPhase = "ingest" | "static" | "semantic" | "done";

/** Whether the browser currently holds the event stream open. */
export type StreamState = "opening" | "live" | "retrying" | "closed";

export type ProjectSource = "github" | "upload";

/**
 * What `run.completed` said.
 *
 * Renamed on the way in, on purpose. The wire payload calls these `nodeCount`
 * and `edgeCount`, and `src/lib/graph/view.ts` set the rule that the graph's
 * own vocabulary stops at the boundary of the UI — past here a thing is an item
 * and a link is a connection, in the types as well as in the copy, because a
 * name is where the wrong word gets back in.
 */
export type AnalysisCompletion = {
  /** `nodeCount` */
  itemCount: number;
  /** `edgeCount` */
  connectionCount: number;
  filesParsed: number;
  filesSkipped: number;
  /** Plain Korean sentences about what ingest had to leave out. */
  limits: readonly string[];
};

/**
 * The running state of one analysis, as the stream last reported it.
 *
 * Flat and cumulative: every field is the latest total, not a delta, so a
 * browser that reconnects mid-run and replays from its cursor lands on the same
 * object a browser that never left would hold.
 */
export type AnalysisProgress = {
  /** Null until the first `phase.changed` arrives. */
  phase: AnalysisPhase | null;
  stream: StreamState;
  /** `file.parsed.parsed` */
  filesRead: number;
  /** `file.parsed.total`. Null before the first file — never a guess. */
  filesTotal: number | null;
  /** `run.started.fileCount`. Null means ingest has not finished. */
  filesOffered: number | null;
  /** `nodes.added.total` */
  itemsFound: number;
  /** `edges.added.total` */
  connectionsFound: number;
  /** `edges.added.certain` / `.inferred` */
  certainCount: number;
  inferredCount: number;
  /** `feature.created` count. Zero until Pass 2 exists (Step 4). */
  featuresNamed: number;
  /** Paths from `file.parsed`, newest first. Bounded by the hook. */
  recentFiles: readonly string[];
  /** `file.skipped` */
  skipped: readonly { path: string; reason: string }[];
  /** `run.failed.message` — already plain Korean, written for this reader. */
  failure: string | null;
  /** `run.completed` */
  completion: AnalysisCompletion | null;
};

export type AnalysisScreenProps = {
  projectName: string;
  source: ProjectSource;
  progress: AnalysisProgress;
  /**
   * Called once the finished run has been handed over. The map takes the
   * screen from here; this component does not know what the map is.
   */
  onArrive?: () => void;
  /** Absent when the project cannot be re-analysed — an uploaded folder (D66). */
  onRetry?: () => void;
};

/**
 * How long the finished screen holds before the map takes over.
 *
 * Not a fake delay — the work is over and every number is final. It is the beat
 * that makes the end of the run readable, and it is short enough that nobody
 * waits on it. The 지도 열기 button skips it, which is also what a keyboard gets.
 */
const ARRIVAL_DWELL_MS = 1400;

export function AnalysisScreen({
  projectName,
  source,
  progress,
  onArrive,
  onRetry,
}: AnalysisScreenProps) {
  const reduced = usePrefersReducedMotion();
  const rows = buildPhaseRows(progress, source);
  const { completion, failure } = progress;

  const stage = completion ? "arriving" : failure ? "stopped" : "running";

  // Hand over once, on a timer that starts when the last event lands. Firing on
  // a ref rather than on `onArrive` itself so a parent that re-creates the
  // callback each render cannot restart the beat.
  const arriveRef = useRef(onArrive);
  useEffect(() => {
    arriveRef.current = onArrive;
  }, [onArrive]);
  useEffect(() => {
    if (!completion) return;
    const timer = setTimeout(() => arriveRef.current?.(), ARRIVAL_DWELL_MS);
    return () => clearTimeout(timer);
  }, [completion]);

  const hasNumbers =
    progress.filesOffered !== null ||
    progress.filesRead > 0 ||
    progress.itemsFound > 0;
  const said = subline(progress, source);
  const reading = progress.recentFiles[0] ?? null;

  return (
    /*
     * Anchored to the top rather than centred. This panel's height is not ours
     * to choose, and a vertically centred block in a short one pushes the
     * headline out through the top of the overflow container, where no scroll
     * can bring it back.
     */
    <section
      data-stage={stage}
      className="vc-analysis relative flex h-full w-full items-start justify-center overflow-y-auto px-6 py-10"
    >
      <style href="vestra-analysis-screen" precedence="medium">
        {SCREEN_CSS}
      </style>

      {/* The map's own surface, arriving under the text. It is the transition:
          the sheet slides in, the checklist dissolves on top of it, and what is
          left standing is the summary the map opens with. */}
      {/* The clip is load-bearing: the sheet rests 14px below its final place,
          and without it that offset lengthens the panel's scroll height and
          leaves a scrollbar on a screen that fits. */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        aria-hidden="true"
      >
        <div className="vc-sheet absolute inset-x-0 bottom-0 top-1/2" />
      </div>

      <div className="relative w-full max-w-[620px]">
        <p className="text-[13px] font-medium tracking-[-0.01em] text-said-faint">
          {projectName}
        </p>

        <div role="status" aria-live="polite" className="mt-2">
          <h1 className="display-kr text-[27px] text-said">{headline(progress)}</h1>
          {said ? (
            <p className="mt-2.5 max-w-[46ch] text-[14px] leading-[1.8] text-said-soft">
              {said}
            </p>
          ) : null}
        </div>

        {/* The silent stretch. No bar, because there is nothing behind one —
            the download emits no progress events at all. A band that only says
            "still working" is the honest shape for that, and the sentence above
            says why it is quiet. */}
        {!hasNumbers && !failure && !completion ? (
          reduced ? (
            <div className="vc-band mt-7 h-[3px] w-full rounded-full" />
          ) : (
            <div className="mt-7 h-[3px] w-full overflow-hidden rounded-full bg-edge">
              <div className="vc-sweep h-full w-1/3 rounded-full bg-lamp-dim" />
            </div>
          )
        ) : null}

        {hasNumbers ? <Counters progress={progress} /> : null}

        {/* One line, replaced in place. The whole file list is a terminal; the
            file being read right now is proof that the numbers above belong to
            real work happening at this second. */}
        {reading && !completion && !failure ? (
          <p className="mt-3 flex items-baseline gap-2 text-[12px] text-said-faint">
            <span className="shrink-0">지금 읽는 파일</span>
            <span className="truncate font-mono">{reading}</span>
          </p>
        ) : null}

        <div className="relative mt-7">
          <div className="vc-rows">
            <PhaseChecklist rows={rows} />
          </div>

          <div
            className="vc-arrival pointer-events-none absolute inset-0"
            aria-hidden={completion === null}
          >
            {completion ? (
              <Arrival
                completion={completion}
                certain={progress.certainCount}
                inferred={progress.inferredCount}
                onArrive={onArrive}
              />
            ) : null}
          </div>
        </div>

        {failure ? (
          <Stopped message={failure} source={source} onRetry={onRetry} />
        ) : null}

        {progress.stream === "retrying" && !completion && !failure ? (
          <p className="mt-5 text-[13px] leading-[1.7] text-said-faint">
            화면 연결이 잠깐 끊겼어요. 다시 잇는 중이고, 읽는 일은 계속되고 있어요.
          </p>
        ) : null}

        <Details progress={progress} />
      </div>
    </section>
  );
}

/**
 * The three numbers the brief asks for, and nothing else.
 *
 * They snap to the value the event carried rather than counting up to it. A
 * tween looks better and would be the one dishonest thing on the screen: the
 * intermediate numbers never existed. What moves instead is a brief warmth on
 * the digits as they change, which marks that something arrived without
 * inventing a value.
 */
function Counters({ progress }: { progress: AnalysisProgress }) {
  const { completion } = progress;
  const files = completion ? completion.filesParsed : progress.filesRead;
  const items = completion ? completion.itemCount : progress.itemsFound;
  const connections = completion
    ? completion.connectionCount
    : progress.connectionsFound;

  return (
    <dl className="mt-7 grid grid-cols-3 gap-3 border-y border-edge py-4">
      <Counter
        label="읽은 파일"
        value={files}
        suffix={
          !completion && progress.filesTotal !== null
            ? ` / ${progress.filesTotal.toLocaleString("ko-KR")}`
            : null
        }
      />
      <Counter label="찾은 것" value={items} suffix={null} />
      <Counter label="연결" value={connections} suffix={null} />
    </dl>
  );
}

function Counter({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number;
  suffix: string | null;
}) {
  return (
    <div>
      <dt className="text-[12px] tracking-[-0.005em] text-said-faint">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-1">
        {/*
         * Keyed on the value so the element is replaced and the flash replays.
         * Safe here because it is a number with no state of its own — the same
         * move on a text input would remount the field and lose a half-typed
         * 한글 syllable with the IME composition (UI_DIRECTION section 5.2).
         */}
        <span
          key={value}
          className="vc-tick text-[26px] font-semibold tabular-nums tracking-[-0.03em] text-said"
        >
          {value.toLocaleString("ko-KR")}
        </span>
        {suffix ? (
          <span className="text-[14px] tabular-nums text-said-faint">{suffix}</span>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * What the screen settles into when the run is over.
 *
 * One sentence a person can read out loud, then the one distinction this
 * product refuses to lose: how much of what we drew we are actually sure of.
 * The hatch is introduced here, before the map, so the texture is already known
 * by the time it is carrying meaning on a drawing.
 */
function Arrival({
  completion,
  certain,
  inferred,
  onArrive,
}: {
  completion: AnalysisCompletion;
  certain: number;
  inferred: number;
  onArrive?: () => void;
}) {
  const ko = (n: number) => n.toLocaleString("ko-KR");

  return (
    <div className="pointer-events-auto">
      <p className="text-[16px] leading-[1.85] text-said">
        파일 {ko(completion.filesParsed)}개를 읽고 그 안에서 {ko(completion.itemCount)}개를
        찾았어요.{" "}
        {completion.connectionCount > 0
          ? `서로 어떻게 이어지는지 ${ko(completion.connectionCount)}군데 정리했어요.`
          : "아는 연결이 없어요."}
      </p>

      {completion.connectionCount > 0 ? (
        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-said-soft">
          {inferred === 0 ? (
            <span className="flex items-center gap-2">
              <Swatch kind="certain" />
              정리한 연결은 전부 {CERTAINTY_WORDS.certain}
            </span>
          ) : (
            <>
              <span className="flex items-center gap-2">
                <Swatch kind="certain" />
                {ko(certain)}개는 {CERTAINTY_WORDS.certain}
              </span>
              <span className="flex items-center gap-2">
                <Swatch kind="inferred" />
                {ko(inferred)}개는 {CERTAINTY_WORDS.inferred}
              </span>
            </>
          )}
        </p>
      ) : null}

      {completion.limits.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {completion.limits.map((limit) => (
            <li key={limit} className="text-[13px] leading-[1.75] text-said-faint">
              {limit}
            </li>
          ))}
        </ul>
      ) : null}

      {onArrive ? (
        <button
          type="button"
          onClick={onArrive}
          className="mt-5 rounded-lg bg-paper px-5 py-2.5 text-[14px] font-semibold text-ink transition-colors hover:bg-lamp"
        >
          지도 열기
        </button>
      ) : null}
    </div>
  );
}

/**
 * The honesty encoding, at swatch size.
 *
 * A hatch rather than a dashed line, because at the zoom where a whole project
 * fits on screen a 1px dash and a 1px solid stroke are the same stroke, and the
 * distinction would quietly disappear exactly where it matters (D59). Drawn in
 * SVG, so the hatch pitch is in screen space and stays constant — the canvas
 * version of this has to be built against the inverse transform or it scales
 * with the zoom and loses the property it was chosen for.
 */
function Swatch({ kind }: { kind: "certain" | "inferred" }) {
  // Both swatches are the same colour on purpose. If the hatch were also
  // darker, the eye would read "fainter" and learn the wrong lesson — the whole
  // argument for a texture is that it survives being small, dim or projected,
  // which a difference in weight does not.
  if (kind === "certain") {
    return (
      <span
        className="inline-block h-[14px] w-[14px] rounded-[2px] bg-wire"
        aria-hidden="true"
      />
    );
  }
  return (
    <svg
      className="inline-block h-[14px] w-[14px] text-wire"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="vc-hatch"
          width="3"
          height="3"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="3" stroke="currentColor" strokeWidth="1.6" />
        </pattern>
      </defs>
      <rect width="14" height="14" rx="2" fill="url(#vc-hatch)" />
      <rect width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/**
 * A run that stopped.
 *
 * Rendered as information, not as a crash: the checklist above keeps its
 * checkmarks, so the reader can see how far it got, and the step that was under
 * way carries a dash rather than a cross. The message is the server's — already
 * written for this reader, and it is the one that knows whether the repository
 * was too large, unreachable, or had nothing we could read.
 */
function Stopped({
  message,
  source,
  onRetry,
}: {
  message: string;
  source: ProjectSource;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="mt-6 rounded-xl border border-edge bg-ink-raised p-5">
      <p className="text-[15px] leading-[1.8] text-said">{message}</p>

      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg bg-paper px-4 py-2 text-[14px] font-semibold text-ink transition-colors hover:bg-lamp"
        >
          다시 시도하기
        </button>
      ) : source === "upload" ? (
        // D66: there is no origin to fetch from, and section 3 means we kept no
        // copy. Asking for the folder again is the honest answer, and this is
        // the first place the trust promise costs the user something visible.
        <p className="mt-3 text-[13px] leading-[1.75] text-said-faint">
          올려주신 폴더는 원본을 가지고 있지 않아서 다시 읽을 수 없어요. 폴더를 다시
          올려 주세요.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The log, one disclosure away.
 *
 * Collapsed by default and never the main event. Whoever wants the file-by-file
 * list gets exactly that; everyone else never meets a terminal.
 */
function Details({ progress }: { progress: AnalysisProgress }) {
  const [open, setOpen] = useState(false);
  const { recentFiles, skipped } = progress;
  if (recentFiles.length === 0 && skipped.length === 0) return null;

  return (
    <div className="mt-6 border-t border-edge pt-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="vc-analysis-details"
        className="flex items-center gap-1.5 text-[13px] text-said-faint transition-colors hover:text-said-soft"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        자세히
      </button>

      {open ? (
        <div id="vc-analysis-details" className="mt-3">
          <ul className="max-h-[168px] space-y-1 overflow-y-auto">
            {recentFiles.slice(0, 60).map((path, index) => (
              <li
                key={`${path}-${index}`}
                className="truncate font-mono text-[12px] text-said-faint"
              >
                {path}
              </li>
            ))}
          </ul>

          {skipped.length > 0 ? (
            <div className="mt-4">
              <p className="text-[13px] text-said-soft">
                넘어간 파일 {skipped.length.toLocaleString("ko-KR")}개
              </p>
              <ul className="mt-1.5 space-y-1">
                {skipped.map((entry) => (
                  <li
                    key={entry.path}
                    className="truncate font-mono text-[12px] text-said-faint"
                  >
                    {entry.path} — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function headline(progress: AnalysisProgress): string {
  if (progress.failure) return "읽다가 멈췄어요";
  if (progress.completion) return "지도가 준비됐어요";
  switch (progress.phase) {
    case "ingest":
      return "코드를 가져오는 중이에요";
    case "static":
      return "코드를 한 파일씩 읽고 있어요";
    case "semantic":
      return "기능에 이름을 붙이고 있어요";
    case "done":
      return "찾은 것들을 정리하고 있어요";
    default:
      return "분석을 시작하는 중이에요";
  }
}

function subline(progress: AnalysisProgress, source: ProjectSource): string | null {
  if (progress.failure || progress.completion) return null;
  if (progress.phase === "ingest" || progress.phase === null) {
    return source === "upload"
      ? "올려주신 폴더를 정리하고 있어요. 이 동안에는 보여드릴 숫자가 없어서 잠깐 조용해요."
      : "저장소를 통째로 받아오는 중이에요. 이 동안에는 보여드릴 숫자가 없어서 잠깐 조용해요. 저장소가 크면 조금 더 걸려요.";
  }
  // Past ingest the numbers speak for themselves, and a sentence under every
  // one of them would be noise on a screen that is already moving.
  return null;
}

/**
 * Reduced motion, read once and watched.
 *
 * The global stylesheet already flattens every animation, which is enough for
 * decoration. This is for the one place where the right answer is a different
 * element rather than a slower one: a swept band with its duration flattened
 * freezes at one end and reads as stalled, so that case gets a still hatch and
 * the sentence beside it instead.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

/**
 * Scoped to this screen and hoisted by React rather than added to the global
 * stylesheet, which belongs to the whole product. Every duration here is also
 * governed by the global reduced-motion rule, which flattens all of them.
 */
const SCREEN_CSS = `
.vc-analysis .vc-rows,
.vc-analysis .vc-arrival,
.vc-analysis .vc-sheet {
  transition: opacity 520ms ease, transform 520ms ease;
}
.vc-analysis .vc-arrival { opacity: 0; transform: translateY(6px); }
.vc-analysis .vc-sheet {
  opacity: 0;
  transform: translateY(14px);
  border-top: 1px solid color-mix(in oklab, var(--color-paper) 22%, transparent);
  background: linear-gradient(
    to bottom,
    color-mix(in oklab, var(--color-paper) 7%, transparent),
    transparent 70%
  );
}
.vc-analysis[data-stage="arriving"] .vc-rows { opacity: 0; transform: translateY(-8px); }
.vc-analysis[data-stage="arriving"] .vc-arrival { opacity: 1; transform: none; }
.vc-analysis[data-stage="arriving"] .vc-sheet { opacity: 1; transform: none; }
.vc-analysis[data-stage="stopped"] .vc-rows { opacity: 0.6; }

.vc-sweep { animation: vc-sweep 1.5s cubic-bezier(0.5, 0, 0.5, 1) infinite; }
@keyframes vc-sweep {
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
}

.vc-band {
  background-image: repeating-linear-gradient(
    45deg,
    var(--color-edge-lit) 0 3px,
    transparent 3px 6px
  );
}

.vc-tick { animation: vc-tick 620ms ease-out; }
@keyframes vc-tick {
  from { color: var(--color-lamp); }
  to { color: var(--color-said); }
}

.vc-pulse { animation: vc-pulse 1.9s ease-out infinite; }
@keyframes vc-pulse {
  0% { transform: scale(1); opacity: 0.55; }
  70% { transform: scale(2.4); opacity: 0; }
  100% { transform: scale(2.4); opacity: 0; }
}
`;
