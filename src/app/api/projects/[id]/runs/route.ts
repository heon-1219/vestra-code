import { and, desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import type { RunRecord, RunsResponse } from "@/components/workspace/history/runs";
import { db } from "@/db";
import { analysisRuns, projects } from "@/db/schema";
import { getSession } from "@/lib/session";

/**
 * Every run of one project, newest first — the 변경 기록 band's data.
 *
 * The graph endpoint next door answers "what does my project look like now".
 * This one answers "what happened to it, and when": each row is a dated
 * snapshot, and the band turns consecutive rows into a difference.
 *
 * It sends counts and never rows. A history of thirty runs that each carried
 * their own graph would be megabytes for a strip four percent of a screen
 * tall, and there is nothing on that strip that a node id could be used for.
 */

export const runtime = "nodejs";
// One person's project, so nothing here may be held anywhere shared.
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

const UNAUTHENTICATED = "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.";

/**
 * The same answer for "no such project" and "somebody else's project", copied
 * from the graph endpoint deliberately. A 403 would confirm the id exists,
 * which tells a stranger something true about another user's account.
 */
const NOT_FOUND = "이 프로젝트를 찾지 못했어요. 목록에서 다시 열어 주세요.";

/**
 * How far back one request looks.
 *
 * The band is a strip; maximised it is a list somebody scrolls for a moment.
 * Thirty is more than either can use and enough that nobody reaches the end of
 * it in a session, and a cursor for the rest is a feature nobody has asked for.
 * What matters is that the truncation is *declared* rather than silent — the
 * oldest run in a truncated window is not the project's first run, and the band
 * must not be able to say that it is.
 */
const LIMIT = 30;

export async function GET(
  _request: NextRequest,
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

  const rows = await db
    .select({
      id: analysisRuns.id,
      status: analysisRuns.status,
      commitSha: analysisRuns.commitSha,
      nodeCount: analysisRuns.nodeCount,
      edgeCount: analysisRuns.edgeCount,
      filesParsed: analysisRuns.filesParsed,
      filesSkipped: analysisRuns.filesSkipped,
      error: analysisRuns.error,
      startedAt: analysisRuns.startedAt,
      finishedAt: analysisRuns.finishedAt,
    })
    .from(analysisRuns)
    .where(eq(analysisRuns.projectId, project.id))
    // `started_at`, not `finished_at`: a run in flight has no end, and ordering
    // by a null would put the thing happening right now at the bottom.
    .orderBy(desc(analysisRuns.startedAt))
    // One more than we will send, purely to find out whether there are older
    // ones. Cheaper than a second count query and exact.
    .limit(LIMIT + 1);

  const body: RunsResponse = {
    runs: rows.slice(0, LIMIT).map(toRecord),
    truncated: rows.length > LIMIT,
  };

  return Response.json(body, {
    // A run's row changes when it finishes and at no other time, and the band
    // asks again when it sees one finish.
    headers: { "Cache-Control": "private, no-store" },
  });
}

type RunRow = {
  id: string;
  status: RunRecord["status"];
  commitSha: string | null;
  nodeCount: number;
  edgeCount: number;
  filesParsed: number;
  /** A `jsonb` column, so genuinely unknown until it has been looked at. */
  filesSkipped: unknown;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

/**
 * One row, in the shape the band's schema defines.
 *
 * The renames are `view.ts`'s rule, applied at the same boundary it applies it
 * at: past here nothing is a node or an edge. `analyzer` and the skipped
 * *paths* are deliberately dropped — the first is the name of a component of
 * this program, and the second is a list of filenames nobody is going to read
 * off a strip. The count of them is the part that is worth saying.
 */
function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    status: row.status,
    // ISO rather than a Date, because this crosses a JSON boundary and a Date
    // would arrive as a string anyway — better said in the type than found out.
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    commitSha: row.commitSha,
    itemCount: row.nodeCount,
    connectionCount: row.edgeCount,
    filesParsed: row.filesParsed,
    skippedCount: Array.isArray(row.filesSkipped) ? row.filesSkipped.length : 0,
    error: row.error,
  };
}
