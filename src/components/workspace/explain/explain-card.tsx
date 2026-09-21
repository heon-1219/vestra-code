"use client";

import { useMemo } from "react";

import type { AskSession } from "@/lib/ask/session";
import { CERTAINTY_WORDS, KIND_WORDS, type GraphItem } from "@/lib/graph/view";
import type { Citation, Finding } from "@/qa";
import { deepSummaryAuthor, EXPLAIN_WORDS } from "@/qa/explain";
import { EXPLAIN_STARTED } from "@/hooks/use-explain";

import { displayNameOf } from "../map/render/paint";
import { CertaintyMark, displayName, ModelMark } from "../panel/connection-row";
import { Walk, Working } from "../panel/walk-view";
import {
  certaintySplit,
  membersSentence,
  usedBySentence,
  usesSentence,
  type KnownExplanation,
  type KnownRow,
  type KnownSide,
} from "./known";

/**
 * 설명하기, on screen.
 *
 * Two halves, and they are separated by **who wrote them**, which is the one
 * thing this card must never blur. What a model wrote — Pass 2's plain name and
 * sentence, the feature it was grouped under (and a feature's members), Pass
 * 3's purpose lines, and later the deep read's own paragraph — carries
 * `ModelMark` every time. What came off the map with no model asked carries
 * nothing, because that is this product's floor, and every connection says
 * 확실해요 or 짐작이에요 on its own.
 *
 * The cheap half renders in the same frame as the click (D155). The deep half
 * is a button, never the default: it costs the person a model's time and
 * tokens, and most of the time the first half already answered them.
 */

/** Said once, under the two halves, so the mark has a sentence behind it. */
export const EXPLAIN_SOURCES =
  "'모델이 쓴 말'이 붙은 줄은 모델이 코드를 보고 풀어 쓴 짐작이에요. 표시가 없는 줄은 모델 없이, 저희가 코드를 분석해서 그린 지도에서 바로 가져온 거예요.";

/**
 * The heading of the unmarked half.
 *
 * It said 저희가 코드를 읽고 센 것 — "we read the code and counted" — over lines
 * that were not all counts: `describe.ts`'s 안을 읽지 않은 파일이에요 is a line
 * about what we did *not* read (81 of 1,961 selections on this repository's
 * map, 42 of 44 on the one upload), and a feature's 기능 하나로 묶어 둔 것이에요
 * is a model's grouping. What every line under it shares is where it came
 * from: the map, with no model asked. The feature line has moved to the other
 * half (D164).
 */
export const FROM_THE_MAP = "모델 없이 지도에서 바로 가져온 것";

/** What the deep read's paragraph is headed with, by who wrote it. */
export const DEEP_BY_MODEL = "모델이 코드를 직접 읽고 쓴 말";
export const DEEP_BY_US = "저희가 남기는 말";

/**
 * The heading over the findings when the paragraph above them is ours.
 *
 * A finding's sentence is always the model's — the certainty word and the
 * citation under it are what the ledger checked — so when the paragraph is
 * replaced (for its vocabulary, or
 * because the read stopped short) the findings cannot sit under 저희가 남기는
 * 말 unmarked: by the card's own legend an unmarked line is the map's (D173).
 */
export const DEEP_FINDINGS_BY_MODEL = "모델이 코드를 읽고 찾은 것";

/** A feature with no plain name yet. Never its id, which is ours and means nothing. */
const UNNAMED_FEATURE = "이름을 아직 못 붙인 기능";

export const DEEP_OFFER =
  "모델이 이 곳의 코드를 직접 열어 읽고 다시 설명해요. 읽은 줄에 근거한 것만 확실해요라고 적어요.";

