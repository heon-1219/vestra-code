import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import type { ChangeDetail } from "@/components/workspace/history/changes";
import { db } from "@/db";
import { nodes, projects } from "@/db/schema";
import { GITHUB_MESSAGES, type GithubFailure } from "@/lib/github/api";
import { changedPaths, fetchCommitDetail } from "@/lib/github/commits";
import { getGithubToken } from "@/lib/github/token";
import { getSession } from "@/lib/session";

/**
 * One change, and which places on the map it touched.
 *
 * This is the endpoint behind clicking a row in the 변경 기록 band. It answers
 * in two halves, and they are deliberately different kinds of answer:
 *
 *   - **What changed**, as the files GitHub says the commit touched. Not a
 *     diff. The reader of this product cannot read code, and a diff is the one
 *     format that assumes they can.
 *   - **Where that lands on the map**, as item ids the browser can light.
 *
 * The second half is the one that can be quietly wrong, so it is done here and
 * not in the browser. A changed file becomes a lit place by its path, and the
 * path the map holds went through `normalizePath` on its way to being hashed
 * into an id (D18) — so GitHub's spelling goes through the same function
 * before it is compared, rather than through a comparison written by hand. The
 * comparison itself is `nodes.file_path` equality against rows we wrote
 * ourselves, on the index that exists for it, which means a path the map does
 * not hold cannot light anything whatever it looks like.
 *
 * Everything under a changed file lights, not just the file: the pieces cut
 * out of it are in it, and they are what the person is being shown when they
 * ask what a change touched.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  id: z.uuid(),
  /**
   * Hex, seven to forty. Narrow because this string is pasted into a URL we
   * send to GitHub: anything that is not a SHA has no business being asked
   * about, and a shape check here is cheaper than trusting an encoder.
   */
  sha: z.string().regex(/^[0-9a-f]{7,40}$/i),
});

const UNAUTHENTICATED = "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.";
const NOT_FOUND = "이 프로젝트를 찾지 못했어요. 목록에서 다시 열어 주세요.";
const NO_HISTORY =
  "이 프로젝트는 GitHub 저장소가 아니라서, 바뀐 내용을 가져올 수 없어요.";

/**
 * A ceiling on how many places one change may light.
 *
 * Not a product rule — a map has at most a few thousand items, so this is
 * never reached by a real project. It is here so that a pathological repo
 * cannot make one click return a response measured in megabytes.
 */
const MAX_LIT = 5000;

const STATUS: Record<GithubFailure, number> = {
  not_found: 404,
  private: 404,
  rate_limited: 429,
  unavailable: 502,
  empty_repo: 404,
  malformed: 502,
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; sha: string }> },
) {
  const session = await getSession();
  if (!session) {
    return Response.json({ message: UNAUTHENTICATED }, { status: 401 });
  }

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return Response.json({ message: NOT_FOUND }, { status: 404 });
  }

  const [project] = await db
    .select({
      id: projects.id,
      source: projects.source,
      repoOwner: projects.repoOwner,
      repoName: projects.repoName,
    })
    .from(projects)
    .where(
      and(eq(projects.id, params.data.id), eq(projects.userId, session.user.id)),
    )
    .limit(1);

  // The same answer for "no such project" and "somebody else's".
  if (!project) {
    return Response.json({ message: NOT_FOUND }, { status: 404 });
  }

  if (project.source === "upload" || !project.repoOwner || !project.repoName) {
    // The list endpoint already said this project has no history; reaching
    // here means a stale band or a hand-made request, and it gets the same
    // honest sentence rather than a shrug.
    return Response.json({ message: NO_HISTORY }, { status: 404 });
  }

  const token = await getGithubToken(request.headers);
  const result = await fetchCommitDetail(
    project.repoOwner,
    project.repoName,
    params.data.sha,
    token,
  );

  if (!result.ok) {
    return Response.json(
      { message: GITHUB_MESSAGES[result.error] },
      { status: STATUS[result.error] },
    );
  }

  const { commit, files, fileListTruncated, fileListMissing } = result.value;
  const paths = changedPaths(files);

  /*
   * Which of those paths the map actually holds, and everything standing on
   * them.
   *
   * One query rather than one per file, and `inArray` guarded because an empty
   * list is a real case — a merge commit that changed nothing, or a commit
   * whose file list GitHub withheld — and `IN ()` is a syntax error rather
   * than an empty result.
   */
  const rows =
    paths.length === 0
      ? []
      : await db
          .select({ id: nodes.id, filePath: nodes.filePath })
          .from(nodes)
          .where(
            and(
              eq(nodes.projectId, project.id),
              isNotNull(nodes.filePath),
              inArray(nodes.filePath, paths),
            ),
          )
          .limit(MAX_LIT);

  const itemIds: string[] = [];
  const onMap = new Set<string>();
  for (const row of rows) {
    itemIds.push(row.id);
    if (row.filePath) onMap.add(row.filePath);
  }

  const body: ChangeDetail = {
    sha: commit.sha,
    title: commit.title,
    body: commit.body,
    authorName: commit.authorName,
    at: commit.at,
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      // A renamed file counts as on the map under either of its names: the map
      // may predate the rename or postdate it, and it is the same file either
      // way. This mirrors what `changedPaths` sent to the query.
      onMap:
        onMap.has(file.path) ||
        (file.previousPath !== null && onMap.has(file.previousPath)),
    })),
    fileListTruncated,
    fileListMissing,
    itemIds,
  };

  return Response.json(body, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
