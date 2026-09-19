import path from "node:path";

import { ts } from "ts-morph";

/**
 * Lifting path aliases out of the repository's own config — and nothing else.
 *
 * This is DECISIONS D15, and it is the single most consequential twenty lines
 * in Pass 1. The brief says to build the ts-morph project without the repo's
 * tsconfig, which is right about *why* (their `target`, `strict` and include
 * globs must never decide our parse) but taken literally produces a silent
 * disaster: `@/components/Button` is a bare specifier, so TypeScript walks
 * node_modules, which does not exist in an unbuilt tarball, resolves to
 * nothing, and Pass 1 emits a confident, completely disconnected graph with no
 * error anywhere.
 *
 * So: read the config, take `baseUrl` and `paths`, discard the rest.
 */

export type AliasConfig = {
  /** Absolute. Always set, because substitutions are rewritten against it. */
  baseUrl: string;
  /** Substitutions rewritten to absolute paths (D30). */
  paths: Record<string, string[]>;
  /** Where the mapping came from, for the run log. */
  source: "tsconfig.json" | "jsconfig.json" | "probed" | "none";
};

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"] as const;

/**
 * `ts.readConfigFile` is used rather than `JSON.parse` because real configs
 * contain comments and trailing commas, which JSON.parse rejects outright.
 *
 * Deliberately NOT `parseJsonConfigFileContent`: with a host whose
 * `readDirectory` returns nothing — which is what we want, since ingest already
 * chose the files — it always reports error 18003, so its `errors` array can
 * never be used to tell a broken config from a fine one.
 */
function readRawConfig(
  absolutePath: string,
  readFile: (p: string) => string | undefined,
): Record<string, unknown> | null {
  const result = ts.readConfigFile(absolutePath, (p) => readFile(p));
  if (result.error || typeof result.config !== "object" || result.config === null) {
    return null;
  }
  return result.config as Record<string, unknown>;
}

function compilerOptionsOf(config: Record<string, unknown>): Record<string, unknown> {
  const options = config.compilerOptions;
  return typeof options === "object" && options !== null
    ? (options as Record<string, unknown>)
    : {};
}

export function resolveAliasConfig(
  repoRoot: string,
  /** Repo-relative POSIX paths that exist, from ingest. */
  existingPaths: ReadonlySet<string>,
  readFile: (absolutePath: string) => string | undefined,
): AliasConfig {
  for (const name of CONFIG_NAMES) {
    if (!existingPaths.has(name)) continue;

    const absolute = path.join(repoRoot, name);
    let config = readRawConfig(absolute, readFile);
    if (!config) continue;

    let options = compilerOptionsOf(config);

    // Follow `extends` exactly one level. Deeper chains are rare, and each hop
    // is another chance to read a file that is not in the repo at all (a shared
    // config from node_modules, which we do not have).
    if (typeof config.extends === "string" && !config.extends.startsWith("@")) {
      const parentPath = path.resolve(path.dirname(absolute), config.extends);
      const withExtension = parentPath.endsWith(".json")
        ? parentPath
        : `${parentPath}.json`;
      const parent = readRawConfig(withExtension, readFile);
      if (parent) {
        const parentOptions = compilerOptionsOf(parent);
        options = { ...parentOptions, ...options };
      }
    }

    const rawPaths = options.paths;
    if (typeof rawPaths !== "object" || rawPaths === null) continue;

    // `baseUrl` is resolved against the config's own directory. When it is
    // absent — which is the common case in a modern Next.js jsconfig — the
    // config directory itself is the base.
    const baseUrl =
      typeof options.baseUrl === "string"
        ? path.resolve(path.dirname(absolute), options.baseUrl)
        : path.dirname(absolute);

    const paths: Record<string, string[]> = {};
    for (const [pattern, substitutions] of Object.entries(
      rawPaths as Record<string, unknown>,
    )) {
      if (!Array.isArray(substitutions)) continue;
      const absoluteSubstitutions = substitutions
        .filter((value): value is string => typeof value === "string")
        // D30: rewritten to absolute. `paths` without `baseUrl`, handed to the
        // compiler programmatically, resolves against OUR process working
        // directory and silently returns nothing — and the demo repo's
        // jsconfig.json is exactly `{"paths":{"@/*":["./*"]}}` with no baseUrl.
        // A rooted substitution makes the base irrelevant.
        .map((value) => path.resolve(baseUrl, value));
      if (absoluteSubstitutions.length > 0) paths[pattern] = absoluteSubstitutions;
    }

    if (Object.keys(paths).length > 0) {
      return {
        baseUrl,
        paths,
        source: name,
      };
    }
  }

  return probeAlias(repoRoot, existingPaths);
}

/**
 * No usable config. Guess the one alias that is nearly universal.
 *
 * `@/` is the convention `create-next-app` has shipped for years, so a repo
 * using it without a readable config is common enough to be worth a guess —
 * and a wrong guess here costs nothing, because a substitution pointing at a
 * directory that does not exist simply fails to resolve, exactly as it would
 * have without the guess.
 */
function probeAlias(
  repoRoot: string,
  existingPaths: ReadonlySet<string>,
): AliasConfig {
  const hasSrc = [...existingPaths].some((p) => p.startsWith("src/"));
  const target = hasSrc ? path.join(repoRoot, "src") : repoRoot;

  return {
    baseUrl: repoRoot,
    paths: { "@/*": [path.join(target, "*")] },
    source: "probed",
  };
}
