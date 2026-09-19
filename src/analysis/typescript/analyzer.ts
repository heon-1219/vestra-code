import path from "node:path";

import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type SourceFile as TsSourceFile,
  type Symbol as TsSymbol,
} from "ts-morph";

import { normalizePath, type NodeRef } from "@/analysis/ids";
import type {
  AnalysisEmitter,
  AnalyzedEdge,
  AnalyzedNode,
  Analyzer,
  SourceFile,
  SymbolKind,
} from "@/analysis/types";

import { classifyRoute } from "./routes";
import { resolveAliasConfig } from "./tsconfig";

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/**
 * A key that identifies a node ref without hashing it. Analyzers never hash.
 *
 * JSON rather than a delimiter string on purpose. Any separator has to be a
 * character that cannot occur in a path or a name, which in practice means a
 * control character — and a literal control character in source is exactly
 * what gets silently rewritten in transit, turning `a/b c` and `a/b`+`c` into
 * the same key and quietly merging two different nodes. JSON encodes the
 * boundary structurally, so there is nothing to mangle.
 */
function refKey(ref: NodeRef): string {
  return JSON.stringify([
    ref.type,
    normalizePath(ref.filePath),
    ref.container ?? "",
    ref.name ?? "",
  ]);
}

export function createTypescriptAnalyzer(): Analyzer {
  return {
    name: "typescript",
    handles: (kind) => kind === "nextjs" || kind === "react_spa",
    analyze: (files, root, emit) => Promise.resolve(run(files, root, emit)),
  };
}

