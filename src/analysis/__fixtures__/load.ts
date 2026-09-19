import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePath } from "@/analysis/ids";
import type { SourceFile } from "@/analysis/types";

/**
 * Fixture repositories for the parser tests, and the machinery that turns one
 * into the `SourceFile[]` an analyzer sees.
 *
 * Two things about the layout are deliberate.
 *
 * **Every fixture source file carries a trailing `.txt`.** `app/page.tsx.txt`
 * becomes `app/page.tsx` only once it is materialised. Without that, the app's
 * own `tsconfig.json` (`include: ["**\/*.ts", "**\/*.tsx"]`) would compile the
 * fixture as application code and eslint would lint it — and one of these files
 * is a merge conflict on purpose, so `tsc --noEmit` on the whole product would
 * fail because of a test fixture. The alternative was an exclude entry in
 * `tsconfig.json` and `eslint.config.mjs`, which costs two shared config files
 * and still leaves every fixture inside the type-checked program.
 *
 * **The tree is written to a real temp directory at test time.** ts-morph
 * resolves `./PriceTag` and `@/lib/format` through the filesystem, and the
 * whole point of the alias and barrel tests is that real resolution runs. A
 * fresh directory per call also means two runs of the same fixture live under
 * two different absolute paths, which is exactly the condition stable ids have
 * to survive (a GitHub tarball nests everything under `{owner}-{repo}-{sha}/`,
 * so the prefix genuinely changes on every commit).
 */

const FIXTURE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_SUFFIX = ".txt";

/** Recorded as nodes, never read. Mirrors what ingest hands us for a binary. */
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".svg", ".ico", ".woff2"]);

export type Fixture = {
  /** Absolute path of the materialised tree, as ingest would report it. */
  root: string;
  files: SourceFile[];
  /**
   * Fixture text by repo-relative path. Tests locate a declaration by searching
   * this rather than hard-coding a line number, so editing a fixture file does
   * not silently invalidate a line-range assertion.
   */
  sources: Map<string, string>;
  cleanup: () => void;
};

/**
 * Anything the caller wants different from what is on disk: new content for a
 * path, a brand new path, or `null` to leave a file out entirely.
 */
export type FixtureOverrides = Record<string, string | null>;

export function materializeFixture(
  name: string,
  overrides: FixtureOverrides = {},
): Fixture {
  const sourceDir = path.join(FIXTURE_ROOT, name);
  const contents = new Map<string, string>();

  for (const stored of walk(sourceDir)) {
    const repoPath = normalizePath(
      path.relative(sourceDir, stored).slice(0, -SOURCE_SUFFIX.length),
    );
    contents.set(repoPath, readFileSync(stored, "utf8"));
  }

  for (const [repoPath, content] of Object.entries(overrides)) {
    if (content === null) contents.delete(normalizePath(repoPath));
    else contents.set(normalizePath(repoPath), content);
  }

  const root = mkdtempSync(path.join(tmpdir(), "vestra-fixture-"));
  const files: SourceFile[] = [];

  // Sorted so the file list is identical between two runs. Directory order is
  // not guaranteed, and an analyzer that happened to depend on it would pass
  // here and fail on the server.
  for (const repoPath of [...contents.keys()].sort()) {
    const content = contents.get(repoPath) as string;
    const absolutePath = path.join(root, repoPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");

    const isAsset = ASSET_EXTENSIONS.has(path.extname(repoPath).toLowerCase());
    files.push({
      path: repoPath,
      absolutePath,
      size: Buffer.byteLength(content, "utf8"),
      read: isAsset ? null : () => readFileSync(absolutePath, "utf8"),
    });
  }

  return {
    root,
    files,
    sources: contents,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(absolute));
    else if (entry.name.endsWith(SOURCE_SUFFIX)) found.push(absolute);
  }
  return found;
}
