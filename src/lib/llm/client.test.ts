import { describe, expect, it } from "vitest";

import { createLlm } from "./client";
import { LlmError, type LlmConfig } from "./types";

/**
 * The client, without a network and without a key.
 *
 * Everything here is about a remote party we do not run answering in a shape we
 * did not choose. A model server returning a reply with no `usage`, a `content`
 * of null beside tool calls, or tool arguments that are not valid JSON are all
 * ordinary operation — so they are the cases worth pinning, not the happy path.
 */

const CONFIG: LlmConfig = {
  baseUrl: "https://api.example.test/v1",
  apiKey: "test-key",
  model: "test-model",
  supportsJsonSchema: false,
};

/** Captures what was sent, which is half of what is under test. */
function fakeFetch(reply: unknown, init?: { status?: number; body?: string }) {
  const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];

  const impl = (async (url: string | URL | Request, options?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(options?.body ?? "{}")),
      headers: new Headers(options?.headers),
    });
    const status = init?.status ?? 200;
    return new Response(init?.body ?? JSON.stringify(reply), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return { impl, seen };
}

function textReply(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  };
}

describe("createLlm", () => {
  it("posts to chat/completions with the configured model and key", async () => {
    const { impl, seen } = fakeFetch(textReply("안녕하세요"));
    const llm = createLlm(CONFIG, impl);

    const reply = await llm.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(seen[0].url).toBe("https://api.example.test/v1/chat/completions");
    expect(seen[0].headers.get("Authorization")).toBe("Bearer test-key");
    expect(seen[0].body.model).toBe("test-model");
    expect(reply.text).toBe("안녕하세요");
    expect(reply.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
  });

  it("does not produce a double slash when the base url has a trailing one", async () => {
    // A double slash is answered by some gateways with a redirect that drops
    // the Authorization header, which then reads as a bad key.
    const { impl, seen } = fakeFetch(textReply("ok"));
    const llm = createLlm({ ...CONFIG, baseUrl: "https://api.example.test/v1" }, impl);
    await llm.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(seen[0].url).not.toContain("//chat");
  });

  it("carries an assistant's tool calls back onto the wire", async () => {
    // An endpoint rejects a `tool` result whose call it never saw, so a loop
    // that keeps only the results fails on its second iteration.
    const { impl, seen } = fakeFetch(textReply("done"));
    const llm = createLlm(CONFIG, impl);

    await llm.complete({
      messages: [
        { role: "user", content: "어디가 문제야?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read_source", arguments: { path: "a.ts" } }],
        },
        { role: "tool", content: "line 1", toolCallId: "call_1" },
      ],
    });

    const sent = seen[0].body.messages as Record<string, unknown>[];
    expect(sent[1].tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "read_source", arguments: '{"path":"a.ts"}' },
      },
    ]);
    expect(sent[2].tool_call_id).toBe("call_1");
  });

  it("parses tool calls, and keeps unparseable arguments rather than dropping them", async () => {
    const { impl } = fakeFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "a",
                function: { name: "search_graph", arguments: '{"q":"결제"}' },
              },
              // Truncated at the completion ceiling — this happens.
              { id: "b", function: { name: "read_source", arguments: '{"path":' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 9 },
    });

    const reply = await createLlm(CONFIG, impl).complete({
      messages: [{ role: "user", content: "x" }],
    });

    expect(reply.text).toBeNull();
    expect(reply.finishReason).toBe("tool_calls");
    expect(reply.toolCalls[0].arguments).toEqual({ q: "결제" });
    // Kept as the raw string: the caller validates anyway, and a silently
    // discarded call is a loop that stalls for a reason nobody can see.
    expect(reply.toolCalls[1].arguments).toBe('{"path":');
  });

  it("reports a truncated answer as truncated", async () => {
    // A caller that treats this as a complete reply ships a half-written
    // feature name, or a conclusion with its evidence cut off.
    const { impl } = fakeFetch({
      choices: [{ message: { content: "결제 기" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });

    const reply = await createLlm(CONFIG, impl).complete({
      messages: [{ role: "user", content: "x" }],
    });

    expect(reply.finishReason).toBe("length");
  });

  it("survives a reply with no usage block", async () => {
    const { impl } = fakeFetch({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });

    const reply = await createLlm(CONFIG, impl).complete({
      messages: [{ role: "user", content: "x" }],
    });

    expect(reply.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("only asks for a schema where the endpoint advertises one", async () => {
    const schema = { name: "features", schema: { type: "object" } };

    const off = fakeFetch(textReply("{}"));
    await createLlm(CONFIG, off.impl).complete({
      messages: [{ role: "user", content: "x" }],
      jsonSchema: schema,
    });
    // Sending response_format to an endpoint without it is a 400 on a good day
    // and a silently ignored constraint on a bad one (D47).
    expect(off.seen[0].body.response_format).toBeUndefined();

    const on = fakeFetch(textReply("{}"));
    await createLlm({ ...CONFIG, supportsJsonSchema: true }, on.impl).complete({
      messages: [{ role: "user", content: "x" }],
      jsonSchema: schema,
    });
    expect(on.seen[0].body.response_format).toMatchObject({ type: "json_schema" });
  });

  it("tells an unusable key apart from a busy endpoint", async () => {
    // The only question a caller has is whether waiting could help.
    const auth = createLlm(CONFIG, fakeFetch(null, { status: 401, body: "{}" }).impl);
    await expect(auth.complete({ messages: [] })).rejects.toMatchObject({
      kind: "auth",
      retryable: false,
    });

    const busy = createLlm(CONFIG, fakeFetch(null, { status: 429, body: "{}" }).impl);
    await expect(busy.complete({ messages: [] })).rejects.toMatchObject({
      kind: "rate_limit",
      retryable: true,
    });

    const down = createLlm(CONFIG, fakeFetch(null, { status: 503, body: "{}" }).impl);
    await expect(down.complete({ messages: [] })).rejects.toMatchObject({
      kind: "unavailable",
      retryable: true,
    });
  });

  it("never puts the key in the error a person could see", async () => {
    const { impl } = fakeFetch(null, {
      status: 401,
      // Providers really do echo a prefix of the key back.
      body: JSON.stringify({ error: "invalid key test-key" }),
    });

    await expect(
      createLlm(CONFIG, impl).complete({ messages: [] }),
    ).rejects.toSatisfy((error: unknown) => {
      return error instanceof LlmError && !error.message.includes("test-key");
    });
  });

  it("calls a reply with no choices malformed rather than crashing", async () => {
    const { impl } = fakeFetch({ id: "x" });
    await expect(
      createLlm(CONFIG, impl).complete({ messages: [] }),
    ).rejects.toMatchObject({ kind: "malformed" });
  });
});
