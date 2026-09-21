// `./types` rather than the package index, and the distinction is load-bearing:
// `@/lib/llm` re-exports `llmFromEnv`, which pulls in `config.ts` and through it
// `env.ts` — and `env.ts` validates all eleven variables the moment it is
// imported and throws when any is missing. `LlmError` is a class, so importing
// it is a runtime import; taken from the index it would make this module, and
// every test of it, unimportable on a machine with no API key.
import {
  LlmError,
  type Llm,
  type LlmMessage,
  type LlmReply,
  type LlmToolCall,
} from "@/lib/llm/types";
// The leaf, for the same reason. `@/lib/context` reaches the database; the
// digest's own module imports nothing.
import type { ProjectDigest } from "@/lib/context/digest";

import {
  checkFindings,
  forbiddenWordsIn,
  GROUNDED_FALLBACK_SUMMARY,
  reportIssues,
  reportSchema,
  UNGROUNDED_SUMMARY,
} from "./answer";
import { EXPLAIN_STOP_WORDS } from "./explain";
import {
  buildSystemPrompt,
  NUDGE,
  stepsLeftNote,
  type InvestigationFocus,
} from "./prompt";
import type { SourceReader } from "./source";
import { buildTrail, EMPTY_TRAIL, type TrailStep } from "./trail";
import {
  commonOf,
  createToolContext,
  isQaToolName,
  runTool,
  toArgumentObject,
  toolNamesFor,
  toolSpecsFor,
  type LedgerEntry,
  type QaGraph,
} from "./tools";
import {
  DEFAULT_BUDGET,
  type Budget,
  type Finding,
  type Investigation,
  type QaEvent,
  type QaEventPayloads,
  type QaEventSink,
  type QaEventType,
  type QaToolName,
  type RefusalReason,
  type RefusedFinding,
  type StopReason,
} from "./types";

/**
 * The loop: a hypothesis, a look, and either a conclusion or a narrower
 * hypothesis — until one of four budgets runs out.
 *
 * The product this is for fixed six real defects in one session, and every one
 * of them passed the type checker, the linter and five hundred tests. They were
 * in the rendered result, not in the code's structure, which is exactly the
 * class of thing a single-shot answer over a graph cannot see. What finds them
 * is the ability to say "I think it is this file — let me look — no, it is the
 * wrapper above it", and that sentence is a loop.
 *
 * Four things here are deliberate and would each be easy to get wrong:
 *
 *   1. **Every exit is an answer.** Out of steps, out of tokens, out of time,
 *      cut off mid-reply, the model never filed anything — each has its own
 *      stop reason and its own Korean sentence. None of them silently becomes a
 *      conclusion, and none of them throws away what the loop had learned.
 *   2. **The budget is told to the model.** Every tool result ends with how
 *      many steps are left. A model that does not know it is on its last one
 *      spends it opening a fifth file, and we get nothing instead of a partial
 *      answer.
 *   3. **A truncated reply is not a reply.** `finishReason: "length"` means the
 *      completion ceiling cut the answer off. A conclusion whose evidence ends
 *      mid-sentence is not a conclusion, and reporting it as one is the exact
 *      dishonesty this module exists to prevent.
 *   4. **Nothing is retried in secret.** The client deliberately does not
 *      retry, because a hidden retry spends the caller's time and tokens
 *      without the caller knowing. One retry happens here, for a failure the
 *      client says is retryable, and it is charged as a step so the budget the
 *      user can see is the budget being spent.
 */

/** Prose instead of a tool call. Once is a mistake; twice is a conversation. */
const MAX_NUDGES = 1;

/**
 * How many times a bad `report` may be handed back — so, two attempts at most.
 *
 * Shared between "the shape was wrong" and "nothing you cited was read",
 * because both are the same event from the model's side: it tried to finish and
 * was told it could not. Once, then we file what we have. The usual cause is
 * citing the file it opened rather than the lines it read, which is a one-turn
 * fix; a model that gets it wrong twice is not going to get it right on the
 * third try, and the budget being spent is the user's.
 */
const MAX_REPORT_RETRIES = 1;

/**
 * One retryable endpoint failure is worth trying again, with no wait.
 *
 * A 503 usually succeeds immediately; a 429 usually does not, and we spend one
 * step finding out. That is the honest trade: the alternative is either
 * abandoning an investigation over one blip, or sleeping inside a request the
 * user is watching.
 */
const MAX_LLM_RETRIES = 1;

