import { and, eq, sql } from "drizzle-orm";

import { edges as edgesTable, nodes as nodesTable } from "@/db/schema";

import type { GraphDb } from "../persist";

import { refKey, type NodeText } from "./ask";

/**
 * Where a purpose sentence lives, and why it is not a table.
 *
 * `FLOW_TRACKING.md` §4 proposed `edge_purposes(projectId, purposeKey)` and
 * §12.1 said to measure before adding it. Measured on the two real projects,
 * and the numbers sent it the other way — the decision and the arithmetic are
 * in `DECISIONS.md`; the short version is three facts:
 *
 *  1. **The sentence is not a copy of anything that already exists.** On
 *     `vestra-code`, 674 of 801 purposes — every `calls`, `renders`, `fetches`
 *     and `uses_package` one — point at a node with **no `summary` at all**,
 *     because D54 and D87 keep symbol summaries lazy on purpose and Pass 2
 *     refuses to describe a package. §12.1's worry that "for a `calls` edge the
 *     purpose is close to the target's `nodes.summary`" is false on real data.
 *     So something has to store it.
 *  2. **It cannot go on the target node.** The 127 `imports` purposes point at
 *     files whose `summary` Pass 2 already wrote, and the 22 `uses_package`
 *     ones point at libraries we are not entitled to describe.
 *  3. **The duplication a table would prevent is 2.14×, not 40×.** 1,711
 *     connections carry 801 distinct sentences — about 150 KB — and they are
 *     written from one map keyed on `purposeKey`, so two connections in one
 *     group cannot disagree within a run. Against that, `load.ts` already
 *     selects `edges.metadata` (D83 put the call-site line there), while a
 *     table would make the map's loader compute an analysis-layer key to join
 *     on. That is the read path this product runs on every page view.
 *
 * ## The one change that makes it work
 *
 * `persistGraph` re-writes `edges.metadata` wholesale on every run. So the edge
 * upsert now keeps an existing `purpose` the way the node upsert already keeps
 * `label`, `summary` and `text_lang` — Pass 1 does not touch what a later pass
 * owns. Without it the previous run's sentences would be gone by the time this
 * pass looked for them, and every run would pay full price.
 */

/** Rows per statement. `persist.ts`'s reasoning, at two bound columns. */
const CHUNK = 500;

/**
 * Sentences already stored, by **edge row id**.
 *
 * Deliberately not keyed by `purposeKey`: a purpose's key contains the target's
 * natural key, and a symbol's `container` is not a column — it lives inside the
 * id hash, which is the same limitation `semantic/persist.ts` records. So the
 * caller, which has this run's graph and can therefore hash an edge, maps these
 * back onto purposes itself.
 *
 * Only rows that actually carry one are returned, so on a project that has
 * never run this pass the query brings back nothing.
 */
export async function loadStoredPurposes(
  db: GraphDb,
  projectId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: edgesTable.id,
      purpose: sql<string | null>`${edgesTable.metadata} ->> 'purpose'`,
    })
    .from(edgesTable)
    .where(
      and(
        eq(edgesTable.projectId, projectId),
        sql`${edgesTable.metadata} -> 'purpose' is not null`,
      ),
    );

  const stored = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.purpose === "string" && row.purpose !== "") {
      stored.set(row.id, row.purpose);
    }
  }
  return stored;
}

/**
 * The Korean Pass 2 has put on the graph, by natural key.
 *
 * Read for every node type rather than only files, which is the difference from
 * `loadSemanticState`: a `calls` purpose is about a symbol, and 결제 버튼 is
 * better evidence for what calling it is for than `PayButton` is. Rows whose
 * text came from another language are ignored (D2) for the same reason the
 * outline ignores them — a row tagged `en` is not an answer in this one.
 *
 * A symbol's `container` is not selected, for the reason above, so a method's
 * key is reconstructed without one and simply fails to match. That loses the
 * label for a method and never mislabels one, which is the safe direction.
 */
