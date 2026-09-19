import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  Certainty,
  ConnectionRelation,
  GraphConnection,
  GraphItem,
  GraphView,
} from "@/lib/graph/view";

import { RightPanel, type RightPanelProps } from "./connections-panel";
import {
  DEFAULT_HOPS,
  MAX_HOPS,
  MIN_HOPS,
  buildNeighbourhood,
  isAlone,
  type NeighbourhoodInput,
} from "./neighbourhood";
import type { RunProgress } from "./states";

/**
 * These tests are about honesty, not about plumbing. Each one pins a way the
 * panel could show someone a confident sentence about their own code that is
 * not true: a guess promoted to a fact at two hops, two things joined because
 * they happen to share a neighbour, or a list that stops at the cap without
 * saying so.
 */

function item(id: string, overrides: Partial<GraphItem> = {}): GraphItem {
  return {
    id,
    kind: "symbol",
    shape: "function",
    name: id,
    label: null,
    summary: null,
    path: `src/${id}.ts`,
    startLine: 1,
    endLine: 10,
    fromUser: false,
    usedBy: 0,
    uses: 0,
    ...overrides,
  };
}

function link(
  from: string,
  to: string,
  relation: ConnectionRelation = "calls",
  certainty: Certainty = "certain",
): GraphConnection {
  return { id: `${from}->${to}:${relation}`, from, to, relation, certainty };
}

function graph(items: GraphItem[], connections: GraphConnection[]): NeighbourhoodInput {
  return { items, connections };
}

