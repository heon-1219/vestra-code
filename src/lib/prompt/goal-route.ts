import { z } from "zod";

import type { Llm } from "@/lib/llm/types";

import { GOAL_NOTES, restateGoal, type GoalPlace } from "./goal";
import { ROUTE_WORDS } from "./owned";

/**
 * `POST /api/projects/:id/prompt`, with everything it touches handed in.
 *
 * The route file is a few lines that wire the real session, database and model
 * into this, and this is what the tests drive. The split exists for the reason
 * this codebase keeps rediscovering: `@/db` and `@/lib/llm` both reach
 * `env.ts`, which throws at import time on a machine without all 21 variables,
 * so a test that imported the route would be testing the environment.
 *
 * ## What it does, and what it deliberately does not
 *
 * It restates the person's goal — the one job §6.4 gives a model — and returns
 * it. It does **not** build the prompt: the browser already holds the graph the
 * person is looking at and the switches they set, and building from those is
 * what guarantees the prompt describes the map on screen rather than a second
 * read of it that could have moved. It does **not** store anything either
 * (D154): the founder's own words on this were "굳이 DB에 저장할 필요는 없을듯",
 * and the prompt is in the person's clipboard, which is where it is used.
 *
 * ## The order of the refusals is the order of what could leak
 *
 *   1. No session: 401, before the body is even read.
 *   2. Not this person's project: 404, with the same sentence as a project that
 *      does not exist.
 *   3. Only then is anything about the project read — and the selection's names
 *      are looked up **inside that project**, so an id from somebody else's
 *      project names nothing.
 */

export type GoalRouteDeps = {
  /** Who is signed in, or null. */
  session: () => Promise<{ user: { id: string } } | null>;
  /** The project, only if it belongs to `userId`. */
  findOwnedProject: (projectId: string, userId: string) => Promise<{ id: string } | null>;
  /** The named items, only those that belong to `projectId`. */
  selectionNames: (projectId: string, ids: readonly string[]) => Promise<GoalPlace[]>;
  /**
   * The model the person picked, or the installation's default when they did
   * not pick one. Null when that model has no key — honoured or refused, never
   * swapped for another, the rule `/ask` keeps.
   */
  llm: (model: "mimo" | "gemini" | "custom" | undefined) => Llm | null;
  signal?: AbortSignal;
};

export type RouteReply = { status: number; body: Record<string, unknown> };

const paramsSchema = z.object({ id: z.uuid() });

const bodySchema = z.object({
  request: z.string().trim().min(1).max(2000),
  /** One today. Twenty is a ceiling on a lookup, not a feature. */
  selectionIds: z.array(z.string().min(1).max(200)).min(1).max(20),
  model: z.enum(["mimo", "gemini", "custom"]).optional(),
});

export async function handleGoalRequest(
  deps: GoalRouteDeps,
  rawParams: unknown,
  rawBody: () => Promise<unknown>,
): Promise<RouteReply> {
  const session = await deps.session();
  if (!session) return refuse(ROUTE_WORDS.unauthenticated, 401);

  const params = paramsSchema.safeParse(rawParams);
  if (!params.success) return refuse(ROUTE_WORDS.notFound, 404);

  const project = await deps.findOwnedProject(params.data.id, session.user.id);
  if (!project) return refuse(ROUTE_WORDS.notFound, 404);

  let body: unknown;
  try {
    body = await rawBody();
  } catch {
    return refuse(ROUTE_WORDS.unreadable, 400);
  }
  const asked = bodySchema.safeParse(body);
  if (!asked.success) return refuse(ROUTE_WORDS.unreadable, 400);

  const llm = deps.llm(asked.data.model);
  if (!llm) return refuse(ROUTE_WORDS.noModel, 409);

  const places = await deps.selectionNames(project.id, asked.data.selectionIds);
  const outcome = await restateGoal({
    llm,
    request: asked.data.request,
    places,
    signal: deps.signal,
  });

  return outcome.ok
    ? { status: 200, body: { goal: outcome.goal, note: null } }
    : { status: 200, body: { goal: null, reason: outcome.reason, note: GOAL_NOTES[outcome.reason] } };
}

function refuse(message: string, status: number): RouteReply {
  return { status, body: { message } };
}
