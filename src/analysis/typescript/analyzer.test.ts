import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { edgeId, nodeId, type NodeRef } from "@/analysis/ids";
import type {
  AnalysisEmitter,
  AnalyzedEdge,
  AnalyzedNode,
} from "@/analysis/types";

import {
  materializeFixture,
  type Fixture,
  type FixtureOverrides,
} from "../__fixtures__/load";
import { createTypescriptAnalyzer } from "./analyzer";

/**
 * The parser is the foundation of the product (section 7, Step 2). Everything
 * above it — the map, the answers, the generated prompt — repeats whatever this
 * file's subject says, in plain language, to someone who cannot check it by
 * reading the code. A wrong edge here is not a wrong edge; it is the product
 * confidently telling a user something false about their own app.
 *
 * So these tests run the real analyzer over a real fixture repository written
 * to a real temp directory. No mocks, no GitHub, no database: `analyze` is pure
 * over (files, root, emit), which is the whole reason it was shaped that way.
 *
 * `src/analysis/typescript/live.test.ts` covers the same analyzer against the
 * demo repository over the network, and is skipped by default. This suite is
 * the one that has to hold on every commit.
 */

const PROJECT = "fixture-project";

/** Identity exactly as the persistence layer computes it. Analyzers never hash. */
const idOf = (ref: NodeRef) => nodeId(PROJECT, ref);
const edgeIdOf = (edge: AnalyzedEdge) =>
  edgeId(PROJECT, edge.type, idOf(edge.source), idOf(edge.target));

/**
 * A readable one-line form of an edge, so an exact per-edge table fails with a
 * diff a person can act on rather than a wall of objects.
 */
const label = (ref: NodeRef) =>
  ref.name
    ? `${ref.filePath}:${ref.container ? `${ref.container}.` : ""}${ref.name}`
    : ref.filePath;
const describeEdge = (edge: AnalyzedEdge) =>
  `${edge.confidence} ${edge.type} ${label(edge.source)} -> ${label(edge.target)}`;

type Run = {
  fixture: Fixture;
  nodes: AnalyzedNode[];
  edges: AnalyzedEdge[];
  skipped: { path: string; reason: string }[];
  parsed: string[];
  phases: string[];
  /** Order matters: Step 3 draws nodes as they arrive and would drop early edges. */
  emissions: string[];
};

async function runFixture(
  name: string,
  overrides: FixtureOverrides = {},
): Promise<Run> {
  const fixture = materializeFixture(name, overrides);
  const skipped: Run["skipped"] = [];
  const parsed: string[] = [];
  const phases: string[] = [];
  const emissions: string[] = [];

  const emit: AnalysisEmitter = {
    phase: (phase) => phases.push(phase),
    fileParsed: (path) => parsed.push(path),
    nodes: () => emissions.push("nodes"),
    edges: () => emissions.push("edges"),
    fileSkipped: (path, reason) => skipped.push({ path, reason }),
  };

  const { nodes, edges } = await createTypescriptAnalyzer().analyze(
    fixture.files,
    fixture.root,
    emit,
  );

  return { fixture, nodes, edges, skipped, parsed, phases, emissions };
}

const nodesOfType = (run: Run, type: NodeRef["type"]) =>
  run.nodes.filter((node) => node.ref.type === type);
const edgesOfType = (run: Run, type: AnalyzedEdge["type"]) =>
  run.edges.filter((edge) => edge.type === type);
const lines = (run: Run, type: AnalyzedEdge["type"]) =>
  edgesOfType(run, type).map(describeEdge).sort();

function symbol(run: Run, filePath: string, name: string, container?: string) {
  const found = run.nodes.find(
    (node) =>
      node.ref.type === "symbol" &&
      node.ref.filePath === filePath &&
      node.ref.name === name &&
      node.ref.container === container,
  );
  if (!found) throw new Error(`no symbol ${filePath}:${container ?? ""}:${name}`);
  return found;
}

/** The line a declaration starts on, found by its text so fixtures stay editable. */
function lineOf(source: string, needle: string): number {
  const index = source.split("\n").findIndex((line) => line.includes(needle));
  if (index < 0) {
    throw new Error(`the fixture no longer contains ${JSON.stringify(needle)}`);
  }
  return index + 1;
}

