/**
 * What a person is told about the files the model was not asked about.
 *
 * Apart from `set-aside.ts` for one reason: that module reaches `ids.ts`, which
 * imports `node:crypto`, and this sentence has to be sayable in the browser
 * too — on the band over the map, from the counts the map already carries —
 * without a second copy of it drifting from the one the run ends with. So the
 * words live here, with no imports at all, and `set-aside.ts` re-exports them.
 */

/** Why a file was not read. None of these is a budget: nothing ran out, we chose. */
export type SetAsideReason = "tool_settings" | "generated" | "tests";

/** The order they are counted and said in, so a sentence reads the same twice. */
export const SET_ASIDE_REASONS: readonly SetAsideReason[] = [
  "tests",
  "generated",
  "tool_settings",
];

export type SetAsideCount = { reason: SetAsideReason; count: number };

/** Whether a stored value is one of the three reasons. Tolerant of any row. */
export function isSetAsideReason(value: unknown): value is SetAsideReason {
  return value === "tool_settings" || value === "generated" || value === "tests";
}

/** Counts by reason, in the fixed order, omitting reasons with none. */
export function countSetAside(
  tagged: ReadonlyMap<string, SetAsideReason>,
): SetAsideCount[] {
  return SET_ASIDE_REASONS.map((reason) => ({
    reason,
    count: [...tagged.values()].filter((value) => value === reason).length,
  })).filter((entry) => entry.count > 0);
}

/** What each reason is called in a sentence. Everyday words, not the folder names. */
const REASON_WORDS: Record<SetAsideReason, string> = {
  tests: "코드를 점검하는 테스트와 그 자료",
  generated: "프로그램이 자동으로 만든 파일",
  tool_settings: "편집기나 도우미 프로그램이 스스로 쓰는 설정",
};

/**
 * The sentence a person reads, or null when nothing was set aside.
 *
 * It has to say three things, and each is load-bearing. **How many, of what
 * kind** — a count with no kind is a shortfall with no cause. **That it was a
 * choice** — the budget sentences say "we stopped", and this must never be
 * read as one of them. **That the map still has them** — or it reads as the
 * very omission `set-aside.ts` forbids.
 *
 * And the last clause has to be true of the rows, not only of one run: Pass 2
 * clears any name or description an earlier run wrote on these files and
 * their pieces, and Pass 3 clears any sentence left on connections it no
 * longer asks about (D169). Without that, a file set aside today would keep a
 * model's sentence about code it has since stopped being — measured, 128 of
 * 128 such files on `vestra-code` did, until this was fixed.
 *
 * Composed by the product about its own behaviour, so it keeps to the words
 * the product may use of itself (no 실행, 추적, 실시간, and none of the graph
 * words), and `set-aside.test.ts` checks it.
 */
export function describeSetAside(counts: readonly SetAsideCount[]): string | null {
  const parts = counts
    .filter((entry) => entry.count > 0)
    .map((entry) => `${REASON_WORDS[entry.reason]} ${entry.count.toLocaleString("ko-KR")}개`);
  if (parts.length === 0) return null;
  return (
    `${parts.join(", ")}는 일부러 모델에게 보여 주지 않았어요. ` +
    "코드를 모르는 사람이 물어볼 일이 거의 없는 파일이라 빼 두었어요. " +
    "지도에는 그대로 있어요. 모델이 읽어야 알 수 있는 이름, 설명, 짐작한 연결만 없어요."
  );
}
