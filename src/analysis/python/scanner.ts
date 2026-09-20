/**
 * Reading a Python file the way the interpreter's tokenizer reads it, and not
 * the way a pile of regexes reads it.
 *
 * The shallow analyzer gets away with independent regexes because everything it
 * claims from them is a literal path, and a missed one costs a line on the map.
 * The Python analyzer cannot: it claims that a `def` is a top-level symbol, and
 * **indentation is the only evidence for that claim**. A regex sweep for
 * `^\s*def ` cannot tell a module-level function from a closure four levels
 * deep inside another one, and it cannot tell code from a docstring. Both
 * failures are silent — the node list is simply wrong, nothing downstream can
 * detect it, and the user is told their project contains functions that do not
 * exist as they are drawn.
 *
 * So this is a scanner with state: it knows whether it is inside a string,
 * which quote opened it, how deep the brackets are, and what column the current
 * logical line starts at. Three states, and each one exists because getting it
 * wrong produces a specific wrong claim:
 *
 *   1. **Strings.** `"""...def foo(): ..."""` is a docstring — a very common
 *      way to write an example in Python — and admitting `foo` would invent a
 *      function nobody wrote. `SQL = "select * from t # not a comment"` is the
 *      same problem from the other side.
 *   2. **Comments.** A commented-out `# import broker` is not an import, and an
 *      edge drawn from one is a connection the user's program does not have.
 *   3. **Continuations.** `from x import (\n  a,\n  b,\n)` is one statement
 *      across four lines, and a line-at-a-time reader sees an `import` with no
 *      names followed by three lines of nonsense.
 *
 * What comes out is a list of *logical* lines: one statement each, with its
 * indent measured, its comments gone, and every string literal emptied to `""`
 * so the shape of the statement survives but nothing inside a string can be
 * mistaken for code.
 */

/** One statement, however many physical lines it was written across. */
export type PythonLogicalLine = {
  /** Column of the first non-blank character, tabs expanded the way Python does. */
  indent: number;
  /**
   * The statement's code: comments removed, string contents emptied, runs of
   * whitespace collapsed to one space. Safe to match patterns against.
   */
  text: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
};

export type PythonScan = {
  logical: PythonLogicalLine[];
  /**
   * Per physical line, that line's code with comments removed and strings
   * emptied — index 0 is line 1.
   *
   * Kept alongside the logical lines because the LLM pass verifies a claimed
   * call against the text of the line it was claimed on, and a claim must be
   * checked against code rather than against a comment that happens to mention
   * the function's name.
   */
  code: string[];
};

type StringState = { delim: string; triple: boolean };

type ScanState = {
  string: StringState | null;
  depth: number;
};

