"use client";

import { useState } from "react";

import { flowRefusalSentence } from "@/lib/graph/flow";
import {
  CERTAINTY_WORDS,
  KIND_WORDS,
  type GraphView,
  type ItemKind,
} from "@/lib/graph/view";

import { discoveryRefusal, flowsByFeature, importCountOf } from "../flow/start";
import { NO_FEATURES_YET } from "../map/grouping";
import { CertaintyMark, displayName } from "./connection-row";

/**
 * Everything the right panel shows when it is not showing connections.
 *
 * The brief's state table, minus the one state that has its own file: a run in
 * progress, nothing selected yet, a run that failed, and the two Step 4 states
 * that exist here as typed slots so the shape is settled before the data is.
 */

/* ---------------------------------------------------------------- shared */

export function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="display-kr text-[17px] text-said">{children}</h2>
  );
}

export function PanelNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 text-[13px] leading-[1.8] text-said-soft text-pretty">{children}</p>
  );
}

/* -------------------------------------------------------- analysis running */

export type RunPhase = "ingest" | "static" | "semantic" | "done";

/**
 * The live run, as the panel needs it.
 *
 * Deliberately a plain summary rather than the event stream: the workspace
 * folds `AnalysisEvent`s into this shape once, and every counter here maps
 * onto a field of `AnalysisEventPayloads` so the fold is obvious.
 */
export type RunProgress = {
  status: "running" | "completed" | "failed";
  phase: RunPhase;
  filesTotal: number;
  filesParsed: number;
  items: number;
  connections: number;
  certain: number;
  inferred: number;
  features: number;
  /** The last handful of parsed paths, newest first. */
  recent: readonly string[];
  skipped: readonly { path: string; reason: string }[];
  /** Plain language, only when the run failed. */
  message: string | null;
  /** Limits ingest hit, so the panel can say what is not on the map. */
  limits: readonly string[];
};

type StepState = "waiting" | "running" | "done" | "missed";

const PHASE_ORDER: RunPhase[] = ["ingest", "static", "semantic", "done"];

const PHASE_WORDS: Record<
  "ingest" | "static" | "semantic",
  { waiting: string; running: string; done: string; missed: string }
> = {
  ingest: {
    waiting: "파일 모으기",
    running: "파일 모으는 중이에요",
    done: "파일 다 모았어요",
    missed: "파일을 모으지 못했어요",
  },
  static: {
    waiting: "구조 읽기",
    running: "구조 읽는 중이에요",
    done: "구조 다 읽었어요",
    missed: "구조는 읽지 못했어요",
  },
  semantic: {
    waiting: "기능 이름 붙이기",
    running: "기능 이름 붙이는 중이에요",
    done: "기능 이름 다 붙였어요",
    missed: "기능 이름은 이번에 붙이지 않았어요",
  },
};

/**
 * A phase is done when its own work shows in the counters, not when the run
 * moved past it.
 *
 * The difference matters today: Pass 2 does not exist yet, so a completed run
 * goes ingest, static, done. Deriving "done" from the phase alone would put a
 * checkmark next to 기능 이름 다 붙였어요 on a run that never named a single
 * feature — a checkmark for work nobody did.
 */
function stepStateOf(phase: "ingest" | "static" | "semantic", run: RunProgress): StepState {
  const current = PHASE_ORDER.indexOf(run.phase);
  const mine = PHASE_ORDER.indexOf(phase);
  const didWork =
    phase === "ingest"
      ? run.filesTotal > 0
      : phase === "static"
        ? run.filesParsed > 0
        : run.features > 0;

  if (didWork && (current > mine || run.status !== "running")) return "done";
  if (run.status === "running") {
    if (current === mine) return "running";
    return current > mine ? "missed" : "waiting";
  }
  return "missed";
}

function stepCounter(phase: "ingest" | "static" | "semantic", run: RunProgress): string | null {
  if (phase === "ingest") {
    return run.filesTotal > 0 ? `파일 ${run.filesTotal.toLocaleString("ko-KR")}개` : null;
  }
  if (phase === "static") {
    if (run.filesParsed === 0) return null;
    return `${run.filesParsed.toLocaleString("ko-KR")}/${run.filesTotal.toLocaleString("ko-KR")} · 항목 ${run.items.toLocaleString("ko-KR")}개 · 연결 ${run.connections.toLocaleString("ko-KR")}개`;
  }
  return run.features > 0 ? `기능 ${run.features.toLocaleString("ko-KR")}개` : null;
}

