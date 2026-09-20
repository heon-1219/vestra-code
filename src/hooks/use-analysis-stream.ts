"use client";

import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import type { AnalysisEventPayloads, AnalysisEventType } from "@/analysis/events";

/**
 * Watching one analysis run from the browser.
 *
 * The rule this is built around: **the run is not attached to this page**. The
 * pipeline writes numbered events to the database and the SSE endpoint tails
 * them from a cursor (D16), so a refresh mid-run is not a recovery problem, it
 * is a new cursor. All this hook has to do is remember where it got to.
 *
 * `EventSource` already handles the hard half — it reconnects on its own and
 * sends `Last-Event-ID`, which the endpoint prefers over everything else. What
 * it cannot do is survive the page being thrown away, because a fresh
 * `EventSource` has no last id. So the sequence number is kept in
 * `sessionStorage`, and only the first connection of a page needs it.
 *
 * Two things here are not obvious and are both deliberate:
 *
 *   - **Progress does not finish when the files run out.** `file.parsed` carries
 *     an upper bound, not a total: ingest offers 22 files on the demo repo and
 *     the analyzer parses 18 of them, the rest being manifests and stylesheets.
 *     A bar driven by `parsed === total` sticks at 82% for ever. The bar is
 *     therefore capped below 100% until `run.completed` says so.
 *   - **The stream is closed on the terminal event, not left to time out.** An
 *     `EventSource` nobody closed keeps a connection open and keeps
 *     reconnecting, on a host that caps a request at fifteen minutes.
 */

export type AnalysisPhase = "ingest" | "static" | "semantic" | "done";

/** How the connection itself is doing, which is not how the run is doing. */
export type StreamLink = "idle" | "connecting" | "open" | "closed";

export type SkippedFile = { path: string; reason: string };

/**
 * How much of the project the model opened, when it did not open all of it.
 *
 * The payload as it comes off the wire. Null is the ordinary state and means
 * there is nothing to report — full coverage, or no model on this
 * installation at all — never "we do not know".
 */
export type AnalysisCoverage = AnalysisEventPayloads["llm.coverage"];

export type AnalysisStreamState = {
  /** Null until the first event arrives. */
  phase: AnalysisPhase | null;
  /**
   * True once the run has actually reached the naming pass. Pass 2 does not
   * exist yet, so a checklist that always shows a "naming features" step would
   * show a step that never completes.
   */
  sawSemantic: boolean;

  filesParsed: number;
  /** What ingest offered. An upper bound on `filesParsed`, never a total. */
  filesOffered: number;
  /** 0 to 1, and only 1 once the run says it is done. */
  progress: number;

  /** The most recent files read, newest last. Bounded; see RECENT_FILES. */
  files: string[];
  skipped: SkippedFile[];
  /**
   * How many files the run itself said it skipped.
   *
   * Not the length of `skipped`, and the difference matters after a refresh:
   * the browser replays from its cursor, so the list it holds starts partway
   * through the run while this number is the run's own final count. Zero until
   * `run.completed` says otherwise.
   */
  skippedTotal: number;

  itemCount: number;
  connectionCount: number;
  certainCount: number;
  inferredCount: number;
  featureCount: number;

  /**
   * What the model did not open, straight from `llm.coverage`.
   *
   * Null until the run says otherwise, and it stays null for a run with full
   * coverage or no model — the pipeline only emits when there is a shortfall,
   * so a null here is never a missing measurement being read as zero.
   */
  coverage: AnalysisCoverage | null;

  /** True once the run ended, whether it worked or not. */
  finished: boolean;
  /** Plain Korean, straight from the server. Null while things are fine. */
  failure: string | null;
  /** Anything ingest had to leave out, already in plain Korean. */
  limits: string[];

  link: StreamLink;
};

/**
 * How many filenames to keep.
 *
 * They live behind a collapsed row and nobody scrolls back through a thousand
 * of them; keeping every one of a large repo's paths in React state is memory
 * spent on something no one reads.
 */
const RECENT_FILES = 80;

/** Below 1 until the run says otherwise. See the note at the top. */
const PROGRESS_CEILING = 0.95;

/** Writing the cursor on every event is thousands of synchronous writes. */
const CURSOR_WRITE_INTERVAL_MS = 400;

const CONNECTION_LOST =
  "진행 상황을 더 이상 받아오지 못했어요. 페이지를 새로고침해 주세요.";

const IDLE: AnalysisStreamState = {
  phase: null,
  sawSemantic: false,
  filesParsed: 0,
  filesOffered: 0,
  progress: 0,
  files: [],
  skipped: [],
  skippedTotal: 0,
  itemCount: 0,
  connectionCount: 0,
  certainCount: 0,
  inferredCount: 0,
  featureCount: 0,
  coverage: null,
  finished: false,
  failure: null,
  limits: [],
  link: "idle",
};

// --- The wire contract, validated -----------------------------------------
// These come off the network, so they are checked rather than trusted, even
// though we wrote the other end. The mapped type is the part that matters: add
// an event to `AnalysisEventPayloads` without a schema here and this file stops
// compiling, so the two cannot drift.

