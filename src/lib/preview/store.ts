import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  previewShapeFor,
  type PreviewKind,
} from "@/components/workspace/preview/preview-kinds";
import type { Db } from "@/db";
import { projectFiles } from "@/db/schema";

/**
 * Keeping an uploaded project's files, so its map opens onto something.
 *
 * A GitHub project stores no source: the map holds paths and line ranges, and a
 * preview re-fetches the file from GitHub when someone asks. An uploaded folder
 * has no origin to re-fetch from — the temp directory is deleted the moment
 * analysis ends — so the same rule meant every file in the map opened onto an
 * apology, and "올리셨던 폴더에서 열어보세요" is not an answer for someone who
 * opened the map on a different computer.
 *
 * So uploads keep their bytes and GitHub projects still do not. The asymmetry
 * is the point: we store source only where storing it is the only way to show
 * it, and the schema, not a sentence in the UI, is where that is enforced.
 *
 * Three caps, each for its own reason:
 *
 *   1. **Per file, the ceiling of its own preview kind.** Storing a 30 MB PDF
 *      when the viewer refuses to open anything over 20 MB buys nothing but
 *      disk. The ceiling that decides what we show decides what we keep.
 *   2. **Per project, a budget.** One person's photo folder should not be able
 *      to fill the database for everyone else, and a cap that lives here is a
 *      number we can raise, rather than an outage we have to explain.
 *   3. **Per statement, a byte budget for batching.** 1,500 files in one
 *      INSERT is both a parameter-count problem and a multi-megabyte statement;
 *      chunking keeps each round trip a size Postgres and Neon are happy with.
 *
 * Nothing here is reached for a GitHub project. The callers are the upload
 * endpoints, and the two readers — the preview endpoint and the re-read that
 * rebuilds an analysis from what we kept — only ever ask about a project whose
 * `projects.source` is `'upload'`.
 */

/** What one project may keep. Comfortably more than a codebase, less than a photo library. */
export const STORE_BUDGET_BYTES = 40 * 1024 * 1024;

/**
 * And how many files, which the byte budget alone does not bound.
 *
 * 40 MB is 400,000 rows if every file is 100 bytes. The ceiling that matters
 * for a database is rows, not only bytes, and an upload of a real project comes
 * nowhere near this one.
 */
export const STORE_MAX_ROWS = 6000;

/**
 * How many paths go in a single SELECT when reading files back.
 *
 * The same reasoning as `WRITE_CHUNK` in `analysis/persist.ts`: one bound
 * parameter per path against Postgres' ceiling of 65,535, and a project may
 * hold `STORE_MAX_ROWS` of them. 500 keeps a statement readable in a slow-query
 * log and is still one round trip for any real project.
 */
const READ_CHUNK = 500;

/** How many bytes of file content go in a single INSERT. */
const BATCH_BYTES = 2 * 1024 * 1024;

/** How many rows go in a single INSERT, whatever they weigh. */
const BATCH_ROWS = 200;

export type StorableFile = { path: string; content: Buffer };

/** Why one file was not kept. The UI turns these into sentences. */
export type StoreRefusalReason = "unsupported" | "too_large" | "budget" | "count";

export type StoreRefusal = { path: string; reason: StoreRefusalReason };

export type StoreOutcome = {
  stored: number;
  storedBytes: number;
  refused: StoreRefusal[];
};

/**
 * Whether a file of this path and size is worth keeping, and why not.
 *
 * Shared with the browser so the upload can skip what the server would refuse
 * instead of sending it and being told. The answer must be the same in both
 * places: this function is the only copy.
 */
export function storeDecision(
  path: string,
  size: number,
  remainingBudget: number,
): { keep: boolean; reason?: StoreRefusalReason; kind: PreviewKind } {
  const shape = previewShapeFor(path);
  // A kind we cannot draw is a kind we do not keep. Storing bytes we would
  // refuse to render is pure cost — the person still cannot see the file.
  if (shape.contentType === null) {
    return { keep: false, reason: "unsupported", kind: shape.kind };
  }
  if (size > shape.maxBytes) {
    return { keep: false, reason: "too_large", kind: shape.kind };
  }
  if (size > remainingBudget) {
    return { keep: false, reason: "budget", kind: shape.kind };
  }
  return { keep: true, kind: shape.kind };
}

/** What a project is already using, against both ceilings. */
export type StorageUsage = { bytes: number; rows: number };

export const NO_USAGE: StorageUsage = { bytes: 0, rows: 0 };

/**
 * One query for both ceilings, because the second phase of an upload needs to
 * know what the first phase spent.
 */
