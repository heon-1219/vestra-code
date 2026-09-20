import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Db } from "@/db";
import { projectDigests } from "@/db/schema";

import { normaliseDigest, type ProjectDigest } from "./digest";
import type { DigestDocument } from "./build";

/**
 * Where a digest is kept, and what it is kept against.
 *
 * `import type { Db }` rather than the value, exactly as `src/qa/readers.ts`
 * does: the type is erased, so nothing here pulls in the connection pool or the
 * environment it needs. The schema module is types and table definitions only.
 *
 * ## The two bases
 *
 * A digest stops being true when the documents change, and the cheapest honest
 * proxy for that depends on what the project is:
 *
 *   - **A commit sha**, where there is one. It is exactly the moment the
 *     documents could have changed, it is already computed by
 *     `src/analysis/incremental.ts`, and — the part that matters — it is known
 *     BEFORE anything is read, so a cache hit costs one small query and no file
 *     reads at all.
 *   - **A fingerprint of the documents**, where there is not: an uploaded
 *     folder, or a project whose last completed run recorded no commit. There
 *     is nothing else that changes when a README does. The cost is stated
 *     rather than hidden: the documents have to be read before the key exists,
 *     so this saves the model call and not the reads. For an upload the reads
 *     are rows in this same database, which is why that trade is acceptable;
 *     if it ever has to hold for a GitHub project with no run, the reads are
 *     network round trips and it is worth revisiting.
 *
 * Rows are written once and never updated. A new basis is a new row, so a stale
 * digest is one nobody asks for again rather than one somebody has to notice.
 */

export function commitBasis(commitSha: string): string {
  return `commit:${commitSha}`;
}

/**
 * A fingerprint of exactly what would be summarised.
 *
 * Path, length and content of each document, in the order they would be sent.
 * JSON-encoded rather than joined with a separator, for the reason `ids.ts`
 * records at length: any separator has to be a character that cannot appear in
 * a path, which means a control character, and a literal control character in
 * source is what gets silently rewritten in transit. This codebase has been
 * bitten by that more than once.
 */
export function documentBasis(documents: readonly DigestDocument[]): string {
  const parts = documents.flatMap((document) => [
    document.path,
    String(document.text.length),
    document.text,
  ]);
  const hash = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
  return `docs:${hash}`;
}

/**
 * The digest held for this basis, or null.
 *
 * Re-normalised on the way out. The row was written by us, but by whichever
 * version of this code was deployed when it was written — and how big this
 * block is in every prompt is not a property to discover from a token bill.
 */
export async function readStoredDigest(
  db: Db,
  projectId: string,
  basis: string,
): Promise<ProjectDigest | null> {
  const [row] = await db
    .select({
      about: projectDigests.about,
      words: projectDigests.words,
      sources: projectDigests.sources,
    })
    .from(projectDigests)
    .where(
      and(
        eq(projectDigests.projectId, projectId),
        eq(projectDigests.basis, basis),
      ),
    )
    .limit(1);

  if (!row) return null;
  return normaliseDigest(row);
}

/**
 * Keep it, unless somebody already did.
 *
 * `onConflictDoNothing` rather than an upsert: two questions asked at the same
 * moment each build a digest, both are valid, and the first one to land is the
 * one every later prompt should use. Overwriting would mean the same project
 * answered from two slightly different descriptions depending on timing, which
 * is the kind of difference nobody would think to look for.
 */
export async function writeStoredDigest(
  db: Db,
  input: { projectId: string; basis: string; digest: ProjectDigest },
): Promise<void> {
  await db
    .insert(projectDigests)
    .values({
      id: randomUUID(),
      projectId: input.projectId,
      basis: input.basis,
      about: input.digest.about,
      words: input.digest.words,
      sources: input.digest.sources,
    })
    .onConflictDoNothing({
      target: [projectDigests.projectId, projectDigests.basis],
    });
}
