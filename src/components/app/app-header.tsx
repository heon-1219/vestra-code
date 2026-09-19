"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { UserAvatar } from "@/components/app/user-avatar";

/**
 * The account bar, which gets out of the way once you are actually working.
 *
 * On the dashboard it is an ordinary header: it is the only chrome on the page
 * and there is nothing competing with it. Inside a project it is the second of
 * two stacked bars, and the one with nothing to do with the work — a wordmark,
 * a name, a sign-out link — sitting on top of the one that does. Two rows of
 * chrome above a three-column workspace is roughly a hundred pixels of the
 * screen spent saying who you are, on a screen whose whole job is to show you
 * as much of your project at once as it can.
 *
 * So in a project it slides away and comes back when you reach for it. The
 * reveal is a strip along the top edge rather than a button, because the
 * gesture people already have for a hidden bar is "push the pointer at the top
 * of the screen" — the same one every full-screen video player and every
 * auto-hiding menu bar has trained.
 *
 * Three things this has to get right, and each of them is a way it could be
 * quietly broken:
 *
 *   1. **The hidden bar must not eat clicks.** The wrapper stays in the layout
 *      at the top of the screen even while the bar itself is translated out of
 *      view, so without `pointer-events: none` on it the workspace's own header
 *      — which sits directly underneath — would be unclickable along its whole
 *      top edge. Only the trigger strip and the bar itself take pointer events.
 *   2. **It must come back for the keyboard.** A bar that is off screen but
 *      still focusable sends Tab to a control nobody can see. `focus-within`
 *      reveals it for exactly the same reason hover does, and it is not an
 *      accessibility extra — without it the sign-out button becomes a trap.
 *   3. **It must not cost layout.** `transform` only: the bar is taken out of
 *      flow, so revealing it slides it over the workspace rather than pushing
 *      the whole three-column grid down and forcing the map's canvas to
 *      re-measure itself sixty times during the animation.
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

  if (!inProject) {
    return <header className="border-b border-edge">{bar}</header>;
  }

  return (
    <div className="group pointer-events-none absolute inset-x-0 top-0 z-40">
      {/*
        The reach-for-it strip. Eight pixels: wide enough that a pointer
        travelling to the top edge of the screen crosses it, narrow enough that
        it does not shadow the workspace header's own controls, which begin
        immediately below.
      */}
      <div className="pointer-events-auto h-2 w-full" aria-hidden="true" />

      <header
        className="pointer-events-auto -translate-y-[calc(100%+0.5rem)] border-b border-edge bg-ink/95 backdrop-blur transition-transform duration-200 ease-out group-hover:translate-y-0 group-focus-within:translate-y-0 motion-reduce:transition-none"
      >
        {bar}
      </header>
    </div>
  );
}
