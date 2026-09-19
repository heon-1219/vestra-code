import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import type { Db } from "@/db";
import { edges as edgesTable, nodes as nodesTable } from "@/db/schema";

import { edgeId, nodeId, normalizePath, type NodeRef } from "./ids";
import type { AnalyzedEdge, AnalyzedNode, Origin } from "./types";

/**
 * Writing a run's graph to Postgres, and the re-analysis rules.
 *
 * The analyzer is pure and addresses everything by natural key, so this module
 * is where a NodeRef becomes a row id — analyzers never hash (see `ids.ts`).
 *
 * Three rules from the brief and the decisions log shape everything here:
 *
 *   - **Nodes before edges, always** (D31). Edges carry foreign keys to nodes
 *     and a `renders` edge routinely names a target whose file has not been
 *     visited yet, so the brief's "loop each file, write nodes and edges" is
 *     not implementable. Two passes, and any edge whose endpoints still do not
 *     resolve is dropped and counted rather than lost quietly.
 *
 *   - **The sweep runs only after a successful run** (D20). Rows are staged by
 *     stamping `lastSeenRunId`, and `promoteRun` deletes what this run did not
 *     see. A failed run simply never calls it, so the previous graph stands
 *     instead of being replaced by a partial one.
 *
 *   - **User rows win** (section 6.1 rule 2). Nothing here updates or deletes a
 *     row whose `origin` is `user`, which is enforced in SQL — a `setWhere` on
 *     every upsert and an `origin <> 'user'` on every delete — rather than by
 *     remembering to filter at each call site.
 *
 * What this module deliberately does NOT write: `label`, `summary` and
 * `textLang`. Those are Pass 2's columns. If Pass 1 listed them in its upsert
 * they would be nulled on every re-analysis, and a run whose semantic pass then
 * failed would leave the user with a map that had lost every plain-language
 * name it used to have.
 */

/**
 * Rows per INSERT statement.
 *
 * A 300-file repo is thousands of rows, and one statement per row against Neon
 * in Singapore is minutes of round trips. The ceiling is Postgres' 65535 bound
 * parameters per statement: nodes bind 13 columns, so ~5000 rows would fit.
 * 500 leaves an order of magnitude of headroom for a column being added later,
 * keeps a single statement small enough to be readable in a slow-query log, and
 * still turns the measured demo graph (38 symbols, 119 edges) into one
 * statement each and a 300-file repo into a couple of dozen.
 */
export const WRITE_CHUNK = 500;

/**
 * Either the pool-backed database or an open transaction.
 *
 * Derived from `Db` rather than written out, because the transaction type is a
 * seven-parameter generic that would be wrong the moment the schema changes.
 */
export type GraphDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type PersistOptions = {
  /**
   * Who is writing. Pass 1 is `static`; Pass 2 writes its feature nodes and
   * `belongs_to` edges through this same function as `llm`. Never `user` —
   * user rows come from the UI, one at a time, and this function refuses to
   * overwrite them.
   */
  origin?: Exclude<Origin, "user">;
};

export type PersistResult = {
  nodesWritten: number;
  /** Refs with neither a name nor a path. Unaddressable, so not written. */
  nodesDropped: number;
  edgesWritten: number;
  /** Edges whose endpoints resolved to no node. A signal, not a silent loss. */
  edgesDropped: number;
  /** A few dropped edges in readable form, for the run log. */
  droppedSamples: string[];
};

export type CarryForwardResult = { nodes: number; edges: number };

export type SweepResult = { nodes: number; edges: number };

export type PromoteResult = {
  carriedForward: CarryForwardResult;
  swept: SweepResult;
};

/**
 * Write one analysis pass's nodes and edges.
 *
 * Idempotent by construction: ids are hashes of the natural key, so running the
 * same analysis twice upserts the same rows rather than duplicating them, and
 * `createdAt` on an existing row survives.
 */
