import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { toSseFrame } from "@/analysis/events";
import { githubSourceReader, storedSourceReader } from "@/qa/readers";
import { investigate } from "@/qa";
import { db } from "@/db";
import { analysisRuns, projects } from "@/db/schema";
import { getGithubToken } from "@/lib/github/token";
import { loadGraphView } from "@/lib/graph/load";
import { llmFor, llmFromEnv } from "@/lib/llm";
import { getSession } from "@/lib/session";

/**
 * Asking a question about one project, and watching it be answered.
 *
 * This is the endpoint that turns "아직 준비 중이에요" into a working feature.
 * It runs the investigation loop and **streams its trace**, because the trace
 * is most of the value: a person who cannot read code is being told something
 * about their own app, and the only thing that makes that trustworthy is
 * watching where the answer came from. An answer that appears after fifteen
 * silent seconds is a verdict; the same answer with five steps visible in front
 * of it is an account.
 *
 * Server-Sent Events, in the same frame shape the analysis stream already uses
 * — one machinery for "something is happening", not two.
 *
 * ## What this refuses
 *
 *   - **No session, or somebody else's project: the same 404.** A 403 would
 *     confirm the id exists, which tells a stranger something true about
 *     another person's account.
 *   - **No model configured: 409 and a sentence.** Not an empty stream and not
 *     a fabricated answer. The panel already says the same thing in the box.
 *   - **A model the caller named but we have no key for: refused, never
 *     silently swapped.** Answering with a different model than the one on
 *     screen is a lie the user cannot see.
 *
 * ## Source access
 *
 * The loop can read the user's files, and which files it may read is decided
 * here rather than by the loop: a GitHub project is fetched on demand, an
 * uploaded one is read from what we kept (D77). A project with neither gets a
 * loop with no `read_source`, which can only produce `inferred` findings — the
 * honest ceiling rather than a failure.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

const askSchema = z.object({
  question: z.string().min(1).max(2000),
  /** Which model, when the caller has been shown a choice. */
  model: z.enum(["mimo", "gemini", "custom"]).optional(),
  effort: z.enum(["fast", "deep"]).optional(),
});

const UNAUTHENTICATED = "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.";
const NOT_FOUND = "이 프로젝트를 찾지 못했어요.";
const UNREADABLE = "무엇을 물어보시는지 읽지 못했어요.";
const NO_MODEL =
  "아직 모델이 연결되지 않아서 답해 드릴 수 없어요. 설정에 모델 열쇠를 넣어 주세요.";
const NO_GRAPH =
  "아직 지도를 그리지 않아서 찾아볼 곳이 없어요. 먼저 지도 그리기를 눌러 주세요.";

function refuse(message: string, status: number) {
  return Response.json({ message }, { status });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return refuse(UNAUTHENTICATED, 401);

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return refuse(NOT_FOUND, 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse(UNREADABLE, 400);
  }
  const asked = askSchema.safeParse(body);
  if (!asked.success) return refuse(UNREADABLE, 400);

  const [project] = await db
    .select({
      id: projects.id,
      source: projects.source,
      repoOwner: projects.repoOwner,
      repoName: projects.repoName,
      defaultBranch: projects.defaultBranch,
    })
    .from(projects)
    .where(
      and(eq(projects.id, params.data.id), eq(projects.userId, session.user.id)),
    )
    .limit(1);

  // The same answer for "no such project" and "somebody else's project".
  if (!project) return refuse(NOT_FOUND, 404);

  /*
   * A named model is honoured or refused, never quietly replaced.
   *
   * `llmFor` returns null for a provider with no key rather than falling back,
   * because the name of the model is on screen beside the answer: answering
   * with a different one is a difference the person cannot see and would have
   * no reason to suspect.
   */
  const llm = asked.data.model ? llmFor(asked.data.model) : llmFromEnv();
  if (!llm) return refuse(NO_MODEL, 409);

  const view = await loadGraphView(db, project.id);
  // Nothing to look through. Said plainly rather than answered from nothing.
  if (view.items.length === 0) return refuse(NO_GRAPH, 409);

  /*
   * Which commit the source should be read at.
   *
   * The last completed run's, because the line ranges in the graph were
   * measured against that tree. Reading the branch tip instead would cite line
   * 120 of a file whose line 120 has since moved — quietly wrong in exactly the
   * way an answer with a citation must never be.
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

  // Read while the request's cookies are still in scope.
  const token = await getGithubToken(request.headers);

  const source =
    project.source === "upload"
      ? storedSourceReader(db, project.id)
      : project.repoOwner && project.repoName
        ? githubSourceReader({
            owner: project.repoOwner,
            repo: project.repoName,
            ref: run?.commitSha ?? project.defaultBranch ?? "HEAD",
            token,
          })
        : null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: { seq: number; type: string; payload: unknown }) => {
        try {
          controller.enqueue(encoder.encode(toSseFrame(event)));
        } catch {
          // The reader went away mid-answer. `request.signal` aborts the loop
          // just below; there is nothing to do about an enqueue on a closed
          // stream except not crash the request that owns it.
        }
      };

      let seq = 0;
      try {
        const investigation = await investigate({
          question: asked.data.question,
          graph: { items: view.items, connections: view.connections },
          llm,
          source,
          effort: asked.data.effort,
          signal: request.signal,
          onEvent: (type, payload) => {
            seq += 1;
            send({ seq, type, payload });
          },
        });

        /*
         * The answer is its own frame, not a `QaEvent`.
         *
         * The loop's trace says what happened; this says what it came to. They
         * are different things to a reader and folding the second into the
         * first would make the UI guess which trace entry was the conclusion.
         */
        seq += 1;
        send({
          seq,
          type: "qa.answer",
          payload: {
            summary: investigation.summary,
            findings: investigation.findings,
            ruledOut: investigation.ruledOut,
            stop: investigation.stop,
            spent: investigation.spent,
          },
        });
      } catch (error) {
        console.error("[ask] investigation failed", project.id, error);
        seq += 1;
        send({
          seq,
          type: "qa.answer",
          payload: {
            summary: "찾아보는 도중에 문제가 생겼어요. 잠시 후에 다시 물어봐 주세요.",
            findings: [],
            ruledOut: [],
            stop: "llm_failed",
            spent: null,
          },
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // One person's question and one person's source. Nothing between them
      // and us may hold a copy.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, private",
      Connection: "keep-alive",
      // Nginx and friends buffer a stream into uselessness without this.
      "X-Accel-Buffering": "no",
    },
  });
}
