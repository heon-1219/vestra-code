import type { Finding, QaTrail, RefusalReason, Spend, StopReason } from "@/qa";

import type { AskFrame } from "./frames";

/**
 * One question, and everything known about it so far.
 *
 * A fold over frames, kept apart from React for the usual reason and one
 * specific one: the interesting behaviour here is about **order and lateness**,
 * not about rendering. A conclusion arrives after the step it concludes. The
 * trail arrives after every step. The answer arrives last, or a failure does.
 * Driving that from a test with a list of frames is the only way to be sure the
 * screen never shows a step attached to the wrong conclusion, and no amount of
 * clicking finds that bug because it needs a specific arrival order to appear.
 *
 * Every payload here came off a socket. It is our own server on the other end,
 * but it is still parsed JSON: each field is checked before it is used and a
 * frame that does not make sense is ignored rather than trusted into the state.
 */

export type AskStep = {
  step: number;
  tool: string;
  /** Why the loop did this, in its own words. */
  hypothesis: string;
  /** What came back, as one sentence. Never the result itself. */
  note: string;
  /** The items this put the loop in front of. What the map lights. */
  items: string[];
  /**
   * What it turned out to mean, once the next step says so. Null until then,
   * and null forever for the last step — which is honest: nothing concluded it.
   */
  conclusion: string | null;
};

export type AskAnswer = {
  summary: string;
  findings: Finding[];
  ruledOut: string[];
  stop: StopReason | null;
  spent: Spend | null;
};

export type AskSession = {
  status: "asking" | "answered" | "failed";
  question: string;
  steps: AskStep[];
  /** Claims that did not survive checking. Shown, not hidden — see below. */
  refused: { claim: string; reason: RefusalReason }[];
  /** The finished walk. Null until the loop stops. */
  trail: QaTrail | null;
  answer: AskAnswer | null;
  /** Set only when the stream itself failed. A refusal from the loop is an answer. */
  error: string | null;
};

export function startSession(question: string): AskSession {
  return {
    status: "asking",
    question,
    steps: [],
    refused: [],
    trail: null,
    answer: null,
    error: null,
  };
}

export function failSession(session: AskSession, error: string): AskSession {
  // Only when nothing arrived to answer with. A stream that dropped after the
  // answer still answered, and replacing that with an error message would throw
  // away something true the person already read.
  if (session.answer) return session;
  return { ...session, status: "failed", error };
}

export function applyFrame(session: AskSession, frame: AskFrame): AskSession {
  const payload = asRecord(frame.payload);
  if (!payload) return session;

  switch (frame.type) {
    case "step.taken": {
      const step = asInt(payload.step);
      if (step === null) return session;
      // Replaced rather than appended when the number is one we have. A retried
      // report step reuses its number, and two rows for one step would read as
      // the loop having done the same thing twice.
      const taken: AskStep = {
        step,
        tool: asText(payload.tool) ?? "unknown",
        hypothesis: asText(payload.hypothesis) ?? "",
        note: asText(payload.note) ?? "",
        items: asIds(payload.items),
        conclusion: session.steps.find((one) => one.step === step)?.conclusion ?? null,
      };
      return { ...session, steps: upsert(session.steps, taken) };
    }

    case "step.concluded": {
      /*
       * Attached to the step it names, which is not the latest one.
       *
       * The loop gets a conclusion for step N out of step N+1's tool call —
       * the model writes it as `learned` on its next move, which saves a whole
       * round trip. So this always arrives late, and a reader that appended it
       * to the end would caption every step with the meaning of the one before.
       */
      const step = asInt(payload.step);
      const conclusion = asText(payload.conclusion);
      if (step === null || conclusion === null) return session;
      return {
        ...session,
        steps: session.steps.map((one) =>
          one.step === step ? { ...one, conclusion } : one,
        ),
      };
    }

    case "finding.refused": {
      /*
       * Kept and shown.
       *
       * This is a claim the model made that could not be traced to anything it
       * read, and the loop threw it out. Hiding that would make the product
       * look more certain than it is; showing it is the clearest possible
       * evidence that the citation check is real and not decoration.
       */
      const claim = asText(payload.claim);
      const reason = asText(payload.reason);
      if (claim === null || reason === null) return session;
      return {
        ...session,
        refused: [...session.refused, { claim, reason: reason as RefusalReason }],
      };
    }

    case "qa.trail":
      return {
        ...session,
        trail: {
          points: asArray(payload.points),
          hops: asArray(payload.hops),
          unplaced: asArray(payload.unplaced),
        } as QaTrail,
      };

    case "qa.answer": {
      const summary = asText(payload.summary);
      if (summary === null) return session;
      return {
        ...session,
        status: "answered",
        answer: {
          summary,
          findings: asArray<Finding>(payload.findings),
          ruledOut: asIds(payload.ruledOut),
          stop: (asText(payload.stop) as StopReason | null) ?? null,
          spent: asRecord(payload.spent) as Spend | null,
        },
      };
    }

    // `qa.started` and `qa.stopped` say nothing the screen does not already
    // show: the question is on it before the first frame arrives, and the stop
    // reason comes back on the answer. Ignored rather than stored, so nothing
    // has to be kept in step with them.
    default:
      return session;
  }
}

/** Every item any step touched, oldest first, each one once. */
export function itemsSeen(session: AskSession): string[] {
  const seen = new Set<string>();
  for (const step of session.steps) for (const id of step.items) seen.add(id);
  return [...seen];
}

function upsert(steps: readonly AskStep[], next: AskStep): AskStep[] {
  const at = steps.findIndex((one) => one.step === next.step);
  if (at === -1) return [...steps, next];
  const copy = [...steps];
  copy[at] = next;
  return copy;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one) => typeof one === "string") : [];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
