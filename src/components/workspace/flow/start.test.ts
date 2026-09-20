import { describe, expect, it } from "vitest";

import { flowSentenceIssues, traceFlow } from "@/lib/graph/flow";

import { buildBeamIndex } from "../map/beam";
import { NO_FEATURES_YET } from "../map/grouping";
import { NO_WAY_IN, SHALLOW, SHOP } from "./__fixtures__/shop";
import {
  discoveryRefusal,
  flowsByFeature,
  importCountOf,
  listedStarts,
  questionWords,
  startNote,
  startsForQuestion,
  withoutParticle,
} from "./start";

/**
 * Where a flow starts when somebody types a sentence.
 *
 * The founder's ask is a sentence — "이 구매 기능 어떻게 동작하는지 말해줘" — and
 * `FLOW_TRACKING.md` §2.3 says to resolve it with the map's own beam rather
 * than a second search. What is pinned here is that the sentence **arrives at a
 * path**, that it arrives by the beam and not by something invented alongside
 * it, and that every sentence written about the choice keeps the vocabulary
 * §1 lays down.
 *
 * Nothing here imports a parser, a database or `env.ts`.
 */

const beam = buildBeamIndex(SHOP.items);

function walk(question: string) {
  const starts = startsForQuestion(SHOP, beam, question);
  expect(starts.length).toBeGreaterThan(0);
  return { starts, trace: traceFlow(SHOP, { startId: starts[0].item.id }) };
}

describe("cutting a question into words", () => {
  it("keeps the words that are about the project", () => {
    expect(questionWords("이 구매 기능 어떻게 동작하는지 말해줘")).toEqual(["구매"]);
  });

  it("drops the words that are about asking", () => {
    // Every one of these matches something on a real project for the wrong
    // reason, or is pure grammar.
    for (const word of ["어떻게", "기능", "알려줘", "코드", "how", "does"]) {
      expect(questionWords(`결제 ${word}`)).toEqual(["결제"]);
    }
  });

  it("refuses a needle too short to be a needle", () => {
    // One syllable lights the map rather than pointing at something on it.
    expect(questionWords("이 것 은 P")).toEqual([]);
  });

  it("says each word once, in the order it was typed", () => {
    expect(questionWords("결제 주문 결제")).toEqual(["결제", "주문"]);
  });
});

describe("Korean particles", () => {
  it("takes one off so the word can be found at all", () => {
    // `"결제 화면".includes("결제가")` is false. Without this the word somebody
    // actually typed appears nowhere in the project, spelled that way.
    expect(withoutParticle("결제가")).toBe("결제");
    expect(withoutParticle("주문은")).toBe("주문");
    expect(withoutParticle("장바구니에서")).toBe("장바구니");
  });

  it("leaves a word alone when stripping would destroy it", () => {
    // 지도 ends in 도, which is also a particle. A rule that rewrote it to 지
    // would stop the word 지도 finding anything.
    expect(withoutParticle("지도")).toBeNull();
    expect(withoutParticle("PayButton")).toBeNull();
  });

  it("offers both forms rather than replacing one with the other", () => {
    // 결제 is found by the stripped form; 지도 would only ever be found by the
    // typed one. Both go to the beam, so neither case can lose.
    expect(startsForQuestion(SHOP, beam, "결제가")[0]?.item.name).toBe("/checkout");
    expect(startsForQuestion(SHOP, beam, "결제")[0]?.item.name).toBe("/checkout");
  });
});

describe("the founder's own question", () => {
  it("reaches a path", () => {
    const { starts, trace } = walk("이 구매 기능 어떻게 동작하는지 말해줘");

    expect(starts[0].item.name).toBe("/checkout");
    expect(trace.refusal).toBeNull();
    expect(trace.path?.hops.length).toBeGreaterThan(0);
  });

  it("gets there through the feature, because nothing is called 구매", () => {
    /*
     * The whole reason a matched feature has to resolve to the addresses
     * inside it. No file, route or symbol in this project carries the word a
     * person uses; only the name Pass 2 wrote does, and a feature cannot be a
     * start — `entryPointsOf` refuses one. Without the expansion the word
     * would find something and then lead nowhere.
     */
    const [best] = startsForQuestion(SHOP, beam, "구매");
    expect(best.via?.name).toBe("구매");
    expect(best.item.kind).toBe("route");
  });

  it("says where the start came from, and where the name came from", () => {
    const [best] = startsForQuestion(SHOP, beam, "이 구매 기능 어떻게 동작하는지 말해줘");
    const note = startNote(best);

    expect(note).toContain('"구매"');
    expect(note).toContain("이 이름은 주소에서 가져왔어요");
    expect(flowSentenceIssues(note)).toEqual([]);
  });

  it("walks a whole path from the sentence: screen → button → server", () => {
    const { trace } = walk("이 구매 기능 어떻게 동작하는지 말해줘");
    const names = trace.path?.hops.map((hop) => hop.toId) ?? [];

    // The joint, the click, the crossing, the handler. The founder's example
    // on the fixture's own rows.
    expect(names).toEqual(["s-pay", "s-create", "e-orders", "s-save"]);
    expect(trace.path?.reachedEndpoint).toBe(true);
  });
});

