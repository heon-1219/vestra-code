import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

/**
 * Re-read one real project, from the command line.
 *
 * Opt-in, and it is a tool rather than a test:
 *
 *   VESTRA_REANALYZE=<projectId> npx vitest run src/analysis/reanalyze.test.ts
 *
 * It exists because the web app is not always the fastest way to answer "did
 * this actually work". The analysis pipeline is a plain module that takes a
 * project and an emitter and knows nothing about HTTP (section 6.2), so it can
 * be driven without a browser, without a session, and without a dev server that
 * happens to be mid-recompile. That property was designed in; this is the first
 * thing to use it.
 *
 * It writes to the real database, which is why nothing here runs by default and
 * why the project id has to be typed out rather than discovered.
 */

const projectId = process.env.VESTRA_REANALYZE ?? "";

if (projectId) {
  try {
    // Vitest does not read `.env.local` — Next does, which is why the app works
    // and this would otherwise fail on a machine that is perfectly configured.
    process.loadEnvFile(".env.local");
  } catch {
    // Absent or unreadable. The import below will say so in the only way that
    // matters: `env.ts` refuses to hand out a half-configured environment.
  }
}

describe.skipIf(!projectId)("re-reading one project for real", () => {
  it("draws its map again and says what changed", async () => {
    const { db } = await import("@/db");
    const { analysisRuns, edges, nodes, projects } = await import("@/db/schema");
    const { startAnalysis } = await import("./pipeline");
    const { llmFromEnv } = await import("@/lib/llm");

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    expect(project, `no project with id ${projectId}`).toBeDefined();
    if (!project) return;

    /** Counts by type, so "more edges" can be read as "more of what". */
    const shape = async () => {
      const nodeRows = await db
        .select({ type: nodes.type })
        .from(nodes)
        .where(eq(nodes.projectId, projectId));
      const edgeRows = await db
        .select({ type: edges.type, confidence: edges.confidence })
        .from(edges)
        .where(eq(edges.projectId, projectId));

      const tally = (list: string[]) =>
        list.reduce<Record<string, number>>((all, key) => {
          all[key] = (all[key] ?? 0) + 1;
          return all;
        }, {});

      return {
        nodes: nodeRows.length,
        edges: edgeRows.length,
        nodesByType: tally(nodeRows.map((row) => row.type)),
        edgesByType: tally(edgeRows.map((row) => row.type)),
        certain: edgeRows.filter((row) => row.confidence === "certain").length,
        inferred: edgeRows.filter((row) => row.confidence === "inferred").length,
      };
    };

    const before = await shape();
    console.log(`\n=== ${project.displayName} (${project.kind}) ===`);
    console.log(`before: ${before.nodes} nodes, ${before.edges} edges`);
    console.log(`  nodes ${JSON.stringify(before.nodesByType)}`);
    console.log(`  edges ${JSON.stringify(before.edgesByType)}`);
    console.log(`  certain ${before.certain} / inferred ${before.inferred}`);

    const started = await startAnalysis({
      db,
      project:
        project.source === "github"
          ? {
              id: project.id,
              source: "github",
              repoOwner: project.repoOwner ?? "",
              repoName: project.repoName ?? "",
              defaultBranch: project.defaultBranch ?? "main",
              kind: project.kind,
            }
          : { id: project.id, source: "upload", kind: project.kind },
      githubToken: null,
      llm: llmFromEnv(),
    });
    expect(started.ok, started.ok ? "" : started.message).toBe(true);
    if (!started.ok) return;

    console.log(`run ${started.runId} started=${started.started}`);

    /*
     * `startAnalysis` returns as soon as there is a run id to hand back (D16)
     * and the run outlives the request, so the only way to know it finished is
     * to watch the row it writes.
     */
    const deadline = Date.now() + 15 * 60_000;
    let status = "pending";
    let error: string | null = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const [row] = await db
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, started.runId))
        .limit(1);
      if (!row) continue;
      status = row.status;
      error = row.error;
      if (status === "completed" || status === "failed") break;
    }

    const [run] = await db
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.projectId, projectId))
      .orderBy(desc(analysisRuns.startedAt))
      .limit(1);

    const [afterProject] = await db
      .select({ kind: projects.kind })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    const after = await shape();
    console.log(`\nrun: ${status}${error ? ` — ${error}` : ""}`);
    console.log(
      `analyzer=${run?.analyzer ?? "-"} v${run?.analyzerVersion ?? "-"} files=${run?.filesParsed ?? 0} commit=${run?.commitSha?.slice(0, 7) ?? "-"}`,
    );
    console.log(`kind: ${project.kind} -> ${afterProject?.kind ?? "?"}`);
    console.log(`after:  ${after.nodes} nodes, ${after.edges} edges`);
    console.log(`  nodes ${JSON.stringify(after.nodesByType)}`);
    console.log(`  edges ${JSON.stringify(after.edgesByType)}`);
    console.log(`  certain ${after.certain} / inferred ${after.inferred}`);
    console.log(
      `\nCHANGE: nodes ${before.nodes} -> ${after.nodes}, edges ${before.edges} -> ${after.edges}`,
    );

    expect(status).toBe("completed");
  }, 16 * 60_000);
});
