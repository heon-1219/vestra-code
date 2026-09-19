import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { projects } from "@/db/schema";
import { loadGraphView } from "@/lib/graph/load";
import { getSession } from "@/lib/session";

/**
 * The map of one project, as `src/lib/graph/view.ts` defines it.
 *
 * This exists so the map can be redrawn without a full page load — after a run
 * finishes, or when the user comes back to a tab that was open through one.
 * The server-rendered project page loads the same view through the same
 * function, so there is one description of what a graph is and not two.
 */

export const runtime = "nodejs";
// Scoped to the person asking, so there is nothing here that could be shared
// between two of them.
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

const UNAUTHENTICATED = "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.";

/**
 * The same answer for "no such project" and "somebody else's project", matching
 * the other two handlers. A 403 would confirm the id exists, which tells a
 * stranger something true about another user's account.
 */
const NOT_FOUND = "이 프로젝트를 찾지 못했어요. 목록에서 다시 열어 주세요.";

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

  // An empty graph is an answer, not an error: a project that has never been
  // analysed returns no items and a null run, and the page reads that as "offer
  // to start" rather than as a failure.
  const view = await loadGraphView(db, project.id);

  return Response.json(view, {
    // The graph changes when a run finishes and at no other time, and the
    // client asks again when it sees one finish. Nothing here may be held by a
    // shared cache — it is one person's project.
    headers: { "Cache-Control": "private, no-store" },
  });
}
