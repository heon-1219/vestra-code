"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  indexFlowGraph,
  traceFlow,
  type FlowGraph,
  type FlowIndex,
  type FlowPath,
  type FlowTrace,
} from "@/lib/graph/flow";

import type { BeamIndex } from "../map/beam";
import type { Trail } from "../map/render/scene";
import { NO_TRAIL } from "../map/render/scene";
import {
  openPlayer,
  replay as replayPlayer,
  seek as seekPlayer,
  setSpeed as setSpeedPlayer,
  showAll as showAllPlayer,
  step as stepPlayer,
  stepMs,
  tick,
  togglePlay,
  type FlowSpeed,
  type Player,
} from "./player";
import {
  listedStarts,
  startNote,
  startsForQuestion,
  type FlowChoice,
  type StartOrigin,
} from "./start";
import { hereIn, trailOfFlow } from "./trail";

/**
 * One flow, from asked to watched.
 *
 * Owned by the workspace rather than by the panel, for the reason `useAsk` is:
 * **two** things need it. The panel reads the path as a list and the map lights
 * it as a picture, and a hook inside the panel would leave the map with no way
 * to see the flow short of handing it back up — which is this, with more steps.
 *
 * ## Nothing here is in flight, and the shape says so
 *
 * There is no loading state in this file and there is not supposed to be. The
 * walk is pure arithmetic over a graph the browser is already holding: it runs
 * inside the click handler, returns the whole path, and the session is either
 * there or it is not. `FLOW_TRACKING.md` §5 is explicit that the paced reveal
 * is an **animation of a finished answer**, so a spinner here would be the
 * product inventing work it did not do.
 *
 * That also means no model and no network. §4's arithmetic: a flow costs zero
 * model calls warm and at most one cold, and Phase 1 is the warm case by
 * construction because Layers 0 and 1 are the only narrators wired.
 */

/** Everything one flow is, as the two halves of the screen read it. */
export type FlowSession = {
  /** What the user typed, or "" when they picked a place instead. */
  question: string;
  /** Where the walk began. Null when the typed words matched nothing. */
  choice: FlowChoice | null;
  /** Why it began there, in the user's words. Empty when `choice` is null. */
  note: string;
  /** The finished walk. Null when there was nothing to walk. */
  trace: FlowTrace | null;
  /**
   * The one refusal `flow.ts` has no word for: the typed words matched nothing
   * on the map, so there was no start to refuse *from*. Our sentence, checked
   * by the same `flowSentenceIssues` every other sentence in this feature is.
   */
  missed: string | null;
  /** Other places the same words matched, best first. The panel offers them. */
  candidates: FlowChoice[];
};

/**
 * How far down the ranked candidates a typed question will look for a start
 * that leads somewhere.
 *
 * Not one, and not all of them. "결제" on a real project matches the page, the
 * button, the helper and the test fixture, and the page is ranked first but is
 * sometimes the one whose file we failed to read — walking only the top
 * candidate would answer a perfectly good question with 나가는 연결을 못 찾았어요
 * while the second candidate had the whole path. Six because each attempt is a
 * bounded beam search (§2.5) and six of them is still a constant, and because
 * past six the thing being offered is no longer what the person typed.
 *
 * When none of the six leads anywhere, the refusal shown is the **top**
 * candidate's, not the sixth's: the honest answer to "결제가 어떻게 되나요" is
 * about 결제, not about the fourth thing that happened to share a syllable.
 */
const TRIES = 6;

/**
 * Whether this person asked for less motion.
 *
 * `useSyncExternalStore` and not an effect, for the reason `usePhoneLayout`
 * gives one screen over: the server has no media queries, so the server and the
 * first client render have to agree on something, and React then re-reads and
 * re-renders once before paint. Reading it in an effect and calling setState is
 * the shape React 19 rejects outright, and it would also play one step of an
 * animation at somebody who asked for none.
 *
 * The server's answer is `false`, which is the same answer the global CSS rule
 * in `globals.css` assumes: reduced motion is applied by a media query there,
 * so a server that guessed `true` would be the one place in the product that
 * decided this for the visitor rather than asking their browser.
 */
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(listener: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(REDUCED_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function getReduced(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(REDUCED_QUERY).matches;
}

const getServerReduced = () => false;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, getReduced, getServerReduced);
}

