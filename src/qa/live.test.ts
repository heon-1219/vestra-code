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
    /*
     * The walk, printed the way the panel shows it.
     *
     * Not an assertion — whether a real model crosses two connections or four
     * is a question about the model. It is here because this is the only place
     * the whole chain runs at once: a real question, a real model, real tools,
     * and the trail that comes out the far end. A trail that came back empty
     * from a loop that plainly took steps is the failure this makes visible,
     * and no unit test can see it because every one of them supplies its own
     * tool results.
     */
    const trail = investigation.trail;
    console.log(`[qa] walk: ${trail.points.length}곳, 건넌 연결 ${trail.hops.length}개`);
    const nameOf = (id: string) =>
      GRAPH.items.find((item) => item.id === id)?.name ?? id;
    for (const point of trail.points) {
      const mark = point.critical ? "근거" : "  ";
      console.log(`[qa]   ${mark} [${point.number}] ${nameOf(point.id)} (${point.step}단계, ${point.leg}번째 길)`);
    }
    for (const [index, hop] of trail.hops.entries()) {
      console.log(
        `[qa]   ${index + 1}. ${nameOf(hop.from)} → ${nameOf(hop.to)} (${hop.relation}, ${hop.via})`,
      );
    }
    if (trail.unplaced.length > 0) {
      console.log(`[qa] 지도에 못 짚은 인용: ${JSON.stringify(trail.unplaced)}`);
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

/**
 * The sweep against real GitHub, with whatever allowance this machine has left.
 *
 *   VESTRA_GITHUB_LIVE=1 npx vitest run src/qa/live.test.ts
 *
 * Its own switch because it spends requests out of a public allowance of sixty
 * an hour, which is the very thing it is measuring. It asserts almost nothing:
 * what it is for is the pair of numbers it prints — how many fetches the sweep
 * spent, and what it said afterwards — because the failure this replaces was
 * "sixty fetches, all refused, reported as an absence" and that is only
 * visible against a real rate limiter.
 */
const githubLive = process.env.VESTRA_GITHUB_LIVE === "1";

describe.skipIf(!githubLive)("search_source against real GitHub", () => {
  it("sizes its sweep to the allowance it has left", async () => {
    const { githubSourceReader } = await import("./readers");
    const { createToolContext, runTool } = await import("./tools");
    // Real files first, so the sweep has something to actually open, then a
    // long tail it will only reach if the allowance lets it.
    const paths = [
      "package.json",
      "readme.md",
      "license.md",
      "contributing.md",
      ".editorconfig",
      ".prettierignore",
      ...Array.from(
        { length: 54 },
        (_, i) => `packages/next/src/build/${String(i).padStart(3, "0")}.ts`,
      ),
    ];
    const items = paths.map((path, index) => ({
      id: `f${index}`,
      kind: "file" as const,
      shape: null,
      name: path,
      label: null,
      summary: null,
      path,
      startLine: null,
      endLine: null,
      fromUser: false,
      usedBy: 0,
      uses: 0,
    }));

    let fetches = 0;
    const reader = githubSourceReader({
      owner: "vercel",
      repo: "next.js",
      ref: "canary",
      token: null,
    });
    const counted = async (path: string, signal?: AbortSignal) => {
      fetches += 1;
      return reader(path, signal);
    };

    const context = createToolContext({ items, connections: [] }, counted);
    const outcome = await runTool(context, "search_source", {
      why: "",
      words: "stop_loss",
    });

    console.log(`[qa] fetches spent: ${fetches} of a possible ${paths.length}`);
    console.log(`[qa] allowance left afterwards: ${JSON.stringify(context.quota)}`);
    console.log(`[qa] said: ${outcome.text}`);

    // The one thing that is true whatever the allowance happens to be: a
    // search that could not look inside anything never reports an absence.
    if (!outcome.text.includes("들여다봤어요")) {
      expect(outcome.text).toContain("말할 수 없어요");
    }
    expect(fetches).toBeLessThanOrEqual(paths.length);
  }, 120_000);
});
