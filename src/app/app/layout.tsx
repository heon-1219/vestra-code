import Link from "next/link";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireSession } from "@/lib/session";

/**
 * Everything under /app is behind a session.
 *
 * The check runs here rather than in a proxy (the file convention formerly
 * called middleware, deprecated in Next 16). Section 8 of the brief is explicit
 * that protection must not rely on a network-boundary layer alone — each route
 * handler checks the session and checks that the project belongs to the user.
 * A layout check covers the pages; handlers still check for themselves.
 */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const session = await requireSession();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-edge">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between px-6 py-4">
          <Link
            href="/app"
            className="text-[15px] font-semibold tracking-[-0.02em]"
          >
            Vestra Code
          </Link>
          <div className="flex items-center gap-5">
            <span className="text-[14px] text-said-faint">
              {session.user.name || session.user.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
