import { env } from "@/lib/env";

import type { LlmConfig } from "./types";

/**
 * Which models this product can be pointed at, and which one it uses. D50.
 *
 * One provider was the original design and it was one too few. The founder
 * wants to choose between MiMo and Gemini, and the two differ in a way that
 * would be invisible until it broke: **Gemini's OpenAI-compatible endpoint
 * supports `response_format` with a JSON schema and MiMo's does not.** A single
 * global `LLM_SUPPORTS_JSON_SCHEMA` would therefore be right for one of them
 * and wrong for the other, and wrong here means either a 400 or — far worse —
 * a silently ignored constraint and free prose where a schema was expected.
 *
 * So capability is a property of the provider, declared beside it, verified
 * against each vendor's own documentation rather than assumed.
 *
 * **Base URL and model are defaults in code; the key is not.** That is the one
 * place this departs from "configured only by environment", and deliberately:
 * an address nobody can look up is not a secret, it is a thing to get wrong,
 * and the founder pasting two API keys is the whole setup. Both remain
 * overridable by environment, so swapping `gemini-3.8-flash` for something
 * newer is still a config change and not a deploy.
 *
 * **Never point one of these at a router (D44).** MiMo's capabilities differ by
 * serving provider rather than by model — one serves it with `tools` and no
 * `response_format`, another the reverse — and a router picks by price and
 * latency, so the same key lands somewhere different between one run and the
 * next. That is a product which works today and silently fails tomorrow.
 */

export type ProviderId = "mimo" | "gemini" | "custom";

export type ProviderInfo = {
  id: ProviderId;
  /** What a person reading a settings screen would call it. */
  label: string;
  baseUrl: string | null;
  model: string | null;
  supportsJsonSchema: boolean;
  effort: LlmConfig["effort"];
};

/**
 * What each provider is, before the environment has its say.
 *
 * `custom` exists so that "any OpenAI-compatible endpoint" stays true: it has
 * no defaults, takes the unprefixed variables, and is how anyone points this at
 * a provider we have never heard of. It is also why the original three
 * variables still mean something rather than being quietly ignored — a
 * configuration that stops working without saying so is the failure this
 * codebase spends most of its comments avoiding.
 */
const DEFAULTS: Record<ProviderId, Omit<ProviderInfo, "id">> = {
  mimo: {
    label: "MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    // `mimo-v2.5` and `mimo-v2.5-pro` are different models released the same
    // day (D45). This one is the cheap one that does tool calling; Pro is the
    // code/agent model at roughly ten times the price.
    model: "mimo-v2.5",
    // Xiaomi's own API reference documents `tools` and documents only a `text`
    // response format. Verified, not assumed.
    supportsJsonSchema: false,
    // It documents `thinking: { type: "enabled" | "disabled" }` and no finer
    // control, so there are two settings here and not three.
    effort: "binary" as const,
  },
  gemini: {
    label: "Gemini",
    // Google's OpenAI-compatibility layer. Documented with a trailing slash;
    // `readProvider` strips it, because `${base}/chat/completions` with two
    // slashes is a 404 on some gateways and, on others, a redirect that drops
    // the Authorization header — a failure that reads exactly like a bad key.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    // Google documents both tool calling and `response_format` with a schema
    // on this endpoint. This is the difference from MiMo that makes capability
    // a per-provider fact.
    supportsJsonSchema: true,
    // Documented as `reasoning_effort`, mapped to Gemini's thinking level.
    effort: "graded" as const,
  },
  custom: {
    label: "직접 설정한 모델",
    baseUrl: null,
    model: null,
    supportsJsonSchema: false,
    // We know nothing about it, so we send nothing. An unrecognised parameter
    // is a 400 on a strict server, and guessing costs the request.
    effort: "none" as const,
  },
};

export const PROVIDER_IDS: readonly ProviderId[] = ["mimo", "gemini", "custom"];

/** The environment, as a plain bag, so the resolution below can be tested. */
export type RawEnv = Partial<Record<string, string | undefined>>;

/**
 * One provider's configuration, or null when it has no key.
 *
 * A provider without a key is not a broken provider — it is one this
 * installation has not been given. Every Step 4 feature already has to say so
 * in words a person can read, and null is what makes that sentence true rather
 * than a placeholder.
 */
export function readProvider(id: ProviderId, raw: RawEnv): LlmConfig | null {
  const prefix = id === "custom" ? "LLM_" : `LLM_${id.toUpperCase()}_`;
  const defaults = DEFAULTS[id];

  const apiKey = raw[`${prefix}API_KEY`]?.trim();
  if (!apiKey) return null;

  const baseUrl = (raw[`${prefix}BASE_URL`]?.trim() || defaults.baseUrl)?.replace(/\/+$/, "");
  const model = raw[`${prefix}MODEL`]?.trim() || defaults.model;
  // A key with nowhere to send it is a misconfiguration, not a provider.
  if (!baseUrl || !model) return null;

  const declared = raw[`${prefix}SUPPORTS_JSON_SCHEMA`]?.trim();
  return {
    baseUrl,
    apiKey,
    model,
    supportsJsonSchema: declared ? declared === "true" : defaults.supportsJsonSchema,
    effort: defaults.effort,
  };
}

/** Every provider this installation actually has a key for. */
export function configuredProviders(raw: RawEnv): ProviderId[] {
  return PROVIDER_IDS.filter((id) => readProvider(id, raw) !== null);
}

/**
 * Which provider to use when nobody has said otherwise.
 *
 * `LLM_DEFAULT` names it. When that names something with no key — a typo, or a
 * key removed and the name left behind — we fall through to whatever IS
 * configured rather than reporting no model at all: the operator's stated
 * intent was to have a model, and honouring the letter of a broken setting over
 * that helps nobody. When nothing is configured, null, and the product says so.
 */
export function defaultProvider(raw: RawEnv): ProviderId | null {
  const available = configuredProviders(raw);
  if (available.length === 0) return null;

  const wanted = raw.LLM_DEFAULT?.trim() as ProviderId | undefined;
  if (wanted && available.includes(wanted)) return wanted;
  return available[0];
}

/** The label a person reads for a provider. */
export function providerLabel(id: ProviderId): string {
  return DEFAULTS[id].label;
}

/** The configuration in use, reading the real environment. */
export function llmConfig(id?: ProviderId): LlmConfig | null {
  const chosen = id ?? defaultProvider(env as RawEnv);
  return chosen ? readProvider(chosen, env as RawEnv) : null;
}