function run(
  files: SourceFile[],
  repoRoot: string,
  emit: AnalysisEmitter,
): { nodes: AnalyzedNode[]; edges: AnalyzedEdge[] } {
  emit.phase("static");

  const sourceFiles = files.filter(
    (file) => file.read !== null && SOURCE_EXTENSIONS.test(file.path),
  );
  const existingPaths = new Set(files.map((file) => file.path));

  const readFile = (absolutePath: string): string | undefined => {
    const wanted = normalizePath(path.relative(repoRoot, absolutePath));
    const match = files.find((file) => file.path === wanted);
    return match?.read?.();
  };

  const alias = resolveAliasConfig(repoRoot, existingPaths, readFile);

  const project = new Project({
    // Never point at the repo's tsconfig: that would import its include globs
    // (undoing ingest's filtering) and its target/strict/lib (which are exactly
    // the parts of a "broken" config we must not inherit).
    skipAddingFilesFromTsConfig: true,
    // With no node_modules there is nothing to chase, and chasing costs a full
    // resolution sweep.
    skipFileDependencyResolution: true,
    compilerOptions: {
      // Mandatory. Measured: with allowJs off, 0 of 17 files of the demo repo
      // enter the program AND zero diagnostics are reported — the run
      // "succeeds" and replaces the previous graph with nothing (D29).
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      // Decisive. Bundler resolves extensionless relative specifiers
      // (./Button -> Button.tsx | .jsx | /index.tsx) and honours `paths` with
      // or without baseUrl. Node16/NodeNext require an explicit .js extension
      // and resolve ./Button to nothing — D15's failure from another direction.
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      noEmit: true,
      // Determinism: stop TypeScript auto-including @types/* if a stray
      // node_modules happens to exist beside the temp directory, which would
      // otherwise make the graph differ between a laptop and the server (D39).
      types: [],
      typeRoots: [],
      baseUrl: alias.baseUrl,
      paths: alias.paths,
    },
  });

  // Enumerate, never glob. A glob re-walks the tree and re-includes exactly
  // what ingest excluded, and the two exclusion lists then drift forever.
  const added = new Map<string, { file: SourceFile; source: TsSourceFile }>();
  for (const file of sourceFiles) {
    try {
      const source = project.createSourceFile(
        file.absolutePath,
        file.read?.() ?? "",
        { overwrite: true },
      );
      added.set(file.path, { file, source });
    } catch (error) {
      emit.fileSkipped(file.path, String(error));
    }
  }

  // A merge-conflict file does NOT throw — the parser recovers and yields
  // usable statements, so a try/catch never fires and the file would be
  // silently half-analysed. Syntactic diagnostics are the real signal, and
  // specifically NOT getPreEmitDiagnostics, which also reports type errors that
  // are entirely expected here since no dependency is installed (D38).
  const program = project.getProgram();
  for (const [repoPath, entry] of [...added]) {
    const syntactic = program.getSyntacticDiagnostics(entry.source);
    if (syntactic.length > 0) {
      emit.fileSkipped(repoPath, `구문 오류 ${syntactic.length}건`);
      added.delete(repoPath);
    }
  }

  // The tripwire for every silent-emptiness failure: allowJs off, a wrong
  // moduleResolution, an unreadable tree. The run must fail loudly rather than
  // succeed with nothing and let D20's sweep replace a good graph (D36).
  if (sourceFiles.length > 0 && added.size === 0) {
    throw new Error(
      `analyzer produced no parseable files from ${sourceFiles.length} source files`,
    );
  }

  const nodes: AnalyzedNode[] = [];
  const declared = new Set<string>();

  const declare = (node: AnalyzedNode) => {
    const key = refKey(node.ref);
    if (declared.has(key)) return;
    declared.add(key);
    nodes.push(node);
  };

  // ---- Pass A: nodes -------------------------------------------------------
  // Every node first, then every edge. Edges have foreign keys to nodes, and a
  // renders edge is routinely emitted before its target file is parsed, so the
  // brief's "loop each file, write nodes and edges" is not implementable (D31).

  // Files, including assets — "nothing uses this photo" needs the photo.
  for (const file of files) {
    declare({
      ref: { type: "file", filePath: file.path },
      metadata: file.read === null ? { asset: true, size: file.size } : { size: file.size },
    });
  }

  for (const file of files) {
    const hit = classifyRoute(file.path);
    if (!hit) continue;
    declare({
      ref: { type: hit.kind, filePath: file.path, name: hit.urlPath },
      metadata: { urlPath: hit.urlPath },
    });
  }

  const symbolsByName = new Map<string, NodeRef[]>();

  for (const [repoPath, { source }] of added) {
    for (const decl of collectDeclarations(source)) {
      const ref: NodeRef = {
        type: "symbol",
        filePath: repoPath,
        name: decl.name,
        ...(decl.container ? { container: decl.container } : {}),
      };
      declare({
        ref,
        kind: decl.kind,
        startLine: decl.startLine,
        endLine: decl.endLine,
        metadata: { exported: decl.exported },
      });
      const list = symbolsByName.get(decl.name) ?? [];
      list.push(ref);
      symbolsByName.set(decl.name, list);
    }
    emit.fileParsed(repoPath);
  }

  emit.nodes(nodes);

  // ---- Pass B: edges -------------------------------------------------------

  const edges: AnalyzedEdge[] = [];
  const seenEdges = new Set<string>();

  const addEdge = (edge: AnalyzedEdge) => {
    // D35: never point at something we did not create. A JSX tag bound to a
    // destructured prop resolves *successfully* to a BindingElement, passing
    // every "did the checker answer" test, and yields an edge to a node that
    // never existed — a foreign-key violation or a phantom node.
    if (!declared.has(refKey(edge.source))) return;
    if (!declared.has(refKey(edge.target))) return;
    // D32: attribution makes components call themselves. 133 self-loops on the
    // demo repo, and the six highest-weight edges in the graph were self-loops.
    if (refKey(edge.source) === refKey(edge.target)) return;

    const key = JSON.stringify([edge.type, refKey(edge.source), refKey(edge.target)]);
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(edge);
  };

  for (const [repoPath, { source }] of added) {
    const fileRef: NodeRef = { type: "file", filePath: repoPath };

    // contains: file -> symbol. Never crosses a file boundary, so it is a
    // direct read rather than a resolution — always certain.
    for (const decl of collectDeclarations(source)) {
      addEdge({
        source: fileRef,
        target: {
          type: "symbol",
          filePath: repoPath,
          name: decl.name,
          ...(decl.container ? { container: decl.container } : {}),
        },
        type: "contains",
        confidence: "certain",
      });
    }

    // contains: file -> route / api_endpoint.
    const hit = classifyRoute(repoPath);
    if (hit) {
      addEdge({
        source: fileRef,
        target: { type: hit.kind, filePath: repoPath, name: hit.urlPath },
        type: "contains",
        confidence: "certain",
      });
    }

    // imports and packages.
    for (const decl of source.getImportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue();
      const target = decl.getModuleSpecifierSourceFile();

      const targetPath = target
        ? normalizePath(path.relative(repoRoot, target.getFilePath()))
        : null;
      const resolvedInsideRepo = targetPath !== null && !targetPath.startsWith("..");

      if (resolvedInsideRepo) {
        addEdge({
          source: fileRef,
          target: { type: "file", filePath: targetPath },
          type: "imports",
          confidence: "certain",
          metadata: { specifier },
        });
        continue;
      }

      /**
       * Either unresolved, or resolved to something outside the repository.
       *
       * The second case is not hypothetical and it is not harmless. A stray
       * `node_modules` above the system temp directory on the founder's machine
       * makes `react` resolve to a real file there, so it would be treated as an
       * in-repo import and then silently dropped for pointing outside the repo —
       * while on the server, with no such directory, the same import resolves to
       * nothing and correctly becomes a package. The same repository would
       * produce two different graphs depending on the machine (D39).
       *
       * Deciding on repo membership rather than on whether resolution succeeded
       * makes both environments agree.
       */
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        declare({ ref: { type: "package", filePath: "", name: packageName } });
        addEdge({
          source: fileRef,
          target: { type: "package", filePath: "", name: packageName },
          type: "uses_package",
          confidence: "certain",
          metadata: { specifier },
        });
      }
    }

    collectCallAndRenderEdges({
      source,
      repoPath,
      repoRoot,
      symbolsByName,
      declared,
      addEdge,
    });
  }

  emit.edges(edges);
  emit.phase("done");

  return { nodes, edges };
}

