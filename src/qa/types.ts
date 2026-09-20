import type { Certainty, ConnectionRelation } from "@/lib/graph/view";
import type { LlmError } from "@/lib/llm/types";

/**
 * The vocabulary of an investigation: what goes in, what comes out, and what a
 * person watching it sees on the way.
 *
 * All of it in one file because these four groups only mean anything together —
 * a finding is defined by the citation that backs it, a stop reason is defined
 * by the budget it ran into, and the trace is the same story told live. Split
 * across four modules they would import each other in a circle and read as
 * three unrelated ideas.
 *
 * Two rules are load-bearing here, and both are rules about honesty rather than
 * about types:
 *
 *   1. **`certain` and `inferred`, never a third word.** The same two values
 *      the map already draws (`view.ts`), meaning the same two things: we read
 *      the exact line, or we went by names and connections. A softer third word
 *      is how "I did not check" becomes "probably", and this whole loop exists
 *      because a confident single-shot answer is the failure mode.
 *   2. **Stopping early is an outcome, not an error.** "I ran out of steps
 *      having checked these three places" is a real answer and has a real
 *      shape here. It must never be dressed up as a conclusion, and it must
 *      never be thrown away either.
 */

// --- What comes back -------------------------------------------------------

/**
 * Where a claim was checked. Half-open ranges were considered and rejected: a
 * person reads "40–92줄" and means both ends, and the map's `startLine` /
 * `endLine` are inclusive too. One convention, or line numbers stop matching
 * between the panel and the answer.
 */
export type Citation = { path: string; startLine: number; endLine: number };

export type Finding = {
  /** One claim, in 해요체. Two claims belong in two findings with two citations. */
  claim: string;
  /**
   * `certain` only when a tool returned the cited lines' own text during THIS
   * investigation — `read_source`, `read_file`, a `search_source` hit, or the
   * head `follow_import` opens. Everything else is `inferred`, including
   * something obvious from a name. Enforced in `answer.ts` against the ledger,
   * not trusted.
   *
   * The rule is about the bytes, not about which tool fetched them: a line
   * whose text came back is a line somebody could have read, and a line the
   * graph merely told us exists is not. Every tool that returns source
   * registers `read: true` for exactly the lines it printed, and no tool
   * registers it for lines it summarised.
   */
  certainty: Certainty;
  /**
   * One place, or two when the claim genuinely spans a call and the thing it
   * calls. Three means it is really three findings, and a list of five line
   * ranges under one sentence is how an unchecked claim hides inside checked
   * ones.
   */
  citations: Citation[];
};

/** Why a claim the model made did not survive. Each one is a real failure mode. */
export type RefusalReason =
  /** Cites somewhere this investigation never fetched. The core check. */
  | "unread_citation"
  /**
   * Claims `certain` while citing something only the graph showed us — a
   * search result's own line, a neighbour's line range, a listing.
   */
  | "certain_without_reading"
  /** Says 안전하다, or calls things by the words the product does not use. */
  | "forbidden_words"
  /** Labelled `certain` and then hedged in the sentence itself. */
  | "hedged_certainty";

export type RefusedFinding = Finding & { reason: RefusalReason };

/**
 * Why the loop stopped. Every value is reportable — there is no "failed"
 * bucket, because a user who asked a question is owed a sentence whichever of
 * these happened.
 */
export type StopReason =
  /** The model called `report` and it survived checking. */
  | "answered"
  | "steps_spent"
  | "tokens_spent"
  | "time_spent"
  /** The caller's `AbortSignal` fired, or the model reported an abort. */
  | "stopped"
  /**
   * The reply hit the completion ceiling. A conclusion whose evidence was cut
   * off mid-sentence is not a conclusion, so this never becomes `answered`.
   */
  | "truncated"
  /** The model stopped calling tools without ever filing a report. */
  | "no_answer"
  /** The model or its endpoint failed. `Investigation.failure` says how. */
  | "llm_failed";

export type Budget = {
  maxSteps: number;
  /** Across every turn, not per turn. History is re-sent, so this is the real cost. */
  maxInputTokens: number;
  maxOutputTokens: number;
  maxMillis: number;
};

export type Spend = {
  /** Model turns taken, including ones spent recovering from a bad tool call. */
  steps: number;
  inputTokens: number;
  outputTokens: number;
  millis: number;
};

