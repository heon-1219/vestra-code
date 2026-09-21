import type { ChangeScope } from "../incremental";
import { noDrops, type Drops } from "../semantic/parse";
// `@/lib/llm/types` and never the package index. The index re-exports
// `llmFromEnv`, which reaches `env.ts` — and `env.ts` validates 21 variables at
// import time and throws when one is missing. `LlmError` is a class, so it is a
// runtime import; taken from the index it would make this module, and every
// test of it, unimportable on a machine with no API key.
import { LlmError, type Llm } from "@/lib/llm/types";

import { runInOrder } from "../model-pool";

import {
  batches,
  DEFAULT_PURPOSE_BUDGET,
  outputCeilingFor,
  selectPurposes,
  type PurposeAsk,
  type PurposeBudget,
} from "./ask";
import { parsePurposeReply } from "./parse";
import { buildPurposePrompt, PURPOSE_JSON_SCHEMA, PURPOSE_SYSTEM_PROMPT } from "./prompt";

/**
 * Pass 3 — one sentence per purpose, reused everywhere it applies.
 *
 * Pass 1 draws the map. Pass 2 writes the names on it. This writes what the
 * **lines** mean: not 사용해요 but 여기서 가격을 사람이 읽기 좋은 모양으로 바꿔요.
 *
 * ## Why it is one question per purpose and not one per connection
 *
 * `groups.ts` collapses every connection that shares a relation and a target.
 * Measured on `vestra-code`: **1,711 explainable connections collapse into 801
 * purposes**, 2.14 to one. The saving is real but it is not the point — the
 * point is that the twelfth component to call `formatPrice` is told the same
 * thing as the first, **in the same words**. A map that words one fact twelve
 * ways is a map nobody believes, and that is a trust problem rather than a
 * bill.
 *
 * ## The three rules, the same three Pass 2 is built around
 *
 * **Everything here is the model's opinion.** A purpose sentence never changes
 * a connection's `confidence`; it is prose laid over an edge the parser already
 * measured, written into `metadata.purpose` with no claim of its own. There is
 * no path through this file that makes anything `certain`.
 *
 * **A model failure is never a run failure.** No key, a wrong key, an endpoint
 * down, a budget spent — the pass returns what it has and every connection it
 * could not reach keeps its structural verb, which is true and was never wrong.
 *
 * **A purpose already answered is not asked again.** It belongs to the far end,
 * so a new caller costs nothing; only an edit to the target's file can make it
 * untrue. A re-read of a repository nobody pushed to costs zero calls.
 */

/** Why the pass stopped. `null` means no model ran, which is not a shortfall. */
export type PurposeStop =
  | "completed"
  | "token_budget"
  | "group_budget"
  | "llm_error"
  | "aborted";

export type PurposeResult = {
  /**
   * Every purpose this run stands behind, by `purposeKey`.
   *
   * Fresh answers **and** carried-forward ones together, deliberately. A
   * connection written for the first time this run — the twelfth component to
   * call `formatPrice` — has nothing in its own row yet, and leaving it out
   * would show it 사용해요 beside eleven siblings reading the real sentence.
   * That inconsistency is the exact thing the grouping exists to prevent.
   */
  answers: Map<string, string>;
  /** Purposes the model answered this run. */
  answered: number;
  /** Purposes kept from an earlier run without asking. */
  carried: number;
  /**
   * Purposes nobody has answered. Not a fault and not reported as one: these
   * connections keep the relation's own verb, which the map has always shown.
   */
  notAnswered: number;
  stopped: PurposeStop | null;
  /** The failure, in Korean, when one happened. */
  error: string | null;
  spent: { calls: number; inputTokens: number; outputTokens: number };
  drops: Drops;
};

export type PurposePassInput = {
  /** Null is ordinary: no key configured. The pass then does nothing and says so. */
  llm: Llm | null;
  asks: readonly PurposeAsk[];
  /** Sentences an earlier run already wrote, by `purposeKey`. */
  known: ReadonlyMap<string, string>;
  /** What changed since the last run. Decides what is carried forward. */
  scope: ChangeScope;
  budget?: Partial<PurposeBudget>;
  signal?: AbortSignal;
};

/**
 * Ask, check, and hand back sentences. No database, no HTTP, no environment.
 *
 * Injected model, injected questions, injected budget — the same shape
 * `RunAnalysisInput` and `runSemanticPass` use, and for the same reason: a unit
 * test of this file must not drag `env.ts` in. Persistence is the caller's.
 */
