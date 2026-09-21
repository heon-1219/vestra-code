import { describe, expect, it } from "vitest";

import { EXPLAIN_BUDGET, explainQuestion } from "./explain";
import { investigate } from "./loop";

/**
 * 설명하기's deep read, against a real model and a real project.
 *
 *   VESTRA_EXPLAIN_LIVE=<projectId> npx vitest run src/qa/explain-live.test.ts --reporter=verbose
 *   VESTRA_EXPLAIN_LIVE=<projectId>:<itemId>   (one place, instead of the three busiest)
 *
 * Opt-in: it reads the production database and GitHub, and spends tokens.
 *
 * What it measures is what `EXPLAIN_BUDGET` was set from (D156): how many
 * steps, tokens and seconds explaining one place costs when the loop is told
 * where to start, and whether what comes back is grounded — how many findings
 * are `certain`, how many were refused, how many lines were actually read. It
 * asserts only the contract (nothing unread is passed on as certain), for the
 * reason `live.test.ts` gives: whether a model is articulate is a question
 * about the model; whether a claim can travel without evidence is about us.
 */

const target = process.env.VESTRA_EXPLAIN_LIVE ?? "";
const live = target.length > 0;

if (live) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // `env.ts` will say what is missing.
  }
}

describe.skipIf(!live)("the deep explanation, against a real model", () => {
  it("reads the place it was pointed at and grounds what it says", async () => {
    const [projectId, itemId] = target.split(":");
    const { db } = await import("@/db");
    const { projects, analysisRuns } = await import("@/db/schema");
    const { and, desc, eq, isNotNull } = await import("drizzle-orm");
    const { loadGraphView } = await import("@/lib/graph/load");
    const { llmFromEnv } = await import("@/lib/llm");
    const { githubSourceReader, storedSourceReader } = await import("./readers");

    const llm = llmFromEnv();
    expect(llm, "a provider key must be configured").not.toBeNull();

    const [project] = await db
      .select({
        source: projects.source,
        repoOwner: projects.repoOwner,
        repoName: projects.repoName,
        defaultBranch: projects.defaultBranch,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    expect(project, "no such project").toBeDefined();

    const [run] = await db
      .select({ commitSha: analysisRuns.commitSha })
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.projectId, projectId),
          eq(analysisRuns.status, "completed"),
          isNotNull(analysisRuns.commitSha),
        ),
      )
      .orderBy(desc(analysisRuns.startedAt))
      .limit(1);

    const source =
      project.source === "upload"
        ? storedSourceReader(db, projectId)
        : githubSourceReader({
            owner: project.repoOwner ?? "",
            repo: project.repoName ?? "",
            ref: run?.commitSha ?? project.defaultBranch ?? "HEAD",
            token: process.env.GITHUB_TOKEN ?? null,
          });

    const view = await loadGraphView(db, projectId);
    const graph = { items: view.items, connections: view.connections };
    const picks = itemId
      ? graph.items.filter((item) => item.id === itemId)
      : graph.items
          .filter((item) => item.kind === "symbol" && item.path && !/\.test\./.test(item.path))
          .sort((a, b) => b.usedBy - a.usedBy)
          .slice(0, 3);
    expect(picks.length, "nothing to explain").toBeGreaterThan(0);

    for (const item of picks) {
      const investigation = await investigate({
        question: explainQuestion(item, null),
        graph,
        llm: llm!,
        source,
        focus: { items: [item] },
        budget: EXPLAIN_BUDGET,
        effort: "fast",
      });

      const certain = investigation.findings.filter((f) => f.certainty === "certain").length;
      console.log(
        `\n=== ${item.name} (${item.label ?? "-"}) · ${item.path}:${item.startLine}-${item.endLine} ===\n` +
          `stop ${investigation.stop} · ${investigation.spent.steps}/${investigation.budget.maxSteps} steps · ` +
          `${investigation.spent.inputTokens} in / ${investigation.spent.outputTokens} out tokens · ` +
          `${(investigation.spent.millis / 1000).toFixed(1)} s · ` +
          `read ${investigation.read.files} files, ${investigation.read.lines} lines · ` +
          `findings ${investigation.findings.length} (${certain} certain), refused ${investigation.refused.length}`,
      );
      for (const event of investigation.trace) {
        if (event.type === "step.taken") {
          const payload = event.payload as { step: number; tool: string; note: string };
          console.log(`  ${payload.step}. ${payload.tool} — ${payload.note}`);
        }
      }
      console.log(`  answer: ${investigation.summary}`);
      for (const finding of investigation.findings) {
        console.log(
          `  - (${finding.certainty}) ${finding.claim} — ${finding.citations
            .map((c) => `${c.path}:${c.startLine}-${c.endLine}`)
            .join(", ")}`,
        );
      }

      // The contract, and only the contract.
      for (const finding of investigation.findings) {
        expect(finding.citations.length).toBeGreaterThan(0);
      }
      if (investigation.read.lines === 0) {
        expect(certain, "certain with nothing read").toBe(0);
      }
    }
  }, 10 * 60_000);
});
