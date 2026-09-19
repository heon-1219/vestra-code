"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { useAnalysisStream } from "@/hooks/use-analysis-stream";
import type { GraphView } from "@/lib/graph/view";

import { AnalysisScreen } from "./analysis-screen";
import { DistrictMap } from "./map/district-map";
import { buildBeamIndex, runBeam, IDLE_BEAM } from "./map/beam";
import { PlacesPanel } from "./places-panel";
import { RightPanel, type ConnectionLock, type LockMap } from "./panel/connections-panel";
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
};

const startedSchema = z.object({ runId: z.uuid(), started: z.boolean() });
const messageSchema = z.object({ message: z.string() });

const GENERIC_START_ERROR = "지금은 시작하지 못했어요. 잠시 후에 다시 시도해 주세요.";
const OFFLINE_START_ERROR = "연결이 끊겼어요. 인터넷 연결을 확인하고 다시 시도해 주세요.";
const RELOAD_FAILED = "새로 그린 지도를 불러오지 못했어요. 페이지를 새로고침해 주세요.";

type StartError = { status: number; message: string };

export function Workspace({ project, initialView, activeRunId }: WorkspaceProps) {
  const [view, setView] = useState<GraphView>(initialView);
  const [runId, setRunId] = useState<string | null>(activeRunId);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<StartError | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [locks, setLocks] = useState<LockMap>({});
  const inputRef = useRef<HTMLInputElement>(null);

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

  const running = runId !== null;
  const hasGraph = view.items.length > 0;
  const neverRead = !hasGraph && view.lastRun === null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-edge px-4 py-2.5">
        <Link
          href="/app"
          className="shrink-0 text-[13px] text-said-faint transition-colors hover:text-said-soft"
        >
          ← 내 프로젝트
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold tracking-[-0.02em]">
            {project.displayName}
          </h1>
        </div>
        <p className="hidden shrink-0 text-[12px] text-said-faint sm:block">
          {project.source === "upload" ? (
            "내 컴퓨터에서 올린 폴더"
          ) : (
            <span className="font-mono">
              {project.repoOwner}/{project.repoName}
            </span>
          )}
        </p>
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

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(150px,15%)_minmax(0,1fr)_minmax(272px,25%)]">
        <PlacesPanel
          items={view.items}
          selectedId={selectedId}
          onSelect={onSelect}
          beam={beam}
          loading={running}
        />

        <section className="flex min-h-0 min-w-0 flex-col">
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
          </div>

          <div className="relative min-h-0 flex-1">
            {running ? (
              <AnalysisScreen
                projectName={project.displayName}
                source={project.source}
                progress={progress}
                onArrive={() => setRunId(null)}
                // An uploaded folder has nothing to fetch again (D66), so it is
                // offered no retry rather than one that cannot work.
                onRetry={project.source === "github" ? start : undefined}
              />
            ) : hasGraph ? (
              <DistrictMap
                items={view.items}
                connections={view.connections}
                query={query}
                selectedId={selectedId}
                onSelect={onSelect}
                className="absolute inset-0"
              />
            ) : (
              <EmptyCentre
                neverRead={neverRead}
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
          onRetry={project.source === "github" ? start : undefined}
          // The centre is already showing the checklist while a run goes; the
          // same five steps twice reads as two things happening.
          showRunSteps={false}
        />
      </div>

      {/*
        Section 4: the change timeline is out of scope for the MVP and this
        strip is its visual placeholder. It says so — an inert row of dots with
        no explanation would read as a broken control.
      */}
      <div className="flex shrink-0 items-center gap-3 border-t border-edge px-4 py-1.5 text-[11px] text-said-faint">
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
  );
}

function EmptyCentre({
  neverRead,
  failed,
  error,
  source,
  starting,
  onStart,
}: {
  neverRead: boolean;
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
            : "코드를 한 번 읽어서 앱의 지도를 그릴게요. 파일과 그 사이의 연결만 저장하고, 코드 자체는 보관하지 않아요."}
        </p>

        {source === "upload" && !neverRead ? (
          <p className="mt-4 text-[13px] leading-[1.75] text-said-faint">
            올려주신 폴더는 코드를 보관하지 않아서, 다시 읽으려면 폴더를 한 번 더
            골라주셔야 해요.
          </p>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={starting}
            className="mt-6 rounded-lg bg-paper px-5 py-2.5 text-[14px] font-semibold text-ink transition-colors hover:bg-lamp disabled:opacity-55"
          >
            {starting ? "시작하는 중…" : failed ? "다시 해보기" : "지도 그리기"}
          </button>
        )}
      </div>
    </div>
  );
}
