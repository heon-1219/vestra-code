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

/**
 * Where a word is written inside an uploaded project — asked of the database,
 * once, instead of pulling the files out one at a time to look.
 *
 * The Q&A loop's content search used to fetch files and scan them in this
 * process, which bounded it at sixty files: on a two-hundred-file upload it
 * searched sixty and had to say so. Measured against a real upload's worth of
 * files (284 files, 2.9 MB) on the production database: sixty single-path
 * reads in waves of six cost **16.4 s** and looked inside 60 of them; this one
 * query costs **95–141 ms** and looks inside all 284. The difference is almost
 * entirely bytes on the wire — reading ten matched files whole costs 1.9–2.7 s
 * on the same link, and the only thing that comes back here is the ten lines
 * we are going to show.
 *
 * ## Bytes, not text
 *
 * `content` is `bytea`, and an upload keeps whatever the person had in the
 * folder: a PNG sits beside the code (D77). `convert_from(content, 'UTF8')`
 * throws on the first byte sequence that is not valid UTF-8, and one such file
 * would take down the whole query rather than the one row — so the match is
 * done over `encode(content, 'escape')`, which is **total**: every byte has a
 * spelling, no input can fail it, and it is a per-byte map, so a substring of
 * the bytes is still a substring of the escaping. The needle is spelled the
 * same way here in `escapeBytes`, which is the whole trick — the comparison is
 * byte-for-byte even though Postgres is comparing two `text` values.
 *
 * Two consequences, both deliberate:
 *
 *   - **Case folding is ASCII.** `encode` turns every byte over 127 into octal
 *     digits, so `lower()` folds `A`–`Z` and nothing else. The needle is
 *     lowercased in JavaScript first, where folding *is* Unicode-aware, so
 *     searching `CAFÉ` finds `café`; the reverse does not. For Korean, which
 *     has no case, this is no difference at all.
 *   - **A file with a NUL byte is not searched.** That is `asText`'s own test
 *     for "these bytes are not source", and a search that quietly matched
 *     inside a PNG would hand the answer a line number nobody can open. It is
 *     excluded from `searched` too, so it lands in the caller's count of files
 *     it could not look inside rather than in the count it may say "not there"
 *     about.
 *
 * ## What comes back, and what it is allowed to support
 *
 * Path, line number, and the text of that line — the three things the Q&A
 * citation ledger needs to let a finding stand as `certain` (D110). The bytes
 * of that line really did come back; the lines around it did not, and the
 * ledger entry the caller writes says so.
 *
 * `paths` is the caller's own list **in the order it wants the matches
 * ranked**, which is how the map's ranking survives a trip through SQL:
 * `array_position` is the rank, so the ten lines that come back are the ten
 * the caller would have picked. It is also the security boundary — the map is
 * the authority for what may be read, here exactly as in `read_source`.
 */
export type ProjectFileMatch = {
  path: string;
  /** 1-based, counting the way an editor does. */
  line: number;
  /** The whole line as stored, minus a trailing CR. Untrimmed, uncut. */
  text: string;
};

export type ProjectSearchResult = {
  matches: ProjectFileMatch[];
  /**
   * How many rows were actually looked inside.
   *
   * The only number an absence may rest on (D112). A path the caller named
   * that has no row, or one too big, or one that is not text, is not counted
   * here — the caller can subtract and say how many it could not look at.
   */
  searched: number;
};

export type ProjectSearchOptions = {
  /** The files to look inside, in the order matches should be ranked. */
  paths?: readonly string[];
  /** Only files under this path. A plain prefix, never a pattern. */
  prefix?: string;
  /** Most matched lines to return, over all files. */
  limit?: number;
  /** Most matched lines from any one file, so one loud file cannot crowd out nine quiet ones. */
  perFile?: number;
  /** Files bigger than this are not looked inside. */
  maxBytes?: number;
};

const SEARCH_LIMIT = 10;
const SEARCH_PER_FILE = 3;
/** The same ceiling `SOURCE_MAX_BYTES` puts on reading one file. */
const SEARCH_MAX_BYTES = 512 * 1024;

/**
 * One byte, spelled the way `encode(bytea, 'escape')` spells it.
 *
 * Postgres escapes exactly three things and leaves every other byte alone:
 * NUL, a backslash, and anything with the high bit set. Verified against the
 * production database rather than remembered — `byteaout` escapes control
 * characters too and this encoder does not, and getting that wrong would mean
 * a needle with a tab in it never matching anything.
 */
