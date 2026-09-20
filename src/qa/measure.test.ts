import { describe, expect, it } from "vitest";

import type { Investigation } from "./types";

/**
 * One real investigation, on one real project, measured.
 *
 * Opt-in, and it costs money:
 *
 *   VESTRA_MEASURE=1 npx vitest run src/qa/measure.test.ts
 *
 * ## Why this exists rather than a number in a comment
 *
 * The budget in `types.ts` was reasoned rather than measured, and a constant
 * argued for in prose is a constant nobody can check. This is the harness that
 * produced the numbers now written there, and it is kept so the next person to
 * change them has to produce numbers too.
 *
 * It asserts almost nothing. Whether a model takes seven steps or nine is a
 * question about the model; what this is for is printing what actually
 * happened — steps, tokens, wall clock, how many steps went on orienting
 * versus reading, how many lines of source came back, and whether anything
 * survived as `certain`. The only assertions are the ones that would mean the
 * harness itself is lying: that it ran, and that usage came back.
 *
 * ## Knobs
 *
 *   VESTRA_PROJECT   the project id. Defaults to the Python bot this was
 *                    measured against (48 files, 213 items, 284 connections).
 *   VESTRA_Q         one question. Defaults to running the built-in set.
 *   VESTRA_STEPS     override `maxSteps`, to see what a bigger budget buys.
 *   VESTRA_RUNS      how many times to run each question. Wall clock is noisy
 *                    on a busy machine, so the report takes the best.
 */

const measuring = process.env.VESTRA_MEASURE === "1";

if (measuring) {
  try {
    // Vitest does not read `.env.local` — Next does. Same line as `live.test.ts`.
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

const PROJECT_ID =
  process.env.VESTRA_PROJECT ?? "e0ef56c2-386f-4862-a41b-69a8d1bab3dd";

/**
 * Questions a person would actually type, chosen so the answer is not in a
 * file name.
 *
 * The first is the founder's own shape — "where does the money move" — asked
 * of a project whose word for it is not 결제. The second and third need a line
 * of source read before anything can be said with certainty about them.
 */
const QUESTIONS = [
  "주문이 실제로 어디서 나가나요? 어느 API를 부르는지 알고 싶어요.",
  "손실이 커지면 자동으로 멈추는 장치가 있나요? 어디에 있어요?",
  "어떤 종목을 살지는 어디서 정해지나요?",
];

/**
 * Steps that look at the shape of the project rather than at its contents.
 *
 * Written as plain strings rather than `QaToolName` so this harness keeps
 * compiling while the tool set is being changed underneath it — which is
 * exactly what it is for.
 */
const ORIENTING: readonly string[] = [
  "find_items",
  "open_item",
  "list_files",
  "list_tree",
];

type Row = {
  question: string;
  stop: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  millis: number;
  orienting: number;
  reading: number;
  tools: string;
  filesRead: number;
  linesRead: number;
  certain: number;
  inferred: number;
  refused: number;
  points: number;
  hops: number;
};

function rowOf(question: string, investigation: Investigation): Row {
  const tools = new Map<string, number>();
  let orienting = 0;
  let reading = 0;

  for (const event of investigation.trace) {
    if (event.type !== "step.taken") continue;
    const payload = event.payload as { tool: string };
    tools.set(payload.tool, (tools.get(payload.tool) ?? 0) + 1);
    if (payload.tool === "report" || payload.tool === "unknown") continue;
    if (ORIENTING.includes(payload.tool)) orienting += 1;
    else reading += 1;
  }

  return {
    question,
    stop: investigation.stop,
    steps: investigation.spent.steps,
    inputTokens: investigation.spent.inputTokens,
    outputTokens: investigation.spent.outputTokens,
    millis: investigation.spent.millis,
    orienting,
    reading,
    tools: [...tools.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, count]) => `${name}×${count}`)
      .join(" "),
    filesRead: investigation.read.files,
    linesRead: investigation.read.lines,
    certain: investigation.findings.filter((f) => f.certainty === "certain")
      .length,
    inferred: investigation.findings.filter((f) => f.certainty === "inferred")
      .length,
    refused: investigation.refused.length,
    points: investigation.trail.points.length,
    hops: investigation.trail.hops.length,
  };
}

