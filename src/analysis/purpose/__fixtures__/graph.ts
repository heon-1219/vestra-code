import type { AnalyzedEdge, AnalyzedNode } from "@/analysis/types";

import {
  contains,
  file,
  imports,
  pkg,
  symbol,
  usesPackage,
} from "../../semantic/__fixtures__/graph";

/**
 * A graph with behaviour edges on it, which the Pass 2 fixture deliberately
 * has none of.
 *
 * `semantic/__fixtures__/graph.ts` is shaped for the question Pass 2 asks —
 * which files exist and what is in them — so it carries `contains`, `imports`
 * and `uses_package` and stops there. A purpose is mostly about `calls` and
 * `renders`, and on the two real projects those are **644 of 801** groups. A
 * fixture without them would test the one relation this pass matters least for.
 *
 * Built on the same helpers rather than beside them, so the two fixtures cannot
 * drift apart on what a node ref looks like.
 */

export function calls(
  fromPath: string,
  fromName: string,
  toPath: string,
  toName: string,
  line = 10,
): AnalyzedEdge {
  return {
    source: { type: "symbol", filePath: fromPath, name: fromName },
    target: { type: "symbol", filePath: toPath, name: toName },
    type: "calls",
    confidence: "certain",
    metadata: { line },
  };
}

export function renders(
  fromPath: string,
  fromName: string,
  toPath: string,
  toName: string,
  line = 20,
): AnalyzedEdge {
  return {
    source: { type: "symbol", filePath: fromPath, name: fromName },
    target: { type: "symbol", filePath: toPath, name: toName },
    type: "renders",
    confidence: "certain",
    metadata: { line },
  };
}

/**
 * `callers` components, all calling one helper, plus a little structure around
 * it. The shape the whole pass exists for: one question, `callers` answers.
 */
export function sharedHelperGraph(callers = 12): {
  nodes: AnalyzedNode[];
  edges: AnalyzedEdge[];
} {
  const formatPrice = symbol("src/lib/format.ts", "formatPrice", "function", 1);
  const nodes: AnalyzedNode[] = [
    file("src/lib/format.ts"),
    formatPrice,
    pkg("stripe"),
  ];
  const edges: AnalyzedEdge[] = [
    contains("src/lib/format.ts", formatPrice),
    usesPackage("src/lib/format.ts", "stripe"),
  ];

  for (let at = 0; at < callers; at += 1) {
    const path = `src/components/Card${at}.tsx`;
    const name = `Card${at}`;
    const node = symbol(path, name, "component", 4);
    nodes.push(file(path), node);
    edges.push(
      contains(path, node),
      imports(path, "src/lib/format.ts"),
      calls(path, name, "src/lib/format.ts", "formatPrice", 30 + at),
    );
  }

  return { nodes, edges };
}

/**
 * `count` distinct helpers, each called from one place.
 *
 * The opposite shape to `sharedHelperGraph`, and both are needed: that one has
 * twelve connections and **one** purpose, which is what the grouping is for;
 * this one has twelve connections and **twelve** purposes, which is what a
 * budget, a batch and a twelve-hop flow are measured against.
 */
export function manyHelpersGraph(count: number): {
  nodes: AnalyzedNode[];
  edges: AnalyzedEdge[];
} {
  const nodes: AnalyzedNode[] = [file("src/app/main.ts")];
  const edges: AnalyzedEdge[] = [];

  const caller = symbol("src/app/main.ts", "main", "function", 1);
  nodes.push(caller);
  edges.push(contains("src/app/main.ts", caller));

  for (let at = 0; at < count; at += 1) {
    const path = `src/lib/step${at}.ts`;
    const name = `step${at}`;
    const node = symbol(path, name, "function", 1);
    nodes.push(file(path), node);
    edges.push(contains(path, node), calls("src/app/main.ts", "main", path, name, 10 + at));
  }

  return { nodes, edges };
}
