import { randomUUID } from "node:crypto";

import { z } from "zod";

import { LIMITS } from "@/analysis/ingest/limits";
import type { UploadPayload } from "@/analysis/ingest/upload";
import { startAnalysis } from "@/analysis/pipeline";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { detectProject, type PackageManifest } from "@/lib/github/detect";
import { getSession } from "@/lib/session";

/**
 * Receiving a folder the user picked on their own machine.
 *
 * The browser has already filtered with the same rules the server uses, and
 * sends only text — an asset arrives as a path and a size, never as bytes,
 * because nothing ever reads an asset's contents. That is what makes this
 * practical: the founder's portfolio is ~110 MB on disk for ~200 KB of text.
 *
 * The filtering is still re-done here. The browser's copy is a convenience for
 * the user; this one is the one that has to hold, because a request is
 * untrusted input no matter which page it claims to come from.
 */

const payloadSchema = z.object({
  displayName: z.string().min(1).max(120),
  texts: z
    .array(z.object({ path: z.string().min(1).max(1024), content: z.string() }))
    .max(LIMITS.maxSourceFiles),
  assets: z
    .array(z.object({ path: z.string().min(1).max(1024), size: z.number().int().nonnegative() }))
    .max(LIMITS.maxAssets),
  skippedCount: z.number().int().nonnegative(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return Response.json(
      { message: "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { message: "보내주신 파일을 읽지 못했어요. 폴더를 다시 선택해 주세요." },
      { status: 400 },
    );
  }

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { message: "보내주신 파일을 읽지 못했어요. 폴더를 다시 선택해 주세요." },
      { status: 400 },
    );
  }

  const { displayName, texts, assets, skippedCount } = parsed.data;

  if (texts.length === 0) {
    return Response.json(
      {
        message:
          "읽을 수 있는 파일이 폴더에 없었어요. 코드가 들어있는 폴더를 선택해 주세요.",
      },
      { status: 400 },
    );
  }

  const totalText = texts.reduce(
    (sum, file) => sum + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  if (totalText > LIMITS.maxTextBytes) {
    return Response.json(
      {
        message:
          "폴더가 한 번에 읽기에는 너무 커요. 프로젝트 폴더 하나만 선택해 주세요.",
      },
      { status: 413 },
    );
  }

  // Detection runs on the same signals as a repository: the file list plus any
  // manifests, so an uploaded Next.js folder is recognised exactly as its
  // GitHub twin would be.
  const paths = [...texts.map((f) => f.path), ...assets.map((f) => f.path)];
  const manifests: PackageManifest[] = texts
    .filter((f) => f.path === "package.json" || f.path.endsWith("/package.json"))
    .slice(0, 4)
    .map((f) => {
      try {
        return { path: f.path, json: JSON.parse(f.content) };
      } catch {
        return { path: f.path, json: null };
      }
    });
  const detection = detectProject(paths, manifests);

  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    userId: session.user.id,
    source: "upload",
    displayName,
    kind: detection.kind,
  });

  const payload: UploadPayload = { texts, assets, skippedCount, limitsHit: [] };

  const outcome = await startAnalysis({
    db,
    project: { id: projectId, source: "upload", kind: detection.kind },
    githubToken: null,
    upload: payload,
  });

  if (!outcome.ok) {
    return Response.json({ message: outcome.message }, { status: 400 });
  }

  return Response.json(
    {
      projectId,
      runId: outcome.runId,
      displayName,
      summary: detection.summary,
      fileCount: paths.length,
      textCount: texts.length,
      skippedCount,
    },
    { status: 202 },
  );
}
