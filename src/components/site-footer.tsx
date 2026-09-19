"use client";

import { usePathname } from "next/navigation";

/**
 * Who made this, at the bottom of the pages that have a bottom.
 *
 * In the root layout rather than on each page, so there is one footer and not
 * three that drift apart — but it takes itself off the signed-in app. Those
 * screens are exactly the height of the viewport with their own scrolling
 * regions inside; anything appended after them is not "at the bottom of the
 * page", it is a row that pushes a `h-dvh` shell past the viewport and gives
 * the whole document a scrollbar it was built not to have. The workspace has
 * no bottom to put this at.
 *
 * No year. A hard-coded one is wrong from the next January, and computing one
 * in a client component makes the server and the browser disagree about the
 * date across midnight — a hydration mismatch for a number nobody reads. The
 * notice is complete without it.
 */
export function SiteFooter() {
  const pathname = usePathname();

  // Everything under /app is the product; everything else is the page about it.
  if (pathname === "/app" || pathname.startsWith("/app/")) return null;

  return (
    <footer className="mt-auto border-t border-edge">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-6 text-[13px] text-said-faint md:px-10">
        <p>© David Seheon Chang</p>
        <a
          href="https://davidseheonchang.xyz"
          target="_blank"
          // `noopener` is the one that matters: without it the page we open
          // gets a handle on this one through `window.opener`.
          rel="noreferrer noopener"
          className="transition-colors hover:text-said-soft"
        >
          davidseheonchang.xyz
        </a>
      </div>
    </footer>
  );
}
