import type {
  confidenceEnum,
  edgeTypeEnum,
  nodeTypeEnum,
  originEnum,
  projectKindEnum,
  symbolKindEnum,
} from "@/db/schema";

import type { NodeRef } from "./ids";

export type NodeType = (typeof nodeTypeEnum.enumValues)[number];
export type SymbolKind = (typeof symbolKindEnum.enumValues)[number];
export type EdgeType = (typeof edgeTypeEnum.enumValues)[number];
export type Confidence = (typeof confidenceEnum.enumValues)[number];
export type Origin = (typeof originEnum.enumValues)[number];
export type ProjectKind = (typeof projectKindEnum.enumValues)[number];

/**
 * A file the analyzer may look at. Ingest has already filtered and normalised
 * these, so an analyzer never touches the filesystem directly — which is what
 * makes the whole pass testable from an in-memory fixture with no GitHub, no
 * temp directory and no database.
 */
export type SourceFile = {
  /** Repo-relative, POSIX separators. */
  path: string;
  /** Absolute path on disk, for analyzers that must hand a real path to a tool. */
  absolutePath: string;
  /** Bytes. Present for assets too, where `read` is unavailable. */
  size: number;
  /**
   * Text content, or null for binary assets. An asset still becomes a `file`
   * node — "nothing on your site uses this photo" depends on it existing.
   */
  read: (() => string) | null;
};

/** A node an analyzer found, before it has an id. */
export type AnalyzedNode = {
  ref: NodeRef;
  kind?: SymbolKind;
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
};

/**
 * An edge an analyzer found, addressed by natural key at both ends.
 *
 * Analyzers name endpoints rather than ids so they never hash anything, and so
 * an edge can be emitted before the node at its far end has been visited.
 */
export type AnalyzedEdge = {
  source: NodeRef;
  target: NodeRef;
  type: EdgeType;
  /**
   * `certain` means the compiler resolved it. `inferred` means a heuristic
   * did. There is no third value, and an analyzer that cannot honestly pick
   * one of these two must emit nothing — the brief's rule is that a wrong
   * edge is worse than a missing one.
   */
  confidence: Confidence;
  metadata?: Record<string, unknown>;
};

/** Progress, streamed to the browser over SSE and persisted as it goes. */
export type AnalysisEmitter = {
  phase: (phase: "ingest" | "static" | "semantic" | "done") => void;
  fileParsed: (path: string) => void;
  nodes: (nodes: AnalyzedNode[]) => void;
  edges: (edges: AnalyzedEdge[]) => void;
  /** One unparseable file must not fail the run (section 6.2). Record it. */
  fileSkipped: (path: string, reason: string) => void;
};

/**
 * One analysis strategy for one shape of project.
 *
 * Deliberately small. Section 8 warns against building a framework instead of
 * the specific thing, so this is two implementations behind one interface, not
 * a plugin system: no registration, no lifecycle, no configuration.
 */
export type Analyzer = {
  /** Stable name, recorded on the run so a graph can say what produced it. */
  name: string;

  /**
   * Whether this analyzer handles a project of this kind. Detection itself is
   * a separate concern — it runs once over the file list, before any analyzer
   * is chosen.
   */
  handles: (kind: ProjectKind) => boolean;

  /**
   * Pure over its inputs: files in, nodes and edges out, progress on the
   * emitter. No HTTP, no database, no id hashing. This is what lets the
   * fixture tests run the real analyzer against an in-memory tree.
   *
   * `root` is the absolute directory the repo-relative paths are relative to.
   * It is passed rather than derived, because deriving it means slicing an
   * absolute path (native separators) by a repo-relative one (POSIX), which
   * silently produces the wrong answer on Windows.
   */
  analyze: (
    files: SourceFile[],
    root: string,
    emit: AnalysisEmitter,
  ) => Promise<{ nodes: AnalyzedNode[]; edges: AnalyzedEdge[] }>;
};
