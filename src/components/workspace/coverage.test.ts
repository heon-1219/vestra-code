import { describe, expect, it } from "vitest";

import type { AnalysisCoverage } from "@/hooks/use-analysis-stream";

import { describeCoverage } from "./coverage";

/**
 * The sentence that stops the worst claim this product can make.
 *
 * What can be wrong here is not a crash. It is a run that opened 40 of 120
 * files being described in words that let someone conclude there is nothing in
 * the other 80 — or a project with no model at all being told it fell short of
 * something. Both are silent, and neither is visible to a person who cannot
 * read the code.
 */

const coverage = (overrides: Partial<AnalysisCoverage> = {}): AnalysisCoverage => ({
  examined: 40,
  notExamined: 80,
  reason: "file_budget",
  ...overrides,
});

describe("when there is nothing to say", () => {
  it("says nothing at all for a run with no coverage to report", () => {
    // No model on this installation: the parser half ran alone and produced a
    // smaller honest graph. That is not a shortfall and must not be drawn as
    // one.
    expect(describeCoverage(null)).toBeNull();
  });

  it("says nothing when every file was opened", () => {
    expect(describeCoverage(coverage({ examined: 120, notExamined: 0 }))).toBeNull();
  });
});

describe("the numbers", () => {
  it("gives both counts, so neither has to be worked out", () => {
    const said = describeCoverage(coverage())?.said ?? "";

    expect(said).toContain("40");
    expect(said).toContain("80");
  });

  it("groups thousands the way the rest of the screen does", () => {
    const said = describeCoverage(coverage({ examined: 1200, notExamined: 4300 }))?.said;

    expect(said).toContain("1,200");
    expect(said).toContain("4,300");
  });

  it("does not say it opened zero files, it says it opened none", () => {
    // "파일 0개를 열어 봤고" is a sentence about a number. A person reading their
    // own project deserves the plain version of the same fact.
    const said = describeCoverage(coverage({ examined: 0, notExamined: 120 }))?.said ?? "";

    expect(said).not.toContain("0개를 열어 봤");
    expect(said).toContain("120");
  });
});

describe("why it stopped", () => {
  it("never calls a budget a problem", () => {
    // The two families the brief refuses to collapse: a cap is a decision we
    // took to keep this quick and cheap, and telling someone something went
    // wrong sends them looking for a fault that does not exist.
    for (const reason of ["file_budget", "token_budget"] as const) {
      const because = describeCoverage(coverage({ reason }))?.because ?? "";
      expect(because).not.toContain("문제");
      expect(because).toContain("빠르고 저렴하게");
    }
  });

  it("says plainly that something went wrong when something did", () => {
    const because = describeCoverage(coverage({ reason: "llm_error" }))?.because ?? "";

    expect(because).toContain("문제");
    expect(because).not.toContain("빠르고 저렴하게");
  });

  it("tells a run that was stopped apart from one that failed", () => {
    const aborted = describeCoverage(coverage({ reason: "aborted" }))?.because;
    const failed = describeCoverage(coverage({ reason: "llm_error" }))?.because;

    expect(aborted).not.toBe(failed);
  });

  it("has a sentence for every reason the stream can carry", () => {
    const reasons = ["file_budget", "token_budget", "llm_error", "aborted"] as const;

    for (const reason of reasons) {
      const because = describeCoverage(coverage({ reason }))?.because ?? "";
      expect(because.length).toBeGreaterThan(0);
    }
  });
});

describe("the claim this exists to prevent", () => {
  it("always says that missing is not the same as absent", () => {
    const reasons = ["file_budget", "token_budget", "llm_error", "aborted"] as const;

    for (const reason of reasons) {
      const caution = describeCoverage(coverage({ reason }))?.caution ?? "";
      // The one sentence that may never be dropped, whatever stopped the run.
      expect(caution).toContain("연결이 없다는 뜻이 아니라");
    }
  });

  it("never uses the words the product is not allowed to use", () => {
    const sentences = describeCoverage(coverage());
    const all = `${sentences?.said} ${sentences?.because} ${sentences?.caution}`;

    for (const banned of ["노드", "엣지", "온톨로지", "안전"]) {
      expect(all).not.toContain(banned);
    }
  });
});
