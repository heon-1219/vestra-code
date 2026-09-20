import { z } from "zod";

import { READING } from "./runs";

/**
 * 다시 읽기, from the band: which state the button is in, and what it says once
 * the endpoint has answered.
 *
 * Everything here is pure, for the same reason `runs.ts` and `when.ts` are: the
 * band's job is to be *believable*, and each of these answers is wrong in a way
 * you cannot see by looking at the screen. A button that says 지도 다시 그리기 on
 * a project nobody has read, or one that reports success for a request the
 * server refused, both look perfectly fine.
 *
 * Three decisions live here rather than in the component:
 *
 *   1. **`started: false` is not success.** The endpoint answers 202 with
 *      `started: false` when it found a run already in flight and handed that
 *      one back rather than racing a second against it. Treating that as a
 *      fresh start would tell somebody their re-read began when it did not, and
 *      the run they are actually watching would be an older one.
 *   2. **The run id is handed back either way.** Started or already going, the
 *      id is the thing the workspace needs — without it a real run is happening
 *      with nothing on screen saying so, the person presses again, and the only
 *      reason a second one does not start is that the server refuses. The
 *      button must not depend on that.
 *   3. **A refusal speaks with the endpoint's own sentence.** Every one of them
 *      is already plain Korean written for this person — sign in again, upload
 *      the folder again. Replacing it with 오류 throws away the one thing that
 *      tells them what to do.
 */

/** The statuses that mean a run is happening right now. */
const IN_FLIGHT = new Set(["pending", "running"]);

/** The same word both existing start buttons use while their request is out. */
const STARTING_WORDS = "시작하는 중…";
/**
 * The two labels, taken from `analysis-trigger.tsx` rather than written again.
 * One act, one vocabulary: a band that called it 새로고침 beside a header that
 * calls it 다시 읽기 would read as two different things to press.
 */
const FIRST_WORDS = "지도 그리기";
const AGAIN_WORDS = "지도 다시 그리기";

/**
 * What the band says when the endpoint handed back a run that was already
 * going. The second sentence is `analysis-trigger.tsx`'s own, and it is true
 * here for the same reason it is true there: the id is adopted, so the screen
 * picks that run up where it is.
 */
export const ALREADY_NOTE = "이미 읽고 있어요. 하던 자리에서 이어서 보여드려요.";

/** Only when the refusal carried no sentence of its own, which it always does. */
export const GENERIC_NOTE = "지금은 시작하지 못했어요. 잠시 후에 다시 시도해 주세요.";

/**
 * The request never reached anybody. `workspace.tsx` separates this from a
 * refusal because the instruction is different — check the connection, not the
 * project — and the same sentence is used so both say it the same way.
 */
export const OFFLINE_NOTE = "연결이 끊겼어요. 인터넷 연결을 확인하고 다시 시도해 주세요.";

/**
 * Whether a run is happening, from the two things the workspace already knows.
 *
 * Deliberately **not** read from the band's own runs list. A row left saying
 * `running` by a server that stopped mid-run would lock this button shut
 * forever with no way for the browser to find out otherwise, whereas both
 * signals here can be let go of: `activeRunId` is dropped when the stream ends,
 * and `lastRunStatus` moves with the graph the workspace reloads. A run started
 * in another tab is covered without polling for it — the endpoint answers
 * `started: false` and the band adopts that run instead of starting a second.
 */
export function runIsGoing(signals: {
  /** The run the workspace is watching, if any. */
  activeRunId: string | null;
  /** The status of the run the workspace's map came from. */
  lastRunStatus: string | null;
}): boolean {
  if (signals.activeRunId !== null) return true;
  return signals.lastRunStatus !== null && IN_FLIGHT.has(signals.lastRunStatus);
}

/**
 * Whether this project has a map already, which changes one word on the button
 * and nothing else.
 *
 * `lastRunStatus` is checked first because it is server-rendered and therefore
 * true in the first paint; the band's own list arrives a fetch later, and a
 * label that said 지도 그리기 for that beat and then swapped to 지도 다시 그리기
 * is a button changing its mind in front of somebody about to press it.
 */
export function hasDrawnMap(signals: {
  lastRunStatus: string | null;
  /** The statuses of the runs the band read for itself. */
  runStatuses: readonly string[];
}): boolean {
  if (signals.lastRunStatus === "completed") return true;
  return signals.runStatuses.includes("completed");
}