export function ExplainCard({
  known,
  deep,
  onDeep,
  deepRefusal,
  itemsById,
  onSelect,
  onOpen,
}: {
  known: KnownExplanation;
  /** The deep read for this item, when one has been asked for. */
  deep: AskSession | null;
  /** Start the deep read. Undefined when it cannot run here. */
  onDeep?: () => void;
  /** Why it cannot, when it cannot. Said instead of a dead button. */
  deepRefusal: string | null;
  itemsById: ReadonlyMap<string, GraphItem>;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
}) {
  const { item, measured, written } = known;
  const isFeature = item.kind === "feature";
  const hasWritten = Boolean(written.label || written.summary || written.feature || written.members);
  const title = isFeature ? (item.label ?? UNNAMED_FEATURE) : displayName(item);

  return (
    <section aria-label="설명" className="hairline rounded-xl bg-ink px-4 py-4">
      <p className="label-kr text-[11px] text-said-faint">
        {KIND_WORDS[item.kind]} 설명
      </p>
      <h3 className="display-kr mt-1 break-words text-[17px] text-said">{title}</h3>

      {hasWritten ? (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 text-[11px] text-said-faint">
            <ModelMark />
            <span>모델이 코드를 보고 풀어 쓴 말</span>
          </p>
          {written.label && !isFeature ? (
            <p className="mt-1.5 text-[13px] leading-[1.75] text-said-soft text-pretty">
              쉬운 이름: <span className="text-said">{written.label}</span>
              {/*
                A file's code name is its path, which is printed just below. A
                feature has no code name at all — `feature:1c8e949eccd7` is our
                id for a grouping, and it was on screen as though it were one.
              */}
              {item.name !== item.path ? (
                <>
                  <span className="text-said-faint"> · 코드 이름: </span>
                  <code className="break-all text-[12px] text-said-faint">{item.name}</code>
                </>
              ) : null}
            </p>
          ) : null}
          {written.summary ? (
            <p className="mt-1.5 text-[14px] leading-[1.85] text-said text-pretty">{written.summary}</p>
          ) : null}
          {written.feature ? (
            <p className="mt-1.5 text-[12px] leading-[1.7] text-said-soft text-pretty">
              ‘{written.feature.label ?? UNNAMED_FEATURE}’ 기능으로 묶어 뒀어요.
            </p>
          ) : null}
          {written.members ? (
            <Side
              title="이 기능으로 묶은 것"
              sentence={membersSentence(written.members)}
              side={written.members}
              onSelect={onSelect}
            />
          ) : null}
        </div>
      ) : null}

      {/*
        A feature has nothing in this half: every line the map holds about one
        is a model's grouping, and it is all above, marked.
      */}
      {isFeature ? null : (
        <div className={hasWritten ? "rule-t mt-4 pt-3" : "mt-3"}>
          <p className="text-[11px] text-said-faint">{FROM_THE_MAP}</p>
          <p className="mt-1.5 text-[14px] leading-[1.8] text-said text-pretty">{measured.line}</p>
          {/*
            Where it is written, by path and lines — the code's own words. The
            home file used to be named here too, by its Pass 2 label and with no
            mark; the path already says which file, without a model's help.
          */}
          {item.path ? (
            <p className="mt-1 break-all font-mono text-[11px] leading-[1.7] text-said-faint">
              {item.path}
              {item.startLine !== null
                ? ` · ${item.startLine}–${item.endLine ?? item.startLine}줄`
                : ""}
            </p>
          ) : null}

          <Side
            title="어디서 쓰이나요"
            sentence={usedBySentence(measured.usedBy)}
            side={measured.usedBy}
            onSelect={onSelect}
          />
          <Side
            title="무엇을 가져다 쓰나요"
            sentence={usesSentence(measured.uses)}
            side={measured.uses}
            onSelect={onSelect}
          />
        </div>
      )}

      <p className="mt-4 text-[11px] leading-[1.7] text-said-faint text-pretty">{EXPLAIN_SOURCES}</p>

      <div className="rule-t mt-4 pt-3">
        {deep ? (
          <DeepRead session={deep} itemsById={itemsById} onSelect={onSelect} onOpen={onOpen} onAgain={onDeep} />
        ) : onDeep ? (
          <>
            <button
              type="button"
              onClick={onDeep}
              className="flex min-h-11 items-center rounded-lg border border-edge-lit px-3 text-[13px] text-said-soft transition-colors hover:border-said-faint hover:bg-ink-raised hover:text-said md:min-h-9"
            >
              코드를 직접 읽고 더 알아보기
            </button>
            <p className="mt-2 text-[12px] leading-[1.7] text-said-faint text-pretty">{DEEP_OFFER}</p>
          </>
        ) : deepRefusal ? (
          <p className="text-[12px] leading-[1.7] text-said-faint text-pretty">{deepRefusal}</p>
        ) : null}
      </div>
    </section>
  );
}

