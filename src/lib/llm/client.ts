import {
  LlmError,
  type Llm,
  type LlmConfig,
  type LlmReply,
  type LlmRequest,
  type LlmToolCall,
} from "./types";

/**
 * An OpenAI-compatible chat client, written with `fetch` and nothing else.
 *
 * Not the AI SDK, and that is a decision rather than an omission. Three reasons,
 * in the order they decided it:
 *
 *  1. **The whole surface we need is one POST.** Messages, tools, a token
 *     ceiling, a usage count. The SDK's value is provider abstraction and a
 *     built-in tool loop; we deliberately pin one endpoint (D44) and the
 *     investigation loop is ours, with its own budget and its own trace.
 *  2. **The token plan needs the exact payload.** D52–D54 turn a 300-file
 *     analysis from ~72원 to ~5원 by controlling precisely what is sent. A layer
 *     that helpfully reformats messages is a layer between us and the number we
 *     are trying to move.
 *  3. **D48: the SDK's current major moved its API substantially** —
 *     `generateObject` gone, `system` renamed, ESM-only. Code written from
 *     remembered signatures does not compile, and the remedy is to read current
 *     docs for a dependency we would be adding to avoid writing ninety lines.
 *
 * `fetch` is injectable for exactly one reason: so every test in this file runs
 * without a network and without a key.
 */

type Fetch = typeof globalThis.fetch;

/** An endpoint that has not answered in this long is not going to. */
const REQUEST_TIMEOUT_MS = 120_000;

export function createLlm(
  config: LlmConfig,
  fetchImpl: Fetch = globalThis.fetch,
): Llm {
  return {
    async complete(request: LlmRequest): Promise<LlmReply> {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: request.messages.map(toWireMessage),
      };

      if (request.tools?.length) {
        body.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }
      if (request.maxOutputTokens !== undefined) {
        body.max_tokens = request.maxOutputTokens;
      }
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }
      /*
       * Asked for only where the endpoint says it can (D47).
       *
       * Sending `response_format` to an endpoint that does not advertise it is
       * a 400 on a good day and, on a bad one, a silently ignored constraint —
       * free prose where a schema was expected, which surfaces much later as a
       * validation failure that looks like the model being stupid.
       */
      if (request.jsonSchema && config.supportsJsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: request.jsonSchema.name,
            schema: request.jsonSchema.schema,
            strict: true,
          },
        };
      }

      /*
       * The same request, expressed in whichever knob this endpoint has.
       *
       * Google takes `reasoning_effort` and maps it to a thinking level;
       * Xiaomi takes `thinking: { type }` and has only on and off. Sending
       * either one to the other is at best ignored and at worst a 400, so the
       * translation lives here and the caller never learns which it got.
       */
      if (request.effort) {
        if (config.effort === "graded") {
          body.reasoning_effort = request.effort === "deep" ? "high" : "low";
        } else if (config.effort === "binary") {
          body.thinking = { type: request.effort === "deep" ? "enabled" : "disabled" };
        }
      }

      /*
       * Two ways to stop: the caller gave up, or the endpoint went quiet.
       *
       * Combined rather than chosen between, because they are different events
       * and the caller's one must still work when we have added our own.
       */
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout;

      let response: Response;
      try {
        response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        if (signal.aborted) {
          throw new LlmError("모델 응답을 기다리다가 멈췄어요.", "aborted");
        }
        // A DNS failure, a refused connection, a TLS problem. The cause is not
        // in the message: it can contain the URL, and the URL is next to the
        // key in every log we would write.
        throw new LlmError("모델에 연결하지 못했어요.", "unavailable");
      }

      if (!response.ok) throw await errorFor(response);

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new LlmError("모델 응답을 읽지 못했어요.", "malformed");
      }

      return readReply(parsed);
    },
  };
}

type WireMessage = {
  role: string;
  content: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    extra_content?: unknown;
  }[];
  tool_call_id?: string;
};

