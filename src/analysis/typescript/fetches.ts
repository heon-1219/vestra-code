/**
 * Which server address a piece of the screen is talking to.
 *
 * These edges did not exist, and their absence was not a small gap: in an app
 * whose front and back halves live in one repository, a `fetch("/api/orders")`
 * is the ONLY thing joining them. Without it the map draws two islands — every
 * screen on one side, every endpoint on the other, nothing crossing — and a
 * person looking for "where does the order actually get placed" is shown a
 * picture that says nowhere. Worse, it looks finished: there is no gap on the
 * screen, just two neighbourhoods that appear genuinely unrelated.
 *
 * ## What counts as a fetch
 *
 * `fetch(url, …)` and the axios family, and nothing else for now. The cost of
 * being generous here is not a missing edge, it is a WRONG one — a helper of
 * the user's own called `get(url)` would produce an edge to an endpoint nobody
 * calls from there, and a false connection on someone's own app is worse than
 * an absent one. The list grows when a real project needs it, not in advance.
 *
 * ## How a URL is matched
 *
 * A call writes `/api/projects/${id}/file`; a route is stored as
 * `/api/projects/[id]/file`. So the interpolated parts become wildcards, and a
 * wildcard matches exactly one path segment — never several, or `/api/${x}`
 * would match every endpoint in the project.
 *
 * **Ambiguity produces no edge at all.** If a pattern matches two endpoints we
 * cannot tell which was meant, and picking one is a fabricated fact about
 * someone's code. Nothing is claimed.
 */

/**
 * The stand-in for an interpolated part of a URL.
 *
 * Built with `fromCharCode` rather than written as an escape, and that is not
 * style. An escape does not survive the trip from an editor to this file --
 * every layer in between decodes it and writes the raw byte back -- and a raw
 * control character in source makes the whole file read as binary to grep, to
 * diff and to every review tool. This codebase has been bitten by it four
 * times now, twice in files nobody would think to check.
 *
 * A character that cannot occur in a URL is the point: a space can, so a space
 * would make `/api/my file` look like an interpolation.
 */
const WILDCARD = String.fromCharCode(0);

/** Where the URL was found and how sure we are that it names this endpoint. */
export type FetchMatch = {
  urlPath: string;
  /**
   * `certain` when every segment was written out and the address is the route,
   * `inferred` when a wildcard stood in for a segment.
   *
   * The distinction is real: `/api/orders` in the source and `/api/orders` in
   * the router is the same fact twice. `/api/${kind}/orders` matching
   * `/api/user/orders` is a guess that happens to be the only one available,
   * and the map draws it as a guess.
   */
  confidence: "certain" | "inferred";
};

/**
 * The callee names we treat as "this is a request to a server".
 *
 * Matched on the last part of the expression, so `axios.get`, `client.get` and
 * a bare `get` are the same name — which is why the bare names are absent. Only
 * `fetch` stands alone, because nothing else in a browser is called that.
 */
const FETCH_CALLEES = new Set(["fetch"]);

/** Recognised on the member name, but only when the object looks like axios. */
const AXIOS_METHODS = new Set(["get", "post", "put", "patch", "delete", "request"]);

/**
 * Does this callee expression mean a request?
 *
 * `text` is the whole callee as written — `fetch`, `axios.get`,
 * `window.fetch`, `api.client.post`.
 */
export function isFetchCallee(text: string): boolean {
  const trimmed = text.trim();
  if (FETCH_CALLEES.has(trimmed)) return true;
  // `window.fetch` and `globalThis.fetch` are the same function.
  if (/^(?:window|globalThis|self)\.fetch$/.test(trimmed)) return true;

  const parts = trimmed.split(".");
  if (parts.length < 2) return false;
  const method = parts[parts.length - 1];
  const object = parts[parts.length - 2];
  // The object has to say axios. A user's own `client.get` is not evidence of
  // anything, and treating it as such is how a false edge gets drawn.
  return AXIOS_METHODS.has(method) && /^axios$/i.test(object);
}

/**
 * The URL a call is asking for, as a pattern, or null when it is not knowable.
 *
 * `parts` are the literal chunks of a template with the interpolations removed:
 * `` `/api/projects/${id}/file` `` arrives as `["/api/projects/", "/file"]`.
 * A plain string literal arrives as a single part and is exact.
 */
