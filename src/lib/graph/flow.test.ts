import { afterEach, describe, expect, it, vi } from "vitest";

import { materializeFixture } from "@/analysis/__fixtures__/load";
import { edgeId, nodeId, type NodeRef } from "@/analysis/ids";
import type { AnalysisEmitter } from "@/analysis/types";
import { createTypescriptAnalyzer } from "@/analysis/typescript/analyzer";
import { buildLinks } from "@/components/workspace/map/render/scene";

import {
  BEAM,
  BRANCHES_SHOWN,
  FLOW_FORBIDDEN_WORDS,
  FLOW_NOTICE,
  FLOW_NO_MODEL_NOTE,
  HOP_RELATIONS,
  MAX_EXPANSIONS,
  MAX_FLOW_HOPS,
  alternativesNote,
  branchesNote,
  certaintyNote,
  entryPointsOf,
  flowRefusalSentence,
  flowSentenceIssues,
  flowTerminalSentence,
  guessedAddressNote,
  indexFlowGraph,
  projectEntryPoints,
  traceFlow,
  type FlowEvent,
  type FlowEventType,
  type FlowGraph,
  type FlowTrace,
  type HopCriterion,
} from "./flow";
import { buildGraphView, type GraphEdgeRow, type GraphNodeRow } from "./load";
import { RELATION_RANK, type ConnectionRelation, type GraphView, type ItemKind } from "./view";

/**
 * §8 of `docs/FLOW_TRACKING.md`, which is not optional and is not "does it
 * look plausible".
 *
 * This repository finds its own defects by measurement. D68 found a false
 * sentence by counting 58 files and 0 style rules; D69 found an inflated
 * number by comparing 7 against a measured 6; `lod.ts` found a feature that
 * could never fire by computing 6.81 against a ceiling of 6. Every one of
 * those was invisible to looking at the code.
 *
 * So the numbers this suite produces are written into the assertions rather
 * than described in a comment, and the two that decide whether a criterion
 * survives — §8.3's endpoint arrival rate with and without `distance`, and
 * §8.4's ranking margin — are measured against the real analyzer over a real
 * fixture repository, not against a graph shaped to agree with them.
 *
 * Nothing here needs an environment. `flow.ts` imports `./view` and
 * `@/qa/answer` and nothing else, so `src/lib/env.ts` — which validates 21
 * variables at import time and throws — is never on the path.
 */

// ---------------------------------------------------------------------------
// The env.ts trap, which has bitten this codebase five times
// ---------------------------------------------------------------------------

