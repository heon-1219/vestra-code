import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { heartbeatFrame, SSE_HEADERS, toSseFrame } from "@/analysis/events";
import { loadRun, readEventsAfter, reapStaleRun } from "@/analysis/run-store";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getSession } from "@/lib/session";

/**
 * Watch an analysis run.
 *
 * Nothing is computed here. The pipeline writes numbered events to the database
 * and this tails them from a cursor, which is what lets a browser reload
 * mid-run and pick up exactly where it left off: `Last-Event-ID` comes back on
 * the reconnect and becomes the cursor (D16).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });
const runIdSchema = z.uuid();
/** A cursor the browser sent back to us. Anything else starts from the top. */
const cursorSchema = z.coerce.number().int().min(0);

const UNAUTHENTICATED = "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.";
const NOT_FOUND = "이 프로젝트를 찾지 못했어요. 목록에서 다시 열어 주세요.";
const RUN_NOT_FOUND = "이 분석 기록을 찾지 못했어요. 페이지를 새로고침해 주세요.";

/** Fast enough to feel live, slow enough that a run is a few hundred queries. */
const POLL_INTERVAL_MS = 400;
/**
 * How slow the poll is allowed to get while nothing is happening.
 *
 * A run is not a steady stream of events; it is bursts separated by silence.
 * Measured over the nine real runs in the database: **84% of the 400ms polls
 * returned no rows**, and the longest gap between two events was 43 seconds —
 * Pass 2's model call, which emits nothing while it thinks. Polling a database
 * in Singapore six hundred times through a wait like that is the app's largest
 * single source of query traffic, and every one of those queries holds a pool
 * client for a moment.
 *
 * So the poll slows down when there is nothing to fetch and snaps back to
 * `POLL_INTERVAL_MS` the instant a row arrives. Replayed against those same
 * nine runs, that is **60% fewer queries** (910 to 363), and the price is the
 * worst single event appearing **0.85s later** than it would have. That price
 * is only ever paid at the end of a long silence — by definition, on a screen
 * that has not changed for tens of seconds — and never during the file-by-file
 * burst, which is the part a person actually watches move.
 *
 * The ceiling is chosen to keep that worst case **under a second**. A 3000ms
 * ceiling was measured too: 70% fewer queries, but 2.2s of delay, which is long
 * enough to read as a stall.
 */
const POLL_MAX_INTERVAL_MS = 1_600;
/** How fast it gives up hope. Measured alongside the ceiling above. */
const POLL_BACKOFF_FACTOR = 1.5;
/**
 * Railway closes a request after five minutes with no data transferred (D17),
 * and Pass 2's LLM call can be silent for longer than that on its own.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;
/** How often we check whether the run's process is still alive. */
const REAP_INTERVAL_MS = 60_000;
/**
 * Railway caps a request at fifteen minutes. Closing first makes the end of the
 * stream ours: EventSource reconnects on its own and sends `Last-Event-ID`, so
 * the user sees nothing, where a proxy kill mid-frame would hand the browser
 * half an event.
 */
