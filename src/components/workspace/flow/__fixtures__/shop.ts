import type { GraphConnection, GraphItem, GraphView } from "@/lib/graph/view";

/**
 * A shop, small enough to hold in your head and shaped like the real thing.
 *
 * The same shape `src/analysis/__fixtures__/shop` has coming out of the real
 * parser, written by hand here because these tests are about the **screen** and
 * must not import a parser, a database or anything that reaches `env.ts` — which
 * validates 21 variables at import and throws, and which `@/db` and `@/lib/llm`
 * both pull in transitively. `lib/graph/flow.ts` is pure and importable with no
 * environment, and so is everything in this directory; this fixture is what
 * keeps it that way.
 *
 * It carries, on purpose:
 *
 *   - **Both joints.** A `route` that is a *sibling* of its page's pieces, and
 *     an `api_endpoint` that is a sibling of its handler. Get either wrong and a
 *     forward-only walk returns nothing on a repository that obviously has a
 *     path (§2.1), which is the failure most likely to hide behind a green test
 *     suite.
 *   - **A branch**, so `branches` is not always zero.
 *   - **An `inferred` hop**, so the certainty note and the weakest-link label
 *     have something to say.
 *   - **A package on the far file**, so the terminal sentence about an outside
 *     tool can fire.
 *   - **A Korean label on the route**, because that is what Pass 2 writes and
 *     it is the only way the beam finds 결제 at all.
 */

function item(over: Partial<GraphItem> & { id: string }): GraphItem {
  return {
    kind: "symbol",
    shape: "function",
    name: over.id,
    label: null,
    summary: null,
    path: null,
    startLine: null,
    endLine: null,
    fromUser: false,
    usedBy: 0,
    uses: 0,
    ...over,
  };
}

function link(
  id: string,
  from: string,
  to: string,
  relation: GraphConnection["relation"],
  over: Partial<GraphConnection> = {},
): GraphConnection {
  return { id, from, to, relation, certainty: "certain", ...over };
}

export const SHOP_ITEMS: GraphItem[] = [
  item({ id: "f-page", kind: "file", shape: null, name: "app/checkout/page.jsx", path: "app/checkout/page.jsx" }),
  item({ id: "r-checkout", kind: "route", shape: null, name: "/checkout", label: "결제 화면", path: "app/checkout/page.jsx" }),
  item({ id: "s-page", kind: "symbol", shape: "component", name: "CheckoutPage", path: "app/checkout/page.jsx", startLine: 4, endLine: 40, uses: 2 }),
  item({ id: "s-pay", kind: "symbol", shape: "component", name: "PayButton", path: "app/checkout/page.jsx", startLine: 44, endLine: 70, usedBy: 1, uses: 1 }),
  item({ id: "s-cart", kind: "symbol", shape: "component", name: "CartSummary", path: "app/checkout/page.jsx", startLine: 74, endLine: 90, usedBy: 1 }),

  item({ id: "f-orders", kind: "file", shape: null, name: "lib/orders.js", path: "lib/orders.js" }),
  item({ id: "s-create", kind: "symbol", shape: "function", name: "createOrder", path: "lib/orders.js", startLine: 3, endLine: 20, usedBy: 1, uses: 1 }),

  item({ id: "f-api", kind: "file", shape: null, name: "app/api/orders/route.js", path: "app/api/orders/route.js" }),
  item({ id: "e-orders", kind: "api_endpoint", shape: null, name: "/api/orders", label: "주문 받는 곳", path: "app/api/orders/route.js" }),
  item({ id: "s-post", kind: "symbol", shape: "function", name: "POST", path: "app/api/orders/route.js", startLine: 6, endLine: 30, usedBy: 1, uses: 1 }),
  item({ id: "s-save", kind: "symbol", shape: "function", name: "saveOrder", path: "app/api/orders/route.js", startLine: 34, endLine: 50, usedBy: 1 }),

  item({ id: "p-stripe", kind: "package", shape: null, name: "stripe", usedBy: 1 }),

  /*
   * What Pass 2 writes, and the reason the founder's own sentence works.
   *
   * "이 구매 기능 어떻게 동작하는지 말해줘" has exactly one word in it about the
   * project — 구매 — and nothing in this repository is called that: not the
   * route (`/checkout`), not the file, not the button. The only thing that
   * carries the word a person uses is the feature the naming pass wrote, which
   * is why a matched feature has to resolve to the addresses inside it.
   */
  item({ id: "feat-buy", kind: "feature", shape: null, name: "구매", label: "구매", usedBy: 2 }),
];

