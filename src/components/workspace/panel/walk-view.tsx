"use client";

import type { AskSession } from "@/lib/ask/session";
import { RELATION_WORDS, type GraphItem } from "@/lib/graph/view";

import { displayNameOf } from "../map/render/paint";

/**
 * How the answer was found, beside the answer.
 *
 * The founder's ask, in his words: show the graph being walked, and record only
 * the points that turned out to matter. Both halves are here, and they are
 * deliberately two different screens rather than one that fills in.
 *
 * ## While it is working, a narrative. Afterwards, a walk.
 *
 * During the investigation the only thing that exists is the loop's own
 * sentences — "src/lib/format.ts 1-12줄을 읽었어요" — arriving one at a time.
 * They are numbered by step, because that is what they are.
 *
 * Once it stops, the trail arrives and the map lights up, and the numbers on
 * screen are **crossing numbers**: 1 is the first connection the walk went
 * along. Those are not the same numbers — one step that opens an item can cross
 * four connections at once — and showing both at the same time would put two
 * numbering systems on one screen with nothing saying which is which. So the
 * narrative gives way to the walk rather than sitting beside it, and the
 * numbers here are the numbers on the map.
 *
 * ## What it refuses to make tidier
 *
 * A gap in the walk is drawn as a gap and said out loud: the loop gave up and
 * started looking somewhere else, which is a real thing that happened and is
 * more informative than a smooth path. A claim that failed its citation check
 * is shown, not swallowed. A citation the map could not place is counted,
 * because "the picture shows less than the answer" should be something a person
 * can see rather than notice.
 */

export function WalkView({
  session,
  itemsById,
  onSelect,
}: {
  session: AskSession;
  itemsById: ReadonlyMap<string, GraphItem>;
  onSelect: (id: string) => void;
}) {
  const nameOf = (id: string) => {
    const item = itemsById.get(id);
    return item ? displayNameOf(item) : null;
  };

  return (
    <section className="rounded-xl border border-edge bg-ink px-4 py-4">
      <p className="text-[13px] leading-[1.7] text-said-soft">{session.question}</p>

      {session.status === "failed" ? (
        <p className="mt-3 text-[13px] leading-[1.8] text-said">{session.error}</p>
      ) : null}

      {session.answer ? (
        <p className="mt-3 whitespace-pre-wrap text-[14px] leading-[1.85] text-said">
          {session.answer.summary}
        </p>
      ) : null}

      {session.trail ? (
        <Walk session={session} nameOf={nameOf} onSelect={onSelect} />
      ) : (
        <Working session={session} />
      )}

      {session.refused.length > 0 ? (
        <div className="mt-4 border-t border-edge pt-3">
          {/*
            Said plainly rather than hidden. A model that claimed something it
            could not point to is the exact failure this loop exists to catch,
            and a person who never sees it caught has only our word that it is.
          */}
          <p className="text-[12px] text-said-faint">
            근거를 찾지 못해서 빼놓은 이야기가 {session.refused.length}가지 있어요.
          </p>
          <ul className="mt-1.5 space-y-1">
            {session.refused.map((one, index) => (
              <li key={index} className="text-[12px] leading-[1.7] text-said-faint line-through">
                {one.claim}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** The live narrative: what it is doing, as it does it. */
function Working({ session }: { session: AskSession }) {
  if (session.steps.length === 0) {
    return (
      <p className="mt-3 text-[13px] text-said-faint">
        <span className="animate-pulse">어디를 볼지 정하고 있어요…</span>
      </p>
    );
  }

  return (
    <ol className="mt-3 space-y-2">
      {session.steps.map((step) => (
        <li key={step.step} className="flex gap-2.5">
          <span className="mt-[3px] shrink-0 text-[11px] tabular-nums text-said-faint">
            {step.step}
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] leading-[1.7] text-said-soft">{step.note}</span>
            {step.conclusion ? (
              <span className="mt-0.5 block text-[12px] leading-[1.7] text-said-faint">
                {step.conclusion}
              </span>
            ) : null}
          </span>
        </li>
      ))}
      {session.status === "asking" ? (
        <li className="text-[12px] text-said-faint">
          <span className="animate-pulse">계속 찾고 있어요…</span>
        </li>
      ) : null}
    </ol>
  );
}

/**
 * The finished walk, numbered to match the map.
 *
 * Rendered from `points` rather than from `hops`, because a place the loop
 * stood is worth showing even when nothing led to it — that is what a restart
 * looks like, and a list built only from crossings would silently drop it.
 */
function Walk({
  session,
  nameOf,
  onSelect,
}: {
  session: AskSession;
  nameOf: (id: string) => string | null;
  onSelect: (id: string) => void;
}) {
  const trail = session.trail;
  if (!trail || trail.points.length === 0) return null;

  // Which crossing arrives at each place, so a row can wear the same number the
  // map draws on the line leading to it.
  const arrivals = new Map<string, number>();
  trail.hops.forEach((hop, index) => {
    if (!arrivals.has(hop.to)) arrivals.set(hop.to, index + 1);
    if (!arrivals.has(hop.from)) arrivals.set(hop.from, index + 1);
  });

  const relationInto = new Map<string, string>();
  for (const hop of trail.hops) {
    if (!relationInto.has(hop.to)) relationInto.set(hop.to, RELATION_WORDS[hop.relation].short);
  }

  return (
    <div className="mt-4 border-t border-edge pt-3">
      <p className="text-[12px] text-said-faint">이 순서로 따라가서 찾았어요.</p>

      <ol className="mt-2 space-y-1">
        {trail.points.map((point, index) => {
          const name = nameOf(point.id);
          if (!name) return null;
          const previous = trail.points[index - 1];
          // A new leg means the walk restarted here: nothing already on it
          // connects to this place.
          const restarted = previous !== undefined && point.leg !== previous.leg;
          const number = arrivals.get(point.id) ?? null;

          return (
            <li key={point.id}>
              {restarted ? (
                <p className="py-1 text-[11px] text-said-faint">
                  여기서는 막혀서, 다시 다른 곳부터 찾았어요.
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => onSelect(point.id)}
                className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-ink-raised ${
                  point.critical ? "text-said" : "text-said-faint"
                }`}
              >
                <span className="shrink-0 text-[11px] tabular-nums text-said-faint">
                  {number ?? "·"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
                {relationInto.has(point.id) ? (
                  <span className="shrink-0 text-[11px] text-said-faint">
                    {relationInto.get(point.id)}
                  </span>
                ) : null}
                {/*
                  The one distinction that matters: where it looked, against
                  what the answer actually stands on. Drawing both the same way
                  would make the account agree with the answer more than the
                  evidence does.
                */}
                {point.critical ? (
                  <span className="shrink-0 text-[11px] text-lamp">근거</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>

      {trail.unplaced.length > 0 ? (
        <p className="mt-2 text-[11px] text-said-faint">
          이 가운데 {trail.unplaced.length}곳은 지도에서 어디인지 짚지 못했어요.
        </p>
      ) : null}
    </div>
  );
}
