import { beforeAll, describe, expect, it } from "vitest";

import { edges as edgesTable, nodes as nodesTable } from "@/db/schema";
import type { ChangedFile } from "@/lib/github/api";

import { materializeFixture, type FixtureOverrides } from "./__fixtures__/load";
import { normalizePath } from "./ids";
import {
  ANALYZER_VERSION,
  planChangeScope,
  resolveWriteScope,
  selectOwnedRows,
  shapeOfGraph,
  type WriteScope,
} from "./incremental";
import {
  buildEdgeRows,
  buildNodeRows,
  resolveEdgeEndpoints,
  type CarryForwardScope,
} from "./persist";
import { createShallowAnalyzer } from "./shallow/analyzer";
import type { AnalysisEmitter, AnalyzedEdge, AnalyzedNode, SourceFile } from "./types";
import { createTypescriptAnalyzer } from "./typescript/analyzer";

/**
 * The one property incremental re-analysis has to hold:
 *
 *     incremental(A -> B) == full(B)
 *
 * Every id, every type, every certainty, every line range, every scrap of
 * metadata. Without this the feature is a silent graph-corruption machine, and
 * the corruption reaches the user as a confident sentence about their own code
 * that they have no way to check.
 *
 * ## What is real here and what is modelled
 *
 * The analyzers are real, run over real fixture trees. The decision — which
 * files get re-written, which get carried forward, which get swept — is the
 * real `incremental.ts`. The row shapes are the real `persist.ts` builders, so
 * ids, names, paths and dropped-row rules are not re-implemented here.
 *
 * What IS modelled is the three SQL statements: upsert, stamp, delete. They
 * are modelled because this suite has to run on every commit with no database
 * (`persist.test.ts` says so, and covers that SQL against a real Postgres
 * behind `VESTRA_DB=1`). The model is three functions below, each a line-for-
 * line reading of its `persist.ts` original — and the thing this file exists
 * to test is the *decision*, which is what incremental analysis actually adds.
 */

const PROJECT = "incremental-fixture";

type NodeRow = typeof nodesTable.$inferInsert;
type EdgeRow = typeof edgesTable.$inferInsert;
type Store = { nodes: Map<string, NodeRow>; edges: Map<string, EdgeRow> };
type Graph = { nodes: AnalyzedNode[]; edges: AnalyzedEdge[] };

/** One analysis, and everything the pipeline learns from it. */
type Analysed = {
  graph: Graph;
  skipped: string[];
  paths: string[];
  sources: Map<string, string>;
};

const emptyStore = (): Store => ({ nodes: new Map(), edges: new Map() });

// --- The three statements, modelled ----------------------------------------

/** `persistGraph`: upsert nodes, then edges whose endpoints resolve. */
function writeRows(store: Store, runId: string, graph: Graph): void {
  const { rows: nodeRows } = buildNodeRows(PROJECT, runId, graph.nodes, "static");
  for (const [id, row] of nodeRows) store.nodes.set(id, { ...row });

  // Exactly persistGraph's rule: an endpoint counts as resolved if this write
  // produced it OR the table already holds it. The second half is what lets an
  // incremental write point at a node it deliberately did not re-state.
  const { rows: edgeRows } = buildEdgeRows(
    PROJECT,
    runId,
    resolveEdgeEndpoints(PROJECT, graph.edges),
    "static",
    (id) => store.nodes.has(id),
  );
  for (const [id, row] of edgeRows) store.edges.set(id, { ...row });
}

/** `carryForwardSkipped`, including the two edge scopes. */
function carryForward(
  store: Store,
  runId: string,
  paths: readonly string[],
  scope: CarryForwardScope,
): void {
  const wanted = new Set(paths.map(normalizePath).filter((path) => path !== ""));
  if (wanted.size === 0) return;

  const endpoints = new Set<string>();
  for (const [id, row] of store.nodes) {
    if (row.filePath != null && wanted.has(row.filePath)) {
      endpoints.add(id);
      row.lastSeenRunId = runId;
    }
  }

  for (const row of store.edges.values()) {
    const covered =
      scope === "outgoing"
        ? endpoints.has(row.sourceNodeId)
        : endpoints.has(row.sourceNodeId) || endpoints.has(row.targetNodeId);
    if (covered) row.lastSeenRunId = runId;
  }
}

