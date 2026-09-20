import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { edges as edgesTable, nodes as nodesTable } from "@/db/schema";

import { nodeId, normalizePath } from "../ids";
import type { GraphDb } from "../persist";

import type { PreviousFeature } from "./features";
import { refKey, type KnownText } from "./outline";
import type { SemanticText } from "./pass";
import { TEXT_LANG } from "./words";

/**
 * The three columns Pass 1 refuses to touch, and the two reads that make this
 * pass incremental.
 *
 * `persistGraph` deliberately leaves `label`, `summary` and `textLang` out of
 * its upsert — its own header says why: listing them would null them on every
 * re-analysis, so a run whose semantic pass then failed would leave the user
 * with a map that had lost every plain-language name it used to have. The
 * consequence is that Pass 2 needs a writer of its own, and this is it.
 *
 * That same omission is what makes carry-forward free. An unchanged file's row
 * is re-upserted by Pass 1 with its text untouched, or in an incremental run is
 * not written at all — either way the Korean survives, and the saving is
 * *not asking*, not copying.
 */

/** Rows per statement. `persist.ts`'s reasoning, at four bound columns. */
const CHUNK = 500;

/** What the previous run left behind, in the two shapes this pass reads. */
export type SemanticState = {
  /** Plain-language text already on a row, by natural key (`refKey`). */
  known: Map<string, KnownText>;
  /** Features and their members, so a key survives a rename (D55). */
  previousFeatures: PreviousFeature[];
};

/**
 * Read what is already there.
 *
 * Runs after Pass 1 has written, which is the only moment both halves are
 * true: this run's nodes are in the table (so a file that moved has a row) and
 * the sweep has not happened yet (so last run's features are still there to be
 * matched against).
 *
 * Two queries, and neither returns source. `label` and `summary` are our own
 * prose about the project, not the project's own text.
 */