export async function persistGraph(
  db: GraphDb,
  projectId: string,
  runId: string,
  nodes: readonly AnalyzedNode[],
  edges: readonly AnalyzedEdge[],
  options: PersistOptions = {},
): Promise<PersistResult> {
  const origin = options.origin ?? "static";

  // Keyed by id, which is a dedupe and not merely a tidy one: Postgres rejects
  // an ON CONFLICT DO UPDATE whose VALUES name the same key twice ("cannot
  // affect row a second time"), so one duplicate ref from any analyzer would
  // fail the whole statement.
  const nodeRows = new Map<string, typeof nodesTable.$inferInsert>();
  let nodesDropped = 0;

  for (const node of nodes) {
    const path = normalizePath(node.ref.filePath);
    // A package node carries a name and no file; a file node carries a path and
    // no name. Something with neither cannot be addressed or shown, and `name`
    // is NOT NULL, so it is dropped rather than written as an empty string.
    const name = node.ref.name ?? path;
    if (name === "") {
      nodesDropped += 1;
      continue;
    }

    const id = nodeId(projectId, node.ref);
    nodeRows.set(id, {
      id,
      projectId,
      type: node.ref.type,
      kind: node.kind ?? null,
      name,
      filePath: path === "" ? null : path,
      startLine: node.startLine ?? null,
      endLine: node.endLine ?? null,
      origin,
      metadata: node.metadata ?? {},
      lastSeenRunId: runId,
    });
  }

  for (const rows of chunk([...nodeRows.values()], WRITE_CHUNK)) {
    await db
      .insert(nodesTable)
      .values(rows)
      .onConflictDoUpdate({
        target: nodesTable.id,
        set: {
          type: sql`excluded.type`,
          kind: sql`excluded.kind`,
          name: sql`excluded.name`,
          filePath: sql`excluded.file_path`,
          startLine: sql`excluded.start_line`,
          endLine: sql`excluded.end_line`,
          origin: sql`excluded.origin`,
          metadata: sql`excluded.metadata`,
          lastSeenRunId: sql`excluded.last_seen_run_id`,
          updatedAt: sql`now()`,
        },
        // Section 6.1 rule 2. The user renamed this, or moved it, or said it
        // belongs somewhere else; re-analysis does not get to argue.
        setWhere: ne(nodesTable.origin, "user"),
      });
  }

  const written = new Set(nodeRows.keys());

  const candidates = edges.map((edge) => ({
    edge,
    sourceId: nodeId(projectId, edge.source),
    targetId: nodeId(projectId, edge.target),
  }));

  // An endpoint this pass did not write may still be a real row: Pass 2's
  // `belongs_to` edges point at symbols Pass 1 wrote in an earlier call of the
  // same run. So ask the database about the ids we cannot vouch for ourselves,
  // rather than dropping every edge that crosses a pass boundary.
  const unknown = new Set<string>();
  for (const candidate of candidates) {
    if (!written.has(candidate.sourceId)) unknown.add(candidate.sourceId);
    if (!written.has(candidate.targetId)) unknown.add(candidate.targetId);
  }
  const present = await existingNodeIds(db, projectId, [...unknown]);

  const edgeRows = new Map<string, typeof edgesTable.$inferInsert>();
  const droppedSamples: string[] = [];
  let edgesDropped = 0;

  for (const { edge, sourceId, targetId } of candidates) {
    const resolved =
      (written.has(sourceId) || present.has(sourceId)) &&
      (written.has(targetId) || present.has(targetId));

    if (!resolved) {
      edgesDropped += 1;
      if (droppedSamples.length < 10) {
        droppedSamples.push(
          `${edge.type} ${describeRef(edge.source)} -> ${describeRef(edge.target)}`,
        );
      }
      continue;
    }

    const id = edgeId(projectId, edge.type, sourceId, targetId);
    edgeRows.set(id, {
      id,
      projectId,
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      type: edge.type,
      confidence: edge.confidence,
      origin,
      metadata: edge.metadata ?? {},
      lastSeenRunId: runId,
    });
  }

  for (const rows of chunk([...edgeRows.values()], WRITE_CHUNK)) {
    await db
      .insert(edgesTable)
      .values(rows)
      .onConflictDoUpdate({
        target: edgesTable.id,
        set: {
          confidence: sql`excluded.confidence`,
          origin: sql`excluded.origin`,
          metadata: sql`excluded.metadata`,
          lastSeenRunId: sql`excluded.last_seen_run_id`,
        },
        setWhere: ne(edgesTable.origin, "user"),
      });
  }

  return {
    nodesWritten: nodeRows.size,
    nodesDropped,
    edgesWritten: edgeRows.size,
    edgesDropped,
    droppedSamples,
  };
}

