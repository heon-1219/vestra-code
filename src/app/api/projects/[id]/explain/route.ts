import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { investigate } from "@/qa";
import { EXPLAIN_BUDGET, prepareExplain } from "@/qa/explain";
import { githubSourceReader, storedSourceReader } from "@/qa/readers";
import { db } from "@/db";
import { analysisRuns, projects } from "@/db/schema";
import { ASK_SSE_HEADERS, askEventStream } from "@/lib/ask/stream";
import { getGithubToken } from "@/lib/github/token";
import { loadGraphView } from "@/lib/graph/load";
import { llmFor, llmFromEnv } from "@/lib/llm";
import { ownedProject } from "@/lib/prompt/owned";
import { storageUsageFor } from "@/lib/preview/store";
import { getSession } from "@/lib/session";

/**
 * 설명하기, the deep read: one place, opened and explained, streamed.
 *
 * The decisions — who may ask, and every sentence a refusal says — live in
 * `qa/explain.ts`, where they are tested without an environment. This file
 * wires the real session, database, model and source into them, then runs
 * `investigate()` — the same loop `/ask` runs, with its citation ledger — and
 * streams its trace over the same transport, **including the heartbeat**:
 * Railway closes a request after five minutes with nothing on the wire (D17),
 * and a model thinking inside one step is exactly that silence.
 *
 * The frames are `/ask`'s frames, name for name, so the browser folds them with
 * the same reducer (`lib/ask/session.ts`) and there is one reading of "what
 * the loop just did", not two.
 *
 * Nothing is stored. The answer goes to one browser and nowhere else (D154).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const prepared = await prepareExplain(
    {
      session: getSession,
      async findOwnedProject(projectId, userId) {
        const [row] = await db
          .select({
            id: projects.id,
            source: projects.source,
            repoOwner: projects.repoOwner,
            repoName: projects.repoName,
            defaultBranch: projects.defaultBranch,
          })
          .from(projects)
          .where(ownedProject(projectId, userId))
          .limit(1);
        return row ?? null;
      },
      llm: (model) => (model ? llmFor(model) : llmFromEnv()),
      async loadGraph(projectId) {
        const view = await loadGraphView(db, projectId);
        return { items: view.items, connections: view.connections };
      },
      async storedFiles(projectId) {
        return (await storageUsageFor(db, projectId)).rows;
      },
      async sourceFor(project) {
        if (project.source === "upload") return storedSourceReader(db, project.id);
        if (!project.repoOwner || !project.repoName) return null;
        /*
         * The commit the map was measured at, as `/ask` does: the line ranges
         * in the graph belong to that tree, and reading the branch tip would
         * cite line 120 of a file whose line 120 has moved.
         */
        const [run] = await db
          .select({ commitSha: analysisRuns.commitSha })
          .from(analysisRuns)
          .where(
            and(
              eq(analysisRuns.projectId, project.id),
              eq(analysisRuns.status, "completed"),
              isNotNull(analysisRuns.commitSha),
            ),
          )
          .orderBy(desc(analysisRuns.startedAt))
          .limit(1);
        return githubSourceReader({
          owner: project.repoOwner,
          repo: project.repoName,
          ref: run?.commitSha ?? project.defaultBranch ?? "HEAD",
          // Read here, after the ownership check and while the request's
          // cookies are still in scope — before the stream starts.
          token: await getGithubToken(request.headers),
        });
      },
    },
    await context.params,
    () => request.json(),
  );

  if (!prepared.ok) {
    return Response.json(
      { message: prepared.message },
      { status: prepared.status, headers: { "Cache-Control": "no-store, private" } },
    );
  }

  const { plan } = prepared;
  const stream = askEventStream({
    signal: request.signal,
    async run(send) {
      try {
        const investigation = await investigate({
          question: plan.question,
          graph: plan.graph,
          llm: plan.llm,
          source: plan.source,
          focus: { items: [plan.item] },
          budget: EXPLAIN_BUDGET,
          effort: plan.effort,
          signal: request.signal,
          onEvent: send,
        });
        send("qa.answer", {
          summary: investigation.summary,
          findings: investigation.findings,
          ruledOut: investigation.ruledOut,
          stop: investigation.stop,
          spent: investigation.spent,
        });
      } catch (error) {
        console.error("[explain] investigation failed", plan.project.id, error);
        send("qa.answer", {
          summary: "읽어 보는 도중에 문제가 생겼어요. 잠시 후에 다시 눌러 주세요.",
          findings: [],
          ruledOut: [],
          stop: "llm_failed",
          spent: null,
        });
      }
    },
  });

  return new Response(stream, { headers: { ...ASK_SSE_HEADERS } });
}
