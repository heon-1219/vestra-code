"use client";

import { useActionState } from "react";

import { addProject, type AddProjectState } from "@/app/app/actions";

const INITIAL: AddProjectState = { status: "idle" };

export function AddProjectForm() {
  const [state, formAction, pending] = useActionState(addProject, INITIAL);

  return (
    <div>
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          name="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://github.com/사용자이름/저장소이름"
          aria-label="GitHub 저장소 주소"
          className="min-w-0 flex-1 rounded-xl border border-edge bg-ink px-4 py-3 text-[15px] placeholder:text-said-faint focus:border-edge-lit"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-xl bg-paper px-6 py-3 text-[15px] font-semibold text-ink transition-colors hover:bg-lamp disabled:opacity-55"
        >
          {pending ? "확인하는 중…" : "연결하기"}
        </button>
      </form>

      {state.status === "error" ? (
        <p role="alert" className="mt-3 text-[14px] leading-[1.7] text-c4">
          {state.message}
        </p>
      ) : null}

      {state.status === "ok" ? (
        <div
          role="status"
          className="mt-4 rounded-xl border border-edge bg-ink-raised p-5"
        >
          <p className="text-[15px] font-semibold">
            {state.displayName} 연결했어요
          </p>
          <p className="mt-2 text-[14px] leading-[1.75] text-said-soft">
            {state.summary}
          </p>
          {state.fileCount > 0 ? (
            <p className="mt-2 text-[13px] text-said-faint">
              파일 {state.fileCount.toLocaleString("ko-KR")}개를 찾았어요.
            </p>
          ) : null}
          {/*
            The brief forbids presenting anything unfinished as if it worked.
            Connecting is not analysing, and saying so here is the difference
            between an honest empty state and a product that looks broken when
            the map does not appear. It now points at the button that does it —
            "다음에 들어옵니다" was true while the workspace did not exist, and
            became a false promise of a future release the day it shipped.
          */}
          <p className="mt-3 text-[13px] leading-[1.7] text-said-faint">
            아직 코드를 읽지는 않았어요. “만들어 둔 지도”에서 이 프로젝트를 열고
            지도 그리기를 누르면 그때 읽어요.
          </p>
        </div>
      ) : null}
    </div>
  );
}