describe("importing the walk", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("needs no environment, on a machine that has none", async () => {
    /*
     * `src/lib/env.ts` validates 21 variables AT IMPORT TIME and throws, and
     * `@/db` and `@/lib/llm` both reach it transitively. A walk that could not
     * be imported without a database URL would be a walk nobody could test.
     *
     * Both halves are asserted, because only the second makes the first mean
     * anything: with the environment emptied, `env.ts` refuses and `flow.ts`
     * does not.
     */
    for (const key of Object.keys(process.env)) vi.stubEnv(key, undefined);

    await expect(import("@/lib/env")).rejects.toThrow(/Environment is not configured/);

    vi.resetModules();
    const fresh = await import("./flow");
    expect(typeof fresh.traceFlow).toBe("function");
    expect(fresh.MAX_FLOW_HOPS).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Hand-built graphs
// ---------------------------------------------------------------------------

const PROJECT = "flow-fixture";

function node(over: Partial<GraphNodeRow> & { id: string }): GraphNodeRow {
  return {
    type: "symbol",
    kind: "function",
    name: over.id,
    label: null,
    summary: null,
    filePath: `src/${over.id}.ts`,
    startLine: null,
    endLine: null,
    origin: "static",
    ...over,
  };
}

function edge(
  from: string,
  to: string,
  type: ConnectionRelation,
  over: Partial<GraphEdgeRow> = {},
): GraphEdgeRow {
  return {
    id: `${type}:${from}->${to}`,
    sourceNodeId: from,
    targetNodeId: to,
    type,
    confidence: "certain",
    ...over,
  };
}

function view(nodes: GraphNodeRow[], edges: GraphEdgeRow[]): GraphView {
  // Through `buildGraphView` rather than by hand, so `usedBy` — which is
  // ranking criterion 4 — is the number production computes under D69's rule,
  // not a number this test made up to agree with itself.
  return buildGraphView(PROJECT, nodes, edges, null);
}

/**
 * The shop shape, hand-built: an address, the file that answers for it, a
 * component, a helper, a server address and its handler.
 *
 * Deliberately the same skeleton as `src/analysis/__fixtures__/shop`, so a
 * failure here and a failure in the measured suite below point at the same
 * thing.
 */
function shopShape(): GraphView {
  return view(
    [
      node({ id: "f_page", type: "file", filePath: "src/app/checkout/page.tsx", kind: null }),
      node({ id: "r_checkout", type: "route", name: "/checkout", filePath: "src/app/checkout/page.tsx", kind: null }),
      node({ id: "s_page", name: "CheckoutPage", kind: "component", filePath: "src/app/checkout/page.tsx" }),
      node({ id: "f_pay", type: "file", filePath: "src/components/PayButton.tsx", kind: null }),
      node({ id: "s_pay", name: "PayButton", kind: "component", filePath: "src/components/PayButton.tsx" }),
      node({ id: "f_price", type: "file", filePath: "src/components/PriceTag.tsx", kind: null }),
      node({ id: "s_price", name: "PriceTag", kind: "component", filePath: "src/components/PriceTag.tsx" }),
      node({ id: "f_orders", type: "file", filePath: "src/lib/orders.ts", kind: null }),
      node({ id: "s_create", name: "createOrder", filePath: "src/lib/orders.ts" }),
      node({ id: "f_route", type: "file", filePath: "src/app/api/orders/route.ts", kind: null }),
      node({ id: "e_orders", type: "api_endpoint", name: "/api/orders", filePath: "src/app/api/orders/route.ts", kind: null }),
      node({ id: "s_post", name: "POST", filePath: "src/app/api/orders/route.ts" }),
      node({ id: "p_stripe", type: "package", name: "stripe", filePath: null, kind: null }),
    ],
    [
      edge("f_page", "r_checkout", "contains"),
      edge("f_page", "s_page", "contains"),
      edge("f_pay", "s_pay", "contains"),
      edge("f_price", "s_price", "contains"),
      edge("f_orders", "s_create", "contains"),
      edge("f_route", "e_orders", "contains"),
      edge("f_route", "s_post", "contains"),
      // The coarse-grained reach that must never become a hop.
      edge("f_page", "f_orders", "imports"),
      edge("f_orders", "p_stripe", "uses_package"),
      edge("s_page", "s_pay", "renders", { line: "18" }),
      edge("s_page", "s_price", "renders", { line: "17" }),
      edge("s_pay", "s_price", "renders", { line: "22" }),
      edge("s_pay", "s_create", "calls", { line: "34" }),
      edge("s_create", "e_orders", "fetches", { line: "9" }),
    ],
  );
}

const ids = (trace: FlowTrace): string[] => (trace.path?.hops ?? []).map((hop) => hop.toId);
const types = (events: readonly FlowEvent[]): FlowEventType[] => events.map((event) => event.type);

// ---------------------------------------------------------------------------
// §2.1 — the two joints. First, because it is the thing that would silently
// return "no path" on a repository that obviously has one.
// ---------------------------------------------------------------------------

describe("the entry joint", () => {
  it("gets a route moving at all, which a forward-only walk never would", () => {
    const graph = shopShape();

    // The fact that makes the joint necessary, asserted rather than assumed:
    // the route has no outgoing behaviour connection of its own. Every one of
    // them hangs off a symbol that is its SIBLING inside the same file.
    const outward = graph.connections.filter(
      (c) => c.from === "r_checkout" && HOP_RELATIONS.has(c.relation),
    );
    expect(outward).toEqual([]);

    const trace = traceFlow(graph, { startId: "r_checkout" });
    expect(trace.refusal).toBeNull();
    expect(ids(trace)).toEqual(["s_page", "s_pay", "s_create", "e_orders", "s_post"]);
  });

  it("is one hop from the address to the piece, with the file named in the sentence", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    const first = trace.path?.hops[0];

    expect(first?.joint).toBe("entry");
    expect(first?.fromId).toBe("r_checkout");
    expect(first?.toId).toBe("s_page");
    // The file is collapsed out of the path and named in the words instead.
    expect(first?.text).toBe("이 주소는 checkout/page.tsx 가 맡고 있어요");
    // Two segments, not one: every App Router route's file is called page.tsx.
    expect(first?.text).not.toContain("이 주소는 page.tsx");
    // A structural fact, said as one. Never "이 주소가 이걸 불러요".
    expect(first?.text).not.toContain("불러");
    expect(first?.line).toBeNull();
  });

  it("takes the server joint when the path arrives at an address", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    const joints = (trace.path?.hops ?? []).filter((hop) => hop.joint !== null);
    expect(joints.map((hop) => hop.joint)).toEqual(["entry", "server"]);
    expect(joints[1].fromId).toBe("e_orders");
    expect(joints[1].toId).toBe("s_post");
  });

  it("gets an endpoint moving when the endpoint is itself the start", () => {
    const trace = traceFlow(shopShape(), { startId: "e_orders" });
    expect(trace.path?.hops[0].joint).toBe("server");
    expect(ids(trace)).toEqual(["s_post"]);
  });

  it("reverses `contains` at those two places and nowhere else", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    for (const hop of trace.path?.hops ?? []) {
      if (hop.joint !== null) {
        expect(hop.relation).toBe("contains");
        continue;
      }
      // Rule 1 from `neighbourhood.ts`: a walk never changes direction.
      // Sidestepping between two symbols of one file would make them look
      // connected merely for sharing a file.
      expect(hop.relation).not.toBe("contains");
      expect(HOP_RELATIONS.has(hop.relation)).toBe(true);
    }
  });

  it("refuses rather than walking when an address's file holds nothing we read", () => {
    const graph = view(
      [
        node({ id: "f", type: "file", filePath: "src/app/page.tsx", kind: null }),
        node({ id: "r", type: "route", name: "/", filePath: "src/app/page.tsx", kind: null }),
        node({ id: "s", name: "Other", filePath: "src/other.ts" }),
        node({ id: "t", name: "Target", filePath: "src/other.ts" }),
      ],
      [edge("f", "r", "contains"), edge("s", "t", "calls")],
    );

    const trace = traceFlow(graph, { startId: "r" });
    expect(trace.refusal).toBe("nothing-leaves");
    expect(trace.path).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §2.2 — which relations are hops
// ---------------------------------------------------------------------------

describe("what a flow is allowed to walk", () => {
  it("never steps along an import, which is what makes everything reach everything", () => {
    const graph = shopShape();
    const trace = traceFlow(graph, { startId: "r_checkout" });
    for (const hop of trace.path?.hops ?? []) {
      expect(hop.relation).not.toBe("imports");
    }
  });

  it("annotates a hop with an outside tool and never puts one on the path", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    expect(ids(trace)).not.toContain("p_stripe");

    // File-grained on purpose: `analyzer.ts` writes `uses_package` from the
    // FILE, so `stripe` belongs to `src/lib/orders.ts`, not to `createOrder`.
    const onCreate = trace.path?.hops.find((hop) => hop.toId === "s_create");
    expect(onCreate?.packages).toEqual(["stripe"]);
    const onPay = trace.path?.hops.find((hop) => hop.toId === "s_pay");
    expect(onPay?.packages).toEqual([]);
  });

  it("never steps along a grouping we made ourselves", () => {
    const graph = view(
      [
        node({ id: "feat", type: "feature", name: "결제", filePath: null, kind: null }),
        node({ id: "a" }),
        node({ id: "b" }),
      ],
      [edge("a", "feat", "belongs_to"), edge("b", "feat", "belongs_to"), edge("a", "b", "calls")],
    );
    const trace = traceFlow(graph, { startId: "a" });
    expect(ids(trace)).toEqual(["b"]);
  });

  it("has no flows at all on a project the shallow analyzer read", () => {
    // Only `imports` and `uses_package`, which is exactly what the shallow
    // analyzer emits. A degraded flow wearing the same name would be D68's
    // failure; this is a refusal with a sentence.
    const graph = view(
      [
        node({ id: "f1", type: "file", filePath: "index.html", kind: null }),
        node({ id: "f2", type: "file", filePath: "app.js", kind: null }),
        node({ id: "r", type: "route", name: "/", filePath: "index.html", kind: null }),
      ],
      [edge("f1", "r", "contains"), edge("f1", "f2", "imports")],
    );
    const trace = traceFlow(graph, { startId: "r" });
    expect(trace.refusal).toBe("no-behaviour");
    expect(flowRefusalSentence("no-behaviour", { name: "/", kind: "route", imports: 57 })).toContain(
      "읽은 연결 57개",
    );
  });
});

// ---------------------------------------------------------------------------
// §2.3 — where a flow starts
// ---------------------------------------------------------------------------

describe("where a flow starts", () => {
  it("offers every address in the project, pages before server addresses", () => {
    const starts = projectEntryPoints(shopShape()).map((item) => item.name);
    expect(starts).toEqual(["/checkout", "/api/orders"]);
  });

  it("resolves a file to the pieces inside it, most outgoing behaviour first", () => {
    const graph = view(
      [
        node({ id: "f", type: "file", filePath: "src/lib/thing.ts", kind: null }),
        node({ id: "quiet", name: "quiet", filePath: "src/lib/thing.ts" }),
        node({ id: "busy", name: "busy", filePath: "src/lib/thing.ts" }),
        node({ id: "x" }),
        node({ id: "y" }),
      ],
      [
        edge("f", "quiet", "contains"),
        edge("f", "busy", "contains"),
        edge("busy", "x", "calls"),
        edge("busy", "y", "calls"),
        edge("quiet", "x", "calls"),
      ],
    );
    const resolved = entryPointsOf(graph, "f");
    expect(resolved.starts.map((item) => item.id)).toEqual(["busy", "quiet"]);

    // The walk begins at the piece; the file is not a place in a flow. The
    // rest are offered rather than picked silently.
    const trace = traceFlow(graph, { startId: "f" });
    expect(trace.selected?.id).toBe("f");
    expect(trace.start?.id).toBe("busy");
    expect(trace.otherStarts.map((item) => item.id)).toEqual(["quiet"]);
  });

  it("refuses a package and a feature, each with its own sentence", () => {
    const graph = shopShape();
    expect(entryPointsOf(graph, "p_stripe").refusal).toBe("not-a-start");
    expect(traceFlow(graph, { startId: "p_stripe" }).refusal).toBe("not-a-start");

    const forPackage = flowRefusalSentence("not-a-start", {
      name: "stripe",
      kind: "package",
      imports: 0,
    });
    expect(forPackage).toContain("밖에서 가져온 도구");
    const forFeature = flowRefusalSentence("not-a-start", {
      name: "결제",
      kind: "feature",
      imports: 0,
    });
    expect(forFeature).toContain("저희가 묶어 둔 이름");
  });

  it("says so rather than throwing when the id is not on the map", () => {
    const trace = traceFlow(shopShape(), { startId: "nope" });
    expect(trace.refusal).toBe("unknown-start");
    expect(types(trace.events)).toEqual(["flow.refused"]);
  });
});

// ---------------------------------------------------------------------------
// §2.4 — the ranking, one criterion at a time
// ---------------------------------------------------------------------------

describe("the ranking is lexicographic, and each criterion can be seen firing", () => {
  /** Two ways out of `a`, differing only in the criterion under test. */
  function fork(
    left: Partial<GraphEdgeRow>,
    right: Partial<GraphEdgeRow>,
    extra: { nodes?: GraphNodeRow[]; edges?: GraphEdgeRow[] } = {},
  ): GraphView {
    return view(
      [node({ id: "a" }), node({ id: "L", name: "L" }), node({ id: "R", name: "R" }), ...(extra.nodes ?? [])],
      [
        edge("a", "L", "calls", left),
        edge("a", "R", "calls", right),
        ...(extra.edges ?? []),
      ],
    );
  }

  it("1. prefers what the compiler resolved over what a heuristic guessed", () => {
    const graph = fork({ confidence: "inferred" }, { confidence: "certain" });
    expect(traceFlow(graph, { startId: "a" }).path?.hops[0].toId).toBe("R");
  });

  it("2. prefers the hop that gets closer to a server address", () => {
    const graph = view(
      [
        node({ id: "a" }),
        node({ id: "L", name: "L" }),
        node({ id: "R", name: "R" }),
        node({ id: "f", type: "file", filePath: "src/api/route.ts", kind: null }),
        node({ id: "end", type: "api_endpoint", name: "/api/x", filePath: "src/api/route.ts", kind: null }),
      ],
      [
        edge("a", "L", "calls"),
        edge("a", "R", "calls"),
        edge("f", "end", "contains"),
        edge("R", "end", "fetches"),
      ],
    );
    expect(traceFlow(graph, { startId: "a" }).path?.hops[0].toId).toBe("R");
    // Switching the criterion off does NOT change this answer, and that is
    // worth stating rather than hiding: on a fork this narrow the beam holds
    // both branches and the path ranking prefers the one that reached the
    // server anyway. The criterion earns its place further down, where the
    // frontier is wider than the beam — measured in §8.3 below.
  });

  it("3. reuses RELATION_RANK rather than defining a second order", () => {
    const graph = fork({ type: "calls" }, { type: "renders" });
    expect(RELATION_RANK.renders).toBeLessThan(RELATION_RANK.calls);
    expect(traceFlow(graph, { startId: "a" }).path?.hops[0].toId).toBe("R");
  });

  it("4. prefers this feature's spine over shared machinery", () => {
    // L is used in three places; R in one. A helper used everywhere is not
    // what this flow is about.
    const graph = fork(
      {},
      {},
      {
        nodes: [node({ id: "u1" }), node({ id: "u2" })],
        edges: [edge("u1", "L", "calls"), edge("u2", "L", "calls")],
      },
    );
    expect(traceFlow(graph, { startId: "a" }).path?.hops[0].toId).toBe("R");
  });

  it("5. falls back to the id, so two runs produce the same path", () => {
    const graph = fork({}, {});
    expect(traceFlow(graph, { startId: "a" }).path?.hops[0].toId).toBe("L");
  });

  it("is lexicographic: a later criterion never outvotes an earlier one", () => {
    /*
     * The failure a weighted sum would produce, written as a graph.
     *
     * `R` wins criteria 3, 4 and 5 outright — a `renders` edge, used nowhere
     * else, an id that sorts first. `L` wins only criterion 1. Under any
     * weighted sum where certainty does not dominate the other three put
     * together, `R` is chosen and a guess has been preferred to something the
     * compiler resolved. Under a lexicographic order it cannot happen, and
     * this test is the difference being enforced rather than described.
     */
    const graph = view(
      [node({ id: "a" }), node({ id: "L", name: "L" }), node({ id: "R", name: "R" }), node({ id: "u" })],
      [
        edge("a", "L", "calls", { confidence: "certain" }),
        edge("a", "R", "renders", { confidence: "inferred" }),
        edge("u", "L", "calls"),
      ],
    );
    expect(traceFlow(graph, { startId: "a" }).path?.hops[0].toId).toBe("L");
  });
});

// ---------------------------------------------------------------------------
// §2.5 / §2.6 — bounds, terminals, branches
// ---------------------------------------------------------------------------

/** s0 → s1 → … → sN, one call each. */
function chain(length: number): GraphView {
  const nodes = Array.from({ length }, (_, i) => node({ id: `s${i}`, name: `s${i}` }));
  const edges = Array.from({ length: length - 1 }, (_, i) => edge(`s${i}`, `s${i + 1}`, "calls"));
  return view(nodes, edges);
}

/** s0 → s1 → … → sN → s0. */
function ring(length: number): GraphView {
  const nodes = Array.from({ length }, (_, i) => node({ id: `s${i}`, name: `s${i}` }));
  const edges = Array.from({ length }, (_, i) =>
    edge(`s${i}`, `s${(i + 1) % length}`, "calls"),
  );
  return view(nodes, edges);
}

/**
 * A spine of forks, each `fanout` wide, with a server address behind the LAST
 * child at every level — the branch every other criterion pushes against.
 *
 * Built for §8.3, and for one question: at what branching factor does the
 * `distance` criterion start to matter. Every node in the live frontier gets
 * `fanout` children, so the frontier is `fanout²` at the first prune, and the
 * endpoint branch sorts last by id at every level.
 */
function fanOut(depth: number, fanout: number): GraphView {
  const nodes: GraphNodeRow[] = [node({ id: "root", name: "root" })];
  const edges: GraphEdgeRow[] = [];
  let layer = ["root"];
  let spine = "root";

  for (let level = 1; level <= depth; level += 1) {
    const born: string[] = [];
    for (const parent of layer) {
      for (let f = 0; f < fanout; f += 1) {
        const id = `${parent}_${f}`;
        nodes.push(node({ id, name: id }));
        edges.push(edge(parent, id, "calls"));
        born.push(id);
      }
    }
    layer = born.filter((id) => id.startsWith(`${spine}_`));
    spine = layer[layer.length - 1];
  }

  nodes.push(node({ id: "f_api", type: "file", filePath: "src/api/route.ts", kind: null }));
  nodes.push(
    node({ id: "end", type: "api_endpoint", name: "/api/x", filePath: "src/api/route.ts", kind: null }),
  );
  edges.push(edge("f_api", "end", "contains"));
  edges.push(edge(spine, "end", "fetches"));
  return view(nodes, edges);
}

/** Every symbol calls every other symbol. */
function complete(size: number): GraphView {
  const nodes = Array.from({ length: size }, (_, i) =>
    node({ id: `s${String(i).padStart(2, "0")}`, name: `s${i}` }),
  );
  const edges: GraphEdgeRow[] = [];
  for (const from of nodes) {
    for (const to of nodes) {
      if (from.id === to.id) continue;
      edges.push(edge(from.id, to.id, "calls"));
    }
  }
  return view(nodes, edges);
}

describe("the bounds", () => {
  it("stops at twelve hops and says which bound it hit", () => {
    const trace = traceFlow(chain(40), { startId: "s0" });
    expect(trace.path?.hops).toHaveLength(MAX_FLOW_HOPS);
    expect(trace.path?.terminal).toBe("bound");
    expect(trace.path?.text).toContain("열두 걸음까지 따라갔는데");
  });

  it("keeps at most BEAM live guesses, which is where the other paths come from", () => {
    const trace = traceFlow(complete(30), { startId: "s00" });
    expect(trace.alternatives.length).toBeLessThanOrEqual(BRANCHES_SHOWN);
    expect(trace.margin.found).toBeLessThanOrEqual(BEAM * (MAX_FLOW_HOPS + 1));
  });

  it("says how many other ways out there were at every single hop", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    const hops = trace.path?.hops ?? [];
    expect(hops.every((hop) => Number.isInteger(hop.branches) && hop.branches >= 0)).toBe(true);
    // CheckoutPage renders PayButton and PriceTag: one other way out.
    expect(hops.find((hop) => hop.fromId === "s_page")?.branches).toBe(1);
    expect(branchesNote(1)).toBe("여기서 갈라지는 다른 길이 1개 더 있어요.");
    expect(branchesNote(0)).toBe("여기서 갈라지는 다른 길은 없어요.");
  });
});

describe("the five terminals, each with its sentence", () => {
  it("reached a server address", () => {
    // The endpoint has no handler we read, so the walk stops on the address.
    const graph = view(
      [
        node({ id: "a" }),
        node({ id: "f", type: "file", filePath: "src/api/route.ts", kind: null }),
        node({ id: "end", type: "api_endpoint", name: "/api/x", filePath: "src/api/route.ts", kind: null }),
      ],
      [edge("f", "end", "contains"), edge("a", "end", "fetches")],
    );
    const trace = traceFlow(graph, { startId: "a" });
    expect(trace.path?.terminal).toBe("endpoint");
    expect(trace.path?.text).toBe("여기가 끝이에요 — 서버가 받는 곳까지 왔어요.");
  });

  it("reached a leaf, without ever saying the code does nothing", () => {
    const trace = traceFlow(chain(2), { startId: "s0" });
    expect(trace.path?.terminal).toBe("leaf");
    expect(trace.path?.text).toContain("저희가 읽어서 이어붙이지 못했다는 뜻이에요");
    expect(trace.path?.text).not.toContain("아무것도 안 해요");
  });

  it("handed off to an outside tool, and says which file brings it in", () => {
    const graph = view(
      [
        node({ id: "a" }),
        node({ id: "f", type: "file", filePath: "src/lib/pay.ts", kind: null }),
        node({ id: "b", name: "charge", filePath: "src/lib/pay.ts" }),
        node({ id: "p", type: "package", name: "stripe", filePath: null, kind: null }),
      ],
      [edge("f", "b", "contains"), edge("f", "p", "uses_package"), edge("a", "b", "calls")],
    );
    const trace = traceFlow(graph, { startId: "a" });
    expect(trace.path?.terminal).toBe("package");
    expect(trace.path?.text).toContain("`stripe` 쪽이 맡아요");
    // File-grained, because that is the grain the data has.
    expect(trace.path?.text).toContain("pay.ts 파일이 가져다 쓰는 도구예요");
    expect(trace.path?.text).toContain("그 안은 읽지 않아서");
  });

  it("hit the hop bound", () => {
    expect(
      flowTerminalSentence("bound", { hops: 12, address: null, back: null, file: null, pkg: null }),
    ).toContain("열두 걸음까지");
  });

  it("came back to somewhere it had been, and says that is a real fact", () => {
    const trace = traceFlow(ring(4), { startId: "s0" });
    expect(trace.path?.terminal).toBe("cycle");
    expect(ids(trace)).toEqual(["s1", "s2", "s3"]);
    expect(trace.path?.text).toContain("s0 쪽으로 다시 돌아가요");
    expect(trace.path?.text).toContain("돌고 도는 구조라는 뜻이에요");
  });

  it("never visits the same place twice", () => {
    const trace = traceFlow(ring(40), { startId: "s0" });
    const visited = ["s0", ...ids(trace)];
    expect(new Set(visited).size).toBe(visited.length);
  });
});

// ---------------------------------------------------------------------------
// §5 — the event shape
// ---------------------------------------------------------------------------

describe("the events", () => {
  it("carries the hop's own certainty and the weakest link, both", () => {
    const graph = view(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
      [
        edge("a", "b", "calls", { confidence: "inferred" }),
        edge("b", "c", "calls", { confidence: "certain" }),
      ],
    );
    const trace = traceFlow(graph, { startId: "a" });
    const hops = trace.path?.hops ?? [];

    expect(hops.map((hop) => hop.certainty)).toEqual(["inferred", "certain"]);
    // The label a user reads is the weakest link, not the last one. Reporting
    // the last hop would launder a guess into a fact at depth 2.
    expect(hops.map((hop) => hop.pathCertainty)).toEqual(["inferred", "inferred"]);
    expect(trace.path?.weakest).toBe("inferred");
  });

  it("says who wrote every sentence, and in Phase 0 that is always the arithmetic", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    for (const event of trace.events) {
      if (event.type !== "flow.hop") continue;
      expect(event.payload).toMatchObject({ narrator: "measured" });
    }
    // `flow.narrated` is declared and never emitted until Layer 2 is wired.
    expect(types(trace.events)).not.toContain("flow.narrated");
  });

  it("carries no source, ever — ids, a line number and one short sentence", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    const wire = JSON.stringify(trace.events);
    for (const forbidden of ["function", "return", "=>", "import ", "const "]) {
      expect(wire).not.toContain(forbidden);
    }
    for (const event of trace.events) {
      if (event.type !== "flow.hop") continue;
      expect(Object.keys(event.payload).sort()).toEqual([
        "branches",
        "certainty",
        "fromId",
        "index",
        "joint",
        "line",
        "narrator",
        "packages",
        "pathCertainty",
        "relation",
        "text",
        "toId",
      ]);
    }
  });

  it("carries the call-site line all the way from edges.metadata", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    const call = trace.path?.hops.find((hop) => hop.relation === "calls");
    expect(call?.line).toBe(34);
    expect(call?.text).toBe("사용해요 · PayButton.tsx 34줄");
  });

  it("returns the whole trace whether or not anyone is watching", () => {
    const graph = shopShape();
    const seen: { type: string }[] = [];
    const quiet = traceFlow(graph, { startId: "r_checkout" });
    const watched = traceFlow(graph, {
      startId: "r_checkout",
      onEvent: (type, payload) => seen.push({ type, ...payload }),
    });

    expect(JSON.stringify(quiet.events)).toBe(JSON.stringify(watched.events));
    expect(seen.map((event) => event.type)).toEqual(types(watched.events));
  });

  it("numbers events from one, in order", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    expect(trace.events.map((event) => event.seq)).toEqual(
      trace.events.map((_, i) => i + 1),
    );
    expect(types(trace.events)[0]).toBe("flow.started");
    expect(types(trace.events).at(-1)).toBe("flow.ended");
  });
});