export async function runPurposePass(
  input: PurposePassInput,
): Promise<PurposeResult> {
  const budget = { ...DEFAULT_PURPOSE_BUDGET, ...input.budget };

  const result: PurposeResult = {
    answers: new Map(),
    answered: 0,
    carried: 0,
    notAnswered: 0,
    stopped: "completed",
    error: null,
    spent: { calls: 0, inputTokens: 0, outputTokens: 0 },
    drops: noDrops(),
  };

  const selection = selectPurposes(input.asks, input.known, input.scope, budget);

  // Carried first, and unconditionally — before the model is even looked at.
  // A run with no key still restates every sentence it already had, so a
  // missing key costs the new connections and never the old ones.
  for (const ask of selection.carried) {
    const sentence = input.known.get(ask.key);
    if (sentence === undefined) continue;
    result.answers.set(ask.key, sentence);
    result.carried += 1;
  }

  if (!input.llm) {
    // Not a failure and not reported as one: the parser half produced a real
    // map with real verbs on every line, and a shortfall sentence over it would
    // turn a configuration we chose into a fault the user cannot fix.
    result.stopped = null;
    result.notAnswered = selection.asks.length + selection.skipped.length;
    return result;
  }

  const llm = input.llm;
  result.notAnswered = selection.skipped.length;
  if (selection.skipped.length > 0) result.stopped = "group_budget";

  /*
   * Several batches at once, folded back in the order they were built.
   *
   * Measured on `vestra-code` (D159): 45 purpose calls one after another took
   * 162 of the run's 348 seconds — the single largest phase of the whole
   * analysis. No batch depends on another, so waiting bought only an order,
   * and the fold below restores the order without the waiting.
   *
   * A truncated reply is still re-asked **narrower** rather than lost. D88 is
   * the precedent and the reason: Pass 2's first real run sent a flat
   * ceiling, one batch answered 15 tokens under it with `finishReason:
   * "length"`, and the whole batch was discarded with nothing on screen to say
   * so. `outputCeilingFor` scales with the batch here from the start; splitting
   * in half on truncation is the belt, and it loses nothing — both halves are
   * asked, inside the same unit of work, before that unit reports back.
   */
  const units = batches([...selection.asks], budget.batchSize);

  let settledSpend = 0;
  let fatalSeen = false;
  const slots = await runInOrder(
    units,
    budget.concurrency,
    async (unit) => {
      const outcome = await askUnit(llm, unit, budget, input.signal);
      settledSpend += outcome.spent.inputTokens + outcome.spent.outputTokens;
      if (outcome.fatal !== null || outcome.aborted) fatalSeen = true;
      return outcome;
    },
    // Only a way to stop spending: each of these means the fold would discard
    // the unit anyway. See `runInOrder`.
    () => !input.signal?.aborted && !fatalSeen && settledSpend < budget.maxTokens,
    budget.probeFirst,
  );

  const asksIn = (from: number) =>
    units.slice(from).reduce((total, unit) => total + unit.length, 0);

  let keptSpend = 0;
  for (let at = 0; at < units.length; at += 1) {
    const slot = slots[at];
    if (slot.ran) addSpend(result.spent, slot.value.spent);

    if (keptSpend >= budget.maxTokens) {
      // Out of budget, not out of questions. Everything from here keeps its
      // verb, and saying which is the whole point of the distinction.
      result.stopped = "token_budget";
      result.notAnswered += asksIn(at);
      spendTheRest(result, slots, at);
      break;
    }
    if (!slot.ran) {
      // Never launched, not for the budget (caught above) and not after a
      // failure (which ends the fold first): the run was cancelled.
      result.stopped = "aborted";
      result.notAnswered += asksIn(at);
      break;
    }

    const outcome = slot.value;
    keptSpend += outcome.spent.inputTokens + outcome.spent.outputTokens;
    addDrops(result.drops, outcome.drops);
    if (outcome.error !== null) result.error = outcome.error;
    for (const [key, sentence] of outcome.answers) result.answers.set(key, sentence);
    result.answered += outcome.answers.length;
    result.notAnswered += outcome.notAnswered;

    if (outcome.fatal !== null || outcome.aborted) {
      result.stopped = outcome.aborted ? "aborted" : stopFor(outcome.fatal);
      result.notAnswered += asksIn(at + 1);
      spendTheRest(result, slots, at);
      break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------

/** What one unit of questions produced, before anything is decided about it. */
type UnitOutcome = {
  /** In the order they were answered: the same order the old queue produced. */
  answers: [string, string][];
  notAnswered: number;
  spent: PurposeResult["spent"];
  drops: Drops;
  error: string | null;
  /** A failure retrying cannot help. Ends the fold where it lands. */
  fatal: unknown;
  /** The run was cancelled partway through this unit. */
  aborted: boolean;
};

/**
 * Ask one batch, splitting it on truncation, and hand back what came of it.
 *
 * The split halves stay inside the unit and are asked one after the other, in
 * the order the old work queue asked them — depth first, left half first — so
 * a unit's answers are exactly the answers that queue produced for the same
 * batch. It writes nothing shared.
 */
async function askUnit(
  llm: Llm,
  unit: readonly PurposeAsk[],
  budget: PurposeBudget,
  signal: AbortSignal | undefined,
): Promise<UnitOutcome> {
  const outcome: UnitOutcome = {
    answers: [],
    notAnswered: 0,
    spent: { calls: 0, inputTokens: 0, outputTokens: 0 },
    drops: noDrops(),
    error: null,
    fatal: null,
    aborted: false,
  };
  const queue: PurposeAsk[][] = [[...unit]];
  const left = () => queue.reduce((total, group) => total + group.length, 0);

  while (queue.length > 0) {
    const group = queue.shift();
    if (!group || group.length === 0) continue;

    if (signal?.aborted) {
      outcome.aborted = true;
      outcome.notAnswered += group.length + left();
      return outcome;
    }

    const prompt = buildPurposePrompt(group);

    let reply;
    try {
      reply = await llm.complete({
        messages: [
          { role: "system", content: PURPOSE_SYSTEM_PROMPT },
          { role: "user", content: prompt.text },
        ],
        maxOutputTokens: outputCeilingFor(group, budget),
        temperature: 0,
        jsonSchema: { name: "vestra_purpose", schema: PURPOSE_JSON_SCHEMA },
        effort: "fast",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      /*
       * One batch's failure is not the run's failure — unless retrying cannot
       * help. A wrong key will still be wrong on the thirtieth batch, and
       * thirty requests spent discovering that is the user's time.
       */
      outcome.error = describeFailure(error);
      if (fatal(error)) {
        outcome.fatal = error;
        outcome.notAnswered += group.length + left();
        return outcome;
      }
      outcome.notAnswered += group.length;
      continue;
    }

    outcome.spent.calls += 1;
    outcome.spent.inputTokens += reply.usage.inputTokens;
    outcome.spent.outputTokens += reply.usage.outputTokens;

    if (reply.finishReason === "length") {
      // Counted, always. A batch silently discarded is the exact failure this
      // split exists for, and it has to show up as a number in the run log
      // rather than as a map that quietly has fewer sentences on it.
      outcome.drops.truncated += 1;
      if (group.length > 1) {
        const half = Math.ceil(group.length / 2);
        queue.unshift(group.slice(0, half), group.slice(half));
      } else {
        outcome.notAnswered += 1;
      }
      continue;
    }

    const answered = parsePurposeReply(reply.text, prompt.allowed, outcome.drops);
    const byIndex = new Map(group.map((ask) => [ask.index, ask]));

    for (const item of answered.items) {
      const ask = byIndex.get(item.index);
      if (!ask) continue;
      outcome.answers.push([ask.key, item.sentence]);
    }
    // Whatever the model did not answer for, or whatever the parser refused,
    // keeps its verb. Counted so a prompt that has started producing rubbish
    // shows up as a number rather than as a quietly emptier map.
    outcome.notAnswered += group.length - answered.items.length;
  }

  return outcome;
}

function addSpend(into: PurposeResult["spent"], from: PurposeResult["spent"]): void {
  into.calls += from.calls;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
}

/** Units after a stop still cost what they cost, though none is kept. */
function spendTheRest(
  result: PurposeResult,
  slots: readonly { ran: boolean; value?: UnitOutcome }[],
  at: number,
): void {
  for (const later of slots.slice(at + 1)) {
    if (later.ran && later.value) addSpend(result.spent, later.value.spent);
  }
}

function addDrops(into: Drops, from: Drops): void {
  for (const key of Object.keys(from) as (keyof Drops)[]) into[key] += from[key];
}

function fatal(error: unknown): boolean {
  return !(error instanceof LlmError) || !error.retryable;
}

function stopFor(error: unknown): PurposeStop {
  return error instanceof LlmError && error.kind === "aborted" ? "aborted" : "llm_error";
}

function describeFailure(error: unknown): string {
  if (error instanceof LlmError) {
    if (error.kind === "auth") return "모델 열쇠가 맞지 않아서 연결 설명을 다 붙이지 못했어요.";
    if (error.kind === "rate_limit") return "모델이 잠시 바빠서 연결 설명을 다 붙이지 못했어요.";
    if (error.kind === "aborted") return "분석이 중간에 멈춰서 연결 설명을 다 붙이지 못했어요.";
  }
  return "연결 설명을 붙이다가 문제가 생겨서 일부는 그대로 두었어요.";
}
