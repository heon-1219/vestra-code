import { z } from "zod";

import { normalizePath } from "@/analysis/ids";
import type { FileStatus } from "@/components/workspace/history/changes";

import type { GithubFailure, GithubResult } from "./api";

/**
 * The repository's own history: what the person did to their project.
 *
 * `api.ts` next door answers "can we read this repo at all" — it is the call
 * made before a download. This file answers a different question, asked after
 * the map exists: *what changed, and when*. Same rules, deliberately:
 * section 8's, every response validated with a schema before a single field is
 * read, and every failure mapped onto one of `GithubFailure`'s names so the
 * caller has a sentence to say rather than a status code to print.
 *
 * ## Why `headers` and `classify` are written again here
 *
 * They are private to `api.ts` and that file is being edited by somebody else
 * right now. Copying twelve lines is the cheaper mistake: exporting them would
 * mean two agents editing one file, and importing a half-edited one would mean
 * this file failing for a reason that has nothing to do with it. They are small
 * enough that a drift between the two is visible in a diff, and the *shape*
 * that matters — Accept, the API version, a User-Agent, Bearer when we have a
 * token — is identical on purpose.
 *
 * ## What is capped, and why that is not a lie
 *
 * A commit message has no length limit and neither does a file list. One
 * repository with a generated changelog in a commit body would be megabytes on
 * a strip four percent of a screen tall. So the message is cut to a stated
 * number of characters with an ellipsis, which is a *shortening* the reader can
 * see; and GitHub's own 300-file ceiling on a commit's file list is reported
 * rather than absorbed, because "파일 300개" and "파일 300개까지 셀 수 있었어요"
 * are two different claims and only the second one is true.
 */

const GITHUB_API = "https://api.github.com";

/** Long enough to read the shape of a branch, short enough to draw. */
export const COMMIT_PAGE = 50;

/** GitHub's own ceiling on `per_page`. Asking for more is silently clamped. */
const MAX_PER_PAGE = 100;

/** A commit message's first line, cut here rather than by the layout. */
const TITLE_CHARS = 200;
/** The rest of the message, for the one commit somebody actually opened. */
const BODY_CHARS = 2000;

/**
 * How many files GitHub will list for one commit.
 *
 * Not ours — theirs, and undocumented in the response itself: a commit that
 * touched more files comes back with exactly this many and nothing saying so.
 * Seeing the ceiling is the only way to know we are standing on it, which is
 * why the number is here and not merely known.
 */
const GITHUB_FILE_CEILING = 300;

function headers(token: string | null): HeadersInit {
  const base: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vestra-code",
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

/** Same mapping `api.ts` makes, for the same reason: a 404 hides two cases. */
function classify(status: number): GithubFailure {
  if (status === 404) return "not_found";
  if (status === 403 || status === 429) return "rate_limited";
  if (status === 451) return "unavailable";
  return "unavailable";
}

const authorSchema = z
  .object({
    name: z.string().nullish(),
    date: z.string().nullish(),
  })
  .nullish();

const rawCommitSchema = z.object({
  sha: z.string().min(1),
  /** Two of these is a merge. Zero is the repository's first commit. */
  parents: z.array(z.object({ sha: z.string().min(1) })),
  commit: z.object({
    message: z.string(),
    author: authorSchema,
    committer: authorSchema,
  }),
});

/** GitHub's words. Anything else is mapped in `toStatus` rather than trusted. */
const rawFileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  previous_filename: z.string().nullish(),
});

const rawDetailSchema = rawCommitSchema.extend({
  /**
   * Optional on purpose. GitHub omits the list entirely for some very large
   * commits, and an `optional().default([])` would turn "we were not told" into
   * "nothing changed" — the exact class of silent falsehood section 2 forbids.
   */
  files: z.array(rawFileSchema).optional(),
});

/** One change, as the band draws it. */
export type ChangeCommit = {
  sha: string;
  /** Full SHAs. Order matters: the first parent is the line this continued. */
  parents: string[];
  /** The message's first line — the person's own words, never ours. */
  title: string;
  /** Whatever else the message said, or null. */
  body: string | null;
  authorName: string | null;
  /** ISO. When the change was made, not when it was pushed. */
  at: string;
};

export type CommitPage = {
  commits: ChangeCommit[];
  /** True when the branch has history older than what came back. */
  truncated: boolean;
};

/*
 * The four words GitHub's dozen are reduced to are defined on the wire, in
 * `changes.ts`, and imported here as a type only — so the reduction happens
 * once and the enum the browser validates against is the same one this file
 * produces. A type-only import erases, so nothing from the component folder
 * reaches this module at runtime.
 */

export type ChangedFile = {
  /** Repo-relative, POSIX separators — the one spelling the map holds (D18). */
  path: string;
  status: FileStatus;
  /** Where a renamed file used to live, normalised the same way. */
  previousPath: string | null;
};

export type CommitDetail = {
  commit: ChangeCommit;
  files: ChangedFile[];
  /** True when we hit GitHub's 300-file ceiling, so this list is a prefix. */
  fileListTruncated: boolean;
  /** True when GitHub sent no file list at all. Not the same as "no files". */
  fileListMissing: boolean;
};

/**
 * The branch's commits, newest first.
 *
 * `ref` is the branch to walk. Null asks for the repository's default branch,
 * which is what GitHub does when `sha` is absent — and which is right for a
 * project we recorded before we stored a default branch.
 */
