import { describe, expect, it } from "vitest";

import { FLOW_FORBIDDEN_WORDS } from "@/lib/graph/flow";

import { noDrops } from "../semantic/parse";
import { FLOW_FORBIDDEN_EXTRA, FORBIDDEN_WORDS } from "../semantic/words";

import { cleanPurpose, MAX_PURPOSE_CHARS, parsePurposeReply } from "./parse";

const ALLOWED = new Set([0, 1, 2]);

function parse(body: unknown) {
  const drops = noDrops();
  const result = parsePurposeReply(JSON.stringify(body), ALLOWED, drops);
  return { items: result.items, drops };
}

describe("reading what the model said about a connection", () => {
  it("keeps a sentence that is Korean, 해요체 and short", () => {
    const { items } = parse({
      items: [{ i: 1, why: "여기서 가격을 사람이 읽기 좋은 모양으로 바꿔요." }],
    });
    expect(items).toEqual([
      { index: 1, sentence: "여기서 가격을 사람이 읽기 좋은 모양으로 바꿔요." },
    ]);
  });

  it("refuses a number nobody sent", () => {
    const { items, drops } = parse({ items: [{ i: 99, why: "여기서 값을 바꿔요." }] });
    expect(items).toHaveLength(0);
    expect(drops.unknown_index).toBe(1);
  });

  it("takes the first answer when the model answers twice, not the last", () => {
    const { items, drops } = parse({
      items: [
        { i: 1, why: "여기서 값을 바꿔요." },
        { i: 1, why: "여기서 값을 지워요." },
      ],
    });
    expect(items).toEqual([{ index: 1, sentence: "여기서 값을 바꿔요." }]);
    expect(drops.duplicate).toBe(1);
  });

  it("throws away a reply it cannot read at all", () => {
    const drops = noDrops();
    expect(parsePurposeReply("설명을 드릴게요.", ALLOWED, drops).items).toHaveLength(0);
    expect(drops.unreadable_reply).toBe(1);
  });

  it("reads JSON out of a fenced block, because only some endpoints are held to the schema", () => {
    const drops = noDrops();
    const text = '```json\n{"items":[{"i":0,"why":"여기서 값을 바꿔요."}]}\n```';
    expect(parsePurposeReply(text, ALLOWED, drops).items).toHaveLength(1);
  });
});

describe("the checks, each of which drops rather than repairs", () => {
  const drop = (raw: string) => {
    const drops = noDrops();
    return { text: cleanPurpose(raw, drops), drops };
  };

  it("refuses English, because no English reaches a user", () => {
    const { text, drops } = drop("Formats the price for display.");
    expect(text).toBeNull();
    expect(drops.not_korean).toBe(1);
  });

  it("refuses 합니다체, because every sentence in this product is 해요체", () => {
    const { text, drops } = drop("여기서 가격을 바꿉니다.");
    expect(text).toBeNull();
    expect(drops.not_haeyoche).toBe(1);
  });

  it("refuses a bare noun phrase for the same reason", () => {
    expect(drop("가격을 바꾸는 곳").text).toBeNull();
  });

  it("refuses the three words Pass 2 refuses", () => {
    for (const word of FORBIDDEN_WORDS) {
      const { text, drops } = drop(`여기서 ${word} 관련된 일을 해요.`);
      expect(text, word).toBeNull();
      expect(drops.forbidden_word, word).toBe(1);
    }
  });

  it("refuses the three words a flow sentence refuses (D78)", () => {
    for (const word of FLOW_FORBIDDEN_EXTRA) {
      const { text, drops } = drop(`여기서 ${word} 관련된 일을 해요.`);
      expect(text, word).toBeNull();
      expect(drops.forbidden_word, word).toBe(1);
    }
  });

  it("refuses a sentence too long for the row it has to sit on", () => {
    const long = `여기서 ${"아주 ".repeat(30)}바꿔요.`;
    const { text, drops } = drop(long);
    expect([...long].length).toBeGreaterThan(MAX_PURPOSE_CHARS);
    expect(text).toBeNull();
    expect(drops.too_long).toBe(1);
  });

  it("keeps a sentence right at the ceiling", () => {
    const at = `${"가".repeat(MAX_PURPOSE_CHARS - 2)}해요`;
    expect([...at].length).toBe(MAX_PURPOSE_CHARS);
    expect(cleanPurpose(at, noDrops())).toBe(at);
  });

  it("refuses an empty answer", () => {
    const { text, drops } = drop("   ");
    expect(text).toBeNull();
    expect(drops.empty).toBe(1);
  });
});

/**
 * The one test that stops the copy in `semantic/words.ts` from drifting.
 *
 * `purpose/` may not import `lib/graph/flow.ts` at run time — it reaches
 * `qa/answer.ts` and from there the workspace components, and an analysis pass
 * that pulled a React tree into itself could no longer be run from a plain
 * test. A test may import anything, so the pinning happens here instead of by
 * convention.
 */
describe("the forbidden list, pinned against the one flow.ts enforces", () => {
  it("is exactly the six words a flow sentence may not contain", () => {
    expect([...FORBIDDEN_WORDS, ...FLOW_FORBIDDEN_EXTRA].sort()).toEqual(
      [...FLOW_FORBIDDEN_WORDS].sort(),
    );
  });
});
