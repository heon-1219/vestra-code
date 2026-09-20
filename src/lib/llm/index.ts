import { env } from "@/lib/env";

import { createLlm } from "./client";
import {
  configuredProviders,
  defaultProvider,
  llmConfig,
  providerLabel,
  type ProviderId,
} from "./config";
import type { Llm, LlmConfig } from "./types";

/**
 * The composition root for the model: where a provider's configuration becomes
 * something that can answer a question.
 *
 * It is separate from `client.ts` on purpose. `env.ts` validates all eleven
 * variables the moment it is imported and throws if any is missing — right for
 * a server that must not boot half-configured, wrong for a unit test, and the
 * reason the client itself takes its configuration as an argument. Importing
 * the client is free; importing this is a statement that you are running in a
 * configured process.
 *
 * There are three providers now rather than one (D50), so there are two
 * questions instead of one: which model, and which models are there to choose
 * between. The second one is what the request box needs, and it is the reason
 * `availableProviders` returns labels and not just ids: a picker that offers a
 * model this installation has no key for is the dishonesty everything else
 * here is built to avoid.
 */
export function llmFromEnv(fetchImpl?: typeof globalThis.fetch): Llm | null {
  const config = llmConfig();
  return config ? createLlm(config, fetchImpl) : null;
}

/**
 * The model someone asked for by name, or null when this installation has no
 * key for it.
 *
 * Null rather than a fall-back to the default, which is the opposite of what
 * `defaultProvider` does and deliberately so: falling back is right when nobody
 * chose, and wrong when somebody did — answering with a different model than
 * the one on screen is a lie the user has no way to notice.
 */
export function llmFor(
  provider: ProviderId,
  fetchImpl?: typeof globalThis.fetch,
): Llm | null {
  const config = llmConfig(provider);
  return config ? createLlm(config, fetchImpl) : null;
}

/** One model a person may be offered, with everything the offer has to be honest about. */
export type AvailableProvider = {
  id: ProviderId;
  /** What a person reads. */
  label: string;
  /**
   * Whether this endpoint has a thinking control at all, carried along so the
   * screen can withdraw the 빠르게/깊게 choice where it would be ignored on the
   * wire rather than offering a setting that does nothing.
   */
  effort: LlmConfig["effort"];
};

/**
 * Every provider this installation actually has a key for, default first.
 *
 * **Default first is not cosmetic.** Whatever is listed first is what a picker
 * starts on, and if that disagreed with `defaultProvider` then a request sent
 * without touching the control would go somewhere other than the name shown
 * beside it. Ordering here is what keeps those two the same fact.
 *
 * Empty is a normal answer, not a failure: it is an installation with no key,
 * and every Step 4 screen already has to say so in words a person can read.
 */
export function availableProviders(): AvailableProvider[] {
  const first = defaultProvider(env);
  const ids = configuredProviders(env);
  const ordered = first ? [first, ...ids.filter((id) => id !== first)] : ids;

  // `flatMap` rather than a non-null assertion: `configuredProviders` only
  // lists ids that read back, so the null branch cannot be taken today — and
  // writing that as an observation the compiler checks, rather than as a `!`
  // it has to take our word for, is what survives the next edit to config.ts.
  return ordered.flatMap((id) => {
    const config = llmConfig(id);
    return config ? [{ id, label: providerLabel(id), effort: config.effort }] : [];
  });
}

/**
 * Whether Step 4's features can work at all.
 *
 * False is not a failure: a project with no key is a product with those
 * features switched off, and each of them already has to say so in words a
 * person can read. This is what makes "아직 모델이 연결되지 않았어요" a true
 * sentence rather than a placeholder.
 */
export function llmConfigured(): boolean {
  return llmConfig() !== null;
}

export { createLlm } from "./client";
export type { ProviderId } from "./config";
export * from "./types";