/**
 * Stamp this run onto the rows of files we could not parse this time (D37).
 *
 * Must happen before the sweep. A file that parsed in run one and has a syntax
 * error in run two produces no nodes, so the sweep would delete it — and
 * `ON DELETE CASCADE` would take every edge from *healthy* files that pointed
 * into it as well. One bad file would quietly amputate a piece of the map that
 * has nothing wrong with it.
 *
 * Edges are carried by endpoint rather than by path because an edge has no
 * path of its own: the ones at risk are exactly those touching a node in a
 * skipped file, in either direction.
 */
export async function carryForwardSkipped(
  db: GraphDb,
  projectId: string,
  runId: string,
  skippedPaths: readonly string[],
): Promise<CarryForwardResult> {
  const paths = [...new Set(skippedPaths.map(normalizePath))].filter((p) => p !== "");
  if (paths.length === 0) return { nodes: 0, edges: 0 };

  // Every node in those files, user rows included. A user row is never updated,
  // but an edge touching it still has to survive the sweep.
  const endpoints: string[] = [];
  const touchable: string[] = [];
  for (const batch of chunk(paths, WRITE_CHUNK)) {
    const found = await db
      .select({ id: nodesTable.id, origin: nodesTable.origin })
      .from(nodesTable)
      .where(
        and(eq(nodesTable.projectId, projectId), inArray(nodesTable.filePath, batch)),
      );
    for (const row of found) {
      endpoints.push(row.id);
      if (row.origin !== "user") touchable.push(row.id);
    }
  }

  let nodesTouched = 0;
  for (const batch of chunk(touchable, WRITE_CHUNK)) {
    const updated = await db
      .update(nodesTable)
      .set({ lastSeenRunId: runId })
      .where(and(eq(nodesTable.projectId, projectId), inArray(nodesTable.id, batch)))
      .returning({ id: nodesTable.id });
    nodesTouched += updated.length;
  }

  // A Set, not a running total: an edge whose two endpoints land in different
  // batches is updated once and would otherwise be counted twice.
  const edgesTouched = new Set<string>();
  for (const batch of chunk(endpoints, WRITE_CHUNK)) {
    const updated = await db
      .update(edgesTable)
      .set({ lastSeenRunId: runId })
      .where(
        and(
          eq(edgesTable.projectId, projectId),
          ne(edgesTable.origin, "user"),
          or(
            inArray(edgesTable.sourceNodeId, batch),
            inArray(edgesTable.targetNodeId, batch),
          ),
        ),
      )
      .returning({ id: edgesTable.id });
    for (const row of updated) edgesTouched.add(row.id);
  }

  return { nodes: nodesTouched, edges: edgesTouched.size };
}

/**
 * Delete what this run did not see (D20).
 *
 * Only ever called for a run that succeeded — see `promoteRun`. Edges go first
 * so the count is honest; whatever is left hanging off a deleted node would
 * cascade anyway, but by then it has already been counted here.
 */