// ---------------------------------------------------------------------------

type DeclarationInfo = {
  name: string;
  container?: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
};

/** Wrappers whose argument is still the component a person wrote. */
const COMPONENT_WRAPPERS = new Set([
  "memo",
  "forwardRef",
  "observer",
  "dynamic",
  "styled",
]);

function collectDeclarations(source: TsSourceFile): DeclarationInfo[] {
  const found: DeclarationInfo[] = [];

  const push = (
    name: string,
    node: Node,
    kind: SymbolKind,
    exported: boolean,
    container?: string,
  ) => {
    if (!name) return;
    found.push({
      name,
      ...(container ? { container } : {}),
      kind,
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      exported,
    });
  };

  for (const fn of source.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    push(name, fn, classifyFunction(name, fn), fn.isExported());
  }

  for (const cls of source.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    push(name, cls, "class", cls.isExported());
    // Methods carry the class as their container, so three render() methods in
    // one file stay three nodes rather than collapsing into one (D27).
    for (const method of cls.getMethods()) {
      push(method.getName(), method, "function", false, name);
    }
  }

  for (const iface of source.getInterfaces()) {
    push(iface.getName(), iface, "type", iface.isExported());
  }
  for (const alias of source.getTypeAliases()) {
    push(alias.getName(), alias, "type", alias.isExported());
  }

  for (const statement of source.getVariableStatements()) {
    const exported = statement.isExported();
    for (const declaration of statement.getDeclarations()) {
      const name = declaration.getName();
      const initializer = declaration.getInitializer();
      if (!initializer) continue;

      if (
        Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer)
      ) {
        push(name, declaration, classifyFunction(name, initializer), exported);
        continue;
      }

      // `const Card = memo(function Card() {...})` is still a component. A bare
      // call expression is not — `const LAST_DAY = Math.max(...)` is a constant,
      // and admitting it as a function was a measured mistake in an earlier
      // design.
      if (Node.isCallExpression(initializer)) {
        const callee = initializer.getExpression().getText().split(".").pop() ?? "";
        if (COMPONENT_WRAPPERS.has(callee)) {
          push(name, declaration, /^[A-Z]/.test(name) ? "component" : "function", exported);
        }
      }
    }
  }

  return found;
}

