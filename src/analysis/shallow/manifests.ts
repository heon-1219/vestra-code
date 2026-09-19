import { z } from "zod";

/**
 * Reading a dependency list out of whatever a repository happens to keep it in.
 *
 * This is the one thing the shallow layer can say with certainty about a
 * repository in a language it cannot compile. A bare specifier that appears
 * verbatim in a manifest IS a dependency of that project — reading it is a
 * lookup, not a resolution, so those edges are `certain` (DECISIONS D26
 * correction). Everything else this layer produces crosses a file boundary by
 * name and is `inferred`.
 *
 * These are deliberately readers, not parsers. Nothing here tries to be a
 * correct TOML or XML implementation; each one extracts names from the shapes
 * that real manifests are actually written in, and returns nothing when it
 * meets something it does not recognise. A wrong package name is a wrong claim
 * about somebody's project, so every branch that cannot be sure produces
 * silence.
 */

export type Ecosystem =
  | "npm"
  | "pip"
  | "go"
  | "rubygems"
  | "cargo"
  | "composer"
  | "maven";

export type ManifestResult =
  /** Not a file we read dependencies from. The overwhelming majority. */
  | { status: "skip" }
  | { status: "read"; ecosystem: Ecosystem; packages: string[] }
  /**
   * A manifest we recognised by name and could not read. `reason` reaches the
   * user in the progress list, so it is Korean and says what happened.
   */
  | { status: "unreadable"; ecosystem: Ecosystem; reason: string };

type Reader = (content: string) => string[] | null;

/**
 * Keyed by file name, matched anywhere in the tree. A monorepo keeps the
 * interesting `package.json` a level or two down, and a Python service in a
 * `backend/` folder is the common shape of the repos this layer exists for.
 */
const READERS: Record<string, { ecosystem: Ecosystem; read: Reader }> = {
  "package.json": { ecosystem: "npm", read: readPackageJson },
  "requirements.txt": { ecosystem: "pip", read: readRequirementsTxt },
  "pyproject.toml": { ecosystem: "pip", read: readPyprojectToml },
  "go.mod": { ecosystem: "go", read: readGoMod },
  Gemfile: { ecosystem: "rubygems", read: readGemfile },
  "Cargo.toml": { ecosystem: "cargo", read: readCargoToml },
  "composer.json": { ecosystem: "composer", read: readComposerJson },
  "pom.xml": { ecosystem: "maven", read: readPomXml },
};

/** Whether this path is a manifest at all, without reading it. */
export function manifestEcosystem(repoPath: string): Ecosystem | null {
  const base = repoPath.slice(repoPath.lastIndexOf("/") + 1);
  return READERS[base]?.ecosystem ?? null;
}

export function readManifest(repoPath: string, content: string): ManifestResult {
  const base = repoPath.slice(repoPath.lastIndexOf("/") + 1);
  const reader = READERS[base];
  if (!reader) return { status: "skip" };

  const packages = reader.read(content);
  if (packages === null) {
    return {
      status: "unreadable",
      ecosystem: reader.ecosystem,
      reason: "이 파일에 적힌 사용 중인 도구 목록을 읽지 못했어요.",
    };
  }

  return { status: "read", ecosystem: reader.ecosystem, packages: unique(packages) };
}

function unique(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// --- npm -------------------------------------------------------------------

/**
 * Section 8 requires external input to be validated rather than cast. A
 * `package.json` is a file out of somebody else's repository, so `dependencies`
 * being an array instead of an object is a thing that happens, and
 * `Object.keys` on it would produce the packages `0`, `1` and `2`.
 */
const dependencyMap = z.record(z.string(), z.unknown());

const packageJsonShape = z.object({
  dependencies: dependencyMap.optional(),
  devDependencies: dependencyMap.optional(),
  peerDependencies: dependencyMap.optional(),
  optionalDependencies: dependencyMap.optional(),
});

function readPackageJson(content: string): string[] | null {
  const json = parseJson(content);
  if (json === null) return null;

  const parsed = packageJsonShape.safeParse(json);
  if (!parsed.success) return null;

  return [
    ...Object.keys(parsed.data.dependencies ?? {}),
    ...Object.keys(parsed.data.devDependencies ?? {}),
    ...Object.keys(parsed.data.peerDependencies ?? {}),
    ...Object.keys(parsed.data.optionalDependencies ?? {}),
  ];
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content.replace(/^﻿/, "")) as unknown;
  } catch {
    return null;
  }
}