// ---------------------------------------------------------------------------
// §7 — the refusals, written out
// ---------------------------------------------------------------------------

describe("the refusal sentences", () => {
  it("has one for a project with no address anywhere", () => {
    const graph = view([node({ id: "a" }), node({ id: "b" })], [edge("a", "b", "calls")]);
    expect(projectEntryPoints(graph)).toEqual([]);
    const sentence = flowRefusalSentence("no-entry-point", {
      name: "",
      kind: "file",
      imports: 0,
    });
    expect(sentence).toContain("아직 시작점을 찾지 못했어요");
    expect(sentence).toContain("파일을 하나 골라 주시면");
  });

  it("names the right kind of thing when nothing leaves the start", () => {
    // 페이지 takes 가, 조각 takes 이. Worked out from the syllable rather than
    // guessed, because the wrong particle is the first thing a reader notices.
    expect(
      flowRefusalSentence("nothing-leaves", { name: "/checkout", kind: "route", imports: 0 }),
    ).toContain("이 페이지가 아무 일도 안 한다는 뜻은 아니고");
    expect(
      flowRefusalSentence("nothing-leaves", { name: "PayButton", kind: "symbol", imports: 0 }),
    ).toContain("이 조각이 아무 일도 안 한다는 뜻은 아니고");
  });

  it("has the wildcard-address sentence, and fires it only on a guessed fetch", () => {
    const graph = view(
      [
        node({ id: "a" }),
        node({ id: "f", type: "file", filePath: "src/api/route.ts", kind: null }),
        node({ id: "end", type: "api_endpoint", name: "/api/orders/:id", filePath: "src/api/route.ts", kind: null }),
      ],
      [edge("f", "end", "contains"), edge("a", "end", "fetches", { confidence: "inferred" })],
    );
    const trace = traceFlow(graph, { startId: "a" });
    const note = trace.notes.find((entry) => entry.kind === "guessed-address");
    expect(note?.text).toBe(guessedAddressNote("/api/orders/:id"));
    expect(note?.hop).toBe(1);

    const sure = traceFlow(shopShape(), { startId: "r_checkout" });
    expect(sure.notes.some((entry) => entry.kind === "guessed-address")).toBe(false);
  });

  it("says the certainty summary once, over the whole path, as the weakest link", () => {
    const graph = view(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" }), node({ id: "d" }), node({ id: "e" })],
      [
        edge("a", "b", "calls"),
        edge("b", "c", "calls"),
        edge("c", "d", "calls", { confidence: "inferred" }),
        edge("d", "e", "calls"),
      ],
    );
    const trace = traceFlow(graph, { startId: "a" });
    const note = trace.notes.find((entry) => entry.kind === "certainty");
    expect(note?.text).toBe("이 길 네 걸음 중에 한 군데는 짐작이에요.");
    expect(certaintyNote(4, 1)).toBe("이 길 네 걸음 중에 한 군데는 짐작이에요.");
  });

  it("offers the alternatives sentence only when the top path is not clearly ahead", () => {
    expect(alternativesNote(3)).toBe(
      "이 길 말고도 비슷하게 그럴듯한 길이 3개 더 있어요. 아래에서 바꿔 볼 수 있어요.",
    );
    // A path that reaches the server is clearly ahead of one that does not, so
    // the sentence stays off rather than hedging a decision we actually made.
    const decisive = traceFlow(shopShape(), { startId: "r_checkout" });
    expect(decisive.margin.criterion).toBe("endpoint");
    expect(decisive.margin.close).toBe(false);
    expect(decisive.notes.some((note) => note.kind === "alternatives")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §8.8 — the vocabulary test
// ---------------------------------------------------------------------------

/** Every sentence this module can put in front of a person. */
function everySentence(traces: readonly FlowTrace[]): string[] {
  const said: string[] = [FLOW_NO_MODEL_NOTE, guessedAddressNote("/api/x"), alternativesNote(3)];

  for (const hops of [1, 4, 12]) said.push(certaintyNote(hops, 1), branchesNote(hops));

  const facts = { hops: 12, address: "/api/x", back: "Cart", file: "pay.ts", pkg: "stripe" };
  for (const terminal of ["endpoint", "leaf", "package", "bound", "cycle"] as const) {
    said.push(flowTerminalSentence(terminal, facts));
  }
  const kinds: ItemKind[] = ["file", "symbol", "route", "api_endpoint", "package", "feature"];
  for (const refusal of [
    "no-entry-point",
    "no-behaviour",
    "nothing-leaves",
    "not-a-start",
    "unknown-start",
  ] as const) {
    for (const kind of kinds) said.push(flowRefusalSentence(refusal, { name: "X", kind, imports: 57 }));
  }

  for (const trace of traces) {
    for (const hop of trace.path?.hops ?? []) said.push(hop.text);
    for (const alternative of [trace.path, ...trace.alternatives]) {
      if (alternative) said.push(alternative.text);
    }
    for (const note of trace.notes) said.push(note.text);
  }

  return said;
}

describe("the vocabulary", () => {
  it("extends the existing forbidden list rather than starting a second one", () => {
    // 안전 · 노드 · 엣지 come from `qa/answer.ts`; 실행 · 추적 · 실시간 are this
    // feature's own. Three copies of the first list already exist in this
    // codebase and a fourth would be the same drift under another name.
    expect(FLOW_FORBIDDEN_WORDS).toEqual(["안전", "노드", "엣지", "실행", "추적", "실시간"]);
  });

  it("says none of them, in any sentence, from any layer", () => {
    const traces = [
      traceFlow(shopShape(), { startId: "r_checkout" }),
      traceFlow(chain(40), { startId: "s0" }),
      traceFlow(ring(4), { startId: "s0" }),
      traceFlow(shopShape(), { startId: "p_stripe" }),
    ];
    for (const sentence of everySentence(traces)) {
      expect({ sentence, issues: flowSentenceIssues(sentence) }).toEqual({
        sentence,
        issues: [],
      });
    }
  });

  it("exempts exactly one string — the sentence that denies the thing", () => {
    /*
     * `FLOW_NOTICE` contains 실행, and that is the point: it is a DENIAL of
     * the reading of 실시간 트래킹 we refuse. A rule that banned the word from
     * the sentence saying we do not do it would have banned the honesty
     * rather than the claim.
     */
    expect(flowSentenceIssues(FLOW_NOTICE)).toEqual(["실행"]);
    expect(FLOW_NOTICE).toContain("앱을 실행해 보는 게 아니에요");
    expect(FLOW_NOTICE).toContain("실제로 지나간 길이 아니라");
  });

  it("phrases no hop in the past tense of execution", () => {
    const trace = traceFlow(shopShape(), { startId: "r_checkout" });
    for (const hop of trace.path?.hops ?? []) {
      for (const past of ["불렀", "했어요", "갔어요", "지나갔", "됐어요"]) {
        expect(hop.text).not.toContain(past);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The single ranking (§2.4 criterion 3), pinned across two files
// ---------------------------------------------------------------------------

describe("RELATION_RANK", () => {
  it("is the order the map actually sorts its lines into", () => {
    /*
     * `map/render/scene.ts` still declares a private copy of this table.
     * Rather than trust that the two agree, this measures the order
     * `buildLinks` really produces and compares it to the exported one — so
     * whichever copy someone edits, this fails.
     *
     * The layout is the smallest thing `buildLinks` reads: one placed item per
     * id, all in one district, so nothing is 'crossing' and the relation is
     * the only thing left to sort on.
     */
    const relations = Object.keys(RELATION_RANK) as ConnectionRelation[];
    const nodes = relations.map((relation) => node({ id: `t_${relation}`, name: relation }));
    nodes.push(node({ id: "src", name: "src" }));
    const graph = view(
      nodes,
      relations.map((relation) => edge("src", `t_${relation}`, relation)),
    );

    const placed = new Map(
      graph.items.map((item) => [item.id, { districtId: "one" }]),
    );
    const layout = { byItemId: placed } as unknown as Parameters<typeof buildLinks>[2];

    const drawn = buildLinks(graph.items, graph.connections, layout)
      .sort((a, b) => a.rank - b.rank)
      .map((link) => link.relation);

    const ours = [...relations].sort((a, b) => RELATION_RANK[a] - RELATION_RANK[b]);
    expect(drawn).toEqual(ours);
  });
});

// ---------------------------------------------------------------------------
// §8.6 — the pathological fixtures
// ---------------------------------------------------------------------------

describe("graphs nobody has measured", () => {
  /*
   * The largest graph measured anywhere in this codebase is the demo repo's
   * 68 items. These three are the shapes that would make an unbounded walk
   * hang, and the complete graph is the measured answer to "what happens when
   * everything reaches everything" — which §2.5 currently only argues.
   *
   * Every wall-clock ceiling here is deliberately generous. Four other agents
   * are running builds on the same machine, and a tight millisecond budget
   * fails for the wrong reason and teaches nobody anything.
   */
  const CEILING_MS = 5_000;

  it("a forty-node cycle terminates, inside budget", () => {
    const started = Date.now();
    const trace = traceFlow(ring(40), { startId: "s0" });
    expect(Date.now() - started).toBeLessThan(CEILING_MS);

    expect(trace.expansions).toBeLessThanOrEqual(MAX_EXPANSIONS);
    expect(trace.path?.hops).toHaveLength(MAX_FLOW_HOPS);
    // Measured, and worth saying out loud: a forty-node cycle hits the HOP
    // bound, not the cycle terminal, because twelve is less than forty. The
    // cycle terminal needs a loop shorter than `MAX_FLOW_HOPS`, which is what
    // the four-node ring above is for. A fixture that only tested the long
    // ring would have left the cycle sentence untested and looked thorough.
    expect(trace.path?.terminal).toBe("bound");
    expect(trace.expansions).toBe(MAX_FLOW_HOPS);
  });

  it("a forty-deep chain terminates, inside budget", () => {
    const started = Date.now();
    const trace = traceFlow(chain(40), { startId: "s0" });
    expect(Date.now() - started).toBeLessThan(CEILING_MS);

    expect(trace.expansions).toBe(MAX_FLOW_HOPS);
    expect(trace.path?.terminal).toBe("bound");
    expect(ids(trace)).toEqual(Array.from({ length: 12 }, (_, i) => `s${i + 1}`));
  });

  it("thirty symbols where everything calls everything terminates, and spends the budget", () => {
    const graph = complete(30);
    expect(graph.connections).toHaveLength(30 * 29);

    const started = Date.now();
    const trace = traceFlow(graph, { startId: "s00" });
    expect(Date.now() - started).toBeLessThan(CEILING_MS);

    // The budget is what stops this, and it is checked rather than assumed.
    // Without it: BEAM 4 × out-degree 29 × 12 depths is roughly 1,300
    // candidate hops, and on a real hairball the out-degree is the variable.
    expect(trace.expansions).toBeGreaterThan(MAX_EXPANSIONS - 30);
    expect(trace.expansions).toBeLessThanOrEqual(MAX_EXPANSIONS + 30);
    expect(trace.path?.terminal).toBe("bound");
    expect((trace.path?.hops ?? []).length).toBeLessThanOrEqual(MAX_FLOW_HOPS);

    // Still a simple path, and still the same one twice.
    const visited = ["s00", ...ids(trace)];
    expect(new Set(visited).size).toBe(visited.length);
    expect(ids(traceFlow(graph, { startId: "s00" }))).toEqual(ids(trace));
  });
});

// ---------------------------------------------------------------------------
// §8.2 / §8.3 / §8.4 / §8.5 — measured against the real analyzer
// ---------------------------------------------------------------------------

const NOTHING: AnalysisEmitter = {
  phase: () => {},
  fileParsed: () => {},
  nodes: () => {},
  edges: () => {},
  fileSkipped: () => {},
};

/**
 * The `shop` fixture through the real parser and the real `buildGraphView`.
 *
 * Not a hand-written graph: §8's whole point is that a fixture shaped to agree
 * with the algorithm proves nothing. This is the same tree `analyzer.test.ts`
 * measures, carried through the same id hashing and the same view builder the
 * product uses, so the numbers below are the numbers a user would get.
 */
async function measuredShop(): Promise<GraphView> {
  const fixture = materializeFixture("shop");
  try {
    const { nodes, edges } = await createTypescriptAnalyzer().analyze(
      fixture.files,
      fixture.root,
      NOTHING,
    );

    const id = (ref: NodeRef) => nodeId(PROJECT, ref);
    const nodeRows: GraphNodeRow[] = nodes.map((entry) => ({
      id: id(entry.ref),
      type: entry.ref.type as ItemKind,
      kind: entry.kind ?? null,
      name: entry.ref.name ?? entry.ref.filePath,
      label: null,
      summary: null,
      filePath: entry.ref.filePath === "" ? null : entry.ref.filePath,
      startLine: entry.startLine ?? null,
      endLine: entry.endLine ?? null,
      origin: "static",
    }));

    const edgeRows: GraphEdgeRow[] = edges
      .map((entry) => ({
        id: edgeId(PROJECT, entry.type, id(entry.source), id(entry.target)),
        sourceNodeId: id(entry.source),
        targetNodeId: id(entry.target),
        type: entry.type as ConnectionRelation,
        confidence: entry.confidence,
        // `load.ts` asks Postgres for `metadata->>'line'`, which comes back as
        // text or null. Doing the same conversion here keeps this test on the
        // path the product actually takes, rather than on a row shape the
        // query stopped returning.
        line: jsonLine(entry.metadata),
      }))
      // The order `load.ts` hands the view builder, so this test sees the
      // array the product sees.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    return buildGraphView(PROJECT, nodeRows, edgeRows, null);
  } finally {
    fixture.cleanup();
  }
}

function named(graph: FlowGraph, name: string): string {
  const found = graph.items.find((item) => item.name === name);
  if (!found) throw new Error(`no item called ${name}`);
  return found.id;
}

describe("measured on the shop fixture, through the real parser", () => {
  it("§8.2 — every address in the project produces a path", async () => {
    const graph = await measuredShop();
    const index = indexFlowGraph(graph);
    const starts = projectEntryPoints(graph);

    /*
     * The fixture as numbers, so a change to it fails here loudly — and
     * because §11.9 is right that the recorded counts for the demo repository
     * predate `fetches` and nobody has re-measured them. This is not that
     * repository, but it is the tree the parser suite measures, and a flow
     * feature with no measured edge counts anywhere would repeat the mistake.
     */
    const counted: Record<string, number> = {};
    for (const connection of graph.connections) {
      counted[connection.relation] = (counted[connection.relation] ?? 0) + 1;
    }
    expect({ items: graph.items.length, connections: graph.connections.length }).toEqual({
      items: 49,
      connections: 63,
    });
    expect(counted).toEqual({
      contains: 27,
      imports: 15,
      calls: 10,
      renders: 5,
      uses_package: 5,
      fetches: 1,
    });
    expect(graph.connections.filter((c) => c.certainty === "inferred")).toHaveLength(2);

    expect(starts.map((item) => item.name)).toEqual(["/", "/checkout", "/api/orders"]);

    const covered = starts.filter(
      (start) => traceFlow(graph, { startId: start.id, index }).path !== null,
    );
    // 3 of 3. A fraction below 1 here is the joint rule being wrong, not the
    // repository being odd — which is the whole reason this is measured per
    // address rather than once for the project.
    expect(covered).toHaveLength(starts.length);
    expect(covered).toHaveLength(3);
  });

  it("§8.3 — on this fixture the distance criterion changes nothing at all", async () => {
    const graph = await measuredShop();
    const index = indexFlowGraph(graph);
    const routes = projectEntryPoints(graph).filter((item) => item.kind === "route");
    expect(routes).toHaveLength(2);

    const walk = (ignore: HopCriterion[]) =>
      routes.map((start) => traceFlow(graph, { startId: start.id, index, ignore }));
    const arrivals = (traces: FlowTrace[]) =>
      traces.filter((trace) => trace.path?.reachedEndpoint).length;

    const withIt = walk([]);
    const withoutIt = walk(["distance"]);

    /*
     * Measured, and it is not the result the design document expects.
     *
     * 1 of 2 routes reach a server address WITH the criterion, and 1 of 2
     * WITHOUT it. `/` cannot reach one at all — nothing on the home page
     * fetches — so 1/2 is this fixture's ceiling and both settings hit it. The
     * chosen paths are not merely equivalent, they are byte-identical.
     *
     * The reason is the fixture, not the criterion. The deciding fork is
     * `PayButton`, which leaves by four connections; `BEAM = 4` holds every
     * one of them, so the branch that crosses to the server survives to the
     * end whatever order the candidates were in, and the PATH ranking — which
     * prefers a path that reached the server — then picks it. On a graph this
     * narrow the beam is doing the work.
     *
     * §8.3 says a criterion that does not move a number is decoration and
     * comes out. Taken on this fixture alone that would have deleted it. The
     * next test is why it does not.
     */
    expect(arrivals(withIt)).toBe(1);
    expect(arrivals(withoutIt)).toBe(1);
    expect(JSON.stringify(withoutIt.map(ids))).toBe(JSON.stringify(withIt.map(ids)));

    // The number this fixture cannot stress, recorded so the next reader knows
    // what it did and did not prove: the widest fork in it is four.
    const degree = new Map<string, number>();
    for (const connection of graph.connections) {
      if (!HOP_RELATIONS.has(connection.relation)) continue;
      degree.set(connection.from, (degree.get(connection.from) ?? 0) + 1);
    }
    expect(Math.max(...degree.values())).toBe(4);
  });

  it("§8.3 — and it is the whole story as soon as a fork is wider than the beam", () => {
    /*
     * The same measurement on a graph built to have the property the shop
     * fixture lacks: a frontier wider than `BEAM`.
     *
     * At every level the endpoint branch is the last child by id, so every
     * other criterion — relation, `usedBy`, id — pushes against it. With the
     * distance criterion the walk reaches the server; without it the beam cuts
     * that branch at the first prune and never recovers.
     *
     * Measured across fan-out 2, 3, 4, 5, 6, 8, 12 at depths 2, 3, 4, 6 and 8:
     * the number does not move at fan-out 2, and moves at every single one of
     * the thirty combinations from fan-out 3 upward.
     *
     * So criterion 2 stays, and what it buys is now a measured statement
     * rather than an argument: it makes the endpoint arrival rate independent
     * of `BEAM`. Deleting it on the strength of the shop fixture would have
     * broken every project whose components fork more than four ways, which is
     * most of them.
     */
    const reaches = (graph: GraphView, ignore: HopCriterion[]) =>
      traceFlow(graph, { startId: "root", ignore }).path?.reachedEndpoint === true;

    const moved: string[] = [];
    const held: string[] = [];
    for (const fanout of [2, 3, 4, 5, 6, 8, 12]) {
      for (const depth of [2, 3, 4, 6, 8]) {
        const graph = fanOut(depth, fanout);
        const label = `${fanout}x${depth}`;
        if (reaches(graph, []) === reaches(graph, ["distance"])) held.push(label);
        else moved.push(label);
      }
    }

    expect(held).toEqual(["2x2", "2x3", "2x4", "2x6", "2x8"]);
    expect(moved).toHaveLength(30);
    // The direction, not just the difference: with the criterion it arrives.
    expect(reaches(fanOut(4, 6), [])).toBe(true);
    expect(reaches(fanOut(4, 6), ["distance"])).toBe(false);
    // And the fan-out at which it starts to matter is the beam width, which is
    // the mechanism rather than a coincidence: frontier = fanout², pruned to 4.
    expect(BEAM).toBe(4);
  });

  it("§8.3 — and the path it picks is the one a person would give", async () => {
    const graph = await measuredShop();
    const trace = traceFlow(graph, { startId: named(graph, "/checkout") });
    const walked = (trace.path?.hops ?? []).map(
      (hop) => graph.items.find((item) => item.id === hop.toId)?.name,
    );

    // /checkout → CheckoutPage → PayButton → createOrder → /api/orders → POST.
    // `createOrder`'s call from PayButton's click handler is the edge D57
    // recovered on the real demo repo; without that fix this path stops one
    // hop short and the feature's flagship answer is wrong.
    expect(walked).toEqual([
      "CheckoutPage",
      "PayButton",
      "createOrder",
      "/api/orders",
      "POST",
    ]);
    expect(trace.path?.reachedEndpoint).toBe(true);
    expect(trace.path?.weakest).toBe("certain");
  });

  it("§8.4 — the ranking margin, and where the 'several paths' threshold comes from", async () => {
    const graph = await measuredShop();
    const index = indexFlowGraph(graph);

    const measured = projectEntryPoints(graph).map((start) => {
      const trace = traceFlow(graph, { startId: start.id, index });
      return {
        start: start.name,
        complete: trace.margin.found,
        criterion: trace.margin.criterion,
        gap: trace.margin.gap,
        close: trace.margin.close,
      };
    });

    /*
     * Measured, and written out rather than summarised.
     *
     * The threshold is not a constant anywhere in `flow.ts`: a lexicographic
     * ranking has no scalar score to threshold, which is most of why it was
     * chosen over a weighted sum. "Close" is defined by WHICH criterion
     * separated the top two, and on this fixture all three starts are decided
     * by the length — one hop, every time — so none of them says "비슷한 길이
     * 여러 개 있어요".
     *
     * `/checkout` is the one worth reading twice. Six complete paths, and the
     * top two both reach the server: `… → /api/orders → POST` at five hops and
     * `… → /api/orders → GET → formatCount` at six. The margin is the length,
     * and the shorter one happens to be the handler the `fetch` actually
     * names — which we do not know, because the parser records no HTTP method.
     * Getting the right answer for a reason we cannot state is why the branch
     * count is said out loud at that hop.
     */
    expect(measured).toEqual([
      { start: "/", complete: 2, criterion: "length", gap: 1, close: false },
      { start: "/checkout", complete: 6, criterion: "length", gap: 1, close: false },
      { start: "/api/orders", complete: 2, criterion: "length", gap: 1, close: false },
    ]);

    // And the case the sentence exists for: two paths the ranking can only
    // separate on a hop-level tiebreak.
    const twins = view(
      [node({ id: "a" }), node({ id: "L", name: "L" }), node({ id: "R", name: "R" })],
      [edge("a", "L", "calls"), edge("a", "R", "calls")],
    );
    const trace = traceFlow(twins, { startId: "a" });
    expect(trace.margin.criterion).toBe("steps");
    expect(trace.margin.close).toBe(true);
    expect(trace.notes.some((note) => note.kind === "alternatives")).toBe(true);
  });

  it("§8.5 — two walks over an unchanged graph are byte-identical", async () => {
    const graph = await measuredShop();
    const start = named(graph, "/checkout");

    const first = traceFlow(graph, { startId: start });
    const second = traceFlow(graph, { startId: start });

    // Paths, events, branch lists and note order, all of it.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // And the same answer when the connections arrive in a different order,
    // which is the promise `load.ts` makes about its own output: every list in
    // here is given a total order, so nothing depends on how the rows landed.
    const shuffled: FlowGraph = {
      items: [...graph.items].reverse(),
      connections: [...graph.connections].reverse(),
    };
    expect(JSON.stringify(traceFlow(shuffled, { startId: start }))).toBe(
      JSON.stringify(first),
    );
  });

  it("§11.1 — the call-site line survives the whole trip from the parser", async () => {
    const graph = await measuredShop();

    const withLine = graph.connections.filter((c) => c.line !== undefined);
    const behaviour = graph.connections.filter((c) => HOP_RELATIONS.has(c.relation));
    // Every `calls`, `renders` and `fetches` edge the parser wrote carries one.
    expect(withLine).toHaveLength(behaviour.length);
    // And nothing else does — `imports` and `contains` have no call site.
    expect(withLine.every((c) => HOP_RELATIONS.has(c.relation))).toBe(true);

    const trace = traceFlow(graph, { startId: named(graph, "/checkout") });
    const lines = (trace.path?.hops ?? []).map((hop) => hop.line);
    // Null on the two joints, a real line on the three behaviour hops.
    expect(lines.filter((line) => line === null)).toHaveLength(2);
    expect(lines.filter((line) => typeof line === "number" && line > 0)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// A type declaration is not a place where anything happens
// ---------------------------------------------------------------------------

describe("the entry joint's targets", () => {
  /**
   * Found on this repository's own graph, not in a fixture.
   *
   * `/app/:projectId` ranked six complete paths and the winner was
   * `ProjectPageProps` — a React prop type — at one hop, beating
   * `ProjectPage → Workspace → HistoryBand → RereadButton → RefreshMark` on
   * the `length` criterion with a gap of 2. Neither path reaches a server, so
   * `endpoint` and `terminal` tie and shortest wins, and the shortest thing a
   * file holds is always the declaration that does nothing.
   *
   * The ranking was behaving exactly as specified. The fault was upstream: a
   * `type` has no runtime behaviour, so it can only ever be a dead end, and
   * the first hop of a flow is the worst place to spend on one.
   */
  function pageWithAPropType(): GraphView {
    return view(
      [
        node({ id: "route", type: "route", name: "/app/:projectId", kind: null }),
        node({ id: "page.tsx", type: "file", name: "page.tsx", kind: null }),
        // Declared first and sorting first, so the test fails for the right
        // reason if the filter is removed rather than by luck of ordering.
        node({ id: "PageProps", kind: "type", name: "PageProps" }),
        node({ id: "Page", kind: "component", name: "Page" }),
        // In its own file. A sibling of `Page` would be offered by the joint
        // on its own merits and win on length, which is the ranking working
        // and would make this test pass for a reason it is not about.
        node({ id: "workspace.tsx", type: "file", name: "workspace.tsx", kind: null }),
        node({ id: "Workspace", kind: "component", name: "Workspace" }),
      ],
      [
        edge("page.tsx", "route", "contains"),
        edge("page.tsx", "PageProps", "contains"),
        edge("page.tsx", "Page", "contains"),
        edge("workspace.tsx", "Workspace", "contains"),
        edge("Page", "Workspace", "renders"),
      ],
    );
  }

  it("never starts a flow on a type declaration", () => {
    const graph = pageWithAPropType();
    const trace = traceFlow(graph, { startId: "route" });

    expect(trace.path).not.toBeNull();
    expect(ids(trace)).toEqual(["Page", "Workspace"]);
    // Not merely un-ranked: it must not be reachable as a start at all, or it
    // comes back the moment two real paths tie.
    expect([trace.path, ...trace.alternatives].flatMap((path) => path?.hops ?? [])
      .map((hop) => hop.toId)).not.toContain("PageProps");
  });

  it("leaves a type out of the choices a file offers, too", () => {
    // `entryPointsIn` and `jointTargets` ask the same map the same question,
    // which is why the filter lives in the index rather than at either one.
    const starts = entryPointsOf(pageWithAPropType(), "page.tsx").starts;
    expect(starts.map((item) => item.id)).not.toContain("PageProps");
    expect(starts.map((item) => item.id)).toContain("Page");
  });
});

/**
 * What `metadata->>'line'` returns: the value as text, or null when the key is
 * absent or the object is. Postgres's `->>`  does not care what type the value
 * had, which is exactly why `load.ts` reads it as text and checks it itself.
 */
function jsonLine(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const line = (metadata as Record<string, unknown>).line;
  return line === undefined || line === null ? null : String(line);
}
