import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RELATION_WORDS } from "@/lib/graph/view";

import { FeatureMark } from "./feature-mark";
import { KeptAndNot } from "./kept-and-not";
import { PainMark } from "./pain-mark";
import { RepoToMap } from "./repo-to-map";
import { WaysIn } from "./ways-in";

/**
 * These tests cannot see the drawings, so they do not try to. They pin the four
 * things that would make a drawing wrong in a way nobody would notice from a
 * screenshot on one machine:
 *
 * - a picture that carries a claim and has no text saying the same thing,
 * - a decoration that a screen reader reads out anyway,
 * - a colour written as a hex literal, which is how a palette drifts, or the
 *   lamp amber spent on a decoration, which is how "you act here" stops meaning
 *   anything,
 * - a fixed pixel width, which is how this page grew a horizontal scrollbar
 *   twice (D61, D72).
 */

/** Tag text only. Class names are full of words nobody reads aloud. */
function words(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function svgTags(html: string): string[] {
  return html.match(/<svg[^>]*>/g) ?? [];
}

/** The one table row containing `header`, so a cell can be read in its column. */
function rowOf(html: string, header: string): string {
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  return rows.find((row) => row.includes(header)) ?? "";
}

const ALL: readonly { name: string; html: string }[] = [
  { name: "RepoToMap", html: renderToStaticMarkup(createElement(RepoToMap)) },
  { name: "WaysIn", html: renderToStaticMarkup(createElement(WaysIn)) },
  { name: "KeptAndNot", html: renderToStaticMarkup(createElement(KeptAndNot)) },
  { name: "PainMark", html: renderToStaticMarkup(createElement(PainMark, { index: 0 })) },
  { name: "FeatureMark", html: renderToStaticMarkup(createElement(FeatureMark, { name: "지도" })) },
];

describe("every landing drawing", () => {
  it("scales with its box instead of claiming a size", () => {
    for (const { name, html } of ALL) {
      const tags = svgTags(html);
      expect(tags.length, `${name} draws nothing`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, `${name} has an svg with no viewBox`).toContain("viewBox=");
        // A `width` or `height` attribute overrides the viewBox's scaling and
        // is the exact shape of the bug that put a canvas wider than its
        // container (D61). Size belongs to the class, which can be responsive.
        expect(tag, `${name} pins an svg to a fixed size`).not.toMatch(/\s(width|height)=/);
      }
    }
  });

  it("names every colour rather than spelling one out", () => {
    for (const { name, html } of ALL) {
      // Anything that looks like #rrggbb or #rgb is a token duplicated by hand,
      // and a duplicated token is one that will eventually be the odd one out.
      expect(html, `${name} hard-codes a colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it("leaves the lamp amber to the things you can act on", () => {
    for (const { name, html } of ALL) {
      expect(html, `${name} spends the accent on a picture`).not.toContain("--color-lamp");
      expect(html, `${name} spends the accent on a picture`).not.toMatch(/\blamp\b/);
    }
  });

  it("hides decoration from a screen reader", () => {
    for (const { name, html } of ALL) {
      for (const tag of svgTags(html)) {
        // Every drawing here is a second channel for something written beside
        // it. The day one stops being that, it needs a label, not this test
        // relaxed.
        expect(tag, `${name} has an svg a screen reader will read`).toContain('aria-hidden="true"');
      }
    }
  });
});

describe("the repository-to-map figure", () => {
  const html = renderToStaticMarkup(createElement(RepoToMap));

  it("says in text everything the picture says", () => {
    const text = words(html);
    // The claim itself, not a caption about a caption: what each side is, what
    // the grouping is, and what a line means.
    expect(text).toContain("왼쪽은 프로젝트에 들어 있는 파일이고");
    expect(text).toContain("사람이 쓰는 말로");
    expect(text).toContain("무엇이 무엇과 이어져 있는지");
  });

  it("teaches the two kinds of line it draws", () => {
    const text = words(html);
    expect(text).toContain("코드에서 확인한 연결");
    expect(text).toContain("정황으로 짐작한 연결");
  });

  it("gives both panels a written name, so the drawings can stay hidden", () => {
    const text = words(html);
    expect(text).toContain("파일 목록");
    expect(text).toContain("한 장의 지도");
  });

  it("lets its columns collapse below their content", () => {
    // `1fr` is `minmax(auto, 1fr)`, and an svg's auto minimum is its intrinsic
    // width — which is how a two-panel figure pushes past a 375px screen.
    expect(html).toContain("minmax(0,1fr)");
  });

  it("stacks its panels with an arrow that points the right way on each axis", () => {
    // One arrow per axis: a right-pointing arrow between two stacked panels
    // points at nothing.
    expect(html).toContain("md:hidden");
    expect(html).toContain("hidden h-6");
  });

  it("draws both panels on the same shape, so the two boxes end level", () => {
    // The alignment is not a CSS trick that could be undone by a class: the two
    // drawings are the same ratio, so at equal column widths they are the same
    // height and the panels line up at the bottom as well as the top, with
    // neither one padded out over empty space. The two arrows are the other
    // two svgs here and are taller than they are wide, or barely wider.
    const ratios = [...html.matchAll(/viewBox="0 0 ([\d.]+) ([\d.]+)"/g)].map(
      ([, width, height]) => Number(width) / Number(height),
    );
    const panels = ratios.filter((ratio) => ratio > 1.3);
    expect(panels, "the two panel drawings").toHaveLength(2);
    expect(panels[0]).toBeCloseTo(panels[1], 6);
  });

  it("aligns the two panels by their edges, not by their middles", () => {
    // `items-center` is what left the tops out of line: two boxes with a
    // visible edge, centred against each other, are level on neither edge.
    expect(html).toContain("grid items-stretch");
    // An arrow is not a panel, so it must not be stretched to the row's height.
    expect(html.match(/self-center/g) ?? []).toHaveLength(2);
  });

  it("puts one dot on the map for every file in the list", () => {
    // The whole reason this is one picture rather than two: nothing appears on
    // the right that did not come from the left. The swatch beside a file row
    // and the dot inside the place it went to are counted from the same array,
    // so a seventh file cannot quietly arrive without a seventh dot.
    const swatches = html.match(/width="3" height="12"/g) ?? [];
    const dots = html.match(/r="2\.4"/g) ?? [];
    expect(swatches, "one swatch per file row").toHaveLength(6);
    expect(dots, "one dot per file, inside its place").toHaveLength(swatches.length);
  });

  it("labels each arrow with the product's own word for the relation", () => {
    // Not a word invented for the landing page. These come from the one table
    // the workspace names connections with, so renaming one there renames it
    // here — and inventing one here fails.
    const text = words(html);
    expect(text).toContain(RELATION_WORDS.calls.short);
    expect(text).toContain(RELATION_WORDS.fetches.short);
  });

  it("writes each arrow out as a sentence, from → word → to", () => {
    // The words on a line are the one thing in this figure that cannot be HTML
    // — they are sized against the line they sit on. So they are said again in
    // the caption, in the order the arrow reads, and from the same table.
    const text = words(html);
    expect(text).toContain(`결제 → ${RELATION_WORDS.calls.short} → 장바구니`);
    expect(text).toContain(`결제 → ${RELATION_WORDS.fetches.short} → 로그인`);
  });

  it("draws both of the two lines its legend teaches", () => {
    // A legend for a mark the picture does not contain teaches nothing. The
    // guess is a hatched band rather than a dashed hairline, because at this
    // size a 1px dash and a 1px solid stroke are the same stroke.
    expect(html).toContain("var(--color-wire)");
    expect(html).toContain("var(--color-guess)");
    expect(html).toContain('stroke-dasharray="1.5 3"');
  });

  it("gives every connection a head, because the direction is the fact", () => {
    // "결제 uses 장바구니" and the reverse are different claims about someone's
    // code. Filled triangles, one per road.
    expect(html.match(/<polygon/g) ?? []).toHaveLength(2);
  });
});

describe("the three ways in", () => {
  const text = words(renderToStaticMarkup(createElement(WaysIn)));

  it("names all three doors in text, including the one the page forgets", () => {
    expect(text).toContain("GitHub 저장소 고르기");
    expect(text).toContain("주소 붙여넣기");
    expect(text).toContain("폴더 올리기");
  });

  it("does not promise a repository list to someone who has not signed in", () => {
    expect(text).toContain("로그인하면");
  });
});

describe("the pain marks", () => {
  it("draws one for each numbered pain the page has", () => {
    for (const index of [0, 1, 2]) {
      expect(renderToStaticMarkup(createElement(PainMark, { index }))).toContain("<svg");
    }
  });

  it("draws nothing rather than the wrong thing for a fourth", () => {
    // A borrowed mark would tell a different story from the words beside it,
    // which is worse than a missing mark.
    expect(renderToStaticMarkup(createElement(PainMark, { index: 3 }))).toBe("");
    expect(renderToStaticMarkup(createElement(PainMark, { index: -1 }))).toBe("");
  });
});

describe("the feature marks", () => {
  /**
   * These four words are the page's own eyebrows. Renaming one there without
   * renaming it here would empty a card silently; this test is what turns that
   * into a red run instead.
   */
  it("draws one for each of 지도 · 질문 · 연결 · 프롬프트", () => {
    for (const name of ["지도", "질문", "연결", "프롬프트"]) {
      expect(renderToStaticMarkup(createElement(FeatureMark, { name })), name).toContain("<svg");
    }
  });

  it("draws nothing for a word it has no picture for", () => {
    expect(renderToStaticMarkup(createElement(FeatureMark, { name: "미리보기" }))).toBe("");
  });
});

describe("what is kept and what is not", () => {
  const html = renderToStaticMarkup(createElement(KeptAndNot));

  it("is a table, so the answer arrives attached to its question", () => {
    expect(html).toContain("<table");
    expect(html).toContain("<caption");
    expect(html).toContain('scope="row"');
    expect(html).toContain('scope="col"');
  });

  it("writes every answer as a word, never as a mark alone", () => {
    const text = words(html);
    // Three rows, two columns: five kept and one not.
    expect(text.match(/남습니다/g) ?? []).toHaveLength(5);
    expect(text).toContain("남지 않습니다");
  });

  it("keeps the asymmetry D77 decided, in both directions", () => {
    const text = words(html);
    expect(text).toContain("파일 내용");
    expect(text).toContain("GitHub 저장소");
    expect(text).toContain("올려주신 폴더");
    // The reasons, word for word from the promise this illustrates. A diagram
    // that paraphrases a claim about someone's own code will eventually
    // disagree with it.
    expect(text).toContain("코드는 필요할 때 GitHub에서 가져와 읽고 곧바로 버립니다");
    expect(text).toContain("다시 가져올 곳이 없어서");
  });

  it("puts the one 'no' under the right column", () => {
    // Read the row rather than the flattened page: flattened, the two answers
    // in a row are two adjacent words and nothing says which column each
    // belongs to — which is the whole failure this table exists to prevent.
    // The old flat promise ("코드는 보관하지 않습니다") became false for half the
    // product at D77, and a false sentence about someone's own code is the
    // worst thing this page can contain. Column order first, then the row.
    expect(words(rowOf(html, "남는 것"))).toBe("남는 것 GitHub 저장소 올려주신 폴더");
    expect(words(rowOf(html, "파일 내용"))).toBe("파일 내용 남지 않습니다 남습니다");
  });

  it("names its empty corner for a screen reader", () => {
    expect(html).toContain("sr-only");
  });

  it("lays its columns out fixed, so three of them fit a phone", () => {
    expect(html).toContain("table-fixed");
  });
});
