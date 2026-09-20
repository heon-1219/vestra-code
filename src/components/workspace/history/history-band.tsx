"use client";

import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import {
  buildRunEntries,
  runFacts,
  runHeadline,
  runTone,
  runsResponseSchema,
  shortSha,
  type RunEntry,
  type RunsResponse,
  type RunTone,
} from "./runs";
import { exactWhen, formatWhen, parseWhen } from "./when";

/**
 * The band along the bottom of the workspace: what happened to this project.
 *
 * Every run is a dated snapshot of the map, and the band lays them out newest
 * first with what changed between each one and the one before it. It has two
 * shapes because it lives in two sizes, and the difference is not a
 * breakpoint — it is which question there is room to answer:
 *
 *   - **A strip** at its resting 4.5% of the workspace. One line per run, and
 *     the line has to survive being ~18px tall: when, and the one sentence.
 *     Everything else is on the hover.
 *   - **A list** when the band is the maximised pane, which is the state that
 *     exists for reading rather than glancing. The counts, the files, and the
 *     commit go here, because this is the only place they fit honestly.
 *
 * What it will not do is fill either shape with something that is not true. A
 * project with one run shows one run; a project with none says so in a
 * sentence. There is no skeleton row, no example, and no placeholder history —
 * the thing this band replaced was a placeholder, and the product's whole
 * promise is that what is on the screen was measured.
 */

const LOAD_FAILED = "변경 기록을 불러오지 못했어요.";
const LOADING = "불러오는 중이에요…";
const NOTHING_YET = "아직 이 프로젝트를 읽은 적이 없어요.";
const STALE = "새로 불러오지 못했어요.";

const messageSchema = z.object({ message: z.string() });

export type HistoryBandProps = {
  projectId: string;
  /** True when this band is the pane filling the workspace. */
  expanded: boolean;
  /**
   * The run the workspace is currently watching, and the run its map came
   * from. Not used as data — the band reads its own — but as the signal to go
   * and read again: a run starting, and a run's graph arriving, are the only
   * two moments this list changes.
   */
  activeRunId: string | null;
  lastRunId: string | null;
  lastRunStatus: string | null;
};