export async function loadSemanticState(
  db: GraphDb,
  projectId: string,
): Promise<SemanticState> {
  const rows = await db
    .select({
      id: nodesTable.id,
      type: nodesTable.type,
      name: nodesTable.name,
      filePath: nodesTable.filePath,
      label: nodesTable.label,
      summary: nodesTable.summary,
      textLang: nodesTable.textLang,
      metadata: nodesTable.metadata,
    })
    .from(nodesTable)
    .where(eq(nodesTable.projectId, projectId));

  const known = new Map<string, KnownText>();
  const featureRows = new Map<string, { key: string; label: string | null }>();

  for (const row of rows) {
    // The container is not selected — it lives inside the id hash rather than
    // in a column — so a ref reconstructed here is only ever used for the two
    // node types that have no container: files and features.
    if (row.type === "file") {
      known.set(
        refKey({ type: "file", filePath: row.filePath ?? "" }),
        { label: row.label, summary: row.summary, textLang: row.textLang },
      );
    }
    if (row.type === "feature") {
      featureRows.set(row.id, { key: row.name, label: row.label });
    }
  }

  const previousFeatures: PreviousFeature[] = [];
  if (featureRows.size > 0) {
    const members = new Map<string, string[]>();
    const ids = [...featureRows.keys()];

    for (const batch of chunk(ids, CHUNK)) {
      const found = await db
        .select({
          featureId: edgesTable.targetNodeId,
          path: nodesTable.filePath,
        })
        .from(edgesTable)
        .innerJoin(nodesTable, eq(nodesTable.id, edgesTable.sourceNodeId))
        .where(
          and(
            eq(edgesTable.projectId, projectId),
            eq(edgesTable.type, "belongs_to"),
            inArray(edgesTable.targetNodeId, batch),
          ),
        );

      for (const row of found) {
        if (!row.path) continue;
        const list = members.get(row.featureId);
        if (list) list.push(row.path);
        else members.set(row.featureId, [row.path]);
      }
    }

    for (const [id, feature] of featureRows) {
      previousFeatures.push({
        key: feature.key,
        label: feature.label,
        memberPaths: members.get(id) ?? [],
      });
    }
    // Ordered, so two runs over the same database match features in the same
    // order and `featureKey` resolves a tie the same way both times.
    previousFeatures.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  return { known, previousFeatures };
}

/**
 * Write the Korean onto the rows it belongs to.
 *
 * One statement per chunk rather than one per row: a 120-file project is 120
 * round trips to Singapore otherwise, which is most of a minute of a wait the
 * user is watching.
 *
 * Two guards, both in SQL rather than in a filter somebody has to remember:
 *
 *   - `origin <> 'user'`, because section 6.1 rule 2 says a name the user typed
 *     is not something re-analysis gets to argue with.
 *   - `project_id = $1`, because an id is a hash and a hash from another
 *     project is exactly the kind of thing that should find nothing rather than
 *     something.
 *
 * `textLang` is written on every row (D2). A row without it is a row a second
 * language cannot later be added beside.
 */
export async function writeSemanticText(
  db: GraphDb,
  projectId: string,
  text: readonly SemanticText[],
): Promise<number> {
  // Deduped by id, last write winning, because two refs for the same thing are
  // one row and a VALUES list naming it twice makes the join ambiguous.
  const byId = new Map<string, { label: string; summary: string | null }>();
  for (const row of text) {
    byId.set(nodeId(projectId, row.ref), { label: row.label, summary: row.summary });
  }

  let written = 0;
  for (const batch of chunk([...byId.entries()], CHUNK)) {
    const values = batch.map(
      ([id, row]) =>
        sql`(${id}::text, ${row.label}::text, ${row.summary}::text, ${TEXT_LANG}::text)`,
    );

    const updated = await db.execute(sql`
      update ${nodesTable} as n
      set label = v.label, summary = v.summary, text_lang = v.text_lang, updated_at = now()
      from (values ${sql.join(values, sql`, `)}) as v(id, label, summary, text_lang)
      where n.id = v.id
        and n.project_id = ${projectId}
        and n.origin <> 'user'
      returning n.id
    `);

    written += rowCount(updated);
  }

  return written;
}

/**
 * Delete the groupings this run no longer stands behind.
 *
 * A `belongs_to` edge whose source file did not change is stamped by
 * `carryForwardSkipped`'s `outgoing` rule regardless of what this run decided,
 * which is correct for a `calls` edge the file owns and wrong for a grouping we
 * just re-derived: it would leave the file in the feature it used to be in
 * **and** the one it is in now, and `grouping.ts` would quietly hand it to
 * whichever has more members.
 *
 * Safe because the pass restates every grouping it keeps — a fresh answer and a
 * carried-forward one both come back as rows stamped with this run. So a
 * `belongs_to` this run did not stamp is one nothing believes any more.
 *
 * `origin = 'llm'` only. A grouping the user fixed by hand is theirs (section
 * 6.1 rule 2), and D9 suppresses the machine's version of it rather than
 * deleting either.
 */
export async function sweepStaleFeatureLinks(
  db: GraphDb,
  projectId: string,
  runId: string,
): Promise<number> {
  const removed = await db
    .delete(edgesTable)
    .where(
      and(
        eq(edgesTable.projectId, projectId),
        eq(edgesTable.type, "belongs_to"),
        eq(edgesTable.origin, "llm"),
        // `<>` is not true for NULL, so a row written before this column
        // existed would otherwise survive every sweep for ever.
        or(isNull(edgesTable.lastSeenRunId), ne(edgesTable.lastSeenRunId, runId)),
      ),
    )
    .returning({ id: edgesTable.id });
  return removed.length;
}

/**
 * Clear the Korean off rows that no longer have an answer.
 *
 * Not called today and kept out of the pass on purpose: a label with no current
 * evidence behind it is still the last true thing we knew, and blanking it
 * would turn a run that merely ran out of budget into a map that lost its
 * words. Exported so the decision is visible rather than absent.
 */
export async function clearSemanticText(
  db: GraphDb,
  projectId: string,
  ids: readonly string[],
): Promise<number> {
  let cleared = 0;
  for (const batch of chunk([...ids], CHUNK)) {
    const updated = await db
      .update(nodesTable)
      .set({ label: null, summary: null, textLang: null })
      .where(
        and(
          eq(nodesTable.projectId, projectId),
          ne(nodesTable.origin, "user"),
          inArray(nodesTable.id, batch),
        ),
      )
      .returning({ id: nodesTable.id });
    cleared += updated.length;
  }
  return cleared;
}

/** The natural key for a file path, as `loadSemanticState` stores it. */
export function fileKey(path: string): string {
  return refKey({ type: "file", filePath: normalizePath(path) });
}

/**
 * `db.execute` returns the driver's result, whose shape differs between the
 * pool and a transaction. Both carry the rows; counting them is the one fact
 * this needs and asking for `rowCount` directly is not portable across the two.
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