/** The sentence for words that landed nowhere. §7's voice, our own case. */
export function noMatchSentence(question: string): string {
  const said = question.trim();
  const quoted = said.length > 0 ? `"${said}"` : "적어 주신 말";
  return (
    `${quoted}에 맞는 자리를 지도에서 찾지 못했어요. ` +
    "다른 낱말로 적어 보시거나, 아래에 있는 주소 중 하나를 골라 주시면 거기서부터 따라가 볼게요."
  );
}

export type FlowControls = {
  session: FlowSession | null;
  player: Player;
  /** True when this person asked for less motion, so nothing is paced. */
  reduced: boolean;
  /**
   * Which of the walk's paths is showing: 0 is the best one, 1 and up are the
   * runner-ups the beam already had in hand. §7's alternatives sentence ends
   * "아래에서 바꿔 볼 수 있어요", so there has to be a way to.
   */
  pathAt: number;
  /** Every path the walk finished, best first. What `pathAt` indexes. */
  paths: readonly FlowPath[];
  /** The one being read. Null when the walk refused. */
  path: FlowPath | null;
  /** The path as the map draws it, trimmed to what has been revealed. */
  trail: Trail;
  /** The item the reader is on right now. The map centres on it. */
  here: string | null;
  /** How many steps the path has. Zero when there is no path. */
  hops: number;

  /** Walk from a place that was clicked — a discovery button, or a selection. */
  follow: (itemId: string, origin: StartOrigin) => void;
  /** Walk from a typed sentence, falling back to the selection when it is dumb. */
  ask: (question: string, selectedId: string | null) => void;
  clear: () => void;

  playPause: () => void;
  stepBy: (delta: number) => void;
  replay: () => void;
  seek: (to: number) => void;
  showAll: () => void;
  chooseSpeed: (speed: FlowSpeed) => void;
  choosePath: (at: number) => void;
};

