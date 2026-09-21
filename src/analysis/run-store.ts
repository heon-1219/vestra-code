import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, inArray } from "drizzle-orm";

import type { Db } from "@/db";
import { analysisEvents, analysisRuns } from "@/db/schema";

import type { AnalysisEvent, EventSink } from "./events";

/**
 * Where an analysis run's events live between the pipeline and the browser.
 *
 * The pipeline never talks to a browser. It writes numbered events here, and
 * the SSE endpoint reads them back by cursor. That indirection is the whole
 * point of D16: a page refresh mid-run opens a brand new request with no access
 * to the emitter the first one was using, so anything held only in memory is
 * gone. Persisted events with a monotonic sequence make recovery a `seq > n`
 * query instead of a reconnection protocol.
 */

/** A run row, as both routes and the reaper need it. */
export type AnalysisRunRow = typeof analysisRuns.$inferSelect;

/**
 * How long a run may go without writing anything before we call it dead.
 *
 * It has to sit above the longest legitimately silent stretch, which is Pass
 * 2's single LLM call, and below the point where a user gives up and reloads.
 * Nothing else in the run is silent for more than a second or two: Pass 1 emits
 * a line per file.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

const STALE_MESSAGE =
  "분석이 중간에 멈췄어요. 저장소 화면에서 다시 시작해 주세요.";

/** Ordered, persisted event output for exactly one run. */
export type RunStore = {
  /** Assigns the next sequence number and persists the event. */
  emit: EventSink;
  /** Resolves once everything emitted so far has reached the database. */
  flush: () => Promise<void>;
};

export async function createRun(db: Db, projectId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(analysisRuns).values({ id, projectId, status: "pending" });
  return id;
}

/**
 * Events per statement. Five bound columns each, so far under Postgres's
 * 65,535-parameter ceiling; the number only has to stop one statement growing
 * without bound on a repository of thousands of files.
 */
const EVENT_BATCH = 500;

type EventRow = typeof analysisEvents.$inferInsert;

export function createRunStore(db: Db, runId: string): RunStore {
  let seq = 0;

  /**
   * Writes are chained rather than issued in parallel. A reader asks for
   * `seq > cursor` and moves its cursor forward as it goes, so an event that
   * commits after a higher-numbered one has already been read is an event the
   * reader has stepped past and will never come back for — a progress line
   * missing from one browser and present in another, with nothing to show for
   * it in any log.
   *
   * **Chained, but not one row at a time.** Events that arrive while a write
   * is in flight wait in `pending` and go out together in the next statement.
   * Measured on a full re-read of `vestra-code` (D159): 268 `file.parsed`
   * events took **22.9 seconds** to reach the database one round trip at a
   * time, while the parser that produced them was long finished — the run's
   * "parse" phase was mostly this queue. A multi-row insert is one statement
   * and so commits all or nothing, and the statements are still issued one
   * after another in sequence order, so no reader can ever see a higher
   * number before a lower one. The ordering argument above is untouched.
   */
  let tail: Promise<void> = Promise.resolve();
  const pending: EventRow[] = [];
  let scheduled = false;

  const write = async () => {
    scheduled = false;
    while (pending.length > 0) {
      const rows = pending.splice(0, EVENT_BATCH);
      try {
        await db.insert(analysisEvents).values(rows);
      } catch (error) {
        // One bad row must not cost its neighbours their progress lines, so a
        // statement that fails is retried row by row and only what still
        // fails is dropped. Rows keep their order, so the rule above holds.
        console.error("[run-store] event batch failed, writing one by one", runId, error);
        for (const row of rows) {
          try {
            await db.insert(analysisEvents).values(row);
          } catch (rowError) {
            // A dropped progress line must never take the analysis down with
            // it. The reader orders by sequence, so the gap is stepped over
            // rather than waited on. Technical detail to the log, per section 8.
            console.error("[run-store] event insert failed", runId, row.seq, row.type, rowError);
          }
        }
      }
    }
  };

  const emit: EventSink = (type, payload) => {
    seq += 1;
    pending.push({ id: randomUUID(), runId, seq, type, payload });

    // One write queued at a time. A write that has not started yet will take
    // this row with it; one that has started is followed by another.
    if (!scheduled) {
      scheduled = true;
      tail = tail.then(write);
    }
    return tail;
  };

  return { emit, flush: () => tail };
}

/**
 * Events after `cursor`, oldest first.
 *
 * `limit` caps one page rather than one run: a browser attaching to a finished
 * run of a large repository replays thousands of events, and loading them all
 * into one array before writing a single byte is how an SSE endpoint manages to
 * feel slower than no streaming at all.
 */