describe.skipIf(!measuring || !keyed)("one real investigation, measured", () => {
  it("prints what it spent and what it read", async () => {
    const { db } = await import("@/db");
    const { projects, analysisRuns } = await import("@/db/schema");
    const { and, desc, eq, isNotNull } = await import("drizzle-orm");
    const { loadGraphView } = await import("@/lib/graph/load");
    const { llmFromEnv } = await import("@/lib/llm");
    const { projectDigest } = await import("@/lib/context");
    const { githubSourceReader, storedSourceReader } = await import("./readers");
    const { investigate } = await import("./loop");

    const llm = llmFromEnv();
    expect(llm, "a provider key must be configured").not.toBeNull();

    const [project] = await db
      .select({
        id: projects.id,
        source: projects.source,
        repoOwner: projects.repoOwner,
        repoName: projects.repoName,
        defaultBranch: projects.defaultBranch,
      })
      .from(projects)
      .where(eq(projects.id, PROJECT_ID))
      .limit(1);
    expect(project, "the project must exist on this machine").toBeTruthy();

    const [run] = await db
      .select({ commitSha: analysisRuns.commitSha })
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.projectId, PROJECT_ID),
          eq(analysisRuns.status, "completed"),
          isNotNull(analysisRuns.commitSha),
        ),
      )
      .orderBy(desc(analysisRuns.startedAt))
      .limit(1);

    const view = await loadGraphView(db, PROJECT_ID);
    const graph = { items: view.items, connections: view.connections };
    console.log(
      `[measure] project ${PROJECT_ID}: 조각 ${view.items.length}, 연결 ${view.connections.length}, source=${project.source}`,
    );

    const source =
      project.source === "upload"
        ? storedSourceReader(db, PROJECT_ID)
        : project.repoOwner && project.repoName
          ? githubSourceReader({
              owner: project.repoOwner,
              repo: project.repoName,
              ref: run?.commitSha ?? project.defaultBranch ?? "HEAD",
              token: null,
            })
          : null;

    const digest = await projectDigest({
      db,
      projectId: PROJECT_ID,
      commitSha: run?.commitSha ?? null,
      items: view.items,
      read: source,
      llm: llm!,
    });
    console.log(`[measure] digest: ${digest ? JSON.stringify(digest) : "(없음)"}`);

    const questions = process.env.VESTRA_Q ? [process.env.VESTRA_Q] : QUESTIONS;
    const runs = Number(process.env.VESTRA_RUNS ?? "1");
    const steps = process.env.VESTRA_STEPS
      ? { maxSteps: Number(process.env.VESTRA_STEPS) }
      : {};

    const rows: Row[] = [];

    for (const question of questions) {
      for (let attempt = 0; attempt < runs; attempt += 1) {
        const investigation = await investigate({
          question,
          graph,
          llm: llm!,
          source,
          digest,
          budget: steps,
        });

        console.log(`\n[measure] Q: ${question}`);
        for (const event of investigation.trace) {
          if (event.type === "step.taken" || event.type === "step.concluded") {
            console.log(`[measure]   ${event.type} ${JSON.stringify(event.payload)}`);
          }
        }
        console.log(`[measure]   answer: ${investigation.summary}`);
        for (const finding of investigation.findings) {
          console.log(
            `[measure]   finding (${finding.certainty}): ${finding.claim} — ${JSON.stringify(finding.citations)}`,
          );
        }
        for (const one of investigation.refused) {
          console.log(`[measure]   refused (${one.reason}): ${one.claim}`);
        }

        const row = rowOf(question, investigation);
        rows.push(row);
        console.log(`[measure]   ${JSON.stringify(row)}`);

        expect(investigation.spent.inputTokens).toBeGreaterThan(0);
      }
    }

    console.log("\n[measure] ---- summary ----");
    console.table(
      rows.map((row) => ({
        stop: row.stop,
        steps: row.steps,
        in: row.inputTokens,
        out: row.outputTokens,
        sec: Math.round(row.millis / 100) / 10,
        orient: row.orienting,
        read: row.reading,
        files: row.filesRead,
        lines: row.linesRead,
        certain: row.certain,
        inferred: row.inferred,
        refused: row.refused,
        tools: row.tools,
      })),
    );
  }, 1_200_000);
});
