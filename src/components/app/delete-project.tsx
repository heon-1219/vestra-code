"use client";

import { useState, useTransition } from "react";

import { deleteProject } from "@/app/app/actions";

/**
 * Removing a project, with the sentence that says what that costs.
 *
 * Two steps, and the second one is not a browser `confirm()`. A native dialog
 * says "이 사이트의 메시지" above whatever we wrote, cannot say it in this
 * product's own words, and on some setups does not appear at all. The confirm
 * is part of the card instead, and it states what leaves with the project —
 * which for an uploaded folder is the only copy of those files we hold.
 *
 * The trigger sits over the card, not inside it. The whole card is a link to
 * the workspace, and a `<button>` inside an `<a>` is invalid HTML that browsers
 * resolve by guessing. Absolutely positioned above it keeps both targets real.
 *
 * It is always visible, never hover-only. A control that appears on hover does
 * not exist on a touch screen, and is found by keyboard users only by accident.
 * Quiet is enough: it is `said-faint` until you are on it.
 */
export function DeleteProject({
  projectId,
  displayName,
  isUpload,
}: {
  projectId: string;
  displayName: string;
  /** An upload has no origin, so deleting it is the end of those files. */
  isUpload: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
        // The card's own title is right there; a screen reader reading five
        // buttons all called "삭제" cannot tell the user which is which.
        aria-label={`${displayName} 지우기`}
        // Brightens rather than darkens under the pointer. It sits on a raised
        // card, so filling with `ink` made the hover read as a hole punched in
        // the card — the same inversion the tab row had. Everything on this
        // screen now moves toward the light when you are on it.
        className="absolute top-3 right-3 z-10 rounded-lg px-2.5 py-1.5 text-[12px] text-said-faint transition-colors hover:bg-edge-lit hover:text-said focus-visible:bg-edge-lit focus-visible:text-said"
      >
        삭제
      </button>
    );
  }

  return (
    // Covers the card entirely, so the link underneath cannot be clicked by
    // someone aiming for 취소 and missing.
    //
    // `ink-sunk`, where this was the same `ink-raised` as the card it covers.
    // Two surfaces of one colour with a brighter line between them is a card
    // whose contents changed, not a question laid over a card — and the whole
    // point of this panel is that something has intervened between the click
    // and the deletion. The darkest surface in the palette is also the right
    // register for it: a destructive confirm should recede, not shout.
    <div className="absolute inset-0 z-20 flex flex-col justify-center rounded-2xl border border-edge-lit bg-ink-sunk p-6">
      <p className="text-[15px] leading-[1.7] font-semibold">지울까요?</p>
      <p className="mt-2 text-[13px] leading-[1.75] text-said-soft">
        {isUpload
          ? "지도와 함께 보관해 둔 파일도 사라져요. 올리셨던 폴더는 그대로 있어요."
          : "그려둔 지도가 사라져요. GitHub 저장소는 그대로 있어요."}
      </p>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const result = await deleteProject(projectId);
              if (result.status === "error") {
                // Stay open. Closing the panel would take the sentence
                // explaining the failure off screen with it, and leave someone
                // looking at a card that simply did not go away.
                setError(result.message);
                return;
              }
              // No navigation and no local state to clear: the action
              // revalidates /app, so this card leaves with the list it was in.
            });
          }}
          className="rounded-lg bg-paper px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-lamp disabled:opacity-55"
        >
          {pending ? "지우는 중…" : "지우기"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(false)}
          className="rounded-lg px-3.5 py-2 text-[13px] text-said-soft transition-colors hover:text-said disabled:opacity-55"
        >
          취소
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-[12px] leading-[1.6] text-c4">
          {error}
        </p>
      ) : null}
    </div>
  );
}