export async function sweepStaleRows(
  db: GraphDb,
  projectId: string,
  runId: string,
): Promise<SweepResult> {
  // `lastSeenRunId` is nullable, and `<> $1` is not true for NULL, so a row
  // that predates the column would survive every sweep forever without this.
  const staleEdges = or(
    isNull(edgesTable.lastSeenRunId),
    ne(edgesTable.lastSeenRunId, runId),
  );
  const staleNodes = or(
    isNull(nodesTable.lastSeenRunId),
    ne(nodesTable.lastSeenRunId, runId),
  );

  const deletedEdges = await db
    .delete(edgesTable)
    .where(
      and(eq(edgesTable.projectId, projectId), ne(edgesTable.origin, "user"), staleEdges),
    )
    .returning({ id: edgesTable.id });

  const deletedNodes = await db
    .delete(nodesTable)
    .where(
      and(eq(nodesTable.projectId, projectId), ne(nodesTable.origin, "user"), staleNodes),
    )
    .returning({ id: nodesTable.id });

  return { nodes: deletedNodes.length, edges: deletedEdges.length };
}

/**
 * Finish a successful run: carry skipped files forward, then sweep.
 *
 * One transaction, because the two halves are one decision. A carry-forward
 * that committed without its sweep would leave last run's rows looking current;
 * a sweep that ran without its carry-forward is exactly the cascade D37
 * describes. A failed run never calls this at all.
 */
export async function promoteRun(
  db: Db,
  projectId: string,
  runId: string,
  skippedPaths: readonly string[] = [],
): Promise<PromoteResult> {
  return db.transaction(async (tx) => {
    const carriedForward = await carryForwardSkipped(tx, projectId, runId, skippedPaths);
    const swept = await sweepStaleRows(tx, projectId, runId);
    return { carriedForward, swept };
  });
}

/** The shape of an edge row this rule needs. A full row satisfies it. */
export type BelongsToLike = {
  id: string;
  sourceNodeId: string;
  type: string;
  origin: Origin;
};

/**
 * Which machine groupings a user correction overrules (D9).
 *
 * Section 6.1 rule 2 only says re-analysis must not delete or overwrite a user
 * row, which on its own leaves both edges present after the next run and puts
 * one item in two features at once. So a `user` `belongs_to` edge suppresses
 * the machine's `belongs_to` for the same source node.
 *
 * Suppression, not deletion, and computed here from the rows rather than marked
 * on them: a stored flag would go stale the moment the user undid their
 * correction, and D9's whole point is that the machine grouping comes back when
 * they do. Anything reading `belongs_to` edges should run them through this.
 */
export function suppressedBelongsToIds(rows: readonly BelongsToLike[]): Set<string> {
  const corrected = new Set<string>();
  for (const row of rows) {
    if (row.type === "belongs_to" && row.origin === "user") corrected.add(row.sourceNodeId);
  }

  const suppressed = new Set<string>();
  if (corrected.size === 0) return suppressed;

  for (const row of rows) {
    // `llm` in practice — static analysis never produces a grouping — but the
    // rule is "the user's answer wins over the machine's", whichever machine.
    if (row.type !== "belongs_to" || row.origin === "user") continue;
    if (corrected.has(row.sourceNodeId)) suppressed.add(row.id);
  }
  return suppressed;
}

async function existingNodeIds(
  db: GraphDb,
  projectId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const batch of chunk(ids, WRITE_CHUNK)) {
    const rows = await db
      .select({ id: nodesTable.id })
      .from(nodesTable)
      .where(and(eq(nodesTable.projectId, projectId), inArray(nodesTable.id, batch)));
    for (const row of rows) found.add(row.id);
  }
  return found;
}

function describeRef(ref: NodeRef): string {
  const path = normalizePath(ref.filePath);
  const name = ref.container ? `${ref.container}.${ref.name ?? ""}` : ref.name;
  return name ? `${ref.type} ${path}#${name}` : `${ref.type} ${path}`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
