"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { classifyFile, LIMITS } from "@/analysis/ingest/limits";
import { previewShapeFor } from "@/components/workspace/preview/preview-kinds";

/**
 * Picking a folder off your own machine.
 *
 * The filtering happens HERE, before anything is uploaded. A project folder
 * usually contains `node_modules`, which is tens of thousands of files and
 * hundreds of megabytes — uploading it and filtering server-side would mean a
 * long wait to discard almost everything. The rules come from the same module
 * the server uses, so the two cannot drift.
 *
 * **Assets are sent in two different ways, and the split is deliberate.** Every
 * asset is sent as a path and a size, which is all the map needs to answer
 * "nothing uses this photo" — that is what keeps a 110 MB portfolio folder an
 * instant upload. The ones a person can actually open — pictures, PDFs — also
 * have their bytes sent, in a second pass, because for an uploaded project this
 * is the only chance to get them: the folder is on this machine and the map may
 * be opened on another one. Video, archives and everything else still travel as
 * a name alone.
 */

type Chosen = {
  texts: { path: string; content: string }[];
  assets: { path: string; size: number }[];
  /** The subset whose bytes are worth sending: openable, and within its ceiling. */
  previewable: { path: string; file: File }[];
  previewableBytes: number;
  skippedCount: number;
  rootName: string;
  textBytes: number;
};

