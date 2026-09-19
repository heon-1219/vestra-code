"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  useAnalysisStream,
  type AnalysisPhase,
  type AnalysisStreamState,
} from "@/hooks/use-analysis-stream";

/**
 * Starting a run, and watching it.
 *
 * The live screen here is deliberately **not** a scrolling list of filenames.
 * A terminal is the most alienating object in a developer tool for someone who
 * cannot read code, and it has no visible end — you cannot tell from a log
 * whether you are nearly there. A short checklist with counters carries exactly
 * the same information and has a shape you can see the end of
 * (`docs/UI_DIRECTION.md` section 4). The file-by-file list is still here, one
 * click away, for the person who wants it.
 */

const startedSchema = z.object({ runId: z.uuid(), started: z.boolean() });
const messageSchema = z.object({ message: z.string() });

const GENERIC_START_ERROR =
  "지금은 시작하지 못했어요. 잠시 후에 다시 시도해 주세요.";
const OFFLINE_START_ERROR =
  "연결이 끊겼어요. 인터넷 연결을 확인하고 다시 시도해 주세요.";

/** The phases a run moves through, in order. Used to rank, never displayed. */
const PHASE_ORDER: AnalysisPhase[] = ["ingest", "static", "semantic", "done"];

type StartError = { status: number; message: string };

/** What the last run produced, kept after the stream has closed. */
type Finished = {
  itemCount: number;
  connectionCount: number;
  certainCount: number;
  inferredCount: number;
  limits: string[];
};

