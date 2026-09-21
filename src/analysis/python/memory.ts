import { and, eq, sql } from "drizzle-orm";

import { nodes as nodesTable } from "@/db/schema";

import type { GraphDb } from "../persist";

import { LLM_ANSWER_KEY } from "./analyzer";
import { readRememberedAnswer, type RememberedAnswer } from "./llm";

/**
 * What the Python analyzer's model half was told last time, by file (D161).
 *
 * The answers live on the file nodes the analyzer returned, as
 * `metadata.llmAnswer`, because that is the one place a run's output survives
 * into the next one without a table of its own. This reads them back before
 * `analyze`, so the analyzer — which never touches the database — can be handed
 * a plain lookup.
 *
 * One query, and only the rows that have one: `jsonb -> key is not null`
 * rather than a scan in Node, so a project with thousands of symbols returns a
 * few dozen file rows.
 *
 * Anything that does not read back as an answer is left out rather than
 * trusted. A row somebody edited by hand, or one written by a version of this
 * code that stored a different shape, costs one fresh question and nothing
 * else — and every remembered answer is re-checked against the file on the
 * way in anyway (`collect` in `llm.ts`).
 */
export async function loadRememberedAnswers(
  db: GraphDb,
  projectId: string,
): Promise<Map<string, RememberedAnswer>> {
  const rows = await db
    .select({
      filePath: nodesTable.filePath,
      answer: sql<unknown>`${nodesTable.metadata} -> ${LLM_ANSWER_KEY}`,
    })
    .from(nodesTable)
    .where(
      and(
        eq(nodesTable.projectId, projectId),
        eq(nodesTable.type, "file"),
        sql`${nodesTable.metadata} -> ${LLM_ANSWER_KEY} is not null`,
      ),
    );

  const remembered = new Map<string, RememberedAnswer>();
  for (const row of rows) {
    if (!row.filePath) continue;
    const answer = readRememberedAnswer(row.answer);
    if (answer) remembered.set(row.filePath, answer);
  }
  return remembered;
}