export function escapeBytes(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x00) out += "\\000";
    else if (byte === 0x5c) out += "\\\\";
    else if (byte >= 0x80) out += "\\" + byte.toString(8).padStart(3, "0");
    else out += String.fromCharCode(byte);
  }
  return out;
}

/** The same spelling, read back into the text it stood for. */
export function unescapeBytes(escaped: string): string {
  const bytes: number[] = [];
  for (let at = 0; at < escaped.length; ) {
    if (escaped.charCodeAt(at) === 0x5c) {
      if (escaped.charCodeAt(at + 1) === 0x5c) {
        bytes.push(0x5c);
        at += 2;
        continue;
      }
      const octal = escaped.slice(at + 1, at + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8));
        at += 4;
        continue;
      }
    }
    bytes.push(escaped.charCodeAt(at) & 0xff);
    at += 1;
  }
  // Bytes that are not valid UTF-8 come back as replacement characters rather
  // than as an exception: the line is shown as what it is, and the file it
  // came from was already one the caller offered as text.
  return Buffer.from(bytes).toString("utf8");
}

export async function searchProjectFiles(
  db: Db,
  projectId: string,
  needle: string,
  options: ProjectSearchOptions = {},
): Promise<ProjectSearchResult> {
  const wanted = needle.toLowerCase();
  if (wanted === "") return { matches: [], searched: 0 };
  // Nothing to look inside is a legitimate question with a legitimate answer,
  // and it keeps an empty array out of the SQL.
  if (options.paths && options.paths.length === 0) return { matches: [], searched: 0 };

  const target = escapeBytes(Buffer.from(wanted, "utf8"));
  const limit = options.limit ?? SEARCH_LIMIT;
  const perFile = options.perFile ?? SEARCH_PER_FILE;
  const maxBytes = options.maxBytes ?? SEARCH_MAX_BYTES;

  const paths = options.paths ? sql`${sql.param([...options.paths])}::text[]` : null;
  const under = options.prefix
    ? sql` and starts_with(${projectFiles.path}, ${options.prefix})`
    : sql``;
  const named = paths ? sql` and ${projectFiles.path} = any(${paths})` : sql``;
  // The caller's own order, or the file system's. `array_position` is O(n) per
  // row, which is nothing against the number of rows that reach it: only the
  // files that matched are ordered at all.
  const rank = paths
    ? sql`array_position(${paths}, scanned.path)`
    : sql`scanned.path`;

  const found = await db.execute<{
    searched: number;
    path: string | null;
    line: number | null;
    text: string | null;
  }>(sql`
    with scanned as materialized (
      select
        ${projectFiles.path} as path,
        strpos(lower(encode(${projectFiles.content}, 'escape')), ${target}) > 0 as hit
      from ${projectFiles}
      where ${projectFiles.projectId} = ${projectId}
        and ${projectFiles.size} <= ${maxBytes}
        and position(decode('00', 'hex') in ${projectFiles.content}) = 0${under}${named}
    ),
    tally as (select count(*)::int as searched from scanned),
    -- The files whose lines will be cut, and no more of them than could
    -- possibly be shown: every one of these contributes at least one line, so
    -- taking the best few can never come up short. Without it, a word written
    -- in every file of a large upload would have every one of them escaped
    -- and split apart to produce ten lines.
    top as (
      select scanned.path as path, ${rank} as at
      from scanned where scanned.hit order by 2 limit ${limit}
    )
    select tally.searched, hits.path, hits.line, hits.text
    from tally
    left join lateral (
      select top.path as path, found.n::int as line, found.txt as text
      from top
      join ${projectFiles} on ${projectFiles.projectId} = ${projectId}
        and ${projectFiles.path} = top.path
      cross join lateral (
        select line.n, line.txt
        from unnest(
          string_to_array(encode(${projectFiles.content}, 'escape'), chr(10))
        ) with ordinality as line(txt, n)
        where strpos(lower(line.txt), ${target}) > 0
        order by line.n
        limit ${perFile}
      ) as found
      order by top.at, found.n
      limit ${limit}
    ) as hits on true
  `);

  const rows = found.rows;
  return {
    // `tally` always has exactly one row, so the count survives a search that
    // matched nothing — which is the case where saying how many files were
    // looked inside matters most.
    searched: Number(rows[0]?.searched ?? 0),
    matches: rows
      .filter((row) => row.path !== null && row.line !== null)
      .map((row) => ({
        path: row.path as string,
        line: Number(row.line),
        // Split on the newline alone, so a CRLF file keeps a stray CR that
        // belongs to the line ending rather than to the line.
        text: unescapeBytes(row.text ?? "").replace(/\r$/, ""),
      })),
  };
}
