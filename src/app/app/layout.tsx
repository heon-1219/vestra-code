import { Aurora } from "@/components/ambient/aurora";
import { AppHeader } from "@/components/app/app-header";
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
    /*
     * The shell is exactly the viewport tall, and scrolling happens inside
     * <main>. The workspace is a three-column screen with its own scrolling
     * regions (a file list, a connections panel, a canvas that sizes itself
     * from its container), and none of that can be laid out against a page
     * that grows: the canvas would chase the document height. The dashboard
     * simply scrolls inside the same box.
     */
    <div className="relative flex h-dvh flex-col">
      <Aurora intensity="quiet" />
      {/*
        Inside a project this bar hides itself and comes back when the pointer
        reaches the top edge, so the workspace gets the hundred pixels that two
        stacked headers were spending on a wordmark and a name. It decides that
        from the route, which is why it is a client component — the layout is
        shared by the dashboard and every workspace, and only the workspace has
        a second header underneath.
      */}
      <AppHeader
        name={session.user.name || session.user.email}
        image={session.user.image}
        signOut={<SignOutButton />}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