/**
 * How many recent tool results keep their full text.
 *
 * History is re-sent on every turn, so a twenty-step investigation that kept
 * everything would pay for its third tool result eighteen times. Older ones
 * collapse to the one-line note they already produced for the trace — the
 * model keeps the thread of what it did and stops paying for the detail. Six
 * is enough that a file read at step 4 is still on screen at step 9, which is
 * where the "actually, it is the wrapper above it" moment tends to happen.
 *
 * This is also what makes the input cost linear rather than triangular, and
 * therefore what makes twenty steps affordable at all: measured at 4–6k
 * tokens per step, flat, from step seven onwards.
 */
const HISTORY_FULL_STEPS = 6;

/**
 * The ceiling for one reply.
 *
 * `mimo-v2.5` allows 32,768 and charges reasoning tokens against it (D46). Well
 * under that, because the failure mode we care about is one runaway turn eating
 * the whole investigation's output budget — and a step that needs three
 * thousand tokens to ask for sixty lines of a file has gone wrong anyway.
 */
const PER_CALL_OUTPUT_TOKENS = 3_000;

/**
 * Low, not zero.
 *
 * The same symptom should produce the same investigation twice, which is what
 * makes a change in the answer mean something changed in the code. Not pinned
 * to zero: a greedy decode on a reasoning model repeats itself, and a loop that
 * reads the same window three times has spent a quarter of its steps agreeing
 * with itself.
 */
const TEMPERATURE = 0.1;

/** Trace payloads go to a database on the way to a browser. Keep them short. */
const NOTE_CHARS = 160;

export type InvestigateInput = {
  /** The symptom, in the user's own words. */
  question: string;
  graph: QaGraph;
  /** Injected. Nothing in this module knows which provider is behind it. */
  llm: Llm;
  /**
   * Null for a project whose files cannot be reached. The loop then runs
   * without `read_source` and can only produce `inferred` findings, which is
   * the honest ceiling rather than a failure.
   */
  source?: SourceReader | null;
  /**
   * What the project's own README says it is for, or null.
   *
   * Orientation only. It goes into the system prompt fenced and labelled as the
   * author's own description, it never enters the ledger, and a claim resting
   * on it alone is refused in `answer.ts` like any other unread citation. Null
   * is the ordinary case and the loop behaves exactly as it did before this
   * existed — a smaller honest input, not an invented one.
   */
  digest?: ProjectDigest | null;
  /**
   * The place this investigation is about, when it is 설명하기's deep read
   * rather than a question. Changes the brief and the stop sentences; changes
   * nothing about the tools, the budget checks or the ledger (D156).
   */
  focus?: InvestigationFocus | null;
  budget?: Partial<Budget>;
  /**
   * How hard the model should think, passed through to every turn.
   *
   * The client translates it per provider — Gemini takes a graded
   * `reasoning_effort`, MiMo has only on and off — and drops it for an endpoint
   * with no such control. The loop neither knows nor cares which it got.
   */
  effort?: "fast" | "deep";
  /** Injected so the wall-clock ceiling can be tested without waiting for it. */
  now?: () => number;
  signal?: AbortSignal;
  /** Live listener. The trace comes back in full either way. */
  onEvent?: QaEventSink;
};

/** One model turn and what followed it, kept so history can be rebuilt. */
type Turn = {
  assistant: LlmMessage;
  follow: LlmMessage;
  /** The one-line summary a tool result collapses to. Null never collapses. */
  note: string | null;
};

