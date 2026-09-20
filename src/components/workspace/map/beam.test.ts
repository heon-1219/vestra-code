import { describe, expect, it } from "vitest";

import {
  beamOf,
  buildBeamIndex,
  choseongOf,
  isChoseongQuery,
  runBeam,
  toHangul,
} from "./beam";
import type { BeamItem } from "./beam";

const items: BeamItem[] = [
  { id: "pay", name: "PayButton", label: "결제 버튼", path: "src/components/PayButton.tsx" },
  { id: "cart", name: "useCart", label: "장바구니", path: "src/lib/useCart.ts" },
  { id: "login", name: "LoginForm", label: "로그인", path: "src/app/login/page.tsx" },
  { id: "orders", name: "src/app/api/orders/route.ts", label: null, path: "src/app/api/orders/route.ts" },
  { id: "react", name: "react", label: null, path: null },
];

const index = buildBeamIndex(items);

function lit(query: string): string[] {
  return [...runBeam(index, query).matched].sort();
}

describe("toHangul", () => {
  it("reads the wrong keyboard as the syllables it meant", () => {
    expect(toHangul("rufwp")).toBe("결제");
    expect(toHangul("dkssud")).toBe("안녕");
    expect(toHangul("gksrmf")).toBe("한글");
  });

  it("fuses the vowels and the final consonants that fuse", () => {
    expect(toHangul("dhk")).toBe("와");
    expect(toHangul("dkfg")).toBe("앓");
  });

  it("hands a final consonant over to the syllable that starts next", () => {
    // The whole reason this is an automaton and not a lookup table: the `ㄹ` of
    // 결 becomes 제's initial the moment a vowel follows.
    expect(toHangul("rkrk")).toBe("가가");
    expect(toHangul("dkscp")).toBe("안체");
  });

  it("leaves a half-typed syllable half-typed rather than guessing", () => {
    expect(toHangul("rufw")).toBe("결ㅈ");
    expect(toHangul("ru")).toBe("겨");
  });

  it("passes through what is not on the Korean layout", () => {
    expect(toHangul("rufwp-2")).toBe("결제-2");
  });
});

describe("choseongOf", () => {
  it("keeps only the leading consonant of each syllable", () => {
    expect(choseongOf("결제")).toBe("ㄱㅈ");
    expect(choseongOf("장바구니")).toBe("ㅈㅂㄱㄴ");
  });

  it("lets everything else through, lowercased", () => {
    expect(choseongOf("PayButton 결제")).toBe("paybutton ㄱㅈ");
  });

  it("knows a bare-consonant query when it sees one", () => {
    expect(isChoseongQuery("ㄱㅈ")).toBe(true);
    expect(isChoseongQuery("결제")).toBe(false);
    expect(isChoseongQuery("pay")).toBe(false);
    expect(isChoseongQuery("")).toBe(false);
  });
});

describe("runBeam", () => {
  it("is not on when nothing is typed", () => {
    const result = runBeam(index, "   ");
    expect(result.active).toBe(false);
    expect(result.matched.size).toBe(0);
  });

  it("matches the plain-language name", () => {
    expect(lit("결제")).toEqual(["pay"]);
  });

  it("matches the code name, whatever case it is typed in", () => {
    expect(lit("paybutton")).toEqual(["pay"]);
    expect(lit("PAYBUTTON")).toEqual(["pay"]);
  });

  it("matches the path, so a folder lights its files", () => {
    expect(lit("api/orders")).toEqual(["orders"]);
    expect(lit("src/lib")).toEqual(["cart"]);
  });

  it("matches 초성, because that is how the name is half-remembered", () => {
    expect(lit("ㄱㅈ")).toEqual(["pay"]);
    expect(lit("ㅈㅂㄱㄴ")).toEqual(["cart"]);
    expect(lit("ㄹㄱㅇ")).toEqual(["login"]);
  });

  it("reads a query typed with the IME still in English", () => {
    expect(lit("rufwp")).toEqual(["pay"]);
  });

  it("lands on the answer before the last keystroke of a wrong-IME query", () => {
    // `rufw` composes to 결ㅈ, whose 초성 is ㄱㅈ — which is 결제.
    expect(lit("rufw")).toEqual(["pay"]);
  });

  it("is on, and lights nothing, when nothing matches", () => {
    const result = runBeam(index, "존재하지않는이름");
    expect(result.active).toBe(true);
    expect(result.matched.size).toBe(0);
  });

  it("lights an item that has no path at all", () => {
    expect(lit("react")).toEqual(["react"]);
  });

  it("does not let a match straddle two fields", () => {
    // `결제 버튼` and `PayButton` are joined in the index; a query spanning the
    // join would report a word that does not exist anywhere in the project.
    expect(lit("버튼paybutton")).toEqual([]);
  });

  it("stays fast enough to run on every keystroke", () => {
    const many: BeamItem[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `n${i}`,
      name: `Component${i}`,
      label: i % 3 === 0 ? "결제 화면" : "장바구니",
      path: `src/components/Component${i}.tsx`,
    }));
    const big = buildBeamIndex(many);
    const started = Date.now();
    for (const query of ["ㄱ", "ㄱㅈ", "rufwp", "component1", "결제"]) {
      runBeam(big, query);
    }
    /*
     * Generous on purpose, and it still does its job.
     *
     * What this guards against is the beam going accidentally quadratic — a
     * per-keystroke scan of 2000 items that starts comparing every item to
     * every other. That regression costs seconds on this input, not a few
     * milliseconds, so a wide budget catches it just as surely as a tight one.
     *
     * A tight one, meanwhile, fails for a reason that has nothing to do with
     * this code: the five queries take ~72ms here, and at a ceiling of 80 the
     * test was really asserting that no other process wanted the CPU. Under a
     * full run with fifty workers competing it lost that bet regularly, which
     * is a red suite that means nothing and trains everyone to re-run it.
     */
    expect(Date.now() - started).toBeLessThan(800);
  });
});

describe("beamOf", () => {
  it("lights exactly the items it was handed", () => {
    const result = beamOf(new Set(["pay", "cart"]));
    expect(result.active).toBe(true);
    expect([...result.matched].sort()).toEqual(["cart", "pay"]);
  });

  /*
   * The empty set is the case this exists for.
   *
   * A change that touched nothing the map holds — a README, a lockfile, a
   * config — is the ordinary answer on a project whose analyzer only places
   * files. An active beam over an empty set dims every item on the map to 30%
   * and lights none of them, which is the map telling an already-anxious
   * person that their project has gone (D59). The honest answer is a sentence,
   * so the lighting stays idle and the band says it.
   */
  it("stays idle for an empty set rather than dimming the whole map", () => {
    const result = beamOf(new Set<string>());
    expect(result.active).toBe(false);
    expect(result.matched.size).toBe(0);
  });
});