function toWireMessage(message: {
  role: string;
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
}): WireMessage {
  const wire: WireMessage = { role: message.role, content: message.content };
  if (message.toolCalls?.length) {
    // Back out as the string the endpoint sent us. Re-serialising our parsed
    // object would be almost the same text and occasionally not — and an
    // endpoint that hashes the tool call to match it with its result would
    // then reject the turn.
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: {
        name: call.name,
        arguments:
          typeof call.arguments === "string"
            ? call.arguments
            : JSON.stringify(call.arguments ?? {}),
      },
      // Echoed exactly as it arrived, or not at all. Gemini 3 rejects a second
      // turn whose function call has lost its thought_signature, and the error
      // names neither our request nor the turn it came from.
      ...(call.extra === undefined ? {} : { extra_content: call.extra }),
    }));
  }
  if (message.toolCallId) wire.tool_call_id = message.toolCallId;
  return wire;
}

async function errorFor(response: Response): Promise<LlmError> {
  // Read the body for the log, never for the message we show. Providers put
  // request ids, model names and occasionally a prefix of the key in there.
  const detail = await response.text().catch(() => "");
  console.error("[llm] request failed", response.status, detail.slice(0, 500));

  if (response.status === 401 || response.status === 403) {
    return new LlmError(
      "모델 열쇠가 받아들여지지 않았어요. 설정을 확인해 주세요.",
      "auth",
      response.status,
    );
  }
  if (response.status === 429) {
    return new LlmError(
      "지금은 모델이 바빠요. 잠시 후 다시 시도해 주세요.",
      "rate_limit",
      response.status,
    );
  }
  if (response.status >= 500) {
    return new LlmError(
      "모델 쪽에 문제가 있어요. 잠시 후 다시 시도해 주세요.",
      "unavailable",
      response.status,
    );
  }
  return new LlmError(
    "모델에 보낸 요청이 받아들여지지 않았어요.",
    "bad_request",
    response.status,
  );
}

/**
 * The wire response, turned into the reply the rest of the app sees.
 *
 * Every field is treated as absent until proven otherwise. This is the one
 * place in the codebase where a remote party's JSON becomes our types, and the
 * remote party is a model server we do not run: a missing `usage`, a `content`
 * of null beside tool calls, and `arguments` that do not parse are all things
 * that happen in normal operation, not corruption.
 */
function readReply(parsed: unknown): LlmReply {
  const root = asRecord(parsed);
  const choices = root?.choices;
  const first = Array.isArray(choices) ? asRecord(choices[0]) : null;
  if (!first) {
    throw new LlmError("모델이 답을 돌려주지 않았어요.", "malformed");
  }

  const message = asRecord(first.message);
  const rawText = message?.content;
  const text = typeof rawText === "string" && rawText.length > 0 ? rawText : null;

  const toolCalls: LlmToolCall[] = [];
  const rawCalls = message?.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const entry of rawCalls) {
      const call = asRecord(entry);
      const fn = asRecord(call?.function);
      const name = fn?.name;
      const id = call?.id;
      if (typeof name !== "string" || typeof id !== "string") continue;

      const raw = fn?.arguments;
      toolCalls.push({
        id,
        name,
        // Kept whatever it is. See `LlmToolCall.extra`.
        ...(call?.extra_content === undefined ? {} : { extra: call.extra_content }),
        // Kept as the raw string when it does not parse, rather than dropped.
        // The caller validates these anyway, and a tool call we silently
        // discarded is a loop that stalls for a reason nobody can see.
        arguments: typeof raw === "string" ? tryParse(raw) : (raw ?? {}),
      });
    }
  }

  const usage = asRecord(root?.usage);
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: asCount(usage?.prompt_tokens),
      outputTokens: asCount(usage?.completion_tokens),
    },
    finishReason: readFinish(first.finish_reason),
  };
}

function readFinish(value: unknown): LlmReply["finishReason"] {
  if (value === "stop" || value === "length" || value === "tool_calls") return value;
  return "other";
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
