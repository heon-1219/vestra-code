import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { NOT_STORED_MESSAGE } from "@/analysis/ingest/restore";
import { startAnalysis, type AnalysisProject } from "@/analysis/pipeline";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getGithubToken } from "@/lib/github/token";
import { llmFromEnv } from "@/lib/llm";
import { storageUsageFor } from "@/lib/preview/store";
import { getSession } from "@/lib/session";

/**
 * Start an analysis run, and say which one.
 *
 * This endpoint does not stream. It returns a run id as soon as there is one,
 * and the browser opens `GET .../events?runId=` to watch (D16). Splitting the
 * two is what makes a refresh mid-run recover: the run is not attached to any
 * request, so losing a request loses nothing.
 */

export const runtime = "nodejs";
// The answer depends on who is asking and what is already running, so there is
// nothing here to cache or prerender.
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

const UNAUTHENTICATED = "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.";

/**
 * Deliberately the same answer for "no such project" and "someone else's
 * project" (section 8). A 403 would confirm that the id exists, which tells a
 * stranger something about another user's account.
 */
const NOT_FOUND = "이 프로젝트를 찾지 못했어요. 목록에서 다시 열어 주세요.";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    // 401 rather than a redirect: this is called with fetch, and a redirect to
    // the sign-in page would arrive as an HTML body where JSON was expected.
    return Response.json({ message: UNAUTHENTICATED }, { status: 401 });
  }

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    // A malformed id is indistinguishable from a missing one, to the user and
    // to us.
    return Response.json({ message: NOT_FOUND }, { status: 404 });
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.id, params.data.id), eq(projects.userId, session.user.id)),
    )
    .limit(1);

  if (!project) {
    return Response.json({ message: NOT_FOUND }, { status: 404 });
  }

  // Resolved here, not inside the pipeline: the run outlives this request, and
  // the token can only be read while the request's cookies are still in scope.
  const githubToken = await getGithubToken(request.headers);

  // An uploaded folder has no origin to fetch from, so a re-read is possible
  // only for a project whose files we kept. Asked here rather than left to the
  // run: a project uploaded before we kept anything should meet a sentence it
  // can act on, not a run that starts, spins and then fails. One indexed count.
  if (project.source === "upload") {
    const kept = await storageUsageFor(db, project.id);
    if (kept.rows === 0) {
      return Response.json({ message: NOT_STORED_MESSAGE }, { status: 400 });
    }
  }

  const analysisProject = toAnalysisProject(project);
  if (!analysisProject) {
    return Response.json({ message: NOT_FOUND }, { status: 404 });
  }

  // No `upload` payload, ever, from this endpoint. Nobody picked a folder to
  // get here, so the run rebuilds one from what we stored.
  const outcome = await startAnalysis({
    db,
    project: analysisProject,
    githubToken,
    // Resolved here rather than inside the pipeline: reading it means importing
    // `env.ts`, which validates the whole environment at import. Null when no
    // key is configured, and the Python analyzer then runs its parser half
    // alone — a smaller honest graph rather than a failure.
    llm: llmFromEnv(),
  });

  if (!outcome.ok) {
    return Response.json({ message: outcome.message }, { status: 400 });
  }

  // 202 either way. `started` is false when a run was already in flight and we
  // handed back that one instead of racing a second against it.
  return Response.json(
    { runId: outcome.runId, started: outcome.started },
    { status: 202 },
  );
}

/**
 * The row as the pipeline wants it, or null when there is nothing to run on.
 *
 * A GitHub project missing its owner, name or branch is a row that should not
 * exist. There is nothing to fetch and nothing to tell the user beyond "we
 * could not find it" — the same answer as a project that is not theirs, for the
 * same reason.
 */
function toAnalysisProject(
  project: typeof projects.$inferSelect,
): AnalysisProject | null {
  if (project.source === "upload") {
    return { id: project.id, source: "upload", kind: project.kind };
  }
  if (!project.repoOwner || !project.repoName || !project.defaultBranch) {
    return null;
  }
  return {
    id: project.id,
    source: "github",
    repoOwner: project.repoOwner,
    repoName: project.repoName,
    defaultBranch: project.defaultBranch,
    kind: project.kind,
  };
}
