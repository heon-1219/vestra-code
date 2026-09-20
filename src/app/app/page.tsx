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
          sides now open with the same `label-kr text-micro` label and put their
          content at `mt-3`, so the card's top edge and the first project card's
          top edge are the same edge — which is what stops the page reading as
          two things dropped side by side at different heights. Whatever those
          two classes resolve to, they resolve to it on both headings, which is
          the whole requirement: the invariant is that the two are identical,
          not that they are any particular height.

          No scroller here. The card holds one, over the repository list, and a
          second one around the card put a bar down the column's edge with a few
          pixels of travel and nothing worth scrolling to.
        */}
        <section className="flex min-h-0 flex-col">
          <h2 className="label-kr shrink-0 text-micro text-said-faint">
            새 프로젝트
          </h2>
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            <AddProject />
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          <h2 className="label-kr flex shrink-0 items-baseline gap-2 text-micro text-said-faint">
            만들어 둔 지도
            {/* `tracking-normal` because the count is a numeral, not a label:
                `label-kr`'s 0.14em is set for Hangul, which carries its own
                sidebearing, and inheriting it pulls the digits of a two-digit
                count visibly apart. */}
            {myProjects.length > 0 ? (
              <span className="font-mono tracking-normal">
                {myProjects.length}
              </span>
            ) : null}
          </h2>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {myProjects.length === 0 ? (
              /*
               * The empty state fills the column rather than sitting at the top
               * of it.
               *
               * Empty, this is the largest area on the page, and a short box
               * with a void under it reads as a page that failed to load rather
               * than a page waiting for you. `min-h-full` resolves because the
               * scroller above it is a flex child with a definite height; where
               * it cannot resolve it falls back to content height, which is
               * exactly what this used to be.
               *
               * Its fill is a fraction of `ink-raised` rather than the whole
               * thing, and the heading is the display face. Both say the same
               * thing in different registers: the panel is lighter than a
               * project card will be, so the first real card is the more solid
               * object of the two, while the sentence that tells you what to do
               * is the most present piece of type on this side of the page.
               */
              <div className="hairline flex min-h-full flex-col justify-center rounded-2xl bg-ink-raised/40 px-8 py-12">
                <h3 className="display-kr max-w-[16ch] text-[22px]">
                  아직 만든 지도가 없어요
                </h3>
                {/*
                  Points at the thing that fixes it, and says what we keep —
                  which is now two different answers. A GitHub repository is
                  read and not stored; an uploaded folder is kept so you can
                  open its files later, from any computer. Saying only the first
                  one would be the older, simpler promise that this product no
                  longer keeps for both halves.

                  The second sentence sits under a rule rather than in the same
                  block, because it answers a different question: the first is
                  what to do, the second is what it costs you. Stacked with only
                  a size change between them they read as one paragraph that
                  got quieter.
                */}
                <p className="mt-4 max-w-[36ch] text-[15px] leading-[1.8] text-said-soft">
                  왼쪽에서 저장소를 고르거나 폴더를 올리면, 코드를 한 번 읽어서
                  여기에 지도를 그려 드려요.
                </p>
                <p className="rule-t mt-7 max-w-[36ch] pt-5 text-[13px] leading-[1.8] text-said-faint">
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
                    {/*
                      `hairline` rather than a 1px border: this column is a
                      grid of boxes on a dark ground, and at 1px a dozen of
                      them read as a wireframe. `group` sits on the link, not
                      the list item, so the delete button above it does not
                      light the card it is about to remove.

                      Colour only on hover, and no movement. The landing page
                      lifts its cards; this is the surface someone opens six
                      times a day, and the second line brightening with the
                      border is enough to say which card the pointer is on.
                    */}
                    <Link
                      href={`/app/${project.id}`}
                      className="group hairline block h-full rounded-2xl bg-ink-raised p-5 transition-colors hover:border-edge-lit"
                    >
                      <h3 className="pr-12 text-[16px] font-semibold tracking-[-0.02em]">
                        {project.displayName}
                      </h3>
                      <p className="mt-1.5 truncate text-[13px] text-said-faint transition-colors group-hover:text-said-soft">
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