export async function readEventsAfter(
  db: Db,
  runId: string,
  cursor: number,
  limit: number,
): Promise<AnalysisEvent[]> {
  const rows = await db
    .select({
      seq: analysisEvents.seq,
      type: analysisEvents.type,
      payload: analysisEvents.payload,
    })
    .from(analysisEvents)
    .where(and(eq(analysisEvents.runId, runId), gt(analysisEvents.seq, cursor)))
    .orderBy(analysisEvents.seq)
    .limit(limit);

  // These rows were written by `createRunStore` a few lines up, so the shape is
  // ours by construction, not external input. The cast is only the boundary
  // between a `jsonb` column (necessarily `unknown`) and the event contract.
  return rows as AnalysisEvent[];
}

/** The run the client asked for, scoped to a project the caller already owns. */
export async function loadRun(
  db: Db,
  projectId: string,
  runId: string,
): Promise<AnalysisRunRow | null> {
  const [run] = await db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.id, runId), eq(analysisRuns.projectId, projectId)))
    .limit(1);

  return run ?? null;
}

/** The newest run of this project that still claims to be working, if any. */
export async function findActiveRun(
  db: Db,
  projectId: string,
): Promise<AnalysisRunRow | null> {
  const [run] = await db
    .select()
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.projectId, projectId),
        inArray(analysisRuns.status, ["pending", "running"]),
      ),
    )
    .orderBy(desc(analysisRuns.startedAt))
    .limit(1);

  return run ?? null;
}

/**
 * The run the stored graph was last measured against.
 *
 * This is the base an incremental re-analysis compares the new commit to, and
 * "completed" is load-bearing: a failed run never sweeps (D20), so the rows in
 * the table still belong to the last run that finished, not to the last run
 * that started. Taking the newest run regardless of status would date the
 * graph to a commit it was never measured at, and every file that changed
 * between the two would be treated as unchanged — stale rows, silently.
 */
export async function findBaseRun(
  db: Db,
  projectId: string,
): Promise<AnalysisRunRow | null> {
  const [run] = await db
    .select()
    .from(analysisRuns)
    .where(
      and(eq(analysisRuns.projectId, projectId), eq(analysisRuns.status, "completed")),
    )
    .orderBy(desc(analysisRuns.finishedAt), desc(analysisRuns.startedAt))
    .limit(1);

  return run ?? null;
}

/**
 * Close out a run whose process is gone.
 *
 * The pipeline runs detached from any request, so nothing survives a restart or
 * a crash to mark its own run failed. The row would stay `running` for ever:
 * every later start would hand the user back a run id that will never produce
 * another event, and every browser attached to it would wait for a completion
 * that is not coming. Rather than a startup sweep — which cannot tell our own
 * previous process from a second instance still working — a run is judged by
 * when it last wrote something.
 *
 * Deliberately also appends the `run.failed` event, not just the status: the
 * SSE endpoint closes on that event, so reaping here is what lets an attached
 * browser find out and stop waiting.
 *
 * Returns true when this call reaped the run.
 */
export async function reapStaleRun(db: Db, run: AnalysisRunRow): Promise<boolean> {
  if (run.status !== "pending" && run.status !== "running") return false;

  const [latest] = await db
    .select({ seq: analysisEvents.seq, createdAt: analysisEvents.createdAt })
    .from(analysisEvents)
    .where(eq(analysisEvents.runId, run.id))
    .orderBy(desc(analysisEvents.seq))
    .limit(1);

  const lastActivity = Math.max(
    run.startedAt.getTime(),
    latest?.createdAt.getTime() ?? 0,
  );
  if (Date.now() - lastActivity < STALE_AFTER_MS) return false;

  await db
    .update(analysisRuns)
    .set({ status: "failed", error: STALE_MESSAGE, finishedAt: new Date() })
    .where(eq(analysisRuns.id, run.id));

  // Sequence read from the table rather than from a counter, because whichever
  // process owned that counter is exactly what is missing here. Two reapers
  // racing is possible and harmless: the unique index on (run, seq) rejects the
  // loser, and the run is already failed either way.
  try {
    await db.insert(analysisEvents).values({
      id: randomUUID(),
      runId: run.id,
      seq: (latest?.seq ?? 0) + 1,
      type: "run.failed",
      payload: { message: STALE_MESSAGE },
    });
  } catch (error) {
    console.error("[run-store] reap event insert failed", run.id, error);
  }

  return true;
}
