import { asc, desc, eq, sql } from "drizzle-orm";

import type { Db } from "@/db";
import { analysisRuns, edges, nodes } from "@/db/schema";

import type {
  Certainty,
  ConnectionRelation,
  GraphConnection,
  GraphItem,
  GraphView,
  ItemKind,
} from "./view";

/**
 * Reading the stored graph back out as the thing the workspace renders.
 *
 * Three queries, one per table, and never a query per item. That is not a
 * micro-optimisation: the demo repo is 68 items and 121 connections, but a
 * 300-file app is thousands of each, and the two obvious shapes — a join that
 * fans the items out once per connection, or a count query per item — are the
 * two that make the map's first paint scale with the square of the project.
 *
 * `usedBy` and `uses` are counted in the same single pass that builds the
 * connection list, for the same reason. `connections.filter(c => c.to === id)`
 * inside the item loop reads fine and is O(items x connections); on a real repo
 * that is tens of millions of comparisons to produce two integers per row.
 */

// --- Row shapes ------------------------------------------------------------
// Written out rather than inferred so `buildGraphView` can be tested without a
// database, and so the assignment from a Drizzle row is itself the check that
// the Postgres enums and `view.ts` still agree. If someone adds an edge type to
// the schema and not to `ConnectionRelation`, this file stops compiling — which
// is the earliest anyone could possibly find out.

export type GraphNodeRow = {
  id: string;
  type: ItemKind;
  kind: string | null;
  name: string;
  label: string | null;
  summary: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  origin: "static" | "llm" | "user";
};

export type GraphEdgeRow = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: ConnectionRelation;
  confidence: Certainty;
  /**
   * The call site, already picked out of `edges.metadata` by the query.
   *
   * Text rather than a number, because the column is `jsonb` and can hold
   * anything: `::int` on a value that is not one fails the whole statement
   * rather than one row, which would take the map down over a single bad
   * edge. `readLine` below does every check it did before.
   *
   * **Why the query does the picking.** `analyzer.ts` writes `{ line }` on
   * every `calls`, `renders` and `fetches` edge, and it writes other things
   * too — a matched url, an import specifier — that the workspace has no
   * sentence for and never reads. Selecting the whole object pulled all of it
   * across the wire to be thrown away here: measured on this repository's own
   * graph, 39.7 KB per load, of which 22.3 KB was import specifiers on 780
   * edges. Only 926 of 3,030 edges carry a line at all. Server-side execution
   * is unchanged (2.02 ms against 2.23 ms), so this buys bytes, not time.
   *
   * Optional so that every fixture and every caller written before this
   * arrived still compiles. An edge with no line is the normal case.
   */
  line?: string | null;
};

export type GraphRunRow = {
  id: string;
  status: NonNullable<GraphView["lastRun"]>["status"];
  finishedAt: Date | null;
  filesParsed: number;
  /** A `jsonb` column, so genuinely unknown until it has been looked at. */
  filesSkipped: unknown;
  error: string | null;
};

/**
 * The graph of one project, in the shape `view.ts` promises.
 *
 * The caller has already proved the project belongs to whoever is asking. This
 * function does not check — it has no session and no opinion about one, in the
 * same way the pipeline has no opinion about HTTP.
 */
export async function loadGraphView(
  db: Db,
  projectId: string,
): Promise<GraphView> {
  // Issued together because they do not depend on each other. On a project with
  // a few thousand rows the three round trips are most of the wall clock.
  const [nodeRows, edgeRows, runRows] = await Promise.all([
    db
      .select({
        id: nodes.id,
        type: nodes.type,
        kind: nodes.kind,
        name: nodes.name,
        label: nodes.label,
        summary: nodes.summary,
        filePath: nodes.filePath,
        startLine: nodes.startLine,
        endLine: nodes.endLine,
        origin: nodes.origin,
      })
      .from(nodes)
      .where(eq(nodes.projectId, projectId))
      // A stable order, so two loads of an unchanged graph hand the renderer
      // the same array. A force layout seeded from array order otherwise
      // settles somewhere new on every refresh, and the user reasonably reads
      // that as their app having changed.
      .orderBy(asc(nodes.filePath), asc(nodes.startLine), asc(nodes.name)),

    db
      .select({
        id: edges.id,
        sourceNodeId: edges.sourceNodeId,
        targetNodeId: edges.targetNodeId,
        type: edges.type,
        confidence: edges.confidence,
        line: sql<string | null>`${edges.metadata}->>'line'`,
      })
      .from(edges)
      .where(eq(edges.projectId, projectId))
      .orderBy(asc(edges.id)),

    db
      .select({
        id: analysisRuns.id,
        status: analysisRuns.status,
        finishedAt: analysisRuns.finishedAt,
        filesParsed: analysisRuns.filesParsed,
        filesSkipped: analysisRuns.filesSkipped,
        error: analysisRuns.error,
      })
      .from(analysisRuns)
      .where(eq(analysisRuns.projectId, projectId))
      .orderBy(desc(analysisRuns.startedAt))
      .limit(1),
  ]);

  return buildGraphView(projectId, nodeRows, edgeRows, runRows[0] ?? null);
}