/** `sweepStaleRows`, with the foreign key's ON DELETE CASCADE after it. */
function sweep(store: Store, runId: string): void {
  for (const [id, row] of [...store.edges]) {
    if (row.lastSeenRunId !== runId) store.edges.delete(id);
  }
  for (const [id, row] of [...store.nodes]) {
    if (row.lastSeenRunId !== runId) store.nodes.delete(id);
  }
  for (const [id, row] of [...store.edges]) {
    if (!store.nodes.has(row.sourceNodeId) || !store.nodes.has(row.targetNodeId)) {
      store.edges.delete(id);
    }
  }
}

/** `promoteRun`, including its "the wider stamp wins" dedupe. */
function promote(
  store: Store,
  runId: string,
  skipped: readonly string[],
  unchanged: readonly string[],
): void {
  const skippedPaths = new Set(skipped.map(normalizePath));
  carryForward(store, runId, [...skippedPaths], "touching");
  carryForward(
    store,
    runId,
    unchanged.map(normalizePath).filter((path) => !skippedPaths.has(path)),
    "outgoing",
  );
  sweep(store, runId);
}

/**
 * The stored graph as lines a person can read.
 *
 * Ids are hashes, so an assertion on raw rows fails with a wall of hex nobody
 * can act on. Each line leads with what the thing is and ends with its id, so
 * a diff names the file and the connection first and still proves identity.
 */
function snapshot(store: Store): string[] {
  const nameOf = (id: string): string => {
    const row = store.nodes.get(id);
    return row ? `${row.type}:${row.filePath ?? "-"}#${row.name}` : `dangling(${id})`;
  };

  const lines: string[] = [];
  for (const [id, row] of store.nodes) {
    lines.push(
      `item ${row.type}:${row.filePath ?? "-"}#${row.name} kind=${row.kind ?? "-"}` +
        ` lines=${row.startLine ?? "-"}..${row.endLine ?? "-"} origin=${row.origin}` +
        ` meta=${JSON.stringify(row.metadata)} id=${id}`,
    );
  }
  for (const [id, row] of store.edges) {
    lines.push(
      `link ${row.type} ${nameOf(row.sourceNodeId)} -> ${nameOf(row.targetNodeId)}` +
        ` certainty=${row.confidence} origin=${row.origin}` +
        ` meta=${JSON.stringify(row.metadata)} id=${id}`,
    );
  }
  return lines.sort();
}

// --- The two runs, exactly as the pipeline sequences them ------------------

function runFull(store: Store, runId: string, state: Analysed): void {
  writeRows(store, runId, state.graph);
  promote(store, runId, state.skipped, []);
}

function runIncremental(
  store: Store,
  runId: string,
  next: Analysed,
  previous: Analysed,
  changed: readonly ChangedFile[],
): WriteScope {
  const scope = planChangeScope({
    source: "github",
    baseRun: {
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      analyzer: "fixture",
      analyzerVersion: ANALYZER_VERSION,
    },
    headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    analyzer: "fixture",
    comparison: { status: "ahead", files: [...changed], gap: null },
    comparisonError: null,
  });

  const writeScope =
    scope.mode === "incremental"
      ? resolveWriteScope({
          projectId: PROJECT,
          scope,
          analysedPaths: next.paths,
          graph: next.graph,
          previous: shapeOfGraph(PROJECT, previous.graph),
        })
      : scope;

  if (writeScope.mode === "incremental") {
    writeRows(store, runId, selectOwnedRows(next.graph, writeScope.touched));
    promote(store, runId, next.skipped, writeScope.carryForward);
  } else {
    writeRows(store, runId, next.graph);
    promote(store, runId, next.skipped, []);
  }
  return writeScope;
}

/**
 * Run A, then B incrementally; run B on its own; require the same graph.
 *
 * Returns the write scope so every caller can assert it really did go
 * incremental. Without that assertion the whole suite would keep passing if
 * this feature silently fell back to a full run for ever.
 */