export function useFlow(graph: FlowGraph | null, beamIndex: BeamIndex): FlowControls {
  const reduced = useReducedMotion();
  const [session, setSession] = useState<FlowSession | null>(null);
  const [player, setPlayer] = useState<Player>(() => openPlayer(0, reduced));
  const [pathAt, setPathAt] = useState(0);

  /**
   * Built once per graph, and the reason it is exported from `flow.ts` at all:
   * `traceFlow` is called once per candidate when a question is resolved and
   * once per entry point when the discovery list is drawn, and rebuilding this
   * each time would make listing a project's flows quadratic in its graph.
   */
  const index: FlowIndex | null = useMemo(
    () => (graph ? indexFlowGraph(graph) : null),
    [graph],
  );

  const paths: readonly FlowPath[] = useMemo(() => {
    const trace = session?.trace;
    if (!trace?.path) return [];
    return [trace.path, ...trace.alternatives];
  }, [session]);

  const path = paths[pathAt] ?? paths[0] ?? null;
  const hops = path?.hops.length ?? 0;

  const begin = useCallback(
    (next: FlowSession) => {
      setSession(next);
      setPathAt(0);
      setPlayer(openPlayer(next.trace?.path?.hops.length ?? 0, reduced));
    },
    [reduced],
  );

  const follow = useCallback(
    (itemId: string, origin: StartOrigin) => {
      if (!graph || !index) return;
      const trace = traceFlow(graph, { startId: itemId, index });
      const item = graph.items.find((one) => one.id === itemId) ?? null;
      const choice: FlowChoice | null = item
        ? { item, origin, hits: 0, words: [], others: 0, via: null }
        : null;
      begin({
        question: "",
        choice,
        note: choice ? startNote(choice) : "",
        trace,
        missed: null,
        candidates: [],
      });
    },
    [begin, graph, index],
  );

  const ask = useCallback(
    (question: string, selectedId: string | null) => {
      if (!graph || !index) return;

      const typed = question.trim();
      const candidates = typed === "" ? [] : startsForQuestion(graph, beamIndex, typed);

      if (candidates.length === 0) {
        // Nothing typed, or nothing matched. A selection is the next-best
        // start (§2.3 ranks it second) and is what 흐름 따라가기 promises when
        // the box is empty.
        if (selectedId !== null) {
          follow(selectedId, "selection");
          return;
        }
        begin({
          question: typed,
          choice: null,
          note: "",
          trace: null,
          missed: noMatchSentence(typed),
          candidates: listedStarts(graph),
        });
        return;
      }

      let chosen: { choice: FlowChoice; trace: FlowTrace } | null = null;
      let first: { choice: FlowChoice; trace: FlowTrace } | null = null;

      for (const candidate of candidates.slice(0, TRIES)) {
        const trace = traceFlow(graph, { startId: candidate.item.id, index });
        if (first === null) first = { choice: candidate, trace };
        if (trace.path !== null) {
          chosen = { choice: candidate, trace };
          break;
        }
      }

      const landed = chosen ?? first;
      if (!landed) return;

      begin({
        question: typed,
        choice: landed.choice,
        note: startNote(landed.choice),
        trace: landed.trace,
        missed: null,
        candidates,
      });
    },
    [beamIndex, begin, follow, graph, index],
  );

  const clear = useCallback(() => {
    setSession(null);
    setPathAt(0);
    setPlayer(openPlayer(0, reduced));
  }, [reduced]);

  /**
   * Switch to one of the runner-up paths, from the top.
   *
   * From the top rather than at the same step: the two paths share a start and
   * usually diverge somewhere in the middle, so keeping the position would drop
   * the reader into the middle of a story they have not been told, at a step
   * that means something different from the one they were looking at.
   */
  const choosePath = useCallback(
    (at: number) => {
      const next = paths[at];
      if (!next) return;
      setPathAt(at);
      setPlayer(openPlayer(next.hops.length, reduced));
    },
    [paths, reduced],
  );

  /*
   * The timer, and the only clock in this feature.
   *
   * One `setTimeout` per step rather than an interval, so changing speed takes
   * effect on the next step instead of at whatever point in a running interval
   * the change happened to land — and so pausing cannot leave a tick queued.
   */
  useEffect(() => {
    if (!player.playing || hops === 0) return;
    const handle = window.setTimeout(() => {
      setPlayer((current) => tick(current, hops));
    }, stepMs(player.speed));
    return () => window.clearTimeout(handle);
  }, [hops, player]);

  const startId = session?.trace?.start?.id ?? null;

  const trail = useMemo(
    () => (path ? trailOfFlow(startId, path.hops, player.revealed) : NO_TRAIL),
    [path, player.revealed, startId],
  );

  const here = useMemo(
    () => (path ? hereIn(startId, path.hops, player.revealed) : startId),
    [path, player.revealed, startId],
  );

  return {
    session,
    player,
    reduced,
    pathAt,
    paths,
    path,
    trail,
    here,
    hops,
    follow,
    ask,
    clear,
    choosePath,
    playPause: useCallback(() => setPlayer((p) => togglePlay(p, hops)), [hops]),
    stepBy: useCallback((delta: number) => setPlayer((p) => stepPlayer(p, hops, delta)), [hops]),
    replay: useCallback(() => setPlayer((p) => replayPlayer(p, hops)), [hops]),
    seek: useCallback((to: number) => setPlayer((p) => seekPlayer(p, hops, to)), [hops]),
    showAll: useCallback(() => setPlayer((p) => showAllPlayer(p, hops)), [hops]),
    chooseSpeed: useCallback((speed: FlowSpeed) => setPlayer((p) => setSpeedPlayer(p, speed)), []),
  };
}
