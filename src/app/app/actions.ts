"use server";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { headers as nextHeaders } from "next/headers";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { projects } from "@/db/schema";
import {
  fetchRepo,
  fetchTextFile,
  fetchTree,
  GITHUB_MESSAGES,
  listUserRepos,
} from "@/lib/github/api";
import {
  detectProject,
  manifestsToFetch,
  type PackageManifest,
} from "@/lib/github/detect";
import { parseRepoUrl, REPO_URL_MESSAGES } from "@/lib/github/repo-url";
import { getGithubToken } from "@/lib/github/token";
import { requireSession } from "@/lib/session";

export type AddProjectState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "ok";
      projectId: string;
      displayName: string;
      summary: string;
      deep: boolean;
      fileCount: number;
      /** True when we already had this repo and reopened it instead of duplicating. */
      existing: boolean;
    };

export async function addProject(
  _previous: AddProjectState,
  formData: FormData,
): Promise<AddProjectState> {
  const session = await requireSession();

  const parsed = parseRepoUrl(String(formData.get("url") ?? ""));
  if (!parsed.ok) {
    return { status: "error", message: REPO_URL_MESSAGES[parsed.error] };
  }
  const { owner, repo, url } = parsed.value;

  // Re-adding a repo reopens the existing project rather than building a second
  // graph of the same thing, which would split the user's corrections across
  // two projects with no way to tell them apart.
  const existing = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.userId, session.user.id),
        eq(projects.repoOwner, owner),
        eq(projects.repoName, repo),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const project = existing[0];
    return {
      status: "ok",
      projectId: project.id,
      displayName: project.displayName,
      summary: "이미 연결해 둔 저장소예요.",
      deep: project.kind !== "unsupported",
      fileCount: 0,
      existing: true,
    };
  }

  const token = await getGithubToken(await nextHeaders());

  const info = await fetchRepo(owner, repo, token);
  if (!info.ok) {
    return { status: "error", message: GITHUB_MESSAGES[info.error] };
  }

  const tree = await fetchTree(owner, repo, info.value.default_branch, token);
  if (!tree.ok) {
    return { status: "error", message: GITHUB_MESSAGES[tree.error] };
  }

  const paths = tree.value.files.map((file) => file.path);

  // Manifests are fetched on their own rather than from the archive: detection
  // runs before any download, so we can tell the user what we will be able to
  // show them in about a second instead of after a large wait.
  //
  // Several, not just the root one — a repo with frontend/ and backend/ keeps
  // the interesting package.json a level down, and reading only the root is
  // what made a SolidJS app look like a hand-written HTML site.
  const manifests: PackageManifest[] = [];
  for (const path of manifestsToFetch(paths)) {
    const raw = await fetchTextFile(
      owner,
      repo,
      info.value.default_branch,
      path,
      token,
    );
    if (!raw) continue;
    try {
      manifests.push({ path, json: JSON.parse(raw) });
    } catch {
      // A broken manifest is a detection signal, not a crash: its presence
      // still tells us this is a bundled project rather than a static site.
      manifests.push({ path, json: null });
    }
  }

  const detection = detectProject(paths, manifests);

  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    userId: session.user.id,
    repoOwner: owner,
    repoName: repo,
    repoUrl: url,
    defaultBranch: info.value.default_branch,
    displayName: repo,
    kind: detection.kind,
  });

  revalidatePath("/app");

  return {
    status: "ok",
    projectId,
    displayName: repo,
    summary: detection.summary,
    deep: detection.deep,
    fileCount: paths.length,
    existing: false,
  };
}

export type MyReposState =
  | { status: "no_github" }
  | { status: "error"; message: string }
  | {
      status: "ok";
      repos: {
        owner: string;
        name: string;
        fullName: string;
        description: string | null;
        language: string | null;
        pushedAt: string | null;
        /** Already connected, so the picker can say so instead of duplicating. */
        connected: boolean;
      }[];
      privateCount: number;
      more: boolean;
    };

/**
 * The signed-in user's repositories, for the picker.
 *
 * Returns `no_github` rather than an error when the account has no GitHub
 * token — someone who signed in with Google has done nothing wrong, and the UI
 * offers them the paste-a-URL path instead.
 */
export async function listMyRepos(): Promise<MyReposState> {
  const session = await requireSession();
  const token = await getGithubToken(await nextHeaders());
  if (!token) return { status: "no_github" };

  const result = await listUserRepos(token);
  if (!result.ok) {
    return { status: "error", message: GITHUB_MESSAGES[result.error] };
  }

  const mine = await db
    .select({ owner: projects.repoOwner, name: projects.repoName })
    .from(projects)
    .where(eq(projects.userId, session.user.id));
  const already = new Set(mine.map((row) => `${row.owner}/${row.name}`));

  return {
    status: "ok",
    repos: result.value.repos.map((repo) => ({
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description,
      language: repo.language,
      pushedAt: repo.pushed_at,
      connected: already.has(repo.full_name),
    })),
    privateCount: result.value.privateCount,
    more: result.value.more,
  };
}