function equivalent(
  before: Analysed,
  after: Analysed,
  changed: readonly ChangedFile[],
): { store: Store; writeScope: WriteScope } {
  const incremental = emptyStore();
  runFull(incremental, "run-a", before);
  const writeScope = runIncremental(incremental, "run-b", after, before, changed);

  const full = emptyStore();
  runFull(full, "run-b", after);

  expect(snapshot(incremental)).toEqual(snapshot(full));
  return { store: incremental, writeScope };
}

function touchedOf(writeScope: WriteScope): ReadonlySet<string> {
  if (writeScope.mode !== "incremental") {
    throw new Error(`expected an incremental write, got full: ${writeScope.reason}`);
  }
  return writeScope.touched;
}

function links(store: Store): string[] {
  const nameOf = (id: string) => {
    const row = store.nodes.get(id);
    if (!row) return "?";
    // A file's name IS its path, so printing both reads as a stutter.
    if (row.type === "file") return row.filePath ?? row.name;
    return `${row.filePath ?? ""}#${row.name}`;
  };
  return [...store.edges.values()].map(
    (row) =>
      `${row.confidence} ${row.type} ${nameOf(row.sourceNodeId)} -> ${nameOf(row.targetNodeId)}`,
  );
}

// --- Driving the two analyzers ---------------------------------------------

function collector(): { emit: AnalysisEmitter; skipped: string[] } {
  const skipped: string[] = [];
  return {
    skipped,
    emit: {
      phase: () => {},
      fileParsed: () => {},
      nodes: () => {},
      edges: () => {},
      fileSkipped: (path) => void skipped.push(path),
    },
  };
}

/**
 * The TypeScript analyzer over a real tree on disk.
 *
 * A fresh temp directory every call, so A and B live under different absolute
 * paths — which is the condition stable ids have to survive anyway, since a
 * GitHub archive nests everything under `{owner}-{repo}-{sha}/`.
 */
async function analyseShop(overrides: FixtureOverrides = {}): Promise<Analysed> {
  const fixture = materializeFixture("shop", overrides);
  const { emit, skipped } = collector();
  const graph = await createTypescriptAnalyzer().analyze(
    fixture.files,
    fixture.root,
    emit,
  );
  const paths = fixture.files.map((file) => file.path);
  const sources = fixture.sources;
  fixture.cleanup();
  return { graph, skipped, paths, sources };
}

/** The shallow analyzer, which needs no disk at all. */
async function analyseTree(
  entries: Record<string, string | null>,
): Promise<Analysed> {
  const files: SourceFile[] = Object.entries(entries).map(([path, content]) => ({
    path,
    absolutePath: `/repo/${path}`,
    size: content === null ? 2048 : Buffer.byteLength(content, "utf8"),
    read: content === null ? null : () => content,
  }));
  const { emit, skipped } = collector();
  const graph = await createShallowAnalyzer().analyze(files, "/repo", emit);
  return {
    graph,
    skipped,
    paths: files.map((file) => file.path),
    sources: new Map(
      Object.entries(entries).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    ),
  };
}

const change = (
  path: string,
  status: ChangedFile["status"],
  previousPath: string | null = null,
): ChangedFile => ({ path, status, previousPath });

// ---------------------------------------------------------------------------