/**
 * The budget, measured rather than reasoned.
 *
 * The numbers here used to be an argument: twelve steps because "twelve is the
 * number a person waits through", 60k input from an estimate of the triangular
 * history cost, ninety seconds because twelve round trips "is already a minute
 * or two". Every one of them was wrong in the same direction, and the way we
 * found out was to run the loop against a real project and write down what
 * happened rather than what we expected.
 *
 * ## What was measured
 *
 * Three questions a person would actually type, against a real Python project
 * — 48 files, 213 pieces, 284 connections — read from GitHub at the commit the
 * map was drawn at. `src/qa/measure.test.ts` is the harness, and it is kept so
 * the next person to change these numbers has to produce numbers too.
 *
 * On the old budget, all three investigations used **11 of 12 steps**. One of
 * them stopped at `tokens_spent` on step 11 having read 557 lines and filed
 * **nothing at all**. Two of eleven steps went on searching for words the
 * project does not use, twice with the same word, because the only search
 * there was matched names. Wall clock was **23–27 seconds** against a
 * ninety-second ceiling — so the constraint everyone assumed was patience was
 * in fact steps and tokens, and time was not close to binding.
 *
 * The same question, with the searching and following tools and this budget:
 * **16 steps of 20**, 104k input of 150k, 36 seconds, **11 files and 406 lines
 * read**, and **five findings, all `certain`, none refused**. It finished
 * because it was done, not because a ceiling stopped it — which is the whole
 * shape of the change, and the thing to check first if these numbers ever move
 * again.
 *
 * ## The numbers, and what each is protecting
 *
 * **20 steps.** The ceiling is still what a person waits through, but that
 * turned out to be a wall-clock question rather than a step-count one: a step
 * is about 2.2 seconds, so twenty steps is around forty-five — measured at
 * 36.3s for the sixteen-step run above, against the 23–27s eleven steps took.
 * Twelve was stopping investigations mid-read: the two questions that now
 * finish on their own take **6** and **16** steps, and twelve would have cut
 * the second one off four steps from its answer. Twenty is the first number
 * that is a ceiling rather than a wall — both runs stopped when they were
 * finished.
 *
 * **150k input.** The real driver, and the one that was quietly binding. Input
 * is roughly linear at 4–6k per step once `HISTORY_FULL_STEPS` starts
 * collapsing older results — measured 46k for eleven light steps and 64k for
 * eleven reading ones. Twenty reading steps is therefore about 120k, and 150k
 * leaves room for a question that arrives with context without making the
 * token ceiling the thing that stops a run. The step ceiling should be what
 * stops it, because the step ceiling is the one a person can feel.
 *
 * It can still bind, and that is stated rather than hidden: six full results
 * of 6,000 characters each — an investigation made entirely of whole-file
 * reads of long files — is nearer 9k a turn, and would run out of tokens
 * around step fifteen. That is a real outcome with a real sentence, not a
 * bug. Raising the ceiling to cover the worst case would mean paying for the
 * worst case on a question that never comes near it.
 *
 * **30k output.** Not a working budget — a guard. Measured output was 829
 * tokens over six steps and 1,627 over twenty, about eighty a step.
 * `PER_CALL_OUTPUT_TOKENS` is what actually stops one runaway turn (D46:
 * `mimo-v2.5` has a 32,768 completion ceiling and charges reasoning against
 * it), and this is ten such turns out of twenty — far past anything measured,
 * close enough to catch a loop that has started writing essays instead of
 * calling tools.
 *
 * **180 seconds.** Comfortably past the measured worst case, and still under
 * the five minutes after which Railway closes a connection that has sent no
 * data (D17) — which `src/lib/ask/stream.ts` now covers anyway with a
 * twenty-second keepalive, so the silence this is protecting against is the
 * user's patience rather than a proxy's. Ninety seconds was never protecting
 * anything: it was three times the wall clock a whole investigation actually
 * takes, and the run it would have cut short would have been cut short by the
 * step ceiling first.
 *
 * ## What more budget must not buy
 *
 * A bigger budget is more looking, never more confidence. "I ran out of steps
 * having checked these three places" is still a real answer with a real shape
 * here, and nothing in `answer.ts` loosened to pay for these numbers — the
 * measured runs that came back with only `inferred` findings came back that
 * way because the files would not open, and said so.
 */
