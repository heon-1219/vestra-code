import type { ChangeScope } from "../incremental";
import { noDrops, type Drops } from "../semantic/parse";
// `@/lib/llm/types` and never the package index. The index re-exports
// `llmFromEnv`, which reaches `env.ts` — and `env.ts` validates 21 variables at
// import time and throws when one is missing. `LlmError` is a class, so it is a
// runtime import; taken from the index it would make this module, and every
// test of it, unimportable on a machine with no API key.
import { LlmError, type Llm } from "@/lib/llm/types";

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
   * A work queue rather than a for-loop, because a truncated reply is re-asked
   * **narrower** rather than lost.
   *
   * D88 is the precedent and the reason: Pass 2's first real run sent a flat
   * ceiling, one batch answered 15 tokens under it with `finishReason:
   * "length"`, and the whole batch was discarded with nothing on screen to say
   * so. `outputCeilingFor` scales with the batch here from the start; splitting
   * in half on truncation is the belt, and it loses nothing — both halves go
   * back on the queue.
   */
  const queue = batches([...selection.asks], budget.batchSize);

  while (queue.length > 0) {
    const group = queue.shift();
    if (!group || group.length === 0) continue;

    if (input.signal?.aborted) {
      result.stopped = "aborted";
      result.notAnswered += countLeft(group, queue);
      break;
    }
    if (spent(result) >= budget.maxTokens) {
      // Out of budget, not out of questions. Everything from here keeps its
      // verb, and saying which is the whole point of the distinction.
      result.stopped = "token_budget";
      result.notAnswered += countLeft(group, queue);
      break;
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
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      /*
       * One batch's failure is not the run's failure — unless retrying cannot
       * help. A wrong key will still be wrong on the thirtieth batch, and
       * thirty requests spent discovering that is the user's time.
       */
      result.error = describeFailure(error);
      if (fatal(error)) {
        result.stopped = stopFor(error);
        result.notAnswered += countLeft(group, queue);
        break;
      }
      result.notAnswered += group.length;
      continue;
    }

    result.spent.calls += 1;
    result.spent.inputTokens += reply.usage.inputTokens;
    result.spent.outputTokens += reply.usage.outputTokens;

    if (reply.finishReason === "length") {
      // Counted, always. A batch silently discarded is the exact failure this
      // split exists for, and it has to show up as a number in the run log
      // rather than as a map that quietly has fewer sentences on it.
      result.drops.truncated += 1;
      if (group.length > 1) {
        const half = Math.ceil(group.length / 2);
        queue.unshift(group.slice(0, half), group.slice(half));
      } else {
        result.notAnswered += 1;
      }
      continue;
    }

    const answered = parsePurposeReply(reply.text, prompt.allowed, result.drops);
    const byIndex = new Map(group.map((ask) => [ask.index, ask]));

    for (const item of answered.items) {
      const ask = byIndex.get(item.index);
      if (!ask) continue;
      result.answers.set(ask.key, item.sentence);
      result.answered += 1;
    }
    // Whatever the model did not answer for, or whatever the parser refused,
    // keeps its verb. Counted so a prompt that has started producing rubbish
    // shows up as a number rather than as a quietly emptier map.
    result.notAnswered += group.length - answered.items.length;
  }

  return result;
}

// ---------------------------------------------------------------------------

function countLeft(current: readonly PurposeAsk[], queue: readonly PurposeAsk[][]): number {
  return current.length + queue.reduce((total, group) => total + group.length, 0);
}

function spent(result: PurposeResult): number {
  return result.spent.inputTokens + result.spent.outputTokens;
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
