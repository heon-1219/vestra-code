import Link from "next/link";
import { redirect } from "next/navigation";

import { Aurora } from "@/components/ambient/aurora";
import { SignInButtons } from "@/components/auth/sign-in-buttons";
import { getSession } from "@/lib/session";

export const metadata = { title: "시작하기 — Vestra Code" };

export default async function SignInPage() {
  const session = await getSession();
  if (session) {
    redirect("/app");
  }

  return (
    <main className="relative flex min-h-screen flex-col">
      <Aurora />
      <div className="mx-auto w-full max-w-[1180px] px-6 py-5">
        <Link
          href="/"
          className="text-[15px] font-semibold tracking-[-0.02em] text-said-soft transition-colors hover:text-said"
        >
          Vestra Code
        </Link>
      </div>

      <div className="flex flex-1 items-center justify-center px-6 pb-24">
        <div className="w-full max-w-[400px]">
          <h1 className="display-kr text-[32px]">시작하기</h1>
          <p className="mt-3 text-[15px] leading-[1.8] text-said-soft">
            GitHub이나 Google 계정으로 들어오세요. 따로 가입할 것은 없습니다.
          </p>

          <div className="mt-9">
            <SignInButtons />
          </div>

          <p className="mt-8 text-[13px] leading-[1.75] text-said-faint">
            GitHub으로 들어오시면 공개 저장소를 더 빠르게 읽을 수 있습니다.
            비공개 저장소 권한은 요청하지 않습니다.
          </p>
        </div>
      </div>
    </main>
  );
}
