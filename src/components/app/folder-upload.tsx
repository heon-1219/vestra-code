"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { classifyFile, LIMITS } from "@/analysis/ingest/limits";

/**
 * Picking a folder off your own machine.
 *
 * The filtering happens HERE, before anything is uploaded. A project folder
 * usually contains `node_modules`, which is tens of thousands of files and
 * hundreds of megabytes — uploading it and filtering server-side would mean a
 * long wait to discard almost everything. The rules come from the same module
 * the server uses, so the two cannot drift.
 *
 * Assets are never uploaded at all. A photo becomes a node so "nothing uses
 * this photo" can be answered, but nothing ever reads its bytes, so only its
 * path and size are sent.
 */

type Chosen = {
  texts: { path: string; content: string }[];
  assets: { path: string; size: number }[];
  skippedCount: number;
  rootName: string;
  textBytes: number;
};

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
    let skippedCount = 0;
    let textBytes = 0;

    for (const file of files) {
      const relative = file.webkitRelativePath.split("/").slice(1).join("/");
      if (!relative) {
        skippedCount += 1;
        continue;
      }
      const kind = classifyFile(relative, file.size);

      if (kind === "asset") {
        if (assets.length < LIMITS.maxAssets) assets.push({ path: relative, size: file.size });
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

    setChosen({ texts, assets, skippedCount, rootName, textBytes });
    setReading(false);
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
      onConnected(`${result.displayName} 올렸어요. ${result.summary}`);
      setChosen(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch {
      setError("올리지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setUploading(false);
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

      <p className="mt-2 text-[13px] leading-[1.7] text-said-faint">
        폴더를 통째로 선택하세요. 코드만 읽고, 코드는 저장하지 않아요. 사진이나
        영상 같은 파일은 이름만 확인하고 올리지 않아요.
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
            {chosen.assets.length > 0
              ? ` · 사진·영상 ${chosen.assets.length.toLocaleString("ko-KR")}개는 이름만`
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
            {uploading ? "올리는 중…" : "이 폴더로 시작하기"}
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
