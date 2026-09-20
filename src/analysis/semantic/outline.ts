import type { NodeRef } from "../ids";
import { normalizePath } from "../ids";
import type { AnalyzedEdge, AnalyzedNode, SymbolKind } from "../types";

/**
 * The project, flattened into the smallest thing a model can be asked about.
 *
 * Pass 1 hands us thousands of rows. This turns them into one list of files,
 * each carrying the pieces inside it and the few facts that make its name
 * guessable — what points at it, what it points at, which address it serves.
 * No source text, per section 6.2 and D52: the outline is what keeps a 300-file
 * project inside ~12k input tokens instead of ~100k.
 *
 * ## Indices, not ids (D46)
 *
 * Every entry carries a small integer, and that integer is the only way the
 * model is allowed to refer to anything. Echoing 32-hex node ids back would
 * cost 20-25k output tokens on a mid-sized repo — against a 32,768 completion
 * ceiling it competes with the answer itself — and it turns "drop any id that
 * does not exist" into string matching. An integer turns it into a bounds
 * check, which cannot be fooled.
 *
 * Files and their pieces share one index space. One space rather than two
 * means the parser has exactly one rule ("is this index in the set I sent?")
 * and there is no way for a file index to be read as a piece index.
 *
 * ## Determinism
 *
 * Files are ordered by path and pieces by (line, name), so two runs over an
 * unchanged repository build a byte-identical outline — which is what makes a
 * carried-forward answer comparable with a fresh one, and what any later cache
 * on the outline bytes (D53) will depend on.
 */

export type OutlineKind = "file" | "symbol" | "route" | "api_endpoint";

/** One thing the model may be asked to name. */
export type OutlineEntry = {
  /** Stable within this run. What the model answers with (D46). */
  index: number;
  ref: NodeRef;
  kind: OutlineKind;
  /** The name in the code: a path for a file, an identifier for a piece. */
  name: string;
  /** The file this belongs to. Its own path, for a file. */
  filePath: string;
  /** `component`, `hook`, `function`… when Pass 1 knew. */
  shape: SymbolKind | null;
  /** The plain-Korean name a previous run already wrote, if any. */
  label: string | null;
  summary: string | null;
};

export type OutlineFile = OutlineEntry & {
  kind: "file";
  /** Symbols, routes and endpoints this file contains. */
  pieces: OutlineEntry[];
  /** How many other files point at this one. */
  importedBy: number;
  /** Links at either end that are not `contains`. D69's notion of a real use. */
  degree: number;
  /** Files this one points at. Context for a name, capped by the caller. */
  pointsAt: string[];
  /** Packages it uses. `stripe` says more about a file than its folder does. */
  packages: string[];
  /** Addresses it serves: `/checkout`, `POST /api/orders`. */
  addresses: string[];
};

export type Outline = {
  files: readonly OutlineFile[];
  /** Every entry, by index. The parser's bounds check reads this. */
  byIndex: ReadonlyMap<number, OutlineEntry>;
};

/** What a previous run already wrote for a node, keyed by the same ref. */
export type KnownText = {
  label: string | null;
  summary: string | null;
  textLang: string | null;
};

/**
 * Build the outline from one run's graph.
 *
 * `known` is looked up by the node's natural key rather than by id, so this
 * stays a pure function of the graph plus a map — no project id, no hashing,
 * and therefore testable with a literal.
 */