/**
 * A component is capitalised AND returns JSX. Both are required.
 *
 * Capitalisation alone admits every exported constant factory; JSX alone
 * admits helpers that happen to build an element. Neither test is right by
 * itself, and this pair is wrong far less often than either.
 */
function classifyFunction(name: string, node: Node): SymbolKind {
  const capitalised = /^[A-Z]/.test(name);
  const isHookName = /^use[A-Z]/.test(name);
  if (isHookName) return "hook";

  if (capitalised && containsJsx(node)) return "component";
  return "function";
}

function containsJsx(node: Node): boolean {
  return (
    node.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
    node.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
    node.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined
  );
}

// ---------------------------------------------------------------------------

function collectCallAndRenderEdges(context: {
  source: TsSourceFile;
  repoPath: string;
  repoRoot: string;
  symbolsByName: Map<string, NodeRef[]>;
  declared: Set<string>;
  addEdge: (edge: AnalyzedEdge) => void;
}): void {
  const { source, repoPath, repoRoot, symbolsByName, addEdge } = context;

  const enclosing = (node: Node): NodeRef | null => {
    let current: Node | undefined = node.getParent();
    while (current) {
      const ref = declarationRefOf(current, repoPath);
      if (ref) return ref;
      current = current.getParent();
    }
    return null;
  };

  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const from = enclosing(call);
    if (!from) continue;

    const target = resolveToProjectSymbol(
      call.getExpression(),
      repoRoot,
      symbolsByName,
    );
    if (!target) continue;

    addEdge({
      source: from,
      target: target.ref,
      type: "calls",
      confidence: target.confidence,
      metadata: { line: call.getStartLineNumber() },
    });
  }

  const jsxTags = [
    ...source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];

  for (const tag of jsxTags) {
    const nameNode = tag.getTagNameNode();
    const text = nameNode.getText();
    // Lowercase tags are intrinsic elements (`div`), not project components.
    if (!/^[A-Z]/.test(text.split(".")[0])) continue;

    const from = enclosing(tag);
    if (!from) continue;

    const target = resolveToProjectSymbol(nameNode, repoRoot, symbolsByName);
    if (!target) continue;

    addEdge({
      source: from,
      target: target.ref,
      type: "renders",
      confidence: target.confidence,
      metadata: { line: tag.getStartLineNumber() },
    });
  }
}

function declarationRefOf(node: Node, repoPath: string): NodeRef | null {
  if (Node.isFunctionDeclaration(node)) {
    const name = node.getName();
    return name ? { type: "symbol", filePath: repoPath, name } : null;
  }
  if (Node.isClassDeclaration(node)) {
    const name = node.getName();
    return name ? { type: "symbol", filePath: repoPath, name } : null;
  }
  if (Node.isMethodDeclaration(node)) {
    const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const container = cls?.getName();
    return {
      type: "symbol",
      filePath: repoPath,
      name: node.getName(),
      ...(container ? { container } : {}),
    };
  }
  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    if (
      initializer &&
      (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
    ) {
      return { type: "symbol", filePath: repoPath, name: node.getName() };
    }
  }
  return null;
}

/**
 * From an expression to the project symbol it refers to — or nothing.
 *
 * "Or nothing" is the important half. The brief's rule is that a wrong edge is
 * worse than a missing one, so every branch here that cannot honestly name a
 * target returns null rather than guessing.
 */
