import { normalizePath, type NodeRef } from "@/analysis/ids";
import type {
  AnalysisEmitter,
  AnalyzedEdge,
  AnalyzedNode,
  Analyzer,
  ProjectKind,
  SourceFile,
} from "@/analysis/types";
import type { Llm } from "@/lib/llm/types";

import {
  runPythonLlmPass,
  type PythonFileFacts,
  type PythonLlmBudget,
  type PythonLlmResult,
  type PythonSymbol,
  type RememberedAnswer,
} from "./llm";
import {
  createModuleIndex,
  createPackageIndex,
  importTargets,
  topLevelModule,
} from "./resolve";
import { collectDefinitions, collectImports, scanPython } from "./scanner";
import { looksLikeStreamlit, streamlitPages } from "./streamlit";

/**
 * The analyzer for a Python repository, built on one split that is the whole
 * design:
 *
 *   **Structure from a parser → `certain`. Calls and roles from a model →
 *   `inferred`. Never the other way round.**
 *
 * Today a Python repository falls through to the shallow analyzer, and what it
 * gets is a pile of disconnected dots: a real 48-file, 221KB Python project
 * produced eleven edges, every one of them "uses this package", with not a
 * single file joined to another. The shallow layer is honest about that — it
 * reads paths, and Python's imports are dotted names rather than paths — but
 * honest emptiness is still emptiness, and it is the biggest hole in the
 * product.
 *
 * The two halves are separated because they are two different kinds of claim:
 *
 *   - **What the file says.** `from .db import save` names `db.py` next to it.
 *     `def place_order` at column 0 is a module-level function. Both are read
 *     off the text with no inference, so both are `certain`. This half runs
 *     with no model, no key and no network, and it is what a repository gets
 *     when nobody has configured a model at all — a smaller honest graph, which
 *     is not a failure.
 *   - **What the file does.** `place_order(...)` on line 42 might be the
 *     imported function, a method on a local object, or a name rebound three
 *     lines up. Without type information nothing here can tell those apart, so
 *     that half is asked of a model, comes back `inferred`, is checked against
 *     the source line before it is kept, and is marked as the model's.
 *
 * The rule the split enforces is that no model answer can ever become
 * `certain`, whatever the model's confidence, and no parser fact is ever
 * softened to `inferred` because a model disagreed.
 */

/**
 * The project kind this analyzer answers to.
 *
 * `project_kind` has no `python` value yet, and adding one is a schema change
 * and a migration that belong with whoever wires this in — so `handles` asks a
 * question the enum cannot answer today and gets `false`, which leaves the
 * analyzer inert and harmless until the value exists. Written as a string
 * membership test rather than a cast so that adding `python` to the enum is the
 * only change needed: nothing in this file has to be edited for it to switch on.
 */
export const PYTHON_PROJECT_KINDS: readonly string[] = ["python"];

const PYTHON_SOURCE = /\.py$/i;

export type PythonAnalyzerOptions = {
  /**
   * The model, or nothing.
   *
   * Injected and optional, which is the property that keeps everything above
   * testable: every test in this folder drives a scripted fake, there is no API
   * key on a contributor's machine, and a project with no model configured
   * still gets the whole parser half.
   */
  llm?: Llm | null;
  budget?: Partial<PythonLlmBudget>;
  signal?: AbortSignal;
  /**
   * What the model pass found out, handed back out of band.
   *
   * `Analyzer.analyze` returns nodes and edges and nothing else, and the one
   * thing this pass produces that is neither is its coverage — how many files
   * it did not look at. "We did not look" and "there is nothing there" are
   * opposite claims and must never be conflated, so the number has to reach the
   * caller somehow. It is also written onto each file node as
   * `metadata.llmExamined`, so it survives into the database either way.
   */
  onLlmResult?: (result: PythonLlmResult) => void;
  /**
   * Files whose calls the model is not asked to read (D160): tests, generated
   * files, a tool's own settings. They are parsed like every other file and
   * keep every `certain` import; only the model half skips them, and they get
   * no `llmExamined` flag, so they are counted as set aside rather than as a
   * shortfall.
   *
   * Handed this analyzer's whole parser-half graph — files, symbols, the
   * Streamlit pages and every import — rather than one path at a time, and
   * that is the fix for a measured defect (D168). Asked per path, the question
   * could not see that `pages/ab_test.py` serves `/ab_test`, so a Streamlit
   * page named like a test lost its model reading with no flag and no count:
   * its flow led nowhere and nothing on screen said why. The graph carries
   * the address, what the file defines and who imports it, which is
   * everything `set-aside.ts#resolveSetAside` needs — and the pipeline asks
   * the same function of the finished graph, so the two answers agree.
   */
  setAside?: (graph: {
    nodes: readonly AnalyzedNode[];
    edges: readonly AnalyzedEdge[];
  }) => ReadonlyMap<string, unknown>;
  /**
   * What an earlier run was told about a file (D161). Written back onto each
   * file node as `metadata.llmAnswer`, which is where the next run finds it.
   */
  recall?: (path: string) => RememberedAnswer | null;
};