const phaseSchema = z.enum(["ingest", "static", "semantic", "done"]);
const count = z.number().int().nonnegative();

const PAYLOAD_SCHEMAS: {
  [T in AnalysisEventType]: z.ZodType<AnalysisEventPayloads[T]>;
} = {
  "run.started": z.object({ analyzer: z.string(), fileCount: count }),
  "phase.changed": z.object({ phase: phaseSchema }),
  "file.parsed": z.object({ path: z.string(), parsed: count, total: count }),
  "file.skipped": z.object({ path: z.string(), reason: z.string() }),
  "nodes.added": z.object({ count, total: count }),
  "edges.added": z.object({
    count,
    total: count,
    certain: count,
    inferred: count,
  }),
  "feature.created": z.object({ name: z.string(), memberCount: count }),
  "node.assigned": z.object({ count }),
  "llm.coverage": z.object({
    examined: count,
    notExamined: count,
    reason: z.enum(["file_budget", "token_budget", "llm_error", "aborted"]),
  }),
  "run.completed": z.object({
    nodeCount: count,
    edgeCount: count,
    filesParsed: count,
    filesSkipped: count,
    limits: z.array(z.string()),
  }),
  "run.failed": z.object({ message: z.string() }),
};

/**
 * Follow `runId` until it ends.
 *
 * Pass `null` for `runId` when nothing is running; the hook then holds the idle
 * state and opens no connection at all.
 */
export function useAnalysisStream(
  projectId: string,
  runId: string | null,
): AnalysisStreamState {
  /**
   * The state is stored with the run it belongs to.
   *
   * A new run has to start from nothing — inheriting the last one's counters
   * would show the user numbers from a run that is already over. The obvious
   * way to do that is to clear the state in the effect that opens the stream,
   * but that is a second render on every run change, and for one frame the
   * screen shows the old run's numbers under the new run's heading. Keeping the
   * run id next to the state makes the reset something the render can see
   * rather than something it has to be told.
   */
  const [tracked, setTracked] = useState<{
    runId: string | null;
    state: AnalysisStreamState;
  }>(() => ({ runId, state: startingState(runId) }));

  const pending = useMemo(() => startingState(runId), [runId]);
  const state = tracked.runId === runId ? tracked.state : pending;

  useEffect(() => {
    if (!runId) return;

    /** Applies an update, discarding anything left over from a previous run. */
    const update = (
      change: (previous: AnalysisStreamState) => AnalysisStreamState,
    ) => {
      setTracked((previous) => ({
        runId,
        state: change(
          previous.runId === runId ? previous.state : startingState(runId),
        ),
      }));
    };

    const source = new EventSource(streamUrl(projectId, runId, readCursor(runId)));

    let cursorWrittenAt = 0;
    const rememberCursor = (seq: string) => {
      // Throttled rather than written per event: a large repo emits thousands,
      // and `sessionStorage` is synchronous. Losing up to 400ms of cursor costs
      // a replay of a handful of events, which the absolute counters absorb.
      const now = Date.now();
      if (now - cursorWrittenAt < CURSOR_WRITE_INTERVAL_MS) return;
      cursorWrittenAt = now;
      writeCursor(runId, seq);
    };

    /**
     * One listener per event type, each parsing its own payload.
     *
     * The cast is lib.dom's fault: `addEventListener` on an arbitrary event
     * name falls back to the overload that hands back a plain `Event`. Every
     * named frame on an SSE stream is a `MessageEvent` by specification.
     */
    const listen = <T extends AnalysisEventType>(
      type: T,
      apply: (
        payload: AnalysisEventPayloads[T],
        previous: AnalysisStreamState,
      ) => AnalysisStreamState,
      options: {
        /** Nothing is coming after this one. */
        terminal?: boolean;
        /**
         * Do not move the cursor past this event.
         *
         * For the one event that is said once and never restated. Every other
         * payload here is a running total, so a reload that lands past it
         * catches up on the next one — but `llm.coverage` is emitted once, in
         * the seconds between the analysis ending and `run.completed`, and a
         * cursor parked on it would replay straight over the fact that the
         * model never opened eighty files. Leaving the cursor where it was
         * costs a replay of the handful of events since the last write, all of
         * which are absolute and land on the same numbers.
         */
        sticky?: boolean;
      } = {},
    ) => {
      const { terminal = false, sticky = false } = options;
      source.addEventListener(type, (event) => {
        const message = event as MessageEvent<string>;

        let raw: unknown;
        try {
          raw = JSON.parse(message.data);
        } catch {
          // A frame we cannot read is one missing progress line. Dropping it is
          // right; taking the screen down over it is not.
          return;
        }

        const parsed = PAYLOAD_SCHEMAS[type].safeParse(raw);
        if (!parsed.success) return;

        update((previous) => withProgress(apply(parsed.data, previous)));

        if (terminal) {
          // Nothing else is coming, and the endpoint has already closed its
          // end. Forgetting the cursor matters as much as closing: a cursor
          // sitting past the last event would make the next connection wait
          // for an event that does not exist.
          forgetCursor(runId);
          source.close();
          update((previous) => ({ ...previous, link: "closed" }));
        } else if (!sticky) {
          rememberCursor(message.lastEventId);
        }
      });
    };

    source.onopen = () => {
      update((previous) =>
        previous.finished ? previous : { ...previous, link: "open" },
      );
    };

    source.onerror = () => {
      // `CONNECTING` is the ordinary case: the endpoint closes its own stream
      // before the host's fifteen-minute cap and the browser reconnects with
      // `Last-Event-ID`. Only `CLOSED` is a real end — a 401, a 404, or a
      // response the browser refused — and the browser will not retry it.
      const closed = source.readyState === EventSource.CLOSED;
      update((previous) => {
        if (previous.finished) return previous;
        if (!closed) return { ...previous, link: "connecting" };
        return { ...previous, link: "closed", failure: previous.failure ?? CONNECTION_LOST };
      });
    };

    listen("run.started", (payload, previous) => ({
      ...previous,
      filesOffered: Math.max(previous.filesOffered, payload.fileCount),
    }));

    listen("phase.changed", (payload, previous) => ({
      ...previous,
      phase: payload.phase,
      sawSemantic: previous.sawSemantic || payload.phase === "semantic",
    }));

    listen("file.parsed", (payload, previous) => ({
      ...previous,
      filesParsed: payload.parsed,
      filesOffered: Math.max(previous.filesOffered, payload.total),
      files: [...previous.files, payload.path].slice(-RECENT_FILES),
    }));

    listen("file.skipped", (payload, previous) => ({
      ...previous,
      skipped: [...previous.skipped, { path: payload.path, reason: payload.reason }].slice(
        -RECENT_FILES,
      ),
    }));

    // `total` on both of these is cumulative, not a delta, which is what makes
    // resuming from a cursor produce the right numbers rather than the numbers
    // since the reconnect.
    listen("nodes.added", (payload, previous) => ({
      ...previous,
      itemCount: payload.total,
    }));

    listen("edges.added", (payload, previous) => ({
      ...previous,
      connectionCount: payload.total,
      certainCount: payload.certain,
      inferredCount: payload.inferred,
    }));

    listen("feature.created", (_payload, previous) => ({
      ...previous,
      featureCount: previous.featureCount + 1,
    }));

    listen("node.assigned", (_payload, previous) => previous);

    // The one fact on this stream that is not a number about what we found, but
    // a number about what we never looked at. Sticky, so a refresh in the gap
    // before `run.completed` cannot silently drop it — see `listen`.
    listen(
      "llm.coverage",
      (payload, previous) => ({ ...previous, coverage: payload }),
      { sticky: true },
    );

    listen(
      "run.completed",
      (payload, previous) => ({
        ...previous,
        phase: "done",
        // The run's own figures win over anything counted along the way: these
        // are what was actually written, after rows that could not be written
        // were dropped.
        itemCount: payload.nodeCount,
        connectionCount: payload.edgeCount,
        filesParsed: payload.filesParsed,
        skippedTotal: payload.filesSkipped,
        limits: payload.limits,
        finished: true,
        failure: null,
      }),
      { terminal: true },
    );

    listen(
      "run.failed",
      (payload, previous) => ({
        ...previous,
        finished: true,
        failure: payload.message,
      }),
      { terminal: true },
    );

    return () => {
      // Unconditional. An `EventSource` left open after unmount holds a
      // connection to a route that polls the database every 400ms, for as long
      // as the tab lives.
      source.close();
    };
  }, [projectId, runId]);

  return state;
}

