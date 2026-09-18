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

  // Step 4. The LLM provider is configured only by these three, never in code,
  // so the model can be swapped without a deploy that touches source.
  LLM_BASE_URL: optionalUrl,
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,

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

/**
 * True once the LLM provider is configured. Step 4 features check this and
 * degrade with a plain-language message rather than throwing at the user.
 */
export function hasLlmConfigured(): boolean {
  return Boolean(env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL);
}