export const SHOP_CONNECTIONS: GraphConnection[] = [
  link("c1", "f-page", "r-checkout", "contains"),
  link("c2", "f-page", "s-page", "contains"),
  link("c3", "f-page", "s-pay", "contains"),
  link("c4", "f-page", "s-cart", "contains"),
  link("c5", "f-orders", "s-create", "contains"),
  link("c6", "f-api", "e-orders", "contains"),
  link("c7", "f-api", "s-post", "contains"),
  link("c8", "f-api", "s-save", "contains"),

  // The branch: the page draws two things, and only one of them goes anywhere.
  link("c9", "s-page", "s-pay", "renders", { line: 12 }),
  link("c10", "s-page", "s-cart", "renders", { line: 18 }),

  link("c11", "s-pay", "s-create", "calls", { line: 34 }),
  /*
   * A wildcard address: the parser saw `${…}` in the middle and said so — and
   * the one connection here that Pass 3 wrote a sentence for, so the panel has
   * a hop whose `narrator` is `purpose` to mark.
   */
  link("c12", "s-create", "e-orders", "fetches", {
    certainty: "inferred",
    line: 9,
    purpose: "주문 내용을 서버로 보내요",
  }),
  link("c13", "s-post", "s-save", "calls", { line: 11 }),

  link("c14", "f-api", "p-stripe", "uses_package"),
  link("c15", "f-page", "f-orders", "imports"),

  // `belongs_to` is written member → feature, and it hangs off the FILE: Pass 2
  // is asked about files, and D52 is the inheritance through `contains` that
  // gets the claim down to the route inside one.
  link("c16", "f-page", "feat-buy", "belongs_to", { certainty: "inferred" }),
  link("c17", "f-api", "feat-buy", "belongs_to", { certainty: "inferred" }),
];

export const SHOP: GraphView = {
  projectId: "shop",
  items: SHOP_ITEMS,
  connections: SHOP_CONNECTIONS,
  lastRun: {
    id: "run-1",
    status: "completed",
    finishedAt: "2026-09-21T00:00:00.000Z",
    filesParsed: 3,
    filesSkipped: [],
    error: null,
  },
};

/**
 * The same project whose address we had to work out rather than read.
 *
 * What every Streamlit route in production is: which pages exist depends on
 * which script somebody ran, which is a command line rather than a file in the
 * repository, so `python/streamlit.ts` writes the `contains` edge `inferred`.
 * The walk cannot say this — the entry joint is `certain` because reversing a
 * `contains` is a structural fact — so the panel is the only thing that can.
 */
export const GUESSED_ADDRESS: GraphView = {
  ...SHOP,
  connections: SHOP_CONNECTIONS.map((one) =>
    one.id === "c1" ? { ...one, certainty: "inferred" as const } : one,
  ),
};

/** The same project read by the shallow analyzer: `imports` and nothing else. */
export const SHALLOW: GraphView = {
  ...SHOP,
  items: SHOP_ITEMS.filter((one) => one.kind === "file" || one.kind === "package"),
  connections: [
    link("i1", "f-page", "f-orders", "imports"),
    link("i2", "f-orders", "f-api", "imports"),
    link("i3", "f-api", "p-stripe", "uses_package"),
  ],
};

/** A project with behaviour but no way in: the shape three of four real ones have. */
export const NO_WAY_IN: GraphView = {
  ...SHOP,
  items: SHOP_ITEMS.filter((one) => one.kind !== "route" && one.kind !== "api_endpoint"),
  connections: SHOP_CONNECTIONS.filter(
    (one) => one.to !== "r-checkout" && one.to !== "e-orders" && one.from !== "e-orders",
  ),
};