export const DEFAULT_BUDGET: Budget = {
  maxSteps: 20,
  maxInputTokens: 150_000,
  maxOutputTokens: 30_000,
  maxMillis: 180_000,
};

export type Investigation = {
  question: string;
  stop: StopReason;
  /**
   * What a person reads. 해요체, plain words.
   *
   * Written by the model only when at least one finding survived checking.
   * Otherwise this file's own sentence, because an ungrounded paragraph with a
   * disclaimer under it still gets read as the answer.
   */
  summary: string;
  /** Claims that carry a citation this investigation actually fetched. */
  findings: Finding[];
  /** Claims we would not pass on, and why. Empty is the good case. */
  refused: RefusedFinding[];
  /**
   * What the loop checked and moved past, in the model's own words.
   *
   * This is what makes "I ran out of steps" a real answer rather than an
   * apology. It is an account of where we looked, not a guarantee that those
   * places are clear — present it as 이렇게 찾아봤어요, never as a conclusion.
   */
  ruledOut: string[];
  /** What the model said it could not settle. Null when it never got to say. */
  unresolved: string | null;
  /** How the endpoint failed, when it did. Null otherwise. */
  failure: { kind: LlmError["kind"]; retryable: boolean } | null;
  /**
   * How much of the project this investigation actually opened.
   *
   * Counted from the ledger, so it is the same record the citation check runs
   * against rather than a second tally that could disagree with it. Distinct
   * lines, not lines returned: a file read twice at overlapping windows was
   * read once, and reporting 120 for 80 lines would be the kind of small
   * wrongness that makes every other number here suspect.
   *
   * It exists because "the loop reads more of the project now" is a claim, and
   * a claim about this product needs a number under it. The budget in this
   * file was re-derived from this one.
   */
  read: { files: number; lines: number };
  /** The walk, in item ids the map can light. Always present, often empty. */
  trail: QaTrail;
  trace: QaEvent[];
  spent: Spend;
  budget: Budget;
};

// --- The trail -------------------------------------------------------------

/**
 * How the graph was walked to reach the answer.
 *
 * The trace says what happened in sentences; the trail says it in item ids,
 * which is the only form the map can act on — it lights things by id. Without
 * this the account and the picture are two separate products, and the person
 * reading "src/lib/format.ts 7줄" has to find that place themselves on a map
 * that is already showing it.
 *
 * Three rules, and each one is a way the picture could agree with the answer
 * more than the evidence does:
 *
 *   1. **A point is somewhere the loop was actually put.** A search result, an
 *      item it opened, a file it read. A folder listing reveals names, not
 *      places, so it contributes nothing — the same line `answer.ts` draws when
 *      it refuses to make a listed file citable.
 *   2. **`critical` means a surviving finding cites it.** Not "the model
 *      dwelled here", not "it looked promising". A point visited and then
 *      abandoned is exactly as uncritical as one never visited, and marking it
 *      otherwise would draw a conclusion the citations do not support.
 *   3. **A hop is a connection that exists in the graph**, carried by its own
 *      id so the map draws a line it already has rather than one we invented.
 *      Where two points have no connection between them, there is no hop and
 *      the leg number goes up — the walk restarted, and saying so is the only
 *      honest alternative to drawing an edge that is not there.
 */
export type TrailPoint = {
  /** The item's id. What the map lights. */
  id: string;
  /**
   * Its number in the catalog — the integer the model itself saw (D46). Carried
   * so a person reading the trace beside the trail sees the same `[6]` in both.
   */
  number: number;
  /** The step that first put this on the walk. Deduplicated, so first arrival. */
  step: number;
  /**
   * Which run of the walk this belongs to. 1 for the first.
   *
   * It goes up when a step lands somewhere nothing already on the trail is
   * connected to — a fresh search after a dead end. That is a real event in an
   * investigation and the picture has to be able to show it as a gap rather
   * than as a line.
   */
  leg: number;
  /** A surviving finding cites this item. */
  critical: boolean;
};

