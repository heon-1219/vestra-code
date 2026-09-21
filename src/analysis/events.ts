import type { SetAsideCount } from "./set-aside";

/**
 * The analysis event stream.
 *
 * Every event is persisted with a monotonic sequence number per run before it
 * reaches anyone, and the SSE endpoint replays from a cursor. That is what
 * makes Step 3's "refresh mid-run without losing state" work: a browser that
 * reconnects asks for everything after the last sequence it saw, rather than
 * depending on an in-memory emitter that died with the previous request
 * (DECISIONS D16).
 *
 * The payloads are deliberately small. They are written to Postgres on every
 * emit, and a payload carrying whole nodes would make the events table larger
 * than the graph it describes.
 */

export type AnalysisEventType =
  | "run.started"
  | "phase.changed"
  | "file.parsed"
  | "file.skipped"
  | "nodes.added"
  | "edges.added"
  | "feature.created"
  | "node.assigned"
  | "llm.coverage"
  | "run.completed"
  | "run.failed";

/**
 * Why the model stopped before it had opened every file.
 *
 * Two families, and they must not be collapsed into one sentence: a budget was
 * a decision we took to keep the run quick and cheap, and a failure is
 * something that went wrong. Someone told "문제가 생겼어요" about a cap we chose
 * goes looking for a fault that does not exist; someone told "빨리 끝내려고
 * 멈췄어요" about a broken key never fixes the key.
 */
export type LlmCoverageReason =
  | "file_budget"
  | "token_budget"
  | "llm_error"
  | "aborted";

export type AnalysisEventPayloads = {
  "run.started": { analyzer: string; fileCount: number };
  "phase.changed": { phase: "ingest" | "static" | "semantic" | "done" };
  "file.parsed": { path: string; parsed: number; total: number };
  "file.skipped": { path: string; reason: string };
  /** Counts and a small sample, never the nodes themselves. */
  "nodes.added": { count: number; total: number };
  "edges.added": { count: number; total: number; certain: number; inferred: number };
  "feature.created": { name: string; memberCount: number };
  "node.assigned": { count: number };
  /**
   * How much of the project the model actually opened, when it did not open
   * all of it.
   *
   * **"We did not look" and "there is nothing there" are opposite claims**, and
   * a map drawn from a half-read project looks exactly like a map of a project
   * with few connections. This event is what lets the screen tell the two
   * apart, so it is emitted only when there is a shortfall to report: a run
   * with full coverage, and a run with no model at all, say nothing here rather
   * than putting a zero on screen that reads as a fault.
   *
   * Counts, not paths. Eighty filenames in a persisted payload would make this
   * row larger than everything else the run writes, and the number is the part
   * a person can act on.
   */
  "llm.coverage": {
    /** Files the model read. */
    examined: number;
    /** Files it never opened. Always above zero, or the event is not sent. */
    notExamined: number;
    reason: LlmCoverageReason;
  };
  "run.completed": {
    nodeCount: number;
    edgeCount: number;
    filesParsed: number;
    filesSkipped: number;
    /** Limits ingest hit, so the UI can say what is missing. */
    limits: string[];
    /**
     * Files we chose not to show the model, counted by why (D160).
     *
     * On the terminal event rather than on `llm.coverage`, because that event
     * is only sent when there is a shortfall and its `reason` is always a
     * budget or a failure — and a choice is neither. A run that read every
     * file it meant to and set aside a hundred tests has nothing to report
     * there and something to report here. The same fact also arrives as a
     * Korean sentence in `limits`, which every screen already shows.
     *
     * Optional: absent when nothing was set aside or no model is configured,
     * and absent from every stream written before this existed.
     */
    setAside?: SetAsideCount[];
  };
  /** Plain language for the user. Technical detail goes to logs, not here. */
  "run.failed": { message: string };
};

export type AnalysisEvent<T extends AnalysisEventType = AnalysisEventType> = {
  seq: number;
  type: T;
  payload: AnalysisEventPayloads[T];
};

/** What a producer calls. Sequencing and persistence are the sink's job. */
export type EventSink = <T extends AnalysisEventType>(
  type: T,
  payload: AnalysisEventPayloads[T],
) => Promise<void>;

/** Serialise one event in SSE wire format, with its id so a client can resume. */
export function toSseFrame(event: {
  seq: number;
  type: string;
  payload: unknown;
}): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

/**
 * A comment frame. Railway closes an HTTP request after five minutes with no
 * data transferred, and Pass 2's LLM call can exceed that on its own, so this
 * goes out unconditionally on a timer rather than only when something happens
 * (DECISIONS D17).
 */
export function heartbeatFrame(): string {
  return `: keepalive\n\n`;
}

/** Headers an SSE response must carry on our host. */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform matters: a proxy that gzips the stream will buffer it, and the
  // events arrive in one burst at the end instead of live.
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
