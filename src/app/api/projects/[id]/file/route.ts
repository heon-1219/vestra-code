import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  isSafeRepoPath,
  previewShapeFor,
  tooLargeMessage,
  type PreviewRefusal,
} from "@/components/workspace/preview/preview-kinds";
import { db } from "@/db";
import { analysisRuns, nodes, projects } from "@/db/schema";
import { fetchRawFile, RAW_MESSAGES } from "@/lib/github/raw";
import { getGithubToken } from "@/lib/github/token";
import { getSession } from "@/lib/session";

/**
 * One file of one project, fetched now and kept by nobody.
 *
 * This is the endpoint section 3's promise was written around. We store the
 * map — paths, line ranges, file hashes — and not the source. A preview is the
 * on-demand fetch that makes that promise liveable instead of merely strict, so
 * it is allowed; and the whole design here is what keeps it true:
 *
 *   - The bytes are **streamed through**. They are never written to our
 *     database, never written to our disk, and never collected into a string in
 *     this process on their way past.
 *   - The answer is `no-store`. Not `private, max-age=…`, not a CDN hint, not a
 *     revalidation token: one person's source code must not sit in any cache
 *     between them and GitHub, including their own disk cache. The cost is that
 *     an image is fetched again every time it is opened, and that cost is the
 *     promise being kept rather than described.
 *
 * Three refusals matter as much as the success path.
 *
 *   1. **Somebody else's project is a 404, never a 403.** A 403 would confirm
 *      the id exists, which tells a stranger something true about another
 *      person's account. Same sentence for a malformed id, a missing project
 *      and one that is not theirs.
 *   2. **The path is looked up among this project's own files.** The query
 *      string is a request, not an authority. Serving whatever path was asked
 *      for would turn this into "read any file in that repository" — harmless
 *      for a public repo and a real leak for one that is private but reachable
 *      with the signed-in user's token.
 *   3. **An uploaded folder cannot be previewed at all** (D66). There is no
 *      origin to fetch from and we kept no copy. It says so plainly; it does
 *      not fail obscurely.
 */

export const runtime = "nodejs";
// One person's file, resolved per request. There is nothing here to prerender
// and nothing here that two people could share.
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

const querySchema = z.object({
  /** Repo-relative, POSIX separators, exactly as the map holds it (D18). */
  path: z.string().min(1).max(1024).refine(isSafeRepoPath, "unusable path"),
  /**
   * The line range the viewer wants to land on. Not used to fetch anything —
   * GitHub has no by-line endpoint and slicing here would mean reading the
   * body — but validated so a nonsense value cannot reach the anchor we echo.
   */
  line: z.coerce.number().int().min(1).max(10_000_000).optional(),
});

const UNAUTHENTICATED = "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.";
const NOT_FOUND = "이 파일을 찾지 못했어요. 지도에서 다시 열어 주세요.";
const UPLOAD =
  "이 프로젝트는 내 컴퓨터에서 올려주신 폴더로 만들었어요. 코드를 보관하지 않아서 파일 내용을 다시 보여드릴 수 없어요. 올리셨던 폴더에서 바로 열어보실 수 있어요.";
const UNSUPPORTED =
  "이 파일은 아직 열어볼 수 없어요. 보여드릴 방법을 아직 준비하지 못했어요. GitHub에서 열어보실 수 있어요.";

/** Every refusal has the same shape, so the viewer has one thing to read. */
function refuse(reason: PreviewRefusal, message: string, status: number) {
  return Response.json({ reason, message }, { status, headers: NO_STORE });
}