export function HistoryBand({
  projectId,
  expanded,
  activeRunId,
  lastRunId,
  lastRunStatus,
}: HistoryBandProps) {
  const [loaded, setLoaded] = useState<RunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * The clock, kept in state and moved on a timer.
   *
   * Reading `Date.now()` during render would give the server one answer and the
   * browser another, which is the hydration mismatch `panes.tsx` documents at
   * length — and this component is rendered on the server, even though the list
   * it draws only exists after a fetch. Keeping it in state also fixes the
   * quieter problem: a band that formats once says 방금 전 an hour later, which
   * is a false sentence on a screen whose entire argument is that it does not
   * make those.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/runs`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          // The route's refusals are already sentences written for this person
          // — signed out, no such project — so showing one is the job.
          const told = messageSchema.safeParse(body);
          setError(told.success ? told.data.message : LOAD_FAILED);
          return;
        }

        const parsed = runsResponseSchema.safeParse(body);
        if (!parsed.success) {
          setError(LOAD_FAILED);
          return;
        }
        setLoaded(parsed.data);
        setError(null);
      } catch {
        // An abort is this effect being replaced, not a failure to report.
        if (!controller.signal.aborted) setError(LOAD_FAILED);
      }
    })();

    return () => controller.abort();
  }, [projectId, activeRunId, lastRunId, lastRunStatus]);

  const entries = useMemo(
    () => (loaded ? buildRunEntries(loaded.runs, loaded.truncated) : []),
    [loaded],
  );

  /*
   * One sentence instead of a list, when there is no list to draw.
   *
   * The order matters: a failed *first* load is the only time an error replaces
   * the band's contents. Once a list has arrived it stays, because it was true
   * a moment ago and a history is not a live instrument — a failed refresh gets
   * a note at the end rather than blanking a project's whole past.
   */
  const note = !loaded
    ? (error ?? LOADING)
    : entries.length === 0
      ? NOTHING_YET
      : null;
  const stale = loaded !== null && error !== null;

  if (expanded) {
    return (
      <section
        aria-label="변경 기록"
        className="flex min-h-0 min-w-0 flex-1 flex-col self-stretch overflow-hidden"
      >
        <div className="shrink-0 pb-2">
          <h2 className="display-kr text-[15px] text-said">변경 기록</h2>
          <p className="mt-1 text-[12px] leading-[1.7] text-said-faint">
            프로젝트를 읽을 때마다 그때의 지도를 하나씩 남겨 둬요. 무엇이 달라졌는지 여기에서 볼 수 있어요.
          </p>
        </div>

        {note ? (
          <p className="text-[12px] text-said-faint">{note}</p>
        ) : (
          <ol className="min-h-0 flex-1 overflow-y-auto pr-2">
            {entries.map((entry) => (
              <HistoryRow key={entry.run.id} entry={entry} now={now} />
            ))}
          </ol>
        )}

        {/* Why the oldest row above says 이때 다시 읽었어요 rather than naming
            itself the first run. Rendered only when there is something to say,
            so it never costs a line of an empty band. */}
        {loaded?.truncated || stale ? (
          <p className="shrink-0 pt-2 text-[11px] text-said-faint">
            {loaded?.truncated ? `최근 ${entries.length}번만 보여드려요. ` : null}
            {stale ? STALE : null}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-label="변경 기록"
      className="flex min-w-0 flex-1 items-center gap-3 self-stretch overflow-hidden"
    >
      <span className="shrink-0">변경 기록</span>
      {note ? (
        <span className="truncate">{note}</span>
      ) : (
        /*
          Newest at the left, and the strip scrolls to the right.

          Korean reads left to right, so the end of the list a person came here
          for is the end their eye lands on without being dragged to. The
          scrollbar is hidden rather than the overflow: at its smallest the band
          is 34px tall, and a classic horizontal scrollbar is most of that —
          it would take the row it is there to let you read. The wheel still
          works, and the whole list is one click away in the maximised pane.
        */
        <ol className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {entries.map((entry) => (
            <HistoryChip key={entry.run.id} entry={entry} now={now} />
          ))}
          {stale ? (
            <li className="shrink-0 text-said-faint">{STALE}</li>
          ) : null}
        </ol>
      )}
    </section>
  );
}

/** One run on the strip: when, and the one sentence. The rest is on the hover. */
function HistoryChip({ entry, now }: { entry: RunEntry; now: number }) {
  const at = parseWhen(entry.at);
  const headline = runHeadline(entry);

  return (
    <li
      // The hover carries the exact moment, which is the one thing a strip this
      // short can never show and the one thing a date is sometimes needed for.
      title={at ? `${exactWhen(at)} · ${headline}` : headline}
      // `leading-[1.5]` rather than the body's 1.72, and no vertical padding
      // worth the name: the band's own minimum is 34px and its border and
      // padding take a third of that, so a chip on the default line height
      // would be clipped by the pane at exactly the size somebody drags it to
      // when they want it out of the way but still readable.
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-2 leading-[1.5]"
    >
      <Dot tone={runTone(entry.run)} />
      {at ? (
        <time dateTime={entry.at} className="text-said-soft">
          {formatWhen(at, new Date(now))}
        </time>
      ) : null}
      <span>{headline}</span>
    </li>
  );
}

/** One run in the maximised list, where there is room for the rest of it. */
function HistoryRow({ entry, now }: { entry: RunEntry; now: number }) {
  const at = parseWhen(entry.at);
  const sha = shortSha(entry.run.commitSha);
  // Empty for a run that has not finished: it has no counts yet, and an empty
  // paragraph would still take its margin and leave a gap that reads as
  // something that failed to load.
  const meta = [at ? exactWhen(at) : null, ...runFacts(entry.run)]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="flex gap-3 border-b border-edge py-2.5 last:border-b-0">
      <Dot tone={runTone(entry.run)} className="mt-[7px]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {at ? (
            <time dateTime={entry.at} className="text-[13px] text-said">
              {formatWhen(at, new Date(now))}
            </time>
          ) : null}
          <span className="text-[13px] leading-[1.6] text-said-soft">
            {runHeadline(entry)}
          </span>
        </div>

        {meta ? (
          <p className="mt-1 text-[11px] leading-[1.7] text-said-faint">{meta}</p>
        ) : null}

        {sha ? (
          <p className="mt-1 text-[11px] text-said-faint">
            읽은 코드 번호{" "}
            {/*
              The one piece of jargon the band keeps, and the hover is what
              makes keeping it fair: seven characters of hex mean nothing to
              this product's user until something says what they are for, and
              the full string is what they would paste somewhere else.
            */}
            <code
              title={`이 번호로 그때의 코드를 찾을 수 있어요. 전체: ${entry.run.commitSha ?? sha}`}
              className="text-said-soft"
            >
              {sha}
            </code>
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The colour of a run, and nothing else.
 *
 * `aria-hidden` because it says nothing the sentence beside it does not already
 * say in words — a run that is going says 지금 읽고 있어요, and one that stopped
 * prints the reason it stopped. A dot that were the only carrier of that would
 * be a state only sighted users can read.
 */
const TONE_COLOURS: Record<RunTone, string> = {
  reading: "bg-lamp",
  drawn: "bg-wire",
  stopped: "bg-c4",
};

function Dot({ tone, className = "" }: { tone: RunTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_COLOURS[tone]} ${className}`}
    />
  );
}
