/**
 * What the rest of this codebase is allowed to know about a language model.
 *
 * One method, four concepts: messages in, an optional set of tools it may call,
 * text or tool calls out, and what it cost. Nothing about providers, keys,
 * retries or wire format crosses this line.
 *
 * That narrowness is the point, and it buys three things:
 *
 *   1. **Everything above it is testable without a network.** The investigation
 *      loop, Pass 2's naming, the Q&A agent — each takes an `Llm` and is driven
 *      in tests by a scripted fake that returns a fixed sequence. There is no
 *      API key on a contributor's machine and there should not need to be.
 *   2. **Swapping the provider is a config change.** D44 pins one serving
 *      endpoint because MiMo-V2.5's tool support varies by provider; if that
 *      endpoint ever has to change, nothing above this file learns about it.
 *   3. **The token budget is visible.** `usage` comes back on every reply
 *      rather than being logged somewhere, because the loop that calls this has
 *      a token ceiling and has to be able to enforce it.
 *
 * Deliberately NOT here: streaming. Nothing in this product streams a model's
 * answer yet — the analysis streams its own progress events, which is a
 * different thing — and an interface that carries a capability nobody uses is
 * an interface that gets implemented wrongly once and never checked.
 */

/**
 * Which model we are talking to. D50 keeps the only reader of the environment
 * in `config.ts`; the shape lives here so that `client.ts` can be imported —
 * and tested — without pulling in `env.ts`, which validates the WHOLE
 * environment at import time and throws when any of eleven variables is
 * missing. That is correct for a server that must not boot half-configured and
 * wrong for a unit test, and the first test written against this client failed
 * on exactly that.
 *
 * **Pin one serving endpoint. Never a router (D44).** MiMo-V2.5's capabilities
 * differ by serving provider rather than by model, and in exactly the two
 * things we depend on: one serves it with `tools` but no `response_format`,
 * another the reverse. A router picks by price and latency, so the same key
 * lands on a tool-less provider between one run and the next — working today,
 * silently failing tomorrow.
 */
export type LlmConfig = {
  /** An OpenAI-compatible base, no trailing slash, no `/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Whether this endpoint advertises `json_schema` structured outputs. A fact
   * about the endpoint, not derivable from its URL, so it is declared (D47).
   * False by default: claiming it where it is unsupported gets a 400 on a good
   * day and a silently ignored constraint on a bad one.
   */
  supportsJsonSchema: boolean;
  /**
   * What shape this endpoint's thinking control has.
   *
   * Three shapes, because the two providers genuinely differ and pretending
   * otherwise would be a lie in the interface:
   *
   *   - `graded` — Google documents `reasoning_effort`, mapped to its own
   *     thinking level.
   *   - `binary` — Xiaomi documents `thinking: { type: "enabled" | "disabled" }`
   *     and nothing finer. It is on or off.
   *   - `none` — an endpoint we know nothing about, so we send nothing. An
   *     unknown parameter is a 400 on a strict server.
   *
   * This is why the choice offered to a person is two options and not three:
   * a third would be a level MiMo cannot honour, and a control whose middle
   * setting does nothing on half the providers is worse than no control.
   */
  effort: "graded" | "binary" | "none";
};

export type LlmRole = "system" | "user" | "assistant" | "tool";

export type LlmMessage = {
  role: LlmRole;
  content: string;
  /**
   * On an `assistant` message, the calls it made. This has to be carried back
   * into the next request verbatim: an OpenAI-compatible endpoint rejects a
   * `tool` result whose call it never saw, so a loop that keeps only the tool
   * results and drops the assistant turn that asked for them fails on its
   * second iteration with an error about an unknown tool call id.
   */
  toolCalls?: LlmToolCall[];
  /** On a `tool` message, which call this is the result of. */
  toolCallId?: string;
};

export type LlmToolSpec = {
  name: string;
  /** What it does, in the model's language. This is prompt, and it costs tokens. */
  description: string;
  /** A JSON Schema object. Passed through untouched. */
  parameters: Record<string, unknown>;
};

export type LlmToolCall = {
  id: string;
  name: string;
  /**
   * Parsed from the model's JSON, and therefore `unknown` rather than a shape.
   *
   * The model decides what to put here and it is wrong sometimes — a missing
   * field, a string where a number belongs, occasionally a truncated object.
   * Every caller validates before use. Typing it as anything friendlier would
   * be a lie that only shows up at runtime, in production, on someone's repo.
   */
  arguments: unknown;
  /**
   * Whatever the endpoint attached to this call, carried back untouched.
   *
   * Opaque on purpose: we never read it and never depend on its shape. It
   * exists because Gemini 3 attaches a `thought_signature` to every function
   * call and REJECTS the next turn without it —
   *
   *   "Function call is missing a thought_signature in functionCall parts.
   *    This is required for tools to work correctly."
   *
   * — which is a 400 on the SECOND step of any loop, with the first step
   * looking perfect. Not documented for the OpenAI-compatible endpoint at the
   * time of writing; found by dumping a real response.
   *
   * Treating it as an opaque blob rather than a Google field is what keeps this
   * from becoming a provider special case: an endpoint that sends nothing gets
   * nothing echoed, and one that starts sending something new keeps working.
   */
  extra?: unknown;
};

export type LlmUsage = { inputTokens: number; outputTokens: number };

export type LlmReply = {
  /** Null when the model answered only with tool calls. */
  text: string | null;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  /**
   * Why the model stopped. `length` matters more than it looks: it means the
   * answer was cut off at the completion ceiling, and a caller that treats a
   * truncated reply as a complete one produces a half-written feature name or
   * a conclusion missing its evidence.
   */
  finishReason: "stop" | "length" | "tool_calls" | "other";
};

export type LlmRequest = {
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  /** The ceiling for this one reply, not for the conversation. */
  maxOutputTokens?: number;
  /**
   * Lower is steadier. Naming features and investigating a defect both want the
   * same answer twice from the same input, so callers here pass something low;
   * the default is the endpoint's.
   */
  temperature?: number;
  /**
   * A JSON Schema the reply must match. Honoured only where the endpoint
   * advertises `json_schema` (D47) — otherwise it is ignored on the wire and
   * the caller's own validation is what catches a bad shape.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /**
   * How hard to think, in our vocabulary rather than any provider's.
   *
   * Translated per endpoint by the client, and dropped entirely where the
   * endpoint has no such control. The caller asks for the outcome it wants and
   * never learns which knob it turned.
   */
  effort?: "fast" | "deep";
  signal?: AbortSignal;
};

export type Llm = {
  complete(request: LlmRequest): Promise<LlmReply>;
};

/**
 * What went wrong, in a form a caller can branch on.
 *
 * Separated by whether retrying could possibly help, because that is the only
 * question a caller actually has. A 429 or a 503 is worth waiting for; a 401 is
 * a key that will still be wrong in ten seconds, and retrying it just spends
 * the user's time before telling them the same thing.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "unconfigured"
      | "auth"
      | "rate_limit"
      | "unavailable"
      | "bad_request"
      | "malformed"
      | "aborted",
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "unavailable";
  }
}
