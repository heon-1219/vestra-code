"use client";

import { memo } from "react";

import {
  shapeWords,
  shortChangeSha,
  type ChangeRecord,
} from "./changes";
import type { ChangeGraph, ChangeNode } from "./lanes";
import { exactWhen, formatWhen, parseWhen } from "./when";

/**
 * The branch graph: every change as a dot on a lane, and the lines between.
 *
 * `lanes.ts` decides where everything goes and this file only draws it, which
 * is the same split the map keeps between `render/` and the canvas component.
 * The one thing that is a decision here rather than a drawing detail is that
 * **every row is exactly `ROW_H` tall**. The picture is one SVG laid over the
 * whole list rather than a fragment per row, so a row that grew to fit a long
 * title would slide every dot below it off its own line — silently, and into a
 * shape that still looks like a branch graph. So the height is an inline style
 * rather than a utility class: `h-11` is 44px only while the root font size is
 * 16px, and a person who has turned their browser text up would get a picture
 * that no longer lines up with the history it claims to show.
 *
 * The SVG is `aria-hidden`. Everything it says — this change merged two lines,
 * this one is where they split, this one is the one we drew a map from — is in
 * the row's own accessible name as words, because a picture is not reachable
 * by anybody who cannot see it and these are facts about their own project.
 */

/** Row height in pixels. The SVG's geometry and the list's must agree exactly. */
const ROW_H = 44;
/** Horizontal distance between two lanes. */
const LANE_W = 15;
/** Where lane 0's centre sits, from the left edge of the gutter. */
const LANE_ORIGIN = 10;
const DOT_R = 4.5;
/** Room between the last lane and the text. */
const GUTTER_TAIL = 14;

const DRAWN_BADGE = "지도를 그린 곳";

export type ChangeGraphProps = {
  changes: readonly ChangeRecord[];
  graph: ChangeGraph;
  /** What each run that drew a map changed, by run id. Missing is normal. */
  runHeadlines: ReadonlyMap<string, string>;
  /** The clock the band keeps, so the server and the first client render agree. */
  now: number;
  selectedSha: string | null;
  /** The change whose details are being fetched right now, if any. */
  pendingSha: string | null;
  onPick: (sha: string) => void;
};

