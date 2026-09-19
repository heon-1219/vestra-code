import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { AddProject } from "@/components/app/add-project";
import { DeleteProject } from "@/components/app/delete-project";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { requireSession } from "@/lib/session";

export const metadata = { title: "내 프로젝트 — Vestra Code" };

export default async function AppDashboard() {
  const session = await requireSession();

  // Scoped to the signed-in user, always. Section 8: every read checks that the
  // rows belong to the person asking.
  const myProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, session.user.id))
    // Newest first. The list is the thing you come back to, and the project you
    // are still thinking about is almost always the one you made last.
    .orderBy(desc(projects.createdAt));

  return (
    /*
     * Side by side, and the height is the page's rather than the content's.
     *
     * Stacked, the picker pushed the projects below the fold, so someone with
     * six maps scrolled past the same three tabs every time they came here to
     * open one — and the picker is the thing you use once, where the list is
     * the thing you use every visit. Beside each other, both are reachable
     * without scrolling, and only the list scrolls.
     *
     * `h-full` works because <main> in the layout above is a flex child with a
     * definite height; without that this would collapse to its content and the
     * inner `overflow-y-auto` would never have a reason to scroll.
     */
    <div className="mx-auto flex h-full min-h-0 max-w-[1180px] flex-col px-6 py-10">
      <h1 className="display-kr shrink-0 text-[30px]">내 프로젝트</h1>

      <div className="mt-7 grid min-h-0 flex-1 gap-8 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
        {/*
          The picker is the narrower of the two — its widest state is a list of
          repository names, which needs far less room than a grid of cards. On a
          narrow window the grid collapses to one column and the two stack in
          the order they are written, which puts the picker first, where someone
          with no projects yet needs it.

          Its own heading exists so the two columns start on the same line. Both
          sides now open with a 13px label and put their content at `mt-3`, so
          the card's top edge and the first project card's top edge are the same
          edge — which is what stops the page reading as two things dropped side
          by side at different heights.

          No scroller here. The card holds one, over the repository list, and a
          second one around the card put a bar down the column's edge with a few
          pixels of travel and nothing worth scrolling to.
        */}
        <section className="flex min-h-0 flex-col">
          <h2 className="shrink-0 text-[13px] text-said-faint">새 프로젝트</h2>
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            <AddProject />
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          <h2 className="flex shrink-0 items-baseline gap-2 text-[13px] text-said-faint">
            만들어 둔 지도
            {myProjects.length > 0 ? (
              <span className="font-mono">{myProjects.length}</span>
            ) : null}
          </h2>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {myProjects.length === 0 ? (
              <div className="rounded-2xl border border-edge bg-ink-raised p-8">
                <h3 className="text-[17px] font-semibold tracking-[-0.02em]">
                  아직 만든 지도가 없어요
                </h3>
                {/*
                  Points at the thing that fixes it, and says what we keep —
                  which is now two different answers. A GitHub repository is
                  read and not stored; an uploaded folder is kept so you can
                  open its files later, from any computer. Saying only the first
                  one would be the older, simpler promise that this product no
                  longer keeps for both halves.
                */}
                <p className="mt-3 text-[15px] leading-[1.8] text-said-soft">
                  왼쪽에서 저장소를 고르거나 폴더를 올리면, 코드를 한 번 읽어서
                  여기에 지도를 그려 드려요.
                </p>
                <p className="mt-2 text-[13px] leading-[1.75] text-said-faint">
                  GitHub 저장소는 지도와 파일 경로만 보관하고, 올려주신 폴더는
                  나중에 열어보실 수 있게 파일도 함께 보관해요.
                </p>
              </div>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {myProjects.map((project) => (
                  <li key={project.id} className="relative">
                    {/* The whole card is the link, not a word inside it: this
                        is the only way into the workspace, and a small target
                        in the corner of a card is a thing people miss. The one
                        exception sits on top of it rather than inside it — a
                        button nested in an anchor is invalid markup that
                        browsers resolve by guessing. */}
                    <DeleteProject
                      projectId={project.id}
                      displayName={project.displayName}
                      isUpload={project.source === "upload"}
                    />
                    <Link
                      href={`/app/${project.id}`}
                      className="block h-full rounded-2xl border border-edge bg-ink-raised p-5 transition-colors hover:border-edge-lit"
                    >
                      <h3 className="pr-12 text-[16px] font-semibold tracking-[-0.02em]">
                        {project.displayName}
                      </h3>
                      <p className="mt-1 truncate text-[13px] text-said-faint">
                        {project.source === "upload" ? (
                          // An uploaded folder has no owner and no repository
                          // name, and printing "null/null" for it would be the
                          // app telling someone their project is broken.
                          "내 컴퓨터에서 올린 폴더"
                        ) : (
                          <span className="font-mono">
                            {project.repoOwner}/{project.repoName}
                          </span>
                        )}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
