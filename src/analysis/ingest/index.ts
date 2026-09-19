import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { extract } from "tar";

import { normalizePath } from "@/analysis/ids";
import type { SourceFile } from "@/analysis/types";

import { classifyFile, LIMIT_MESSAGES, LIMITS, type IngestLimit } from "./limits";

export type IngestResult = {
  /** Absolute path of the extracted tree. Deleted by `cleanup`. */
  root: string;
  files: SourceFile[];
  skipped: { path: string; reason: string }[];
  /** Limits we hit, so the UI can say what is missing instead of implying completeness. */
  limitsHit: IngestLimit[];
  cleanup: () => Promise<void>;
};

export type IngestFailure = "download_failed" | "extract_failed" | "too_large";

export type IngestOutcome =
  | { ok: true; value: IngestResult }
  | { ok: false; error: IngestFailure; message: string };

/**
 * Getting a repository onto disk, safely.
 *
 * A tarball from the internet is untrusted input. node-tar strips absolute
 * paths and `..` by default and we never set `preservePaths`, but the filter
 * here is a second line rather than a first: entries are rejected by name
 * before extraction, so a hostile path never reaches the filesystem layer.
 * Links are refused outright — we only ever read files, so following one never
 * helps us and can escape the extraction root.
 */
export async function ingestRepo(
  owner: string,
  repo: string,
  ref: string,
  token: string | null,
  onProgress?: (message: string) => void,
): Promise<IngestOutcome> {
  const root = await mkdtemp(path.join(tmpdir(), "vestra-"));
  const archivePath = path.join(root, "repo.tar.gz");
  const extractedRoot = path.join(root, "src");

  const cleanup = async () => {
    // A temp directory we cannot remove is a disk-space problem, not a
    // user-facing one, and must never turn a successful analysis into a failure.
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => {
      console.error("[ingest] temp cleanup failed", root, error);
    });
  };

  try {
    await mkdir(extractedRoot, { recursive: true });

    onProgress?.("저장소를 받는 중");

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "vestra-code",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "follow",
      },
    );

    if (!response.ok || !response.body) {
      await cleanup();
      return {
        ok: false,
        error: "download_failed",
        message: "저장소를 받지 못했어요. 잠시 후 다시 시도해 주세요.",
      };
    }

    // Streamed to disk rather than buffered: a 110 MB archive held in memory is
    // a container restart on a small host.
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(archivePath),
    );

    onProgress?.("파일을 여는 중");

    let extractedBytes = 0;
    let exceededExtraction = false;

    await extract({
      file: archivePath,
      cwd: extractedRoot,
      // GitHub archives nest everything under {owner}-{repo}-{sha}/. Without
      // this the commit SHA lands inside every stored path and stable ids
      // change on every commit (DECISIONS D18).
      strip: 1,
      // Explicit although it is the default: true would disable node-tar's own
      // absolute-path and `..` protection.
      preservePaths: false,
      filter: (entryPath, entry) => {
        if (exceededExtraction) return false;

        // tar types this parameter as `Stats | ReadEntry`; extracting from a
        // file always yields ReadEntry, but narrow rather than assert so a
        // future tar change surfaces as a type error instead of a crash.
        if (!("type" in entry)) return false;

        const type = String(entry.type);
        if (type !== "File" && type !== "Directory") return false;
        if (path.isAbsolute(entryPath)) return false;

        const normalized = normalizePath(entryPath);
        if (normalized.startsWith("..") || normalized.includes("/../")) return false;

        if (type === "Directory") return true;
        if (classifyFile(normalized, entry.size ?? 0) === "skip") return false;

        extractedBytes += entry.size ?? 0;
        if (extractedBytes > LIMITS.maxExtractedBytes) {
          exceededExtraction = true;
          return false;
        }
        return true;
      },
    });

    if (exceededExtraction) {
      await cleanup();
      return { ok: false, error: "too_large", message: LIMIT_MESSAGES.extracted_bytes };
    }

    onProgress?.("읽을 파일을 고르는 중");

    const collected = await collectFiles(extractedRoot);

    return {
      ok: true,
      value: { root: extractedRoot, cleanup, ...collected },
    };
  } catch (error) {
    // Plain language to the user; the detail goes to logs (section 8).
    console.error("[ingest]", `${owner}/${repo}@${ref}`, error);
    await cleanup();
    return {
      ok: false,
      error: "extract_failed",
      message: "저장소 파일을 여는 중에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
    };
  }
}

async function collectFiles(extractedRoot: string): Promise<{
  files: SourceFile[];
  skipped: { path: string; reason: string }[];
  limitsHit: IngestLimit[];
}> {
  const files: SourceFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const limitsHit: IngestLimit[] = [];

  let textBytes = 0;
  let assetCount = 0;

  const noteLimit = (limit: IngestLimit) => {
    if (!limitsHit.includes(limit)) limitsHit.push(limit);
  };

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const repoPath = normalizePath(path.relative(extractedRoot, absolute));

      // Never follow a link out of the tree, even if one survived extraction.
      if (entry.isSymbolicLink()) {
        skipped.push({ path: repoPath, reason: "링크는 따라가지 않아요" });
        continue;
      }

      if (entry.isDirectory()) {
        // Reuse one classifier for directories by probing a child path, so the
        // skip list cannot drift between extraction and collection.
        if (classifyFile(`${repoPath}/probe.ts`, 0) === "skip") continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      let size: number;
      try {
        size = (await stat(absolute)).size;
      } catch {
        continue;
      }

      const kind = classifyFile(repoPath, size);
      if (kind === "skip") continue;

      if (kind === "asset") {
        if (assetCount >= LIMITS.maxAssets) continue;
        assetCount += 1;
        // An asset still becomes a node: "nothing on your site uses this photo"
        // is one of the few honest things we can say about a static site, and
        // it needs the photo to exist in the graph.
        files.push({ path: repoPath, absolutePath: absolute, size, read: null });
        continue;
      }

      if (files.length >= LIMITS.maxSourceFiles) {
        noteLimit("files");
        continue;
      }
      if (textBytes + size > LIMITS.maxTextBytes) {
        noteLimit("text_bytes");
        continue;
      }

      textBytes += size;
      files.push({
        path: repoPath,
        absolutePath: absolute,
        size,
        // Read on demand: an analyzer that only needs paths never pays for
        // content, and a fixture supplies its own reader.
        read: () => readFileSync(absolute, "utf8"),
      });
    }
  };

  await walk(extractedRoot);
  return { files, skipped, limitsHit };
}

export { classifyFile, LIMIT_MESSAGES, LIMITS } from "./limits";
export type { IngestLimit } from "./limits";
