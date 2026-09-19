import { createHash } from "node:crypto";

import type { EdgeType, NodeType } from "./types";

/**
 * Stable identity for everything in the graph.
 *
 * Rule 1 of section 6.1: node ids are derived from a hash of project id, type,
 * file path and symbol name, and re-analysis must produce the same id for the
 * same thing. User corrections and chat citations point at ids, so an id that
 * churns silently repoints somebody's correction at the wrong thing.
 *
 * Analyzers never compute ids. They emit a natural key — {type, filePath,
 * name} — and this module hashes it. If each analyzer hashed its own, the
 * TypeScript analyzer and the static-site analyzer could disagree about
 * `styles.css` by a single character and fork the graph in a way nothing
 * would report (DECISIONS D7).
 */

/** What an analyzer emits to point at a node, including one it has not built. */
export type NodeRef = {
  type: NodeType;
  /** Repo-relative, POSIX separators. Normalised again here regardless. */
  filePath: string;
  /** The code name. Omitted for nodes whose identity is the path itself. */
  name?: string;
  /**
   * The enclosing symbol, when a name is not unique within its file.
   *
   * Without this, a file declaring `render()` on three classes collapses into
   * one node and every edge that should point at one of the three merges onto
   * whichever was written last — silently, with no error, and the user is told
   * something false about their own code. Class name for a method, and left
   * unset for a top-level declaration.
   *
   * Deliberately the enclosing NAME rather than a line number or an index:
   * both of those churn when unrelated code moves, and rule 1 of section 6.1
   * requires an id that survives edits elsewhere in the file.
   */
  container?: string;
};

/**
 * Normalise a path to the one form that is ever stored or hashed.
 *
 * Two things are being defended against. Windows produces backslashes, and the
 * founder develops on Windows, so an unnormalised path would hash differently
 * on his machine than on the Linux host — the same repo would produce two
 * different graphs (DECISIONS D18). And GitHub archives nest everything under
 * `{owner}-{repo}-{sha}/`, so a leading segment left in place would put a
 * commit SHA inside every id and break stability on every single commit.
 */
export function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

/**
 * 128 bits of SHA-256, hex. Long enough that collisions are not a practical
 * concern at any repo size, short enough to read in a URL and a log line.
 *
 * The parts are JSON-encoded rather than joined with a separator. Any separator
 * has to be a character that cannot appear in a path or a name, which means a
 * control character — and a literal control character in source is exactly what
 * gets silently rewritten in transit. This file has already had its separator
 * turn into a raw NUL byte once, and the same escape elsewhere in this codebase
 * became a plain space. Either would make `assets/me sitting 3.jpg` collide with
 * a different node, and a collision here silently overwrites one and repoints
 * its edges. JSON encodes the boundary structurally, so there is nothing left to
 * mangle. Changing this scheme changes every id, so it is being done now, while
 * no graph has been persisted.
 */
function digest(parts: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
}

export function nodeId(projectId: string, ref: NodeRef): string {
  return digest([
    "node",
    projectId,
    ref.type,
    normalizePath(ref.filePath),
    ref.container ?? "",
    ref.name ?? "",
  ]);
}

export function edgeId(
  projectId: string,
  type: EdgeType,
  sourceNodeId: string,
  targetNodeId: string,
): string {
  return digest(["edge", projectId, type, sourceNodeId, targetNodeId]);
}