export function AnalysisTrigger({
  projectId,
  activeRunId,
  source,
  hasGraph,
}: {
  projectId: string;
  /** A run the server found already in flight when it rendered the page. */
  activeRunId: string | null;
  /** An uploaded folder cannot be read again; the button says so when asked. */
  source: "github" | "upload";
  /** Changes the words on the button, nothing else. */
  hasGraph: boolean;
}) {
  const router = useRouter();
  const [runId, setRunId] = useState<string | null>(activeRunId);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<StartError | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);

  const stream = useAnalysisStream(projectId, runId);

  /** Runs we have already handled the end of, so the effect below fires once. */
  const settled = useRef<string | null>(null);

  useEffect(() => {
    if (!runId || !stream.finished || stream.failure) return;
    if (settled.current === runId) return;
    settled.current = runId;

    // Snapshot before dropping the run id: clearing it resets the stream, and
    // the numbers the user just watched arrive at would go with it.
    setFinished({
      itemCount: stream.itemCount,
      connectionCount: stream.connectionCount,
      certainCount: stream.certainCount,
      inferredCount: stream.inferredCount,
      limits: stream.limits,
    });
    setRunId(null);

    // The page is server-rendered from the graph, so this is what puts the map
    // on screen. The run row was marked completed before the event was written,
    // so this read cannot see a run that is still working.
    router.refresh();
  }, [runId, stream, router]);

  // A run started somewhere else — a second tab, or a refresh that landed while
  // one was already going — arrives as a prop rather than as a click.
  useEffect(() => {
    if (!activeRunId || activeRunId === runId) return;
    if (settled.current === activeRunId) return;
    setRunId(activeRunId);
  }, [activeRunId, runId]);

  async function start() {
    setStarting(true);
    setStartError(null);
    setFinished(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/analyze`, {
        method: "POST",
      });

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A body we cannot read is handled below by the generic message.
      }

      if (response.status === 202) {
        const accepted = startedSchema.safeParse(body);
        if (!accepted.success) {
          setStartError({ status: 0, message: GENERIC_START_ERROR });
          return;
        }
        settled.current = null;
        setRunId(accepted.data.runId);
        return;
      }

      // Every failure this endpoint returns is already a plain Korean sentence
      // written for this person — an uploaded project asked for the folder
      // again, a signed-out session asked them to sign in. Rendering it is the
      // whole job; treating a 400 as a crash would hide the one instruction
      // they need.
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
  }

  if (runId && !stream.failure) {
    return <LiveRun stream={stream} source={source} />;
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={starting}
        className="rounded-lg bg-paper px-5 py-2.5 text-[14px] font-semibold text-ink transition-colors hover:bg-lamp disabled:opacity-55"
      >
        {starting
          ? "시작하는 중…"
          : hasGraph
            ? "지도 다시 그리기"
            : "지도 그리기"}
      </button>

      {source === "upload" && !hasGraph ? (
        <p className="mt-3 text-[13px] leading-[1.75] text-said-faint">
          올려주신 폴더는 코드를 보관하지 않아서, 다시 읽으려면 폴더를 한 번 더
          골라주셔야 해요.
        </p>
      ) : null}

      {stream.failure ? (
        <p role="alert" className="mt-4 text-[14px] leading-[1.75] text-c4">
          {stream.failure}
        </p>
      ) : null}

      {startError ? (
        <div role="alert" className="mt-4">
          <p className="text-[14px] leading-[1.75] text-c4">{startError.message}</p>
          {startError.status === 401 ? (
            <Link
              href="/sign-in"
              className="mt-2 inline-block text-[14px] font-medium text-lamp underline underline-offset-4"
            >
              다시 로그인하기
            </Link>
          ) : null}
          {startError.status === 400 && source === "upload" ? (
            <Link
              href="/app"
              className="mt-2 inline-block text-[14px] font-medium text-lamp underline underline-offset-4"
            >
              폴더 다시 올리기
            </Link>
          ) : null}
        </div>
      ) : null}

      {finished ? <FinishedNote finished={finished} /> : null}
    </div>
  );
}

/** What is on screen while a run is going. */
function LiveRun({
  stream,
  source,
}: {
  stream: AnalysisStreamState;
  source: "github" | "upload";
}) {
  const rank = stream.phase ? PHASE_ORDER.indexOf(stream.phase) : 0;

  const steps: { phase: AnalysisPhase; doing: string; done: string; detail?: string }[] = [
    {
      phase: "ingest",
      // The same phase, two different things happening: one is a download and
      // the other is the folder already in hand. Telling someone who uploaded
      // from their laptop that we are fetching a repository is a small lie that
      // makes the rest of the screen less believable.
      doing: source === "upload" ? "올려주신 폴더 여는 중" : "저장소 가져오는 중",
      done: source === "upload" ? "폴더를 열었어요" : "저장소를 가져왔어요",
    },
    {
      phase: "static",
      doing: "파일 읽는 중",
      done: "파일을 다 읽었어요",
      detail:
        stream.filesOffered > 0
          ? `${stream.filesParsed.toLocaleString("ko-KR")} / ${stream.filesOffered.toLocaleString("ko-KR")}`
          : undefined,
    },
    // Only once a run has actually reached it. Naming the features is Step 4's
    // pass; showing a step that is never going to run would be a checklist with
    // a line that never gets a checkmark.
    ...(stream.sawSemantic
      ? [
          {
            phase: "semantic" as const,
            doing: "기능 이름 붙이는 중",
            done: "기능 이름을 다 붙였어요",
            detail:
              stream.featureCount > 0 ? `${stream.featureCount}개` : undefined,
          },
        ]
      : []),
    {
      phase: "done",
      doing: "연결 정리하는 중",
      done: "지도를 다 그렸어요",
    },
  ];

  return (
    <div className="rounded-2xl border border-edge bg-ink-raised p-6">
      <h2 className="text-[17px] font-semibold tracking-[-0.02em]">
        앱을 읽고 있어요
      </h2>
      <p className="mt-1.5 text-[14px] leading-[1.75] text-said-soft">
        이 화면을 닫거나 새로고침해도 괜찮아요. 하던 자리에서 이어서 보여드려요.
      </p>

      <div
        className="mt-5 h-1 w-full overflow-hidden rounded-full bg-edge"
        role="progressbar"
        aria-label="지도 그리기 진행"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(stream.progress * 100)}
      >
        <div
          className="h-full rounded-full bg-lamp transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(stream.progress * 100, 2)}%` }}
        />
      </div>

      <ol className="mt-5 space-y-2.5">
        {steps.map((step) => {
          const stepRank = PHASE_ORDER.indexOf(step.phase);
          const state =
            stream.finished || stepRank < rank
              ? "done"
              : stepRank === rank
                ? "active"
                : "waiting";

          return (
            <li key={step.phase} className="flex items-center gap-3">
              <StepMark state={state} />
              <span
                className={`text-[15px] ${
                  state === "waiting" ? "text-said-faint" : "text-said"
                }`}
              >
                {state === "done" ? step.done : step.doing}
              </span>
              {step.detail && state !== "waiting" ? (
                <span className="font-mono text-[13px] text-said-faint">
                  {step.detail}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      <Counts stream={stream} />

      {stream.link === "connecting" && !stream.finished ? (
        <p className="mt-4 text-[13px] text-said-faint">다시 연결하는 중…</p>
      ) : null}

      <details className="mt-5 border-t border-edge pt-4">
        <summary className="cursor-pointer text-[13px] text-said-faint hover:text-said-soft">
          자세히
        </summary>

        {stream.files.length > 0 ? (
          <ul className="mt-3 max-h-56 overflow-y-auto font-mono text-[12px] leading-[1.9] text-said-faint">
            {stream.files.map((path, index) => (
              <li key={`${path}-${index}`}>{path}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[13px] text-said-faint">아직 읽은 파일이 없어요.</p>
        )}

        {stream.skipped.length > 0 ? (
          <div className="mt-4">
            <p className="text-[13px] text-said-soft">
              읽지 못한 파일 {stream.skipped.length.toLocaleString("ko-KR")}개
            </p>
            <ul className="mt-2 max-h-40 overflow-y-auto text-[12px] leading-[1.9] text-said-faint">
              {stream.skipped.map((file, index) => (
                <li key={`${file.path}-${index}`}>
                  <span className="font-mono">{file.path}</span> — {file.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="mt-4 text-[12px] leading-[1.7] text-said-faint">
          새로고침한 뒤에는 그 다음부터 읽은 파일만 여기 보여요. 위의 숫자는
          처음부터의 개수예요.
        </p>
      </details>
    </div>
  );
}

function Counts({ stream }: { stream: AnalysisStreamState }) {
  if (stream.itemCount === 0 && stream.connectionCount === 0) return null;

  return (
    <div className="mt-5 border-t border-edge pt-4">
      <p className="text-[14px] leading-[1.8] text-said-soft">
        찾은 것 {stream.itemCount.toLocaleString("ko-KR")}개 · 이어진 연결{" "}
        {stream.connectionCount.toLocaleString("ko-KR")}개
      </p>
      {stream.connectionCount > 0 ? (
        <p className="mt-1 text-[13px] leading-[1.8] text-said-faint">
          {stream.inferredCount === 0
            ? "모두 코드에서 확인한 연결이에요."
            : `코드에서 확인한 연결 ${stream.certainCount.toLocaleString("ko-KR")}개 · 짐작한 연결 ${stream.inferredCount.toLocaleString("ko-KR")}개`}
        </p>
      ) : null}
    </div>
  );
}

function FinishedNote({ finished }: { finished: Finished }) {
  return (
    <div className="mt-4 rounded-xl border border-edge bg-ink p-4">
      <p className="text-[14px] leading-[1.8] text-said">
        지도를 다 그렸어요. 찾은 것 {finished.itemCount.toLocaleString("ko-KR")}개 ·
        이어진 연결 {finished.connectionCount.toLocaleString("ko-KR")}개.
      </p>
      {finished.connectionCount > 0 && finished.inferredCount > 0 ? (
        <p className="mt-1 text-[13px] leading-[1.8] text-said-faint">
          이 중 {finished.inferredCount.toLocaleString("ko-KR")}개는 짐작한
          연결이에요.
        </p>
      ) : null}
      {finished.limits.length > 0 ? (
        <ul className="mt-2 space-y-1 text-[13px] leading-[1.8] text-said-faint">
          {finished.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StepMark({ state }: { state: "waiting" | "active" | "done" }) {
  // One fixed-width slot whichever mark is in it, so the labels line up rather
  // than stepping sideways as each row completes.
  return (
    <span aria-hidden className="flex w-3 shrink-0 justify-center">
      {state === "done" ? (
        <span className="text-[13px] leading-none text-lamp">✓</span>
      ) : (
        <span
          className={`inline-block size-[7px] rounded-full ${
            state === "active" ? "animate-pulse bg-lamp" : "border border-said-faint"
          }`}
        />
      )}
    </span>
  );
}