describe("buildNeighbourhood", () => {
  it("splits one hop into what this uses and what uses this", () => {
    const view = graph(
      [item("page"), item("button"), item("format")],
      [link("page", "button", "renders"), link("button", "format", "calls")],
    );

    const around = buildNeighbourhood(view, "button");

    expect(around).not.toBeNull();
    expect(around?.uses.map((n) => n.item.id)).toEqual(["format"]);
    expect(around?.usedBy.map((n) => n.item.id)).toEqual(["page"]);
    expect(around?.uses[0].relation).toBe("calls");
    expect(around?.usedBy[0].relation).toBe("renders");
    expect(around?.uses[0].via).toBeNull();
  });

  it("returns null for an id that is not on the map", () => {
    const view = graph([item("a")], []);
    expect(buildNeighbourhood(view, "nope")).toBeNull();
  });

  it("never lists the selection as its own neighbour", () => {
    // Self-calls exist in the wild (DECISIONS D32 drops them at parse time),
    // so the panel must survive one arriving anyway.
    const view = graph([item("a")], [link("a", "a")]);
    const around = buildNeighbourhood(view, "a");

    expect(around?.uses).toEqual([]);
    expect(around?.usedBy).toEqual([]);
    expect(isAlone(around!)).toBe(true);
  });

  it("ignores a connection pointing at something that is not on the map", () => {
    const view = graph([item("a")], [link("a", "ghost")]);
    expect(buildNeighbourhood(view, "a")?.uses).toEqual([]);
  });

  describe("depth", () => {
    const view = graph(
      [item("a"), item("b"), item("c"), item("d")],
      [link("a", "b"), link("b", "c"), link("c", "d")],
    );

    it("stops at one hop by default", () => {
      expect(buildNeighbourhood(view, "a")?.uses.map((n) => n.item.id)).toEqual(["b"]);
    });

    it("reaches two hops and names what it went through", () => {
      const around = buildNeighbourhood(view, "a", { hops: 2 });

      expect(around?.uses.map((n) => n.item.id)).toEqual(["b", "c"]);
      const second = around?.uses.find((n) => n.item.id === "c");
      expect(second?.hops).toBe(2);
      expect(second?.via?.id).toBe("b");
    });

    it("reaches three hops", () => {
      expect(buildNeighbourhood(view, "a", { hops: 3 })?.uses).toHaveLength(3);
    });

    it("clamps a depth outside the range rather than walking the whole graph", () => {
      // Against the constants, not a literal. The ceiling moved from 3 to 6
      // when the control became a number someone types, and a hardcoded 3 here
      // would have failed for the wrong reason — it was testing the old UI, not
      // the clamp.
      expect(buildNeighbourhood(view, "a", { hops: 99 })?.hops).toBe(MAX_HOPS);
      expect(buildNeighbourhood(view, "a", { hops: 0 })?.hops).toBe(MIN_HOPS);
      expect(buildNeighbourhood(view, "a", { hops: Number.NaN })?.hops).toBe(DEFAULT_HOPS);
    });

    it("does not turn around mid-walk", () => {
      // a -> b and c -> b. `a` and `c` share a neighbour and nothing else.
      // Saying they are connected would be a claim about code that is not
      // there, and the user has no way to check it.
      const shared = graph([item("a"), item("b"), item("c")], [link("a", "b"), link("c", "b")]);
      const around = buildNeighbourhood(shared, "a", { hops: 3 });

      expect(around?.uses.map((n) => n.item.id)).toEqual(["b"]);
      expect(around?.usedBy).toEqual([]);
    });
  });

  describe("certainty", () => {
    it("carries each hop's own certainty at one hop", () => {
      const view = graph(
        [item("a"), item("sure"), item("guess")],
        [link("a", "sure", "calls", "certain"), link("a", "guess", "calls", "inferred")],
      );
      const around = buildNeighbourhood(view, "a");

      expect(around?.uses.find((n) => n.item.id === "sure")?.certainty).toBe("certain");
      expect(around?.uses.find((n) => n.item.id === "guess")?.certainty).toBe("inferred");
    });

    it("reports the weakest link on a two hop path, not the last one", () => {
      const view = graph(
        [item("a"), item("b"), item("c")],
        [link("a", "b", "calls", "inferred"), link("b", "c", "calls", "certain")],
      );
      const around = buildNeighbourhood(view, "a", { hops: 2 });
      const far = around?.uses.find((n) => n.item.id === "c");

      // The path is a guess even though the far hop is resolved.
      expect(far?.certainty).toBe("inferred");
      // The far hop keeps its own value, because the graph tab draws that one
      // line on its own merits.
      expect(far?.hopCertainty).toBe("certain");
    });

    it("prefers the certain path when two paths of the same length reach one item", () => {
      const view = graph(
        [item("a"), item("viaGuess"), item("viaSure"), item("target")],
        [
          link("a", "viaGuess", "calls", "inferred"),
          link("viaGuess", "target", "calls", "certain"),
          link("a", "viaSure", "calls", "certain"),
          link("viaSure", "target", "calls", "certain"),
        ],
      );
      const around = buildNeighbourhood(view, "a", { hops: 2 });
      const target = around?.uses.filter((n) => n.item.id === "target");

      expect(target).toHaveLength(1);
      expect(target?.[0].certainty).toBe("certain");
      expect(target?.[0].via?.id).toBe("viaSure");
    });
  });

  it("lists an item reachable by two paths once, at the shorter distance", () => {
    const view = graph(
      [item("a"), item("b"), item("c")],
      [link("a", "c"), link("a", "b"), link("b", "c")],
    );
    const around = buildNeighbourhood(view, "a", { hops: 3 });
    const hits = around?.uses.filter((n) => n.item.id === "c") ?? [];

    expect(hits).toHaveLength(1);
    expect(hits[0].hops).toBe(1);
  });

  it("lists an item in both directions when it both uses and is used by the selection", () => {
    const view = graph([item("a"), item("b")], [link("a", "b"), link("b", "a")]);
    const around = buildNeighbourhood(view, "a");

    expect(around?.uses.map((n) => n.item.id)).toEqual(["b"]);
    expect(around?.usedBy.map((n) => n.item.id)).toEqual(["b"]);
  });

  describe("a hub with more connections than fit", () => {
    // 60 callers and 5 callees: a shared helper on a real repo.
    const callers = Array.from({ length: 60 }, (_, index) =>
      item(`caller-${String(index).padStart(2, "0")}`),
    );
    const callees = Array.from({ length: 5 }, (_, index) => item(`callee-${index}`));
    const hub = graph(
      [item("hub", { usedBy: 60, uses: 5 }), ...callers, ...callees],
      [
        ...callers.map((caller) => link(caller.id, "hub")),
        ...callees.map((callee) => link("hub", callee.id)),
      ],
    );

    it("caps each direction and says exactly how many it left out", () => {
      const around = buildNeighbourhood(hub, "hub", { limit: 24 });

      expect(around?.usedBy).toHaveLength(24);
      expect(around?.found.usedBy).toBe(60);
      expect(around?.hidden.usedBy).toBe(36);
    });

    it("does not let a crowded direction push out a quiet one", () => {
      // The five things the hub uses are the answer to "what does this touch",
      // and a shared total would have buried them under sixty callers.
      const around = buildNeighbourhood(hub, "hub", { limit: 24 });

      expect(around?.uses).toHaveLength(5);
      expect(around?.hidden.uses).toBe(0);
    });

    it("reports nothing hidden when everything fits", () => {
      const around = buildNeighbourhood(hub, "hub", { limit: 100 });

      expect(around?.hidden).toEqual({ uses: 0, usedBy: 0 });
      expect(around?.usedBy).toHaveLength(60);
    });
  });

  describe("ordering", () => {
    it("puts nearer first, then certain, then the busiest", () => {
      const view = graph(
        [
          item("a"),
          item("quiet", { uses: 0, usedBy: 0 }),
          item("busy", { uses: 9, usedBy: 9 }),
          item("guessed", { uses: 40, usedBy: 40 }),
          item("far"),
        ],
        [
          link("a", "quiet"),
          link("a", "busy"),
          link("a", "guessed", "calls", "inferred"),
          link("busy", "far"),
        ],
      );
      const around = buildNeighbourhood(view, "a", { hops: 2 });

      expect(around?.uses.map((n) => n.item.id)).toEqual(["busy", "quiet", "guessed", "far"]);
    });

    it("is stable across repeated builds and across input order", () => {
      const items = [item("a"), item("x"), item("y"), item("z")];
      const links = [link("a", "x"), link("a", "y"), link("a", "z")];
      const forwards = buildNeighbourhood(graph(items, links), "a");
      const backwards = buildNeighbourhood(graph([...items].reverse(), [...links].reverse()), "a");

      expect(forwards?.uses.map((n) => n.item.id)).toEqual(["x", "y", "z"]);
      expect(backwards?.uses.map((n) => n.item.id)).toEqual(["x", "y", "z"]);
    });
  });

  describe("counting the places that use something", () => {
    const view = graph(
      [
        item("button"),
        item("home", { kind: "route", name: "/" }),
        item("checkout", { kind: "route", name: "/checkout" }),
        item("panel"),
        item("buttonFile", { kind: "file", name: "Button.tsx" }),
      ],
      [
        link("home", "button", "renders"),
        link("checkout", "button", "renders"),
        link("panel", "button", "renders"),
        link("buttonFile", "button", "contains"),
      ],
    );

    it("does not count the file a thing lives in as a place that uses it", () => {
      const around = buildNeighbourhood(view, "button");

      expect(around?.usedBy).toHaveLength(4);
      expect(around?.reach).toEqual({ places: 3, pages: 2 });
    });

    it("counts every place, including the ones the cap left off the screen", () => {
      // The headline said 2 while the list below it said 3 were hidden. A
      // smaller number than the truth, in the one sentence the product is sold
      // on, is worse than no number.
      const around = buildNeighbourhood(view, "button", { limit: 2 });

      expect(around?.usedBy).toHaveLength(2);
      expect(around?.reach.places).toBe(3);
    });
  });

  describe("a static site, where files only import each other", () => {
    // David's own portfolio: 58 files, 57 links, all `imports`, no symbols at
    // all. The panel has to read well here or it reads well nowhere.
    const view = graph(
      [
        item("index", { kind: "file", name: "index.html", shape: null }),
        item("style", { kind: "file", name: "assets/style.css", shape: null }),
        item("main", { kind: "file", name: "assets/main.js", shape: null }),
        item("about", { kind: "file", name: "about.html", shape: null }),
      ],
      [
        link("index", "style", "imports"),
        link("index", "main", "imports"),
        link("about", "style", "imports"),
      ],
    );

    it("answers what a page pulls in", () => {
      const around = buildNeighbourhood(view, "index");

      expect(around?.uses.map((n) => n.item.name)).toEqual(["assets/main.js", "assets/style.css"]);
      expect(around?.uses.every((n) => n.relation === "imports")).toBe(true);
      expect(around?.usedBy).toEqual([]);
    });

    it("answers which pages pull in one stylesheet", () => {
      const around = buildNeighbourhood(view, "style");

      expect(around?.usedBy.map((n) => n.item.name)).toEqual(["about.html", "index.html"]);
      expect(around?.reach.places).toBe(2);
    });

    it("knows when it found nothing, which is not the same as nothing existing", () => {
      const orphan = graph([item("lonely", { kind: "file" })], []);
      const around = buildNeighbourhood(orphan, "lonely");

      expect(isAlone(around!)).toBe(true);
      expect(around?.found).toEqual({ uses: 0, usedBy: 0 });
    });
  });
});

