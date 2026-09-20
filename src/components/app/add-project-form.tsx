"use client";

import { useActionState } from "react";

import { addProject, type AddProjectState } from "@/app/app/actions";

const INITIAL: AddProjectState = { status: "idle" };

export function AddProjectForm() {
  const [state, formAction, pending] = useActionState(addProject, INITIAL);

  return (
    <div>
      {/*
        Stacked at every width, where this used to go side by side from 640px
        up.

        `sm:` measures the VIEWPORT, and this form does not live in one: it
        lives in the dashboard's left column, which is `minmax(300px, 360px)`
        and is narrowest exactly when the viewport is widest enough to trigger
        the row. At 360px the button takes about 110 of them and the field is
        left with 190 to show
        `https://github.com/사용자이름/저장소이름` — a placeholder that is
        clipped mid-word on every screen the row layout was meant for. The
        column is narrow on purpose; the form stacks to fit it.
      */}
      <form action={formAction} className="flex flex-col gap-3">
        <input
          type="text"
          name="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://github.com/사용자이름/저장소이름"
          aria-label="GitHub 저장소 주소"
          className="hairline min-w-0 flex-1 rounded-xl bg-ink px-4 py-3 text-[15px] transition-colors placeholder:text-said-faint focus:border-edge-lit"
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

      {/*
        `bg-ink`, not `bg-ink-raised`. This panel is rendered inside the
        `AddProject` card, which is itself `ink-raised`, so its fill was exactly
        the colour already behind it and the only thing separating the outcome
        of the whole form from the form was a 1px line. Recessed to `ink` it
        becomes an object, and it matches the panel the upload tab shows at the
        same moment in the same place.
      */}
      {state.status === "ok" ? (
        <div role="status" className="hairline mt-4 rounded-xl bg-ink p-5">
          <p className="text-[15px] font-semibold">
            {state.displayName} 연결했어요
          </p>
          <p className="mt-2 text-[14px] leading-[1.75] text-said-soft">
            {state.summary}
          </p>
          {/* The numeral in the mono face, the sentence around it in the sans.
              `font-mono` is reserved in this product for Latin and numerals,
              where it means something; a Korean sentence set in it would fall
              back to whatever face the OS picks for Hangul. */}
          {state.fileCount > 0 ? (
            <p className="mt-2 text-[13px] text-said-faint">
              파일{" "}
              <span className="font-mono">
                {state.fileCount.toLocaleString("ko-KR")}
              </span>
              개를 찾았어요.
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
          <p className="rule-t mt-4 pt-3.5 text-[13px] leading-[1.7] text-said-faint">
            아직 코드를 읽지는 않았어요. “만들어 둔 지도”에서 이 프로젝트를 열고
            지도 그리기를 누르면 그때 읽어요.
          </p>
        </div>
      ) : null}
    </div>
  );
}
