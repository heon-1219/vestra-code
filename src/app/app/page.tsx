import { eq } from "drizzle-orm";
import Link from "next/link";

import { AddProject } from "@/components/app/add-project";
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
    .where(eq(projects.userId, session.user.id));

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-16">
      <h1 className="display-kr text-[30px]">내 프로젝트</h1>

      <div className="mt-8 max-w-[720px]">
        <AddProject />
      </div>

      {myProjects.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-edge bg-ink-raised p-10">
          <h2 className="text-[19px] font-semibold tracking-[-0.02em]">
            아직 연결한 저장소가 없어요
          </h2>
          <p className="mt-3 max-w-[52ch] text-[15px] leading-[1.8] text-said-soft">
            GitHub 공개 저장소를 연결하면 코드를 읽어서 앱의 지도를 그립니다.
            소스 코드는 저장하지 않고, 지도와 파일 경로만 보관합니다.
          </p>
        </div>
      ) : (
        <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {myProjects.map((project) => (
            <li key={project.id}>
              {/* The whole card is the link, not a word inside it: this is the
                  only way into the workspace, and a small target in the corner
                  of a card is a thing people miss. */}
              <Link
                href={`/app/${project.id}`}
                className="block h-full rounded-2xl border border-edge bg-ink-raised p-6 transition-colors hover:border-edge-lit"
              >
                <h2 className="text-[17px] font-semibold tracking-[-0.02em]">
                  {project.displayName}
                </h2>
                <p className="mt-1 text-[13px] text-said-faint">
                  {project.source === "upload" ? (
                    // An uploaded folder has no owner and no repository name,
                    // and printing "null/null" for it would be the app telling
                    // someone their project is broken.
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
  );
}
