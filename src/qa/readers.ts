import type { Db } from "@/db";
import { fetchRawFile, type RateLimit } from "@/lib/github/raw";
import { readProjectFiles, searchProjectFiles } from "@/lib/preview/store";

import {
  asText,
  matchText,
  SOURCE_MAX_BYTES,
  type SourceQuota,
  type SourceReader,
  type SourceResult,
} from "./source";

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
  const read: SourceReader = async (path) => {
    const [file] = await readProjectFiles(db, projectId, [path]);
    // Not an error: a file over its kind's ceiling, or one of a kind we cannot
    // draw, was described in the map and never stored (`lib/preview/store`).
    if (!file) return { ok: false, reason: "not_found" };
    return asText(file.content);
  };

  /*
   * An upload can be searched where it lives, and that is the whole difference.
   *
   * Pulling the files out to look inside them bounded the content search at
   * sixty, because sixty reads is what fits in the time somebody will wait: on
   * a real upload's worth of files, measured, sixty single-path reads cost
   * 16.4 s and looked inside 60 of 284. This asks the database instead — one
   * query, 95–141 ms, all 284 — and only the lines it is going to show come
   * back over the wire.
   *
   * The map's own file list is what is handed down, in the order the caller
   * ranked it. That is deliberately the same authority `read_source` uses: a
   * path the model produced is a request, not a permission, and a search that
   * reached rows the map does not hold would put a line in the citation ledger
   * that nothing else in the product would open.
   */
  read.searchAll = async (needle, options) => {
    const found = await searchProjectFiles(db, projectId, needle, {
      paths: options.paths,
      prefix: options.prefix,
      limit: options.limit,
      perFile: options.perFile,
      maxBytes: SOURCE_MAX_BYTES,
    });
    return {
      searched: found.searched,
      matches: found.matches.map((match) => ({
        path: match.path,
        line: match.line,
        // The same line the fetch-and-scan path would have shown, cut by the
        // same rule, because they are two ways of answering one question.
        text: matchText(match.text),
      })),
    };
  };

  return read;
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

    /*
     * What GitHub said is left, carried up with the answer either way.
     *
     * It rides on the refusals as well as on the successes, which is the half
     * that matters: the response that says "no" is the one that says how long
     * it will keep saying it. `search_source` sizes its sweep from this rather
     * than asking for sixty fetches whether six hundred requests remain or six.
     */
    const quota = quotaOf(result.rate);

    if (!result.ok) {
      if (result.error === "too_large") {
        return { ok: false, reason: "too_large", quota };
      }
      if (result.error === "not_found") {
        return { ok: false, reason: "not_found", quota };
      }
      /*
       * Rate limiting is carried through rather than folded in with the rest.
       *
       * It used to arrive as `unavailable` with everything else, and a loop
       * that cannot tell them apart keeps trying: measured on a real
       * investigation, seven of twenty steps went on opening seven different
       * files that were all refused for the same reason, and the answer came
       * back `inferred` on a project whose source was perfectly readable ten
       * minutes earlier. An unauthenticated read is rated at sixty an hour and
       * `search_source` looks inside tens of files at once, so this is a
       * failure the product will meet.
       */
      if (result.error === "rate_limited") {
        return { ok: false, reason: "rate_limited", quota };
      }
      // Private, unreachable, a dropped socket: all "try again later" to the
      // person asking, and none of them a reason to invent an answer instead.
      return { ok: false, reason: "unavailable", quota };
    }

    const collected = await collect(result.value.body);
    return collected.ok
      ? { ok: true, text: collected.text, quota }
      : { ok: false, reason: collected.reason, quota };
  };
}

/**
 * GitHub's numbers, or nothing at all.
 *
 * A missing header means we do not know, and "we do not know" must not become
 * "none left" — a search told there was nothing left would narrow itself to
 * nothing on a repository it could have read perfectly well.
 */
function quotaOf(rate: RateLimit): SourceQuota | undefined {
  if (rate.remaining === null) return undefined;
  return { remaining: rate.remaining, reset: rate.reset };
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