/** What a run looks like before it has said anything. */
function startingState(runId: string | null): AnalysisStreamState {
  return runId ? { ...IDLE, link: "connecting" } : IDLE;
}

function streamUrl(projectId: string, runId: string, cursor: number): string {
  const url = `/api/projects/${encodeURIComponent(projectId)}/events?runId=${encodeURIComponent(runId)}`;
  return cursor > 0 ? `${url}&cursor=${cursor}` : url;
}

function withProgress(state: AnalysisStreamState): AnalysisStreamState {
  // A run that failed did not reach the end, so its bar does not either.
  if (state.finished && !state.failure) return { ...state, progress: 1 };
  if (state.filesOffered === 0) return { ...state, progress: 0 };
  return {
    ...state,
    progress: Math.min(state.filesParsed / state.filesOffered, PROGRESS_CEILING),
  };
}

// --- The cursor ------------------------------------------------------------
// Every access is wrapped: `sessionStorage` throws outright in a browser with
// site data blocked, and losing the cursor costs a replay, where an exception
// here would cost the whole screen.

function cursorKey(runId: string): string {
  return `vestra:analysis:${runId}`;
}

function readCursor(runId: string): number {
  try {
    const raw = window.sessionStorage.getItem(cursorKey(runId));
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeCursor(runId: string, seq: string): void {
  if (!seq) return;
  try {
    window.sessionStorage.setItem(cursorKey(runId), seq);
  } catch {
    // Replaying from the start on the next load is a fine outcome.
  }
}

function forgetCursor(runId: string): void {
  try {
    window.sessionStorage.removeItem(cursorKey(runId));
  } catch {
    // Nothing to do, and nothing worth telling anyone.
  }
}