export function AnalysisRunningState({
  run,
  showSteps = true,
}: {
  run: RunProgress;
  /**
   * False when the centre of the screen is already showing the checklist.
   *
   * The same five steps in two columns at once reads as two different things
   * happening, and the one in the centre is the larger and better one. What is
   * left here is what the centre does not carry: the running counts, the
   * certain/inferred split, and the file list behind 자세히.
   */
  showSteps?: boolean;
}) {
  const running = run.status === "running";

  return (
    <div>
      <PanelHeading>{running ? "지도를 그리는 중이에요" : "지도를 다 그렸어요"}</PanelHeading>
      <PanelNote>
        {running
          ? "새로고침해도 이어서 보여요. 다 그리면 아무거나 눌러서 연결을 볼 수 있어요."
          : "가운데 지도에서 아무거나 눌러 보세요."}
      </PanelNote>

      {showSteps ? (
      <ol className="mt-5 space-y-3">
        {(["ingest", "static", "semantic"] as const).map((phase) => {
          const state = stepStateOf(phase, run);
          const counter = stepCounter(phase, run);
          return (
            <li key={phase} className="flex items-start gap-2.5">
              <StepDot state={state} />
              <div className="min-w-0">
                <p
                  className={`text-[14px] leading-[1.6] ${
                    state === "running"
                      ? "text-said"
                      : state === "done"
                        ? "text-said-soft"
                        : "text-said-faint"
                  }`}
                >
                  {PHASE_WORDS[phase][state]}
                </p>
                {counter ? (
                  <p className="mt-0.5 text-[12px] text-said-faint tabular-nums">{counter}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      ) : (
        <Counts run={run} />
      )}

      {run.connections > 0 ? (
        <div className="rule-t mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-4 text-[12px] text-said-faint tabular-nums">
          <span className="flex items-center gap-1.5">
            <CertaintyMark certainty="certain" />
            {CERTAINTY_WORDS.certain} {run.certain.toLocaleString("ko-KR")}
          </span>
          <span className="flex items-center gap-1.5">
            <CertaintyMark certainty="inferred" />
            {CERTAINTY_WORDS.inferred} {run.inferred.toLocaleString("ko-KR")}
          </span>
        </div>
      ) : null}

      {run.limits.length > 0 ? (
        <ul className="mt-4 space-y-1 text-[12px] leading-[1.7] text-said-faint">
          {run.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      ) : null}

      {/*
        The file-by-file log, folded away. A scrolling list of filenames is a
        terminal, and a terminal is the most alienating object in the room for
        someone who cannot read code — but hiding it entirely would make the
        product look like it is guessing. Same information, opposite register.
        A native <details> so it opens without JavaScript and with a keyboard.
      */}
      {run.recent.length > 0 || run.skipped.length > 0 ? (
        <details className="rule-t mt-4 pt-3">
          <summary className="cursor-pointer text-[13px] text-said-faint hover:text-said-soft">
            자세히
          </summary>
          <ul className="mt-2 space-y-1">
            {run.recent.map((path) => (
              <li key={path} className="truncate font-mono text-[11px] text-said-faint">
                {path}
              </li>
            ))}
          </ul>
          {run.skipped.length > 0 ? (
            <div className="mt-3">
              <p className="text-[12px] text-said-soft tabular-nums">
                읽지 못한 파일 {run.skipped.length.toLocaleString("ko-KR")}개
              </p>
              <ul className="mt-1 space-y-1">
                {run.skipped.map((file) => (
                  <li key={file.path} className="truncate text-[11px] text-said-faint">
                    <span className="font-mono">{file.path}</span> — {file.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

/**
 * The three numbers, when the steps are being told in the centre instead.
 *
 * Counts only, and only the ones that exist yet: a run that has not reached a
 * file yet prints nothing rather than three zeroes, which look like a result.
 */
function Counts({ run }: { run: RunProgress }) {
  if (run.filesParsed === 0 && run.items === 0) return null;

  return (
    <dl className="mt-5 grid grid-cols-3 gap-2">
      {[
        { term: "읽은 파일", value: run.filesParsed },
        { term: "찾은 것", value: run.items },
        { term: "연결", value: run.connections },
      ].map((cell) => (
        <div key={cell.term}>
          <dt className="label-kr text-[11px] text-said-faint">{cell.term}</dt>
          <dd className="mt-0.5 font-mono text-[17px] text-said">
            {cell.value.toLocaleString("ko-KR")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StepDot({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="mt-[3px] h-4 w-4 shrink-0 text-lamp"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
      </svg>
    );
  }
  if (state === "running") {
    return (
      <span
        aria-hidden="true"
        className="mt-[7px] h-2 w-2 shrink-0 animate-pulse rounded-full bg-lamp"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="mt-[7px] h-2 w-2 shrink-0 rounded-full border border-edge-lit"
    />
  );
}

/* ------------------------------------------------------------- run failed */

export function RunFailedState({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry?: () => void;
}) {
  return (
    <div>
      <PanelHeading>지도를 다 그리지 못했어요</PanelHeading>
      <PanelNote>{message ?? "읽는 도중에 멈췄어요. 잠시 후 다시 시도해 주세요."}</PanelNote>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg bg-paper px-4 py-2 text-[14px] font-semibold text-ink transition duration-150 hover:bg-lamp active:scale-[0.98]"
        >
          다시 해보기
        </button>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- nothing chosen */

const KIND_COUNT_ORDER: ItemKind[] = [
  "feature",
  "route",
  "file",
  "symbol",
  "api_endpoint",
  "package",
];

/**
 * The counts, in words, skipping whatever a project does not have.
 *
 * The skipping is the point. David's own portfolio is a static site: 58 files,
 * 57 connections, and not one symbol. A fixed row of labels would sit there
 * reading 조각 0개 — a whole category of nothing, on the screen of the person
 * who owns the site.
 */
function countByKind(view: GraphView): { kind: ItemKind; count: number }[] {
  const counts = new Map<ItemKind, number>();
  for (const item of view.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return KIND_COUNT_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => ({
    kind,
    count: counts.get(kind) ?? 0,
  }));
}

/**
 * The things other parts of the app reach for, most first.
 *
 * Ranked by `usedBy` alone and never by total degree. Measured on the
 * founder's own portfolio: ranking by degree put `index.html` at the top of a
 * list headed 많이 쓰이는 것 with the words "0곳에서 쓰여요" next to it — the page
 * uses ten things and nothing uses it, which is the opposite of what the
 * heading claims. An item nothing uses does not belong in this list at all.
 */
function busiestItems(view: GraphView, howMany: number) {
  return [...view.items]
    .filter((item) => item.kind !== "package" && item.usedBy > 0)
    .sort((a, b) => b.usedBy - a.usedBy)
    .slice(0, howMany);
}

export function NothingSelectedState({
  view,
  onSelect,
  onFollow,
}: {
  view: GraphView;
  onSelect: (id: string) => void;
  /**
   * Start a flow from a place in the project. Undefined leaves the 흐름 block
   * out entirely rather than drawing buttons that do nothing — the same rule
   * `onOpen` follows one file over.
   */
  onFollow?: (id: string) => void;
}) {
  const counts = countByKind(view);
  const certain = view.connections.filter((c) => c.certainty === "certain").length;
  const inferred = view.connections.length - certain;
  const busiest = busiestItems(view, 3);

  return (
    <div>
      <PanelHeading>이 프로젝트의 지도</PanelHeading>
      <PanelNote>
        {view.items.length > 0
          ? "가운데 지도에서 아무거나 눌러 보세요. 무엇과 이어져 있는지 여기에 보여 드려요."
          : view.lastRun === null
            // Nothing was found and nothing was looked for are different
            // sentences, and only one of them is true before the first run.
            ? "아직 읽기 전이에요. 가운데에서 지도 그리기를 눌러 주세요."
            : "아직 지도에 올릴 것을 찾지 못했어요."}
      </PanelNote>

      {view.items.length > 0 ? (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3">
            {counts.map(({ kind, count }) => (
              <div key={kind}>
                <dt className="label-kr text-[11px] text-said-faint">{KIND_WORDS[kind]}</dt>
                <dd className="text-[19px] font-semibold tracking-[-0.02em] text-said tabular-nums">
                  {count.toLocaleString("ko-KR")}
                </dd>
              </div>
            ))}
            <div>
              <dt className="label-kr text-[11px] text-said-faint">연결</dt>
              <dd className="text-[19px] font-semibold tracking-[-0.02em] text-said tabular-nums">
                {view.connections.length.toLocaleString("ko-KR")}
              </dd>
            </div>
          </dl>

          <div className="rule-t mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-3 text-[12px] text-said-faint tabular-nums">
            <span className="flex items-center gap-1.5">
              <CertaintyMark certainty="certain" />
              {CERTAINTY_WORDS.certain} {certain.toLocaleString("ko-KR")}
            </span>
            <span className="flex items-center gap-1.5">
              <CertaintyMark certainty="inferred" />
              {CERTAINTY_WORDS.inferred} {inferred.toLocaleString("ko-KR")}
            </span>
          </div>

          {busiest.length > 0 ? (
            <div className="mt-5">
              <p className="label-kr text-[11px] text-said-faint">많이 쓰이는 것</p>
              <ul className="mt-1.5 space-y-1">
                {busiest.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(item.id)}
                      className="-mx-1.5 block w-[calc(100%+0.75rem)] truncate rounded-md px-1.5 py-1 text-left text-[14px] text-said-soft transition-colors hover:bg-ink hover:text-lamp max-md:py-2.5"
                    >
                      {item.label ? (
                        displayName(item)
                      ) : (
                        <code className="text-[13px]">{item.name}</code>
                      )}
                      <span className="ml-1.5 text-[12px] text-said-faint tabular-nums">
                        {item.usedBy}곳에서 쓰여요
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {onFollow ? <FlowsHere view={view} onFollow={onFollow} /> : null}
        </>
      ) : null}

      {view.lastRun?.filesSkipped.length ? (
        <details className="rule-t mt-5 pt-3">
          <summary className="cursor-pointer text-[13px] text-said-faint hover:text-said-soft">
            읽지 못한 파일 {view.lastRun.filesSkipped.length.toLocaleString("ko-KR")}개
          </summary>
          <ul className="mt-2 space-y-1">
            {view.lastRun.filesSkipped.map((path) => (
              <li key={path} className="truncate font-mono text-[11px] text-said-faint">
                {path}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * 따라가 볼 수 있는 흐름 — where somebody who has clicked nothing finds this.
 *
 * `FLOW_TRACKING.md` §6 puts it here, and §6 is right about why: this panel is
 * already the project-overview slot, and a feature that can only be reached by
 * first guessing what to click is a feature most people never reach.
 *
 * ## The refusal is the common case, and it is written as one
 *
 * Measured against production the same day this was built: **three of the four
 * real projects have no entry point at all** — a Streamlit app, an OpenCV tray
 * app and a static site. So the branch that says so is not the error path, it
 * is what most people see first, and it gets §7's own sentence rather than an
 * empty list or a shrug. The sentence ends by telling them what to do instead
 * (pick a file), because a refusal with no next move is only an apology.
 *
 * ## Features are a heading, never a start
 *
 * Pass 2 writes `feature` rows now, so where a project has them the flows are
 * gathered under the feature each belongs to (§9's Phase 5, which turns out to
 * be a grouping and not an algorithm). A feature is never itself a button:
 * `entryPointsOf` refuses one on purpose, because a grouping we made is not
 * something the code does. Where a project has no features, the sentence is
 * `grouping.ts`'s own, imported rather than retyped — two halves of one screen
 * explaining the same gap two different ways is what that sentence exists to
 * prevent.
 */
function FlowsHere({
  view,
  onFollow,
}: {
  view: GraphView;
  onFollow: (id: string) => void;
}) {
  const refusal = discoveryRefusal(view);
  const groups = refusal === null ? flowsByFeature(view) : [];
  const named = groups.some((group) => group.feature !== null);

  return (
    <div className="rule-t mt-5 pt-4">
      <p className="label-kr text-[11px] text-said-faint">따라가 볼 수 있는 흐름</p>

      {refusal !== null ? (
        <p className="mt-1.5 text-[12px] leading-[1.75] text-said-faint text-pretty">
          {flowRefusalSentence(refusal, {
            name: "",
            kind: "file",
            imports: importCountOf(view),
          })}
        </p>
      ) : (
        <>
          {groups.map((group) => (
            <div key={group.feature?.id ?? "그 밖"} className="mt-2">
              {named ? (
                <p className="text-[11px] text-said-faint">
                  {group.feature
                    ? (group.feature.label ?? group.feature.name)
                    : "어느 기능에도 넣지 못한 것"}
                </p>
              ) : null}
              <ul className="mt-1 space-y-1">
                {group.starts.slice(0, FLOWS_PER_GROUP).map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onFollow(item.id)}
                      className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-ink max-md:py-2.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-[14px] text-said-soft">
                        {item.label ? (
                          displayName(item)
                        ) : (
                          <code className="text-[13px]">{item.name}</code>
                        )}
                      </span>
                      <span className="shrink-0 text-[12px] text-said-faint">따라가 보기</span>
                    </button>
                  </li>
                ))}
              </ul>
              {group.starts.length > FLOWS_PER_GROUP ? (
                <p className="mt-1 text-[11px] text-said-faint tabular-nums">
                  이 밖에 {group.starts.length - FLOWS_PER_GROUP}곳이 더 있어요.
                </p>
              ) : null}
            </div>
          ))}

          {!named ? (
            <p className="mt-2 text-[11px] leading-[1.7] text-said-faint text-pretty">
              {NO_FEATURES_YET}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * How many flows one feature lists before it says there are more.
 *
 * `neighbourhood.ts`'s rule, and the reason is the same: a list that stops with
 * no note reads as "that is all there is", which on this product is a false
 * statement about somebody's code. Six rather than three because this list is
 * the whole way in to the feature rather than an aside beside something else,
 * and because a project with sixteen endpoints under one feature would
 * otherwise show three of them.
 */
const FLOWS_PER_GROUP = 6;

/* ------------------------------------------------------- nothing connected */

/**
 * The absence of knowledge, said as an absence of knowledge.
 *
 * Section 3 of the brief allows exactly one sentence here and forbids the one
 * the user would rather hear: we may say we know of no connections, and we may
 * never say that changing this is safe. The second line is not padding — it is
 * the part that keeps the first line from being read as a promise.
 */
export function NoKnownConnections() {
  return (
    <div className="hairline rounded-xl bg-ink px-4 py-5">
      <p className="text-[14px] font-medium text-said">아는 연결이 없어요</p>
      <p className="mt-1.5 text-[13px] leading-[1.8] text-said-soft text-pretty">
        지금까지 읽은 것 중에는 여기와 이어진 곳을 찾지 못했어요. 우리가 못 본
        연결이 있을 수도 있어요.
      </p>
    </div>
  );
}

/* ------------------------------------------------------- Step 4 slots */

export type PanelCitation = { itemId: string; name: string };

/** What the Q&A agent hands back (brief 6.3). Step 4 fills it. */
export type PanelAnswer = {
  text: string;
  citations: readonly PanelCitation[];
  /** True while the agent is still answering. */
  pending: boolean;
};

/** What prompt generation hands back (brief 6.4). Step 4 fills it. */
export type PanelPrompt = {
  /** Plain language: "결제 화면의 결제 버튼만 고칠게요." */
  confirmation: string;
  /** The thing the agent reads. Behind a toggle, never the first thing shown. */
  prompt: string;
};

export function AnswerState({
  answer,
  onSelect,
}: {
  answer: PanelAnswer;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="hairline rounded-xl bg-ink px-4 py-4">
      <p className="whitespace-pre-wrap text-[14px] leading-[1.85] text-said">
        {answer.text}
        {answer.pending ? <span className="animate-pulse text-said-faint"> …</span> : null}
      </p>
      {answer.citations.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {answer.citations.map((citation) => (
            <li key={citation.itemId}>
              <button
                type="button"
                onClick={() => onSelect(citation.itemId)}
                className="rounded-md border border-edge-lit px-2 py-1 text-[12px] text-said-soft transition-colors hover:border-lamp-dim hover:bg-ink-raised hover:text-lamp"
              >
                {citation.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function PromptState({ prompt }: { prompt: PanelPrompt }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission can be refused; the text is on screen behind the
      // toggle either way, so there is nothing to recover from.
      setCopied(false);
    }
  }

  return (
    <div className="hairline rounded-xl bg-ink px-4 py-4">
      <p className="text-[14px] leading-[1.85] text-said text-pretty">{prompt.confirmation}</p>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="rounded-lg bg-paper px-3 py-1.5 text-[13px] font-semibold text-ink transition duration-150 hover:bg-lamp active:scale-[0.98]"
        >
          {copied ? "복사했어요" : "복사하기"}
        </button>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-[13px] text-said-faint hover:text-said-soft">
          프롬프트 보기
        </summary>
        <pre className="hairline mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-sunk p-3 font-mono text-[11px] leading-[1.7] text-said-soft [scrollbar-color:var(--color-edge-lit)_transparent] [scrollbar-width:thin]">
          {prompt.prompt}
        </pre>
      </details>
    </div>
  );
}
