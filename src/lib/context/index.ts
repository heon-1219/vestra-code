import type { Db } from "@/db";
import type { GraphItem } from "@/lib/graph/view";
import type { Llm } from "@/lib/llm/types";
// A type-only import across a boundary that runs the other way at run time.
// `src/qa/source.ts` has no imports of its own, the type is erased, and one
// definition of "how a file is read" is worth more than the tidier direction:
// a second shape would be a second place for the refusal reasons to drift.
import type { SourceReader } from "@/qa/source";

import { buildDigest, DIGEST_LIMITS, type DigestDocument } from "./build";
import type { ProjectDigest } from "./digest";
import { contextDocumentPaths } from "./documents";
import {
  commitBasis,
  documentBasis,
  readStoredDigest,
  writeStoredDigest,
} from "./store";

/**
 * The project context digest, as the rest of the product sees it.
 *
 * One function: given a project and the things needed to reach it, either the
 * digest it already has, a freshly built one, or **null**. Null is a first-class
 * answer and the one to read carefully — a project with no README gets no
 * digest and the investigation runs exactly as it does today. A smaller honest
 * input, never an invented one.
 *
 * ## Why this is lazy
 *
 * Built on the first question rather than during analysis. Two reasons, and the
 * second is the one that decided it:
 *
 *   1. It only costs tokens for projects somebody actually asks about. Most
 *      analysed projects are never asked a question.
 *   2. It keeps this entirely out of `src/analysis/**`. The analysis pipeline
 *      has an event contract and a phase machine; adding a model call to it to
 *      produce something only the Q&A path reads would couple two things that
 *      have no reason to know about each other.
 *
 * ## What it is for, and what it is not
 *
 * It is **context for naming and explaining**. It helps the model call things
 * what their author calls them, and it may help it decide where to look first
 * instead of spending a step of six on `list_files` working out what the
 * project is.
 *
 * It is **never evidence**. A README describes features that were removed and
 * features nobody built. Nothing in this module writes to the citation ledger
 * in `src/qa/tools.ts`, so a sentence that came from here can never become a
 * cited finding: `src/qa/answer.ts` refuses any claim whose citation does not
 * match something the investigation itself fetched, and the digest fetches
 * nothing on its behalf. That is not a convention — it is the reason the two
 * halves are wired the way they are, and there is a test for it.
 *
 * `build.ts` and `digest.ts` are deliberately importable without this file.
 * This one reaches the database; those two are what a unit test loads.
 */

export type ProjectDigestInput = {
  db: Db;
  projectId: string;
  /**
   * The commit the last completed run analysed, or null.
   *
   * The same value the answer's source is read at, for the same reason: it is
   * what the map was measured against. Null is normal — an upload, or a run
   * that recorded no sha — and is handled by keying on the documents instead.
   */
  commitSha: string | null;
  /** The project's own map. The authority for which files exist (D18 paths). */
  items: readonly GraphItem[];
  /** Null for a project whose files cannot be opened at all. Then: no digest. */
  read: SourceReader | null;
  /** Injected. Nothing here knows which provider is behind it. */
  llm: Llm;
  signal?: AbortSignal;
};

export async function projectDigest(
  input: ProjectDigestInput,
): Promise<ProjectDigest | null> {
  const paths = contextDocumentPaths(input.items);
  // No README, no AGENTS.md, nothing in docs/. There is nothing to summarise
  // and nothing to invent, so this costs one pass over the item list.
  if (paths.length === 0) return null;
  // The map says these files exist; without a reader we cannot open them.
  if (!input.read) return null;

  /*
   * With a commit sha the cache is checked BEFORE anything is read, which is
   * the whole win: on every question after the first, a project's digest costs
   * one indexed query and no file reads at all.
   */
  const knownBasis = input.commitSha ? commitBasis(input.commitSha) : null;
  if (knownBasis) {
    const held = await readStoredDigest(input.db, input.projectId, knownBasis);
    if (held) return held;
  }

  const documents = await readDocuments(input.read, paths, input.signal);
  // Every candidate refused — deleted since the map was drawn, too large, not
  // text. Same answer as having none: no digest.
  if (documents.length === 0) return null;

  /*
   * Without a commit sha the documents themselves are the key, so they have to
   * be read before the cache can be asked. The model call is still saved, which
   * is the expensive half; the reads are not, which is stated here rather than
   * discovered later. For an upload those reads are rows in the same database.
   */
  const basis = knownBasis ?? documentBasis(documents);
  if (!knownBasis) {
    const held = await readStoredDigest(input.db, input.projectId, basis);
    if (held) return held;
  }

  const digest = await buildDigest({
    llm: input.llm,
    documents,
    signal: input.signal,
  });
  if (!digest) return null;

  await writeStoredDigest(input.db, {
    projectId: input.projectId,
    basis,
    digest,
  });
  return digest;
}

/**
 * The documents, in the order they were chosen, skipping the ones that will not
 * open.
 *
 * A refusal is not an error here. The map is drawn at a commit and read at one;
 * a file can still be missing, be a binary somebody named `README.txt`, or be
 * over the reader's own ceiling. Each of those means one fewer document, and
 * the digest is built from whatever is left — down to nothing, which is null
 * and is fine.
 */
async function readDocuments(
  read: SourceReader,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<DigestDocument[]> {
  const documents: DigestDocument[] = [];
  let total = 0;

  for (const path of paths) {
    if (signal?.aborted) break;
    if (total >= DIGEST_LIMITS.maxTotalChars) break;

    const result = await read(path, signal);
    if (!result.ok) continue;
    const text = result.text.trim();
    if (text === "") continue;

    total += text.length;
    documents.push({ path, text });
  }

  return documents;
}

export { contextDocumentPaths, MAX_CONTEXT_DOCUMENTS } from "./documents";
export {
  renderDigestBlock,
  DIGEST_FENCE_CLOSE,
  DIGEST_FENCE_OPEN,
  type ProjectDigest,
} from "./digest";