export async function loadPurposeText(
  db: GraphDb,
  projectId: string,
): Promise<Map<string, NodeText>> {
  const rows = await db
    .select({
      type: nodesTable.type,
      name: nodesTable.name,
      filePath: nodesTable.filePath,
      label: nodesTable.label,
      summary: nodesTable.summary,
      textLang: nodesTable.textLang,
    })
    .from(nodesTable)
    // Only rows the loop below keeps. Filtered in SQL so the rows nobody named
    // do not cross the wire at all (D159) — the answer is the same map.
    .where(
      and(
        eq(nodesTable.projectId, projectId),
        eq(nodesTable.textLang, "ko"),
        sql`(${nodesTable.label} is not null or ${nodesTable.summary} is not null)`,
      ),
    );

  const text = new Map<string, NodeText>();
  for (const row of rows) {
    if (row.textLang !== "ko") continue;
    if (row.label === null && row.summary === null) continue;
    const key = refKey({
      type: row.type,
      filePath: row.filePath ?? "",
      ...(row.type === "file" ? {} : { name: row.name }),
    });
    text.set(key, { label: row.label, summary: row.summary });
  }
  return text;
}

/**
 * Write one sentence onto every connection that shares it.
 *
 * `metadata || jsonb_build_object(...)` rather than a replacement, because
 * `edges.metadata` already carries the call-site line D83 put there and the
 * import specifier the analyzers write. Clobbering those to add a sentence
 * would trade "PayButton.tsx 34줄에서" for it, which is the wrong half.
 *
 * Two guards, both in SQL rather than in a filter somebody has to remember:
 *
 *   - `origin <> 'user'`, because section 6.1 rule 2 says a connection the user
 *     corrected is not something re-analysis gets to argue with.
 *   - `project_id = $1`, because an id is a hash and a hash from another
 *     project should find nothing rather than something.
 */
export async function writePurposes(
  db: GraphDb,
  projectId: string,
  byEdgeId: ReadonlyMap<string, string>,
): Promise<number> {
  let written = 0;

  for (const batch of chunk([...byEdgeId.entries()], CHUNK)) {
    const values = batch.map(
      ([id, sentence]) => sql`(${id}::text, ${sentence}::text)`,
    );

    const updated = await db.execute(sql`
      update ${edgesTable} as e
      set metadata = e.metadata || jsonb_build_object('purpose', v.purpose)
      from (values ${sql.join(values, sql`, `)}) as v(id, purpose)
      where e.id = v.id
        and e.project_id = ${projectId}
        and e.origin <> 'user'
      returning e.id
    `);

    written += rowCount(updated);
  }

  return written;
}

/**
 * Take the sentence off connections this pass no longer stands behind (D169).
 *
 * Only ever handed the connections of purposes set aside (D160) — a test's
 * helper, a fixture, anything only a test reaches for. Nobody asks about those
 * any more, so a sentence an earlier run left there would never be refreshed
 * and would go on describing whatever the code used to be, on the one run
 * that tells the person the model did not read these files. The structural
 * verb underneath is the parser's and stays.
 *
 * A budget stop never reaches this: a purpose the budget did not get to keeps
 * its sentence, because that one is still the last true thing we knew.
 * `origin <> 'user'` for the same reason as everywhere else in this pass.
 */
export async function clearPurposes(
  db: GraphDb,
  projectId: string,
  edgeIds: readonly string[],
): Promise<number> {
  let cleared = 0;
  for (const batch of chunk([...new Set(edgeIds)], CHUNK)) {
    const updated = await db.execute(sql`
      update ${edgesTable} as e
      set metadata = e.metadata - 'purpose'
      where e.project_id = ${projectId}
        and e.id in (${sql.join(
          batch.map((id) => sql`${id}`),
          sql`, `,
        )})
        and e.origin <> 'user'
        and e.metadata -> 'purpose' is not null
      returning e.id
    `);
    cleared += rowCount(updated);
  }
  return cleared;
}

/**
 * `db.execute` returns the driver's result, whose shape differs between the
 * pool and a transaction. Both carry the rows; counting them is the one fact
 * this needs, and asking for `rowCount` directly is not portable across the two.
 */
function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}
