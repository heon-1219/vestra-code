import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import type {
  ChangeRecord,
  ChangesResponse,
} from "@/components/workspace/history/changes";
import { db } from "@/db";
import { analysisRuns, projects } from "@/db/schema";
import { GITHUB_MESSAGES, type GithubFailure } from "@/lib/github/api";
import { fetchCommits } from "@/lib/github/commits";
import { getGithubToken } from "@/lib/github/token";
import { getSession } from "@/lib/session";

/**
 * The repository's own history — what the person did to their project.
 *
 * The runs endpoint next door answers "when did we read this, and what changed
 * on the map each time". This one answers the question underneath that: what
 * did *they* change, and when. Both feed one band, and the join between them is
 * `analysis_runs.commit_sha` — a change we have drawn a map for is marked as
 * such rather than being listed twice.
 *
 * Nothing is stored here. The history lives in GitHub and is read on demand,
 * the same way a file preview is (section 3): we hold the map, not the
 * repository. That also means this endpoint can fail in ways the runs endpoint
 * cannot, and every one of those failures arrives as a plain Korean sentence
 * from `GITHUB_MESSAGES` rather than as a status code for the browser to guess
 * at.
 */

export const runtime = "nodejs";
// One person's project, and a live read of somebody else's service. Nothing
// here may be held anywhere shared.
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

const UNAUTHENTICATED = "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.";

/**
 * The same answer for "no such project" and "somebody else's project", copied
 * from the runs endpoint deliberately. A 403 would confirm the id exists,
 * which tells a stranger something true about another user's account.
 */
const NOT_FOUND = "이 프로젝트를 찾지 못했어요. 목록에서 다시 열어 주세요.";

/**
 * How many runs we look at for the join.
 *
 * Generous rather than matched to the band's own window: this is a lookup of
 * "did we ever draw a map of this change", and a project read a hundred times
 * should still have its early changes marked. Completed runs only — a failed
 * run drew nothing (D20), and marking its commit 지도를 그렸어요 would be a
 * false badge on somebody's own history.
 */
const RUN_LOOKUP = 300;

/** Which HTTP status each GitHub failure deserves. */
const STATUS: Record<GithubFailure, number> = {
  not_found: 404,
  private: 404,
  rate_limited: 429,
  unavailable: 502,
  empty_repo: 200,
  malformed: 502,
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
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
      defaultBranch: projects.defaultBranch,
    })
    .from(projects)
    .where(
      and(eq(projects.id, params.data.id), eq(projects.userId, session.user.id)),
    )
    .limit(1);

  if (!project) {
    return Response.json({ message: NOT_FOUND }, { status: 404 });
  }

  // An uploaded folder was never a repository. Answered as a normal 200 with a
  // reason, not as an error: there is nothing wrong, there is simply no history
  // of this kind, and the band has a sentence for it.
  if (project.source === "upload") return none("upload");
  if (!project.repoOwner || !project.repoName) return none("unknown_repo");

  // Read while the request's cookies are still in scope. Null is normal — a
  // user who signed in with Google has no GitHub token, and a public
  // repository's history is readable without one.
  const token = await getGithubToken(request.headers);

  const result = await fetchCommits(
    project.repoOwner,
    project.repoName,
    project.defaultBranch,
    token,
  );

  if (!result.ok) {
    // A repository with no commits is not a failure either, and GitHub's own
    // 409 is how we learn it. Same shape as an upload: a reason, not an error.
    if (result.error === "empty_repo") return none("empty");
    return Response.json(
      { message: GITHUB_MESSAGES[result.error] },
      { status: STATUS[result.error] },
    );
  }

  /*
   * Which of these changes we have drawn a map for.
   *
   * `commit_sha` is a full 40-character commit SHA — `pipeline.ts` resolves the
   * branch to one *before* downloading, so the tree analysed and the commit
   * recorded are the same thing by construction — so this is a plain equality
   * and never a prefix test. Newest run wins where a change was read twice.
   */
  const runs = await db
    .select({ id: analysisRuns.id, commitSha: analysisRuns.commitSha })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.projectId, project.id),
        eq(analysisRuns.status, "completed"),
        isNotNull(analysisRuns.commitSha),
      ),
    )
    .orderBy(desc(analysisRuns.startedAt))
    .limit(RUN_LOOKUP);

  const drawn = new Map<string, string>();
  for (const run of runs) {
    if (run.commitSha && !drawn.has(run.commitSha)) drawn.set(run.commitSha, run.id);
  }

  const body: ChangesResponse = {
    none: null,
    changes: result.value.commits.map(
      (commit): ChangeRecord => ({
        sha: commit.sha,
        parents: commit.parents,
        title: commit.title,
        authorName: commit.authorName,
        at: commit.at,
        drawnRunId: drawn.get(commit.sha) ?? null,
      }),
    ),
    truncated: result.value.truncated,
  };

  return Response.json(body, { headers: NO_STORE });
}

/** There is no history of this kind, and which kind of nothing it is. */
function none(reason: NonNullable<ChangesResponse["none"]>) {
  const body: ChangesResponse = { none: reason, changes: [], truncated: false };
  return Response.json(body, { headers: NO_STORE });
}

const NO_STORE = {
  // Someone else's repository, read on their behalf with their token. It must
  // not sit in any cache between them and GitHub.
  "Cache-Control": "private, no-store",
} as const;
