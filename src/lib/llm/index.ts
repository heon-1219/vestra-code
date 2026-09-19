import { llmConfig } from "./config";
import { createLlm } from "./client";
import type { Llm } from "./types";

/**
 * The composition root for the model, and the only file here that reads the
 * environment.
 *
 * It is separate from `client.ts` on purpose. `env.ts` validates all eleven
 * variables the moment it is imported and throws if any is missing — right for
 * a server that must not boot half-configured, wrong for a unit test, and the
 * reason the client itself takes its configuration as an argument. Importing
 * the client is free; importing this is a statement that you are running in a
 * configured process.
 */
export function llmFromEnv(fetchImpl?: typeof globalThis.fetch): Llm | null {
  const config = llmConfig();
  return config ? createLlm(config, fetchImpl) : null;
}

/**
 * Whether Step 4's features can work at all.
 *
 * Null is not a failure: a project with no key is a product with those features
 * switched off, and each of them already has to say so in words a person can
 * read. This is what makes "아직 준비 중이에요" a true sentence rather than a
 * placeholder.
 */
export function llmConfigured(): boolean {
  return llmConfig() !== null;
}

export { createLlm } from "./client";
export * from "./types";
