/**
 * Parsing what a person actually pastes into "add a project".
 *
 * Section 8 requires validating every external input with a schema, and this is
 * the first thing a user hands us. It is a pure function with no network call so
 * the failure messages can be exhaustive and tested — the brief asks that when
 * something is unsupported we say so "kindly and specifically", and specific
 * means naming what was wrong with the thing they pasted rather than rejecting
 * it with one generic sentence.
 */

export type ParsedRepo = {
  owner: string;
  repo: string;
  /** Canonical form we store and show back. */
  url: string;
};

export type RepoUrlError =
  | "empty"
  | "not_github"
  | "not_a_repo"
  | "gist"
  | "missing_repo"
  | "bad_owner"
  | "bad_repo";

export type ParseResult =
  | { ok: true; value: ParsedRepo }
  | { ok: false; error: RepoUrlError };

/**
 * GitHub paths that look like `owner/repo` but are not. Pasting the URL of a
 * settings page and being told "that repository is private" would be a
 * confusing lie, so these are rejected by name.
 */
const RESERVED_OWNERS = new Set([
  "settings",
  "marketplace",
  "explore",
  "topics",
  "collections",
  "sponsors",
  "orgs",
  "organizations",
  "notifications",
  "pulls",
  "issues",
  "codespaces",
  "new",
  "login",
  "join",
  "about",
  "pricing",
  "features",
  "security",
  "apps",
  "account",
  "dashboard",
  "search",
  "trending",
  "events",
]);

/** GitHub's own rules: alphanumeric and single hyphens, no leading or trailing hyphen, 39 max. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Repos also allow underscore and period, but are never "." or "..". */
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function parseRepoUrl(input: string): ParseResult {
  const raw = input.trim();
  if (raw === "") return { ok: false, error: "empty" };

  let host: string | null = null;
  let path: string;

  // git@github.com:owner/repo.git — an SSH remote, which people copy out of
  // their terminal as often as they copy a URL out of the address bar.
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(raw);
  if (ssh) {
    host = ssh[1].toLowerCase();
    path = ssh[2];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, error: "not_github" };
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } else if (/^[^/\s]+\.[^/\s]+\//.test(raw)) {
    // Looks like a bare host with a path: "github.com/owner/repo".
    const slash = raw.indexOf("/");
    host = raw.slice(0, slash).toLowerCase();
    path = raw.slice(slash);
  } else {
    // Bare "owner/repo", which is how people refer to repos in conversation.
    path = raw;
  }

  if (host !== null) {
    const bare = host.replace(/^www\./, "");
    if (bare === "gist.github.com") return { ok: false, error: "gist" };
    if (bare !== "github.com") return { ok: false, error: "not_github" };
  }

  const segments = path
    .split(/[?#]/)[0]
    .split("/")
    .filter((segment) => segment !== "");

  if (segments.length === 0) return { ok: false, error: "not_a_repo" };
  if (segments.length === 1) return { ok: false, error: "missing_repo" };

  const owner = segments[0];
  // Strip .git from an SSH or clone URL, but only as a suffix — a repo may
  // legitimately be named something like "dotgit".
  const repo = segments[1].replace(/\.git$/, "");

  if (RESERVED_OWNERS.has(owner.toLowerCase())) {
    return { ok: false, error: "not_a_repo" };
  }
  if (!OWNER_RE.test(owner)) return { ok: false, error: "bad_owner" };
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") {
    return { ok: false, error: "bad_repo" };
  }

  // Deeper paths (/tree/main/src, /blob/main/a.ts, /pull/3) are fine — the
  // person copied from somewhere inside the repo, which is the common case.
  // We take the repo and ignore the rest rather than making them edit the URL.
  return {
    ok: true,
    value: { owner, repo, url: `https://github.com/${owner}/${repo}` },
  };
}

/**
 * What the user reads. Plain language, says what happened and what to do next,
 * and never blames them (section 8, and Step 5's rule about error copy).
 */
export const REPO_URL_MESSAGES: Record<RepoUrlError, string> = {
  empty: "GitHub 저장소 주소를 붙여넣어 주세요.",
  not_github:
    "지금은 GitHub 저장소만 읽을 수 있어요. github.com 주소를 붙여넣어 주세요.",
  not_a_repo:
    "저장소 주소가 아닌 것 같아요. github.com/사용자이름/저장소이름 형태의 주소가 필요해요.",
  gist: "Gist는 아직 읽을 수 없어요. 저장소 주소를 붙여넣어 주세요.",
  missing_repo:
    "사용자 이름만 있고 저장소 이름이 없어요. github.com/사용자이름/저장소이름 형태로 붙여넣어 주세요.",
  bad_owner: "주소에서 사용자 이름을 알아볼 수 없어요. 다시 확인해 주세요.",
  bad_repo: "주소에서 저장소 이름을 알아볼 수 없어요. 다시 확인해 주세요.",
};
