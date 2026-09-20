import { z } from "zod";

/**
 * The runs of one project, and what changed between them.
 *
 * A run is a dated snapshot of the map. The band is there to answer one
 * question for somebody who cannot read code — "what happened to my project,
 * and when" — and the answer that question wants is a *difference*, not a
 * measurement: 항목 12개가 늘었어요 is an answer, `nodeCount: 143` is a reading
 * off an instrument.
 *
 * Three decisions live here rather than in the component, because each one is
 * wrong in a way you cannot see by looking at the screen:
 *
 *   1. **Only completed runs are compared, and only to other completed runs.**
 *      `pipeline.ts` writes `nodeCount`/`edgeCount` on the success path alone,
 *      so a failed or in-flight run carries the column defaults — 0 and 0.
 *      Differencing against one of those would report 항목 143개가 줄었어요 for
 *      a run that changed nothing, on the screen of a person whose map is
 *      sitting there intact. D20 is why the map *is* intact: a failed run
 *      drops its own work and the previous graph stands, so the honest
 *      difference is the one across it.
 *   2. **A run with nothing to compare against says so, and which kind of
 *      nothing it is.** `first` is the run that drew the map for the first
 *      time. `unknown` is a run whose predecessor exists but is older than the
 *      window the route returns. Collapsing them would tell somebody their
 *      thirty-first-from-last run was their first.
 *   3. **The vocabulary stops at the same line `view.ts` draws it at.** Past
 *      this boundary there are no nodes and no edges: the wire calls them
 *      `itemCount` and `connectionCount`, and the sentences call them 항목 and
 *      연결 — the words `states.tsx` already uses for these two numbers. Not
 *      조각: `KIND_WORDS` spends 조각 on a symbol, and `nodeCount` counts files
 *      and pages and outside tools as well, so 조각 12개가 늘었어요 would be a
 *      false sentence whenever the twelve were files.
 */

/**
 * One run as the band receives it, and as the route must send it.
 *
 * The schema is the definition and the type is derived from it, so the two ends
 * cannot drift: the route's mapping is checked against this by the compiler,
 * and the browser checks the bytes against the same shape at the boundary.
 * Renamed from the column names on the way out — see decision 3 above.
 */
export const runRecordSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  /** ISO. Never null: a row exists because a run started. */
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Only a GitHub project has one; an uploaded folder has no commit. */
  commitSha: z.string().nullable(),
  /** `node_count`. */
  itemCount: z.number().int().nonnegative(),
  /** `edge_count`. */
  connectionCount: z.number().int().nonnegative(),
  filesParsed: z.number().int().nonnegative(),
  /** How many, not which. The paths are of no use at this size. */
  skippedCount: z.number().int().nonnegative(),
  /** Already a plain sentence when it is set (`analysis_runs.error`). */
  error: z.string().nullable(),
});

export type RunRecord = z.infer<typeof runRecordSchema>;

export const runsResponseSchema = z.object({
  runs: z.array(runRecordSchema),
  /** True when this project has runs older than the ones sent. */
  truncated: z.boolean(),
});

export type RunsResponse = z.infer<typeof runsResponseSchema>;

/** What a run can be said to have changed. */
export type RunChange =
  /** Not a completed run, so no counts were ever written for it. */
  | { kind: "none" }
  /** The first time this project's map was drawn. */
  | { kind: "first" }
  /** Completed, but its predecessor is older than the window we were given. */
  | { kind: "unknown" }
  /** Signed differences against the previous completed run. Either may be 0. */
  | { kind: "changed"; items: number; connections: number };

export type RunEntry = {
  run: RunRecord;
  change: RunChange;
  /** The moment to show: when it ended, or when it started if it has not. */
  at: string;
};

/** The three things a dot can mean. */
export type RunTone = "reading" | "drawn" | "stopped";

const ko = (n: number) => n.toLocaleString("ko-KR");

const READING = "지금 읽고 있어요";
/** Only when `error` is somehow empty. A failed run normally speaks for itself. */
const STOPPED = "지도를 그리다가 멈췄어요";
const UNCOMPARED = "이때 다시 읽었어요";

/**
 * Every run, newest first, each with what it changed.
 *
 * `truncated` says the caller's list is a window onto a longer history, which
 * changes the answer for exactly one run: the oldest completed one in the
 * window, which would otherwise be announced as the project's first.
 */
