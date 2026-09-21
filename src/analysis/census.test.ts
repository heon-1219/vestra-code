import { describe, expect, it } from "vitest";

import type { AnalyzedEdge, AnalyzedNode, EdgeType, NodeType, SymbolKind } from "./types";

import { buildPurposeAsks, refKey } from "./purpose/ask";
import { purposeKey } from "./purpose/groups";
import { buildOutline } from "./semantic/outline";
import { buildNamingPrompt } from "./semantic/prompt";
import { selectTargets } from "./semantic/select";
import { resolveSetAside, setAsideContext, setAsideOf } from "./set-aside";

/**
 * What a real project is made of, counted the way the model passes see it.
 *
 *   VESTRA_CENSUS=<projectId>[,<projectId>…] npx vitest run src/analysis/census.test.ts --reporter=verbose
 *
 * A tool rather than a test, the same shape as `reanalyze.test.ts`. It exists
 * because "skip the files nobody reads" is a decision with a cost on both
 * sides, and the only way to take it honestly is to count, per project, how
 * many files of each kind there are and what share of each model pass they
 * take. It reads the graph a previous run wrote. It asks nothing and writes
 * nothing.
 *
 * The categories printed are CANDIDATES, deliberately wider than what
 * `set-aside.ts` acts on — tests, fixtures, images, documents — so the numbers
 * for the ones we decided to keep reading are on screen next to the ones we
 * decided not to.
 */

const ids = (process.env.VESTRA_CENSUS ?? "").split(",").map((id) => id.trim()).filter(Boolean);

if (ids.length > 0) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // `env.ts` says so if it matters.
  }
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|pdf|mp4|webm|mov|mp3|wav|woff2?|ttf|otf|eot)$/i;

/** Build and tool configuration a framework scaffolds. A candidate only (D180). */
const SCAFFOLD_CONFIG =
  /(^|\/)([^/]+\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|jsconfig\.json|\.eslintrc[^/]*|\.prettierrc[^/]*|components\.json|vercel\.json|netlify\.toml|package\.json|pyproject\.toml|setup\.cfg|setup\.py|tox\.ini|requirements[^/]*\.txt|Pipfile|\.gitignore|\.editorconfig|\.env\.example)$/;

/** A candidate label for one path. Only for counting — see the header. */
function candidate(path: string, setAside: string | null): string {
  if (setAside) return `set_aside:${setAside}`;
  if (/(^|\/)(__fixtures__|fixtures|testdata|__mocks__)\//.test(path)) return "fixture";
  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path) ||
    /_test\.py$/.test(path) ||
    /(^|\/)conftest\.py$/.test(path) ||
    /(^|\/)(tests?|__tests__)\//.test(path)
  ) {
    return "test";
  }
  if (IMAGE.test(path)) return "asset";
  if (/\.(md|mdx|txt)$/i.test(path)) return "doc";
  return "source";
}

