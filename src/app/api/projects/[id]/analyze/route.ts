import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { startAnalysis } from "@/analysis/pipeline";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getGithubToken } from "@/lib/github/token";
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

  const outcome = await startAnalysis({
    db,
    project: {
      id: project.id,
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      defaultBranch: project.defaultBranch,
      kind: project.kind,
    },
    githubToken,
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
