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
    /*
     * A column that takes the height it is given rather than the height of its
     * contents, so the repo list inside can be the only scroller on this side.
     */
    <div className="hairline flex min-h-0 flex-1 flex-col rounded-2xl bg-ink-raised p-6 max-lg:flex-none max-md:p-4">
      {/*
        Three labels short enough to sit on one line each at this column's
        narrowest, which is 300px minus the card's padding. Two-line tabs read
        as a broken layout, and the fix is the shorter word rather than a wider
        column — the column is narrow on purpose (the list beside it is what
        this page is for).
      */}
      <div className="flex shrink-0 gap-1 border-b border-edge pb-3">
        <TabButton active={tab === "pick"} onClick={() => setTab("pick")}>
          GitHub에서
        </TabButton>
        <TabButton active={tab === "paste"} onClick={() => setTab("paste")}>
          붙여넣기
        </TabButton>
        <TabButton active={tab === "upload"} onClick={() => setTab("upload")}>
          업로드
        </TabButton>
      </div>

      {/*
        The repo tab runs its own scroller over the list alone, so this holds it
        rather than scrolling it a second time. The other two are short forms
        that grow with what you pick, and scroll here on a short window.
      */}
      <div
        className={`min-h-0 flex-1 pt-4 max-lg:flex-none max-lg:overflow-visible ${
          tab === "pick" ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        {tab === "pick" ? (
          <RepoPicker onConnected={handleConnected} />
        ) : tab === "upload" ? (
          <FolderUpload onConnected={handleConnected} />
        ) : (
          <AddProjectForm />
        )}
      </div>

      {/*
        Under a rule, and in the page's ordinary text colour.

        This is the sentence that says the thing you came here to do worked,
        and it was the quietest type in the card — `said-soft` at the foot of a
        panel, with nothing separating it from the form above. A rule gives it
        its own register without making it loud, which is the same move the
        empty state makes between "what to do" and "what it costs".
      */}
      {notice ? (
        <p
          role="status"
          className="rule-t mt-5 shrink-0 pt-4 text-[14px] leading-[1.75] text-said"
        >
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
    // `whitespace-nowrap` is the guarantee rather than the hope: a tab that
    // wraps is the exact thing this row's type size and padding are set to
    // avoid, and a label two lines tall reads as a broken layout.
    //
    // The selected tab is `edge-lit`, not `ink`. Both are chips this product
    // already uses for exactly this — the workspace's panel modes fill with
    // `ink`, its places tabs fill with `edge-lit` — but the two are on
    // opposite sides of the surface they sit on. This row is on a raised card,
    // so an `ink` chip is DARKER than its own card and the selected tab reads
    // as a hole punched in the panel. `edge-lit` is lighter, which is the
    // direction this palette already means by "you are here".
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center rounded-lg px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors max-md:min-h-11 max-md:px-3 ${
        active
          ? "bg-edge-lit text-said"
          : "text-said-faint hover:bg-edge/60 hover:text-said-soft"
      }`}
    >
      {children}
    </button>
  );
}
