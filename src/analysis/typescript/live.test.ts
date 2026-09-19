import { describe, expect, it } from "vitest";

import { ingestRepo } from "@/analysis/ingest";
import type { AnalysisEmitter } from "@/analysis/types";

import { createTypescriptAnalyzer } from "./analyzer";

const live = process.env.VESTRA_LIVE ? describe : describe.skip;

function silentEmitter(skipped: string[]): AnalysisEmitter {
  return {
    phase: () => {},
    fileParsed: () => {},
    nodes: () => {},
    edges: () => {},
    fileSkipped: (p, reason) => skipped.push(`${p}: ${reason}`),
  };
}

live("TypeScript analyzer against the demo repo", () => {
  it("produces a graph a person could act on", async () => {
    const ingest = await ingestRepo("heon-1219", "coding-interview-prep", "master", null);
    expect(ingest.ok, ingest.ok ? "" : ingest.message).toBe(true);
    if (!ingest.ok) return;

    const skipped: string[] = [];
    const { nodes, edges } = await createTypescriptAnalyzer().analyze(
      ingest.value.files,
      ingest.value.root,
      silentEmitter(skipped),
    );

    const byType = (list: { ref?: { type: string }; type?: string }[], key: "ref" | "type") =>
      list.reduce<Record<string, number>>((acc, item) => {
        const k = key === "ref" ? (item as { ref: { type: string } }).ref.type : (item as { type: string }).type;
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});

    console.log("  NODES:", JSON.stringify(byType(nodes, "ref")));
    console.log("  EDGES:", JSON.stringify(byType(edges, "type")));
    console.log("  certain:", edges.filter((e) => e.confidence === "certain").length,
                " inferred:", edges.filter((e) => e.confidence === "inferred").length);
    console.log("  skipped:", skipped.length ? skipped.join(" | ") : "none");

    // The headline demo moment: a helper used from several places.
    const calls = edges.filter((e) => e.type === "calls");
    const counts = new Map<string, number>();
    for (const e of calls) {
      const k = `${e.target.filePath}:${e.target.name}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log("  most-called:", top.map(([k, n]) => `${k} x${n}`).join(", ") || "(none)");

    const renders = edges.filter((e) => e.type === "renders");
    const rcounts = new Map<string, number>();
    for (const e of renders) {
      const k = `${e.target.filePath}:${e.target.name}`;
      rcounts.set(k, (rcounts.get(k) ?? 0) + 1);
    }
    console.log("  most-rendered:", [...rcounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([k, n]) => `${k} x${n}`).join(", ") || "(none)");

    // Invariants that must hold on any repo.
    const nodeKeys = new Set(nodes.map((n) => JSON.stringify([n.ref.type, n.ref.filePath, n.ref.container ?? "", n.ref.name ?? ""])));
    for (const e of edges) {
      const s = JSON.stringify([e.source.type, e.source.filePath, e.source.container ?? "", e.source.name ?? ""]);
      const t = JSON.stringify([e.target.type, e.target.filePath, e.target.container ?? "", e.target.name ?? ""]);
      expect(nodeKeys.has(s), `dangling edge source ${s}`).toBe(true);
      expect(nodeKeys.has(t), `dangling edge target ${t}`).toBe(true);
      expect(s, "self-loop survived").not.toBe(t);
    }

    expect(nodes.length).toBeGreaterThan(20);
    expect(edges.length).toBeGreaterThan(20);
    expect(calls.length).toBeGreaterThan(0);

    await ingest.value.cleanup();
  }, 180000);
});