function Side({
  title,
  sentence,
  side,
  onSelect,
}: {
  title: string;
  sentence: string;
  side: KnownSide;
  onSelect: (id: string) => void;
}) {
  const split = certaintySplit(side);
  const more = side.total - side.rows.length;
  return (
    <div className="mt-3">
      <p className="label-kr text-[11px] text-said-faint">{title}</p>
      <p className="mt-1 text-[13px] leading-[1.7] text-said-soft tabular-nums text-pretty">
        {sentence}
        {split ? <span className="text-said-faint"> {split}</span> : null}
      </p>
      {side.rows.length > 0 ? (
        <ul className="mt-1">
          {side.rows.map((row) => (
            <Row key={row.item.id} row={row} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
      {more > 0 ? (
        <p className="mt-1 text-[11px] text-said-faint tabular-nums">
          이 밖에 {more.toLocaleString("ko-KR")}개가 더 있어요.
        </p>
      ) : null}
    </div>
  );
}

function Row({ row, onSelect }: { row: KnownRow; onSelect: (id: string) => void }) {
  const name = displayName(row.item);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(row.item.id)}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-ink-raised max-md:min-h-11"
      >
        <CertaintyMark certainty={row.certainty} className="mt-[7px] h-[13px] w-[3px] shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="min-w-0 truncate text-[13px] text-said">
              {row.item.label ? name : <code className="text-[12px]">{name}</code>}
            </span>
            <span className="text-[12px] text-said-soft">{row.verb}</span>
            <span className="text-[11px] text-said-faint">{CERTAINTY_WORDS[row.certainty]}</span>
          </span>
          {row.purpose ? (
            <span className="mt-0.5 flex items-baseline gap-1.5 text-[12px] leading-[1.7] text-said-soft text-pretty">
              <ModelMark />
              <span className="min-w-0">{row.purpose}</span>
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------ deep read */

function DeepRead({
  session,
  itemsById,
  onSelect,
  onOpen,
  onAgain,
}: {
  session: AskSession;
  itemsById: ReadonlyMap<string, GraphItem>;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
  onAgain?: () => void;
}) {
  const nameOf = (id: string) => {
    const item = itemsById.get(id);
    return item ? displayNameOf(item) : null;
  };

  // A citation is a path and a line, and the preview opens items. The smallest
  // item on that path whose lines hold the citation, or the file itself.
  const byPath = useMemo(() => {
    const out = new Map<string, GraphItem[]>();
    for (const item of itemsById.values()) {
      if (!item.path) continue;
      const list = out.get(item.path);
      if (list) list.push(item);
      else out.set(item.path, [item]);
    }
    return out;
  }, [itemsById]);

  const target = (citation: Citation): string | null => {
    const candidates = byPath.get(citation.path) ?? [];
    let best: GraphItem | null = null;
    for (const item of candidates) {
      if (item.startLine === null) {
        best ??= item;
        continue;
      }
      const end = item.endLine ?? item.startLine;
      if (item.startLine <= citation.startLine && citation.startLine <= end) {
        const span = end - item.startLine;
        const bestSpan =
          best && best.startLine !== null ? (best.endLine ?? best.startLine) - best.startLine : Infinity;
        if (span < bestSpan) best = item;
      }
    }
    return best?.id ?? null;
  };

  const answer = session.answer;
  const seconds = answer?.spent ? Math.max(1, Math.round(answer.spent.millis / 1000)) : null;
  /*
   * Counted from the steps that arrived, not from `spent.steps`, which also
   * counts a model call that failed and was tried again. Seen live when the
   * provider refused every call: "1초 동안 2번 살펴봤어요" over a read that had
   * opened nothing.
   */
  const looked = session.steps.length;
  const author = answer ? deepSummaryAuthor(answer) : null;
  /*
   * A refusal that will say the same thing next time — no files kept, no
   * model, nothing to read — gets no "다시 읽어 보기" and no "읽어 볼게요" above
   * it. Measured on the one uploaded project in production: it kept no files,
   * and the card read "I will open the code" over "we cannot open the code",
   * with a retry button under both.
   */
  const permanent =
    session.status === "failed" &&
    (Object.values(EXPLAIN_WORDS) as string[]).includes(session.error ?? "");
  /*
   * "코드를 직접 열어서 읽어 볼게요" is a promise, so it is shown while the read
   * is being made and not after: it stood above a finished read, and above
   * "읽는 도중에 모델과 연결이 끊겼어요", promising a read that had already
   * ended. A question the person typed is theirs and stays, whatever happened.
   */
  const promise = session.question === EXPLAIN_STARTED;
  const showQuestion = !permanent && (!promise || session.status === "asking");

  return (
    <div aria-live="polite">
      {showQuestion ? (
        <p className="text-[12px] leading-[1.7] text-said-faint text-pretty">{session.question}</p>
      ) : null}

      {session.status === "failed" ? (
        <p className="mt-2 text-[13px] leading-[1.8] text-said text-pretty">{session.error}</p>
      ) : null}

      {answer ? (
        <div className="mt-2">
          {/*
            Who wrote the paragraph, and it is not always the model. When the
            read stopped short — a refused call, a spent budget, a report whose
            every claim failed its citation check — the paragraph is one of the
            loop's own sentences, and marking it 모델이 쓴 말 put our words in a
            model's mouth.
          */}
          {author === "model" ? (
            <p className="flex items-baseline gap-1.5 text-[11px] text-said-faint">
              <ModelMark />
              <span>{DEEP_BY_MODEL}</span>
            </p>
          ) : (
            <p className="text-[11px] text-said-faint">{DEEP_BY_US}</p>
          )}
          <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-[1.85] text-said">
            {answer.summary}
          </p>
          {answer.findings.length > 0 && author !== "model" ? (
            <p className="mt-3 flex items-baseline gap-1.5 text-[11px] text-said-faint text-pretty">
              <ModelMark />
              <span>{DEEP_FINDINGS_BY_MODEL}</span>
            </p>
          ) : null}
          {answer.findings.length > 0 ? (
            <ul className="mt-3 space-y-2.5">
              {answer.findings.map((finding, index) => (
                <FindingRow
                  key={index}
                  finding={finding}
                  onOpen={onOpen ? (citation) => {
                    const id = target(citation);
                    if (id) onOpen(id);
                  } : undefined}
                />
              ))}
            </ul>
          ) : null}
          {seconds !== null && looked > 0 ? (
            <p className="mt-3 text-[11px] text-said-faint tabular-nums">
              {seconds.toLocaleString("ko-KR")}초 동안 {looked.toLocaleString("ko-KR")}번 살펴봤어요.
            </p>
          ) : null}
        </div>
      ) : null}

      {session.trail ? (
        <Walk session={session} nameOf={nameOf} onSelect={onSelect} />
      ) : session.status === "asking" ? (
        <Working session={session} />
      ) : null}

      {session.refused.length > 0 ? (
        <p className="mt-3 text-[12px] leading-[1.7] text-said-faint tabular-nums text-pretty">
          근거를 찾지 못해서 빼놓은 이야기가 {session.refused.length}가지 있어요.
        </p>
      ) : null}

      {session.status !== "asking" && onAgain && !permanent ? (
        <button
          type="button"
          onClick={onAgain}
          className="mt-3 flex min-h-11 items-center rounded-lg px-1 text-[12px] text-said-faint transition-colors hover:text-said-soft md:min-h-0"
        >
          다시 읽어 보기
        </button>
      ) : null}
    </div>
  );
}

function FindingRow({
  finding,
  onOpen,
}: {
  finding: Finding;
  onOpen?: (citation: Citation) => void;
}) {
  return (
    <li className="flex gap-2">
      <CertaintyMark certainty={finding.certainty} className="mt-[7px] h-[13px] w-[3px] shrink-0" />
      <span className="min-w-0">
        <span className="block text-[13px] leading-[1.75] text-said-soft text-pretty">{finding.claim}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] text-said">{CERTAINTY_WORDS[finding.certainty]}</span>
          {finding.citations.map((citation) => {
            const text = `${citation.path} ${citation.startLine}–${citation.endLine}줄`;
            return onOpen ? (
              <button
                key={text}
                type="button"
                onClick={() => onOpen(citation)}
                className="inline-flex min-h-11 items-center break-all text-left font-mono text-[11px] text-said-faint underline decoration-edge-lit underline-offset-2 transition-colors hover:text-lamp md:min-h-0"
              >
                {text}
              </button>
            ) : (
              <span key={text} className="break-all font-mono text-[11px] text-said-faint">
                {text}
              </span>
            );
          })}
        </span>
      </span>
    </li>
  );
}
