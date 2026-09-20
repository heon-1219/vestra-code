import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AnalysisEmitter, SourceFile } from "@/analysis/types";

import { createTypescriptAnalyzer } from "./analyzer";

/**
 * The analyzer, run against this repository.
 *
 * Opt-in:  VESTRA_SELFCHECK=1 npx vitest run src/analysis/typescript/selfcheck.test.ts
 *
 * Every other test here drives the analyzer over a hand-written fixture, which
 * proves it does what we told it to on trees we designed. This is the opposite
 * question and the one a user actually asks: on a real codebase nobody shaped
 * for it, **does it find the connections that are plainly there?**
 *
 * A diagnostic rather than a guard, which is why it is opt-in and why the
 * assertions are loose. It exists to be read: it prints what it found and what
 * it missed for a list of connections that are true by inspection, so a gap
 * shows up as a name rather than as a number that looks slightly low.
 */

const ROOT = process.cwd();

function collect(dir: string, into: SourceFile[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const absolutePath = path.join(dir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      collect(absolutePath, into);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) continue;
    into.push({
      path: path.relative(ROOT, absolutePath).split(path.sep).join("/"),
      absolutePath,
      size: stat.size,
      read: () => readFileSync(absolutePath, "utf8"),
    });
  }
}

function silent(skipped: string[]): AnalysisEmitter {
  return {
    phase: () => {},
    fileParsed: () => {},
    nodes: () => {},
    edges: () => {},
    fileSkipped: (p, reason) => skipped.push(`${p}: ${reason}`),
  };
}

/**
 * Connections that are true by reading the source, chosen to cover a different
 * resolution path each. If the analyzer is accurate these all exist; whichever
 * ones do not are the shape of the problem.
 */
const EXPECTED: {
  what: string;
  from: string;
  to: string;
  name: string;
  type: string;
}[] = [
  {
    what: "a component rendering another component",
    from: "src/components/workspace/workspace.tsx",
    to: "src/components/workspace/map/district-map.tsx",
    name: "DistrictMap",
    type: "renders",
  },
  {
    what: "a hook calling a plain function it imported",
    from: "src/hooks/use-ask.ts",
    to: "src/lib/ask/frames.ts",
    name: "createFrameReader",
    type: "calls",
  },
  {
    what: "a call through a re-export barrel (@/db/schema -> ./auth)",
    from: "src/lib/github/token.ts",
    to: "src/db/schema/auth.ts",
    name: "account",
    type: "imports",
  },
  {
    what: "a function calling one in the same file",
    from: "src/qa/trail.ts",
    to: "src/qa/trail.ts",
    name: "markCritical",
    type: "calls",
  },
  {
    what: "a renderer function called across modules",
    from: "src/components/workspace/map/district-map.tsx",
    to: "src/components/workspace/map/render/walk.ts",
    name: "trailFrom",
    type: "calls",
  },
  {
    what: "a panel rendering the walk view",
    from: "src/components/workspace/panel/connections-panel.tsx",
    to: "src/components/workspace/panel/walk-view.tsx",
    name: "WalkView",
    type: "renders",
  },
];

const on = process.env.VESTRA_SELFCHECK === "1";

describe.skipIf(!on)("the analyzer, against this repository", () => {
  it("finds the connections that are plainly there", async () => {
    const files: SourceFile[] = [];
    collect(path.join(ROOT, "src"), files);

    const skipped: string[] = [];
    const { nodes, edges } = await createTypescriptAnalyzer().analyze(
      files,
      ROOT,
      silent(skipped),
    );

    const nodesByType: Record<string, number> = {};
    for (const node of nodes) {
      nodesByType[node.ref.type] = (nodesByType[node.ref.type] ?? 0) + 1;
    }
    const edgesByType: Record<string, number> = {};
    for (const edge of edges) {
      edgesByType[edge.type] = (edgesByType[edge.type] ?? 0) + 1;
    }
    const certain = edges.filter((e) => e.confidence === "certain").length;

    console.log(`\nfiles given:   ${files.length}`);
    console.log(`files skipped: ${skipped.length}`);
    for (const one of skipped.slice(0, 20)) console.log(`   ${one}`);
    console.log(`nodes: ${nodes.length} ${JSON.stringify(nodesByType)}`);
    console.log(`edges: ${edges.length} ${JSON.stringify(edgesByType)}`);
    console.log(`  certain ${certain} / inferred ${edges.length - certain}`);

    // How many symbols never appear at either end of anything. A high number
    // here is the "it is not finding connections" complaint, quantified.
    const touched = new Set<string>();
    for (const edge of edges) {
      touched.add(`${edge.source.filePath}::${edge.source.name ?? ""}`);
      touched.add(`${edge.target.filePath}::${edge.target.name ?? ""}`);
    }
    const symbols = nodes.filter((n) => n.ref.type === "symbol");
    const orphans = symbols.filter(
      (n) => !touched.has(`${n.ref.filePath}::${n.ref.name ?? ""}`),
    );
    console.log(
      `\nsymbols with no connection at all: ${orphans.length} / ${symbols.length}`,
    );
    for (const one of orphans.slice(0, 25)) {
      console.log(`   ${one.ref.filePath} :: ${one.ref.name}`);
    }

    console.log("\nconnections that should exist:");
    const missing: string[] = [];
    for (const want of EXPECTED) {
      const hit = edges.find(
        (edge) =>
          edge.type === want.type &&
          edge.source.filePath === want.from &&
          edge.target.filePath === want.to &&
          edge.target.name === want.name,
      );
      // Same pair and name, any relation — tells "wrong kind" apart from "absent".
      const anyKind = edges.find(
        (edge) =>
          edge.source.filePath === want.from &&
          edge.target.filePath === want.to &&
          edge.target.name === want.name,
      );
      const mark = hit ? `FOUND (${hit.confidence})` : anyKind ? `WRONG KIND (${anyKind.type})` : "MISSING";
      if (!hit) missing.push(`${want.what} [${mark}]`);
      console.log(`  ${mark.padEnd(18)} ${want.type.padEnd(9)} ${want.name} — ${want.what}`);
    }

    console.log(`\nmissing: ${missing.length} / ${EXPECTED.length}`);

    // Loose on purpose: this is a diagnostic. It fails only if the analyzer
    // produced nothing at all, which would mean the harness is wrong rather
    // than the analyzer.
    expect(nodes.length).toBeGreaterThan(0);
    expect(edges.length).toBeGreaterThan(0);
  }, 600_000);
});
