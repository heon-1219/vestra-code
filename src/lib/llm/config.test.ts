import { describe, expect, it, vi } from "vitest";

import {
  configuredProviders,
  defaultProvider,
  providerLabel,
  PROVIDER_IDS,
  readProvider,
  type RawEnv,
} from "./config";

/**
 * Which model this installation has, decided from a bag of strings.
 *
 * **`env.ts` is mocked, and that is not tidiness.** It validates all eleven
 * variables the moment it is imported and throws when any is missing, and
 * `config.ts` imports it at the top — so without this line the file below
 * fails to LOAD on any machine without a full `.env.local`, taking the whole
 * suite's run with it rather than skipping. That happened once already. The
 * mock is never read: every function under test takes its environment as an
 * argument precisely so that it can be tested without one.
 *
 * What is pinned here is the difference between "no model" and "a model
 * configured wrongly", because the product says a different sentence for each
 * and both of them have to be true.
 */
vi.mock("@/lib/env", () => ({ env: {} }));

describe("one provider, read from the environment", () => {
  it("is null when there is no key for it", () => {
    // Not an error and not a default: a provider with no key is one this
    // installation was never given, and null is what lets the screen say so.
    expect(readProvider("mimo", {})).toBeNull();
    expect(readProvider("gemini", { LLM_MIMO_API_KEY: "k" })).toBeNull();
  });

  it("treats a blank or whitespace key as no key", () => {
    // `.env.example` declares unset variables as KEY="", so an unconfigured
    // provider arrives as an empty string rather than as undefined.
    expect(readProvider("gemini", { LLM_GEMINI_API_KEY: "" })).toBeNull();
    expect(readProvider("gemini", { LLM_GEMINI_API_KEY: "   " })).toBeNull();
  });

  it("fills in the base URL and the model a person should not have to look up", () => {
    const config = readProvider("mimo", { LLM_MIMO_API_KEY: "k" });

    expect(config).not.toBeNull();
    expect(config?.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(config?.model).toBe("mimo-v2.5");
    expect(config?.apiKey).toBe("k");
  });

  it("strips a trailing slash from the base URL", () => {
    // `${base}/chat/completions` with two slashes is a 404 on some gateways
    // and, on others, a redirect that drops the Authorization header — which
    // reads exactly like a bad key and sends the reader off to re-paste a key
    // that was fine. Google documents its own base URL with the slash on.
    const config = readProvider("gemini", {
      LLM_GEMINI_API_KEY: "k",
      LLM_GEMINI_BASE_URL: "https://example.test/v1///",
    });

    expect(config?.baseUrl).toBe("https://example.test/v1");
  });

  it("lets the environment override the defaults in code", () => {
    // The defaults exist so that pasting a key is the whole setup. They must
    // not become a floor: moving off gemini-3.8-flash stays a config change.
    const config = readProvider("gemini", {
      LLM_GEMINI_API_KEY: "k",
      LLM_GEMINI_BASE_URL: "https://proxy.example.test/v1",
      LLM_GEMINI_MODEL: "gemini-3.8-pro",
    });

    expect(config?.baseUrl).toBe("https://proxy.example.test/v1");
    expect(config?.model).toBe("gemini-3.8-pro");
  });

  it("carries each provider's own capabilities, because they differ", () => {
    // The whole reason capability is per provider: one global flag would be
    // right for one of these two and silently wrong for the other.
    const mimo = readProvider("mimo", { LLM_MIMO_API_KEY: "k" });
    const gemini = readProvider("gemini", { LLM_GEMINI_API_KEY: "k" });

    expect(mimo?.supportsJsonSchema).toBe(false);
    expect(mimo?.effort).toBe("binary");
    expect(gemini?.supportsJsonSchema).toBe(true);
    expect(gemini?.effort).toBe("graded");
  });

  it("reads the json_schema flag as a word, so \"false\" stays false", () => {
    // An environment holds only strings, and a coercing parser reads "false"
    // as true — which is the direction that hurts: claiming a structured
    // output an endpoint does not have gets a 400, or worse, free prose.
    const off = readProvider("gemini", {
      LLM_GEMINI_API_KEY: "k",
      LLM_GEMINI_SUPPORTS_JSON_SCHEMA: "false",
    });
    const on = readProvider("mimo", {
      LLM_MIMO_API_KEY: "k",
      LLM_MIMO_SUPPORTS_JSON_SCHEMA: "true",
    });

    expect(off?.supportsJsonSchema).toBe(false);
    expect(on?.supportsJsonSchema).toBe(true);
  });

  it("takes the unprefixed variables for the custom endpoint", () => {
    // The escape hatch: the original three variables still mean something
    // rather than being quietly ignored by the move to named providers.
    const config = readProvider("custom", {
      LLM_API_KEY: "k",
      LLM_BASE_URL: "https://anything.example.test/v1",
      LLM_MODEL: "some-model",
    });

    expect(config?.baseUrl).toBe("https://anything.example.test/v1");
    expect(config?.model).toBe("some-model");
    // We know nothing about this endpoint, so we send nothing it did not ask
    // for: an unrecognised parameter is a 400 on a strict server.
    expect(config?.effort).toBe("none");
    expect(config?.supportsJsonSchema).toBe(false);
  });

  it("is null for a custom endpoint with a key and nowhere to send it", () => {
    // Half-configured is worse than unconfigured: it would put a model in the
    // picker that cannot answer, and the failure would arrive as a network
    // error long after the moment someone could have fixed it.
    expect(readProvider("custom", { LLM_API_KEY: "k" })).toBeNull();
    expect(
      readProvider("custom", { LLM_API_KEY: "k", LLM_BASE_URL: "https://x.test/v1" }),
    ).toBeNull();
    expect(readProvider("custom", { LLM_API_KEY: "k", LLM_MODEL: "m" })).toBeNull();
  });
});

describe("which providers this installation has", () => {
  it("lists only the ones with a key", () => {
    const raw: RawEnv = { LLM_GEMINI_API_KEY: "k", LLM_MIMO_BASE_URL: "https://x.test/v1" };

    expect(configuredProviders(raw)).toEqual(["gemini"]);
    expect(configuredProviders({})).toEqual([]);
  });

  it("has a name for every provider it can list", () => {
    // A picker renders what this returns, so an id without a label would be an
    // empty button rather than a missing one.
    for (const id of PROVIDER_IDS) {
      expect(providerLabel(id).length).toBeGreaterThan(0);
    }
  });
});

describe("the provider used when nobody has chosen", () => {
  it("is the one LLM_DEFAULT names", () => {
    const raw: RawEnv = {
      LLM_DEFAULT: "gemini",
      LLM_MIMO_API_KEY: "k",
      LLM_GEMINI_API_KEY: "k",
    };

    expect(defaultProvider(raw)).toBe("gemini");
  });

  it("falls through to a provider that has a key when LLM_DEFAULT names one that does not", () => {
    // A typo, or a key removed and the name left behind. The operator's stated
    // intent was to have a model; honouring the letter of a broken setting
    // would report no model at all, which helps nobody and reads as a bug in
    // the product rather than a line in the settings.
    expect(defaultProvider({ LLM_DEFAULT: "gemini", LLM_MIMO_API_KEY: "k" })).toBe("mimo");
    expect(defaultProvider({ LLM_DEFAULT: "nonsense", LLM_MIMO_API_KEY: "k" })).toBe("mimo");
  });

  it("is null when nothing is configured, rather than a name that cannot answer", () => {
    expect(defaultProvider({})).toBeNull();
    expect(defaultProvider({ LLM_DEFAULT: "gemini" })).toBeNull();
  });
});
