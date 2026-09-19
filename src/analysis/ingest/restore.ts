import { and, eq } from "drizzle-orm";

import type { Db } from "@/db";
import { nodes } from "@/db/schema";
import { listProjectFiles, readProjectFiles } from "@/lib/preview/store";

import type { IngestResult } from "./index";
import { classifyFile } from "./limits";
import { ingestUpload, type UploadedAsset, type UploadedText } from "./upload";

/**
 * Reading an uploaded folder again, without asking for the folder.
 *
 * Until we kept uploaded files, this could not exist: the temp directory was
 * deleted when the run ended, there was no origin to fetch from, and the honest
 * answer to "다시 읽기" was to ask for the folder again (D66). Now the text
 * lives in `project_files`, so the input can be rebuilt — and the founder who
 * opened their map on a different computer never has to find that folder again.
 *
 * Rebuilding goes through `ingestUpload` rather than beside it. That is the
 * whole design: text has to be on a real filesystem for ts-morph to resolve
 * `@/components/Button` at all, and an `IngestResult` built any other way would
 * be a second code path that drifts from the first one silently.
 *
 * The two halves of a folder come back from two different places, because they
 * were kept for two different reasons:
 *
 *   - **Text** is in `project_files`, bytes and all. That is everything an
 *     analyzer needs, and it is the same string it parsed the first time.
 *   - **Assets** are not, and mostly never were. Only a *previewable* asset
 *     ever had its bytes stored — an image, a PDF — so a video, a font or a zip
 *     has no row and never will. The map's asset nodes were built from a
 *     path-and-size list the browser sent once and nobody kept, so rebuilding
 *     from stored bytes alone would report a folder with no video in it, and
 *     the sweep that follows a successful run (D20) would delete that node and
 *     every edge touching it. "이 사진은 아무 데서도 안 써요" is one of the few
 *     things this product can say about a folder of pictures, and a re-read
 *     must not be what takes it away.
 *
 * So the asset list is read back from **the map itself**: the `file` nodes
 * carrying `asset: true`. That is exactly as true as the text beside it. Both
 * describe the folder as it was when it was uploaded, and nothing a re-read
 * produces can be newer than that — there is no folder being looked at.
 *
 * This module therefore touches the database, which the rest of `ingest/` does
 * not. It is the one ingest source whose origin *is* our own tables.
 */

/**
 * A project uploaded before we kept anything. Its rows do not exist and never
 * will, so the only way forward is the folder on their machine.
 */
export const NOT_STORED_MESSAGE =
  "이 프로젝트는 파일을 보관하기 전에 올리셔서, 폴더를 한 번 더 골라주셔야 해요.";

/**
 * Rows exist but none of them is code. Practically unreachable — the upload
 * endpoint stores text before anything else and refuses a folder with none —
 * so reaching it means storage failed partway. Refusing is what protects the
 * existing map: an analysis of nothing succeeds, and a successful run sweeps.
 */
export const NO_CODE_MESSAGE =
  "보관해 둔 파일 중에 읽을 수 있는 코드가 없어서, 폴더를 한 번 더 골라주셔야 해요.";

/** Said about a file the map has and we have no bytes for. */
const LOST_BYTES_REASON = "보관해 둔 내용이 없어서 이번에는 읽지 못했어요";

export type RestoreOutcome =
  | { ok: true; value: IngestResult }
  | { ok: false; message: string };

/**
 * Rebuild an uploaded project's analysis input from what we kept.
 *
 * Refuses rather than returning an empty folder. An ingest that hands back no
 * files is indistinguishable from an empty project, the run succeeds, and the
 * sweep replaces a correct map with nothing — which is the exact failure D36's
 * tripwire exists for, arriving through a door that tripwire does not watch.
 */
export async function ingestStoredUpload(
  db: Db,
  projectId: string,
): Promise<RestoreOutcome> {
  const kept = await listProjectFiles(db, projectId);
  if (kept.length === 0) return { ok: false, message: NOT_STORED_MESSAGE };

  // The same classifier the first ingest used, so a file that was text then is
  // text now — and a stored picture is not offered to an analyzer as source.
  const textPaths = kept
    .filter((file) => classifyFile(file.path, file.size) === "text")
    .map((file) => file.path);
  if (textPaths.length === 0) return { ok: false, message: NO_CODE_MESSAGE };

  const stored = await readProjectFiles(db, projectId, textPaths);
  const texts: UploadedText[] = stored.map((row) => ({
    path: row.path,
    // Written as UTF-8 when the folder arrived, so this is byte for byte the
    // string the analyzer read the first time.
    content: row.content.toString("utf8"),
  }));

  const recorded = await recordedFiles(db, projectId);
  const have = new Set(texts.map((text) => text.path));
  const lost = recorded.texts.filter((path) => !have.has(path));

  const result = await ingestUpload({
    texts,
    assets: recorded.assets,
    // Nobody filtered anything this time: there was no browser in the loop.
    skippedCount: 0,
    limitsHit: [],
  });

  return {
    ok: true,
    value: {
      ...result,
      skipped: [
        ...result.skipped,
        // Reported, not forgotten. The pipeline hands skipped paths to
        // `promoteRun`, which stamps their rows with this run so the sweep
        // leaves them alone (D37). Without this, a file whose bytes never
        // reached storage would lose its node — and, through the cascade, every
        // connection healthy files had to it — on the first re-read.
        ...lost.map((path) => ({ path, reason: LOST_BYTES_REASON })),
      ],
    },
  };
}

/**
 * What the last map says the folder held.
 *
 * Every `file` node, split by whether it was an asset. Both analyzers record
 * `{ asset: true, size }` on a file they never read, which is the only surviving
 * record of the path-and-size list the browser sent.
 */
async function recordedFiles(
  db: Db,
  projectId: string,
): Promise<{ assets: UploadedAsset[]; texts: string[] }> {
  const rows = await db
    .select({ filePath: nodes.filePath, metadata: nodes.metadata })
    .from(nodes)
    .where(and(eq(nodes.projectId, projectId), eq(nodes.type, "file")))
    // Ordered for the same reason the stored files are: the list an analyzer is
    // handed should not depend on what Postgres finds convenient today.
    .orderBy(nodes.filePath);

  const assets: UploadedAsset[] = [];
  const texts: string[] = [];

  for (const row of rows) {
    // A file node always has a path; a package node is the one without, and it
    // is not selected here. Skipped rather than asserted away.
    if (!row.filePath) continue;
    if (row.metadata.asset === true) {
      assets.push({ path: row.filePath, size: assetSize(row.metadata) });
      continue;
    }
    texts.push(row.filePath);
  }

  return { assets, texts };
}

/**
 * The size an asset node recorded, or zero.
 *
 * `metadata` is whatever an analyzer put there, so it is untyped by
 * construction and has to be checked rather than cast. Zero rather than a guess
 * when it is missing: the size is shown beside a file and decides nothing, so
 * an honest zero costs one wrong number on one line — while a made-up one would
 * be a number we invented about the user's own folder.
 */
function assetSize(metadata: Record<string, unknown>): number {
  const size = metadata.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return 0;
  return Math.floor(size);
}
