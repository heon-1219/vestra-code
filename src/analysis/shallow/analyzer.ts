import { normalizePath, type NodeRef } from "@/analysis/ids";
import type {
  AnalysisEmitter,
  AnalyzedEdge,
  AnalyzedNode,
  Analyzer,
  SourceFile,
} from "@/analysis/types";

import { manifestEcosystem, readManifest } from "./manifests";

/**
 * The analyzer that means no repository is ever told it is unsupported (D26).
 *
 * It runs on anything at all — Django, Rails, Go, a folder of HTML — and knows
 * nothing about any language. What it can do is read a file tree, read the
 * dependency lists, and follow paths that are written down literally.
 *
 * The important thing about this layer is what it is honest about, and D26's
 * correction is easy to get backwards. This is NOT an all-inferred analyzer:
 *
 *   - A dependency manifest is a direct read. `react` in `package.json` IS a
 *     package this project uses — `certain`.
 *   - `<script src="./app.js">` is resolved by the browser with a fully
 *     specified rule and no configuration anywhere. `certain`.
 *   - A relative import in source is `inferred`, because whether `./util`
 *     means `util.ts`, `util/index.js` or something a bundler alias decided is
 *     exactly the configuration we do not have.
 *
 * So in a fallback repository the boxes and their contents are solid and only
 * some of the lines between them are dotted. That is a different product from
 * a screen of dotted lines, which is why the distinction is worth the code.
 *
 * Deliberately no symbol extraction. D26 puts tree-sitter at step 5 or later,
 * and a half-built symbol reader that guesses at function boundaries would
 * undo the honesty above on the very first repository it met.
 */
export function createShallowAnalyzer(): Analyzer {
  return {
    name: "shallow",
    /**
     * `static_site` is here on purpose and should come back out. The
     * static-site analyzer (D6) does not exist yet, and a hand-written site is
     * mostly HTML link-and-script paths — which is precisely what this layer
     * reads, and reads as `certain`. A shallower map of a real site beats an
     * error message. When the static-site analyzer lands, drop it from here.
     */
    handles: (kind) => kind === "unsupported" || kind === "static_site",
    analyze: (files, _root, emit) => Promise.resolve(run(files, emit)),
  };
}

/**
 * A key identifying a node ref without hashing it. Analyzers never hash (ids.ts).
 *
 * JSON rather than a delimiter, for the reason D42 records: any separator has
 * to be a character that cannot occur in a path or a name, which means a
 * control character, and a literal control character in source is exactly what
 * gets silently rewritten in transit. This codebase has already had the same
 * escape become a raw NUL byte in one file and a plain space in another.
 */
function refKey(ref: NodeRef): string {
  return JSON.stringify([
    ref.type,
    normalizePath(ref.filePath),
    ref.container ?? "",
    ref.name ?? "",
  ]);
}

const HTML_EXTENSIONS = /\.html?$/i;
const STYLE_EXTENSIONS = /\.(css|scss|sass|less)$/i;

/**
 * What an extensionless specifier might mean, most common first.
 *
 * This list being a guess is the whole reason relative imports are `inferred`.
 * A real resolver reads `tsconfig`, the bundler config and `package.json`
 * `exports`; we read none of them, because in a Rails or Go repository there is
 * nothing to read.
 */
const PROBE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".vue", ".svelte", ".astro",
  ".css", ".scss", ".sass", ".less",
  ".json", ".py", ".rb", ".go", ".php", ".rs",
];