export function urlPatternOf(parts: readonly string[], interpolated: boolean): string | null {
  if (parts.length === 0) return null;

  const joined = interpolated ? parts.join(WILDCARD) : parts[0];

  // A query string and a fragment are arguments to the endpoint, not part of
  // its address. `/api/repos?page=2` and `/api/repos` are the same route.
  const withoutQuery = joined.split("?")[0].split("#")[0];

  // Only same-origin paths. An absolute URL to another host is a real
  // connection and it is not a connection to anything in this repository, so
  // claiming an edge to a route of ours that happens to share a path would be
  // wrong in a way nobody would ever check.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(withoutQuery)) return null;
  if (withoutQuery.startsWith("//")) return null;
  if (!withoutQuery.startsWith("/")) return null;

  return withoutQuery;
}

/**
 * The endpoint a pattern names, if exactly one does.
 *
 * `endpoints` are route paths as the router stores them, with `[id]` for a
 * dynamic segment and `[...rest]` for a catch-all.
 */
export function matchEndpoint(
  pattern: string,
  endpoints: readonly string[],
): FetchMatch | null {
  const wanted = segmentsOf(pattern);
  if (wanted === null) return null;

  const hits: (FetchMatch & { wildcards: number })[] = [];
  for (const endpoint of endpoints) {
    const segments = segmentsOf(endpoint) ?? [];
    const confidence = matchSegments(wanted, segments);
    if (confidence) {
      hits.push({
        urlPath: endpoint,
        confidence,
        wildcards: segments.filter((s) => s.startsWith("[")).length,
      });
    }
  }

  if (hits.length === 0) return null;
  if (hits.length === 1) return strip(hits[0]);

  /*
   * More than one endpoint fits, and the router already has an answer.
   *
   * `/api/orders` written out fits both `/api/orders` and `/api/[section]`,
   * and every router in this family sends it to the literal one — a static
   * segment beats a dynamic segment. So the tie is broken by counting the
   * route's OWN wildcards and taking the fewest, which is modelling what
   * actually happens rather than guessing.
   *
   * The first version of this ranked by our own confidence instead, and got
   * this case wrong in the worst direction: both matches came back `certain`
   * (the call wrote every segment out), the tie never broke, and a perfectly
   * ordinary literal fetch produced no edge at all.
   *
   * If two routes are still equally specific we genuinely cannot tell, and we
   * say nothing rather than pick one.
   */
  const fewest = Math.min(...hits.map((hit) => hit.wildcards));
  const best = hits.filter((hit) => hit.wildcards === fewest);
  return best.length === 1 ? strip(best[0]) : null;
}

function strip(hit: FetchMatch & { wildcards: number }): FetchMatch {
  return { urlPath: hit.urlPath, confidence: hit.confidence };
}

/** A path split into segments, or null if it is not a path at all. */
function segmentsOf(value: string): string[] | null {
  if (!value.startsWith("/")) return null;
  return value.split("/").slice(1).filter((segment) => segment.length > 0);
}

/**
 * Whether a call's segments can be the route's, and how certainly.
 *
 * Returns null for no match. A wildcard in the call (from a `${…}`) matches one
 * route segment; a dynamic route segment (`[id]`) matches one call segment; a
 * catch-all (`[...rest]`) takes the remainder.
 */
function matchSegments(
  call: readonly string[],
  route: readonly string[],
): "certain" | "inferred" | null {
  let guessed = false;
  let c = 0;
  let r = 0;

  while (c < call.length && r < route.length) {
    const left = call[c];
    const right = route[r];

    if (right.startsWith("[...")) {
      // A catch-all eats everything that is left, and there has to BE something
      // left — `/api/files/[...path]` is not reached by `/api/files`.
      return c < call.length ? (guessed ? "inferred" : "certain") : null;
    }

    const callWild = left.includes(WILDCARD);
    const routeWild = right.startsWith("[") && right.endsWith("]");

    if (callWild) {
      // An interpolation inside a longer segment — `page-${n}.json` — still
      // occupies exactly one segment, whatever the rest of it says.
      guessed = true;
    } else if (routeWild) {
      // The route expects a value here and the call wrote one out. That is a
      // match, and the route's own dynamic segment is not a guess on our part.
    } else if (left !== right) {
      return null;
    }

    c += 1;
    r += 1;
  }

  if (c !== call.length || r !== route.length) return null;
  return guessed ? "inferred" : "certain";
}
