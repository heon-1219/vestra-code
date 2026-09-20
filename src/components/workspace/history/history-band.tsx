"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { ChangeGraphList } from "./change-graph";
import {
  changeDetailSchema,
  changeFacts,
  changeHeadline,
  changesResponseSchema,
  litSentence,
  MISSING_NOTE,
  NO_HISTORY_WORDS,
  shortChangeSha,
  STATUS_WORDS,
  TRUNCATED_NOTE,
  type ChangeDetail,
  type ChangesResponse,
} from "./changes";
import { layoutChanges } from "./lanes";
import { hasDrawnMap, runIsGoing } from "./reread";
import { RereadButton } from "./reread-button";
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
 * Two histories of one thing, and the band shows both.
 *
 *   - **코드를 바꾼 기록** — the repository's own commits, drawn as a branch
 *     graph: what the person actually did. This is the history they lived
 *     through, and the one they can recognise.
 *   - **지도를 그린 기록** — our readings of the project, each a dated snapshot
 *     of the map, each with what changed between it and the one before.
 *
 * They are joined at `analysis_runs.commit_sha`: a change we drew a map from is
 * marked on its own row rather than listed twice. Neither replaces the other. A
 * run can fail, and a failure is ours and belongs in our list; a change can be
 * one we never read, and it still happened.
 *
 * It has two shapes because it lives in two sizes, and the difference is not a
 * breakpoint — it is which question there is room to answer:
 *
 *   - **A strip** at its resting 4.5% of the workspace. One line per run, and
 *     the line has to survive being ~18px tall: when, and the one sentence.
 *     The branch graph is deliberately not here: a graph squeezed into 18px is
 *     a row of dots that means nothing, and the strip's job is a glance.
 *   - **A list** when the band is the maximised pane, which is the state that
 *     exists for reading rather than glancing. The graph, the counts, the
 *     files and the commit go here, because this is the only place they fit
 *     honestly.
 *
 * What it will not do is fill either shape with something that is not true. A
 * project with one run shows one run; a project with none says so in a
 * sentence; an uploaded folder is told plainly that it has no commit history
 * rather than being shown an empty graph. There is no skeleton row, no example
 * and no placeholder history — the thing this band replaced was a placeholder,
 * and the product's whole promise is that what is on the screen was measured.
 */

const LOAD_FAILED = "변경 기록을 불러오지 못했어요.";
const CHANGES_FAILED = "코드를 바꾼 기록을 불러오지 못했어요.";
const DETAIL_FAILED = "이 변경의 내용을 불러오지 못했어요.";
const LOADING = "불러오는 중이에요…";
const NOTHING_YET = "아직 이 프로젝트를 읽은 적이 없어요.";
const STALE = "새로 불러오지 못했어요.";

/**
 * How many changed files one panel lists.
 *
 * GitHub itself stops at 300 for one commit, and 300 filenames is not a thing
 * anybody reads off a panel. The remainder is counted out loud rather than
 * silently dropped, which is the same rule the map's reachable list follows.
 */
const FILES_SHOWN = 80;

const messageSchema = z.object({ message: z.string() });

/** What the band asks the map to light, and what it hands back. */
export type ChangeLight = { sha: string; ids: ReadonlySet<string> };

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
  /**
   * The change currently lighting the map, owned by the workspace and not
   * here.
   *
   * It lives up there because the map's light has two switches — this and the
   * search box — and only one of them may be on. A band that kept its own
   * selection could not know the box had just been typed into, and the person
   * would be left with a row that looks picked and a map that is not showing
   * it.
   */
  selectedSha?: string | null;
  /** Light these places on the map, or null to hand the map back. */
  onLight?: (light: ChangeLight | null) => void;
  /**
   * A run the 다시 읽기 button started — or found already going — handed to
   * whoever owns the screen.
   *
   * Required, not optional. The band does not own `runId` and cannot show a
   * reading screen; a mount that dropped this would produce a run that is
   * really happening while the workspace shows nothing, which is the one
   * outcome this button must never have.
   */
  onStarted: (runId: string) => void;
};