describe("the beam, and not a second search", () => {
  it("finds a Korean word through the label Pass 2 wrote", () => {
    expect(startsForQuestion(SHOP, beam, "결제")[0]?.item.name).toBe("/checkout");
  });

  it("handles 초성 the same way the map does", () => {
    // ㄱㅁ is 구매 typed as initials. If this ever stops working it is because
    // somebody wrote a matcher of their own beside `runBeam`.
    expect(startsForQuestion(SHOP, beam, "ㄱㅁ")[0]?.via?.name).toBe("구매");
  });

  it("handles a word typed with the wrong keyboard", () => {
    // `rnao` is 구매 with the IME still in English.
    expect(startsForQuestion(SHOP, beam, "rnao")[0]?.via?.name).toBe("구매");
  });

  it("finds a Latin name written in the code", () => {
    expect(startsForQuestion(SHOP, beam, "PayButton")[0]?.item.name).toBe("PayButton");
  });

  it("returns nothing at all when the words are not about this project", () => {
    expect(startsForQuestion(SHOP, beam, "배송 추적기")).toEqual([]);
  });
});

describe("ranking the places a question matched", () => {
  it("prefers a route, which is the one kind a person reads as a place", () => {
    const ranked = startsForQuestion(SHOP, beam, "구매");
    expect(ranked.map((one) => one.item.kind)).toEqual(["route", "api_endpoint"]);
  });

  it("never offers a start whose only answer would be a refusal", () => {
    // A package is somebody else's code and a feature is a grouping we made;
    // `entryPointsOf` refuses both.
    for (const question of ["stripe", "구매"]) {
      for (const choice of startsForQuestion(SHOP, beam, question)) {
        expect(choice.item.kind).not.toBe("package");
        expect(choice.item.kind).not.toBe("feature");
      }
    }
  });

  it("gives the same answer twice over an unchanged graph", () => {
    const once = startsForQuestion(SHOP, beam, "구매 결제 주문").map((one) => one.item.id);
    const twice = startsForQuestion(SHOP, beam, "구매 결제 주문").map((one) => one.item.id);
    expect(once).toEqual(twice);
  });

  it("counts the other places out loud rather than hiding them", () => {
    const ranked = startsForQuestion(SHOP, beam, "구매");
    expect(ranked[0].others).toBe(ranked.length - 1);
    expect(startNote(ranked[0])).toContain(`${ranked.length - 1}곳 더 있어요`);
  });
});

describe("the project's own flows", () => {
  it("gathers them under the feature that claims them", () => {
    const groups = flowsByFeature(SHOP);
    expect(groups).toHaveLength(1);
    expect(groups[0].feature?.name).toBe("구매");
    expect(groups[0].starts.map((one) => one.name)).toEqual(["/checkout", "/api/orders"]);
  });

  it("inherits the claim through the file, which is where Pass 2 writes it", () => {
    // The `belongs_to` hangs off `app/checkout/page.jsx`, never off the route
    // node inside it. Reading only the route's own connections would find a
    // feature for approximately nothing (D52).
    const claims = SHOP.connections.filter((one) => one.relation === "belongs_to");
    expect(claims.every((one) => one.from.startsWith("f-"))).toBe(true);
    expect(flowsByFeature(SHOP)[0].starts.length).toBe(2);
  });

  it("puts the unclaimed ones last and never drops them", () => {
    const loose = {
      ...SHOP,
      connections: SHOP.connections.filter((one) => one.id !== "c17"),
    };
    const groups = flowsByFeature(loose);
    expect(groups[groups.length - 1].feature).toBeNull();
    expect(groups[groups.length - 1].starts.map((one) => one.name)).toEqual(["/api/orders"]);
  });

  it("offers every entry point when nothing is typed", () => {
    expect(listedStarts(SHOP).map((one) => one.item.name)).toEqual([
      "/checkout",
      "/api/orders",
    ]);
  });

  it("has a sentence, not silence, when no feature has been named", () => {
    // `grouping.ts`'s own, imported rather than retyped: two halves of one
    // screen explaining the same gap two different ways is what it exists to
    // prevent.
    const unnamed = { ...SHOP, items: SHOP.items.filter((one) => one.kind !== "feature") };
    expect(flowsByFeature(unnamed).every((group) => group.feature === null)).toBe(true);
    expect(flowSentenceIssues(NO_FEATURES_YET)).toEqual([]);
  });
});

describe("projects with no flows at all — the common case", () => {
  it("says so when there is no way in", () => {
    // Three of the four real projects on 2026-09-21: a Streamlit app, an
    // OpenCV tray app and a static site. This is the primary path.
    expect(discoveryRefusal(NO_WAY_IN)).toBe("no-entry-point");
  });

  it("says the more specific thing first when every connection is an import", () => {
    // `traceFlow`'s own order. "We found no address" would send somebody
    // looking for a page they do not have, when the real answer is that we did
    // not read their code deeply enough to follow anything anywhere.
    expect(discoveryRefusal(SHALLOW)).toBe("no-behaviour");
  });

  it("carries the project's own number into the sentence", () => {
    expect(importCountOf(SHALLOW)).toBe(2);
    expect(importCountOf(SHOP)).toBe(1);
  });

  it("says nothing when the project does have flows", () => {
    expect(discoveryRefusal(SHOP)).toBeNull();
  });
});

describe("what the screen is not allowed to say", () => {
  it("keeps 실행 · 추적 · 실시간 · 안전 · 노드 · 엣지 out of every start sentence", () => {
    const sentences = [
      ...startsForQuestion(SHOP, beam, "구매 결제 주문").map(startNote),
      ...listedStarts(SHOP).map(startNote),
      startNote({
        item: SHOP.items[2],
        origin: "selection",
        hits: 0,
        words: [],
        others: 0,
        via: null,
      }),
    ];

    expect(sentences.length).toBeGreaterThan(3);
    for (const sentence of sentences) {
      expect(flowSentenceIssues(sentence)).toEqual([]);
      // 해요체, and never the past tense of something having run.
      expect(sentence).toMatch(/요\.$/);
      expect(sentence).not.toMatch(/습니다|합니다/);
      expect(sentence).not.toMatch(/지나갔|불렀|실행됐/);
    }
  });
});