describe.skipIf(ids.length === 0)("counting what the model passes read", () => {
  it("prints each project's files by kind and by pass", async () => {
    const { db } = await import("@/db");
    const { edges: edgesTable, nodes: nodesTable, projects } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    for (const projectId of ids) {
      const [project] = await db
        .select({ name: projects.displayName, kind: projects.kind })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const nodeRows = await db.select().from(nodesTable).where(eq(nodesTable.projectId, projectId));
      const edgeRows = await db.select().from(edgesTable).where(eq(edgesTable.projectId, projectId));
      expect(nodeRows.length, `no graph for ${projectId}`).toBeGreaterThan(0);

      const refById = new Map<string, AnalyzedNode["ref"]>();
      const nodes: AnalyzedNode[] = [];
      const featureIds = new Set(nodeRows.filter((row) => row.type === "feature").map((row) => row.id));
      const pathById = new Map(nodeRows.map((row) => [row.id, row.filePath ?? ""]));
      for (const row of nodeRows) {
        if (row.type === "feature") continue;
        const ref = {
          type: row.type as NodeType,
          filePath: row.filePath ?? "",
          ...(row.type === "file" ? {} : { name: row.name }),
        };
        refById.set(row.id, ref);
        nodes.push({
          ref,
          ...(row.kind ? { kind: row.kind as SymbolKind } : {}),
          ...(row.startLine !== null ? { startLine: row.startLine } : {}),
        });
      }
      const edges: AnalyzedEdge[] = [];
      const edgeRowIds: string[] = [];
      for (const row of edgeRows) {
        const source = refById.get(row.sourceNodeId);
        const target = refById.get(row.targetNodeId);
        if (!source || !target) continue;
        edges.push({ source, target, type: row.type as EdgeType, confidence: row.confidence });
        edgeRowIds.push(row.id);
      }

      const filePaths = nodes.filter((n) => n.ref.type === "file").map((n) => n.ref.filePath);
      const context = setAsideContext(filePaths);
      // The whole-graph answer, the one the pipeline tags rows with: the
      // address exception and the import rule need the graph.
      const setAside = resolveSetAside({ nodes, edges }, context);
      const labelOf = (path: string) => candidate(path, setAside.get(path) ?? null);

      const tally = (keys: string[]) =>
        keys.reduce<Record<string, number>>((all, key) => {
          all[key] = (all[key] ?? 0) + 1;
          return all;
        }, {});

      console.log(`\n=== ${project?.name ?? projectId} (${project?.kind}) ===`);
      console.log(`files ${filePaths.length}: ${JSON.stringify(tally(filePaths.map(labelOf)))}`);
      for (const path of [...filePaths].sort()) {
        const label = labelOf(path);
        if (label.startsWith("set_aside")) console.log(`  ${label.padEnd(24)} ${path}`);
      }

      // Whether today's rules agree with the tag the last run left on each
      // row. A disagreement is a file whose carried row means something the
      // current code would not write, which is what `ANALYZER_VERSION` is for.
      const tagged = new Map(
        nodeRows
          .filter((row) => row.type === "file")
          .map((row) => [row.filePath ?? "", setAsideOf({ metadata: row.metadata })] as const),
      );
      const differ = filePaths.filter((path) => (tagged.get(path) ?? null) !== (setAside.get(path) ?? null));
      console.log(`rules vs the tags on the rows: ${differ.length} of ${filePaths.length} differ`);
      for (const path of differ) {
        console.log(`  row ${tagged.get(path) ?? "read"} -> rule ${setAside.get(path) ?? "read"}  ${path}`);
      }

      // What the last run left behind on set-aside files that only a model
      // could have written: names and descriptions on the files and on the
      // pieces inside them, and purpose sentences on their connections.
      const setAsidePaths = new Set(setAside.keys());
      const withText = nodeRows.filter(
        (row) =>
          setAsidePaths.has(row.filePath ?? "") && (row.label !== null || row.summary !== null),
      );
      console.log(
        `model text left on set-aside rows: ${withText.filter((row) => row.type === "file").length} files, ` +
          `${withText.filter((row) => row.type !== "file").length} pieces`,
      );

      // Pass 2, cold: what a first run asks about, and where its piece
      // allowance lands. Pieces are the half of a naming answer that costs.
      const outline = buildOutline({ nodes, edges }, new Map());
      const selection = selectTargets(outline, { mode: "full", reason: "no_base_run" });
      const pass2Files = tally(selection.targets.map((t) => labelOf(t.file.filePath)));
      const pass2Pieces: Record<string, number> = {};
      for (const target of selection.targets) {
        const key = labelOf(target.file.filePath);
        pass2Pieces[key] = (pass2Pieces[key] ?? 0) + target.pieces.length;
      }
      console.log(`pass2 targets ${selection.targets.length}: ${JSON.stringify(pass2Files)}`);
      console.log(`pass2 pieces  ${JSON.stringify(pass2Pieces)}`);

      // Build and tool configuration a framework scaffolds — a candidate the
      // verifier asked to see decided with a number (D180). Measured among
      // the files Pass 2 actually asks about, by share of the naming prompt.
      const read = selection.targets.filter((target) => !setAside.has(target.file.filePath));
      const config = read.filter((target) => SCAFFOLD_CONFIG.test(target.file.filePath));
      const promptChars = (targets: typeof read) =>
        buildNamingPrompt(targets).text.length - buildNamingPrompt([]).text.length;
      const labelByPath = new Map(
        nodeRows.filter((row) => row.type === "file").map((row) => [row.filePath ?? "", row.label]),
      );
      console.log(
        `pass2 scaffold config: ${config.length} of ${read.length} read files, ` +
          `${promptChars(config)} of ${promptChars(read)} prompt chars, ` +
          `${config.reduce((sum, target) => sum + target.pieces.length, 0)} pieces`,
      );
      for (const target of config) {
        console.log(`  ${target.file.filePath.padEnd(28)} ${labelByPath.get(target.file.filePath) ?? "(no name)"}`);
      }

      // Pass 3: purposes by where the TARGET lives, and — separately — the
      // purposes every one of whose callers is of one kind, which are the
      // sentences only ever shown on that kind's connections.
      // `edgeIdOf` is handed the source's path, so each group's `edgeIds` is
      // the list of places that reach for it — which is what "only ever
      // shown on a test's connections" is a question about.
      const { asks, groups } = buildPurposeAsks(
        { nodes, edges },
        new Map(),
        (edge) => edge.source.filePath,
      );
      const byTarget = tally(asks.map((ask) => labelOf(ask.targetPath)));
      console.log(`pass3 asks ${asks.length} by target: ${JSON.stringify(byTarget)}`);

      const onlyFrom: Record<string, number> = {};
      for (const group of groups) {
        const kinds = new Set(group.edgeIds.map(labelOf));
        const only = kinds.size === 1 ? [...kinds][0] : "mixed";
        onlyFrom[only] = (onlyFrom[only] ?? 0) + 1;
      }
      console.log(`pass3 asks by the kind of every caller: ${JSON.stringify(onlyFrom)}`);

      // The purposes Pass 3 sets aside on the tagged graph, and how many of
      // their connections still carry a sentence an earlier run wrote.
      const rowIdOfEdge = new Map<AnalyzedEdge, string>();
      edges.forEach((edge, at) => rowIdOfEdge.set(edge, edgeRowIds[at] ?? ""));
      const taggedNodes = nodes.map((node) =>
        node.ref.type === "file" && setAside.has(node.ref.filePath)
          ? { ...node, metadata: { setAside: setAside.get(node.ref.filePath) } }
          : node,
      );
      const purposeOf = new Map(
        edgeRows.map((row) => [row.id, (row.metadata as { purpose?: unknown }).purpose]),
      );
      const aside = buildPurposeAsks(
        { nodes: taggedNodes, edges },
        new Map(),
        (edge) => rowIdOfEdge.get(edge) ?? "",
      );
      const stalePurposes = aside.setAsideEdgeIds.filter(
        (id) => typeof purposeOf.get(id) === "string",
      ).length;
      console.log(
        `pass3 set aside ${aside.setAside} purposes over ${aside.setAsideEdgeIds.length} connections, ` +
          `${stalePurposes} still carrying an earlier sentence`,
      );

      // The example callers each question shows (D177): how many questions
      // show a caller only a set-aside file has, under the rule before (the
      // first two in edge order) and the rule now (read callers only).
      const callerName = (ref: AnalyzedEdge["source"]) =>
        ref.type === "file" ? ref.filePath : (ref.name ?? ref.filePath);
      const readCallers = new Map<string, Set<string>>();
      const firstTwo = new Map<string, string[]>();
      for (const edge of edges) {
        const key = purposeKey(edge.type, refKey(edge.target));
        const name = callerName(edge.source);
        if (!setAside.has(edge.source.filePath)) {
          const names = readCallers.get(key) ?? new Set<string>();
          names.add(name);
          readCallers.set(key, names);
        }
        const shown = firstTwo.get(key) ?? [];
        if (shown.length < 2 && name !== "" && !shown.includes(name)) shown.push(name);
        firstTwo.set(key, shown);
      }
      const onlyAside = (key: string, names: readonly string[]) =>
        names.some((name) => !(readCallers.get(key)?.has(name) ?? false));
      console.log(
        `pass3 asks ${aside.asks.length}, showing a caller only a set-aside file has: ` +
          `before ${aside.asks.filter((ask) => onlyAside(ask.key, firstTwo.get(ask.key) ?? [])).length}, ` +
          `now ${aside.asks.filter((ask) => onlyAside(ask.key, ask.examples)).length}`,
      );

      // Two facts about the map rather than the passes. Which kinds of file
      // the last feature answer put inside a territory, and whether anything
      // that is not itself a test ever reaches INTO one — the second is what
      // decides whether a flow from an entry point can ever show a test.
      const inFeature = tally(
        edgeRows
          .filter((row) => row.type === "belongs_to" && featureIds.has(row.targetNodeId))
          .map((row) => labelOf(pathById.get(row.sourceNodeId) ?? "")),
      );
      console.log(`belongs_to by member kind: ${JSON.stringify(inFeature)}`);
      const intoKind: Record<string, number> = {};
      for (const edge of edges) {
        if (edge.type === "contains") continue;
        const from = labelOf(edge.source.filePath);
        const to = edge.target.filePath === "" ? "package" : labelOf(edge.target.filePath);
        if (from === to) continue;
        const key = `${from}->${to}`;
        intoKind[key] = (intoKind[key] ?? 0) + 1;
      }
      console.log(`links between kinds: ${JSON.stringify(intoKind)}`);
    }
  }, 5 * 60_000);
});
