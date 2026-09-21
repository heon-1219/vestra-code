"use client";

import { useRef, useState } from "react";

import type { GraphItem } from "@/lib/graph/view";
import { PLACES_SHOWN, type SharedScope } from "@/lib/prompt/build";
import type { PromptPhase } from "@/hooks/use-prompt";

import { displayName, ModelMark } from "../panel/connection-row";

/**
 * What 프롬프트 만들기 shows, from the question it has to ask first to the
 * prompt it hands over.
 *
 * The person reads one plain sentence — "결제 화면의 결제 버튼만 바꾸라고
 * 적었어요" — and the prompt itself sits behind 프롬프트 보기 with a copy button,
 * which is §3's state table for this mode. The order on the card is the order
 * of what a person needs: what we wrote on their behalf, then who wrote the
 * goal line, then the button that does the thing, then the text if they want to
 * check it.
 */

/* ---------------------------------------------------------------- scope */

/**
 * "Only here, or everywhere?" — asked before a word is generated (§6.4).
 *
 * Each place is its own button rather than a pair of 여기서만 / 모든 곳에서,
 * because on this map "here" is not implied: the person selected the piece
 * itself, and "only here" only means something once they have said which of
 * its screens they mean. Pages come first, because a page is what a person
 * means by "a screen".
 */
export function ScopeQuestion({
  subject,
  places,
  onChoose,
  onCancel,
}: {
  subject: GraphItem | null;
  places: readonly GraphItem[];
  onChoose: (scope: SharedScope) => void;
  onCancel: () => void;
}) {
  const shown = places.slice(0, PLACES_SHOWN);
  const more = places.length - shown.length;
  const name = subject ? displayName(subject) : "고른 곳";

  return (
    <section
      aria-label="바꿀 범위 고르기"
      className="hairline rounded-xl bg-ink px-4 py-4"
    >
      <p className="label-kr text-[11px] text-said-faint">먼저 하나만 여쭤볼게요</p>
      <p className="mt-1.5 text-[14px] leading-[1.8] text-said tabular-nums text-pretty">
        {scopeSentence(name, places.length)}
      </p>

      <div className="mt-3 flex flex-col gap-1.5">
        <ChoiceButton primary onClick={() => onChoose({ kind: "everywhere" })}>
          쓰이는 {places.length.toLocaleString("ko-KR")}곳 모두에서
        </ChoiceButton>
        {shown.map((place) => (
          <ChoiceButton key={place.id} onClick={() => onChoose({ kind: "only_here", placeId: place.id })}>
            <span className="min-w-0 truncate">{displayName(place)}</span>
            <span className="shrink-0">에서만</span>
          </ChoiceButton>
        ))}
      </div>

      {more > 0 ? (
        <p className="mt-2 text-[12px] leading-[1.7] text-said-faint tabular-nums text-pretty">
          이 밖에 {more.toLocaleString("ko-KR")}곳이 더 있어요. 그중 한 곳에서만 바꾸려면, 지도에서
          그 곳을 골라서 다시 적어 주세요.
        </p>
      ) : null}

      <p className="mt-2 text-[12px] leading-[1.7] text-said-faint text-pretty">
        한 곳을 고르면 이번 프롬프트에서는 그 곳도 같이 고쳐도 되게 열어 둘게요.
      </p>

      <button
        type="button"
        onClick={onCancel}
        className="mt-2 flex min-h-11 items-center rounded-lg px-1 text-[13px] text-said-faint transition-colors hover:text-said-soft md:min-h-0 md:py-1"
      >
        그만두기
      </button>
    </section>
  );
}

/**
 * The question itself, about where the change should *apply*.
 *
 * It asked "바꾼 게 어디에 보이면 좋을까요?" — where should it be seen — which
 * is the right question for a component two screens render and the wrong one
 * for most of what is asked it: of the 379 selections on this repository's map
 * that get the question, 243 are functions, whose callers show nothing. A
 * function's two callers are still two places a change lands, so the question
 * stays and its words change (D163).
 */
export function scopeSentence(name: string, count: number): string {
  return `${name} — 쓰이는 곳이 ${count.toLocaleString("ko-KR")}곳이에요. 모든 곳에서 함께 바꿀까요, 한 곳에서만 달라지게 할까요?`;
}