describe("incremental re-analysis of a TypeScript project", () => {
  let base: Analysed;

  beforeAll(async () => {
    base = await analyseShop();
    // One real ts-morph program off disk. Slow because of what it does, not
    // because anything is wrong, and the default five seconds fails it on a
    // machine that is merely busy.
  }, 60_000);

  it("matches a full run when a file is modified", async () => {
    const format = base.sources.get("src/lib/format.ts") as string;
    // An edit ABOVE the declarations, so every line number below it moves. The
    // ids must not move with them, and the line ranges must — a carried-forward
    // file would keep the old ranges and the preview would open on the wrong
    // lines.
    const after = await analyseShop({
      "src/lib/format.ts": `export const CURRENCY = "KRW";\n\n${format}`,
    });

    const { store, writeScope } = equivalent(base, after, [
      change("src/lib/format.ts", "modified"),
    ]);

    expect(touchedOf(writeScope)).toContain("src/lib/format.ts");
    const moved = [...store.nodes.values()].find(
      (row) => row.filePath === "src/lib/format.ts" && row.name === "formatPrice",
    );
    expect(moved?.startLine).toBe(3);
  }, 60_000);

  it("matches a full run when a file is added", async () => {
    const after = await analyseShop({
      "src/lib/receipts.ts":
        'import { formatPrice } from "./format";\n\n' +
        "export function receiptLine(cents: number): string {\n" +
        '  return "total " + formatPrice(cents);\n}\n',
    });

    const { store, writeScope } = equivalent(base, after, [
      change("src/lib/receipts.ts", "added"),
    ]);

    expect(touchedOf(writeScope)).toContain("src/lib/receipts.ts");
    expect(links(store)).toContain(
      "certain calls src/lib/receipts.ts#receiptLine -> src/lib/format.ts#formatPrice",
    );
    // The file it reaches for did not change, so it was carried forward — and
    // the connection into it still landed.
    expect(touchedOf(writeScope)).not.toContain("src/lib/format.ts");
  }, 60_000);

  it("matches a full run when a file is removed, including a file nobody touched", async () => {
    // `Badge` is declared twice in this fixture, so `page.tsx`'s bare <Badge/>
    // is ambiguous and produces no connection at all. Deleting one of the two
    // makes the name unique project-wide and `page.tsx` — untouched, and with
    // no link to the deleted file in either graph — gains a connection.
    const after = await analyseShop({ "src/components/admin/Badge.tsx": null });

    const { store, writeScope } = equivalent(base, after, [
      change("src/components/admin/Badge.tsx", "removed"),
    ]);

    expect([...store.nodes.values()].map((row) => row.filePath)).not.toContain(
      "src/components/admin/Badge.tsx",
    );
    expect(touchedOf(writeScope)).toContain("src/app/page.tsx");
    expect(links(store)).toContain(
      "inferred renders src/app/page.tsx#HomePage -> src/components/Badge.tsx#Badge",
    );
  }, 60_000);

  it("matches a full run when a file is renamed", async () => {
    const analytics = base.sources.get("src/lib/analytics.ts") as string;
    const after = await analyseShop({
      "src/lib/analytics.ts": null,
      "src/lib/telemetry.ts": analytics,
    });

    const { store } = equivalent(base, after, [
      change("src/lib/telemetry.ts", "renamed", "src/lib/analytics.ts"),
    ]);

    // A rename is a delete plus an add, because the path is inside the id. The
    // old path must leave no row behind, and the connection into it must have
    // followed — not been left pointing at the copy that no longer exists.
    expect([...store.nodes.values()].map((row) => row.filePath)).not.toContain(
      "src/lib/analytics.ts",
    );
    expect(links(store)).toContain(
      "inferred calls src/lib/orders.ts#reportOrder -> src/lib/telemetry.ts#trackEvent",
    );
  }, 60_000);

  it("matches a full run when only a dependent is affected", async () => {
    // `formatCount` goes away. The only caller is an API route file that this
    // commit did not touch at all.
    const after = await analyseShop({
      "src/lib/format.ts":
        "export function formatPrice(cents: number): string {\n" +
        '  const won = Math.round(cents / 100);\n' +
        '  return won.toLocaleString("en-US") + " won";\n}\n',
    });

    const { store, writeScope } = equivalent(base, after, [
      change("src/lib/format.ts", "modified"),
    ]);

    const route = "src/app/api/orders/route.ts";
    expect(touchedOf(writeScope)).toContain(route);
    expect(links(store)).not.toContain(
      `certain calls ${route}#GET -> src/lib/format.ts#formatCount`,
    );
    // The proof that the previous line means something: it WAS there before.
    const beforeStore = emptyStore();
    runFull(beforeStore, "run-a", base);
    expect(links(beforeStore)).toContain(
      `certain calls ${route}#GET -> src/lib/format.ts#formatCount`,
    );
  }, 60_000);

  it("matches a full run, and writes almost nothing, when nothing changed", async () => {
    const { writeScope } = equivalent(base, base, []);
    const touched = touchedOf(writeScope);

    // The saving has to be real, or this feature is bookkeeping for nothing.
    // Only the files that guessed are re-stated; everything else is stamped.
    expect(touched.size).toBeLessThan(base.paths.length / 2);
    if (writeScope.mode === "incremental") {
      expect(writeScope.carryForward.length).toBeGreaterThan(touched.size);
    }
  }, 60_000);
});