function linesOf(source: string, start: number, end: number): string {
  return source.split("\n").slice(start - 1, end).join("\n");
}

/**
 * Properties that must hold for any repository at all, not just this fixture.
 * Run against every fixture, because the failures they catch — an edge pointing
 * at a node that was never created, a component that calls itself — are exactly
 * the ones that surface as a foreign-key error in production or as nonsense on
 * the user's map.
 */
function expectGraphInvariants(run: Run) {
  const nodeIds = new Set(run.nodes.map((node) => idOf(node.ref)));

  expect(nodeIds.size, "two nodes hashed to one id").toBe(run.nodes.length);

  for (const edge of run.edges) {
    const line = describeEdge(edge);
    expect(nodeIds.has(idOf(edge.source)), `dangling source: ${line}`).toBe(true);
    expect(nodeIds.has(idOf(edge.target)), `dangling target: ${line}`).toBe(true);
    expect(idOf(edge.source), `self-loop: ${line}`).not.toBe(idOf(edge.target));
    expect(["certain", "inferred"], `third confidence: ${line}`).toContain(
      edge.confidence,
    );
  }
}

// ---------------------------------------------------------------------------

describe("the TypeScript parser, on a fixture Next.js app", () => {
  let run: Run;

  beforeAll(async () => {
    run = await runFixture("shop");
  });
  afterAll(() => run.fixture.cleanup());

  describe("what it finds", () => {
    it("records every file, including the photo it never opens", () => {
      expect(nodesOfType(run, "file").map((node) => node.ref.filePath).sort()).toEqual([
        "package.json",
        "public/logo.png",
        "src/app/api/orders/route.ts",
        "src/app/checkout/page.tsx",
        "src/app/layout.tsx",
        "src/app/page.tsx",
        "src/components/Badge.tsx",
        "src/components/PayButton.tsx",
        "src/components/PriceTag.tsx",
        "src/components/Spinner.tsx",
        "src/components/admin/Badge.tsx",
        "src/components/index.ts",
        "src/legacy/totals.ts",
        "src/lib/analytics.ts",
        "src/lib/cart.ts",
        "src/lib/format.ts",
        "src/lib/orders.ts",
        "src/lib/useCart.ts",
        "tsconfig.json",
      ]);

      // An asset is a node so that "nothing on your site uses this photo" can
      // be said at all. It is marked, so nothing downstream tries to read it.
      const photo = run.nodes.find((node) => node.ref.filePath === "public/logo.png");
      expect(photo?.metadata?.asset).toBe(true);
    });

    it("names the pages a person can visit by their address", () => {
      expect(
        nodesOfType(run, "route").map((node) => `${node.ref.name} ${node.ref.filePath}`).sort(),
      ).toEqual(["/ src/app/page.tsx", "/checkout src/app/checkout/page.tsx"]);

      expect(
        nodesOfType(run, "api_endpoint").map((node) => `${node.ref.name} ${node.ref.filePath}`),
      ).toEqual(["/api/orders src/app/api/orders/route.ts"]);

      // layout.tsx is framework machinery, not an address. It is still a file
      // and still holds a component — it just is not somewhere you can go.
      expect(run.nodes.some((n) => n.ref.type === "route" && n.ref.filePath.endsWith("layout.tsx"))).toBe(false);
      expect(symbol(run, "src/app/layout.tsx", "RootLayout").kind).toBe("component");
    });

    it("tells a component from a helper, a hook, a class and a type", () => {
      expect(symbol(run, "src/components/PriceTag.tsx", "PriceTag").kind).toBe("component");
      expect(symbol(run, "src/lib/format.ts", "formatPrice").kind).toBe("function");
      expect(symbol(run, "src/lib/useCart.ts", "useCart").kind).toBe("hook");
      expect(symbol(run, "src/lib/cart.ts", "Cart").kind).toBe("class");
      expect(symbol(run, "src/lib/analytics.ts", "Payload").kind).toBe("type");
    });

    it("gives each symbol the line range its own body occupies", () => {
      // Step 4 pastes these line numbers into the prompt handed to a coding
      // agent, and Step 6 maps a click in the preview back through them. A
      // range off by a function is a range that points the agent at the wrong
      // code while sounding exact.
      const source = run.fixture.sources.get("src/lib/format.ts") as string;
      const price = symbol(run, "src/lib/format.ts", "formatPrice");

      expect(price.startLine).toBe(lineOf(source, "export function formatPrice"));
      const body = linesOf(source, price.startLine as number, price.endLine as number);
      expect(body).toContain("toLocaleString");
      expect(body).not.toContain("formatCount");
    });

    it("keeps two same-named methods in one file apart", () => {
      // Without the container, a file with total() on two classes collapses to
      // one item and every edge that should reach one of them merges onto the
      // other — silently, with no error (D27).
      const cart = symbol(run, "src/lib/cart.ts", "total", "Cart");
      const wishlist = symbol(run, "src/lib/cart.ts", "total", "Wishlist");

      expect(idOf(cart.ref)).not.toBe(idOf(wishlist.ref));
      expect(cart.startLine).not.toBe(wishlist.startLine);
    });

    it("records external dependencies by package name, scope included", () => {
      expect(nodesOfType(run, "package").map((node) => node.ref.name).sort()).toEqual([
        "@heroicons/react",
        "clsx",
        "react",
      ]);
    });

    it("resolves a @/ alias import to the file it names", () => {
      // D15 and D30. Without the path mappings lifted out of the repo's config
      // and rewritten to absolute, every one of these resolves to nothing and
      // Pass 1 emits a confident, completely disconnected graph with no error.
      expect(lines(run, "imports")).toContain(
        "certain imports src/app/page.tsx -> src/lib/format.ts",
      );
      expect(lines(run, "imports")).toContain(
        "certain imports src/app/checkout/page.tsx -> src/components/index.ts",
      );
    });

    it("ignores the repository's own hostile compiler settings", () => {
      // The fixture's tsconfig.json sets allowJs:false and moduleResolution
      // node16 — the two settings D29 measured as fatal: the first puts zero
      // files in the program while reporting zero diagnostics, the second
      // resolves ./format to nothing. Only baseUrl and paths may be lifted out.
      expect(run.parsed).toHaveLength(15);
      expect(lines(run, "imports")).toContain(
        "certain imports src/lib/orders.ts -> src/lib/format.ts",
      );
    });

    it("streams every parsed file, and finishes", () => {
      // Step 3 draws the map from these as they arrive, and it applies nodes
      // before edges because an edge needs both ends to exist.
      expect(run.phases).toEqual(["static", "done"]);
      expect(run.emissions).toEqual(["nodes", "edges"]);
      expect(new Set(run.parsed).size).toBe(run.parsed.length);
      expect(run.parsed).not.toContain("src/legacy/totals.ts");
    });
  });

  describe("certain versus inferred, edge by edge", () => {
    it("never marks a cross-file guess certain, or a direct read inferred", () => {
      // contains never crosses a file boundary and imports is the compiler's
      // own answer, so both are reads rather than resolutions.
      for (const type of ["contains", "imports", "uses_package"] as const) {
        for (const edge of edgesOfType(run, type)) {
          expect(edge.confidence, describeEdge(edge)).toBe("certain");
        }
      }
    });

    it("marks each rendered component by how it was found", () => {
      expect(lines(run, "renders")).toEqual([
        "certain renders src/app/checkout/page.tsx:CheckoutPage -> src/components/PayButton.tsx:PayButton",
        "certain renders src/app/checkout/page.tsx:CheckoutPage -> src/components/PriceTag.tsx:PriceTag",
        "certain renders src/app/page.tsx:HomePage -> src/components/PriceTag.tsx:PriceTag",
        "certain renders src/components/PayButton.tsx:PayButton -> src/components/PriceTag.tsx:PriceTag",
        // Spinner is used without an import. The compiler resolves nothing, one
        // component in the project carries that name, and so the map says
        // "probably" — a dotted line, never a solid one.
        "inferred renders src/components/PayButton.tsx:PayButton -> src/components/Spinner.tsx:Spinner",
      ]);
    });

    it("marks each call by how it was found", () => {
      expect(lines(run, "calls")).toEqual([
        "certain calls src/app/api/orders/route.ts:GET -> src/lib/format.ts:formatCount",
        "certain calls src/app/checkout/page.tsx:CheckoutPage -> src/lib/format.ts:formatPrice",
        "certain calls src/app/checkout/page.tsx:CheckoutPage -> src/lib/orders.ts:describeOrder",
        "certain calls src/app/page.tsx:HomePage -> src/lib/format.ts:formatPrice",
        "certain calls src/components/PayButton.tsx:PayButton -> src/lib/orders.ts:createOrder",
        "certain calls src/components/PayButton.tsx:PayButton -> src/lib/useCart.ts:useCart",
        "certain calls src/components/PriceTag.tsx:PriceTag -> src/lib/format.ts:formatPrice",
        // The call is written `cart.total()`. Resolving it to Cart's method
        // rather than Wishlist's is the entire point of the container (D27).
        "certain calls src/lib/cart.ts:cartTotal -> src/lib/cart.ts:Cart.total",
        "certain calls src/lib/orders.ts:describeOrder -> src/lib/format.ts:formatPrice",
        // trackEvent is called with no import, as an agent leaves it.
        "inferred calls src/lib/orders.ts:reportOrder -> src/lib/analytics.ts:trackEvent",
      ]);
    });

    it("points a barrel re-export at the real file, not at the barrel", () => {
      // Both pages import from "@/components". If the alias chase stopped at
      // the first hop, every edge would land on index.ts and the map would show
      // one enormous item that everything renders.
      const throughBarrel = edgesOfType(run, "renders").filter(
        (edge) => edge.source.filePath === "src/app/checkout/page.tsx",
      );
      expect(throughBarrel.map((edge) => edge.target.filePath).sort()).toEqual([
        "src/components/PayButton.tsx",
        "src/components/PriceTag.tsx",
      ]);
    });

    it("says nothing at all when a name is ambiguous", () => {
      // The home page renders <Badge/> without an import, and two files declare
      // a Badge — which is precisely the duplication this product exists to
      // surface. Guessing one would be worse than the silence: the brief's rule
      // is that a wrong connection beats no connection only in the other order.
      const guesses = run.edges.filter(
        (edge) => edge.type === "renders" || edge.type === "calls",
      );
      expect(guesses.some((edge) => edge.target.name === "Badge")).toBe(false);
      expect(
        run.nodes.filter((node) => node.ref.type === "symbol" && node.ref.name === "Badge"),
      ).toHaveLength(2);
    });

    it("can say a helper is used in four places, and be right", () => {
      // The demo's best moment. It fires or the product has no headline.
      const callers = edgesOfType(run, "calls").filter(
        (edge) => edge.target.name === "formatPrice",
      );
      expect(callers.map((edge) => label(edge.source)).sort()).toEqual([
        "src/app/checkout/page.tsx:CheckoutPage",
        "src/app/page.tsx:HomePage",
        "src/components/PriceTag.tsx:PriceTag",
        "src/lib/orders.ts:describeOrder",
      ]);
      expect(callers.every((edge) => edge.confidence === "certain")).toBe(true);
    });

    it("can say a component is rendered in three places", () => {
      // Section 6.4's shared-component warning has nothing to fire on without
      // this, and the warning is the difference between changing a button on
      // one page and changing it everywhere by accident.
      const users = edgesOfType(run, "renders").filter(
        (edge) => edge.target.name === "PriceTag",
      );
      expect(users.map((edge) => label(edge.source)).sort()).toEqual([
        "src/app/checkout/page.tsx:CheckoutPage",
        "src/app/page.tsx:HomePage",
        "src/components/PayButton.tsx:PayButton",
      ]);
    });
  });

  describe("the file it could not read", () => {
    const broken = "src/legacy/totals.ts";

    it("skips it without failing the run", () => {
      // A merge conflict does not throw: the parser recovers and hands back
      // usable-looking statements, so a try/catch never fires and the file
      // would be silently half-analysed. Syntactic diagnostics are the signal
      // (D38).
      expect(run.skipped.map((entry) => entry.path)).toEqual([broken]);
      expect(run.skipped[0].reason).toMatch(/구문 오류/);
    });

    it("says what happened in language a non-developer reads", () => {
      // Section 1: the graph is the engine, never the vocabulary.
      const forbidden = /node|edge|entity|triple|ontology|노드|엣지|간선|개체|온톨로지/i;
      expect(run.skipped[0].reason).not.toMatch(forbidden);
    });

    it("keeps the file on the map but claims nothing about its contents", () => {
      expect(run.nodes.some((node) => node.ref.type === "file" && node.ref.filePath === broken)).toBe(true);
      expect(run.nodes.some((node) => node.ref.type === "symbol" && node.ref.filePath === broken)).toBe(false);
      expect(run.edges.some((edge) => edge.source.filePath === broken || edge.target.filePath === broken)).toBe(false);
    });

    it("leaves the rest of the run with a graph worth showing", () => {
      expect(run.nodes.length).toBeGreaterThan(40);
      expect(edgesOfType(run, "calls").length).toBeGreaterThan(5);
      // legacyTotal calls formatPrice too. It must not be counted, because we
      // could not honestly read the file it is in.
      expect(
        edgesOfType(run, "calls").filter((edge) => edge.target.name === "formatPrice"),
      ).toHaveLength(4);
    });
  });

  describe("paths, as they will be stored", () => {
    it("stores nothing that could differ between a laptop and the server", () => {
      // D18: a GitHub archive nests everything under {owner}-{repo}-{sha}/, so
      // a prefix left in place puts a commit SHA inside every id and breaks
      // stability on every commit. And the founder develops on Windows, where
      // an unnormalised path hashes differently than on the Linux host.
      const temporaryDirectory = run.fixture.root.split(/[\\/]/).pop() as string;

      // Edge endpoints as well as nodes. An id is normalised on the way in, so
      // an edge carrying a Windows path would still match its node and pass
      // every other check here while storing a path nothing else can join on.
      const refs = [
        ...run.nodes.map((node) => node.ref),
        ...run.edges.flatMap((edge) => [edge.source, edge.target]),
      ];

      for (const ref of refs) {
        const path = ref.filePath;
        expect(path, "backslash").not.toMatch(/\\/);
        expect(path, "leading slash").not.toMatch(/^\//);
        expect(path, "drive letter").not.toMatch(/^[A-Za-z]:/);
        expect(path, "relative escape").not.toMatch(/(^|\/)\.\.?(\/|$)/);
        expect(path, "archive or temp prefix").not.toContain(temporaryDirectory);
        expect(path, "absolute path").not.toContain(run.fixture.root);
      }
    });
  });

  describe("invariants that must hold for any repository", () => {
    it("holds on the fixture", () => {
      expectGraphInvariants(run);
    });
  });

  describe("what Pass 1 does not do yet", () => {
    /**
     * Three gaps, measured rather than assumed. Each test asserts the honest
     * current state, so the day the gap is closed the test fails and whoever
     * closed it comes here and writes the real assertion. A silent gap in the
     * parser is a silent gap in every answer built on top of it.
     */

    it("does not connect a fetch to the endpoint it names", () => {
      // Section 6.2 asks for an `inferred` fetches edge when a string literal
      // path matches a known endpoint. createOrder calls fetch("/api/orders")
      // and the endpoint exists as a node, so the graph currently cannot answer
      // "what talks to this API route?" at all.
      expect(edgesOfType(run, "fetches")).toHaveLength(0);
      expect(nodesOfType(run, "api_endpoint")).toHaveLength(1);
      expect(run.fixture.sources.get("src/lib/orders.ts")).toContain('fetch("/api/orders"');
    });

    it("credits the component for a call made inside an event handler", () => {
      // PayButton calls createOrder from inside `async function pay()`. A call
      // is attributed to the nearest enclosing declaration WE MADE A NODE FOR,
      // walking past nested functions — because in React most helper calls live
      // in a handler, an effect or a map body, and stopping at the first
      // declaration dropped the edge silently. That was a systematic undercount
      // of "what uses this", in the one sentence the product is sold on.
      //
      // It is also the answer a person would give: PayButton places the order,
      // whether or not the call sits inside a closure.
      expect(run.fixture.sources.get("src/components/PayButton.tsx")).toContain("await createOrder(");
      const toCreateOrder = edgesOfType(run, "calls").filter(
        (edge) => edge.target.name === "createOrder",
      );
      expect(toCreateOrder).toHaveLength(1);
      expect(toCreateOrder[0].source.name).toBe("PayButton");
      expect(toCreateOrder[0].confidence).toBe("certain");
    });

    it("does not record what a barrel re-exports", () => {
      // `export { PriceTag } from "./PriceTag"` is an export declaration, not
      // an import declaration, so index.ts looks like a leaf file. Pass 2 is
      // fed the import graph, where every barrel will appear disconnected.
      expect(run.edges.some((edge) => edge.source.filePath === "src/components/index.ts")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------

describe("stable ids", () => {
  /**
   * Rule 1 of section 6.1. A user's correction, a chat citation and a lock all
   * point at an id, so an id that churns silently repoints somebody's decision
   * at the wrong thing — and nothing in the product reports it.
   */

  it("is identical for two runs of the same repository in different directories", async () => {
    // Different directories on purpose: a GitHub tarball extracts under
    // {owner}-{repo}-{sha}/, so the absolute prefix genuinely changes on every
    // single commit (D18).
    const first = await runFixture("shop");
    const second = await runFixture("shop");
    expect(first.fixture.root).not.toBe(second.fixture.root);

    expect(second.nodes.map((node) => idOf(node.ref)).sort()).toEqual(
      first.nodes.map((node) => idOf(node.ref)).sort(),
    );
    expect(second.edges.map(edgeIdOf).sort()).toEqual(first.edges.map(edgeIdOf).sort());

    first.fixture.cleanup();
    second.fixture.cleanup();
  });

  it("does not churn when a file changes and the lines below it move", async () => {
    const before = await runFixture("shop");

    const format = before.fixture.sources.get("src/lib/format.ts") as string;
    const page = before.fixture.sources.get("src/app/page.tsx") as string;
    const after = await runFixture("shop", {
      // An edit above formatPrice: its body has not changed, but every line
      // number in the file has. A line number inside the id would repoint the
      // user's lock on this helper at nothing.
      "src/lib/format.ts": `export const CURRENCY = "KRW";\n\n${format}`,
      // An unrelated file, edited.
      "src/app/page.tsx": page.replace("<h1>Vestra Shop</h1>", "<h1>Vestra Shop</h1>\n      <p>free shipping</p>"),
      // And a file that did not exist before.
      "src/lib/receipts.ts": 'import { formatPrice } from "./format";\n\nexport function receiptLine(cents: number): string {\n  return "total " + formatPrice(cents);\n}\n',
    });

    const afterNodeIds = new Set(after.nodes.map((node) => idOf(node.ref)));
    for (const node of before.nodes) {
      expect(afterNodeIds.has(idOf(node.ref)), `id churned: ${label(node.ref)}`).toBe(true);
    }

    const afterEdgeIds = new Set(after.edges.map(edgeIdOf));
    for (const edge of before.edges) {
      expect(afterEdgeIds.has(edgeIdOf(edge)), `edge churned: ${describeEdge(edge)}`).toBe(true);
    }

    // The proof that the previous assertion means something: the line range
    // really did move, and the id really did not.
    const was = symbol(before, "src/lib/format.ts", "formatPrice");
    const now = symbol(after, "src/lib/format.ts", "formatPrice");
    expect(now.startLine).toBe((was.startLine as number) + 2);
    expect(idOf(now.ref)).toBe(idOf(was.ref));

    // A new file adds, and only adds.
    expect(after.nodes.length).toBeGreaterThan(before.nodes.length);

    before.fixture.cleanup();
    after.fixture.cleanup();
  });
});

// ---------------------------------------------------------------------------

describe("the TypeScript parser, on plain script files", () => {
  /**
   * A .js file with no import and no export is a *script*, so TypeScript merges
   * its top-level functions into one global scope shared with every other
   * script. That is real resolution and worth having — and it is also how a
   * name declared twice resolves to two declarations in two files, where taking
   * the first would emit a `certain` edge to a coin flip (D34).
   */

  let run: Run;

  beforeAll(async () => {
    run = await runFixture("scripts");
  });
  afterAll(() => run.fixture.cleanup());

  it("follows a call into another script file", () => {
    expect(lines(run, "calls")).toContain("certain calls app.js:boot -> legacy.js:legacyPing");
    expect(lines(run, "calls")).toContain("certain calls app.js:boot -> app.js:render");
  });

  it("refuses to pick one of two globals with the same name", () => {
    // Both files declare init(). Either answer would look exactly as confident
    // as the right one on the map.
    expect(run.nodes.filter((node) => node.ref.name === "init")).toHaveLength(2);
    expect(edgesOfType(run, "calls").some((edge) => edge.target.name === "init")).toBe(false);
  });

  it("holds the same invariants", () => {
    expectGraphInvariants(run);
  });
});
