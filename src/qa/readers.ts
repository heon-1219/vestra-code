import type { Db } from "@/db";
import { fetchRawFile } from "@/lib/github/raw";
import { readProjectFiles } from "@/lib/preview/store";

import { asText, SOURCE_MAX_BYTES, type SourceReader, type SourceResult } from "./source";

/**
 * The two ways this product can reach a file, and there are exactly two.
 *
 * The file endpoint (`app/api/projects/[id]/file/route.ts`) already made this
 * decision and it is not re-made here: a GitHub project stores no source and is
 * fetched on demand at the commit the map was measured against; an uploaded
 * project has no origin to fetch from and is read back from `project_files`
 * (D77). Inventing a third path is how the two would drift, and they must not
 * — a line number means the same thing in a preview and in an answer or it
 * means nothing in either.
 *
 * Both are `SourceReader`s, so the loop cannot tell which it has. That is the
 * whole point: everything above this file is testable with a fake reader and a
 * string, with no database and no network.
 *
 * D67 said the Q&A agent's `read_source` could not work on an uploaded project,
 * because we kept no copy. D77 kept the copy, so that reason is gone and this
 * reader is what replaces it. What has NOT changed is the failure being said
 * out loud: an upload that hit a storage cap has no bytes here, and the answer
 * is a sentence about that, never a silent `inferred` finding dressed up as a
 * reading.
 */

/** Files an uploaded project kept. */
export function storedSourceReader(db: Db, projectId: string): SourceReader {
  return async (path) => {
    const [file] = await readProjectFiles(db, projectId, [path]);
    // Not an error: a file over its kind's ceiling, or one of a kind we cannot
    // draw, was described in the map and never stored (`lib/preview/store`).
    if (!file) return { ok: false, reason: "not_found" };
    return asText(file.content);
  };
}

export type GithubSource = {
  owner: string;
  repo: string;
  /**
   * The commit the analysis measured, where there is one.
   *
   * Not the branch tip. The line ranges on the map were counted against this
   * tree, and reading the tip instead would cite line 120 of a file whose line
   * 120 has since moved — quietly wrong in the one way this product cannot
   * afford, because the citation is the entire basis of the answer.
   */
  ref: string;
  token: string | null;
  fetchImpl?: typeof globalThis.fetch;
};

/** One file from GitHub, held just long enough to cut a window out of it. */
export function githubSourceReader(source: GithubSource): SourceReader {
  return async (path, signal) => {
    const result = await fetchRawFile({
      owner: source.owner,
      repo: source.repo,
      ref: source.ref,
      path,
      token: source.token,
      maxBytes: SOURCE_MAX_BYTES,
      fetchImpl: source.fetchImpl,
      signal,
    });

    if (!result.ok) {
      if (result.error === "too_large") return { ok: false, reason: "too_large" };
      if (result.error === "not_found") return { ok: false, reason: "not_found" };
      // Rate limited, private, unreachable: all "try again later" to the person
      // asking, and none of them a reason to invent an answer instead.
      return { ok: false, reason: "unavailable" };
    }

    return collect(result.value.body);
  };
}

/**
 * The stream, into a string, under the ceiling.
 *
 * `raw.ts` returns a stream because a preview must never hold a 20 MB file in
 * this process. Here we do have to hold it — you cannot count lines you have
 * not seen — so the ceiling is what keeps "hold" meaning half a megabyte for a
 * few milliseconds. Nothing is written, nothing is cached, and the string is
 * unreferenced as soon as the window is cut.
 */
async function collect(body: ReadableStream<Uint8Array>): Promise<SourceResult> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SOURCE_MAX_BYTES) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // The byte-counting transform in `raw.ts` errors the stream past its own
    // ceiling, and a socket can drop mid-file. Neither is worth two sentences.
    return { ok: false, reason: "unavailable" };
  }

  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return asText(bytes);
}