export function scanPython(source: string): PythonScan {
  const physical = source.split(/\r?\n/);
  const state: ScanState = { string: null, depth: 0 };

  const logical: PythonLogicalLine[] = [];
  const code: string[] = [];

  let pending: { parts: string[]; indent: number; startLine: number } | null = null;

  for (let index = 0; index < physical.length; index++) {
    const raw = physical[index];
    const lineNumber = index + 1;

    // A blank or comment-only line starts nothing. Skipping them here rather
    // than filtering later is what keeps a block's `endLine` off the trailing
    // blank lines before the next `def`.
    if (pending === null) {
      const indent = measureIndent(raw);
      if (indent === null) {
        code.push("");
        continue;
      }
      pending = { parts: [], indent, startLine: lineNumber };
    }

    const consumed = consumeLine(raw, state);
    code.push(consumed.text);
    pending.parts.push(consumed.text);

    if (consumed.continues) continue;

    logical.push({
      indent: pending.indent,
      text: normalize(pending.parts.join(" ")),
      startLine: pending.startLine,
      endLine: lineNumber,
    });
    pending = null;
  }

  // An unterminated bracket or triple-quote at end of file. Python would refuse
  // the file; we keep what we read rather than dropping the whole module, since
  // a half-written file still tells the user what is in it.
  if (pending !== null) {
    logical.push({
      indent: pending.indent,
      text: normalize(pending.parts.join(" ")),
      startLine: pending.startLine,
      endLine: physical.length,
    });
  }

  return { logical, code };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The column a line's code starts at, or null when the line holds no code.
 *
 * A tab advances to the next multiple of eight, which is Python's own rule for
 * indentation (`tokenize` does exactly this). Getting it wrong by treating a
 * tab as one column would put a tab-indented method at column 1 and a
 * space-indented sibling at column 4, and the block stack would then read one
 * as nested inside the other.
 */
function measureIndent(raw: string): number | null {
  let column = 0;
  for (const character of raw) {
    if (character === " ") {
      column += 1;
      continue;
    }
    if (character === "\t") {
      column += 8 - (column % 8);
      continue;
    }
    // A form feed resets the column. Rare, and free to honour.
    if (character === "\f") {
      column = 0;
      continue;
    }
    if (character === "#") return null;
    return column;
  }
  return null;
}

/**
 * One physical line, with the scanner's state carried in and out.
 *
 * `continues` means the statement is not over: an open bracket, an open
 * triple-quote, or a backslash that swallowed the newline.
 */
function consumeLine(
  raw: string,
  state: ScanState,
): { text: string; continues: boolean } {
  let text = "";
  let index = 0;
  let backslashEol = false;

  while (index < raw.length) {
    if (state.string) {
      // A backslash escapes the next character, **including inside a raw
      // string**. `r"\""` is a legal string containing `\"`, and a scanner that
      // treated the backslash as ordinary inside `r"..."` would close the
      // string one quote early and read the rest of the file as code.
      if (raw[index] === "\\") {
        index += 2;
        continue;
      }
      if (raw.startsWith(state.string.delim, index)) {
        index += state.string.delim.length;
        state.string = null;
        // The literal becomes an empty one, so `x = "def f():"` keeps its shape
        // as an assignment and loses everything that could be misread as code.
        text += '""';
        continue;
      }
      index += 1;
      continue;
    }

    const character = raw[index];

    if (character === "#") break;

    if (character === '"' || character === "'") {
      const triple = raw.startsWith(character.repeat(3), index);
      state.string = { delim: triple ? character.repeat(3) : character, triple };
      index += triple ? 3 : 1;
      continue;
    }

    // A string prefix needs no special case: `f`, `rb` and friends are ordinary
    // identifier characters that fall through to the append below, and the
    // quote that follows opens the string on its own.

    if (character === "\\" && index === raw.length - 1) {
      backslashEol = true;
      index += 1;
      continue;
    }

    if (character === "(" || character === "[" || character === "{") {
      state.depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      // Clamped: an unbalanced closer in a half-written file must not drive the
      // depth negative, or every following line would look like a continuation.
      state.depth = Math.max(0, state.depth - 1);
    }

    text += character;
    index += 1;
  }

  // `index > raw.length` means the last backslash consumed the newline itself.
  const escapedNewline = index > raw.length;

  if (state.string && !state.string.triple && !escapedNewline) {
    // An unterminated single-quoted string. Python calls this a syntax error;
    // carrying the state to the next line would make the whole rest of the file
    // read as string contents, so the damage is contained to this line.
    state.string = null;
    text += '""';
  }

  return {
    text,
    continues: state.string !== null || state.depth > 0 || backslashEol || escapedNewline,
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type PythonDefinition = {
  name: string;
  kind: "function" | "class";
  /** The class a method belongs to. Unset for a module-level declaration. */
  container?: string;
  /** First decorator line when there is one, else the `def`/`class` line. */
  startLine: number;
  endLine: number;
  decorators: string[];
  isAsync: boolean;
};

export type ImportedName = { name: string; alias?: string };

export type PythonImport = {
  /** Leading dots: 0 is absolute, 1 is "this package", 2 is one above it. */
  level: number;
  /** The dotted module, or "" for `from . import x`. */
  module: string;
  /** The names after `import`. Empty for a plain `import x`. */
  names: ImportedName[];
  /** `import x as y` binds `y` in this file. */
  alias?: string;
  /** True for `from x import y`, false for `import x`. */
  fromForm: boolean;
  line: number;
};

/**
 * A compound statement whose whole body was written on the header's own line.
 *
 * `if not re: import re` is one statement, and the import in it is real — the
 * standard library does exactly this, and `if TYPE_CHECKING: import x` is the
 * everyday form of it. Without stripping the header the line starts with `if`
 * and no import is found at all.
 *
 * `[^:]*` rather than anything cleverer, so a header containing its own colon —
 * a slice or a dict — simply fails to match and the line is left alone. That
 * loses an import we would not otherwise have had, which is the safe direction:
 * the alternative is picking the wrong colon and reading half an expression as
 * a statement.
 */
const INLINE_SUITE = /^(?:if|elif|else|while|for|with|try|except|finally)\b[^:]*:\s*/;

const DEF = /^(async\s+)?def\s+([A-Za-z_]\w*)/;
const CLASS = /^class\s+([A-Za-z_]\w*)/;
const FROM_IMPORT = /^from\s+(\.*)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?\s+import\s+(.+)$/;
const PLAIN_IMPORT = /^import\s+(.+)$/;

/**
 * What a Python file declares, with nesting resolved.
 *
 * The block stack is the whole of it. A `def` is a node when nothing encloses
 * it, and a method when exactly one class encloses it; anything deeper is a
 * closure, a method of a class defined inside a function, or a helper defined
 * inside a method — none of which is a thing the user has a name for at the
 * top of a file, and all of which would collide with the real declarations if
 * admitted.
 *
 * A `def` under `if`/`try`/`with` at module level is still treated as
 * top-level, because those do not create a scope in Python: a function defined
 * inside `if TYPE_CHECKING:` or inside `try: ... except ImportError:` is a
 * module-level name and is exactly how conditional definitions are written.
 */
export function collectDefinitions(scan: PythonScan): PythonDefinition[] {
  const found: PythonDefinition[] = [];
  type Block = { indent: number; kind: "function" | "class"; name: string; at: number };
  const stack: Block[] = [];

  let decorators: string[] = [];
  let decoratorLine: number | null = null;
  let lastEnd = 0;

  const closeTopWhile = (keepOpen: (block: Block) => boolean) => {
    for (let top = stack[stack.length - 1]; top && !keepOpen(top); ) {
      if (top.at >= 0) found[top.at].endLine = lastEnd;
      stack.pop();
      top = stack[stack.length - 1];
    }
  };

  for (const line of scan.logical) {
    closeTopWhile((block) => block.indent < line.indent);

    if (line.text.startsWith("@")) {
      if (decoratorLine === null) decoratorLine = line.startLine;
      // The decorator's name only. Its arguments have had their strings
      // emptied by the scanner, so `@app.route("/orders")` survives here as
      // `@app.route("")` — recording that would put a path on the map that is
      // not the path anybody wrote. The name is the part that is still true.
      const named = /^@([\w.]+)/.exec(line.text);
      if (named) decorators.push(named[1]);
      lastEnd = line.endLine;
      continue;
    }

    // A statement can hold several simple statements separated by `;`, but a
    // `def` or a `class` is a compound statement and can only be first.
    const head = line.text.split(";")[0].trim();

    const asClass = CLASS.exec(head);
    const asDef = asClass ? null : DEF.exec(head);

    const name = asClass ? asClass[1] : asDef?.[2];
    if (name) {
      const kind = asClass ? "class" : "function";
      const isAsync = Boolean(asDef?.[1]);

      // Exactly one enclosing class makes this a method; anything else makes it
      // either top-level (empty stack) or nested (no node).
      const enclosing = stack[stack.length - 1];
      const topLevel = stack.length === 0;
      const method = stack.length === 1 && enclosing.kind === "class";

      let at = -1;
      if (topLevel || method) {
        at = found.length;
        found.push({
          name,
          kind,
          ...(method ? { container: enclosing.name } : {}),
          startLine: decoratorLine ?? line.startLine,
          endLine: line.endLine,
          decorators,
          isAsync,
        });
      }

      stack.push({ indent: line.indent, kind, name, at });
      decorators = [];
      decoratorLine = null;
      lastEnd = line.endLine;
      continue;
    }

    decorators = [];
    decoratorLine = null;
    lastEnd = line.endLine;
  }

  closeTopWhile(() => false);

  return found;
}

/**
 * Every import in the file, in whichever of Python's forms it was written.
 *
 * Imports inside a function body are collected too. They are real — a deferred
 * import to break a cycle is ordinary Python — and the file genuinely does
 * depend on what they name.
 */
export function collectImports(scan: PythonScan): PythonImport[] {
  const found: PythonImport[] = [];

  for (const line of scan.logical) {
    for (const statement of line.text.split(";")) {
      const text = statement.trim().replace(INLINE_SUITE, "");

      const relative = FROM_IMPORT.exec(text);
      if (relative) {
        found.push({
          level: relative[1].length,
          module: relative[2] ?? "",
          names: parseImportedNames(relative[3]),
          fromForm: true,
          line: line.startLine,
        });
        continue;
      }

      const plain = PLAIN_IMPORT.exec(text);
      if (!plain) continue;

      for (const clause of plain[1].split(",")) {
        const parsed = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(
          clause.trim(),
        );
        if (!parsed) continue;
        found.push({
          level: 0,
          module: parsed[1],
          names: [],
          ...(parsed[2] ? { alias: parsed[2] } : {}),
          fromForm: false,
          line: line.startLine,
        });
      }
    }
  }

  return found;
}

/**
 * `(a, b as c,)` -> two names. The parentheses and the trailing comma are both
 * legal and both common in a real file's import block.
 */
function parseImportedNames(raw: string): ImportedName[] {
  const inner = raw.trim().replace(/^\(/, "").replace(/\)$/, "");
  const names: ImportedName[] = [];

  for (const clause of inner.split(",")) {
    const text = clause.trim();
    if (!text) continue;
    if (text === "*") {
      names.push({ name: "*" });
      continue;
    }
    const parsed = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(text);
    if (!parsed) continue;
    names.push({ name: parsed[1], ...(parsed[2] ? { alias: parsed[2] } : {}) });
  }

  return names;
}
