import { and, eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/db";
import { nodes, projects } from "@/db/schema";
import { llmFor, llmFromEnv } from "@/lib/llm";
import { handleGoalRequest } from "@/lib/prompt/goal-route";
import { ownedProject } from "@/lib/prompt/owned";
import { getSession } from "@/lib/session";

/**
 * 프롬프트 만들기's one server call: restate the person's goal.
 *
 * Everything that decides anything is in `lib/prompt/goal-route.ts`, where it
 * is tested without an environment; this file only hands it the real session,
 * the real database and the real model. The prompt itself is built in the
 * browser from the graph on screen (`lib/prompt/build.ts`) and stored nowhere
 * (D154).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const reply = await handleGoalRequest(
    {
      session: getSession,
      async findOwnedProject(projectId, userId) {
        const [row] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(ownedProject(projectId, userId))
          .limit(1);
        return row ?? null;
      },
      async selectionNames(projectId, ids) {
        const rows = await db
          .select({ name: nodes.name, label: nodes.label, path: nodes.filePath })
          .from(nodes)
          // Inside this project only: an id from another project names nothing.
          .where(and(eq(nodes.projectId, projectId), inArray(nodes.id, [...ids])))
          .limit(20);
        return rows;
      },
      llm: (model) => (model ? llmFor(model) : llmFromEnv()),
      signal: request.signal,
    },
    await context.params,
    () => request.json(),
  );

  return Response.json(reply.body, {
    status: reply.status,
    // One person's words about one person's code. Nothing between them and us
    // keeps a copy.
    headers: { "Cache-Control": "no-store, private" },
  });
}