const NO_STORE = {
  // `no-store` on its own is the whole instruction: no shared cache, no private
  // cache, no disk. The rest are there for the proxies that predate it.
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, private",
  Pragma: "no-cache",
} as const;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    // 401 with a body rather than a redirect: this is called with fetch and by
    // an <img>, and a redirect to the sign-in page would arrive as HTML where
    // JSON or bytes were expected.
    return refuse("unauthenticated", UNAUTHENTICATED, 401);
  }

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return refuse("not_found", NOT_FOUND, 404);

  const query = querySchema.safeParse({
    path: request.nextUrl.searchParams.get("path") ?? "",
    line: request.nextUrl.searchParams.get("line") ?? undefined,
  });
  if (!query.success) return refuse("not_found", NOT_FOUND, 404);

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

  // The same answer for "no such project" and "somebody else's project".
  if (!project) return refuse("not_found", NOT_FOUND, 404);

  if (project.source === "upload") {
    // D66, second instance: the trust promise costs the user something visible,
    // and saying so is better than a preview that mysteriously never loads.
    return refuse("upload", UPLOAD, 409);
  }

  if (!project.repoOwner || !project.repoName) {
    return refuse("not_found", NOT_FOUND, 404);
  }

  /*
   * The authority for what this project contains.
   *
   * Not `LIKE`, not a prefix test, not a normalisation and a comparison —
   * equality against a row we wrote ourselves during ingest. A path the map
   * does not hold cannot be fetched, whatever it looks like, and that single
   * fact is what stops this endpoint from being a reader for the whole
   * repository.
   */
  const [file] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.projectId, project.id),
        eq(nodes.type, "file"),
        eq(nodes.filePath, query.data.path),
      ),
    )
    .limit(1);

  if (!file) return refuse("not_found", NOT_FOUND, 404);

  const shape = previewShapeFor(query.data.path);
  if (shape.contentType === null) {
    // A spreadsheet or something we have no viewer for. Refused before a single
    // byte moves: fetching 4 MB and then drawing nothing helps nobody.
    return refuse("unsupported", UNSUPPORTED, 415);
  }

  /*
   * Which commit to read.
   *
   * The last completed run's, when there is one. The line ranges on the map
   * were measured against that tree, so reading the branch tip instead would
   * scroll someone to line 120 of a file whose line 120 has since moved —
   * quietly wrong in exactly the way this product cannot afford. The branch is
   * the fallback for a project analysed before we recorded a commit.
   */
  const [run] = await db
    .select({ commitSha: analysisRuns.commitSha })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.projectId, project.id),
        eq(analysisRuns.status, "completed"),
        isNotNull(analysisRuns.commitSha),
      ),
    )
    .orderBy(desc(analysisRuns.startedAt))
    .limit(1);

  const ref = run?.commitSha ?? project.defaultBranch ?? "HEAD";

  // Read while the request's cookies are still in scope. Null is normal — a
  // user who signed in with Google has no GitHub token, and a public repo needs
  // none.
  const token = await getGithubToken(request.headers);

  const result = await fetchRawFile({
    owner: project.repoOwner,
    repo: project.repoName,
    ref,
    path: query.data.path,
    token,
    maxBytes: shape.maxBytes,
    // If the person closes the popup, stop pulling their file across the
    // internet on their behalf.
    signal: request.signal,
  });

  if (!result.ok) {
    if (result.error === "too_large") {
      return refuse(
        "too_large",
        tooLargeMessage(result.size ?? null, shape.maxBytes),
        413,
      );
    }
    return refuse(
      result.error === "not_found" ? "not_found" : "github",
      RAW_MESSAGES[result.error],
      result.error === "not_found" ? 404 : 502,
    );
  }

  const headers = new Headers(NO_STORE);
  headers.set("Content-Type", shape.contentType);
  headers.set("Content-Disposition", dispositionFor(query.data.path));
  // The content type above is ours, not the file's. `nosniff` is what stops a
  // browser from deciding for itself that our text/plain is really HTML.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (result.value.size !== null) {
    headers.set("Content-Length", String(result.value.size));
  }

  /*
   * An SVG is a document, not a picture.
   *
   * It can carry script and can reach other addresses. Inside an `<img>` tag —
   * the only place the viewer in this repository ever puts one — the browser
   * already refuses to run it. This header covers the other door: somebody who
   * opens the address directly gets an inert, sandboxed picture rather than a
   * page running on our origin with their session attached. `style-src` stays
   * open because an SVG's own `<style>` block is how it is coloured, and a logo
   * drawn in the wrong colours is a bug we would have shipped for nothing.
   *
   * Not applied to the PDF: the browser's built-in viewer is itself a sandboxed
   * document, and a `sandbox` directive on the response is what stops it from
   * opening at all.
   */
  if (shape.contentType === "image/svg+xml") {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  }

  // Straight through. Nothing in this process ever holds the whole file.
  return new Response(result.value.body, { status: 200, headers });
}

/**
 * `inline`, with the name written twice.
 *
 * The plain `filename` is ASCII-only for old clients; `filename*` carries the
 * real one, which for this product is regularly Korean. Quotes and control
 * characters are stripped rather than escaped — a header is not a place to be
 * clever about someone else's file name.
 */
function dispositionFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
