import { env } from "@/lib/env";

import type { LlmConfig } from "./types";

/**
 * The only file in the codebase that reads the model's environment. D50.
 *
 * Four variables, read here and nowhere else. Every call site imports the
 * result, and the Step 6 sandbox is handed the same values serialised into its
 * own config — so changing the model is one string in one file, not a search
 * across three call sites and a sandbox template that quietly kept the old one.
 */
/**
 * The configuration, or null when there is no model configured.
 *
 * Null rather than a throw. A project with no key is not broken — it is a
 * product with its Step 4 features switched off, and every one of those
 * features already has to say so in words a person can read. A module that
 * throws on import would take the whole app down instead.
 */
export function llmConfig(): LlmConfig | null {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = env;
  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) return null;

  return {
    // A trailing slash turns `${base}/chat/completions` into a double slash,
    // which some gateways answer with a 404 and others with a redirect that
    // drops the Authorization header — a failure that looks like a bad key.
    baseUrl: LLM_BASE_URL.replace(/\/+$/, ""),
    apiKey: LLM_API_KEY,
    model: LLM_MODEL,
    supportsJsonSchema: env.LLM_SUPPORTS_JSON_SCHEMA === "true",
  };
}
