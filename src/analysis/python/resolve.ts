import { normalizePath } from "@/analysis/ids";
import { readManifest } from "@/analysis/shallow/manifests";

import type { PythonImport } from "./scanner";

/**
 * Turning an import statement into a file in this repository — or into nothing.
 *
 * This is the half of the Python analyzer that gets to say `certain`, and the
 * reason it can is that **Python's import system is file paths**. There is no
 * `paths` map, no bundler alias, no `exports` field: `from package.module
 * import x` means `package/module.py` or `package/module/__init__.py`, full
 * stop. Where TypeScript needed a whole compiler to answer the same question,
 * here a directory listing answers it.
 *
 * The one genuinely unknown is which directory the interpreter counts from,
 * because that is decided by how the program is launched rather than by
 * anything in the source. Two candidates are tried, in the order Python itself
 * would (see `sourceRootOf`), and the first that names a file in the tree wins.
 *
 * **Nothing is guessed into existence.** A module that resolves to no file in
 * the repository is either the standard library or an installed dependency, and
 * the caller decides which by looking it up in the project's own dependency
 * list. A name in neither produces silence — `import os` must not put a box
 * called `os` on somebody's map.
 */

export type ModuleIndex = {
  has: (repoPath: string) => boolean;
  /**
   * Where absolute imports in this file are counted from: the first ancestor
   * directory that is not itself a package.
   */
  sourceRootOf: (repoPath: string) => string;
  /** The file a module specifier names, or null when the repo has no such file. */
  resolve: (fromPath: string, level: number, module: string) => string | null;
};

export function createModuleIndex(paths: Iterable<string>): ModuleIndex {
  const files = new Set<string>();
  for (const path of paths) files.add(normalizePath(path));

  const isPackage = (directory: string): boolean =>
    files.has(directory === "" ? "__init__.py" : `${directory}/__init__.py`);

  /**
   * Walk up out of the package the file belongs to.
   *
   * This is Python's actual rule rather than a convention: an absolute import
   * is resolved from the entries on `sys.path`, and for a package the entry
   * that matters is the directory *containing* the top package — which is what
   * you reach by climbing while `__init__.py` keeps appearing. It is also what
   * makes the `src/` layout work with no special case: `src/shop/orders.py`
   * climbs out of `src/shop` and stops at `src`, so `from shop.db import save`
   * resolves.
   */
  const sourceRootOf = (repoPath: string): string => {
    let directory = parentOf(normalizePath(repoPath));
    while (directory !== "" && isPackage(directory)) {
      directory = parentOf(directory);
    }
    return directory;
  };

  const candidate = (base: string, segments: string[]): string | null => {
    const joined = [base, ...segments].filter(Boolean).join("/");
    if (!joined) return null;
    // A module file first, then the package's `__init__.py`. Both are the same
    // import to Python, and a repository never has both for one name.
    if (files.has(`${joined}.py`)) return `${joined}.py`;
    if (files.has(`${joined}/__init__.py`)) return `${joined}/__init__.py`;
    return null;
  };

  const resolve = (
    fromPath: string,
    level: number,
    module: string,
  ): string | null => {
    const segments = module ? module.split(".") : [];
    const here = normalizePath(fromPath);

    if (level > 0) {
      // `.` is the file's own package, `..` the one above it. A relative import
      // is fully determined — there is nothing to guess and nothing to fall
      // back to, so walking above the repository root is simply no answer.
      let directory = parentOf(here);
      for (let up = 1; up < level; up++) {
        if (directory === "") return null;
        directory = parentOf(directory);
      }
      return candidate(directory, segments);
    }

    /*
     * Absolute. The file's own source root first, because that is the entry
     * Python would use, and the repository root second.
     *
     * The second try is not the same guess as the first: it is what makes a
     * repository laid out as `backend/app.py` + `backend/db.py` work when the
     * analyzer is looking at the whole repository and the program is run from
     * inside `backend/`. First match wins rather than "exactly one match",
     * because unlike a bare name in TypeScript these two candidates are
     * *ordered* by the interpreter, so preferring the nearer one is the answer
     * Python would give rather than a coin flip between two equals.
     */
    for (const base of unique([sourceRootOf(here), ""])) {
      const hit = candidate(base, segments);
      if (hit) return hit;
    }
    return null;
  };

  return { has: (repoPath) => files.has(normalizePath(repoPath)), sourceRootOf, resolve };
}

/**
 * Every file one import statement names, which can be more than one.
 *
 * `from . import db` names a *module*, not a symbol, and so does `from
 * .models import user` when `models/user.py` exists. Missing that form is not a
 * small loss: a package's `__init__.py` re-exporting its submodules is the
 * standard way a Python package is assembled, and without this the file that
 * ties a package together would have no outgoing connections at all — the same
 * hollow-barrel failure the TypeScript analyzer had before re-exports were
 * counted.
 */
export function importTargets(
  index: ModuleIndex,
  fromPath: string,
  statement: PythonImport,
): { path: string; name?: string }[] {
  const targets: { path: string; name?: string }[] = [];

  const base = index.resolve(fromPath, statement.level, statement.module);
  if (base) targets.push({ path: base });

  if (statement.fromForm) {
    for (const imported of statement.names) {
      if (imported.name === "*") continue;
      const submodule = index.resolve(
        fromPath,
        statement.level,
        statement.module ? `${statement.module}.${imported.name}` : imported.name,
      );
      if (submodule && submodule !== base) {
        targets.push({ path: submodule, name: imported.name });
      }
    }
  }

  return targets;
}

