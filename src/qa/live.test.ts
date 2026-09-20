import { describe, expect, it } from "vitest";

import { GRAPH, SOURCE, fixtureReader } from "./__fixtures__/project";
import { investigate } from "./loop";

/**
 * The loop against a real model, on a project with a real defect in it.
 *
 * Opt-in:
 *
 *   VESTRA_LIVE=1 npx vitest run src/qa/live.test.ts
 *
 * Every other test in this directory drives the loop with a scripted fake, and
 * those prove it is HONEST — that a finding cannot be filed without a citation
 * inside something actually read, that running out of steps is reported as
 * running out of steps. None of them can prove a real model will take a
 * sensible step, and that is what this one is for.
 *
 * The fixture has a planted fault: `formatPrice` formats with `en-US`
 * thousands separators and then appends 원. It is a single line, it is
 * reachable only by opening the file, and nothing in the graph's shape hints at
 * it — so a loop that guesses from names cannot find it and a loop that reads
 * can.
 *
 * **What this asserts is the contract, not the answer.** Whether the model
 * lands on that line is a question about the model; whether a claim can travel
 * without evidence is a question about us. Asserting the wording would make
 * this a test that fails when a provider changes its temperature.
 */

const live = process.env.VESTRA_LIVE === "1";

if (live) {
  try {
    // Vitest does not read `.env.local` — Next does, which is why the app works
    // and a live test on a keyed machine would otherwise skip.
    process.loadEnvFile(".env.local");
  } catch {
    // Absent or unreadable; the skip below then reports it honestly.
  }
}

const keyed = Boolean(
  process.env.LLM_GEMINI_API_KEY ||
    process.env.LLM_MIMO_API_KEY ||
    process.env.LLM_API_KEY,
);

describe.skipIf(!live || !keyed)("the investigation loop, against a real model", () => {
  it("opens files and cannot conclude without citing one", async () => {
    const { llmFromEnv } = await import("@/lib/llm");
    const llm = llmFromEnv();
    expect(llm, "a provider key must be configured").not.toBeNull();

    const investigation = await investigate({
      question: "결제 버튼에 나오는 가격이 이상하게 보여요. 어디를 봐야 할까요?",
      graph: GRAPH,
      llm: llm!,
      source: fixtureReader(SOURCE),
      // Deliberately small. A loop that needs twenty steps on a four-file
      // project is not investigating, it is wandering.
      budget: { maxSteps: 6 },
    });

    for (const event of investigation.trace) {
      console.log(`[qa] ${event.seq} ${event.type} ${JSON.stringify(event.payload)}`);
    }
    console.log(`[qa] stopped: ${investigation.stop}`);
    console.log(`[qa] answer: ${investigation.summary}`);
    for (const finding of investigation.findings) {
      console.log(
        `[qa] finding (${finding.certainty}): ${finding.claim} — ${JSON.stringify(finding.citations)}`,
      );
    }
    console.log(`[qa] spent: ${JSON.stringify(investigation.spent)}`);
    for (const ruled of investigation.ruledOut) console.log(`[qa] looked at: ${ruled}`);
    for (const refused of investigation.refused) console.log(`[qa] refused: ${JSON.stringify(refused)}`);

    // It has to have actually used a tool. A model answering from the item
    // names alone is the single-shot answer this loop exists to replace.
    const steps = investigation.trace.filter((event) => event.type === "step.taken");
    expect(steps.length).toBeGreaterThan(0);

    // And the contract: nothing that survived may claim a thing without saying
    // where it read it.
    for (const finding of investigation.findings) {
      expect(finding.citations.length).toBeGreaterThan(0);
      for (const citation of finding.citations) {
        expect(citation.path).toBeTruthy();
      }
    }

    // Usage has to come back, or every budget in the product is silently
    // infinite.
    expect(investigation.spent.inputTokens).toBeGreaterThan(0);
  }, 180_000);
});