describe("incremental re-analysis of a project the shallow analyzer reads", () => {
  /**
   * Most real projects here never reach the TypeScript analyzer — a static
   * site and a Python repository both land on this one (D26) — so the property
   * has to hold for it too, and its global coupling is a different one.
   */

  // Big enough that carrying most of it forward is a real saving. On a
  // three-file tree the ceiling in `resolveWriteScope` fires first and
  // correctly — one changed file out of three is not worth the bookkeeping —
  // which would make every assertion below vacuous.
  const site = {
    "index.html":
      '<!doctype html>\n<link href="./styles.css" rel="stylesheet">\n' +
      '<script src="./app.js"></script>\n',
    "about.html": '<!doctype html>\n<link href="./styles.css" rel="stylesheet">\n',
    "contact.html": "<!doctype html>\n<p>안녕하세요</p>\n",
    "styles.css": "body { margin: 0 }\n",
    "print.css": "@media print { body { color: #000 } }\n",
    "boot.js": 'console.log("boot");\n',
    "app.js": 'import React from "react";\nimport "./util";\n',
  };

  it("matches a full run when a manifest appears and changes a file nobody touched", async () => {
    const before = await analyseTree(site);
    const after = await analyseTree({
      ...site,
      "package.json": '{"name":"site","dependencies":{"react":"18.0.0"}}',
    });

    const { store, writeScope } = equivalent(before, after, [
      change("package.json", "added"),
    ]);

    // `react` is only a package once a manifest says so. `app.js` did not
    // change and has no link to package.json in either graph, and its
    // connections still move — this is the shallow analyzer's own global index.
    expect(touchedOf(writeScope)).toContain("app.js");
    expect(links(store)).toContain("certain uses_package app.js -> #react");
  });

  it("matches a full run when a manifest is removed", async () => {
    const before = await analyseTree({
      ...site,
      "package.json": '{"name":"site","dependencies":{"react":"18.0.0"}}',
    });
    const after = await analyseTree(site);

    const { store } = equivalent(before, after, [change("package.json", "removed")]);
    expect(links(store).join("\n")).not.toContain("uses_package");
  });

  it("matches a full run when a new file makes another file's path resolve", async () => {
    const before = await analyseTree(site);
    const after = await analyseTree({ ...site, "util.js": "export const x = 1;\n" });

    const { store, writeScope } = equivalent(before, after, [
      change("util.js", "added"),
    ]);

    expect(touchedOf(writeScope)).toContain("app.js");
    expect(links(store)).toContain("inferred imports app.js -> util.js");
  });
});

// ---------------------------------------------------------------------------

