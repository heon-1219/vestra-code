// The type only, and the distinction is load-bearing twice over: `config.ts`
// imports `env.ts`, which validates all eleven variables the moment it is
// imported and throws when any is missing. A runtime import here would drag
// that into the browser bundle, where `process.env` is not what it is on the
// server — and into every test of this file, which would then fail to load on
// a machine with no key. `import type` is erased before either happens.
import type { ProviderId } from "@/lib/llm/config";
import type { LlmConfig } from "@/lib/llm/types";

/**
 * Which model answers, and how hard it thinks — as choices the user makes.
 *
 * The founder asked for both to live in the request box itself: "모델 및 effort
 * 고를 수 있게, 그리고 이 고르는 섹션은 채팅창 일부로 claude 가 하듯이 넣어보자."
 * So this is a sibling of `mode.ts`, not a settings screen, and the words live
 * here for the same reason they do there: the sentence the user reads and the
 * value the code branches on cannot drift apart if there is only one of them.
 *
 * ## The part that is not decoration
 *
 * Both of these controls can be asked for something this installation cannot
 * do, and in two different ways:
 *
 *   - **There may be no model at all.** No key on this machine is the normal
 *     case today. A dropdown with nothing in it, or one listing models we have
 *     no key for, would be a screen claiming a capability the product does not
 *     have — so with nothing connected there is no control, just the sentence
 *     that says so.
 *   - **A model may have no thinking control.** `LlmConfig["effort"]` is
 *     `"none"` for any endpoint we know nothing about, and the client then
 *     sends no such parameter at all. Offering 빠르게/깊게 there would be a
 *     switch wired to nothing: the request goes out identical either way and
 *     the user has no way to notice.
 *
 * One model is handled here too, and deliberately not as a choice: a control
 * with a single option asks a question that has one answer, which reads as a
 * setting the reader ought to think about. It is shown as a fact instead.
 */

/** A model this installation actually has a key for. */
export type ModelChoice = {
  id: ProviderId;
  /** What a person reads. */
  label: string;
  /**
   * What shape this endpoint's thinking control has. Carried with the choice
   * rather than looked up, because the screen has to decide whether to offer
   * 빠르게/깊게 at the moment it draws the model beside it.
   */
  effort: LlmConfig["effort"];
};

/** 빠르게 or 깊게, in the product's words rather than any provider's. */
export type PanelEffort = "fast" | "deep";

/**
 * 빠르게 opens the box. Thinking costs tokens and time, both of which the
 * person running this pays for, so the more expensive setting is the one they
 * ask for rather than the one they have to notice and turn off.
 */
export const DEFAULT_PANEL_EFFORT: PanelEffort = "fast";

/** Both settings, in the order the control lists them. */
export const PANEL_EFFORTS: readonly PanelEffort[] = ["fast", "deep"];

/**
 * Two words and no third.
 *
 * A middle setting would be a level MiMo cannot honour — it documents
 * `thinking: { type: "enabled" | "disabled" }` and nothing finer — and a
 * control whose middle option quietly does nothing on half the providers is
 * worse than no control.
 */
export const EFFORT_WORDS: Record<PanelEffort, string> = {
  fast: "빠르게",
  deep: "깊게",
};

/** What the request box carries besides the text. */
export type PanelRequest = {
  /**
   * Null when nothing is connected. Never a name the screen did not show: a
   * request answered by a different model than the one on screen is a lie the
   * user has no way to notice.
   */
  model: ProviderId | null;
  effort: PanelEffort;
};

/** Said where a model would be named, because there is no model to name. */
export const NO_MODEL_WORDS = "아직 모델이 연결되지 않았어요.";

/**
 * Said where 빠르게/깊게 would be, when the chosen model has no such control.
 *
 * It names what is missing rather than hiding the row, because someone who saw
 * the choice beside another model would otherwise think it had moved.
 */
export const NO_EFFORT_WORDS = "이 모델은 빠르게와 깊게를 따로 고를 수 없어요.";

/**
 * The model in use, given what is connected and what was last picked.
 *
 * Falls through to the first when the picked one is not on the list — the same
 * rule `defaultProvider` follows in `config.ts`, and for the same reason: a key
 * can be removed while a choice made before that is still held on screen, and
 * pointing at a model that is not there would fail at the moment of asking
 * rather than at the moment of choosing. First is the installation's default,
 * because `availableProviders` orders it first.
 */
export function chooseModel(
  models: readonly ModelChoice[],
  picked: ProviderId | null,
): ModelChoice | null {
  if (models.length === 0) return null;
  return models.find((model) => model.id === picked) ?? models[0];
}

/**
 * Whether there is anything to choose between.
 *
 * One model is not a choice. Two is, and the difference matters enough to have
 * a name: it is the line between a control and a fact.
 */
export function hasModelChoice(models: readonly ModelChoice[]): boolean {
  return models.length > 1;
}

/**
 * Whether asking this model to think harder would change anything.
 *
 * False means the client sends no thinking parameter at all for this endpoint,
 * so the two settings would produce byte-identical requests.
 */
export function effortHonoured(model: ModelChoice | null): boolean {
  return model !== null && model.effort !== "none";
}
