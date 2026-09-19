import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { normalizePath } from "@/analysis/ids";
import type { SourceFile } from "@/analysis/types";

import type { IngestResult } from "./index";
import { classifyFile, LIMITS, type IngestLimit } from "./limits";

/**
 * One text file the browser uploaded.
 */
export type UploadedText = { path: string; content: string };

/**
 * An asset the browser did NOT upload, described rather than sent.
 *
 * This is the whole reason a folder upload is practical. An asset becomes a
 * `file` node so "nothing uses this photo" can be answered, but nothing ever
 * reads its bytes — so there is no reason to move them across the network. The
 * founder's own portfolio is roughly 110 MB on disk for about 200 KB of text;
 * sending only the text turns a several-minute upload into an instant one.
 */
export type UploadedAsset = { path: string; size: number };

export type UploadPayload = {
  texts: UploadedText[];
  assets: UploadedAsset[];
  /** What the browser filtered out, so the UI can say so honestly. */
  skippedCount: number;
  limitsHit: IngestLimit[];
};

/**
 * Turn an upload into the same shape `ingestRepo` produces, so everything
 * downstream — analyzer selection, the pipeline, persistence — cannot tell the
 * difference and needs no branch.
 *
 * Text is written to a real temp directory rather than kept in memory because
 * ts-morph resolves modules through the filesystem: `@/components/Button` is
 * only findable if `src/components/Button.tsx` actually exists on disk.
 */
export async function ingestUpload(payload: UploadPayload): Promise<IngestResult> {
  const root = await mkdtemp(path.join(tmpdir(), "vestra-upload-"));

  const cleanup = async () => {
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => {
      console.error("[upload] temp cleanup failed", root, error);
    });
  };

  const files: SourceFile[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const entry of payload.texts) {
    const repoPath = normalizePath(entry.path);

    // The browser already filtered with these same rules, but a request is
    // untrusted input. Re-checking server-side means a hand-rolled POST cannot
    // push node_modules, a 40 MB bundle, or a path outside the root.
    if (repoPath.startsWith("..") || repoPath.includes("/../") || path.isAbsolute(entry.path)) {
      skipped.push({ path: repoPath, reason: "경로가 폴더 밖을 가리켜요" });
      continue;
    }
    const size = Buffer.byteLength(entry.content, "utf8");
    if (classifyFile(repoPath, size) !== "text") {
      skipped.push({ path: repoPath, reason: "읽지 않는 종류의 파일이에요" });
      continue;
    }

    const absolute = path.join(root, repoPath);
    // Confirm the join did not escape, which is the one check that catches a
    // path the string tests above would miss on Windows.
    if (!absolute.startsWith(root + path.sep)) {
      skipped.push({ path: repoPath, reason: "경로가 폴더 밖을 가리켜요" });
      continue;
    }

    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, entry.content, "utf8");

    files.push({
      path: repoPath,
      absolutePath: absolute,
      size,
      read: () => readFileSync(absolute, "utf8"),
    });
  }

  for (const asset of payload.assets.slice(0, LIMITS.maxAssets)) {
    const repoPath = normalizePath(asset.path);
    if (repoPath.startsWith("..") || repoPath.includes("/../")) continue;
    if (classifyFile(repoPath, asset.size) !== "asset") continue;
    files.push({
      path: repoPath,
      // An asset was never uploaded, so nothing on disk backs it. `read` is
      // null, which is exactly how ingest already marks a file whose bytes we
      // do not have — no downstream code needs to know the difference.
      absolutePath: path.join(root, repoPath),
      size: asset.size,
      read: null,
    });
  }

  return { root, files, skipped, limitsHit: payload.limitsHit, cleanup };
}
