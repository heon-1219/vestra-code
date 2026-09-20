import { describe, expect, it } from "vitest";

import { describeAll, copula } from "./describe";
import type { GraphConnection, GraphItem } from "./view";

/**
 * The sentence a person reads when they point at something.
 *
 * Two things are being checked and only one of them is arithmetic. The other is
 * what the sentence is allowed to claim — this file is where "we found no
 * connections" must not become "nothing uses it", and where a model's summary
 * must beat our own guessing.
 */

let counter = 0;
function item(partial: Partial<GraphItem> & { kind: GraphItem["kind"] }): GraphItem {
  counter += 1;
  return {
    id: partial.id ?? `n${counter}`,
    kind: partial.kind,
    shape: partial.shape ?? null,
    name: partial.name ?? `name${counter}`,
    label: partial.label ?? null,
    summary: partial.summary ?? null,
    path: partial.path ?? null,
    startLine: null,
    endLine: null,
    fromUser: false,
    usedBy: partial.usedBy ?? 0,
    uses: partial.uses ?? 0,
  };
}

function link(
  from: string,
  to: string,
  relation: GraphConnection["relation"],
): GraphConnection {
  return { id: `${from}->${to}:${relation}`, from, to, relation, certainty: "certain" };
}

function view(items: GraphItem[], connections: GraphConnection[]) {
  return { items, connections };
}

describe("describeAll", () => {
  it("says what a file holds and how often it is reached for", () => {
    const file = item({ kind: "file", id: "f", path: "src/checkout/PayButton.tsx" });
    const button = item({ kind: "symbol", id: "s1", shape: "component" });
    const helper = item({ kind: "symbol", id: "s2", shape: "function" });
    const other = item({ kind: "file", id: "f2" });

    const lines = describeAll(
      view(
        [file, button, helper, other],
        [link("f", "s1", "contains"), link("f", "s2", "contains"), link("f2", "f", "imports")],
      ),
    );

    expect(lines.get("f")!.line).toBe("화면 조각 1개와 일 처리 1개가 들어 있어요, 1곳에서 써요");
    expect(lines.get("f")!.fromModel).toBe(false);
  });

  it("never turns an absent connection into a verdict on the code", () => {
    // The one sentence in this file that matters most. An entry point is used
    // by the browser, and a file loaded through a name we never resolved is
    // used by something we did not see — "안 쓰여요" would be us saying we
    // looked everywhere, which we did not.
    const lonely = item({ kind: "symbol", id: "s", shape: "component" });
    const lines = describeAll(view([lonely], []));

    expect(lines.get("s")!.line).toContain("쓰는 곳을 아직 못 찾았어요");
    expect(lines.get("s")!.line).not.toContain("안 쓰여요");
    expect(lines.get("s")!.line).not.toContain("안 씁니다");
  });

  it("prefers the model's sentence over its own arithmetic", () => {
    // Pass 2 read the code; this module counted edges. Where both exist, the
    // one that read the code wins, and says so.
    const described = item({
      kind: "file",
      id: "f",
      summary: "결제가 끝난 뒤 영수증을 만들어요.",
    });
    const lines = describeAll(view([described], []));

    expect(lines.get("f")).toEqual({
      line: "결제가 끝난 뒤 영수증을 만들어요.",
      fromModel: true,
    });
  });

  it("ignores a summary that is only whitespace", () => {
    // A model that answered with a blank line should not blank the tooltip.
    const blank = item({ kind: "package", id: "p", summary: "   " });
    expect(describeAll(view([blank], [])).get("p")!.fromModel).toBe(false);
  });

  it("names an address rather than describing it", () => {
    const route = item({ kind: "route", id: "r", name: "/checkout" });
    const endpoint = item({ kind: "api_endpoint", id: "e", name: "/api/orders" });
    const lines = describeAll(
      view([route, endpoint, item({ kind: "file", id: "f" })], [link("f", "e", "fetches")]),
    );

    expect(lines.get("r")!.line).toContain("/checkout 주소로 열리는 페이지예요");
    expect(lines.get("e")!.line).toBe("/api/orders 주소에 답하는 곳이에요, 1곳에서 써요");
  });

  it("caps a mixed file at its two biggest kinds", () => {
    // A file holding six sorts of thing produces a sentence nobody finishes.
    const file = item({ kind: "file", id: "f" });
    const kids = [
      item({ kind: "symbol", id: "a", shape: "component" }),
      item({ kind: "symbol", id: "b", shape: "component" }),
      item({ kind: "symbol", id: "c", shape: "function" }),
      item({ kind: "symbol", id: "d", shape: "type" }),
    ];
    const lines = describeAll(
      view([file, ...kids], kids.map((kid) => link("f", kid.id, "contains"))),
    );

    const line = lines.get("f")!.line;
    expect(line).toContain("화면 조각 2개");
    expect(line).toContain("일 처리 1개");
    expect(line).not.toContain("정해 둔 모양");
  });

  it("does not count being held as being used", () => {
    // `contains` is structure, not a use. Counting it is D69's inflation,
    // which had the panel reporting 7곳 where the parser had measured 6.
    const file = item({ kind: "file", id: "f" });
    const kid = item({ kind: "symbol", id: "s", shape: "function" });
    const lines = describeAll(view([file, kid], [link("f", "s", "contains")]));

    expect(lines.get("s")!.line).toContain("쓰는 곳을 아직 못 찾았어요");
  });

  it("does not ask whether a feature is used", () => {
    // A feature is a grouping we made, so "쓰인다" is not a question about it.
    const feature = item({ kind: "feature", id: "x" });
    expect(describeAll(view([feature], [])).get("x")!.line).toBe(
      "기능 하나로 묶어 둔 것이에요",
    );
  });

  it("recognises a file we recorded but never read", () => {
    const photo = item({ kind: "file", id: "f", path: "public/me.jpg" });
    expect(describeAll(view([photo], [])).get("f")!.line).toContain("그림이나 파일이에요");
  });
});

describe("예요 and 이에요", () => {
  it("picks the one the word actually takes", () => {
    // The three in SHAPE_WORDS that carry 받침, and the four that do not.
    // 화면 조각 is the commonest kind in any React project, so 화면 조각예요 was
    // on screen for almost every user of this product.
    expect(copula("화면 조각")).toBe("이에요");
    expect(copula("정해 둔 값")).toBe("이에요");
    expect(copula("정해 둔 모양")).toBe("이에요");
    expect(copula("일 처리")).toBe("예요");
    expect(copula("화면 도우미")).toBe("예요");
    expect(copula("설계도")).toBe("예요");
    expect(copula("꾸미기")).toBe("예요");
  });

  it("reads the final consonant out of the syllable rather than a list", () => {
    // 각 and 가 are the same syllable with and without a final ㄱ, one code
    // point apart in the block. If this ever needed a dictionary it would be
    // wrong for some word nobody thought of.
    expect(copula("가")).toBe("예요");
    expect(copula("각")).toBe("이에요");
    expect(copula("갛")).toBe("이에요");
  });

  it("does not guess at a word it cannot read", () => {
    // A package name or a path has no deterministic answer: the particle
    // follows how the word is said aloud. Sentences that would need one are
    // written to avoid the choice instead.
    for (const foreign of ["stripe", "orders.ts", "", "42"]) {
      expect(copula(foreign)).toBe("예요");
    }
  });
});
