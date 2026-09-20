import { describe, expect, it } from "vitest";

/**
 * Walk every real project in the database, from the command line.
 *
 *   VESTRA_FLOW_LIVE=1 npx vitest run src/lib/graph/flow-live.test.ts
 *
 * Opt-in, and a tool rather than a test — the same shape as
 * `src/analysis/reanalyze.test.ts` and for the same reason: it reads the real
 * database, so nothing here may run by default.
 *
 * ## Why this exists
 *
 * `flow.test.ts` measures the walk against the `shop` fixture: 49 items, 63
 * connections, a widest behaviour fork of 4. That is a fixture someone wrote,
 * and §8.3 already showed what a single small fixture can hide — the
 * distance-to-endpoint criterion looked like decoration there purely because
 * the fixture's widest fork happened to equal `BEAM`.
 *
 * The honest question is whether the walk finds anything on a project a person
 * actually uploaded, and `FLOW_TRACKING.md` §8.1 and §8.2 both ask it. Neither
 * could be answered without the network, so both were left open.
 *
 * ## What it measures
 *
 * §8.2 entry-point coverage, per project and in total: of every `route` and
 * `api_endpoint` in the graph, how many produce a path at all. A low number
 * here is the joint rule of §2.1 being wrong, not the repository being odd —
 * which is exactly the failure that would otherwise be invisible, because
 * "no path" looks the same whether the code has none or we failed to walk it.
 *
 * It asserts almost nothing, on purpose. It is a measuring instrument, and a
 * measurement that fails the build every time a user adds a project with no
 * routes is a measurement nobody runs.
 */

const live = process.env.VESTRA_FLOW_LIVE === "1";

if (live) {
  try {
    // Vitest does not read `.env.local` — Next does, which is why the app works
    // and this would otherwise fail on a machine that is perfectly configured.
    process.loadEnvFile(".env.local");
  } catch {
    // Absent or unreadable. The import below will say so in the only way that
    // matters: `env.ts` refuses to hand out a half-configured environment.
  }
}

describe.skipIf(!live)("walking every real project", () => {
  it("says how many of their entry points lead anywhere", async () => {
    const { db } = await import("@/db");
    const { projects } = await import("@/db/schema");
    const { loadGraphView } = await import("./load");
    const { indexFlowGraph, projectEntryPoints, traceFlow } = await import("./flow");

    const all = await db
      .select({
        id: projects.id,
        displayName: projects.displayName,
        kind: projects.kind,
      })
      .from(projects);

    expect(all.length, "no projects in the database").toBeGreaterThan(0);

    let entryPoints = 0;
    let withPath = 0;
    let reachedEndpoint = 0;

    for (const project of all) {
      const view = await loadGraphView(db, project.id);
      const graph = { items: view.items, connections: view.connections };

      const behaviour = view.connections.filter(
        (c) => c.relation === "calls" || c.relation === "renders" || c.relation === "fetches",
      ).length;

      console.log(
        `\n=== ${project.displayName} (${project.kind}) ===\n` +
          `${view.items.length} items, ${view.connections.length} connections, ` +
          `${behaviour} of them behaviour`,
      );

      const starts = projectEntryPoints(graph);
      if (starts.length === 0) {
        // Not a failure. `FLOW_TRACKING.md` §7 has a sentence for exactly this
        // and the founder's own portfolio is the case it was written for.
        console.log("  no entry points — §7's first refusal applies");
        continue;
      }

      const index = indexFlowGraph(graph);
      for (const start of starts) {
        entryPoints += 1;
        const trace = traceFlow(graph, { startId: start.id, index });
        const path = trace.path;
        if (!path || path.hops.length === 0) {
          console.log(`  ${start.name}: no path — ${trace.refusal ?? "(no reason given)"}`);
          continue;
        }
        withPath += 1;
        if (path.reachedEndpoint) reachedEndpoint += 1;

        const route = path.hops
          .map((hop) => {
            const to = view.items.find((item) => item.id === hop.toId);
            return `${to?.label ?? to?.name ?? "?"}${hop.joint ? " (joint)" : ""}`;
          })
          .join(" → ");
        console.log(
          `  ${start.name}: ${path.hops.length} hops, ${path.terminal}, ` +
            `${path.weakest}${path.reachedEndpoint ? ", reached the server" : ""}\n` +
            `    ${start.label ?? start.name} → ${route}`,
        );
      }
    }

    const pct = (n: number) =>
      entryPoints === 0 ? "n/a" : `${((n / entryPoints) * 100).toFixed(0)}%`;
    console.log(
      `\n§8.2 across ${all.length} real projects: ` +
        `${withPath}/${entryPoints} entry points lead somewhere (${pct(withPath)}), ` +
        `${reachedEndpoint} reach a server address (${pct(reachedEndpoint)})`,
    );
  }, 5 * 60_000);
});
