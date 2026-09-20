import { z } from "zod";

/**
 * Every environment variable the server reads, validated once at startup.
 *
 * Section 8 of the brief requires validating external input with a schema, and
 * environment is the first external input the app touches. Failing here with a
 * named variable beats failing three layers down with "undefined is not a string".
 *
 * Variables for steps that have not shipped yet are optional, and become
 * required in the step that introduces them.
 */

/**
 * `.env.example` declares unset variables as `KEY=""`, so an unconfigured
 * optional variable arrives as an empty string, not as undefined — and `""`
 * fails `.url()` while `.optional()` never gets a chance to help. Treat blank
 * as absent, which is what someone editing the file means by it.
 */
function blankAsUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalString = z.preprocess(blankAsUndefined, z.string().optional());
const optionalUrl = z.preprocess(
  blankAsUndefined,
  z.string().url("must be a full URL including the scheme").optional(),
);
const serverSchema = z.object({
  // Step 1
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is missing. Copy .env.example to .env.local and paste the Neon connection string."),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 32"),
  BETTER_AUTH_URL: z
    .string()
    .url("BETTER_AUTH_URL must be a full origin, e.g. http://localhost:3000"),
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is missing."),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is missing."),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is missing."),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is missing."),

  /*
   * Step 4. Two providers by name, plus one unnamed escape hatch.
   *
   * Only the KEY is required per provider: the base URL and the model have
   * verified defaults in `llm/config.ts`, because an address nobody can look up
   * is not a secret, it is a thing to get wrong. Both stay overridable here, so
   * moving off `gemini-3.8-flash` is still a config change and not a deploy.
   *
   * `LLM_DEFAULT` picks between them ("mimo" | "gemini" | "custom"). The
   * unprefixed trio is the `custom` provider, which is what keeps "any
   * OpenAI-compatible endpoint" true and keeps those variables meaningful
   * rather than silently ignored.
   */
  LLM_DEFAULT: optionalString,

  LLM_MIMO_API_KEY: optionalString,
  LLM_MIMO_BASE_URL: optionalUrl,
  LLM_MIMO_MODEL: optionalString,
  LLM_MIMO_SUPPORTS_JSON_SCHEMA: optionalString,

  LLM_GEMINI_API_KEY: optionalString,
  LLM_GEMINI_BASE_URL: optionalUrl,
  LLM_GEMINI_MODEL: optionalString,
  LLM_GEMINI_SUPPORTS_JSON_SCHEMA: optionalString,

  LLM_BASE_URL: optionalUrl,
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,
  /*
   * Whether this endpoint advertises `json_schema` structured outputs (D47).
   *
   * Per provider, not global, because it genuinely differs: Google documents
   * `response_format` with a schema on its OpenAI-compatible endpoint and
   * Xiaomi documents only a `text` response format. One flag would have been
   * right for one of them and silently wrong for the other.
   *
   * A string rather than a boolean: an environment has only strings, and a
   * coercing parser reads "false" as true.
   */
  LLM_SUPPORTS_JSON_SCHEMA: optionalString,

  // Step 6 stretch.
  E2B_API_KEY: optionalString,
});

export type ServerEnv = z.infer<typeof serverSchema>;

function loadEnv(): ServerEnv {
  const parsed = serverSchema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Environment is not configured.\n${problems}\n\nSee .env.example for the full list.`,
    );
  }

  return parsed.data;
}

export const env = loadEnv();

/*
 * `hasLlmConfigured()` used to live here and checked the unprefixed trio only,
 * so an installation with a Gemini or MiMo key read as having no model at all.
 * It had no callers, which is the only reason it never lied to anyone. The
 * question it answered now belongs to `llm/config.ts`, which knows about all
 * three providers: use `llmConfigured()` from `@/lib/llm`.
 */
