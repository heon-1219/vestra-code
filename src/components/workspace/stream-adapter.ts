import type { AnalysisStreamState } from "@/hooks/use-analysis-stream";

import type { AnalysisProgress, StreamState } from "./analysis-screen";
import type { RunProgress } from "./panel/connections-panel";

/**
 * One run, told three ways.
 *
 * The stream hook, the centre screen and the right panel were written at the
 * same time against the same events, and each one named the same number
 * differently — `filesParsed` / `filesRead` / `filesParsed`, `itemCount` /
 * `itemsFound` / `items`. Rather than rename anyone's field and make three
 * files disagree with their own comments, the translation lives here, once,
 * where it can be read in full and tested without a browser.
 *
 * The rule the whole thing rests on: every field on `AnalysisStreamState` is a
 * running total, not a delta (that is what makes a mid-run refresh land on the
 * same numbers). So nothing here accumulates; it only renames and reshapes.
 */

/**
 * `0` and "not known yet" are the same value on the wire and are not the same
 * thing on screen: the centre screen draws a denominator only once it has a
 * real one, and a `0` would give it "0 / 0". Ingest has not reported until it
 * has reported something above zero.
 */
function knownCount(value: number): number | null {
  return value > 0 ? value : null;
}

/**
 * Which of the four connection states the screen should say.
 *
 * The hook has one word for two situations — `connecting` is both the first
 * connection of the page and a reconnect after the endpoint closed its stream.
 * They read completely differently to a person: the first is "starting", the
 * second is "we lost you for a second". Having seen a phase is the evidence
 * that the stream was open once.
 */
function linkOf(stream: AnalysisStreamState): StreamState {
  switch (stream.link) {
    case "open":
      return "live";
    case "closed":
      return "closed";
    default:
      return stream.phase === null ? "opening" : "retrying";
  }
}

/** Newest first, which is what both consumers want; the hook keeps newest last. */
function newestFirst(files: readonly string[]): string[] {
  return [...files].reverse();
}

export function toAnalysisProgress(
  stream: AnalysisStreamState,
): AnalysisProgress {
  const done = stream.finished && stream.failure === null;

  return {
    phase: stream.phase,
    stream: linkOf(stream),
    filesRead: stream.filesParsed,
    filesTotal: knownCount(stream.filesOffered),
    filesOffered: knownCount(stream.filesOffered),
    itemsFound: stream.itemCount,
    connectionsFound: stream.connectionCount,
    certainCount: stream.certainCount,
    inferredCount: stream.inferredCount,
    featuresNamed: stream.featureCount,
    recentFiles: newestFirst(stream.files),
    skipped: stream.skipped,
    failure: stream.failure,
    completion: done
      ? {
          itemCount: stream.itemCount,
          connectionCount: stream.connectionCount,
          filesParsed: stream.filesParsed,
          // The run's own figure, not the length of the list we happened to
          // watch go by: after a refresh the browser replays from its cursor,
          // so the list starts partway through and is an undercount.
          filesSkipped: Math.max(stream.skippedTotal, stream.skipped.length),
          limits: stream.limits,
        }
      : null,
  };
}

export function toRunProgress(stream: AnalysisStreamState): RunProgress {
  return {
    status: stream.failure
      ? "failed"
      : stream.finished
        ? "completed"
        : "running",
    // The panel has no null phase — a run that has said nothing yet is
    // fetching, which is what `ingest` means.
    phase: stream.phase ?? "ingest",
    filesTotal: stream.filesOffered,
    filesParsed: stream.filesParsed,
    items: stream.itemCount,
    connections: stream.connectionCount,
    certain: stream.certainCount,
    inferred: stream.inferredCount,
    features: stream.featureCount,
    recent: newestFirst(stream.files),
    skipped: stream.skipped,
    message: stream.failure,
    limits: stream.limits,
  };
}
