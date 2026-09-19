import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GraphItem } from "@/lib/graph/view";

import { IDLE_BEAM } from "./map/beam";
import { PlacesPanel } from "./places-panel";
import {
  DEFAULT_OPEN_ROWS,
  buildTree,
  defaultOpenFolders,
  flattenTree,
  foldersHolding,
  type FolderNode,
  type TreeItem,
  type TreeNode,
} from "./tree";

/**
 * These tests are about one promise: folding hides rows on purpose and never
 * by accident. Every one of them pins a way a file could leave this panel
 * without anybody deciding it should — a path that produced no row, a search
 * reporting matches it did not show, a selection buried under a shut folder,
 * or a fold the user chose being thrown away when they cleared the input.
 */

function entry(id: string, path: string | null): TreeItem {
  return { id, name: id, path };
}

/** Narrowing without a cast, and a readable failure when the shape is wrong. */
function folder(node: TreeNode | undefined): FolderNode {
  if (!node || node.kind !== "folder") {
    throw new Error(`expected a folder, got ${node ? node.kind : "nothing"}`);
  }
  return node;
}

function idsOf(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind === "item") out.push(node.id);
    else out.push(...idsOf(node.children));
  }
  return out;
}

function namesOf(nodes: readonly TreeNode[]): string[] {
  return nodes.map((node) => (node.kind === "folder" ? `${node.name}/` : node.id));
}

describe("buildTree", () => {
  it("gives every item a row, including one with no path at all", () => {
    const items = [
      entry("page", "src/app/page.tsx"),
      entry("cart", "src/lib/cart.ts"),
      entry("readme", "README.md"),
      // A server address has no file of its own. It must still be somewhere.
      entry("orders", null),
    ];

    const roots = buildTree(items);

    expect(idsOf(roots).sort()).toEqual(["cart", "orders", "page", "readme"]);
    expect(namesOf(roots)).toContain("orders");
  });

  it("prints a chain of single folders on one row", () => {
    const roots = buildTree([entry("hero", "src/app/(marketing)/components/hero/Hero.tsx")]);

    expect(roots).toHaveLength(1);
    expect(folder(roots[0]).name).toBe("src/app/(marketing)/components/hero");
    expect(folder(roots[0]).path).toBe("src/app/(marketing)/components/hero");
  });

  it("stops compacting at a folder that also holds a file", () => {
    const roots = buildTree([
      entry("layout", "src/app/layout.tsx"),
      entry("hero", "src/app/marketing/Hero.tsx"),
    ]);

    // `src/app` holds a file of its own, so it cannot be swallowed into the
    // row below it — the file would have nowhere to hang.
    const app = folder(roots[0]);
    expect(app.name).toBe("src/app");
    expect(namesOf(app.children)).toEqual(["marketing/", "layout"]);
  });

  it("puts folders above files, each in case-insensitive name order", () => {
    const roots = buildTree([
      // Ids are the basenames here, so the assertion reads as the rows do.
      entry("README.md", "README.md"),
      entry("orders.ts", "api/orders.ts"),
      entry("next.config.ts", "next.config.ts"),
      entry("thing.ts", "zed/thing.ts"),
    ]);

    // `README.md` last would be a capital letter deciding the order.
    expect(namesOf(roots)).toEqual(["api/", "zed/", "next.config.ts", "README.md"]);
  });

  it("counts everything underneath, at any depth", () => {
    const roots = buildTree([
      entry("a", "src/lib/a.ts"),
      entry("b", "src/lib/deep/b.ts"),
      entry("c", "src/lib/deep/c.ts"),
    ]);

    expect(folder(roots[0]).count).toBe(3);
  });

  it("reads a Windows separator as a folder boundary", () => {
    // An uploaded folder can arrive with backslashes, and one of them would
    // otherwise become a single folder named after the whole path — the panel
    // and the map would then disagree about where the file lives.
    const roots = buildTree([entry("a", "src\\lib\\cart.ts")]);

    expect(folder(roots[0]).name).toBe("src/lib");
    expect(idsOf(roots)).toEqual(["a"]);
  });

  it("namespaces folder keys, so two districts cannot share a fold", () => {
    // `src` is an ancestor of both 공용 기능 and 데이터. Sharing the key would
    // mean folding one district's row folded the other district's row too.
    const shared = buildTree([entry("a", "src/lib/a.ts"), entry("b", "src/utils/b.ts")], "shared");
    const data = buildTree([entry("c", "src/db/c.ts"), entry("d", "src/models/d.ts")], "data");

    expect(folder(shared[0]).key).toBe("shared/src");
    expect(folder(data[0]).key).toBe("data/src");
  });

  it("does not depend on the order the items arrive in", () => {
    const paths = [
      "src/app/page.tsx",
      "src/app/api/orders/route.ts",
      "src/components/PayButton.tsx",
      "public/logo.png",
      "README.md",
    ];
    const forwards = paths.map((path, index) => entry(`i${index}`, path));
    const backwards = [...forwards].reverse();

    expect(JSON.stringify(buildTree(backwards))).toBe(JSON.stringify(buildTree(forwards)));
  });
});

