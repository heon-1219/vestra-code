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

// --- What changed between two commits --------------------------------------

/**
 * The commit a ref currently points at, or null.
 *
 * Best effort by design — a run without a recorded commit is a graph that
 * cannot be dated, which is worth strictly less than a run that did not
 * happen. It is also what makes the next run incremental: the recorded commit
 * is the base the compare below is taken against, so a null here costs the
 * *following* run its saving, not this one its result.
 */
export async function fetchCommitSha(
  owner: string,
  repo: string,
  ref: string,
  token: string | null,
): Promise<string | null> {
  try {
    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      { headers: headers(token), cache: "no-store" },
    );
    if (!response.ok) return null;

    const parsed = z.object({ sha: z.string() }).safeParse(await response.json());
    return parsed.success ? parsed.data.sha : null;
  } catch {
    return null;
  }
}

/**
 * How a path changed between two commits, in the four cases that matter to us.
 *
 * A rename is kept as its own case rather than folded into "modified" because
 * the path is inside a node's id hash (`analysis/ids.ts`). Treating it as an
 * update would leave the old path's rows in the graph *and* create the new
 * path's rows, so the user would see the same file twice and any correction
 * they had made would still be attached to the copy that no longer exists.
 */
export type ChangeStatus = "added" | "modified" | "removed" | "renamed";

export type ChangedFile = {
  /** Repo-relative POSIX path. For a removal, the path the file used to have. */
  path: string;
  /** The path this file had before, for a rename. Null otherwise. */
  previousPath: string | null;
  status: ChangeStatus;
};

/**
 * Why a comparison cannot be trusted as a complete description of the change.
 *
 * Both of these mean the same thing to a caller — do a full run — but they are
 * distinguished so the log says which one happened. "We only got 300 of the
 * changed files" and "GitHub used a word we do not know" are different
 * problems, and a log line that cannot tell them apart is a log line nobody
 * can act on.
 */
export type ComparisonGap = "file_cap" | "unknown_status";

export type RepoComparison = {
  /**
   * `ahead` means head is a descendant of base and nothing else happened.
   *
   * This is the only value that makes an incremental run safe, and the reason
   * is not obvious: GitHub's compare endpoint is three-dot, so for a
   * `diverged` pair it lists the diff from the **merge base** to head — which
   * silently omits everything that happened on base's side. The recorded graph
   * was measured at base, so those omissions are exactly the rows that would
   * be left stale. `behind` and `diverged` are the force-push and
   * branch-rewrite cases, and they get a full run.
   */
  status: "identical" | "ahead" | "behind" | "diverged";
  files: ChangedFile[];
  /** Non-null when `files` is not a complete, fully understood change list. */
  gap: ComparisonGap | null;
};

/**
 * GitHub returns at most 300 entries in `files`, and says nothing about the
 * ones it left out — there is no total to compare against. So a full page is
 * treated as "there may be more", which costs a needless full run on a commit
 * range that touched exactly 300 files and prevents a silently partial one on
 * every range that touched more.
 */
const COMPARE_FILE_CAP = 300;

const compareSchema = z.object({
  status: z.string(),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        previous_filename: z.string().optional(),
      }),
    )
    // Absent, not empty, when the range changed no files at all.
    .optional(),
});

/**
 * Map GitHub's `status` onto ours, or null when we do not recognise it.
 *
 * `copied` becomes `added` because a copy is a path that did not exist before,
 * which is all our ids care about. `changed` is GitHub's word for a mode or
 * type change with the same content, and `unchanged` appears when a file was
 * edited and edited back inside the range — both are re-parsed rather than
 * reasoned about, because re-parsing one file is free and being wrong about it
 * is not.
 */
function mapStatus(status: string): ChangeStatus | null {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    case "modified":
    case "changed":
    case "unchanged":
      return "modified";
    default:
      return null;
  }
}

/**
 * Which files differ between two commits.
 *
 * This is the whole factual basis for incremental re-analysis, so every way it
 * can be less than the truth is turned into something the caller can see: a
 * base commit GitHub no longer has comes back as `not_found` (a force-push
 * deleted it), a rewritten history comes back in `status`, and a list that may
 * be missing entries comes back in `gap`. None of them are recoverable here,
 * and all of them mean the same thing one level up — analyse everything.
 */
export async function compareCommits(
  owner: string,
  repo: string,
  base: string,
  head: string,
  token: string | null,
): Promise<GithubResult<RepoComparison>> {
  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      { headers: headers(token), cache: "no-store" },
    );
  } catch {
    return { ok: false, error: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, error: classify(response.status), status: response.status };
  }

  const parsed = compareSchema.safeParse(await response.json());
  if (!parsed.success) return { ok: false, error: "malformed" };

  const status = parsed.data.status;
  if (
    status !== "identical" &&
    status !== "ahead" &&
    status !== "behind" &&
    status !== "diverged"
  ) {
    return { ok: false, error: "malformed" };
  }

  const entries = parsed.data.files ?? [];
  const files: ChangedFile[] = [];
  let gap: ComparisonGap | null =
    entries.length >= COMPARE_FILE_CAP ? "file_cap" : null;

  for (const entry of entries) {
    const mapped = mapStatus(entry.status);
    if (mapped === null) {
      // One word we do not understand makes the whole list untrustworthy: we
      // cannot tell whether that file needs adding, re-parsing or deleting,
      // and guessing wrong leaves a stale row nobody will ever notice.
      gap = gap ?? "unknown_status";
      continue;
    }
    files.push({
      path: entry.filename,
      previousPath:
        mapped === "renamed" ? (entry.previous_filename ?? null) : null,
      status: mapped,
    });
  }

  // A rename with no previous name is a rename we cannot undo, so it is the
  // same problem as an unknown status: the old path's rows would survive.
  if (files.some((file) => file.status === "renamed" && file.previousPath === null)) {
    gap = gap ?? "unknown_status";
  }

  return { ok: true, value: { status, files, gap } };
}