function run(
  files: SourceFile[],
  emit: AnalysisEmitter,
): { nodes: AnalyzedNode[]; edges: AnalyzedEdge[] } {
  emit.phase("static");

  const byPath = new Map(files.map((file) => [normalizePath(file.path), file]));
  const textFiles = files.filter((file) => file.read !== null);

  // One read per file. `read` goes to disk on every call, and manifests would
  // otherwise be read twice.
  const contents = new Map<string, string>();
  const contentOf = (file: SourceFile): string => {
    const cached = contents.get(file.path);
    if (cached !== undefined) return cached;
    const text = file.read?.() ?? "";
    contents.set(file.path, text);
    return text;
  };

  // --- Manifests ----------------------------------------------------------
  // Read first, because a bare specifier in source is only `certain` when the
  // package it names is already known to be a dependency.

  /** Package name -> the manifest path that declared it, for metadata. */
  const packages = new Map<string, { ecosystem: string; declaredIn: string }>();
  /** Manifest path -> the packages it declares. */
  const declaredBy = new Map<string, string[]>();

  for (const file of textFiles) {
    if (manifestEcosystem(file.path) === null) continue;

    const result = readManifest(file.path, contentOf(file));
    if (result.status === "skip") continue;
    if (result.status === "unreadable") {
      // Not a failure of the run. The file still becomes a node; we just have
      // nothing to say about what is inside it.
      emit.fileSkipped(file.path, result.reason);
      continue;
    }

    declaredBy.set(file.path, result.packages);
    for (const name of result.packages) {
      if (packages.has(name)) continue;
      packages.set(name, { ecosystem: result.ecosystem, declaredIn: file.path });
    }
  }

  // --- Pass A: nodes ------------------------------------------------------
  // Every node before every edge. Edges carry foreign keys to nodes and an
  // import routinely names a file we have not reached yet (D31).

  const nodes: AnalyzedNode[] = [];
  const declared = new Set<string>();

  const declare = (node: AnalyzedNode) => {
    const key = refKey(node.ref);
    if (declared.has(key)) return;
    declared.add(key);
    nodes.push(node);
  };

  for (const file of files) {
    declare({
      ref: { type: "file", filePath: file.path },
      metadata:
        file.read === null
          ? { asset: true, size: file.size }
          : { size: file.size },
    });
  }

  for (const [name, source] of packages) {
    declare({
      ref: { type: "package", filePath: "", name },
      metadata: { ecosystem: source.ecosystem, declaredIn: source.declaredIn },
    });
  }

  emit.nodes(nodes);

  // --- Pass B: edges ------------------------------------------------------

  const edges: AnalyzedEdge[] = [];
  const seenEdges = new Set<string>();

  const addEdge = (edge: AnalyzedEdge) => {
    // Never point at something we did not create, and never at ourselves. A
    // stylesheet that imports itself is nonsense, and a dangling target is a
    // foreign-key violation or a phantom row (D32, D35).
    if (!declared.has(refKey(edge.source))) return;
    if (!declared.has(refKey(edge.target))) return;
    if (refKey(edge.source) === refKey(edge.target)) return;

    const key = JSON.stringify([
      edge.type,
      refKey(edge.source),
      refKey(edge.target),
    ]);
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(edge);
  };

  // The manifest itself uses everything it declares. This is the edge that
  // survives when nothing else in the repository can be read at all.
  for (const [manifestPath, names] of declaredBy) {
    for (const name of names) {
      addEdge({
        source: { type: "file", filePath: manifestPath },
        target: { type: "package", filePath: "", name },
        type: "uses_package",
        confidence: "certain",
        metadata: { declared: true },
      });
    }
  }

  for (const file of textFiles) {
    const fileRef: NodeRef = { type: "file", filePath: file.path };
    const content = contentOf(file);

    for (const reference of collectReferences(file.path, content)) {
      if (reference.kind === "package") {
        const name = packageRoot(reference.specifier);
        // Silence when the name is not in any manifest. It is far more likely
        // to be a standard-library module than a dependency, and inventing a
        // package for `os` or `fmt` would put things on the map that the user
        // never installed.
        if (!packages.has(name)) continue;
        addEdge({
          source: fileRef,
          target: { type: "package", filePath: "", name },
          type: "uses_package",
          confidence: "certain",
          metadata: { specifier: reference.specifier },
        });
        continue;
      }

      const target = resolveTarget(file.path, reference, byPath);
      // No target means no edge. A dangling line is a claim about a file that
      // is not there, and the brief's rule is that a wrong edge costs more than
      // a missing one.
      if (target === null) continue;

      addEdge({
        source: fileRef,
        target: { type: "file", filePath: target },
        type: "imports",
        confidence: reference.confidence,
        metadata: { specifier: reference.specifier, via: reference.via },
      });
    }

    emit.fileParsed(file.path);
  }

  emit.edges(edges);
  emit.phase("done");

  return { nodes, edges };
}