/* ------------------------------------------------------------- the panel */

/**
 * The panel rendered to static HTML.
 *
 * Not a substitute for looking at it, and it cannot see focus, IME or layout.
 * What it is for is the promises: that the cap says what it hid, that an
 * absence of knowledge is reported as an absence of knowledge, and that the
 * word 안전 never reaches the screen. D68 is the precedent — a sentence the
 * product could not back got as far as the founder's own site, and a test is
 * what keeps it from coming back.
 */

function asView(items: GraphItem[], connections: GraphConnection[]): GraphView {
  return {
    projectId: "project-1",
    items,
    connections,
    lastRun: {
      id: "run-1",
      status: "completed",
      finishedAt: "2026-09-19T00:00:00.000Z",
      filesParsed: items.length,
      filesSkipped: [],
      error: null,
    },
  };
}

function render(overrides: Partial<RightPanelProps>): string {
  return renderToStaticMarkup(
    createElement(RightPanel, {
      view: null,
      selectedId: null,
      locks: {},
      onLockChange: () => {},
      onSelect: () => {},
      ...overrides,
    }),
  );
}

/** Tag text only. Class names carry the word "edge", and nobody reads those. */
function words(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const demoView = asView(
  [
    item("file", { kind: "file", name: "app/checkout/page.jsx", shape: null, uses: 3, usedBy: 1 }),
    item("PayButton", { shape: "component", usedBy: 2, uses: 2 }),
    item("formatPrice", { shape: "function", usedBy: 4 }),
    item("home", { kind: "route", name: "/", usedBy: 0, uses: 1 }),
    item("createOrder", { shape: "function", usedBy: 1 }),
  ],
  [
    link("file", "PayButton", "contains"),
    link("file", "formatPrice", "imports"),
    link("PayButton", "createOrder", "calls"),
    link("PayButton", "formatPrice", "calls", "inferred"),
    link("home", "PayButton", "renders"),
  ],
);

describe("the right panel", () => {
  it("names each connection with the words the contract chose", () => {
    const text = words(render({ view: demoView, selectedId: "PayButton" }));

    expect(text).toContain("이 안에 있어요"); // the file it lives in
    expect(text).toContain("사용해요"); // what it calls
    expect(text).toContain("여기에 그려져요"); // the page that renders it
    expect(text).toContain("확실해요");
    expect(text).toContain("짐작이에요");
  });

  it("does not file the home of something under the places that use it", () => {
    const text = words(render({ view: demoView, selectedId: "PayButton" }));

    // "여기가 있는 곳" holds the file, "여기를 쓰는 곳" holds the page. Putting
    // the first under the second would have the heading and the row saying
    // different things about the same link.
    expect(text).toMatch(/여기가 있는 곳 1 app\/checkout\/page\.jsx 이 안에 있어요/);
    expect(text).toMatch(/여기를 쓰는 곳 1 \/ 여기에 그려져요/);
  });

  it("offers a lock for every connected item and none for the selection", () => {
    const html = render({ view: demoView, selectedId: "PayButton" });
    const switches = html.match(/role="switch"/g) ?? [];

    // file (holds it), createOrder, formatPrice, home — four neighbours.
    expect(switches).toHaveLength(4);
    expect(html).toContain('aria-checked="false"'); // locked until the user says otherwise
    expect(html).not.toContain("PayButton 편집 허용");
  });

  it("says how many places use something, without counting the file it lives in", () => {
    const text = words(render({ view: demoView, selectedId: "formatPrice" }));
    expect(text).toContain("2곳에서 쓰여요");
  });

  it("never says anything is safe, and never uses the words for the machinery", () => {
    const everywhere = [
      render({ view: demoView, selectedId: "PayButton" }),
      render({ view: demoView, selectedId: null }),
      render({ view: demoView, selectedId: "PayButton", run: completedRun }),
    ].map(words);

    for (const text of everywhere) {
      expect(text).not.toMatch(/안전/);
      expect(text).not.toMatch(/노드|엣지|간선/);
      expect(text).not.toMatch(/\b(node|edge|entity|triple|ontology)\b/i);
    }
  });

  it("reports an absence of knowledge as an absence of knowledge", () => {
    const alone = asView([item("lonely", { kind: "file", name: "notes.md" })], []);
    const text = words(render({ view: alone, selectedId: "lonely" }));

    expect(text).toContain("아는 연결이 없어요");
    expect(text).toContain("못 본 연결이 있을 수도 있어요");
  });

  it("says out loud how much the cap hid", () => {
    const callers = Array.from({ length: 40 }, (_, index) => item(`caller-${index}`));
    const hub = asView(
      [item("hub", { usedBy: 40 }), ...callers],
      callers.map((caller) => link(caller.id, "hub")),
    );
    const text = words(render({ view: hub, selectedId: "hub" }));

    expect(text).toContain("여기로 이어진 곳 40개 중 24개");
    expect(text).toContain("나머지 16개도 있어요");
    // And the headline still says forty, not twenty-four.
    expect(text).toContain("40곳에서 쓰여요");
  });

  it("reads as a page pulling files in, on a site with no symbols at all", () => {
    // David's portfolio: files, imports, nothing else.
    const site = asView(
      [
        item("index", { kind: "file", name: "index.html", shape: null, uses: 2 }),
        item("style", { kind: "file", name: "assets/style.css", shape: null, usedBy: 2 }),
        item("about", { kind: "file", name: "about.html", shape: null, uses: 1 }),
      ],
      [link("index", "style", "imports"), link("about", "style", "imports")],
    );
    const text = words(render({ view: site, selectedId: "style" }));

    expect(text).toContain("여기서 불러가요");
    expect(text).toContain("2곳에서 쓰여요");
    expect(text).not.toContain("조각"); // no symbols on this site, so the word never shows
  });

  it("does not put a checkmark next to work nobody did", () => {
    const text = words(render({ view: null, run: completedRun }));

    expect(text).toContain("구조 다 읽었어요");
    // Pass 2 does not exist yet, so the run never named a feature.
    expect(text).toContain("기능 이름은 이번에 붙이지 않았어요");
    expect(text).not.toContain("기능 이름 다 붙였어요");
  });

  it("keeps the request box on screen in every state, so it never has to move", () => {
    // The box holding IME composition state is why it is mounted once, at the
    // bottom, for the life of the panel rather than per state.
    for (const html of [
      render({ view: demoView, selectedId: "PayButton" }),
      render({ view: demoView, selectedId: null }),
      render({ view: null, run: { ...completedRun, status: "running" } }),
    ]) {
      expect(html.match(/<textarea/g) ?? []).toHaveLength(1);
    }
  });
});

const completedRun: RunProgress = {
  status: "completed",
  phase: "done",
  filesTotal: 17,
  filesParsed: 17,
  items: 68,
  connections: 121,
  certain: 121,
  inferred: 0,
  features: 0,
  recent: ["app/checkout/page.jsx"],
  skipped: [],
  message: null,
  limits: [],
};
