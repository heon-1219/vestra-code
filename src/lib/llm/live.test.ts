import { describe, expect, it } from "vitest";

import { createLlm } from "./client";

/**
 * The one test that proves the key, the endpoint and the model actually work
 * together. Opt-in, like the other live tests in this repo.
 *
 *   VESTRA_LIVE=1 npx vitest run src/lib/llm/live.test.ts
 *
 * Skipped by default and skipped with a reason when there is no key, because a
 * suite that fails on a contributor's machine for want of a credential trains
 * everyone to ignore red.
 *
 * It asks three questions in one round trip, and they are the three that a unit
 * test against a fake can never answer:
 *
 *   1. **Does the key work on THIS endpoint?** A key is scoped to a provider,
 *      and D44 pins one deliberately.
 *   2. **Does the model name exist there?** `mimo-v2.5` and `mimo-v2.5-pro` are
 *      different models released the same day (D45), and a wrong name is a 404
 *      that reads like a network problem.
 *   3. **Does it actually call tools?** This is the capability the whole
 *      investigation loop rests on, and the one that varies by serving provider
 *      rather than by model. An endpoint that quietly ignores `tools` and
 *      answers in prose looks fine until the loop never takes a step.
 *
 * The configuration is imported INSIDE the test, not at the top of the file.
 * `./config` reads `env.ts`, which validates all eleven variables the moment it
 * is imported and throws when any is missing — so a top-level import makes this
 * file fail to load on every machine without a full environment, including when
 * the suite is skipped. The first version of this file did exactly that and
 * broke the whole run for everyone else. A dynamic import inside the body only
 * happens when the test actually runs, which is when a configured process is
 * the precondition anyway.
 */

const live = process.env.VESTRA_LIVE === "1";
// Read the raw variable rather than the parsed config, for the same reason.
const keyed = Boolean(process.env.LLM_API_KEY);

describe.skipIf(!live || !keyed)("the configured endpoint, for real", () => {
  it("answers, reports what it cost, and can call a tool", async () => {
    const { llmConfig } = await import("./config");
    const config = llmConfig();
    expect(config, "LLM_BASE_URL / LLM_API_KEY / LLM_MODEL must all be set").not.toBeNull();

    const llm = createLlm(config!);

    const reply = await llm.complete({
      messages: [
        {
          role: "system",
          content:
            "You are a test harness. Use the given tool exactly once, then stop.",
        },
        { role: "user", content: "src/app/page.tsx 파일의 1번째 줄부터 5줄을 읽어줘." },
      ],
      tools: [
        {
          name: "read_source",
          description: "Read a window of lines from one file of the project.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              fromLine: { type: "number" },
              lineCount: { type: "number" },
            },
            required: ["path"],
          },
        },
      ],
      maxOutputTokens: 200,
      temperature: 0,
    });

    // Usage is what the loop's budget is enforced against, so a provider that
    // omits it silently makes every budget infinite.
    expect(reply.usage.inputTokens).toBeGreaterThan(0);

    // The capability the loop rests on. If this fails with text instead of a
    // tool call, the endpoint is serving the model without tool support and
    // D44's warning has come true — change the endpoint, not the prompt.
    expect(reply.toolCalls.length).toBeGreaterThan(0);
    expect(reply.toolCalls[0].name).toBe("read_source");
    expect(reply.toolCalls[0].arguments).toMatchObject({ path: expect.any(String) });

    console.log(
      `[live] ${config!.model} @ ${config!.baseUrl} — in ${reply.usage.inputTokens}, out ${reply.usage.outputTokens}, finish ${reply.finishReason}`,
    );
  }, 60_000);
});
