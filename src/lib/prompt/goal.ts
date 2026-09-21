// The leaf, not the package index: `@/lib/llm` re-exports `llmFromEnv`, which
// reaches `env.ts`, which validates 21 variables at import time and throws. This
// module is what a unit test loads. `loop.ts` draws the same line for the same
// reason.
import type { Llm } from "@/lib/llm/types";
import { FORBIDDEN_WORDS } from "@/qa/answer";

/**
 * The one sentence of a prompt that a model writes.
 *
 * §6.4 is exact about the division of labour: "Build the prompt from the graph
 * with code, using a template. The LLM's only job is to restate the user's goal
 * clearly." So this is one call, no tools, a few hundred tokens — and a model
 * that fails, times out, is not connected or writes something unusable costs
 * the person nothing but the restatement: the prompt is still built, with their
 * own words as its goal, and the card says which of the two happened.
 *
 * What the model is given is the person's sentence and the names of what they
 * selected, because "이거 파란색으로" means nothing to an agent and "결제 버튼을
 * 파란색으로" does. It is given nothing else, deliberately: a model shown the
 * neighbourhood starts deciding what else should change, and scope is decided
 * by the person's switches, never by a paraphrase.
 */

/** What the selection is called, for the model to put in place of 이거 / 여기. */
export type GoalPlace = {
  name: string;
  label: string | null;
  path: string | null;
};

export type GoalOutcome =
  | { ok: true; goal: string }
  | { ok: false; reason: GoalRefusal };

/**
 * Why there is no restatement. Each one has a sentence the card shows, so the
 * person always knows whether the goal they are reading is theirs or a model's.
 */
export type GoalRefusal =
  /** No model is connected here. The ordinary case on an unkeyed machine. */
  | "no_model"
  /** The model or its endpoint failed, or took too long. */
  | "failed"
  /** It answered, and what it wrote could not be used. */
  | "unusable";

/** What the card says for each, in the voice the rest of the panel speaks in. */
export const GOAL_NOTES: Record<GoalRefusal, string> = {
  no_model: "아직 모델이 연결되지 않아서, 적어 주신 말을 그대로 목표로 적었어요.",
  failed: "목표를 다시 정리하지 못해서, 적어 주신 말을 그대로 목표로 적었어요.",
  unusable: "모델이 다시 적은 말을 쓸 수 없어서, 적어 주신 말을 그대로 목표로 적었어요.",
};

/** Long enough for two sentences and a file name; short enough to be a goal. */
export const GOAL_MAX_CHARS = 300;

/**
 * Generous for one sentence, and it has to be: `mimo-v2.5` counts reasoning
 * tokens against `max_tokens` (D46), so a ceiling sized for the visible answer
 * alone truncates a thinking model before it has said anything.
 */
const GOAL_OUTPUT_TOKENS = 800;

/** A restatement that takes longer than this is not worth the wait. */
export const GOAL_TIMEOUT_MS = 20_000;

export function goalMessages(request: string, places: readonly GoalPlace[]) {
  const where = places
    .map((place) => {
      const parts = [place.name];
      if (place.label && place.label !== place.name) parts.push(`쉬운 이름: ${place.label}`);
      if (place.path && place.path !== place.name) parts.push(place.path);
      return `- ${parts.join(" · ")}`;
    })
    .join("\n");

  const system = [
    "코드를 읽지 못하는 사람이 코딩 도우미에게 맡길 일을 짧게 적었어요.",
    "이 말을 코딩 도우미가 정확히 알아들을 수 있게, 한두 문장으로 또렷하게 다시 적어 주세요.",
    "",
    "규칙이에요.",
    "1. 사용자가 말하지 않은 일은 더하지 마세요. 범위를 넓히지도 좁히지도 마세요.",
    "2. '이거', '여기', '그거' 같은 말은 아래 고른 곳의 이름으로 바꿔 적어요.",
    "3. 한국어로 쓰고, '…해 주세요'로 끝내요.",
    "4. 인사나 설명, 따옴표 없이 다시 적은 문장만 답해요.",
    "",
    "사용자가 지도에서 고른 곳:",
    where || "- (고른 곳 없음)",
  ].join("\n");

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: request },
  ];
}

/**
 * Whether the model's reply can stand as a goal, and the reply cleaned up.
 *
 * Refused rather than repaired, every time: a restatement is a convenience,
 * the person's own words are always there to fall back on, and a goal with a
 * forbidden word or a second paragraph in it is a goal we would be putting in
 * the model's mouth and the person's name.
 */
export function readGoal(text: string | null): string | null {
  if (text === null) return null;
  let goal = text.trim();
  // A model asked for no quotation marks still wraps its answer in them.
  goal = goal.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "").trim();
  if (goal.length < 4 || goal.length > GOAL_MAX_CHARS) return null;
  // Two sentences, not an essay: a restatement that grew paragraphs is doing
  // something other than restating.
  if (goal.split("\n").filter((line) => line.trim().length > 0).length > 2) return null;
  if (FORBIDDEN_WORDS.some((word) => goal.includes(word))) return null;
  return goal.replace(/\s*\n\s*/g, " ");
}

export async function restateGoal(input: {
  llm: Llm | null;
  request: string;
  places: readonly GoalPlace[];
  signal?: AbortSignal;
}): Promise<GoalOutcome> {
  if (!input.llm) return { ok: false, reason: "no_model" };

  const timeout = AbortSignal.timeout(GOAL_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

  try {
    const reply = await input.llm.complete({
      messages: goalMessages(input.request, input.places),
      maxOutputTokens: GOAL_OUTPUT_TOKENS,
      temperature: 0.1,
      // Restating one sentence is not a thinking problem, and on MiMo "fast" is
      // the difference between thinking on and off.
      effort: "fast",
      signal,
    });
    // Cut off mid-sentence is not a sentence.
    if (reply.finishReason === "length") return { ok: false, reason: "unusable" };
    const goal = readGoal(reply.text);
    return goal ? { ok: true, goal } : { ok: false, reason: "unusable" };
  } catch {
    // Every way this can fail — a refused key, a timeout, a dropped connection,
    // a throw from an injected client — ends the same way, because the only
    // thing a caller does with it is fall back to the person's own words.
    return { ok: false, reason: "failed" };
  }
}
