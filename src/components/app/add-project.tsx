"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AddProjectForm } from "./add-project-form";
import { FolderUpload } from "./folder-upload";
import { RepoPicker } from "./repo-picker";

type Tab = "pick" | "paste" | "upload";

/**
 * Three ways in, in the order most people will use them.
 *
 * Picking from a list asks someone to recognise a name they already know;
 * pasting a URL asks them to go and find one. Uploading a folder is for the
 * project that is not on GitHub at all — which for this product's user is
 * common, since an app prompted into existence on a laptop often never gets
 * pushed anywhere.
 */
export function AddProject() {
  const [tab, setTab] = useState<Tab>("pick");
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  function handleConnected(message: string) {
    setNotice(message);
    // The project list on this page is server-rendered, so it needs a refresh
    // to show what was just connected.
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-edge bg-ink-raised p-6">
      <div className="flex gap-1 border-b border-edge pb-3">
        <TabButton active={tab === "pick"} onClick={() => setTab("pick")}>
          내 저장소에서 고르기
        </TabButton>
        <TabButton active={tab === "paste"} onClick={() => setTab("paste")}>
          주소 붙여넣기
        </TabButton>
        <TabButton active={tab === "upload"} onClick={() => setTab("upload")}>
          폴더 올리기
        </TabButton>
      </div>

      <div className="pt-4">
        {tab === "pick" ? (
          <RepoPicker onConnected={handleConnected} />
        ) : tab === "upload" ? (
          <FolderUpload onConnected={handleConnected} />
        ) : (
          <AddProjectForm />
        )}
      </div>

      {notice ? (
        <p role="status" className="mt-4 text-[14px] leading-[1.75] text-said-soft">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg px-3 py-1.5 text-[14px] font-medium transition-colors ${
        active
          ? "bg-ink text-said"
          : "text-said-faint hover:text-said-soft"
      }`}
    >
      {children}
    </button>
  );
}
