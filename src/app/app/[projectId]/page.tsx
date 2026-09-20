import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";

import { AccountStrip } from "@/components/app/account-strip";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Workspace } from "@/components/workspace/workspace";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { loadGraphView } from "@/lib/graph/load";
import { getSession, requireSession } from "@/lib/session";

/**
 * One project's workspace.
 *
 * Everything on this page is rendered from the database on the server, and the
 * client shell takes over from there. That order is what makes the headline
 * promise of Step 3 work: a refresh in the middle of a run is not a recovery
 * problem, because the run was never attached to the page. The row says a run
 * is in flight, the shell is handed its id, and the stream picks up from the
 * cursor the last page left in session storage.
 */

export const dynamic = "force-dynamic";

// The route parameter is typed here rather than through the generated
// `PageProps<'/app/[projectId]'>` helper, because that file is written by
// `next dev`/`next build` and a route added since the last one would not be in
// it yet. The shape is the one Next passes either way.
type ProjectPageProps = { params: Promise<{ projectId: string }> };

const idSchema = z.uuid();

export async function generateMetadata({ params }: ProjectPageProps) {
  const session = await getSession();
  const id = idSchema.safeParse((await params).projectId);
  if (!session || !id.success) return { title: "프로젝트 — Vestra Code" };

  const [project] = await db
    .select({ displayName: projects.displayName })
    .from(projects)
    .where(and(eq(projects.id, id.data), eq(projects.userId, session.user.id)))
    .limit(1);

  // Several projects open at once is the normal case, and three tabs all
  // reading "프로젝트" helps nobody.
  return {
    title: project ? `${project.displayName} — Vestra Code` : "프로젝트 — Vestra Code",
  };
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const session = await requireSession();

  const id = idSchema.safeParse((await params).projectId);
  // A malformed id is indistinguishable from a missing one, to the user and to
  // us — and both give the same answer as someone else's project, so that a
  // stranger cannot learn which ids exist.
  if (!id.success) notFound();

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id.data), eq(projects.userId, session.user.id)))
    .limit(1);

  if (!project) notFound();

  const view = await loadGraphView(db, project.id);
  const run = view.lastRun;
  const running = run?.status === "pending" || run?.status === "running";

  return (
    <Workspace
      project={{
        id: project.id,
        displayName: project.displayName,
        source: project.source,
        repoOwner: project.repoOwner,
        repoName: project.repoName,
      }}
      initialView={view}
      activeRunId={running && run ? run.id : null}
      /*
       * Rendered here, where the session already is, and handed over as a node.
       * The workspace is the one client component on this screen and it has no
       * reason to learn who is signed in.
       */
      account={
        <AccountStrip
          name={session.user.name || session.user.email}
          image={session.user.image}
          signOut={<SignOutButton />}
        />
      }
    />
  );
}