export type RereadState = {
  /** `going` covers a run this button started and one it merely found. */
  kind: "ready" | "starting" | "going";
  /** The accessible name, and the visible label where there is room for one. */
  label: string;
  /** Whether the icon turns. */
  turning: boolean;
  /** Whether pressing it does anything. */
  pressable: boolean;
};

/**
 * Which of the three states the button is in.
 *
 * `going` is tested before `starting` on purpose: a run someone else began — the
 * centre button, another tab, a refresh that landed on one — is the state this
 * band does not own, and it must win over anything this component thinks it is
 * doing. The band never offers a second run; it says one is happening.
 */
export function rereadState(input: {
  /** This button's own request is out. */
  starting: boolean;
  going: boolean;
  drawn: boolean;
}): RereadState {
  if (input.going) {
    return { kind: "going", label: READING, turning: true, pressable: false };
  }
  if (input.starting) {
    return {
      kind: "starting",
      label: STARTING_WORDS,
      turning: true,
      pressable: false,
    };
  }
  return {
    kind: "ready",
    label: input.drawn ? AGAIN_WORDS : FIRST_WORDS,
    turning: false,
    pressable: true,
  };
}

/** Every way the start request can end, including never arriving. */
export type StartOutcome =
  /** 202, and this run is ours. */
  | { kind: "started"; runId: string }
  /** 202 with `started: false` — one was already in flight, and this is it. */
  | { kind: "already"; runId: string }
  /** The endpoint said no, in its own words. */
  | { kind: "refused"; message: string | null }
  /** 202 whose body was not the shape this endpoint promises. */
  | { kind: "unreadable" }
  /** The request threw: no network, or the page going away under it. */
  | { kind: "offline" };

/** The same two shapes `workspace.tsx` and `analysis-trigger.tsx` parse. */
const startedSchema = z.object({ runId: z.uuid(), started: z.boolean() });
const messageSchema = z.object({ message: z.string() });

/**
 * The response, read into one of the outcomes above.
 *
 * Split out from the fetch so the whole decision is testable without a server:
 * the interesting cases are a 202 that did not start anything and a refusal
 * whose body is missing, and neither is reachable from a component test.
 */
export function readStartResponse(status: number, body: unknown): StartOutcome {
  if (status === 202) {
    const accepted = startedSchema.safeParse(body);
    if (!accepted.success) return { kind: "unreadable" };
    return accepted.data.started
      ? { kind: "started", runId: accepted.data.runId }
      : { kind: "already", runId: accepted.data.runId };
  }

  const told = messageSchema.safeParse(body);
  return { kind: "refused", message: told.success ? told.data.message : null };
}

/**
 * The run this outcome leaves the workspace watching, or null when there is
 * none.
 *
 * A run that was already going is adopted exactly like one we started. It is
 * the same run, it is really happening, and the reason the band hands it up is
 * that the alternative — knowing about it and saying nothing — is the failure
 * this button exists to avoid.
 */
export function adoptedRunId(outcome: StartOutcome): string | null {
  if (outcome.kind === "started" || outcome.kind === "already") {
    return outcome.runId;
  }
  return null;
}

/**
 * The sentence to show, or null when the screen itself is the answer.
 *
 * A run that started needs no sentence: the centre of the workspace becomes the
 * reading screen, which says more than a line in the band could. Every other
 * outcome gets words, and none of them are guessed — a refusal prints what the
 * server said.
 */
export function startNote(outcome: StartOutcome): string | null {
  switch (outcome.kind) {
    case "started":
      return null;
    case "already":
      return ALREADY_NOTE;
    case "refused":
      // An empty string is a message in name only; the generic sentence at
      // least tells them to try again.
      return outcome.message?.trim() || GENERIC_NOTE;
    case "unreadable":
      return GENERIC_NOTE;
    case "offline":
      return OFFLINE_NOTE;
  }
}

/**
 * Whether the sentence is about something that went wrong.
 *
 * 이미 읽고 있어요 is not a failure — the thing the person wanted is happening —
 * and printing it in the colour this interface keeps for failures would tell
 * them the opposite of what the words say.
 */
export function noteIsWrong(outcome: StartOutcome): boolean {
  return (
    outcome.kind === "refused" ||
    outcome.kind === "unreadable" ||
    outcome.kind === "offline"
  );
}