function parentOf(repoPath: string): string {
  const cut = repoPath.lastIndexOf("/");
  return cut === -1 ? "" : repoPath.slice(0, cut);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * What the project declared it installed, so that an unresolved import can be
 * told apart from a dependency.
 *
 * Reading a dependency list is a lookup rather than a resolution, which is why
 * these come back `certain` — the same correction D26 made for the shallow
 * layer. The alternative, emitting a package for every unresolved name, would
 * cover a Django project's map in `os`, `sys`, `json` and `typing`: things
 * nobody installed, nobody thinks of as parts of their project, and which would
 * outnumber the real dependencies several times over.
 */
export type PackageIndex = {
  /** The declared package a module name belongs to, or null. */
  lookup: (moduleName: string) => string | null;
  /** Manifest path -> the packages it declares, for the manifest's own edges. */
  declaredBy: Map<string, string[]>;
  /** Package name -> the manifest that declared it. */
  declaredIn: Map<string, string>;
};

/**
 * Import name and distribution name are different strings, and for these the
 * difference is famous enough that a map without them looks broken.
 *
 * `import yaml` with `PyYAML` in `requirements.txt` is one dependency written
 * two ways, and dropping it would mean a project's own declared libraries are
 * missing from its map. The table is deliberately short and only ever *finds* a
 * package that is already declared — it can rename nothing into existence.
 */
const DISTRIBUTION_ALIASES: Record<string, string[]> = {
  bs4: ["beautifulsoup4"],
  cv2: ["opencv-python", "opencv-python-headless", "opencv-contrib-python"],
  dateutil: ["python-dateutil"],
  dotenv: ["python-dotenv"],
  fitz: ["pymupdf"],
  jwt: ["pyjwt"],
  pil: ["pillow"],
  serial: ["pyserial"],
  sklearn: ["scikit-learn"],
  skimage: ["scikit-image"],
  yaml: ["pyyaml"],
};

/** Every file we read a Python dependency list out of. */
const PYTHON_MANIFESTS = [
  { match: /(^|\/)requirements[^/]*\.txt$/i, reader: "requirements.txt" },
  { match: /(^|\/)pyproject\.toml$/i, reader: "pyproject.toml" },
] as const;

export function createPackageIndex(
  files: readonly { path: string; read: (() => string) | null }[],
): PackageIndex {
  const declaredBy = new Map<string, string[]>();
  const declaredIn = new Map<string, string>();
  /** PEP 503 form -> the name exactly as the manifest spelled it. */
  const canonical = new Map<string, string>();

  const record = (manifestPath: string, names: string[]) => {
    if (names.length === 0) return;
    declaredBy.set(manifestPath, names);
    for (const name of names) {
      const key = pep503(name);
      if (!canonical.has(key)) {
        canonical.set(key, name);
        declaredIn.set(name, manifestPath);
      }
    }
  };

  for (const file of files) {
    if (file.read === null) continue;
    const path = normalizePath(file.path);

    if (/(^|\/)Pipfile$/.test(path)) {
      record(file.path, readPipfile(file.read()));
      continue;
    }

    const manifest = PYTHON_MANIFESTS.find((entry) => entry.match.test(path));
    if (!manifest) continue;

    /*
     * The shallow layer's readers, reached through the canonical file name.
     *
     * `requirements-dev.txt` and `requirements/base.txt` are the same format as
     * `requirements.txt` and are how a real project splits its dependencies, so
     * the path is matched loosely here and the reader is chosen explicitly.
     * Re-implementing PEP 508 beside the one that already exists would be two
     * things to keep right instead of one.
     */
    const result = readManifest(manifest.reader, file.read());
    if (result.status === "read") record(file.path, result.packages);
  }

  const lookup = (moduleName: string): string | null => {
    const direct = canonical.get(pep503(moduleName));
    if (direct) return direct;

    for (const alias of DISTRIBUTION_ALIASES[moduleName.toLowerCase()] ?? []) {
      const hit = canonical.get(pep503(alias));
      if (hit) return hit;
    }
    return null;
  };

  return { lookup, declaredBy, declaredIn };
}

/** PEP 503: runs of `-`, `_` and `.` are one `-`, and case does not matter. */
function pep503(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Pipfile's `[packages]` and `[dev-packages]` tables.
 *
 * A line scanner, for the same reason `manifests.ts` gives: the two shapes here
 * (`requests = "*"` and `flask = {version = "==1.0"}`) are the whole of what is
 * needed, and a half-correct TOML parser is a much larger thing to be wrong
 * about. Every other section is skipped, so `[[source]]`'s `name = "pypi"` — an
 * index, not a package — never reaches the map.
 */
function readPipfile(content: string): string[] {
  const names: string[] = [];
  let inPackages = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;

    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      inPackages = /^(dev-)?packages$/.test(header[1]);
      continue;
    }
    if (!inPackages) continue;

    const key = /^["']?([A-Za-z0-9._-]+)["']?\s*=/.exec(line);
    if (key) names.push(key[1]);
  }

  return names;
}

/**
 * The top-level module a specifier belongs to: `requests.adapters` -> `requests`.
 *
 * Splitting a submodule off is a fully specified rule with nothing configurable
 * in it, so a submodule import of a declared dependency stays `certain` rather
 * than dropping to a guess — the same reasoning as `packageRoot` in the shallow
 * layer.
 */
export function topLevelModule(specifier: string): string {
  return specifier.split(".")[0];
}