export async function investigate(
  input: InvestigateInput,
): Promise<Investigation> {
  const budget: Budget = { ...DEFAULT_BUDGET, ...input.budget };
  const now = input.now ?? Date.now;
  const startedAt = now();
  const source = input.source ?? null;

  const context = createToolContext(input.graph, source, input.signal);
  const tools = toolSpecsFor(source !== null);
  const system = buildSystemPrompt({
    items: input.graph.items,
    hasSource: source !== null,
    digest: input.digest ?? null,
    focus: input.focus ?? null,
  });
  const explaining = Boolean(input.focus && input.focus.items.length > 0);

  const trace: QaEvent[] = [];
  let seq = 0;
  function emit<T extends QaEventType>(
    type: T,
    payload: QaEventPayloads[T],
  ): void {
    seq += 1;
    const event: QaEvent<T> = { seq, type, payload };
    trace.push(event);
    input.onEvent?.(type, payload);
  }

  const turns: Turn[] = [];
  const ledger: LedgerEntry[] = [];
  const checked: string[] = [];
  /**
   * What each step put the loop in front of, in order.
   *
   * Gathered as it happens and folded into a trail at the end, because
   * `critical` is not knowable until the findings have survived checking —
   * marking points live would mean marking them on hope.
   */
  const walked: TrailStep[] = [];

  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let nudges = 0;
  let reportFailures = 0;
  let retries = 0;
  /** The step whose conclusion the next `learned` will be about. */
  let pending: number | null = null;

  let findings: Finding[] = [];
  let refused: RefusedFinding[] = [];
  let summary: string | null = null;
  let unresolved: string | null = null;
  let failure: Investigation["failure"] = null;

  emit("qa.started", {
    question: short(input.question),
    maxSteps: budget.maxSteps,
    itemCount: input.graph.items.length,
  });

  function messages(): LlmMessage[] {
    const out: LlmMessage[] = [
      { role: "system", content: system },
      { role: "user", content: input.question },
    ];
    turns.forEach((turn, index) => {
      // The assistant turn goes back verbatim, tool calls and all: an
      // OpenAI-compatible endpoint rejects a `tool` result whose call it never
      // saw, and a loop that kept only the results would fail on its second
      // iteration with an error about an unknown tool call id.
      out.push(turn.assistant);
      const collapse =
        turn.note !== null && turns.length - index > HISTORY_FULL_STEPS;
      out.push(
        collapse
          ? {
              role: "tool",
              content: `${turn.note} (자세한 내용은 줄였어요)`,
              toolCallId: turn.follow.toolCallId,
            }
          : turn.follow,
      );
    });
    return out;
  }

  function finish(stop: StopReason): Investigation {
    const millis = now() - startedAt;
    // Built on every exit, not only on `answered`. An investigation that ran
    // out of steps still went somewhere, and showing where is most of what
    // makes running out a reportable outcome rather than a failure.
    const trail =
      walked.length === 0
        ? EMPTY_TRAIL
        : buildTrail({
            graph: input.graph,
            catalog: context.catalog,
            steps: walked,
            findings,
          });
    emit("qa.trail", trail);
    emit("qa.stopped", {
      reason: stop,
      steps,
      inputTokens,
      outputTokens,
      millis,
      findings: findings.length,
      refused: refused.length,
    });
    return {
      question: input.question,
      stop,
      summary: summary ?? sentenceFor(stop, steps, explaining),
      findings,
      refused,
      ruledOut: presentable(checked),
      unresolved,
      failure,
      read: readTally(ledger),
      trail,
      trace,
      spent: { steps, inputTokens, outputTokens, millis },
      budget,
    };
  }

  for (;;) {
    if (input.signal?.aborted) return finish("stopped");
    if (now() - startedAt >= budget.maxMillis) return finish("time_spent");
    if (steps >= budget.maxSteps) return finish("steps_spent");
    if (
      inputTokens >= budget.maxInputTokens ||
      outputTokens >= budget.maxOutputTokens
    ) {
      return finish("tokens_spent");
    }

    steps += 1;

    let reply: LlmReply;
    try {
      reply = await input.llm.complete({
        messages: messages(),
        tools,
        // Never more than the whole investigation has left, so the last turn
        // cannot overspend a ceiling the loop is about to check anyway.
        maxOutputTokens: Math.max(
          256,
          Math.min(PER_CALL_OUTPUT_TOKENS, budget.maxOutputTokens - outputTokens),
        ),
        effort: input.effort,
        temperature: TEMPERATURE,
        // No `jsonSchema`: the report arrives as a tool call, and D44 records
        // that tool support and structured-output support vary independently by
        // serving provider. Asking one endpoint for both is asking for the one
        // thing it may not do. Zod validates the arguments regardless, which is
        // what D47 requires of us either way.
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof LlmError) {
        if (error.kind === "aborted") return finish("stopped");
        if (error.retryable && retries < MAX_LLM_RETRIES) {
          retries += 1;
          continue;
        }
        failure = { kind: error.kind, retryable: error.retryable };
        return finish("llm_failed");
      }
      if (input.signal?.aborted) return finish("stopped");
      // An unexpected throw from an injected client is not something we can
      // classify. "Try again" is the honest guess and the least harmful one.
      failure = { kind: "unavailable", retryable: true };
      return finish("llm_failed");
    }

    inputTokens += reply.usage.inputTokens;
    outputTokens += reply.usage.outputTokens;

    if (reply.finishReason === "length") return finish("truncated");

    const call = reply.toolCalls[0];
    if (!call) {
      if (nudges >= MAX_NUDGES) return finish("no_answer");
      nudges += 1;
      turns.push({
        assistant: { role: "assistant", content: reply.text ?? "" },
        follow: { role: "user", content: NUDGE },
        note: null,
      });
      continue;
    }

    const args = toArgumentObject(call.arguments);
    const { why, learned } = commonOf(args);

    // The conclusion of the previous step, written one turn late. See the
    // `learned` note in `tools.ts`: it costs nothing and saves a round trip.
    //
    // Kept even when there is no step to attach it to — after a rejected report
    // there is nothing pending, and the sentence is still an account of where
    // the model has been, which is what makes "I ran out of steps" a real
    // answer. Only the trace event needs a step number.
    if (learned !== null) {
      if (pending !== null) {
        emit("step.concluded", { step: pending, conclusion: short(learned) });
      }
      checked.push(learned);
    }
    pending = null;

    if (!isQaToolName(call.name)) {
      // Named from the specs the model was actually given, so the sentence
      // cannot drift from the list as tools are added or withheld.
      const text = `${call.name}이라는 도구는 없어요. ${toolNamesFor(source !== null).join(", ")} 중에서 골라 주세요.`;
      emit("step.taken", {
        step: steps,
        tool: "unknown",
        hypothesis: short(why),
        note: short(text),
        items: [],
      });
      turns.push(turnFor(call, text, null, budget.maxSteps - steps));
      continue;
    }

    const name: QaToolName = call.name;

    if (name === "report") {
      const parsed = reportSchema.safeParse(args ?? {});
      if (!parsed.success) {
        reportFailures += 1;
        const text = `report를 읽지 못했어요. ${reportIssues(parsed.error)}`;
        emit("step.taken", {
          step: steps,
          tool: "report",
          hypothesis: short(why),
          note: short(text),
          items: [],
        });
        if (reportFailures > MAX_REPORT_RETRIES) return finish("no_answer");
        turns.push(turnFor(call, text, null, budget.maxSteps - steps));
        continue;
      }

      const report = parsed.data;
      const checkedNow = checkFindings(report.findings, ledger);
      emit("step.taken", {
        step: steps,
        tool: "report",
        hypothesis: short(why),
        note: `${checkedNow.kept.length}가지를 확인했고 ${checkedNow.refused.length}가지는 근거가 없었어요.`,
        // Reporting is not a place. The walk is what led here.
        items: [],
      });

      /*
       * A report whose every claim failed its citation check is handed back
       * once.
       *
       * Not out of politeness: the usual cause is a model citing the file it
       * opened rather than the lines it read, which it can fix in one turn. If
       * it comes back the same way, we file the honest empty answer rather than
       * spending the rest of the budget teaching it.
       */
      if (
        checkedNow.kept.length === 0 &&
        checkedNow.refused.length > 0 &&
        reportFailures < MAX_REPORT_RETRIES
      ) {
        reportFailures += 1;
        turns.push(
          turnFor(call, rejection(checkedNow.refused), null, budget.maxSteps - steps),
        );
        continue;
      }

      findings = checkedNow.kept;
      refused = checkedNow.refused;
      for (const one of refused) {
        emit("finding.refused", { claim: short(one.claim), reason: one.reason });
      }
      for (const line of report.ruledOut ?? []) checked.push(line);
      unresolved = report.unresolved ?? null;

      // The model's own paragraph travels only when something under it
      // survived, and only when it is written in words this product uses.
      if (findings.length === 0) {
        summary = explaining ? EXPLAIN_STOP_WORDS.ungrounded : UNGROUNDED_SUMMARY;
      }
      else if (forbiddenWordsIn(report.answer).length > 0) {
        summary = GROUNDED_FALLBACK_SUMMARY;
      } else summary = report.answer;

      return finish("answered");
    }

    const outcome = await runTool(context, name, args);
    ledger.push(...outcome.ledger);
    if (outcome.items.length > 0 || outcome.hops.length > 0) {
      walked.push({ step: steps, items: outcome.items, hops: outcome.hops });
    }
    emit("step.taken", {
      step: steps,
      tool: name,
      hypothesis: short(why),
      note: short(outcome.note),
      items: outcome.items,
    });
    pending = steps;
    turns.push(turnFor(call, outcome.text, outcome.note, budget.maxSteps - steps));
  }
}

/**
 * One turn of history.
 *
 * The assistant message carries only the call we actually ran. A reply with two
 * tool calls in it gets one of them executed — the loop is one look at a time
 * on purpose — and sending both back with a result for only one is how an
 * OpenAI-compatible endpoint starts rejecting the whole conversation.
 */
function turnFor(
  call: LlmToolCall,
  text: string,
  note: string | null,
  stepsLeft: number,
): Turn {
  return {
    assistant: { role: "assistant", content: "", toolCalls: [call] },
    follow: {
      role: "tool",
      content: text + stepsLeftNote(stepsLeft),
      toolCallId: call.id,
    },
    note,
  };
}

const REJECTION_WORDS: Record<RefusalReason, string> = {
  unread_citation: "이번에 열어본 자리가 아니에요",
  certain_without_reading: "직접 읽지 않고 certain이라고 했어요",
  forbidden_words: "쓰지 않는 표현이 들어갔어요",
  hedged_certainty: "certain인데 짐작하는 말투예요",
};

function rejection(refused: readonly RefusedFinding[]): string {
  const rows = refused.map((one) => {
    const where = one.citations
      .map((c) => `${c.path} ${c.startLine}-${c.endLine}줄`)
      .join(", ");
    return `- ${where}: ${REJECTION_WORDS[one.reason]}`;
  });
  return [
    "이 항목들은 전해 드릴 수 없어요.",
    ...rows,
    "read_source로 실제로 읽은 줄 번호를 붙이거나, 짐작이면 inferred로 바꿔서 다시 report해 주세요.",
  ].join("\n");
}

/**
 * What a person reads when the loop stopped without an answer.
 *
 * Each one says what happened and stops. No "but here is my best guess" — the
 * findings and `ruledOut` beside this carry whatever was actually established,
 * and a sentence that reaches for a conclusion is how an unfinished
 * investigation gets read as a finished one.
 */
function sentenceFor(stop: StopReason, steps: number, explaining = false): string {
  /*
   * "원인을 짚지 못했어요" is the right admission for a symptom and the wrong one
   * for 설명하기, where nothing was broken and there was no cause to find — and
   * "다시 물어봐 주세요" is wrong under a card whose button says 다시 읽어 보기.
   * The budget sentences change one clause; the rest are 설명하기's own
   * (`EXPLAIN_STOP_WORDS`).
   */
  const unfinished = explaining ? "아직 다 풀어 드리지 못했어요" : "아직 원인을 짚지 못했어요";
  if (explaining && (stop === "truncated" || stop === "no_answer" || stop === "llm_failed" || stop === "stopped")) {
    return EXPLAIN_STOP_WORDS[stop];
  }
  switch (stop) {
    case "answered":
      return GROUNDED_FALLBACK_SUMMARY;
    case "steps_spent":
      return `${steps}번까지 찾아봤는데 ${unfinished}. 어디를 봤는지는 아래에 남겨 뒀어요.`;
    case "tokens_spent":
      return `한 번에 살펴볼 수 있는 분량을 다 썼어요. ${unfinished}.`;
    case "time_spent":
      return `시간이 다 돼서 여기서 멈췄어요. ${unfinished}.`;
    case "stopped":
      return "찾아보다가 중간에 멈췄어요.";
    case "truncated":
      return "답이 중간에 잘려서 그대로 전해 드릴 수 없어요. 다시 물어봐 주세요.";
    case "no_answer":
      return "찾아보기는 했는데 정리된 답을 받지 못했어요. 다시 물어봐 주세요.";
    case "llm_failed":
      return "찾아보는 도중에 연결이 끊겼어요. 잠시 후에 다시 물어봐 주세요.";
  }
}

/**
 * The account of where we looked, with anything unrepeatable taken out.
 *
 * These are the model's own words and they are shown to a person, so the same
 * vocabulary rule applies as to a finding. Deduplicated because a model that
 * checks two files in one folder often writes the same sentence twice, and a
 * list that repeats itself reads as a longer search than it was.
 */
function presentable(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === "" || seen.has(text)) continue;
    if (forbiddenWordsIn(text).length > 0) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * How much source actually came back, from the ledger rather than from a
 * counter kept alongside it.
 *
 * Only entries marked `read` count. A search result that told us a file exists
 * at line 40 is on the ledger too, and counting it here would say we had read
 * a line we only ever pointed at — the same distinction `answer.ts` refuses to
 * blur, measured the same way.
 *
 * Distinct line numbers, because a real investigation reads one file twice: the
 * imports at the top and the thing that went wrong at line 200, often with an
 * overlap in the middle.
 */
function readTally(ledger: readonly LedgerEntry[]): {
  files: number;
  lines: number;
} {
  const seen = new Map<string, Set<number>>();
  for (const entry of ledger) {
    if (!entry.read) continue;
    let held = seen.get(entry.path);
    if (!held) {
      held = new Set<number>();
      seen.set(entry.path, held);
    }
    for (let line = entry.startLine; line <= entry.endLine; line += 1) {
      held.add(line);
    }
  }
  let lines = 0;
  for (const held of seen.values()) lines += held.size;
  return { files: seen.size, lines };
}

function short(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= NOTE_CHARS ? trimmed : `${trimmed.slice(0, NOTE_CHARS)}…`;
}