describe("defaultOpenFolders", () => {
  it("opens a small project whole", () => {
    const roots = buildTree([
      entry("a", "src/lib/a.ts"),
      entry("b", "src/lib/b.ts"),
      entry("c", "src/components/C.tsx"),
    ]);

    const open = defaultOpenFolders(roots);
    const rows = flattenTree(roots, (key) => open.has(key));

    // A project this size has nothing worth folding away, so the panel opens
    // exactly as the flat list it replaces did.
    expect(rows.filter((row) => row.kind === "item").map((row) => row.id).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("leaves a folder shut once it would not fit, and still opens its small neighbour", () => {
    const many = Array.from({ length: DEFAULT_OPEN_ROWS + 5 }, (_, index) =>
      entry(`img${index}`, `public/img-${index}.png`),
    );
    const roots = buildTree([...many, entry("a", "src/lib/a.ts"), entry("b", "src/lib/b.ts")]);

    const open = defaultOpenFolders(roots);

    expect(open.has("public")).toBe(false);
    expect(open.has("src/lib")).toBe(true);
  });

  it("does not open a deep chain as a column of nested rows", () => {
    const deep = "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/thing.ts";
    const roots = buildTree([entry("thing", deep)]);

    const rows = flattenTree(roots, (key) => defaultOpenFolders(roots).has(key));

    // One row for the whole chain, one for the file it leads to.
    expect(rows).toHaveLength(2);
  });
});

describe("foldersHolding", () => {
  it("returns every ancestor and not only the parent", () => {
    const roots = buildTree([
      entry("x", "src/app/deep/x.ts"),
      entry("y", "src/lib/y.ts"),
    ]);

    const holding = foldersHolding(roots, new Set(["x"]));

    // Opening `src/app/deep` while `src` is still shut reveals nothing.
    expect([...holding].sort()).toEqual(["src", "src/app/deep"]);
  });

  it("is empty when nothing is asked for", () => {
    const roots = buildTree([entry("x", "src/app/x.ts")]);

    expect(foldersHolding(roots, new Set()).size).toBe(0);
  });
});

describe("what the panel actually shows", () => {
  /**
   * The composition the panel does in one line: a folder is open when the beam
   * or the selection is revealing it, otherwise when the person opened it,
   * otherwise by default. The whole point of the order is that revealing is
   * not a write — it is why a cleared search gives the user their own folds
   * back, and that is what these three cases pin.
   */
  function isOpen(
    defaults: ReadonlySet<string>,
    chosen: ReadonlyMap<string, boolean>,
    revealed: ReadonlySet<string>,
  ): (key: string) => boolean {
    return (key) => revealed.has(key) || (chosen.get(key) ?? defaults.has(key));
  }

  const roots = buildTree([
    entry("x", "src/app/deep/x.ts"),
    entry("y", "src/app/deep/y.ts"),
    entry("z", "src/lib/z.ts"),
  ]);
  const shut: ReadonlySet<string> = new Set<string>();
  const nothingChosen: ReadonlyMap<string, boolean> = new Map<string, boolean>();

  it("hides what is inside a shut folder", () => {
    const rows = flattenTree(roots, isOpen(shut, nothingChosen, new Set()));

    expect(rows.map((row) => row.kind)).toEqual(["folder"]);
  });

  it("reveals a match inside a shut folder", () => {
    const revealed = foldersHolding(roots, new Set(["x"]));
    const rows = flattenTree(roots, isOpen(shut, nothingChosen, revealed));

    expect(rows.filter((row) => row.kind === "item").map((row) => row.id)).toContain("x");
    // Its neighbours come with it rather than being filtered out. The beam
    // dims what it did not light; it never empties the list.
    expect(rows.filter((row) => row.kind === "item").map((row) => row.id)).toContain("y");
  });

  it("gives a folder the user shut back when the search is cleared", () => {
    const defaults = defaultOpenFolders(roots);
    const chosen = new Map([["src/app/deep", false]]);
    const revealed = foldersHolding(roots, new Set(["x"]));

    const during = flattenTree(roots, isOpen(defaults, chosen, revealed));
    const after = flattenTree(roots, isOpen(defaults, chosen, new Set()));

    expect(during.some((row) => row.kind === "item" && row.id === "x")).toBe(true);
    expect(after.some((row) => row.kind === "item" && row.id === "x")).toBe(false);
  });
});

/**
 * Rendered, because the three rules above are only kept if the panel composes
 * them in that order — and because "the file is one shut folder away" and "the
 * file is gone" are the same screen to the person this product is for.
 */
describe("PlacesPanel", () => {
  function graphItem(id: string, path: string | null, kind: GraphItem["kind"] = "file"): GraphItem {
    return {
      id,
      kind,
      shape: null,
      name: path ?? id,
      label: null,
      summary: null,
      path,
      startLine: null,
      endLine: null,
      fromUser: false,
      usedBy: 0,
      uses: 0,
    };
  }

  /** Big enough that `public/` is shut on a first look, plus one odd one out. */
  const items: GraphItem[] = [
    ...Array.from({ length: DEFAULT_OPEN_ROWS + 5 }, (_, index) =>
      graphItem(`img${index}`, `public/img-${index}.png`),
    ),
    { ...graphItem("orders", null, "api_endpoint"), name: "POST /api/orders" },
  ];

  function draw(overrides: Partial<Parameters<typeof PlacesPanel>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(PlacesPanel, {
        items,
        selectedId: null,
        onSelect: () => {},
        onOpen: () => {},
        beam: IDLE_BEAM,
        ...overrides,
      }),
    );
  }

  it("names an item that has no path, rather than dropping it", () => {
    expect(draw()).toContain("POST /api/orders");
  });

  it("counts everything in the district heading, including what is folded away", () => {
    const markup = draw();

    expect(markup).not.toContain("img-7.png");
    // 17 in `public/`, and the folder row says so even while it is shut.
    expect(markup).toContain(`>${DEFAULT_OPEN_ROWS + 5}<`);
  });

  it("opens the folder a search matched into", () => {
    const markup = draw({ beam: { active: true, matched: new Set(["img7"]) } });

    expect(markup).toContain("img-7.png");
    expect(markup).toContain("1개를 찾았어요");
  });

  it("opens the folder the selected item is in", () => {
    const markup = draw({ selectedId: "img7" });

    expect(markup).toContain("img-7.png");
  });

  it("marks a folder row as a control that can be opened", () => {
    expect(draw()).toContain('aria-expanded="false"');
  });
});
