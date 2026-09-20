import { describe, expect, it } from "vitest";

import {
  checkFindings,
  coverageOf,
  forbiddenWordsIn,
  hedgesIn,
  reportSchema,
} from "./answer";
import type { LedgerEntry } from "./tools";
import type { Finding } from "./types";

/**
 * The gate. Everything here is a way an unchecked claim could reach a person
 * who cannot check it themselves.
 */

const READ: LedgerEntry = {
  path: "src/lib/format.ts",
  startLine: 3,
  endLine: 8,
  read: true,
};

/** What `open_item` puts on the record: we know where it lives, we did not look. */
const SEEN: LedgerEntry = {
  path: "src/components/PayButton.tsx",
  startLine: 5,
  endLine: 18,
  read: false,
};

function finding(partial: Partial<Finding>): Finding {
  return {
    claim: "가격을 만드는 곳이 여기예요.",
    certainty: "inferred",
    citations: [{ path: "src/lib/format.ts", startLine: 7, endLine: 7 }],
    ...partial,
  };
}

describe("reportSchema", () => {
  it("has exactly two words for how sure we are", () => {
    // The enum is where the softer third word dies. A model asked for a
    // confidence label will happily write "likely"; the product has 확실해요
    // and 짐작이에요 and nothing between them.
    const parsed = reportSchema.safeParse({
      answer: "여기예요.",
      findings: [{ ...finding({}), certainty: "likely" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("will not take a claim with nowhere attached to it", () => {
    const parsed = reportSchema.safeParse({
      answer: "여기예요.",
      findings: [{ claim: "여기가 원인이에요.", certainty: "certain", citations: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a range that runs backwards", () => {
    const parsed = reportSchema.safeParse({
      answer: "여기예요.",
      findings: [
        finding({ citations: [{ path: "a.ts", startLine: 90, endLine: 12 }] }),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a report that found nothing", () => {
    // "I found nothing" is a legitimate answer, and rejecting it would spend a
    // step teaching the model to invent a finding.
    const parsed = reportSchema.safeParse({ answer: "원인을 찾지 못했어요." });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.findings).toEqual([]);
  });

  it("takes line numbers that arrived as strings", () => {
    // Models send `"3"` for a line number more often than not, and refusing it
    // would spend one of twelve steps on punctuation. The bounds are what
    // actually protect us and they are checked either way.
    const parsed = reportSchema.safeParse({
      answer: "여기예요.",
      findings: [
        {
          claim: "여기예요.",
          certainty: "inferred",
          citations: [{ path: "a.ts", startLine: "3", endLine: "9" }],
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findings[0].citations[0].startLine).toBe(3);
    }
  });
});

describe("coverageOf", () => {
  it("wants containment, never overlap", () => {
    // A model that read 3–8 and cites 3–200 has told us about 192 lines it
    // never saw, and an overlap test would let that through on the strength of
    // the six it did.
    expect(
      coverageOf({ path: "src/lib/format.ts", startLine: 3, endLine: 200 }, [READ]),
    ).toEqual({ covered: false, read: false });
    expect(
      coverageOf({ path: "src/lib/format.ts", startLine: 4, endLine: 6 }, [READ]),
    ).toEqual({ covered: true, read: true });
  });

  it("separates having read a place from having been told about it", () => {
    expect(
      coverageOf({ path: "src/components/PayButton.tsx", startLine: 9, endLine: 9 }, [
        SEEN,
      ]),
    ).toEqual({ covered: true, read: false });
  });

  it("matches a path however the model spelled it", () => {
    expect(
      coverageOf({ path: "./src/lib/format.ts", startLine: 7, endLine: 7 }, [READ]),
    ).toEqual({ covered: true, read: true });
  });
});

describe("checkFindings", () => {
  it("keeps a claim about lines that were actually read", () => {
    const { kept, refused } = checkFindings(
      [finding({ certainty: "certain" })],
      [READ],
    );
    expect(kept).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it("refuses a claim about somewhere this investigation never went", () => {
    const { kept, refused } = checkFindings(
      [finding({ citations: [{ path: "src/app/page.tsx", startLine: 1, endLine: 2 }] })],
      [READ],
    );
    expect(kept).toEqual([]);
    expect(refused[0].reason).toBe("unread_citation");
  });

  it("refuses `certain` for a place we only heard about", () => {
    // This is the distinction the whole answer rests on. Knowing PayButton
    // lives at lines 5–18 is not the same as having read them.
    const { kept, refused } = checkFindings(
      [
        finding({
          certainty: "certain",
          citations: [{ path: "src/components/PayButton.tsx", startLine: 9, endLine: 9 }],
        }),
      ],
      [SEEN],
    );
    expect(kept).toEqual([]);
    expect(refused[0].reason).toBe("certain_without_reading");
  });

  it("allows the same claim as a guess", () => {
    const { kept } = checkFindings(
      [
        finding({
          certainty: "inferred",
          citations: [{ path: "src/components/PayButton.tsx", startLine: 9, endLine: 9 }],
        }),
      ],
      [SEEN],
    );
    expect(kept).toHaveLength(1);
  });

  it("needs every citation read before a claim may be `certain`", () => {
    const { refused } = checkFindings(
      [
        finding({
          certainty: "certain",
          citations: [
            { path: "src/lib/format.ts", startLine: 7, endLine: 7 },
            { path: "src/components/PayButton.tsx", startLine: 9, endLine: 9 },
          ],
        }),
      ],
      [READ, SEEN],
    );
    // One read line and one guessed one is a claim that was half checked, which
    // is what `inferred` is for.
    expect(refused[0].reason).toBe("certain_without_reading");
  });

  it("refuses the word this product does not say", () => {
    const { refused } = checkFindings(
      [finding({ claim: "이 파일은 고쳐도 안전해요." })],
      [READ],
    );
    expect(refused[0].reason).toBe("forbidden_words");
  });

  it("refuses a `certain` claim that hedges in the same sentence", () => {
    const { refused } = checkFindings(
      [finding({ certainty: "certain", claim: "아마 여기가 원인인 것 같아요." })],
      [READ],
    );
    expect(refused[0].reason).toBe("hedged_certainty");
  });

  it("lets a guess hedge, because that is what a guess is", () => {
    const { kept } = checkFindings(
      [finding({ certainty: "inferred", claim: "여기가 원인인 것 같아요." })],
      [READ],
    );
    expect(kept).toHaveLength(1);
  });

  it("normalises the path it keeps, so it matches the map", () => {
    const { kept } = checkFindings(
      [finding({ citations: [{ path: "./src/lib/format.ts", startLine: 7, endLine: 7 }] })],
      [READ],
    );
    expect(kept[0].citations[0].path).toBe("src/lib/format.ts");
  });
});

describe("the words", () => {
  it("catches 안전 and the graph vocabulary the user has never seen", () => {
    expect(forbiddenWordsIn("여기는 안전해요")).toContain("안전");
    expect(forbiddenWordsIn("이 노드가 원인이에요")).toContain("노드");
    expect(forbiddenWordsIn("가격을 만드는 곳이 여기예요")).toEqual([]);
  });

  it("does not mistake 똑같아요 for a hedge", () => {
    // Refusing a checked claim over a false match loses as much as passing an
    // unchecked one on.
    expect(hedgesIn("두 값이 똑같아요")).toEqual([]);
    expect(hedgesIn("여기가 원인인 것 같아요")).toContain("것 같");
  });
});
