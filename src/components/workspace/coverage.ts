import type { AnalysisCoverage } from "@/hooks/use-analysis-stream";

/**
 * What to say when the model did not open every file.
 *
 * **This is the sentence that keeps the product honest.** A map with few
 * connections because a budget stopped the model halfway looks exactly like a
 * map with few connections because there are few — and the person reading it
 * cannot open the code to tell which. Saying the second when the first is true
 * is the worst thing this product can do, so the fact goes on screen in the
 * user's own words rather than into a log nobody reads.
 *
 * Kept out of the components because it is the part that can actually be wrong:
 * a number attached to the wrong cause, or a cap described as a fault. Pure, and
 * tested next door.
 */

export type CoverageSentences = {
  /** The numbers, and nothing else. */
  said: string;
  /**
   * Why it stopped. A cap and a failure never share a sentence: one is a
   * decision we took to keep the run quick and cheap, the other is something
   * that went wrong and might be worth trying again.
   */
  because: string;
  /** The claim this whole thing exists to stop anyone making. */
  caution: string;
};

const ko = (value: number): string => value.toLocaleString("ko-KR");

/**
 * Two families, said differently on purpose.
 *
 * The budget lines name the reason for the budget, because "we stopped early"
 * with no reason reads as a fault. The failure lines say a thing went wrong and
 * do not pretend to know it will go right next time.
 */
const BECAUSE: Record<AnalysisCoverage["reason"], string> = {
  file_budget:
    "한 번에 살펴볼 파일 수를 미리 정해 두고 있어서, 거기까지만 봤어요. 빠르고 저렴하게 끝내려고 그어 둔 선이에요.",
  token_budget:
    "이번에 쓸 수 있는 분량을 다 써서 거기서 멈췄어요. 빠르고 저렴하게 끝내려고 그어 둔 선이에요.",
  llm_error:
    "중간에 모델 쪽에 문제가 생겨서 나머지는 열어 보지 못했어요. 한 번 더 읽으면 더 볼 수 있어요.",
  aborted: "분석이 중간에 멈춰서 나머지는 열어 보지 못했어요.",
};

/**
 * The shortfall in plain Korean, or nothing at all.
 *
 * Null for null — no model on this installation, or a run that opened
 * everything. Both are ordinary, and neither may be dressed up as a shortfall:
 * the parser half alone produces a smaller honest graph, and putting "0개
 * 열어 봤어요" over it would report a fault the user did not cause.
 *
 * Also null for a payload claiming nothing was missed. The pipeline does not
 * send those, and if one ever arrives the right answer is silence rather than a
 * warning about zero files.
 */
export function describeCoverage(
  coverage: AnalysisCoverage | null,
): CoverageSentences | null {
  if (!coverage) return null;
  if (coverage.notExamined <= 0) return null;

  const { examined, notExamined } = coverage;

  return {
    said:
      examined > 0
        ? `모델이 파일 ${ko(examined)}개를 열어 봤고, ${ko(notExamined)}개는 열어 보지 못했어요.`
        : `모델이 파일 ${ko(notExamined)}개를 하나도 열어 보지 못했어요.`,
    because: BECAUSE[coverage.reason],
    // The whole point, and the one line that must never be dropped for space:
    // the map cannot show the difference between a connection that is missing
    // and one nobody went looking for, so the words have to.
    caution:
      "그래서 열어 보지 못한 파일 안의 연결은 지도에 없어요. 연결이 없다는 뜻이 아니라, 아직 보지 못했다는 뜻이에요.",
  };
}
