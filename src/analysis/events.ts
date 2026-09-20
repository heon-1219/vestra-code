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
  | "run.completed"
  | "run.failed";

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
  "run.completed": {
    nodeCount: number;
    edgeCount: number;
    filesParsed: number;
    filesSkipped: number;
    /** Limits ingest hit, so the UI can say what is missing. */
    limits: string[];
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