/**
 * `opened` — the loop asked this item for its neighbours and this connection is
 * what came back. The walk went along it.
 *
 * `adjacent` — the loop arrived some other way, by a search or by reading a
 * file, and the graph already held a link to something on the trail. The
 * picture is connected because the code is, not because the walk crossed here.
 * Kept apart because collapsing them would let a search result read as a
 * traversal.
 */
export type TrailHopVia = "opened" | "adjacent";

export type TrailHop = {
  /** The connection's own id, so the map draws an edge it already knows. */
  connectionId: string;
  from: string;
  to: string;
  relation: ConnectionRelation;
  certainty: Certainty;
  /** The step that established it. */
  step: number;
  via: TrailHopVia;
};

export type QaTrail = {
  points: TrailPoint[];
  hops: TrailHop[];
  /**
   * Citations that could not be put on the map.
   *
   * The finding still carries them — a line number is a line number, and the
   * answer is not worth less for the map being unable to draw it. This exists
   * so that "the picture shows less than the answer" is a number somebody can
   * see rather than something they notice later.
   */
  unplaced: Citation[];
};

// --- The trace -------------------------------------------------------------

/**
 * The same shape as `analysis/events.ts`: a sequence number, a type, and a
 * small JSON payload. Deliberately identical so the existing SSE machinery can
 * carry these without a second format — this module does not wire the
 * transport, it just refuses to invent a shape the transport cannot take.
 *
 * Payloads stay small for the same reason they do there. A trace that carried
 * the source it read would be larger than the answer, and would put someone's
 * code into an event log we promised not to keep (section 3).
 */
export type QaToolName =
  | "find_items"
  | "open_item"
  | "list_files"
  | "list_tree"
  | "read_source"
  | "read_file"
  | "search_source"
  | "follow_import"
  | "report";

export type QaEventType =
  | "qa.started"
  | "step.taken"
  | "step.concluded"
  | "finding.refused"
  | "qa.trail"
  | "qa.stopped";

export type QaEventPayloads = {
  "qa.started": { question: string; maxSteps: number; itemCount: number };
  /**
   * The hypothesis and what came back, one line each. Never the result itself.
   *
   * `"unknown"` is a real value: a model sometimes calls a tool that does not
   * exist, the loop tells it so, and that step happened and cost the budget.
   * Recording it as one of the real tools would put a step in the trace that
   * never ran.
   */
  "step.taken": {
    step: number;
    tool: QaToolName | "unknown";
    hypothesis: string;
    note: string;
    /**
     * The items this result put the loop in front of, by id.
     *
     * The one place a QA payload carries ids rather than counts, and it is
     * worth the bytes: a watcher that only has the sentence "src/lib/format.ts
     * 1-12줄을 읽었어요" has to parse Korean to light anything. Empty for a
     * folder listing, which reveals names rather than places, and empty for a
     * step that did not run.
     */
    items: string[];
  };
  /**
   * What the previous step turned out to mean.
   *
   * It arrives one turn late on purpose: the model writes it as `learned` on
   * its NEXT tool call, so we get the conclusion of step N from step N+1
   * without spending a second round trip asking for it. `step` is the step
   * being concluded, which is why it is not always the latest one.
   */
  "step.concluded": { step: number; conclusion: string };
  "finding.refused": { claim: string; reason: RefusalReason };
  /**
   * The finished walk, once — the only event that carries `critical`, because
   * criticality is not knowable until the findings have survived checking.
   *
   * Larger than the other payloads here, and the reason `analysis/events.ts`
   * keeps its own small does not apply: these are streamed straight to one
   * browser and written to no table. A caller that would rather put the trail
   * beside the answer can ignore this event and read `Investigation.trail`.
   */
  "qa.trail": QaTrail;
  "qa.stopped": {
    reason: StopReason;
    steps: number;
    inputTokens: number;
    outputTokens: number;
    millis: number;
    findings: number;
    refused: number;
  };
};

export type QaEvent<T extends QaEventType = QaEventType> = {
  seq: number;
  type: T;
  payload: QaEventPayloads[T];
};

/**
 * A live listener. Optional everywhere: the trace is returned in full whether
 * or not anyone is watching, so a caller that only wants the answer does not
 * have to collect events to get one.
 */
export type QaEventSink = <T extends QaEventType>(
  type: T,
  payload: QaEventPayloads[T],
) => void;