/** One request's worth of pictures. Half the server's per-request ceiling. */
const BATCH_BYTES = 4 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function FolderUpload({
  onConnected,
}: {
  onConnected: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** How far through the picture pass we are, or null when it is not running. */
  const [keeping, setKeeping] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setReading(true);
    setError(null);

    const files = Array.from(fileList);
    // webkitRelativePath is "chosen-folder/rest/of/path"; the folder name is
    // the project's name, and the rest is the repo-relative path.
    const rootName = files[0].webkitRelativePath.split("/")[0] || "내 프로젝트";

    const texts: Chosen["texts"] = [];
    const assets: Chosen["assets"] = [];
    const previewable: Chosen["previewable"] = [];
    let skippedCount = 0;
    let textBytes = 0;
    let previewableBytes = 0;

    for (const file of files) {
      const relative = file.webkitRelativePath.split("/").slice(1).join("/");
      if (!relative) {
        skippedCount += 1;
        continue;
      }
      const kind = classifyFile(relative, file.size);

      if (kind === "asset") {
        if (assets.length < LIMITS.maxAssets) {
          assets.push({ path: relative, size: file.size });
          // The same test the server applies, so we never send a file it would
          // refuse. A video is an asset and is never openable; a 30 MB PDF is
          // openable in principle and over its own ceiling.
          const shape = previewShapeFor(relative);
          if (shape.contentType !== null && file.size <= shape.maxBytes) {
            previewable.push({ path: relative, file });
            previewableBytes += file.size;
          }
        }
        continue;
      }
      if (kind === "skip") {
        skippedCount += 1;
        continue;
      }
      if (texts.length >= LIMITS.maxSourceFiles || textBytes + file.size > LIMITS.maxTextBytes) {
        skippedCount += 1;
        continue;
      }

      texts.push({ path: relative, content: await file.text() });
      textBytes += file.size;
    }

    setChosen({
      texts,
      assets,
      previewable,
      previewableBytes,
      skippedCount,
      rootName,
      textBytes,
    });
    setReading(false);
  }

  /**
   * Send the openable assets, in batches, until the project's budget runs out.
   *
   * Never throws. Every outcome here is "some pictures may not open", which is
   * not a reason to tell someone their upload failed — the map is already being
   * drawn by the time this runs.
   */
  async function keepPictures(projectId: string, budget: number) {
    if (!chosen || chosen.previewable.length === 0) return;

    setKeeping({ done: 0, total: chosen.previewable.length });
    let remaining = budget;
    let done = 0;

    let batch: Chosen["previewable"] = [];
    let batchBytes = 0;

    const send = async () => {
      if (batch.length === 0) return;
      const form = new FormData();
      // The field name is the path. It is a key in a table on the other side,
      // never a filesystem path, and the server validates it as such.
      for (const entry of batch) form.append(entry.path, entry.file);
      try {
        const response = await fetch(`/api/projects/${projectId}/files`, {
          method: "POST",
          body: form,
        });
        if (response.ok) {
          const result = await response.json();
          if (typeof result?.remaining === "number") remaining = result.remaining;
        }
      } catch {
        // A dropped batch costs previews for those files and nothing else.
      }
      done += batch.length;
      setKeeping({ done, total: chosen.previewable.length });
      batch = [];
      batchBytes = 0;
    };

    for (const entry of chosen.previewable) {
      if (entry.file.size > remaining - batchBytes) continue;
      batch.push(entry);
      batchBytes += entry.file.size;
      if (batchBytes >= BATCH_BYTES) await send();
    }
    await send();
    setKeeping(null);
  }

  async function upload() {
    if (!chosen) return;
    setUploading(true);
    setError(null);
    try {
      const response = await fetch("/api/projects/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: chosen.rootName,
          texts: chosen.texts,
          assets: chosen.assets,
          skippedCount: chosen.skippedCount,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result?.message ?? "올리지 못했어요. 잠시 후 다시 시도해 주세요.");
        return;
      }

      // The project exists and its analysis has started; the pictures follow
      // while that runs.
      await keepPictures(
        result.projectId,
        typeof result.storageRemaining === "number" ? result.storageRemaining : 0,
      );

      onConnected(`${result.displayName} 올렸어요. ${result.summary}`);
      setChosen(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch {
      setError("올리지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setUploading(false);
      setKeeping(null);
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        // Non-standard but supported everywhere this product runs; it is the
        // only way a browser can offer a folder rather than a file.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ webkitdirectory: "", directory: "" } as any)}
        multiple
        onChange={(event) => handleFiles(event.target.files)}
        className="block w-full cursor-pointer rounded-xl border border-dashed border-edge-lit bg-ink px-4 py-8 text-center text-[14px] text-said-soft file:hidden hover:border-lamp-dim"
        aria-label="프로젝트 폴더 선택"
      />

      {/* Says what actually happens now, which is not what it used to say. A
          folder we keep is a folder we can open later, and someone deciding
          whether to upload deserves to know that before they do. */}
      <p className="mt-2 text-[13px] leading-[1.7] text-said-faint">
        폴더를 통째로 선택하세요. 나중에 열어볼 수 있도록 코드와 사진·PDF를 함께
        보관해요. 영상처럼 큰 파일은 이름만 확인하고 올리지 않아요.
      </p>

      {reading ? (
        <p className="mt-4 text-[14px] text-said-soft">폴더를 읽는 중…</p>
      ) : null}

      {chosen ? (
        <div className="mt-4 rounded-xl border border-edge bg-ink p-4">
          <p className="text-[15px] font-semibold">{chosen.rootName}</p>
          <p className="mt-1.5 text-[13px] leading-[1.75] text-said-soft">
            읽을 파일 {chosen.texts.length.toLocaleString("ko-KR")}개 (
            {formatBytes(chosen.textBytes)})
            {chosen.previewable.length > 0
              ? ` · 열어볼 수 있는 사진·PDF ${chosen.previewable.length.toLocaleString("ko-KR")}개 (${formatBytes(chosen.previewableBytes)})`
              : ""}
            {chosen.assets.length > chosen.previewable.length
              ? ` · 나머지 ${(chosen.assets.length - chosen.previewable.length).toLocaleString("ko-KR")}개는 이름만`
              : ""}
            {chosen.skippedCount > 0
              ? ` · ${chosen.skippedCount.toLocaleString("ko-KR")}개는 읽지 않아요`
              : ""}
          </p>
          <button
            type="button"
            onClick={upload}
            disabled={uploading || chosen.texts.length === 0}
            className="mt-4 rounded-lg bg-paper px-5 py-2.5 text-[14px] font-semibold text-ink transition-colors hover:bg-lamp disabled:opacity-55"
          >
            {keeping
              ? `사진 보관 중 ${keeping.done}/${keeping.total}`
              : uploading
                ? "올리는 중…"
                : "이 폴더로 시작하기"}
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-[14px] leading-[1.7] text-c4">
          {error}
        </p>
      ) : null}
    </div>
  );
}
