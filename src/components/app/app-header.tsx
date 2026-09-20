"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { UserAvatar } from "@/components/app/user-avatar";

/**
 * The account bar, on the pages that have room for one.
 *
 * The dashboard gets an ordinary header: it is the only chrome on that page and
 * nothing competes with it. A project gets none at all, and the account row
 * moves to the foot of the file list (`AccountStrip`).
 *
 * That is the second answer to the same problem. Inside a project this was the
 * upper of two stacked bars — a wordmark, a name and a sign-out link sitting on
 * top of the bar that actually does the work, about a hundred pixels of a screen
 * whose whole job is to show as much of a project at once as it can. The first
 * answer was to hide it and slide it back when the pointer reached the top
 * edge. That bought the space and cost something worse: a control you find by
 * brushing a screen edge is one you find by accident, and a sign-out you cannot
 * see is one you cannot be sure is there.
 *
 * It is a client component only because the answer depends on the route, and
 * this layout is shared by the dashboard and every workspace.
 */
export function AppHeader({
  name,
  image,
  signOut,
}: {
  name: string;
  image: string | null | undefined;
  /** Rendered by the server so this component needs no session of its own. */
  signOut: ReactNode;
}) {
  const pathname = usePathname();

  /*
   * A project is `/app/<something>`. `/app` itself, and anything we add beside
   * it later, keeps the ordinary header — the rule is "is there a workspace
   * under this bar", not "is the path long".
   */
  const inProject = /^\/app\/[^/]+/.test(pathname);

  const bar = (
    <div className="mx-auto flex max-w-[1180px] items-center justify-between px-6 py-4">
      <Link href="/app" className="text-[15px] font-semibold tracking-[-0.02em]">
        Vestra Code
      </Link>
      <div className="flex items-center gap-5">
        {/* Picture and name are one object, so they get one gap between them
            and the sign-out button keeps the row's larger gap. */}
        <span className="flex items-center gap-2.5">
          <UserAvatar image={image} name={name} />
          <span className="text-[14px] text-said-faint">{name}</span>
        </span>
        {signOut}
      </div>
    </div>
  );

  /*
   * In a project there is no bar at all.
   *
   * This slid away and came back when the pointer reached the top edge, which
   * bought the workspace its hundred pixels and cost something worse: a
   * control you find by brushing against a screen edge is a control you find
   * by accident, and a sign-out you cannot see is one you cannot be sure is
   * there. The account row now lives at the foot of the file list instead —
   * see `AccountStrip`, which the project page renders and hands to the
   * workspace.
   */
  if (inProject) return null;

  return <header className="border-b border-edge">{bar}</header>;
}