export function ChangeGraphList({
  changes,
  graph,
  runHeadlines,
  now,
  selectedSha,
  pendingSha,
  onPick,
}: ChangeGraphProps) {
  const gutter = graph.laneCount * LANE_W + LANE_ORIGIN + GUTTER_TAIL;
  const height = graph.nodes.length * ROW_H;
  const byRow = new Map(graph.nodes.map((node) => [node.sha, node]));

  return (
    <div className="relative">
      <Lines graph={graph} gutter={gutter} height={height} selectedSha={selectedSha} />
      <ol>
        {changes.map((change) => {
          const node = byRow.get(change.sha);
          // A change the layout did not place cannot be drawn on a lane, and a
          // row with no dot beside it would read as a missing one. It should
          // not happen — the layout is given this same list — so it is skipped
          // rather than invented.
          if (!node) return null;
          return (
            <ChangeRow
              key={change.sha}
              change={change}
              node={node}
              gutter={gutter}
              headline={
                change.drawnRunId ? runHeadlines.get(change.drawnRunId) ?? null : null
              }
              drawn={change.drawnRunId !== null}
              now={now}
              selected={selectedSha === change.sha}
              pending={pendingSha === change.sha}
              onPick={onPick}
            />
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The lines, drawn once for the whole list.
 *
 * Memoised on the graph rather than redrawn with the selection: the paths are
 * the history and the history does not change when somebody clicks. Only the
 * dots do, and they are cheap.
 */
const Lines = memo(function Lines({
  graph,
  gutter,
  height,
  selectedSha,
}: {
  graph: ChangeGraph;
  gutter: number;
  height: number;
  selectedSha: string | null;
}) {
  const x = (lane: number) => LANE_ORIGIN + lane * LANE_W;
  const y = (row: number) => row * ROW_H + ROW_H / 2;

  return (
    <svg
      aria-hidden="true"
      width={gutter}
      height={height}
      viewBox={`0 0 ${gutter} ${height}`}
      className="pointer-events-none absolute left-0 top-0"
    >
      {graph.edges.map((edge) => {
        const x1 = x(edge.fromLane);
        const y1 = y(edge.fromRow);
        const x2 = x(edge.toLane);
        const y2 = y(edge.toRow);
        // A straight drop when the line stays in its column, a curve when it
        // moves. The control points sit 45% of the way down each end, which is
        // what keeps a lane change reading as one line bending rather than as
        // two lines meeting at a corner.
        const d =
          x1 === x2
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1} ${y1 + (y2 - y1) * 0.45}, ${x2} ${y2 - (y2 - y1) * 0.45}, ${x2} ${y2}`;
        return (
          <path
            key={`${edge.fromSha}-${edge.toSha}-${edge.parentIndex}`}
            d={d}
            fill="none"
            stroke="var(--color-wire)"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        );
      })}

      {/*
        A line leaving the bottom of what we were sent.
        Dashed and short, because it is not a connection to anything we can
        name — it says "there is more history down here", which is true, where
        a solid line to the edge would be drawing a change we never received.
      */}
      {graph.nodes
        .filter((node) => node.continues)
        .map((node) => (
          <path
            key={`on-${node.sha}`}
            d={`M ${x(node.lane)} ${y(node.row) + DOT_R} L ${x(node.lane)} ${y(node.row) + ROW_H * 0.6}`}
            stroke="var(--color-guess)"
            strokeWidth={1.5}
            strokeDasharray="2 3"
            strokeLinecap="round"
          />
        ))}

      {graph.nodes.map((node) => (
        <g key={node.sha}>
          {/* A ring around a merge: two lines arrived here and became one. */}
          {node.merge ? (
            <circle
              cx={x(node.lane)}
              cy={y(node.row)}
              r={DOT_R + 2.5}
              fill="none"
              stroke="var(--color-wire)"
              strokeWidth={1}
            />
          ) : null}
          <circle
            cx={x(node.lane)}
            cy={y(node.row)}
            r={DOT_R}
            fill={
              selectedSha === node.sha ? "var(--color-lamp)" : "var(--color-ink)"
            }
            stroke={
              selectedSha === node.sha
                ? "var(--color-lamp)"
                : "var(--color-said-faint)"
            }
            strokeWidth={1.5}
          />
        </g>
      ))}
    </svg>
  );
});

function ChangeRow({
  change,
  node,
  gutter,
  headline,
  drawn,
  now,
  selected,
  pending,
  onPick,
}: {
  change: ChangeRecord;
  node: ChangeNode;
  gutter: number;
  headline: string | null;
  drawn: boolean;
  now: number;
  selected: boolean;
  pending: boolean;
  onPick: (sha: string) => void;
}) {
  const at = parseWhen(change.at);
  const when = at ? formatWhen(at, new Date(now)) : null;
  const shape = shapeWords(node);

  const meta = [when, change.authorName, ...shape, drawn ? DRAWN_BADGE : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <li style={{ height: ROW_H }}>
      <button
        type="button"
        onClick={() => onPick(change.sha)}
        aria-pressed={selected}
        // The picture's facts, said in words. `title` carries the exact moment
        // and the full message, which is the one thing a 44px row cannot show
        // and the thing somebody opening a change is usually after.
        aria-label={[
          change.title,
          when,
          change.authorName,
          ...shape,
          drawn ? "여기까지를 읽어서 지도를 그렸어요" : null,
        ]
          .filter(Boolean)
          .join(", ")}
        title={at ? `${exactWhen(at)} · ${change.title}` : change.title}
        style={{ paddingLeft: gutter }}
        className={`flex h-full w-full flex-col justify-center gap-0.5 rounded-md pr-2 text-left transition-colors ${
          selected ? "bg-ink-raised" : "hover:bg-ink-raised"
        }`}
      >
        <span className="flex items-baseline gap-2">
          <span
            className={`truncate text-[13px] leading-[1.4] ${
              selected ? "text-said" : "text-said-soft"
            }`}
          >
            {change.title}
          </span>
          {pending ? (
            <span className="shrink-0 text-[11px] text-said-faint">여는 중이에요…</span>
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-[11px] leading-[1.4] text-said-faint">
          <span className="truncate">{meta}</span>
          {/* The run's own sentence, reused rather than recomputed: 항목 12개가
              늘었어요 is `runHeadline`'s to say, here and in the list below. */}
          {headline ? (
            <span className="hidden shrink-0 text-said-faint xl:inline">
              {headline}
            </span>
          ) : null}
          <code className="ml-auto hidden shrink-0 text-[10px] text-said-faint sm:inline">
            {shortChangeSha(change.sha)}
          </code>
        </span>
      </button>
    </li>
  );
}
