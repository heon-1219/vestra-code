"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AddProjectForm } from "./add-project-form";
import { RepoPicker } from "./repo-picker";

type Tab = "pick" | "paste";

/**
 * Two ways in, with picking first.
 *
 * Pasting a URL asks the user to go and find one; picking from a list asks them
 * to recognise a name they already know. The paste field stays because it is
 * the only way to reach a repository that is not theirs, or one past the first
 * hundred — but it is the fallback, not the front door.
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
      </div>

      <div className="pt-4">
        {tab === "pick" ? (
          <RepoPicker onConnected={handleConnected} />
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