export function buildRunEntries(
  runs: readonly RunRecord[],
  truncated = false,
): RunEntry[] {
  /*
   * Sorted here rather than trusted from the caller.
   *
   * The route orders by `started_at` already, but this function's whole output
   * is directional — 늘었어요 and 줄었어요 are the same subtraction with its
   * sign flipped — so a list that arrived in the other order would not look
   * broken, it would look like a project that had been shrinking. Re-sorting
   * thirty rows costs nothing and removes the possibility.
   */
  const ordered = [...runs].sort((a, b) => startedMs(b) - startedMs(a));

  const entries: RunEntry[] = ordered.map((run) => ({
    run,
    change: { kind: "none" },
    // A run that is still going has no end yet, and its start is the honest
    // answer to "when": it says when this began, which is what is happening.
    at: run.finishedAt ?? run.startedAt,
  }));

  // Backwards, oldest first, carrying the last completed run's counts forward.
  // One pass rather than a lookup per row, and — more to the point — the only
  // direction in which "the previous completed run" is a thing you already have.
  let previous: RunRecord | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const { run } = entries[i];
    if (run.status !== "completed") continue;

    entries[i].change = previous
      ? {
          kind: "changed",
          items: run.itemCount - previous.itemCount,
          connections: run.connectionCount - previous.connectionCount,
        }
      : truncated
        ? { kind: "unknown" }
        : { kind: "first" };

    previous = run;
  }

  return entries;
}

/**
 * The one line a run gets, whatever state it is in.
 *
 * A failed run says what the pipeline stored, because that string was already
 * written for this person — `AnalysisFailure` carries plain Korean and anything
 * else becomes a generic sentence before it reaches the column. Technical
 * detail went to the logs and must not be reconstructed here.
 */
export function runHeadline(entry: RunEntry): string {
  const { run, change } = entry;
  if (run.status === "pending" || run.status === "running") return READING;
  if (run.status === "failed") return run.error?.trim() || STOPPED;

  switch (change.kind) {
    case "first":
      return "처음 그린 지도예요";
    case "changed":
      return changedSentence(change.items, change.connections);
    // `none` cannot reach here — a completed run is always given one of the
    // other three — but it shares `unknown`'s answer, which is the honest one:
    // it ran and it finished, and we are not claiming to know against what.
    case "none":
    case "unknown":
      return UNCOMPARED;
  }
}

/**
 * What two signed differences sound like in one sentence.
 *
 * Four shapes, and the joins are the reason this is a function rather than a
 * template: 항목 12개, 연결 9개가 늘었어요 when both moved the same way, and
 * 항목 12개가 늘고, 연결 3개가 줄었어요 when they did not. Exported so the
 * grammar is pinned by a test instead of by whoever reads the screen next.
 */
export function changedSentence(items: number, connections: number): string {
  const grew: string[] = [];
  const shrank: string[] = [];

  if (items > 0) grew.push(`항목 ${ko(items)}개`);
  if (items < 0) shrank.push(`항목 ${ko(-items)}개`);
  if (connections > 0) grew.push(`연결 ${ko(connections)}개`);
  if (connections < 0) shrank.push(`연결 ${ko(-connections)}개`);

  // A re-read of an unchanged repository. It is a real and common outcome —
  // D53 caches Pass 2 on exactly this case — and saying nothing about it would
  // read as a run that failed to report.
  if (grew.length === 0 && shrank.length === 0) return "지난번과 똑같아요";

  const parts: string[] = [];
  if (grew.length > 0) {
    parts.push(`${grew.join(", ")}가 ${shrank.length > 0 ? "늘고" : "늘었어요"}`);
  }
  if (shrank.length > 0) parts.push(`${shrank.join(", ")}가 줄었어요`);
  return parts.join(", ");
}

/**
 * The smaller facts, for the maximised list where there is room for them.
 *
 * Only for a completed run, for the reason at the top of this file: the numbers
 * on any other kind of run are column defaults, and printing 항목 0개 beside a
 * run that failed halfway would be reporting a measurement nobody took.
 */
export function runFacts(run: RunRecord): string[] {
  if (run.status !== "completed") return [];

  const facts = [`항목 ${ko(run.itemCount)}개`, `연결 ${ko(run.connectionCount)}개`];
  if (run.filesParsed > 0) facts.push(`파일 ${ko(run.filesParsed)}개를 읽었어요`);
  // D37: those files kept the rows they had, so this is a gap in what this run
  // saw and not a gap in the map. Said as a count, never as a verdict.
  if (run.skippedCount > 0) {
    facts.push(`읽지 못한 파일 ${ko(run.skippedCount)}개가 있어요`);
  }
  return facts;
}

/**
 * The first seven characters, which is what every tool that shows one shows.
 *
 * The one piece of jargon the band keeps, because it is the one thing here
 * somebody might want to paste somewhere else. Null rather than an empty
 * string, so the caller renders nothing at all for an uploaded folder — which
 * has no commit, because there was no repository to resolve one against.
 */
export function shortSha(sha: string | null): string | null {
  const trimmed = sha?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed.slice(0, 7);
}

export function runTone(run: RunRecord): RunTone {
  if (run.status === "failed") return "stopped";
  if (run.status === "completed") return "drawn";
  return "reading";
}

/**
 * A run's start as a number, with an unreadable one sorted to the far end.
 *
 * NaN would make the comparator inconsistent and leave the whole list in an
 * order the engine is free to choose, so one bad row is contained to itself
 * rather than scrambling twenty-nine good ones.
 */
function startedMs(run: RunRecord): number {
  const ms = Date.parse(run.startedAt);
  return Number.isNaN(ms) ? 0 : ms;
}