/**
 * Which relations mean "something uses something".
 *
 * `contains` and `belongs_to` are structural: a file holds a symbol, a thing was
 * grouped into a feature. Neither is a use, and counting them inflates the one
 * sentence this product is sold on — "이건 N곳에서 쓰여요".
 */
const COUNTS_AS_USE = new Set<ConnectionRelation>([
  "calls",
  "renders",
  "fetches",
  "imports",
  "uses_package",
]);

/**
 * The same thing without a database, which is where all the decisions live.
 *
 * Split out so the mapping and the counting can be tested against a fixture the
 * size of a real repository in milliseconds. The queries above are three lines
 * of Drizzle and are verified by the opt-in database test.
 */
export function buildGraphView(
  projectId: string,
  nodeRows: readonly GraphNodeRow[],
  edgeRows: readonly GraphEdgeRow[],
  runRow: GraphRunRow | null,
): GraphView {
  const uses = new Map<string, number>();
  const usedBy = new Map<string, number>();
  const connections: GraphConnection[] = [];

  // One pass: build the connection and tally both ends of it while we are here.
  for (const row of edgeRows) {
    const line = readLine(row.line);
    connections.push({
      id: row.id,
      from: row.sourceNodeId,
      to: row.targetNodeId,
      relation: row.type,
      certainty: row.confidence,
      // Spread rather than `line: line ?? undefined`, so an edge without one
      // has no key at all. `view.ts` says absent is the only way to say "no
      // line"; writing `undefined` into the field would give it a second.
      ...(line === null ? {} : { line }),
    });

    // Structural relations are not uses, and counting them inflates the one
    // number this product is sold on. `contains` says a file holds a symbol;
    // `belongs_to` says a thing was grouped into a feature. Neither is anybody
    // using anything. Counting them made `kv` report 7 places on the demo repo
    // when the parser had measured 6 — the seventh was its own file holding it.
    if (!COUNTS_AS_USE.has(row.type)) continue;

    uses.set(row.sourceNodeId, (uses.get(row.sourceNodeId) ?? 0) + 1);
    usedBy.set(row.targetNodeId, (usedBy.get(row.targetNodeId) ?? 0) + 1);
  }

  const items: GraphItem[] = nodeRows.map((row) => ({
    id: row.id,
    kind: row.type,
    shape: row.kind,
    name: row.name,
    label: row.label,
    summary: row.summary,
    path: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    // The one flag the re-analysis rules turn on: a row a person put here
    // survives the next run, and the map has to be able to say so.
    fromUser: row.origin === "user",
    usedBy: usedBy.get(row.id) ?? 0,
    uses: uses.get(row.id) ?? 0,
  }));

  return {
    projectId,
    items,
    connections,
    lastRun: runRow
      ? {
          id: runRow.id,
          status: runRow.status,
          // ISO rather than a Date, because this crosses a JSON boundary on its
          // way to the browser and a Date would silently arrive as a string
          // anyway — better to say so in the type than to discover it.
          finishedAt: runRow.finishedAt?.toISOString() ?? null,
          filesParsed: runRow.filesParsed,
          filesSkipped: readSkipped(runRow.filesSkipped),
          error: runRow.error,
        }
      : null,
  };
}

/**
 * `files_skipped` is a `jsonb` column. Drizzle is told it holds `string[]`, and
 * every write in this codebase does — but a column that can hold anything is
 * worth one guard, because the alternative to a guard here is the whole map
 * failing to render over a list of filenames nobody was going to read.
 */
/**
 * The call site out of `edges.metadata`, or null.
 *
 * Guarded to the same degree as `readSkipped` and for the same reason: this is
 * a column that can hold anything, and the failure mode of trusting it is a
 * sentence reading "PayButton.tsx [object Object]줄에서" in front of somebody
 * who is already unsure whether to trust us.
 *
 * Non-integers, zero and negatives are dropped rather than coerced. A line
 * number is 1-based by every editor's reckoning; a 0 here would mean the
 * parser recorded something we do not understand, and inventing line 1 from it
 * is the kind of quiet guess this file exists to refuse.
 */
function readLine(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  /*
   * Digits only, before `Number` is allowed near it.
   *
   * `Number` is wider than this column's contract and the difference is not
   * theoretical: `Number("1e3")` is 1000, so a `metadata` holding the *string*
   * `"1e3"` would have been read back as line 1000 — a number nobody wrote,
   * printed into a sentence, in front of someone already deciding whether to
   * trust us. The old object-shaped reader rejected it for free by requiring
   * `typeof line === "number"`, and moving the read into SQL would have lost
   * that guard silently.
   *
   * `->>` renders a JSON integer as plain digits, so this accepts everything
   * the analyzer actually writes and nothing else. `Number` then cannot
   * surprise us, and the range check below still has the last word.
   */
  if (!/^\d+$/.test(value)) return null;
  const line = Number(value);
  if (!Number.isInteger(line) || line < 1) return null;
  return line;
}

function readSkipped(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