/** Where a file's remembered answer lives on its node. */
export const LLM_ANSWER_KEY = "llmAnswer";

/**
 * A key that identifies a node ref without hashing it. Analyzers never hash.
 *
 * JSON rather than a delimiter string, for the reason `ids.ts` records: any
 * separator has to be a character that cannot occur in a path or a name, which
 * means a control character, and a literal control character in source is
 * exactly what gets silently rewritten in transit. JSON encodes the boundary
 * structurally, so there is nothing left to mangle.
 */
function refKey(ref: NodeRef): string {
  return JSON.stringify([
    ref.type,
    normalizePath(ref.filePath),
    ref.container ?? "",
    ref.name ?? "",
  ]);
}

export function createPythonAnalyzer(
  options: PythonAnalyzerOptions = {},
): Analyzer {
  return {
    name: "python",
    handles: (kind: ProjectKind) => PYTHON_PROJECT_KINDS.includes(kind),
    analyze: (files, _root, emit) => run(files, emit, options),
  };
}

async function run(
  files: SourceFile[],
  emit: AnalysisEmitter,
  options: PythonAnalyzerOptions,
): Promise<{ nodes: AnalyzedNode[]; edges: AnalyzedEdge[] }> {
  emit.phase("static");

  // One read per file. `read` goes to disk on every call, and the LLM pass
  // needs the same text the scanner saw.
  const contents = new Map<string, string>();
  const sourceFiles = files.filter(
    (file) => file.read !== null && PYTHON_SOURCE.test(file.path),
  );

  const moduleIndex = createModuleIndex(files.map((file) => file.path));
  const packageIndex = createPackageIndex(files);

  // ---- Pass A: nodes -------------------------------------------------------
  // Every node before every edge. Edges carry foreign keys to nodes, and an
  // import routinely names a file that has not been scanned yet (D31).

  const nodes: AnalyzedNode[] = [];
  const declared = new Set<string>();
  const nodeByKey = new Map<string, AnalyzedNode>();

  const declare = (node: AnalyzedNode) => {
    const key = refKey(node.ref);
    if (declared.has(key)) return;
    declared.add(key);
    nodeByKey.set(key, node);
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

  type Parsed = {
    file: SourceFile;
    symbols: PythonSymbol[];
    /** Files this one imports, resolved and in the tree. */
    imports: {
      path: string;
      line: number;
      specifier: string;
      /** The names taken out of it, so the edge can say what was reached for. */
      names: string[];
    }[];
    /** Declared dependencies it reaches for. */
    packages: { name: string; line: number; specifier: string }[];
    aliases: Map<string, string>;
    code: string[];
  };

  const parsed: Parsed[] = [];

  for (const file of sourceFiles) {
    let source: string;
    try {
      source = file.read?.() ?? "";
    } catch (error) {
      emit.fileSkipped(file.path, `파일을 읽지 못했어요: ${String(error)}`);
      continue;
    }
    contents.set(file.path, source);

    const scan = scanPython(source);
    const definitions = collectDefinitions(scan);
    const statements = collectImports(scan);

    /*
     * One entry per name, keeping the first.
     *
     * A name can be defined twice in one file and both are real Python: a
     * `@property` and its `@x.setter` are two `def`s with one name, and a
     * platform branch — `if sys.platform == "win32": def normpath(...)` with an
     * `else:` beside it — is two more. Measured against CPython's own `ast`
     * over 4,000 real files, `os.py`, `ntpath.py`, `ssl.py` and `socket.py`
     * all do this.
     *
     * They collapse to one node either way, because the id is the natural key.
     * Collapsing them here as well is what keeps the list handed to the model
     * one-to-one with the nodes: two indices for one node means two ways to
     * name the same target, and the second would point at a line range that is
     * not the one the node carries.
     */
    const symbols: PythonSymbol[] = [];
    const seenSymbols = new Set<string>();

    for (const definition of definitions) {
      const ref: NodeRef = {
        type: "symbol",
        filePath: file.path,
        name: definition.name,
        ...(definition.container ? { container: definition.container } : {}),
      };
      if (seenSymbols.has(refKey(ref))) continue;
      seenSymbols.add(refKey(ref));

      symbols.push({
        ref,
        name: definition.name,
        ...(definition.container ? { container: definition.container } : {}),
        startLine: definition.startLine,
        endLine: definition.endLine,
        kind: definition.kind,
      });

      declare({
        ref,
        kind: definition.kind,
        startLine: definition.startLine,
        endLine: definition.endLine,
        metadata: {
          ...(definition.isAsync ? { async: true } : {}),
          ...(definition.decorators.length > 0
            ? { decorators: definition.decorators }
            : {}),
        },
      });
    }

    const imports: Parsed["imports"] = [];
    const packages: Parsed["packages"] = [];
    const aliases = new Map<string, string>();

    for (const statement of statements) {
      const specifier = `${".".repeat(statement.level)}${statement.module}`;

      /*
       * `from broker import place_order as po` binds `po` to a symbol, and the
       * LLM pass needs that to recognise `po(...)` as a call to `place_order`.
       *
       * `import broker as b` is deliberately NOT recorded: it renames a module,
       * not a symbol, and `b.place_order()` still spells `place_order` on the
       * line — so there is nothing for an alias to rescue and a module name in
       * this table could only ever produce a false match against a symbol that
       * happened to share it.
       */
      for (const imported of statement.names) {
        if (imported.alias) aliases.set(imported.alias, imported.name);
      }

      const targets = importTargets(moduleIndex, file.path, statement);
      if (targets.length > 0) {
        for (const target of targets) {
          /*
           * `from broker import place_order` names a file AND a symbol inside
           * it. The edge points at the file — that is the connection the map
           * draws — but which names were taken is a fact the parser read
           * straight off the line, so it is recorded rather than thrown away.
           *
           * A target that is itself a submodule (`from . import db`) carries
           * that one name, not the whole statement's list.
           */
          const names = target.name
            ? [target.name]
            : statement.names.map((imported) => imported.name);
          imports.push({
            path: target.path,
            line: statement.line,
            specifier,
            names,
          });
        }
        continue;
      }

      /*
       * Nothing in the tree answers to this name, so it is either the standard
       * library or something installed. A relative import that resolves to
       * nothing is neither — it is a broken import, or a file ingest left out —
       * and inventing a package called `.db` for it would put a thing on the
       * map that exists nowhere.
       */
      if (statement.level > 0 || !statement.module) continue;

      const declaredName = packageIndex.lookup(topLevelModule(statement.module));
      if (!declaredName) continue;
      packages.push({ name: declaredName, line: statement.line, specifier });
    }

    parsed.push({ file, symbols, imports, packages, aliases, code: scan.code });
    emit.fileParsed(file.path);
  }

  for (const [name, manifest] of packageIndex.declaredIn) {
    declare({
      ref: { type: "package", filePath: "", name },
      metadata: { ecosystem: "pip", declaredIn: manifest },
    });
  }

  emit.nodes(nodes);

  // ---- Pass B: the certain edges -------------------------------------------

  const edges: AnalyzedEdge[] = [];
  const seenEdges = new Set<string>();

  const addEdge = (edge: AnalyzedEdge): boolean => {
    // Never point at something we did not create, and never at ourselves. A
    // dangling target is a foreign-key violation or a phantom row, and a
    // self-loop is the highest-weight edge on the map for a fact nobody asked
    // about (D32, D35).
    if (!declared.has(refKey(edge.source))) return false;
    if (!declared.has(refKey(edge.target))) return false;
    if (refKey(edge.source) === refKey(edge.target)) return false;

    const key = JSON.stringify([edge.type, refKey(edge.source), refKey(edge.target)]);
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    edges.push(edge);
    return true;
  };

  // The manifest itself uses everything it declares — the edge that survives
  // even when no source file can be read at all.
  for (const [manifestPath, names] of packageIndex.declaredBy) {
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

  const importedBy = new Map<string, number>();

  for (const entry of parsed) {
    const fileRef: NodeRef = { type: "file", filePath: entry.file.path };

    for (const symbol of entry.symbols) {
      addEdge({
        source: fileRef,
        target: symbol.ref,
        type: "contains",
        confidence: "certain",
        metadata: { kind: symbol.kind },
      });
    }

    for (const imported of entry.imports) {
      const added = addEdge({
        source: fileRef,
        target: { type: "file", filePath: imported.path },
        type: "imports",
        // Certain, and this is the claim the whole parser half rests on:
        // Python's import system is file paths, so `from .db import save` in
        // `shop/orders.py` means `shop/db.py` and nothing else. There is no
        // alias map, no bundler and no `exports` field to be wrong about.
        confidence: "certain",
        metadata: {
          specifier: imported.specifier,
          line: imported.line,
          ...(imported.names.length > 0 ? { names: imported.names } : {}),
        },
      });
      if (added) {
        importedBy.set(imported.path, (importedBy.get(imported.path) ?? 0) + 1);
      }
    }

    for (const used of entry.packages) {
      addEdge({
        source: fileRef,
        target: { type: "package", filePath: "", name: used.name },
        type: "uses_package",
        // A lookup in the project's own dependency list, not a resolution —
        // the same correction D26 made for the shallow layer.
        confidence: "certain",
        metadata: { specifier: used.specifier, line: used.line },
      });
    }
  }

  /*
   * Streamlit's pages, which are the only addresses a Python project in this
   * database actually has.
   *
   * Measured before this existed: of four real projects, three produced no
   * entry point at all and 흐름 따라가기 refused on every one of them. The
   * first guess was unparsed Flask or Django decorators and it was wrong —
   * there is no Flask, FastAPI or Django in any of them. `Kim-and-Chang-` is a
   * Streamlit app, and **Streamlit has no route decorators**: its pages are a
   * file convention, the same shape Next.js `app/` is, so `streamlit.ts` reads
   * it the way `typescript/routes.ts` reads that one.
   *
   * **The route is a SIBLING of its file's symbols, not their parent**, and
   * that shape is load-bearing rather than incidental. `lib/graph/flow.ts`
   * builds `fileOf` from `file --contains--> route` and `symbolsOf` from
   * `file --contains--> symbol`, and its entry joint steps from the address to
   * the file to the symbols beside it. A route emitted as the parent of the
   * symbols would exist, draw on the map, and lead nowhere — with nothing
   * anywhere saying so, because "no path" looks identical whether the code has
   * none or we failed to walk it.
   */
  const streamlitRoutes = looksLikeStreamlit({
    paths: files.map((file) => file.path),
    packages: [...packageIndex.declaredIn.keys()],
  })
    ? streamlitPages({
        paths: sourceFiles.map((file) => file.path),
        importsStreamlit: (path) =>
          (parsed.find((entry) => entry.file.path === path)?.packages ?? []).some(
            (used) => used.name.toLowerCase() === "streamlit",
          ),
        importedBy: (path) => importedBy.get(path) ?? 0,
      })
    : [];

  /*
   * The sibling `contains`, and the edges that make the address reachable.
   *
   * Declared and linked here rather than in Pass A because `soleEntry` asks
   * which files nothing imports, and that count is only complete once every
   * import edge has been added. The nodes are emitted on their own, the way
   * Pass C emits its edges, so the progress count stays true.
   */
  const routeNodes: AnalyzedNode[] = [];
  for (const page of streamlitRoutes) {
    const ref: NodeRef = { type: "route", filePath: page.filePath, name: page.urlPath };
    const node: AnalyzedNode = {
      ref,
      metadata: { via: "streamlit", home: page.home },
    };
    declare(node);
    routeNodes.push(node);

    addEdge({
      source: { type: "file", filePath: page.filePath },
      target: ref,
      type: "contains",
      // The address itself is `inferred` — which script you run is a command
      // line, not a file in the repository — so the link that says this file
      // answers to it cannot be stronger than the claim it carries.
      confidence: "inferred",
      metadata: { via: "streamlit" },
    });
  }
  if (routeNodes.length > 0) emit.nodes(routeNodes);

  emit.edges(edges);

  // ---- Pass C: what a model can see and a parser cannot ---------------------

  if (!options.llm || parsed.length === 0) {
    emit.phase("done");
    return { nodes, edges };
  }

  emit.phase("semantic");

  const symbolsByFile = new Map<string, PythonSymbol[]>();
  for (const entry of parsed) symbolsByFile.set(entry.file.path, entry.symbols);

  // Asked of the graph as it stands: every node and every import the parser
  // half produced, and none of what the model is about to add.
  const setAside = options.setAside?.({ nodes, edges }) ?? new Map<string, unknown>();
  const read = parsed.filter((entry) => !setAside.has(normalizePath(entry.file.path)));
  const facts: PythonFileFacts[] = read.map((entry) => ({
    path: entry.file.path,
    source: contents.get(entry.file.path) ?? "",
    code: entry.code,
    symbols: entry.symbols,
    importedPaths: [...new Set(entry.imports.map((imported) => imported.path))],
    aliases: entry.aliases,
    importedBy: importedBy.get(entry.file.path) ?? 0,
  }));

  const llmResult = await runPythonLlmPass({
    llm: options.llm,
    files: facts,
    symbolsByFile,
    declared: (ref) => declared.has(refKey(ref)),
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.recall ? { recall: options.recall } : {}),
  });

  const inferred: AnalyzedEdge[] = [];
  for (const edge of llmResult.edges) {
    if (addEdge(edge)) inferred.push(edge);
  }
  if (inferred.length > 0) emit.edges(inferred);

  /*
   * Roles and coverage go onto the node objects that were already emitted.
   *
   * The pipeline persists what `analyze` RETURNS and only counts what the
   * emitter reports, so mutating these in place is what puts them in the
   * database without double-counting the nodes in the progress stream.
   */
  for (const { ref, role } of llmResult.roles) {
    const node = nodeByKey.get(refKey(ref));
    if (!node) continue;
    node.metadata = { ...node.metadata, role, roleOrigin: "llm" };
  }

  // A file with nothing to ask is flagged exactly as it always was: nothing
  // in it is missing. Only the sentence's count of files opened leaves it
  // out (D179, `pythonLlmCoverage`), so no stored row changes meaning.
  const examined = new Set([...llmResult.examined, ...llmResult.nothingToAsk]);
  for (const entry of read) {
    const node = nodeByKey.get(refKey({ type: "file", filePath: entry.file.path }));
    if (!node) continue;
    const remembered = llmResult.remembered.get(entry.file.path);
    node.metadata = {
      ...node.metadata,
      llmExamined: examined.has(entry.file.path),
      // Kept on the node the pipeline persists, so the next run can recall it
      // instead of asking the same question again.
      ...(remembered ? { [LLM_ANSWER_KEY]: remembered } : {}),
    };
  }

  options.onLlmResult?.(llmResult);

  emit.phase("done");
  return { nodes, edges };
}

/**
 * How much of the project the model actually read, for the sentence a user is
 * owed when the answer is "not all of it".
 *
 * Derived from the nodes rather than held separately, so it stays true after a
 * graph has been round-tripped through the database — which is where the number
 * is read from when somebody opens a project a day later.
 */
export function pythonLlmCoverage(
  nodes: readonly AnalyzedNode[],
  /**
   * Files this run's model half had nothing to ask about
   * (`PythonLlmResult.nothingToAsk`). Flagged as looked at, because nothing
   * in them is missing, and left out of `examined`, because the sentence built
   * from it says the model opened them and it did not (D179).
   */
  nothingToAsk: readonly string[] = [],
): {
  examined: number;
  notExamined: number;
} {
  let examined = 0;
  let notExamined = 0;
  const unasked = new Set(nothingToAsk.map(normalizePath));

  for (const node of nodes) {
    const flag = (node.metadata as { llmExamined?: unknown } | undefined)?.llmExamined;
    if (flag === true) {
      if (!unasked.has(normalizePath(node.ref.filePath))) examined += 1;
    } else if (flag === false) notExamined += 1;
  }

  return { examined, notExamined };
}