export async function fetchCommits(
  owner: string,
  repo: string,
  ref: string | null,
  token: string | null,
  limit: number = COMMIT_PAGE,
): Promise<GithubResult<CommitPage>> {
  // One more than we will keep, purely to learn whether there are older ones —
  // the same trick the runs route uses, and exact rather than a second call.
  const perPage = Math.min(limit + 1, MAX_PER_PAGE);
  const query = new URLSearchParams({ per_page: String(perPage) });
  if (ref) query.set("sha", ref);

  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/commits?${query.toString()}`,
      { headers: headers(token), cache: "no-store" },
    );
  } catch {
    return { ok: false, error: "unavailable" };
  }

  // GitHub's answer for a repository with no commits yet, exactly as the tree
  // endpoint answers it. There is no history to draw and that is not an error.
  if (response.status === 409) return { ok: false, error: "empty_repo" };
  if (!response.ok) {
    return { ok: false, error: classify(response.status), status: response.status };
  }

  const parsed = z.array(rawCommitSchema).safeParse(await response.json());
  if (!parsed.success) return { ok: false, error: "malformed" };

  return {
    ok: true,
    value: {
      commits: parsed.data.slice(0, limit).map(toChange),
      truncated: parsed.data.length > limit,
    },
  };
}

/** One commit, with what it touched. */
export async function fetchCommitDetail(
  owner: string,
  repo: string,
  sha: string,
  token: string | null,
): Promise<GithubResult<CommitDetail>> {
  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`,
      { headers: headers(token), cache: "no-store" },
    );
  } catch {
    return { ok: false, error: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, error: classify(response.status), status: response.status };
  }

  const parsed = rawDetailSchema.safeParse(await response.json());
  if (!parsed.success) return { ok: false, error: "malformed" };

  const raw = parsed.data.files;
  return {
    ok: true,
    value: {
      commit: toChange(parsed.data),
      files: raw ? toChangedFiles(raw) : [],
      fileListTruncated: (raw?.length ?? 0) >= GITHUB_FILE_CEILING,
      fileListMissing: raw === undefined,
    },
  };
}

/**
 * Every path a commit touched, in the one form the map's ids were hashed from.
 *
 * **Pure, and the reason it is pure is that it is the join.** A changed file
 * becomes a lit place on the map by its path and by nothing else, so a single
 * character of disagreement between GitHub's spelling and ours — a leading
 * `./`, a doubled slash, a backslash from a Windows-authored commit — is a
 * change that silently lights nothing while looking like it worked. Everything
 * goes through `normalizePath`, which is the same function the ids were hashed
 * through (D18), rather than through a comparison written by hand here.
 *
 * A rename contributes **both** paths. The map may predate the commit, in which
 * case the file is standing at its old path and the new one matches nothing;
 * or it may postdate it, and the reverse. Both are the same file moving, and
 * lighting it either way is the honest answer.
 */
export function changedPaths(files: readonly ChangedFile[]): string[] {
  const seen = new Set<string>();
  for (const file of files) {
    for (const candidate of [file.path, file.previousPath]) {
      if (candidate === null) continue;
      const path = normalizePath(candidate);
      if (path === "") continue;
      seen.add(path);
    }
  }
  return [...seen];
}

/**
 * GitHub's status word, as one of the four this product says out loud.
 *
 * `unchanged` is dropped by the caller rather than mapped: a file listed as
 * unchanged did not change, and calling it 고친 파일 would be a false sentence
 * about somebody's own commit. Every other unknown word maps to `modified`,
 * which is the one claim true of anything GitHub bothered to list at all — it
 * is in the commit's file list, so it is part of the change, and only the
 * *kind* of change is in doubt.
 */
function toStatus(status: string): FileStatus | null {
  switch (status) {
    case "added":
    // A copy did not exist at this path before this commit, which is what
    // 새로 생겼어요 says. Where it was copied from is not on the map.
    case "copied":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    case "unchanged":
      return null;
    default:
      return "modified";
  }
}

function toChangedFiles(raw: readonly z.infer<typeof rawFileSchema>[]): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const entry of raw) {
    const status = toStatus(entry.status);
    if (status === null) continue;
    const path = normalizePath(entry.filename);
    if (path === "") continue;
    const previous = entry.previous_filename
      ? normalizePath(entry.previous_filename)
      : "";
    files.push({
      path,
      status,
      previousPath: previous === "" || previous === path ? null : previous,
    });
  }
  return files;
}

function toChange(raw: z.infer<typeof rawCommitSchema>): ChangeCommit {
  const { title, body } = splitMessage(raw.commit.message);
  return {
    sha: raw.sha,
    parents: raw.parents.map((parent) => parent.sha),
    title,
    body,
    authorName: raw.commit.author?.name?.trim() || null,
    /*
     * The author date, falling back to the committer's.
     *
     * They differ after a rebase or a cherry-pick, and the author date is the
     * one that answers the band's question: it is when the person made the
     * change, which is the moment they remember. An empty string rather than
     * an invented one when neither is present — `parseWhen` already refuses to
     * print anything for a time it cannot read.
     */
    at: raw.commit.author?.date ?? raw.commit.committer?.date ?? "",
  };
}

/**
 * A commit message as a title and the rest.
 *
 * Git's own convention — first line, blank line, body — and exported so the
 * split is pinned by a test rather than by whoever reads a list next. Both
 * halves are cut to a stated length with an ellipsis, which a reader can see;
 * neither is rewritten, because these are the user's own words about their own
 * project and we have no better ones.
 */
export function splitMessage(message: string): {
  title: string;
  body: string | null;
} {
  const newline = message.indexOf("\n");
  const first = (newline === -1 ? message : message.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : message.slice(newline + 1).trim();
  return {
    // A commit with an empty message is legal. Saying so beats an empty row
    // that reads as something that failed to load.
    title: cut(first, TITLE_CHARS) || "(메시지가 없어요)",
    body: rest === "" ? null : cut(rest, BODY_CHARS),
  };
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
