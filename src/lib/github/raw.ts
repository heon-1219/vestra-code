import type { GithubFailure } from "./api";

/**
 * One file's bytes from GitHub, at one commit, on demand.
 *
 * This is the fetch that section 3's promise anticipates. We keep the map —
 * paths, line ranges, what connects to what — and we keep no source. When
 * someone asks to look at a file, we go and get it, hand it straight to them,
 * and keep nothing. So the shape of this module is dictated by that promise:
 *
 *   - It returns a **stream**, never a string or a buffer. A 20 MB PDF must
 *     never sit in our process, and `await response.text()` on the way to
 *     `new Response(text)` would put it there twice.
 *   - It never touches the disk and never writes a row.
 *   - The ceiling is checked **before the body is read**, from the length GitHub
 *     declares in the response head. Checking after would mean having already
 *     moved the thing we were refusing to move.
 *
 * A second, cheaper guard rides along the stream itself for the case where
 * GitHub declares no length: the transform counts bytes and errors past the
 * ceiling. It cannot un-send the head — by then the client already has a 200 —
 * so it is a backstop, not the gate. The declared-length check is the gate.
 */

/** Everything `fetchRepo` can fail with, plus the one failure only this has. */
export type RawFailure = GithubFailure | "too_large";

export type RawFile = {
  /**
   * The bytes, not yet read. Hand this to a `Response` and let the runtime
   * pump it; do not collect it.
   */
  body: ReadableStream<Uint8Array>;
  /** What GitHub declared, when it declared anything. */
  size: number | null;
};

/**
 * What GitHub says is left of our hourly allowance, off the answer it just
 * gave us.
 *
 * Free: it rides on a response we were making anyway, on the refusals as well
 * as on the successes. It is here because of a measured failure — a content
 * search asks for sixty files whether six hundred requests remain or six, and
 * with the limit exhausted it spent sixty round trips discovering that and
 * then reported the wall as an absence (D112). A search that can read this
 * number can decline to walk into it, and say that it narrowed and why.
 *
 * Both are null when GitHub did not say, which happens: a cached response, a
 * proxy in between, a network failure before any head arrived. Null means
 * "unknown", never "none left" — a caller that treated the two alike would
 * stop looking on a repository that was perfectly readable.
 */
export type RateLimit = {
  remaining: number | null;
  /** Seconds since the epoch, as GitHub counts them. */
  reset: number | null;
};

export const NO_RATE_LIMIT: RateLimit = { remaining: null, reset: null };

export type RawResult =
  | { ok: true; value: RawFile; rate: RateLimit }
  | {
      ok: false;
      error: RawFailure;
      status?: number;
      size?: number | null;
      rate: RateLimit;
    };

const GITHUB_API = "https://api.github.com";

/**
 * The contents endpoint with the raw media type, rather than
 * `raw.githubusercontent.com`.
 *
 * Two reasons. The raw host does not take a bearer token, so a repository the
 * signed-in user can reach but the public cannot would 404 there for no good
 * reason; and an authenticated API call is rated at 5,000 an hour against the
 * 60 an unauthenticated one gets, which one person opening a handful of files
 * can exhaust on a shared host.
 */
export function buildRawUrl(
  owner: string,
  repo: string,
  ref: string,
  path: string,
): string {
  // Each segment on its own: a slash between segments is structure, a slash
  // inside a name is not, and `encodeURIComponent` on the whole path would
  // escape the separators too.
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return (
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
  );
}