export function HistoryBand({
  projectId,
  expanded,
  activeRunId,
  lastRunId,
  lastRunStatus,
  selectedSha = null,
  onLight,
  onStarted,
}: HistoryBandProps) {
  const [loaded, setLoaded] = useState<RunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [changes, setChanges] = useState<ChangesResponse | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);

  const [detail, setDetail] = useState<ChangeDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [pendingSha, setPendingSha] = useState<string | null>(null);

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

  /*
   * The repository's own history, read only once somebody has opened the band.
   *
   * Unlike the runs list, this one costs a request to GitHub on somebody else's
   * rate limit — 60 an hour for a user who signed in with Google and has no
   * token — so it is not spent on a strip that cannot draw a graph anyway. The
   * latch is a ref written inside the effect rather than state: once the band
   * has been opened, a run finishing still refreshes the 지도를 그린 곳 marks
   * even if it has since been collapsed.
   */
  const opened = useRef(false);
  useEffect(() => {
    if (!expanded && !opened.current) return;
    opened.current = true;

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/commits`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          const told = messageSchema.safeParse(body);
          setChangesError(told.success ? told.data.message : CHANGES_FAILED);
          return;
        }

        const parsed = changesResponseSchema.safeParse(body);
        if (!parsed.success) {
          setChangesError(CHANGES_FAILED);
          return;
        }
        setChanges(parsed.data);
        setChangesError(null);
      } catch {
        if (!controller.signal.aborted) setChangesError(CHANGES_FAILED);
      }
    })();

    return () => controller.abort();
  }, [projectId, expanded, lastRunId, lastRunStatus]);

  const entries = useMemo(
    () => (loaded ? buildRunEntries(loaded.runs, loaded.truncated) : []),
    [loaded],
  );

  /**
   * What each run that drew a map changed, by run id.
   *
   * Built from the same `runHeadline` the list below uses, rather than a second
   * sentence written for the graph. One fact said twice in two wordings is the
   * failure D69 was about, and it would be on the same screen here.
   */
  const runHeadlines = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries) map.set(entry.run.id, runHeadline(entry));
    return map;
  }, [entries]);

  const graph = useMemo(
    () => layoutChanges(changes?.changes ?? []),
    [changes],
  );

  const pick = useCallback(
    async (sha: string) => {
      // Pressing the change that is already showing hands the map back. The
      // same rule the pane chips follow, and the only way out of a lit map for
      // somebody who reached the row with a keyboard.
      if (selectedSha === sha) {
        onLight?.(null);
        return;
      }

      setPendingSha(sha);
      setDetailError(null);
      try {
        const response = await fetch(`/api/projects/${projectId}/commits/${sha}`, {
          headers: { accept: "application/json" },
        });
        const body: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          const told = messageSchema.safeParse(body);
          setDetailError(told.success ? told.data.message : DETAIL_FAILED);
          return;
        }

        const parsed = changeDetailSchema.safeParse(body);
        if (!parsed.success) {
          setDetailError(DETAIL_FAILED);
          return;
        }

        setDetail(parsed.data);
        // The set is built here, once, rather than in the map's render: it is
        // read on every frame and a fresh Set per render would rebuild the
        // beam's memo on every unrelated keystroke in the workspace.
        onLight?.({ sha, ids: new Set(parsed.data.itemIds) });
      } catch {
        setDetailError(DETAIL_FAILED);
      } finally {
        setPendingSha(null);
      }
    },
    [projectId, selectedSha, onLight],
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

  /*
   * The same three-way answer for the repository's history, with one extra
   * case the runs list does not have: a project that has no such history at
   * all. That is not an empty list and must not be drawn as one.
   */
  const changesNote = !changes
    ? (changesError ?? LOADING)
    : changes.none
      ? NO_HISTORY_WORDS[changes.none]
      : changes.changes.length === 0
        ? "아직 올라온 변경이 없어요."
        : null;

  /**
   * The open change, and only while the workspace agrees it is open.
   *
   * Compared during render rather than cleared in an effect. The workspace
   * drops the light the moment somebody types in the search box, and an effect
   * watching for that would render one frame of a panel describing a change
   * the map has already stopped showing.
   */
  const open = detail && detail.sha === selectedSha ? detail : null;

  /*
   * What the 다시 읽기 button needs to know, and the one word it changes.
   *
   * Whether a run is going comes from the workspace's two props rather than
   * from the list above — see `runIsGoing` for why a `running` row we happen to
   * be holding is the wrong thing to lock a button on. Whether a map exists
   * comes from both, so the label is right in the first paint and stays right
   * once the band's own list has arrived.
   */
  const going = runIsGoing({ activeRunId, lastRunStatus });
  const drawn = hasDrawnMap({
    lastRunStatus,
    runStatuses: entries.map((entry) => entry.run.status),
  });

  if (expanded) {
    return (
      <section
        aria-label="변경 기록"
        className="flex min-h-0 min-w-0 flex-1 flex-col self-stretch overflow-hidden"
      >
        {/* The title and the one control, on one line. The button sits with
            the heading rather than at the end of the lists, because it acts on
            the project and not on any row in them. */}
        <div className="flex shrink-0 items-start gap-3 pb-2">
          <div className="min-w-0 flex-1">
            <h2 className="display-kr text-[15px] text-said">변경 기록</h2>
            <p className="mt-1 max-w-[68ch] text-[12px] leading-[1.7] text-said-faint text-pretty">
              코드를 바꿔 온 기록과, 그때마다 그린 지도를 나란히 보여드려요. 하나를 고르면 무엇이 바뀌었는지 알려드리고, 그 자리를 지도에서 밝혀요.
            </p>
          </div>
          <RereadButton
            projectId={projectId}
            expanded
            going={going}
            drawn={drawn}
            onStarted={onStarted}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
          <div className="min-h-0 flex-1 overflow-y-auto pr-2 [scrollbar-color:var(--color-edge-lit)_transparent] [scrollbar-width:thin]">
            <h3 className="label-kr text-[11px] text-said-soft">코드를 바꾼 기록</h3>
            {changesNote ? (
              <p className="mt-1 text-[12px] leading-[1.7] text-said-faint">
                {changesNote}
              </p>
            ) : (
              <div className="mt-1">
                <ChangeGraphList
                  changes={changes?.changes ?? []}
                  graph={graph}
                  runHeadlines={runHeadlines}
                  now={now}
                  selectedSha={selectedSha}
                  pendingSha={pendingSha}
                  onPick={(sha) => void pick(sha)}
                />
              </div>
            )}
            {/* Why the oldest row above is not the project's first change. */}
            {changes?.truncated ? (
              <p className="pt-2 text-[11px] leading-[1.7] text-said-faint tabular-nums text-pretty">
                최근 {changes.changes.length}번만 보여드려요. 그 아래로도 기록이 더 있어요.
              </p>
            ) : null}

            <h3 className="label-kr mt-8 text-[11px] text-said-soft">지도를 그린 기록</h3>
            {note ? (
              <p className="mt-1 text-[12px] text-said-faint">{note}</p>
            ) : (
              <ol className="mt-1">
                {entries.map((entry) => (
                  <HistoryRow key={entry.run.id} entry={entry} now={now} />
                ))}
              </ol>
            )}

            {/* Why the oldest row above says 이때 다시 읽었어요 rather than naming
                itself the first run. Rendered only when there is something to say,
                so it never costs a line of an empty band. */}
            {loaded?.truncated || stale ? (
              <p className="pt-2 text-[11px] leading-[1.7] text-said-faint tabular-nums text-pretty">
                {loaded?.truncated ? `최근 ${entries.length}번만 보여드려요. ` : null}
                {stale ? STALE : null}
              </p>
            ) : null}
          </div>

          {open || detailError ? (
            <aside
              aria-label="고른 변경"
              className="min-h-0 shrink-0 overflow-y-auto border-edge [scrollbar-color:var(--color-edge-lit)_transparent] [scrollbar-width:thin] lg:w-[24rem] lg:border-l-[0.8px] lg:pl-4"
            >
              {detailError ? (
                <p role="alert" className="text-[12px] leading-[1.7] text-c4 text-pretty">
                  {detailError}
                </p>
              ) : open ? (
                <ChangeDetailPanel
                  detail={open}
                  now={now}
                  onClose={() => onLight?.(null)}
                />
              ) : null}
            </aside>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="변경 기록"
      className="flex min-w-0 flex-1 items-center gap-3 self-stretch overflow-hidden"
    >
      <span className="label-kr shrink-0 text-said-soft">변경 기록</span>
      {/*
        The one control the strip must carry.

        A change can be picked while the band is open and the band then put
        back to a strip, leaving the map showing an answer whose only switch is
        off screen — which reads as the map being stuck rather than as an
        answer being shown.

        It says 고른 변경 and not 지도에 비추는 중, because a change that touched
        nothing the map holds is picked without anything being lit, and that is
        the common case on a project whose analyzer only places files. A button
        claiming the map is lit beside a map that is not would be the one
        sentence on this strip that is not true.
      */}
      {selectedSha ? (
        <button
          type="button"
          onClick={() => onLight?.(null)}
          className="shrink-0 rounded-md border border-edge-lit px-2 leading-[1.5] text-said-soft transition-colors hover:border-said-faint hover:bg-ink hover:text-said"
        >
          고른 변경 지우기
        </button>
      ) : null}
      {note ? (
        // `flex-1` so the one control below keeps the same corner whether the
        // strip is showing its list or a sentence instead of one. A button that
        // moves when a project finishes loading is a button people miss.
        <span className="min-w-0 flex-1 truncate">{note}</span>
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

      {/*
        Last, so it is the right-hand end of the strip — the list and the
        sentence above it both take the space between.

        Icon-only here. `layout.history` rests at 0.045, which is a band of
        roughly 19–31px, and its wrapper spends 13 of those on padding and a
        border. So the mark is 14px — shorter than the chips it sits beside, and
        therefore the last thing in this strip to be clipped — and a word beside
        it would not fit at any of those heights. The word is still read aloud,
        and it is on the hover.
      */}
      <RereadButton
        projectId={projectId}
        expanded={false}
        going={going}
        drawn={drawn}
        onStarted={onStarted}
      />
    </section>
  );
}

/**
 * What one change was, in plain language.
 *
 * Not a diff, and the distinction is the whole reason this panel exists. A diff
 * assumes the reader can read code, which is the one assumption this product
 * does not make. What it says instead is: when, who, what the person wrote
 * about it in their own words, how many files moved and in which direction,
 * and how much of that landed on the map.
 */
function ChangeDetailPanel({
  detail,
  now,
  onClose,
}: {
  detail: ChangeDetail;
  now: number;
  onClose: () => void;
}) {
  const at = parseWhen(detail.at);
  const facts = changeFacts(detail);
  const shown = detail.files.slice(0, FILES_SHOWN);
  const hidden = detail.files.length - shown.length;

  return (
    <div className="pb-2">
      <div className="flex items-start gap-2">
        <h3 className="display-kr min-w-0 flex-1 text-[14px] leading-[1.35] text-said text-pretty">
          {detail.title}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-said-faint transition-colors hover:bg-ink hover:text-said-soft"
        >
          닫기
        </button>
      </div>

      <p className="mt-1 text-[11px] leading-[1.7] text-said-faint tabular-nums">
        {[at ? exactWhen(at) : null, at ? formatWhen(at, new Date(now)) : null, detail.authorName]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {detail.body ? (
        // The person's own words, kept as they wrote them — line breaks and
        // all. Nothing here rewrites a commit message: we have no better
        // account of what they were doing than the one they left.
        <p className="mt-2 whitespace-pre-wrap border-l-[0.8px] border-edge-lit pl-3 text-[12px] leading-[1.7] text-said-soft">
          {detail.body}
        </p>
      ) : null}

      <p className="mt-3 text-[13px] leading-[1.6] text-said tabular-nums text-pretty">
        {changeHeadline(detail)}
      </p>
      {facts.length > 0 ? (
        <p className="mt-1 text-[11px] leading-[1.7] text-said-faint tabular-nums">
          {facts.join(" · ")}
        </p>
      ) : null}

      <p className="mt-2 text-[12px] leading-[1.7] text-said-faint tabular-nums text-pretty">
        {litSentence(detail)}
      </p>

      {detail.fileListMissing ? (
        <p className="mt-2 text-[11px] leading-[1.7] text-said-faint text-pretty">{MISSING_NOTE}</p>
      ) : null}
      {detail.fileListTruncated ? (
        <p className="mt-2 text-[11px] leading-[1.7] text-said-faint text-pretty">{TRUNCATED_NOTE}</p>
      ) : null}

      {shown.length > 0 ? (
        <ul className="rule-t mt-3 pt-2">
          {shown.map((file) => (
            <li
              key={`${file.path}-${file.status}`}
              className="flex items-baseline gap-2 py-1"
            >
              {/*
                A file the map does not hold is still listed, dimmed. It changed
                — that is a fact about their project — and leaving it out would
                make the panel's own count disagree with its own list.
              */}
              <span
                className={`min-w-0 flex-1 truncate text-[11px] leading-[1.6] ${
                  file.onMap ? "text-said-soft" : "text-said-faint"
                }`}
                title={file.path}
              >
                {file.path}
              </span>
              <span className="shrink-0 text-[10px] text-said-faint">
                {STATUS_WORDS[file.status]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {hidden > 0 ? (
        <p className="mt-1 text-[11px] text-said-faint tabular-nums">
          그 밖에 {hidden.toLocaleString("ko-KR")}개가 더 있어요.
        </p>
      ) : null}

      <p className="mt-3 text-[11px] text-said-faint">
        이 변경의 번호{" "}
        <code
          title={`이 번호로 그때의 코드를 찾을 수 있어요. 전체: ${detail.sha}`}
          className="text-said-soft"
        >
          {shortChangeSha(detail.sha)}
        </code>
      </p>
    </div>
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
      className="flex shrink-0 items-center gap-1.5 rounded-md border-[0.8px] border-edge bg-ink px-2 leading-[1.5]"
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
    <li className="flex gap-3 border-b-[0.8px] border-edge py-2.5 last:border-b-0">
      <Dot tone={runTone(entry.run)} className="mt-[7px]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {at ? (
            <time dateTime={entry.at} className="text-[13px] text-said tabular-nums">
              {formatWhen(at, new Date(now))}
            </time>
          ) : null}
          <span className="text-[13px] leading-[1.6] text-said-soft tabular-nums">
            {runHeadline(entry)}
          </span>
        </div>

        {meta ? (
          <p className="mt-1 text-[11px] leading-[1.7] text-said-faint tabular-nums">{meta}</p>
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