// ---------------------------------------------------------------------------

type Reference =
  | { kind: "package"; specifier: string; via: string }
  | {
      kind: "path";
      specifier: string;
      /** Relative to the referring file, or to the repository root. */
      base: "file" | "root";
      /** Whether an extension may be guessed at. */
      probe: boolean;
      confidence: "certain" | "inferred";
      via: string;
    };

function collectReferences(repoPath: string, content: string): Reference[] {
  if (HTML_EXTENSIONS.test(repoPath)) return collectHtmlReferences(content);
  if (STYLE_EXTENSIONS.test(repoPath)) return collectStyleReferences(content);
  return collectModuleReferences(content);
}

/**
 * `<script src>`, `<link href>` and `<img src>`.
 *
 * `\ssrc` rather than `\bsrc` deliberately: the word boundary also matches
 * inside `data-src`, which is a lazy-loading placeholder, and the leading
 * whitespace is what separates a real attribute from the tail of another one.
 */
const HTML_REFERENCES: { pattern: RegExp; via: string }[] = [
  { pattern: /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, via: "script src" },
  { pattern: /<link\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, via: "link href" },
  { pattern: /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, via: "img src" },
];

function collectHtmlReferences(content: string): Reference[] {
  // Collected per tag but returned in document order. The three patterns run
  // one after another, so without the sort every stylesheet in the page would
  // come out ahead of every script regardless of where they sit — and this
  // order is the order the user reads the page's connections in.
  const found: { at: number; reference: Reference }[] = [];

  for (const { pattern, via } of HTML_REFERENCES) {
    for (const match of content.matchAll(pattern)) {
      const raw = match[1] ?? match[2] ?? match[3];
      const reference = literalPath(raw, via);
      if (reference) found.push({ at: match.index, reference });
    }
  }

  return found.sort((a, b) => a.at - b.at).map((entry) => entry.reference);
}

const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi;
const CSS_URL = /\burl\(\s*["']?([^"')]+?)["']?\s*\)/gi;

function collectStyleReferences(content: string): Reference[] {
  const found: Reference[] = [];

  for (const match of content.matchAll(CSS_IMPORT)) {
    const reference = literalPath(match[1], "@import");
    if (reference) found.push(reference);
  }
  for (const match of content.matchAll(CSS_URL)) {
    const reference = literalPath(match[1], "url()");
    if (reference) found.push(reference);
  }

  return found;
}

/**
 * A path written out in full, in a document whose resolution rule is the
 * browser's: relative to the file it appears in, no extension guessing, no
 * configuration. That is why these come back `certain`.
 *
 * A root-absolute path is the exception and comes back `inferred`. `/style.css`
 * is relative to the site root, and which directory that is IS configuration —
 * a deploy setting we cannot see. The repository root is the usual answer, so
 * it is worth trying; it is not worth claiming.
 */