// --- composer --------------------------------------------------------------

const composerShape = z.object({
  require: dependencyMap.optional(),
  "require-dev": dependencyMap.optional(),
});

/**
 * Composer package names are always `vendor/name`. The other entries in
 * `require` are platform constraints — `php`, `ext-mbstring`, `lib-openssl` —
 * which are not things anyone installed and would sit on the map as packages
 * that do not exist.
 */
const COMPOSER_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9]([_.-]?[a-z0-9]+)*$/i;

function readComposerJson(content: string): string[] | null {
  const json = parseJson(content);
  if (json === null) return null;

  const parsed = composerShape.safeParse(json);
  if (!parsed.success) return null;

  return [
    ...Object.keys(parsed.data.require ?? {}),
    ...Object.keys(parsed.data["require-dev"] ?? {}),
  ].filter((name) => COMPOSER_NAME.test(name));
}

// --- pip -------------------------------------------------------------------

/**
 * A PEP 508 requirement down to its name: `httpx[http2]>=0.27; python_version
 * >= "3.9"` is the package `httpx`. Everything after the name is a constraint,
 * an extra or an environment marker, and none of them belong in a name.
 */
function requirementName(line: string): string | null {
  const name = line.split(/[[<>=!~;,()@\s]/)[0];
  if (!name) return null;
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : null;
}

function readRequirementsTxt(content: string): string[] {
  const names: string[] = [];

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, "").split("#")[0].trim();
    if (!line) continue;
    // `-r shared.txt`, `-e ./local`, `--index-url ...`: instructions to pip,
    // not packages. `-e` in particular names a directory, and admitting it
    // would put a path on the map dressed up as a package.
    if (line.startsWith("-")) continue;

    const name = requirementName(line);
    if (name) names.push(name);
  }

  return names;
}

/**
 * Both Python layouts: PEP 621's `[project] dependencies = [...]` array, and
 * Poetry's `[tool.poetry.dependencies]` table of name-to-constraint.
 *
 * A line scanner rather than a TOML parser, because the two shapes above are
 * the whole of what we need and a half-correct TOML parser is a much larger
 * thing to be wrong about. `[build-system] requires` is deliberately left out:
 * setuptools and hatchling build the package, they are not part of the app.
 */
function readPyprojectToml(content: string): string[] {
  const names: string[] = [];
  let section = "";
  let arrayDepth = 0;

  for (const raw of content.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;

    if (arrayDepth > 0) {
      names.push(...quotedRequirementNames(line));
      arrayDepth += bracketDelta(line);
      continue;
    }

    const header = tomlSectionHeader(line);
    if (header !== null) {
      section = header;
      continue;
    }

    const inProjectArray =
      section === "project" && /^dependencies\s*=/.test(line);
    const inOptionalArray =
      section === "project.optional-dependencies" && /=\s*\[/.test(line);

    if (inProjectArray || inOptionalArray) {
      names.push(...quotedRequirementNames(line));
      arrayDepth += bracketDelta(line);
      continue;
    }

    // Poetry: `[tool.poetry.dependencies]` and its per-group variants.
    if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(section)) {
      const key = tomlBareKey(line);
      // The interpreter itself is a constraint, not something anyone installed.
      if (key && key !== "python") names.push(key);
    }
  }

  return names;
}

function quotedRequirementNames(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(/["']([^"']+)["']/g)) {
    const name = requirementName(match[1]);
    if (name) out.push(name);
  }
  return out;
}

function bracketDelta(line: string): number {
  let delta = 0;
  for (const character of line) {
    if (character === "[") delta += 1;
    if (character === "]") delta -= 1;
  }
  return delta;
}

