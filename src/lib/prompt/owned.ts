import { and, eq, type SQL } from "drizzle-orm";

import { projects } from "@/db/schema";

/**
 * The one condition every project route asks before it does anything.
 *
 * `and(eq(projects.id, …), eq(projects.userId, session.user.id))` — the id the
 * URL named, **and** owned by whoever is signed in. Written once here for the
 * two routes this track adds, rather than re-typed in each, because the way a
 * route like this goes wrong is that one copy of the condition quietly loses
 * its second half and a stranger's project starts answering.
 *
 * Its own module, importing only the schema, so a test can render the SQL it
 * produces without a database — `@/db` reaches `env.ts`, which throws at import
 * on any machine without the full environment.
 */
export function ownedProject(projectId: string, userId: string): SQL {
  // `and` is typed as possibly undefined for the zero-argument case; with two
  // arguments it never is.
  return and(eq(projects.id, projectId), eq(projects.userId, userId)) as SQL;
}

/**
 * The sentences a refused request reads, shared by both routes.
 *
 * "No such project" and "somebody else's project" are the same 404 with the
 * same sentence. A 403 would confirm that the id exists, which tells a stranger
 * something true about another person's account.
 */
export const ROUTE_WORDS = {
  unauthenticated: "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.",
  notFound: "이 프로젝트를 찾지 못했어요.",
  unreadable: "무엇을 부탁하시는지 읽지 못했어요.",
  noModel:
    "아직 모델이 연결되지 않아서 할 수 없어요. 설정에 모델 열쇠를 넣어 주세요.",
} as const;