function literalPath(raw: string | undefined, via: string): Reference | null {
  if (!raw) return null;
  const specifier = raw.trim();
  if (!specifier) return null;

  // Another origin, a data URI, an anchor, a template placeholder. None of
  // these name a file in this repository.
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;
  if (specifier.startsWith("//")) return null;
  if (specifier.startsWith("#")) return null;
  if (/[{}<>$]/.test(specifier)) return null;

  // `style.css?v=3#section` is still `style.css`.
  const clean = specifier.split(/[?#]/)[0];
  if (!clean) return null;

  return {
    kind: "path",
    specifier: clean,
    base: clean.startsWith("/") ? "root" : "file",
    probe: false,
    confidence: clean.startsWith("/") ? "inferred" : "certain",
    via,
  };
}

/**
 * Module specifiers, found by regex over source in any language.
 *
 * Bounded and quote-free in the middle on purpose: `[^;"']{0,200}?` lets a
 * multi-line `import { a, b } from "./x"` match while making it impossible for
 * one statement's `import` to reach across an intervening string and capture
 * the specifier of a later statement — which silently drops the first import
 * and mis-attributes the second.
 *
 * The block comment allowed inside `import(` is not decoration. Vue and Nuxt
 * routers are written almost entirely as
 * `() => import(/* webpackChunkName: "about" *\/ "../views/About.vue")`, and
 * Vue and Nuxt are two of the kinds that land on this analyzer. Without it the
 * router file — the one file that says what the whole app's pages are — would
 * produce nothing.
 */
const MODULE_SPECIFIER =
  /(?:\b(?:import|export)\s[^;"']{0,200}?\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*(?:\/\*[\s\S]{0,200}?\*\/\s*)?)["']([^"'\n]+)["']/g;

/** Whole-line comments, in every syntax this layer is likely to meet. */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|--|<!--)/;

function collectModuleReferences(content: string): Reference[] {
  // A commented-out import is not an import. Whole lines only — trying to strip
  // comments mid-line means deciding whether `//` is a comment or the middle of
  // `https://`, and getting that wrong corrupts the source we are reading.
  const source = content
    .split(/\r?\n/)
    .map((line) => (COMMENT_LINE.test(line) ? "" : line))
    .join("\n");

  const found: Reference[] = [];

  for (const match of source.matchAll(MODULE_SPECIFIER)) {
    const specifier = match[1].trim();
    if (!specifier) continue;

    if (specifier.startsWith(".")) {
      found.push({
        kind: "path",
        specifier,
        base: "file",
        probe: true,
        // Inferred, and this is the honest half of D26. Whether `./util` is
        // `util.ts`, `util/index.js` or an aliased path is decided by a
        // bundler config we have not read and, in most of these repositories,
        // could not read.
        confidence: "inferred",
        via: "import",
      });
      continue;
    }

    // `/abs/path` is not a module specifier in any ecosystem we read here, and
    // a Windows-style one is not a specifier at all.
    if (specifier.startsWith("/") || /^[a-z]:/i.test(specifier)) continue;

    found.push({ kind: "package", specifier, via: "import" });
  }

  return found;
}

/**
 * `lodash/fp` is the package `lodash`; `@scope/pkg/sub` is `@scope/pkg`.
 *
 * Splitting a subpath off is a fully specified npm rule with nothing
 * configurable in it, so a subpath import of a declared dependency stays
 * `certain` rather than dropping to a guess.
 */
function packageRoot(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

function resolveTarget(
  fromPath: string,
  reference: Extract<Reference, { kind: "path" }>,
  byPath: Map<string, SourceFile>,
): string | null {
  const base =
    reference.base === "root"
      ? []
      : normalizePath(fromPath).split("/").slice(0, -1);

  const joined = joinPosix(base, reference.specifier);
  // A specifier that walks above the repository root names something outside
  // the repository. There is nothing here to point at.
  if (joined === null) return null;

  if (byPath.has(joined)) return joined;
  if (!reference.probe) return null;

  for (const extension of PROBE_EXTENSIONS) {
    const candidate = `${joined}${extension}`;
    if (byPath.has(candidate)) return candidate;
  }
  for (const extension of PROBE_EXTENSIONS) {
    const candidate = `${joined}/index${extension}`;
    if (byPath.has(candidate)) return candidate;
  }

  return null;
}

/**
 * POSIX path joining over repo-relative segments, resolving `.` and `..`.
 *
 * Deliberately not `node:path`. On Windows `path.join` produces backslashes and
 * `path.resolve` drags in the process working directory, either of which
 * silently yields a path that matches nothing in the file list — the founder
 * develops on Windows and the server is Linux, so this would be a graph that
 * differs by machine (D18).
 */
function joinPosix(base: string[], specifier: string): string | null {
  const out = [...base];

  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }

  return out.length === 0 ? null : out.join("/");
}