// --- go --------------------------------------------------------------------

/**
 * `require (...)` blocks and single-line `require path v1.2.3`.
 *
 * `// indirect` lines are dropped. They are transitive dependencies the module
 * graph pulled in, not anything the author chose, and on a real service they
 * outnumber the direct ones several times over — showing a person fifty
 * packages they have never heard of is worse than showing them the eight they
 * picked.
 */
function readGoMod(content: string): string[] {
  const names: string[] = [];
  let inBlock = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.includes("// indirect")) continue;

    if (inBlock) {
      if (line.startsWith(")")) {
        inBlock = false;
        continue;
      }
      const path = line.split(/\s+/)[0];
      if (isGoModulePath(path)) names.push(path);
      continue;
    }

    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }

    const single = /^require\s+(\S+)/.exec(line);
    if (single && isGoModulePath(single[1])) names.push(single[1]);
  }

  return names;
}

function isGoModulePath(path: string): boolean {
  return /^[A-Za-z0-9._~/-]+$/.test(path) && !path.startsWith("//");
}

// --- rubygems --------------------------------------------------------------

function readGemfile(content: string): string[] {
  const names: string[] = [];

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    const match = /^gem\s+["']([^"']+)["']/.exec(line);
    if (match) names.push(match[1]);
  }

  return names;
}

// --- cargo -----------------------------------------------------------------

const CARGO_SECTIONS = /(^|\.)(dev-|build-)?dependencies$/;

/**
 * Cargo writes a dependency three ways: `serde = "1"`, an inline table
 * `serde = { version = "1" }`, and a sub-table `[dependencies.serde]`.
 *
 * The sub-table is the one that needs care. Once inside `[dependencies.serde]`
 * the following lines are `version = ...` and `features = [...]`, so reading
 * keys there would put `version` and `features` on the map as crates.
 */
function readCargoToml(content: string): string[] {
  const names: string[] = [];
  let inDependencyTable = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;

    const header = tomlSectionHeader(line);
    if (header !== null) {
      const subTable = /(^|\.)(dev-|build-)?dependencies\.([^.]+)$/.exec(header);
      if (subTable) {
        names.push(unquote(subTable[3]));
        inDependencyTable = false;
        continue;
      }
      inDependencyTable = CARGO_SECTIONS.test(header);
      continue;
    }

    if (!inDependencyTable) continue;
    const key = tomlBareKey(line);
    if (key) names.push(key);
  }

  return names;
}

// --- maven -----------------------------------------------------------------

/**
 * `<dependency>` blocks only, never `<plugin>` — a plugin carries the same
 * groupId/artifactId pair and builds the project rather than running in it.
 * Blocks whose version is a property reference are still real dependencies, so
 * only the coordinates are read and the version is ignored entirely.
 */
function readPomXml(content: string): string[] {
  const names: string[] = [];

  for (const block of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(block[1]);
    const artifact = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(block[1]);
    if (!group || !artifact) continue;
    names.push(`${group[1]}:${artifact[1]}`);
  }

  return names;
}

// --- shared TOML-ish helpers ----------------------------------------------

/**
 * Strips a `#` comment, but not one inside a quoted string — `version = "1 # 2"`
 * is legal and truncating it would leave an unbalanced quote for the readers
 * above to trip over.
 */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

/** `[tool.poetry.dependencies]` -> `tool.poetry.dependencies`, else null. */
function tomlSectionHeader(line: string): string | null {
  const match = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
  if (!match) return null;
  // `[[bin]]` is an array of tables; it is never a dependency section.
  return match[1].startsWith("[") ? null : match[1];
}

/** The key of `name = value`, unquoted. Null when the line is not an assignment. */
function tomlBareKey(line: string): string | null {
  const match = /^("?[^"'=\s]+"?|'[^']+')\s*=/.exec(line);
  if (!match) return null;
  const key = unquote(match[1]);
  return /^[A-Za-z0-9._-]+$/.test(key) ? key : null;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
