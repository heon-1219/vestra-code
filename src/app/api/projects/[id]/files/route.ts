import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isSafeRepoPath } from "@/components/workspace/preview/preview-kinds";
import { db } from "@/db";
import { projects } from "@/db/schema";
import {
  STORE_BUDGET_BYTES,
  storageUsageFor,
  storeProjectFiles,
  type StorableFile,
  type StoreRefusal,
} from "@/lib/preview/store";
import { getSession } from "@/lib/session";

/**
 * The second half of an upload: the pictures and the PDFs.
 *
 * The first request sends text, which is small — a real project is a few
 * hundred kilobytes of it — and the analysis starts on arrival. Binaries are a
 * different problem: they are most of a folder's weight, nothing in the
 * analysis ever reads them, and for a long time we did not send them at all.
 * That was right until previews existed. Now a photo in the map is something a
 * person will click, and for an uploaded project this is the only chance to
 * have its bytes: the folder is on their machine and we cannot ask for it
 * again from another computer.
 *
 * So it is a **separate request, in batches, after the project exists**, and
 * that shape is the point:
 *
 *   - The map does not wait for it. Analysis is already running when the first
 *     batch arrives.
 *   - Failing costs previews, not the project. A dropped connection halfway
 *     through leaves a working map with some pictures missing, which is a
 *     sentence we can say, rather than a failed upload of a folder the person
 *     already waited for.
 *   - Each request stays small enough to hold in memory. `formData()` buffers
 *     the whole body, so the batch size is not a nicety.
 *
 * The path is the form field's name. It is validated here and never used to
 * open anything — it is a key in a table, and `isSafeRepoPath` is what keeps it
 * from being anything else.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

/**
 * A ceiling on one request, twice what the browser sends in a batch.
 *
 * `formData()` reads the entire body into memory before returning, so without
 * this a single hand-rolled POST decides how much memory this process uses.
 * The browser batches at half of it; the margin is for the multipart framing.
 */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

const UNAUTHENTICATED = "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.";
const NOT_FOUND = "이 프로젝트를 찾지 못했어요.";
const TOO_BIG = "한 번에 보낼 수 있는 양을 넘었어요.";
const UNREADABLE = "보내주신 파일을 읽지 못했어요.";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return Response.json({ message: UNAUTHENTICATED }, { status: 401 });

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ message: NOT_FOUND }, { status: 404 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REQUEST_BYTES) {
    return Response.json({ message: TOO_BIG }, { status: 413 });
  }

  const [project] = await db
    .select({ id: projects.id, source: projects.source })
    .from(projects)
    .where(
      and(eq(projects.id, params.data.id), eq(projects.userId, session.user.id)),
    )
    .limit(1);

  // The same answer for "no such project" and "somebody else's project", for
  // the same reason as the preview endpoint: a 403 would confirm the id.
  if (!project) return Response.json({ message: NOT_FOUND }, { status: 404 });

  // A GitHub project's files are fetched from GitHub. Accepting bytes for one
  // would quietly create the thing this product promises not to have.
  if (project.source !== "upload") {
    return Response.json({ message: NOT_FOUND }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ message: UNREADABLE }, { status: 400 });
  }

  const files: StorableFile[] = [];
  const refused: StoreRefusal[] = [];
  let received = 0;

  for (const [name, value] of form.entries()) {
    if (typeof value === "string") continue;
    if (!isSafeRepoPath(name)) {
      refused.push({ path: name, reason: "unsupported" });
      continue;
    }
    received += value.size;
    // A body whose parts add up to more than the header claimed. Stop reading
    // rather than trust the count we checked before parsing.
    if (received > MAX_REQUEST_BYTES) {
      return Response.json({ message: TOO_BIG }, { status: 413 });
    }
    files.push({
      path: name,
      content: Buffer.from(await value.arrayBuffer()),
    });
  }

  // Read the usage now, not when the project was created: this is the second,
  // third and fourth batch as well, and each one has to see what the last spent.
  const usage = await storageUsageFor(db, project.id);

  try {
    const outcome = await storeProjectFiles(db, project.id, files, usage);
    return Response.json({
      stored: outcome.stored,
      refused: [...refused, ...outcome.refused],
      remaining: Math.max(
        0,
        STORE_BUDGET_BYTES - usage.bytes - outcome.storedBytes,
      ),
    });
  } catch (error) {
    console.error("[files] storing uploaded bytes failed", project.id, error);
    // 202-shaped failure: the caller should carry on with the rest of the
    // folder rather than abandon an upload over one batch.
    return Response.json({ message: UNREADABLE, stored: 0 }, { status: 500 });
  }
}