function resolveToProjectSymbol(
  expression: Node,
  repoRoot: string,
  symbolsByName: Map<string, NodeRef[]>,
): { ref: NodeRef; confidence: "certain" | "inferred" } | null {
  const identifier = expression.getLastChildByKind(SyntaxKind.Identifier) ?? expression;
  const symbol = identifier.getSymbol?.();

  if (symbol) {
    // D33: capture the FIRST declaration before following aliases. An import
    // from an uninstalled package returns the compiler's `unknown` symbol with
    // zero declarations — indistinguishable from "resolution failed" — and the
    // name-match fallback would then fabricate edges from `useRouter` onto a
    // same-named local helper.
    const first = symbol.getDeclarations()[0];
    if (first && isImportOrExportSpecifier(first)) {
      const resolved = followAliases(symbol);
      if (!resolved) return null;
      const ref = refFromDeclarations(resolved, repoRoot);
      return ref ? { ref, confidence: "certain" } : null;
    }

    const ref = refFromDeclarations(symbol, repoRoot);
    if (ref) return { ref, confidence: "certain" };
    return null;
  }

  // The inferred fallback: a bare name with exactly one match project-wide.
  // Ambiguity produces nothing — the brief says so explicitly.
  const name = identifier.getText();
  const candidates = symbolsByName.get(name);
  if (!candidates || candidates.length !== 1) return null;
  return { ref: candidates[0], confidence: "inferred" };
}

function isImportOrExportSpecifier(node: Node): boolean {
  return (
    Node.isImportSpecifier(node) ||
    Node.isImportClause(node) ||
    Node.isNamespaceImport(node) ||
    Node.isExportSpecifier(node)
  );
}

/**
 * One `getAliasedSymbol()` hop is not enough: a barrel file re-exports through
 * another barrel, and the intermediate is in-project, so stopping early yields
 * an edge that points at the barrel and looks `certain`.
 */
function followAliases(symbol: TsSymbol): TsSymbol | null {
  let current: TsSymbol | undefined = symbol;
  for (let hop = 0; hop < 8 && current; hop++) {
    const declarations = current.getDeclarations();
    if (declarations.length > 0 && !declarations.some(isImportOrExportSpecifier)) {
      return current;
    }
    const next: TsSymbol | undefined = current.getAliasedSymbol?.();
    if (!next || next === current) return null;
    current = next;
  }
  return null;
}

function refFromDeclarations(symbol: TsSymbol, repoRoot: string): NodeRef | null {
  const declarations = symbol.getDeclarations();
  if (declarations.length === 0) return null;

  // D34: a .js file with no import or export is a SCRIPT, so its top-level
  // functions merge into one global scope with every other script file. A
  // symbol declared in two files would otherwise yield a `certain` edge to a
  // coin flip.
  const fileSet = new Set(declarations.map((d) => d.getSourceFile().getFilePath()));
  if (fileSet.size !== 1) return null;

  const declaration = declarations[0];
  const sourcePath = normalizePath(
    path.relative(repoRoot, declaration.getSourceFile().getFilePath()),
  );
  if (sourcePath.startsWith("..")) return null;

  const named = declaration.asKind(SyntaxKind.FunctionDeclaration)?.getName()
    ?? declaration.asKind(SyntaxKind.ClassDeclaration)?.getName()
    ?? declaration.asKind(SyntaxKind.VariableDeclaration)?.getName()
    ?? declaration.asKind(SyntaxKind.MethodDeclaration)?.getName()
    ?? symbol.getName();
  if (!named) return null;

  const container =
    declaration.asKind(SyntaxKind.MethodDeclaration) !== undefined
      ? declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getName()
      : undefined;

  return {
    type: "symbol",
    filePath: sourcePath,
    name: named,
    ...(container ? { container } : {}),
  };
}