const MAX_STREAM_MS = 14 * 60 * 1000;
/** One page of replay, so a finished run starts arriving immediately. */
const PAGE_SIZE = 500;
/** The database being unreachable is a reconnect, not a fabricated failure. */
const MAX_CONSECUTIVE_ERRORS = 5;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return Response.json({ message: UNAUTHENTICATED }, { status: 401 });
  }

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return Response.json({ message: NOT_FOUND }, { status: 404 });
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, params.data.id), eq(projects.userId, session.user.id)),
    )
    .limit(1);

  if (!project) {
    return Response.json({ message: NOT_FOUND }, { status: 404 });
  }

  const runId = runIdSchema.safeParse(request.nextUrl.searchParams.get("runId"));
  if (!runId.success) {
    return Response.json({ message: RUN_NOT_FOUND }, { status: 404 });
  }

  // Scoped to the project we just proved ownership of, so a run id guessed from
  // somewhere else resolves to nothing rather than to someone else's progress.
  const found = await loadRun(db, project.id, runId.data);
  if (!found) {
    return Response.json({ message: RUN_NOT_FOUND }, { status: 404 });
  }
  // Rebound after the check: TypeScript drops a null narrowing at a function
  // boundary, and everything below runs inside the stream's closure.
  const run = found;

  const cursor = readCursor(request);
  const encoder = new TextEncoder();

  let closed = false;
  const stop = () => {
    closed = true;
  };
  request.signal.addEventListener("abort", stop);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void pump(controller);
    },
    cancel: stop,
  });

  async function pump(controller: ReadableStreamDefaultController<Uint8Array>) {
    const openedAt = Date.now();
    let lastWriteAt = 0;
    let position = cursor;
    let errors = 0;
    /** Grows while the run is quiet, resets the moment it is not. */
    let interval = POLL_INTERVAL_MS;

    let lastReapAt = Date.now();

    const send = (frame: string): void => {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(frame));
        lastWriteAt = Date.now();
      } catch {
        // The client went away between the abort event and this write.
        closed = true;
      }
    };

    // Before anything else, so the browser's EventSource leaves `connecting`
    // even when the run has not written its first event yet.
    send(heartbeatFrame());

    // On connect, not only on the timer below. Someone opening the page for a
    // run whose process is gone should be told within a second, not after a
    // minute of watching a progress bar that was never going to move. Reaping
    // appends the failure event, so the loop below closes on it like any other.
    await reapStaleRun(db, run).catch(() => false);

    try {
      while (!closed) {
        let finished = false;

        try {
          const events = await readEventsAfter(db, run.id, position, PAGE_SIZE);
          errors = 0;

          // Something happened, so the next thing is likely to happen soon —
          // a run's events arrive in bursts. Decided here, next to the read
          // that is the evidence for it, rather than down beside the sleep.
          interval =
            events.length > 0
              ? POLL_INTERVAL_MS
              : Math.min(
                  POLL_MAX_INTERVAL_MS,
                  Math.round(interval * POLL_BACKOFF_FACTOR),
                );

          for (const event of events) {
            position = event.seq;
            send(toSseFrame(event));
            if (event.type === "run.completed" || event.type === "run.failed") {
              finished = true;
            }
          }

          // A full page means there is more waiting; go straight round again
          // rather than pacing a replay at four hundred milliseconds a page.
          if (!finished && events.length === PAGE_SIZE) continue;
        } catch (error) {
          console.error("[events] read failed", run.id, error);
          errors += 1;
          if (errors >= MAX_CONSECUTIVE_ERRORS) break;
        }

        if (finished || closed) break;
        if (Date.now() - openedAt >= MAX_STREAM_MS) break;

        if (Date.now() - lastWriteAt >= HEARTBEAT_INTERVAL_MS) {
          send(heartbeatFrame());
        }

        if (Date.now() - lastReapAt >= REAP_INTERVAL_MS) {
          lastReapAt = Date.now();
          // A run whose process died writes nothing more, so without this the
          // stream would sit here until the fourteen-minute cap and the user
          // would watch a progress bar that stopped moving. Reaping appends the
          // failure event, which the loop then picks up and closes on.
          const current = await loadRun(db, run.projectId, run.id);
          if (current) await reapStaleRun(db, current).catch(() => false);
        }

        await sleep(interval);
      }
    } finally {
      closed = true;
      request.signal.removeEventListener("abort", stop);
      try {
        controller.close();
      } catch {
        // Already closed by a cancel. Nothing to do and nothing to report.
      }
    }
  }

  return new Response(stream, { headers: { ...SSE_HEADERS } });
}

/**
 * Where to resume from.
 *
 * `Last-Event-ID` is what EventSource sends by itself on a reconnect, and is
 * therefore the one that matters. The query parameter is for a first connection
 * that already knows what it has, such as a page that rendered the run's events
 * on the server and only wants what came after.
 */
function readCursor(request: NextRequest): number {
  // Checked for presence before parsing, because `z.coerce.number()` turns a
  // missing header into 0 and would swallow the fallback below whole.
  const header = request.headers.get("Last-Event-ID");
  if (header !== null) {
    const parsed = cursorSchema.safeParse(header);
    if (parsed.success) return parsed.data;
  }

  const query = request.nextUrl.searchParams.get("cursor");
  if (query !== null) {
    const parsed = cursorSchema.safeParse(query);
    if (parsed.success) return parsed.data;
  }

  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
