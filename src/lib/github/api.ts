import { z } from "zod";

/**
 * The GitHub calls we make before any download.
 *
 * Section 8: treat every external response as untrusted and validate it with a
 * schema. These are also the calls that decide whether we can help at all, so
 * each failure maps to something specific we can say to the user rather than a
 * generic "something went wrong".
 */

const GITHUB_API = "https://api.github.com";

const repoSchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
  fork: z.boolean(),
  archived: z.boolean(),
  default_branch: z.string(),
  description: z.string().nullable(),
  /** Kilobytes, per GitHub. Indicative only — it counts history and binaries. */
  size: z.number(),
  pushed_at: z.string().nullable(),
});

export type RepoInfo = z.infer<typeof repoSchema>;

const treeSchema = z.object({
  sha: z.string(),
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      size: z.number().optional(),
    }),
  ),
});

export type RepoTreeEntry = { path: string; type: string; size?: number };

export type RepoTree = {
  /** The commit tree SHA we looked at. */
  sha: string;
  /** True when the repo has more entries than one tree response can hold. */
  truncated: boolean;
  files: RepoTreeEntry[];
};

export type GithubFailure =
  | "not_found"
  | "private"
  | "rate_limited"
  | "unavailable"
  | "empty_repo"
  | "malformed";

export type GithubResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GithubFailure; status?: number };

function headers(token: string | null): HeadersInit {
  const base: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub asks for a User-Agent and rejects requests without one.
    "User-Agent": "vestra-code",
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

/**
 * A 404 from GitHub means "not found OR you cannot see it" — it deliberately
 * does not distinguish, so a private repo and a typo look identical. We say
 * both possibilities rather than guessing, because guessing wrong reads as the
 * product being broken.
 */
function classify(status: number): GithubFailure {
  if (status === 404) return "not_found";
  if (status === 403 || status === 429) return "rate_limited";
  if (status === 451) return "unavailable";
  return "unavailable";
}

export async function fetchRepo(
  owner: string,
  repo: string,
  token: string | null,
): Promise<GithubResult<RepoInfo>> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers: headers(token),
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, error: classify(response.status), status: response.status };
  }

  const parsed = repoSchema.safeParse(await response.json());
  if (!parsed.success) return { ok: false, error: "malformed" };
  if (parsed.data.private) return { ok: false, error: "private" };

  return { ok: true, value: parsed.data };
}

/**
 * The whole file list in one request.
 *
 * This is deliberately done BEFORE downloading anything. The founder's own
 * portfolio is roughly 110 MB as an archive for about 200 KB of actual source,
 * so deciding what a repo is by downloading it first would mean a two-minute
 * wait before we can even say whether we can help.
 */
export async function fetchTree(
  owner: string,
  repo: string,
  ref: string,
  token: string | null,
): Promise<GithubResult<RepoTree>> {
  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { headers: headers(token), cache: "no-store" },
    );
  } catch {
    return { ok: false, error: "unavailable" };
  }

  if (response.status === 409) {
    // GitHub's answer for a repository with no commits yet.
    return { ok: false, error: "empty_repo" };
  }
  if (!response.ok) {
    return { ok: false, error: classify(response.status), status: response.status };
  }

  const parsed = treeSchema.safeParse(await response.json());
  if (!parsed.success) return { ok: false, error: "malformed" };

  return {
    ok: true,
    value: {
      sha: parsed.data.sha,
      truncated: parsed.data.truncated,
      files: parsed.data.tree.filter((entry) => entry.type === "blob"),
    },
  };
}

/** Plain language, says what happened and what to do next. */
export const GITHUB_MESSAGES: Record<GithubFailure, string> = {
  not_found:
    "그 주소로 저장소를 찾지 못했어요. 주소가 정확한지, 그리고 공개 저장소인지 확인해 주세요. 지금은 공개 저장소만 읽을 수 있어요.",
  private:
    "비공개 저장소예요. 지금은 공개 저장소만 읽을 수 있어요. 비공개 저장소 연결은 나중에 추가할 예정이에요.",
  rate_limited:
    "GitHub 요청 한도에 걸렸어요. 잠시 후 다시 시도해 주세요. GitHub 계정으로 로그인하시면 한도가 훨씬 넉넉해져요.",
  unavailable:
    "GitHub에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.",
  empty_repo: "저장소가 비어 있어요. 코드를 올린 뒤에 다시 연결해 주세요.",
  malformed:
    "GitHub에서 예상과 다른 응답이 왔어요. 잠시 후 다시 시도해 주세요.",
};

/**
 * One text file from the repo, without downloading the archive.
 *
 * Used for package.json during detection. Returns null rather than an error for
 * a missing file, because "there is no package.json" is itself a detection
 * signal, not a failure.
 */
export async function fetchTextFile(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  token: string | null,
): Promise<string | null> {
  try {
    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      {
        headers: { ...(headers(token) as Record<string, string>), Accept: "application/vnd.github.raw+json" },
        cache: "no-store",
      },
    );
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

const userRepoSchema = z.object({
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  fork: z.boolean(),
  archived: z.boolean(),
  description: z.string().nullable(),
  default_branch: z.string(),
  language: z.string().nullable(),
  pushed_at: z.string().nullable(),
  html_url: z.string(),
});

export type UserRepo = z.infer<typeof userRepoSchema>;

export type RepoList = {
  /** Public, non-archived repos, most recently pushed first. */
  repos: UserRepo[];
  /**
   * How many private repos we saw and are not offering. Shown as a count so the
   * user is not left wondering where their repo went — the MVP reads public
   * repositories only, and saying nothing would look like a bug.
   */
  privateCount: number;
  /** True when the account has more repos than one page holds. */
  more: boolean;
};

/**
 * The signed-in user's repositories, for the picker.
 *
 * One page of 100, newest push first. Someone with more than 100 repositories
 * will not find an old one by scrolling anyway, which is what the search box
 * and the paste-a-URL field are for.
 */
export async function listUserRepos(
  token: string,
): Promise<GithubResult<RepoList>> {
  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`,
      { headers: headers(token), cache: "no-store" },
    );
  } catch {
    return { ok: false, error: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, error: classify(response.status), status: response.status };
  }

  const parsed = z.array(userRepoSchema).safeParse(await response.json());
  if (!parsed.success) return { ok: false, error: "malformed" };

  const all = parsed.data;
  const repos = all
    .filter((repo) => !repo.private && !repo.archived)
    .sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""));

  return {
    ok: true,
    value: {
      repos,
      privateCount: all.filter((repo) => repo.private).length,
      more: all.length === 100,
    },
  };
}