function ChoiceButton({
  primary = false,
  onClick,
  children,
}: {
  primary?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-11 w-full min-w-0 items-center gap-0.5 rounded-lg border px-3 text-left text-[13px] transition-colors md:min-h-9 ${
        primary
          ? "border-lamp-dim bg-lamp/10 text-lamp hover:bg-lamp/15"
          : "border-edge-lit text-said-soft hover:border-said-faint hover:bg-ink-raised hover:text-said"
      }`}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- card */

export function PromptCard({ phase }: { phase: Exclude<PromptPhase, { status: "choosing" }> }) {
  if (phase.status === "writing") {
    return (
      <section aria-live="polite" className="hairline rounded-xl bg-ink px-4 py-4">
        <p className="text-[13px] leading-[1.7] text-said-soft text-pretty">
          &ldquo;{phase.request}&rdquo;
        </p>
        <p className="mt-2 text-[13px] text-said-faint">
          <span className="animate-pulse">적어 주신 말을 정리하고 있어요…</span>
        </p>
      </section>
    );
  }
  return <ReadyCard phase={phase} />;
}

function ReadyCard({ phase }: { phase: Extract<PromptPhase, { status: "ready" }> }) {
  const [copied, setCopied] = useState<"idle" | "done" | "refused">("idle");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const { built } = phase;

  async function copy() {
    try {
      await navigator.clipboard.writeText(built.promptText);
      setCopied("done");
      window.setTimeout(() => setCopied("idle"), 2000);
    } catch {
      /*
       * Clipboard permission can be refused, and on some phones it is by
       * default. The text is behind the toggle either way, so the toggle is
       * opened and the person is told to take it from there — not left with a
       * button that silently did nothing.
       */
      setCopied("refused");
      if (detailsRef.current) detailsRef.current.open = true;
    }
  }

  return (
    <section aria-label="만든 프롬프트" className="hairline rounded-xl bg-ink px-4 py-4">
      <p className="text-[14px] leading-[1.85] text-said text-pretty">{built.confirmationText}</p>

      {/*
        Who wrote the goal line, said every time. A restated goal is a model's
        sentence in the person's name, so it carries the same mark every model
        sentence on this screen carries — and when there is no restatement, the
        card says why the goal is their own words instead.
      */}
      {phase.goal ? (
        <p className="mt-2 flex items-baseline gap-1.5 text-[12px] leading-[1.7] text-said-soft text-pretty">
          <ModelMark />
          <span className="min-w-0">목표: {phase.goal}</span>
        </p>
      ) : phase.note ? (
        <p className="mt-2 text-[12px] leading-[1.7] text-said-faint text-pretty">{phase.note}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="flex min-h-11 items-center rounded-lg bg-paper px-4 text-[13px] font-semibold text-ink transition duration-150 hover:bg-lamp active:scale-[0.98] md:min-h-9"
        >
          {copied === "done" ? "복사했어요" : "프롬프트 복사하기"}
        </button>
        <span className="text-[12px] text-said-faint">
          코딩 도우미에게 그대로 붙여 넣으면 돼요.
        </span>
      </div>
      {copied === "refused" ? (
        <p role="status" className="mt-2 text-[12px] leading-[1.7] text-c4 text-pretty">
          복사하지 못했어요. 아래 글을 길게 눌러 직접 복사해 주세요.
        </p>
      ) : null}

      <details ref={detailsRef} className="mt-3">
        {/*
          Not `flex`: a <summary> that stops being `list-item` loses its
          disclosure triangle, and the triangle is the only thing saying this
          line opens. The 44px comes from padding instead.
        */}
        <summary className="min-h-11 cursor-pointer py-3 text-[13px] text-said-faint hover:text-said-soft md:min-h-0 md:py-0">
          프롬프트 보기
        </summary>
        <pre className="hairline mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink-sunk p-3 font-mono text-[11px] leading-[1.7] text-said-soft [scrollbar-color:var(--color-edge-lit)_transparent] [scrollbar-width:thin]">
          {built.promptText}
        </pre>
      </details>
    </section>
  );
}