export function buildOutline(
  graph: { nodes: readonly AnalyzedNode[]; edges: readonly AnalyzedEdge[] },
  known: ReadonlyMap<string, KnownText> = new Map(),
): Outline {
  const files = new Map<string, OutlineFile>();
  const pieces = new Map<string, OutlineEntry[]>();

  const textOf = (ref: NodeRef): KnownText => {
    const hit = known.get(refKey(ref));
    // A row whose text came from some other language is not an answer in this
    // one. D2 put the tag there so that adding English later is additive; the
    // cost of that is that everything reading these columns has to check it.
    if (!hit || hit.textLang !== "ko") return { label: null, summary: null, textLang: null };
    return hit;
  };

  for (const node of graph.nodes) {
    const path = normalizePath(node.ref.filePath);
    const text = textOf(node.ref);

    if (node.ref.type === "file") {
      files.set(path, {
        index: -1,
        ref: node.ref,
        kind: "file",
        name: path,
        filePath: path,
        shape: null,
        label: text.label,
        summary: text.summary,
        pieces: [],
        importedBy: 0,
        degree: 0,
        pointsAt: [],
        packages: [],
        addresses: [],
      });
      continue;
    }

    if (
      node.ref.type !== "symbol" &&
      node.ref.type !== "route" &&
      node.ref.type !== "api_endpoint"
    ) {
      // A package is not ours to name — it is somebody else's library, and a
      // Korean sentence about `react` would be this product inventing a fact
      // about a project it did not read.
      continue;
    }

    const entry: OutlineEntry = {
      index: -1,
      ref: node.ref,
      kind: node.ref.type,
      name: node.ref.container
        ? `${node.ref.container}.${node.ref.name ?? ""}`
        : (node.ref.name ?? path),
      filePath: path,
      shape: node.kind ?? null,
      label: text.label,
      summary: text.summary,
    };
    const list = pieces.get(path);
    if (list) list.push(entry);
    else pieces.set(path, [entry]);

    // Sort key, read back below. Held here rather than on the type because it
    // is bookkeeping for one sort and nothing downstream has a use for it.
    lineOf.set(entry, node.startLine ?? Number.MAX_SAFE_INTEGER);
  }

  const addressOf = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.ref.type === "route" || node.ref.type === "api_endpoint") {
      addressOf.set(refKey(node.ref), node.ref.name ?? "");
    }
  }

  for (const edge of graph.edges) {
    const from = normalizePath(edge.source.filePath);
    const to = normalizePath(edge.target.filePath);

    if (edge.type === "contains") {
      const owner = files.get(from);
      const address = addressOf.get(refKey(edge.target));
      if (owner && address) owner.addresses.push(address);
      continue;
    }

    if (edge.type === "belongs_to") continue;

    // Everything else is a real link between two things (D69). Counted at both
    // ends, because "this file is in the middle of everything" is true whether
    // the arrows point in or out.
    const source = files.get(from);
    const target = files.get(to);

    if (edge.target.type === "package") {
      if (source) {
        source.degree += 1;
        source.packages.push(edge.target.name ?? "");
      }
      continue;
    }

    if (source) source.degree += 1;
    if (target && to !== from) {
      target.degree += 1;
      target.importedBy += 1;
    }
    if (source && to !== "" && to !== from) source.pointsAt.push(to);
  }

  const ordered = [...files.values()].sort((a, b) =>
    a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
  );
  const byIndex = new Map<number, OutlineEntry>();
  let next = 0;

  for (const file of ordered) {
    file.index = next++;
    byIndex.set(file.index, file);

    const own = (pieces.get(file.filePath) ?? []).sort((a, b) => {
      const byLine = (lineOf.get(a) ?? 0) - (lineOf.get(b) ?? 0);
      if (byLine !== 0) return byLine;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    for (const piece of own) {
      piece.index = next++;
      byIndex.set(piece.index, piece);
    }
    file.pieces = own;

    file.pointsAt = unique(file.pointsAt);
    file.packages = unique(file.packages);
    file.addresses = unique(file.addresses);
  }

  return { files: ordered, byIndex };
}

/**
 * Sorting the pieces of a file by where they appear needs the start line, and
 * `OutlineEntry` has no business carrying it downstream. A WeakMap keeps it
 * out of the type without a second pass over the nodes.
 */
const lineOf = new WeakMap<OutlineEntry, number>();

/** The natural key a node is looked up by. Matches `ids.ts`'s hashed parts. */
export function refKey(ref: NodeRef): string {
  return JSON.stringify([
    ref.type,
    normalizePath(ref.filePath),
    ref.container ?? "",
    ref.name ?? "",
  ]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}
