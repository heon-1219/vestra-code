import Link from "next/link";
import type { ReactNode } from "react";

import { UserAvatar } from "@/components/app/user-avatar";

/**
 * Who you are and the way out, at the foot of the file list.
 *
 * It used to be a bar across the top of the workspace, above the workspace's
 * own bar — two rows of chrome over a three-column screen, the upper one
 * carrying a wordmark and a name and nothing to do with the work. Hiding it and
 * sliding it back on hover bought the space and cost something worse: a thing
 * that appears when your pointer strays near the top edge is a thing you find
 * by accident, and a sign-out you cannot see is a sign-out you cannot trust is
 * there.
 *
 * So it moved rather than hid. The foot of the left column is where an
 * application's account row has lived for twenty years — it is out of the way
 * without being hidden, it costs the map nothing because that column is a list
 * that ends, and it is the one place on this screen nothing else is competing
 * for.
 *
 * It is a server component, rendered by the page that already has the session,
 * and passed into the client shell as a node. The workspace does not learn who
 * is signed in — it is handed something to put in a corner.
 */
export function AccountStrip({
  name,
  image,
  signOut,
}: {
  name: string;
  image: string | null | undefined;
  /** Rendered by the caller, which is where the session lives. */
  signOut: ReactNode;
}) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-t border-edge px-3 py-2">
      <UserAvatar image={image} name={name} />
      {/*
        The name truncates and the controls do not. This column is resizable
        down to 170px, and at that width something has to give — a name is
        recognisable from its first few characters, where a sign-out link cut
        in half is a control nobody will risk pressing.
      */}
      <span className="min-w-0 flex-1 truncate text-[12px] text-said-faint">
        {name}
      </span>
      <Link
        href="/app"
        title="내 프로젝트"
        className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-said-faint transition-colors hover:bg-ink hover:text-said-soft"
      >
        목록
      </Link>
      {signOut}
    </div>
  );
}