export async function storageUsageFor(
  db: Db,
  projectId: string,
): Promise<StorageUsage> {
  const [row] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${projectFiles.size}), 0)`,
      rows: sql<string>`count(*)`,
    })
    .from(projectFiles)
    .where(eq(projectFiles.projectId, projectId));
  // Both come back as strings from `pg`: `sum` and `count` are bigints, which
  // do not fit a JS number in general. They fit here — the ceilings are 40 MB
  // and 6,000 rows — but the parse has to be explicit rather than accidental.
  return { bytes: Number(row?.bytes ?? 0), rows: Number(row?.rows ?? 0) };
}

/**
 * Store what we can, skip what we cannot, and say which was which.
 *
 * Never throws for a file it will not keep: a folder with one 30 MB video in it
 * should produce a project with previews for everything else, not a failed
 * upload. The only errors that propagate are the ones that mean the database
 * is not working, which the caller must not swallow.
 */
export async function storeProjectFiles(
  db: Db,
  projectId: string,
  files: readonly StorableFile[],
  usage: StorageUsage = NO_USAGE,
): Promise<StoreOutcome> {
  const refused: StoreRefusal[] = [];
  const keep: { id: string; projectId: string; path: string; size: number; content: Buffer }[] = [];

  let used = usage.bytes;
  let rows = usage.rows;
  for (const file of files) {
    const size = file.content.byteLength;
    if (rows >= STORE_MAX_ROWS) {
      refused.push({ path: file.path, reason: "count" });
      continue;
    }
    const decision = storeDecision(file.path, size, STORE_BUDGET_BYTES - used);
    if (!decision.keep) {
      refused.push({ path: file.path, reason: decision.reason ?? "unsupported" });
      continue;
    }
    rows += 1;
    keep.push({
      id: randomUUID(),
      projectId,
      path: file.path,
      size,
      content: file.content,
    });
    used += size;
  }

  let stored = 0;
  let storedBytes = 0;
  let batch: typeof keep = [];
  let batchBytes = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    await db
      .insert(projectFiles)
      .values(batch)
      // A re-upload of the same folder should refresh the bytes rather than
      // fail on the unique index. `path` is the identity of a file here; the
      // row id is not meaningful to anyone.
      .onConflictDoUpdate({
        target: [projectFiles.projectId, projectFiles.path],
        set: {
          content: sql`excluded.content`,
          size: sql`excluded.size`,
        },
      });
    stored += batch.length;
    storedBytes += batchBytes;
    batch = [];
    batchBytes = 0;
  };

  for (const row of keep) {
    batch.push(row);
    batchBytes += row.size;
    if (batch.length >= BATCH_ROWS || batchBytes >= BATCH_BYTES) await flush();
  }
  await flush();

  return { stored, storedBytes, refused };
}

/** One file we kept, described rather than moved. */
export type StoredFileInfo = { path: string; size: number };

/** One file we kept, bytes and all. */
export type StoredFile = StoredFileInfo & { content: Buffer };

/**
 * What a project has kept, by path and size, without moving a byte.
 *
 * This is what the `size` column is for (see the schema). A project may hold
 * 40 MB of photographs beside 200 KB of code, and the caller that rebuilds an
 * analysis has to know which rows are code *before* it decides what to read —
 * selecting `content` to find out would move the photographs to learn their
 * names.
 *
 * Ordered by path so that two reads of the same project hand their caller the
 * same list in the same order. Postgres is free to return rows in any order it
 * likes, and an analysis whose file list shuffles between reads is one nobody
 * can compare with the last one.
 */
export async function listProjectFiles(
  db: Db,
  projectId: string,
): Promise<StoredFileInfo[]> {
  return db
    .select({ path: projectFiles.path, size: projectFiles.size })
    .from(projectFiles)
    .where(eq(projectFiles.projectId, projectId))
    .orderBy(projectFiles.path);
}

/**
 * The bytes of the files named, in batches.
 *
 * Named rather than "all of them", because the caller has already decided which
 * rows it can use and the rest are weight it would carry for nothing. Asking
 * for none of them is a legitimate question with a legitimate answer — the loop
 * simply does not run, which also keeps an empty `IN ()` out of the SQL.
 */
export async function readProjectFiles(
  db: Db,
  projectId: string,
  paths: readonly string[],
): Promise<StoredFile[]> {
  const files: StoredFile[] = [];
  for (let start = 0; start < paths.length; start += READ_CHUNK) {
    const batch = paths.slice(start, start + READ_CHUNK);
    const rows = await db
      .select({
        path: projectFiles.path,
        size: projectFiles.size,
        content: projectFiles.content,
      })
      .from(projectFiles)
      .where(
        and(
          eq(projectFiles.projectId, projectId),
          inArray(projectFiles.path, batch),
        ),
      )
      .orderBy(projectFiles.path);
    files.push(...rows);
  }
  return files;
}
