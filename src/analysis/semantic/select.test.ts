import { describe, expect, it } from "vitest";

import type { ChangeScope } from "../incremental";

import { file, imports, shopGraph } from "./__fixtures__/graph";
import { buildOutline, refKey, type KnownText } from "./outline";
import { DEFAULT_SEMANTIC_BUDGET, featureOutline, selectTargets } from "./select";

/**
 * Which questions get asked, and — the expensive half — which do not.
 *
 * D52 is the constraint everything here serves: production holds 1,442 nodes
 * for a project of a few hundred files, and asking about all of them is both
 * unaffordable and useless, because twelve of those nodes are twelve wordings
 * of one fact. So the unit is the file, and an unchanged file is not a question
 * at all.
 */

const FULL: ChangeScope = { mode: "full", reason: "no_base_run" };

function incremental(...changed: string[]): ChangeScope {
  return { mode: "incremental", base: "aaa", head: "bbb", changed: new Set(changed) };
}

function known(entries: Record<string, KnownText>): Map<string, KnownText> {
  const map = new Map<string, KnownText>();
  for (const [path, text] of Object.entries(entries)) {
    map.set(refKey({ type: "file", filePath: path }), text);
  }
  return map;
}

const NAMED: KnownText = { label: "결제 버튼", summary: "주문을 넣어요.", textLang: "ko" };

describe("the outline", () => {
  const outline = buildOutline(shopGraph());

  it("has one entry per file and gives every file and piece its own number", () => {
    expect(outline.files).toHaveLength(6);
    const numbers = [...outline.byIndex.keys()].sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, at) => at));
  });

  it("puts a file's pieces under it, in source order", () => {
    const cart = outline.files.find((f) => f.filePath === "src/lib/useCart.ts");
    expect(cart?.pieces.map((p) => p.name)).toEqual(["useCart", "addItem"]);
  });

  it("carries the address a file serves, which is what makes 결제 nameable", () => {
    const page = outline.files.find((f) => f.filePath === "src/app/checkout/page.tsx");
    expect(page?.addresses).toEqual(["/checkout"]);
  });

  it("never lists a package as something to name", () => {
    // `react` is somebody else's library. A Korean sentence about it would be
    // this product inventing a fact about a project it did not read.
    expect([...outline.byIndex.values()].some((e) => e.name === "stripe")).toBe(false);
  });

  it("counts who points at a file, which is how ranking finds the shared ones", () => {
    const format = outline.files.find((f) => f.filePath === "src/lib/format.ts");
    expect(format?.importedBy).toBe(2);
  });

  it("does not count `contains` as a use, which is D69", () => {
    const orphan = outline.files.find((f) => f.filePath === "src/legacy/old-banner.js");
    expect(orphan?.degree).toBe(0);
  });

  it("builds the same numbers twice from the same graph", () => {
    const again = buildOutline(shopGraph());
    expect(again.files.map((f) => [f.index, f.filePath])).toEqual(
      outline.files.map((f) => [f.index, f.filePath]),
    );
  });

  it("ignores text stored in some other language (D2)", () => {
    const english = buildOutline(
      shopGraph(),
      known({ "src/lib/format.ts": { label: "Price", summary: "Formats.", textLang: "en" } }),
    );
    const format = english.files.find((f) => f.filePath === "src/lib/format.ts");
    expect(format?.label).toBeNull();
  });
});

describe("choosing what to ask about", () => {
  it("asks about the files that serve an address first", () => {
    const { targets } = selectTargets(buildOutline(shopGraph()), FULL);
    expect(targets.slice(0, 2).map((t) => t.file.filePath).sort()).toEqual([
      "src/app/api/orders/route.ts",
      "src/app/checkout/page.tsx",
    ]);
  });

  it("asks about every file when there is no base to compare against", () => {
    const { targets, carried } = selectTargets(buildOutline(shopGraph()), FULL);
    expect(targets).toHaveLength(6);
    expect(carried).toHaveLength(0);
  });

  it("does not ask again about a file that already has a name and did not change", () => {
    const outline = buildOutline(
      shopGraph(),
      known({ "src/lib/format.ts": NAMED, "src/lib/useCart.ts": NAMED }),
    );
    const { targets, carried } = selectTargets(outline, incremental("src/lib/useCart.ts"));

    expect(carried.map((f) => f.filePath)).toEqual(["src/lib/format.ts"]);
    // The file that changed is asked again even though it has a name: its
    // content moved, so the name it had may no longer be true.
    expect(targets.map((t) => t.file.filePath)).toContain("src/lib/useCart.ts");
  });

  it("asks about everything on a full run, because a full run does not know what moved", () => {
    const outline = buildOutline(shopGraph(), known({ "src/lib/format.ts": NAMED }));
    const { targets, carried } = selectTargets(outline, FULL);
    expect(carried).toHaveLength(0);
    expect(targets.map((t) => t.file.filePath)).toContain("src/lib/format.ts");
  });

  it("asks about a named file whose name is half missing", () => {
    const outline = buildOutline(
      shopGraph(),
      known({ "src/lib/format.ts": { label: "값 모양 만들기", summary: null, textLang: "ko" } }),
    );
    const { carried } = selectTargets(outline, incremental());
    expect(carried).toHaveLength(0);
  });

  it("reports what the budget could not reach rather than pretending it was empty", () => {
    const { targets, skipped } = selectTargets(buildOutline(shopGraph()), FULL, {
      ...DEFAULT_SEMANTIC_BUDGET,
      maxFiles: 2,
    });
    expect(targets).toHaveLength(2);
    expect(skipped).toHaveLength(4);
  });

  it("names pieces only inside the files the allowance reaches", () => {
    const { targets } = selectTargets(buildOutline(shopGraph()), FULL, {
      ...DEFAULT_SEMANTIC_BUDGET,
      maxPieceFiles: 1,
      maxPiecesPerFile: 1,
    });
    const withPieces = targets.filter((t) => t.pieces.length > 0);
    expect(withPieces).toHaveLength(1);
    expect(withPieces[0].pieces).toHaveLength(1);
  });

  it("puts the same questions in the same order twice", () => {
    const one = selectTargets(buildOutline(shopGraph()), FULL);
    const two = selectTargets(buildOutline(shopGraph()), FULL);
    expect(one.targets.map((t) => t.file.filePath)).toEqual(
      two.targets.map((t) => t.file.filePath),
    );
  });

  it("asks about features over the whole project, not only the files it named", () => {
    // A feature list drawn from a fifth of a repository would be a confident
    // claim about a project we half read.
    const graph = shopGraph();
    for (let at = 0; at < 30; at += 1) {
      graph.nodes.push(file(`src/extra/file-${at}.ts`));
      graph.edges.push(imports(`src/extra/file-${at}.ts`, "src/lib/format.ts"));
    }
    const outline = buildOutline(graph);
    const { targets } = selectTargets(outline, FULL, {
      ...DEFAULT_SEMANTIC_BUDGET,
      maxFiles: 5,
    });
    expect(targets).toHaveLength(5);
    expect(featureOutline(outline)).toHaveLength(36);
  });
});