describe("when it refuses to go incremental", () => {
  const ahead = { status: "ahead" as const, files: [], gap: null };
  const baseRun = {
    commitSha: "a".repeat(40),
    analyzer: "typescript",
    analyzerVersion: ANALYZER_VERSION,
  };
  const ask = (patch: Partial<Parameters<typeof planChangeScope>[0]>) =>
    planChangeScope({
      source: "github",
      baseRun,
      headSha: "b".repeat(40),
      analyzer: "typescript",
      comparison: ahead,
      comparisonError: null,
      ...patch,
    });

  it("does a full run for an uploaded folder, which has no commits", () => {
    expect(ask({ source: "upload" })).toEqual({ mode: "full", reason: "not_a_repo" });
  });

  it("does a full run when there is no completed run to compare against", () => {
    expect(ask({ baseRun: null })).toEqual({ mode: "full", reason: "no_base_run" });
  });

  it("does a full run when the previous run recorded no commit", () => {
    expect(ask({ baseRun: { ...baseRun, commitSha: null } })).toEqual({
      mode: "full",
      reason: "no_base_commit",
    });
  });

  it("does a full run when this run could not resolve a commit", () => {
    expect(ask({ headSha: null })).toEqual({ mode: "full", reason: "no_head_commit" });
  });

  it("does a full run when GitHub no longer has the base commit", () => {
    // What a force-push looks like from here: the head resolved a moment ago,
    // so a 404 on the compare is about the base.
    expect(ask({ comparison: null, comparisonError: "not_found" })).toEqual({
      mode: "full",
      reason: "base_missing",
    });
  });

  it("does a full run when GitHub would not answer", () => {
    expect(ask({ comparison: null, comparisonError: "rate_limited" })).toEqual({
      mode: "full",
      reason: "compare_failed",
    });
  });

  it.each(["behind", "diverged"] as const)(
    "does a full run when history is %s, because the compare is three-dot",
    (status) => {
      expect(ask({ comparison: { ...ahead, status } })).toEqual({
        mode: "full",
        reason: "history_rewritten",
      });
    },
  );

  it.each(["file_cap", "unknown_status"] as const)(
    "does a full run when the change list has a %s gap",
    (gap) => {
      expect(ask({ comparison: { ...ahead, gap } })).toEqual({
        mode: "full",
        reason: "compare_incomplete",
      });
    },
  );

  it("does a full run when a different analyzer produced the base graph", () => {
    expect(ask({ baseRun: { ...baseRun, analyzer: "shallow" } })).toEqual({
      mode: "full",
      reason: "analyzer_changed",
    });
  });

  it("does a full run when the analyzer version moved", () => {
    expect(ask({ baseRun: { ...baseRun, analyzerVersion: "0" } })).toEqual({
      mode: "full",
      reason: "analyzer_changed",
    });
  });

  it("keeps both spellings of a renamed path, so the old rows are swept", () => {
    const scope = ask({
      comparison: {
        ...ahead,
        files: [change("b.ts", "renamed", "a.ts"), change("c.ts", "added")],
      },
    });
    expect(scope.mode).toBe("incremental");
    if (scope.mode !== "incremental") return;
    expect([...scope.changed].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("does a full run when so much changed that skipping the rest saves nothing", () => {
    const scope = planChangeScope({
      source: "github",
      baseRun,
      headSha: "b".repeat(40),
      analyzer: "typescript",
      comparison: {
        ...ahead,
        files: ["a.ts", "b.ts", "c.ts"].map((path) => change(path, "modified")),
      },
      comparisonError: null,
    });

    expect(
      resolveWriteScope({
        projectId: PROJECT,
        scope,
        analysedPaths: ["a.ts", "b.ts", "c.ts", "d.ts"],
        graph: { nodes: [], edges: [] },
        previous: { dependencies: [], endpointIds: [], packageNames: [] },
      }),
    ).toEqual({ mode: "full", reason: "too_many_changes" });
  });
});

describe("which rows a touched file owns", () => {
  const fileNode = (path: string): AnalyzedNode => ({
    ref: { type: "file", filePath: path },
  });

  it("always writes packages, which belong to no file", () => {
    const graph = {
      nodes: [
        fileNode("a.ts"),
        fileNode("b.ts"),
        { ref: { type: "package" as const, filePath: "", name: "react" } },
      ],
      edges: [
        {
          source: { type: "file" as const, filePath: "b.ts" },
          target: { type: "package" as const, filePath: "", name: "react" },
          type: "uses_package" as const,
          confidence: "certain" as const,
        },
      ],
    };

    const owned = selectOwnedRows(graph, new Set(["a.ts"]));

    // A package node nobody stamps is a package node the sweep deletes, and the
    // cascade would take the `uses_package` connections of every file that was
    // carried forward with it.
    expect(owned.nodes.map((node) => node.ref.name ?? node.ref.filePath)).toEqual([
      "a.ts",
      "react",
    ]);
    // The connection itself belongs to `b.ts`, which was not touched.
    expect(owned.edges).toEqual([]);
  });
});