function headersFor(token: string | null): Record<string, string> {
  const base: Record<string, string> = {
    // `+json` is GitHub's own spelling for "the file itself, please".
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub asks for a User-Agent and rejects requests without one.
    "User-Agent": "vestra-code",
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

/**
 * A 404 does not distinguish "no such file" from "you cannot see it", by
 * design. We do not guess: the caller already knows the file was in this
 * project's own map, so the sentence it says is about the file having moved.
 */
function classify(status: number): GithubFailure {
  if (status === 404) return "not_found";
  if (status === 403 || status === 429) return "rate_limited";
  if (status === 451) return "unavailable";
  return "unavailable";
}

/** The declared length, or null when GitHub did not declare one. */
export function declaredSize(response: {
  headers: { get(name: string): string | null };
}): number | null {
  return wholeHeader(response, "content-length");
}

/** What is left of the allowance, off the headers of the answer we just got. */
export function rateLimitOf(response: {
  headers: { get(name: string): string | null };
}): RateLimit {
  return {
    remaining: wholeHeader(response, "x-ratelimit-remaining"),
    reset: wholeHeader(response, "x-ratelimit-reset"),
  };
}

/** A header that is a count, or null when it is missing or is not one. */
function wholeHeader(
  response: { headers: { get(name: string): string | null } },
  name: string,
): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Count the bytes going past and stop if there are too many.
 *
 * Only reachable when GitHub declared no length. Erroring the stream aborts the
 * response mid-flight, which the browser sees as a broken transfer rather than
 * as a short file — the one outcome worse than either would be handing over a
 * silently truncated file and letting someone read it as the whole thing.
 */
function capped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new Error("preview: file exceeded the ceiling mid-stream"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export type FetchRawArgs = {
  owner: string;
  repo: string;
  /** A commit sha where we have one, so the line numbers on the map still line up. */
  ref: string;
  /** Repo-relative, POSIX separators. Already checked against the project's own files. */
  path: string;
  /** The signed-in user's, when they have one. Null is a normal outcome. */
  token: string | null;
  maxBytes: number;
  /** Injected by the tests. Nothing else passes it. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export async function fetchRawFile(args: FetchRawArgs): Promise<RawResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const url = buildRawUrl(args.owner, args.repo, args.ref, args.path);

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: headersFor(args.token),
      // Nothing about this may be held anywhere. Not in the fetch cache on the
      // way in, and — see the route — not in any cache on the way out.
      cache: "no-store",
      signal: args.signal,
    });
  } catch {
    // Nothing came back at all, so there is nothing to say about the
    // allowance. Unknown, which is not the same as none left.
    return { ok: false, error: "unavailable", rate: NO_RATE_LIMIT };
  }

  // Read off every answer, including the ones that refuse — a 403 carries the
  // number that explains it, and that is the one a caller most needs.
  const rate = rateLimitOf(response);

  if (!response.ok) {
    // Nothing is going to read this body, and an unread body holds a socket
    // open until the runtime gives up on it.
    await discard(response);
    return {
      ok: false,
      error: classify(response.status),
      status: response.status,
      rate,
    };
  }

  const size = declaredSize(response);

  // The gate. Before a single byte of the body is pulled.
  if (size !== null && size > args.maxBytes) {
    await discard(response);
    return { ok: false, error: "too_large", size, rate };
  }

  if (!response.body) {
    // A 200 with no body at all: an empty file reaches us this way in some
    // runtimes, and an empty file is an answer rather than a failure.
    return { ok: true, value: { body: emptyStream(), size: size ?? 0 }, rate };
  }

  return {
    ok: true,
    value: { body: capped(response.body, args.maxBytes), size },
    rate,
  };
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed, or the runtime cancelled it for us. Either is fine.
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * What a person reads for each way this can fail.
 *
 * Deliberately not the same strings as `GITHUB_MESSAGES` in `api.ts`. Those are
 * written for someone who is connecting a repository and can fix the address;
 * these are for someone who clicked a file in their own map, where "공개
 * 저장소인지 확인해 주세요" would be advice about a problem they do not have.
 */
export const RAW_MESSAGES: Record<RawFailure, string> = {
  not_found:
    "지금은 그 파일을 찾지 못했어요. 지도를 그린 뒤에 지워졌거나 이름이 바뀌었을 수 있어요. 다시 읽기를 하면 지도가 최신이 돼요.",
  private:
    "지금은 이 저장소를 읽을 수 없어요. 비공개로 바뀌었는지 확인해 주세요.",
  rate_limited:
    "GitHub 요청 한도에 걸렸어요. 잠시 후 다시 열어 주세요. GitHub 계정으로 로그인하시면 한도가 훨씬 넉넉해져요.",
  unavailable: "GitHub에 연결하지 못했어요. 잠시 후 다시 열어 주세요.",
  empty_repo: "저장소가 비어 있어요.",
  malformed: "GitHub에서 예상과 다른 응답이 왔어요. 잠시 후 다시 열어 주세요.",
  too_large:
    "파일이 커서 여기서는 열지 않았어요. GitHub에서 열어보실 수 있어요.",
};
