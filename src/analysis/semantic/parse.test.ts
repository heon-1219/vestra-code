import { describe, expect, it } from "vitest";

import {
  cleanLabel,
  cleanSummary,
  isHaeyoche,
  noDrops,
  parseFeatureReply,
  parseNamingReply,
} from "./parse";

/**
 * What the model is allowed to put on a stranger's map.
 *
 * Every test here is about something reaching a person who cannot open their
 * own code to check it. A label that is a transliteration is visibly useless; a
 * confident Korean sentence that is wrong is not, and neither is a 합니다체 line
 * in the middle of a product whose UI is 해요체 in all 53 of its sentences (D74).
 * So the parser drops rather than repairs, and these pin what it drops.
 */

const allowed = new Set([0, 1, 2]);
const files = new Set([0, 1]);
const names = new Map([
  [0, "src/components/PayButton.tsx"],
  [1, "src/lib/useCart.ts"],
  [2, "PayButton"],
]);

function parse(body: unknown) {
  return parseNamingReply(JSON.stringify(body), allowed, files, names, noDrops());
}

describe("reading a naming reply", () => {
  it("keeps a good answer", () => {
    const { items } = parse({
      items: [{ i: 0, label: "결제 버튼", summary: "결제를 눌렀을 때 주문을 넣어요." }],
    });
    expect(items).toEqual([
      { index: 0, label: "결제 버튼", summary: "결제를 눌렀을 때 주문을 넣어요." },
    ]);
  });

  it("drops an index it never sent", () => {
    // D46's whole point: the model answers with integers into a list we built,
    // so "drop any id that doesn't exist" is a bounds check rather than a
    // string comparison somebody can talk their way around.
    const { items, drops } = parse({ items: [{ i: 99, label: "결제 버튼" }] });
    expect(items).toEqual([]);
    expect(drops.unknown_index).toBe(1);
  });

  it("drops a name that is just the identifier", () => {
    const { items, drops } = parse({ items: [{ i: 0, label: "PayButton" }] });
    expect(items).toEqual([]);
    expect(drops.not_korean).toBe(1);
  });

  it("drops a name that flattens to the identifier, spaces and case aside", () => {
    const one = cleanLabel("pay button", "src/components/PayButton.tsx", noDrops());
    expect(one).toBeNull();
  });

  it("drops a summary that is not 해요체", () => {
    const { items, drops } = parse({
      items: [{ i: 0, label: "결제 버튼", summary: "결제를 처리합니다." }],
    });
    // The name survives; only the sentence is thrown away. A missing sentence
    // costs a line, and a 합니다체 one would be the first in the whole product.
    expect(items).toEqual([{ index: 0, label: "결제 버튼", summary: null }]);
    expect(drops.not_haeyoche).toBe(1);
  });

  it.each(["안전", "노드", "엣지"])("drops anything containing %s", (word) => {
    const { items, drops } = parse({
      items: [{ i: 0, label: `${word} 버튼`, summary: `${word}를 다뤄요.` }],
    });
    expect(items).toEqual([]);
    expect(drops.forbidden_word).toBeGreaterThan(0);
  });

  it("drops a label used as a sentence", () => {
    const { items, drops } = parse({
      items: [
        {
          i: 0,
          label: "결제 버튼을 눌렀을 때 주문을 서버로 보내 주는 아주 긴 이름이에요",
          summary: "주문을 넣어요.",
        },
      ],
    });
    expect(items).toEqual([]);
    expect(drops.too_long).toBe(1);
  });

  it("gives a piece a name and no sentence, because D54 keeps those lazy", () => {
    const { items } = parse({
      items: [{ i: 2, label: "결제 버튼", summary: "이건 버려요." }],
    });
    expect(items).toEqual([{ index: 2, label: "결제 버튼", summary: null }]);
  });

  it("takes the first of two answers for one thing", () => {
    const { items, drops } = parse({
      items: [
        { i: 0, label: "결제 버튼", summary: "주문을 넣어요." },
        { i: 0, label: "다른 이름", summary: "다른 설명이에요." },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("결제 버튼");
    expect(drops.duplicate).toBe(1);
  });

  it("reads JSON out of a fenced block, because only some endpoints honour the schema (D47)", () => {
    const reply = '설명입니다\n```json\n{"items":[{"i":1,"label":"장바구니 기억해 두는 곳","summary":"담은 물건을 기억해요."}]}\n```';
    const { items } = parseNamingReply(reply, allowed, files, names, noDrops());
    expect(items[0].label).toBe("장바구니 기억해 두는 곳");
  });

  it("produces nothing from a reply it cannot read, and counts that", () => {
    const { items, drops } = parseNamingReply("모르겠어요", allowed, files, names, noDrops());
    expect(items).toEqual([]);
    expect(drops.unreadable_reply).toBe(1);
  });

  it("produces nothing from a null reply", () => {
    const { items } = parseNamingReply(null, allowed, files, names, noDrops());
    expect(items).toEqual([]);
  });
});

describe("reading a feature reply", () => {
  const allowedFiles = new Set([0, 1, 2, 3]);

  it("keeps a feature and de-duplicates its members", () => {
    const { features } = parseFeatureReply(
      JSON.stringify({
        features: [{ name: "결제", summary: "물건 값을 받아요.", files: [0, 1, 1] }],
      }),
      allowedFiles,
    );
    expect(features).toEqual([
      { name: "결제", summary: "물건 값을 받아요.", files: [0, 1] },
    ]);
  });

  it("drops members it never sent and keeps the rest", () => {
    const { features, drops } = parseFeatureReply(
      JSON.stringify({ features: [{ name: "결제", files: [0, 404] }] }),
      allowedFiles,
    );
    expect(features[0].files).toEqual([0]);
    expect(drops.unknown_index).toBe(1);
  });

  it("drops a feature with nothing in it", () => {
    // An empty territory on the map reads as a part of the app that exists and
    // is empty, which is a claim about the user's code we did not make.
    const { features, drops } = parseFeatureReply(
      JSON.stringify({ features: [{ name: "결제", files: [404] }] }),
      allowedFiles,
    );
    expect(features).toEqual([]);
    expect(drops.no_members).toBe(1);
  });

  it("drops a feature named in code rather than in Korean", () => {
    const { features, drops } = parseFeatureReply(
      JSON.stringify({ features: [{ name: "AuthProvider", files: [0] }] }),
      allowedFiles,
    );
    expect(features).toEqual([]);
    expect(drops.not_korean).toBe(1);
  });

  it("drops the second feature with the same name", () => {
    const { features, drops } = parseFeatureReply(
      JSON.stringify({
        features: [
          { name: "결제", files: [0] },
          { name: "결제", files: [1] },
        ],
      }),
      allowedFiles,
    );
    expect(features).toHaveLength(1);
    expect(drops.duplicate).toBe(1);
  });
});

describe("해요체", () => {
  it.each([
    "주문을 넣어요.",
    "담은 물건을 기억해요",
    "결제 화면이에요.",
    "여기서 값을 보여 줘요!",
  ])("accepts %s", (text) => {
    expect(isHaeyoche(text)).toBe(true);
  });

  it.each(["주문을 넣습니다.", "주문을 넣는다.", "주문 넣는 곳", "주문을 넣어"])(
    "rejects %s",
    (text) => {
      expect(isHaeyoche(text)).toBe(false);
    },
  );

  it("rejects an English sentence even when it ends in the right shape", () => {
    expect(cleanSummary("Places the order.", noDrops())).toBeNull();
  });
});
