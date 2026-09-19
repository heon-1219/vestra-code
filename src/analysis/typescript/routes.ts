/**
 * Turning a Next.js file path into the address a person types.
 *
 * This is the one part of Pass 1 that is pure convention rather than
 * compilation, which makes it both the easiest thing to get right and the
 * easiest to get subtly wrong — a route group left in the URL, or a parallel
 * route slot treated as a path segment, produces addresses that do not exist
 * and the user is shown pages of their app that they cannot visit.
 */

export type RouteHit =
  | { kind: "route"; urlPath: string }
  | { kind: "api_endpoint"; urlPath: string }
  | null;

const PAGE_FILE = /^(page|route)\.(tsx|ts|jsx|js|mjs)$/;
const PAGES_ROUTER_FILE = /\.(tsx|ts|jsx|js|mjs)$/;

/** `_app`, `_document` and friends are machinery, not pages a user visits. */
const PAGES_ROUTER_SPECIAL = /^_(app|document|error|middleware)$/;

/**
 * Segments that shape the tree without appearing in the URL.
 *
 * - `(marketing)` — a route group, purely organisational.
 * - `@modal` — a parallel route slot, rendered into a layout rather than navigated to.
 */
function isInvisibleSegment(segment: string): boolean {
  return (
    (segment.startsWith("(") && segment.endsWith(")")) || segment.startsWith("@")
  );
}

/** `(.)photo`, `(..)feed` — intercepting routes. Real, but not their own address. */
function isInterceptingSegment(segment: string): boolean {
  return /^\((\.{1,3}|\.{2}\)\()/.test(segment);
}

function toUrlSegment(segment: string): string | null {
  // [[...slug]] — optional catch-all. Matches the parent path too, so the
  // segment itself contributes nothing mandatory.
  if (segment.startsWith("[[...") && segment.endsWith("]]")) return null;
  // [...slug] — catch-all.
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return `:${segment.slice(4, -1)}*`;
  }
  // [id] — dynamic.
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return `:${segment.slice(1, -1)}`;
  }
  return segment;
}

function joinUrl(segments: string[]): string {
  const cleaned = segments.filter((s) => s.length > 0);
  return cleaned.length === 0 ? "/" : `/${cleaned.join("/")}`;
}

/**
 * @param repoPath repo-relative, POSIX separators.
 */
export function classifyRoute(repoPath: string): RouteHit {
  const parts = repoPath.split("/");

  // Both `app/` and `src/app/` are idiomatic, and so are the pages equivalents.
  let index = 0;
  if (parts[0] === "src") index = 1;
  const rootSegment = parts[index];
  const rest = parts.slice(index + 1);

  if (rootSegment === "app") return classifyAppRouter(rest);
  if (rootSegment === "pages") return classifyPagesRouter(rest);
  return null;
}

function classifyAppRouter(rest: string[]): RouteHit {
  if (rest.length === 0) return null;

  const file = rest[rest.length - 1];
  const match = PAGE_FILE.exec(file);
  if (!match) return null;

  const directories = rest.slice(0, -1);
  if (directories.some(isInterceptingSegment)) return null;

  const segments: string[] = [];
  for (const directory of directories) {
    if (isInvisibleSegment(directory)) continue;
    const segment = toUrlSegment(directory);
    if (segment !== null) segments.push(segment);
  }

  const urlPath = joinUrl(segments);
  return match[1] === "route"
    ? { kind: "api_endpoint", urlPath }
    : { kind: "route", urlPath };
}

function classifyPagesRouter(rest: string[]): RouteHit {
  if (rest.length === 0) return null;

  const file = rest[rest.length - 1];
  if (!PAGES_ROUTER_FILE.test(file)) return null;

  const bare = file.replace(PAGES_ROUTER_FILE, "");
  if (PAGES_ROUTER_SPECIAL.test(bare)) return null;
  // A directory of components under pages/ is unusual but legal; only files
  // whose name is not a component convention become routes. Keep it simple:
  // everything that is not special is a page, which is what Next.js does.

  const isApi = rest[0] === "api";
  const directories = rest.slice(0, -1);

  const segments: string[] = [];
  for (const directory of directories) {
    const segment = toUrlSegment(directory);
    if (segment !== null) segments.push(segment);
  }

  // `pages/blog/index.tsx` is `/blog`, not `/blog/index`.
  if (bare !== "index") {
    const segment = toUrlSegment(bare);
    if (segment !== null) segments.push(segment);
  }

  const urlPath = joinUrl(segments);
  return isApi
    ? { kind: "api_endpoint", urlPath }
    : { kind: "route", urlPath };
}
