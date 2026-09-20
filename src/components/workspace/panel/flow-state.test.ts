import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  flowSentenceIssues,
  FLOW_FORBIDDEN_WORDS,
  FLOW_NOTICE,
  traceFlow,
  type FlowTrace,
} from "@/lib/graph/flow";
import { GUESSED_ADDRESS, NO_WAY_IN, SHALLOW, SHOP } from "../flow/__fixtures__/shop";
import { openPlayer } from "../flow/player";
import { startNote, startsForQuestion, type FlowChoice } from "../flow/start";
import { hereIn, trailOfFlow } from "../flow/trail";
import type { FlowControls, FlowSession } from "../flow/use-flow";
import { noMatchSentence } from "../flow/use-flow";
import { buildBeamIndex } from "../map/beam";
import { RightPanel } from "./connections-panel";
import { MODE_WORDS } from "./mode";
import { NothingSelectedState } from "./states";

/**
 * 흐름 따라가기, as a person reads it.
 *
 * Four things are pinned here and each one is a rule from `FLOW_TRACKING.md`
 * that a screen could break without anything else noticing:
 *
 *   1. **The vocabulary.** 실행 · 추적 · 실시간 · 안전 · 노드 · 엣지 appear in
 *      nothing the panel renders, from any source. §8.8, and D68's precedent —
 *      "a test asserts the sentence does not come back."
 *   2. **The refusals.** Three of the four real projects have no entry point,
 *      so the sentences §7 drafted are what most people see first and they have
 *      to actually be on screen.
 *   3. **`prefers-reduced-motion` turns the pacing off** and shows the whole
 *      path at once.
 *   4. **A row shows its measured sentence immediately** and the ending is held
 *      back until the reader arrives at it.
 *
 * Rendered to static markup, which is how every other test of this panel works:
 * the tests cannot press a key, so anything that depends on one is tested in the
 * pure module beside it instead (`flow/player.test.ts`).
 */

const beam = buildBeamIndex(SHOP.items);
const itemsById = new Map(SHOP.items.map((item) => [item.id, item]));

function words(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A flow session, built the way the hook builds one but without React.
 *
 * `useFlow` is a hook and these tests render to a string, so the controls are
 * assembled here from the same pure pieces the hook assembles them from —
 * `traceFlow`, `openPlayer`, `trailOfFlow`, `hereIn` — rather than mocked. What
 * is drawn is therefore what a real walk produces.
 */
function controls(
  over: {
    startId?: string;
    question?: string;
    revealed?: number;
    playing?: boolean;
    reduced?: boolean;
    session?: Partial<FlowSession>;
  } = {},
): FlowControls {
  const startId = over.startId ?? "r-checkout";
  const trace: FlowTrace = traceFlow(SHOP, { startId });
  const paths = trace.path ? [trace.path, ...trace.alternatives] : [];
  const path = paths[0] ?? null;
  const hops = path?.hops.length ?? 0;

  const choice: FlowChoice | null = trace.start
    ? {
        item: itemsById.get(trace.start.id)!,
        origin: over.question ? "typed" : "listed",
        hits: 0,
        words: [],
        others: 0,
        via: null,
      }
    : null;

  const base = openPlayer(hops, over.reduced ?? false);
  const player = {
    ...base,
    revealed: over.revealed ?? base.revealed,
    playing: over.playing ?? base.playing,
  };

  const session: FlowSession = {
    question: over.question ?? "",
    choice,
    note: choice ? startNote(choice) : "",
    trace,
    missed: null,
    candidates: [],
    ...over.session,
  };

  return {
    session,
    player,
    reduced: over.reduced ?? false,
    pathAt: 0,
    paths,
    path,
    trail: trailOfFlow(trace.start?.id ?? null, path?.hops ?? [], player.revealed),
    here: hereIn(trace.start?.id ?? null, path?.hops ?? [], player.revealed),
    hops,
    follow: () => {},
    ask: () => {},
    clear: () => {},
    playPause: () => {},
    stepBy: () => {},
    replay: () => {},
    seek: () => {},
    showAll: () => {},
    chooseSpeed: () => {},
    choosePath: () => {},
  };
}

function panel(flow: FlowControls | null, view: typeof SHOP = SHOP): string {
  return renderToStaticMarkup(
    createElement(RightPanel, {
      view,
      selectedId: null,
      locks: {},
      onLockChange: () => {},
      onSelect: () => {},
      onOpen: () => {},
      onFollow: () => {},
      onFlow: () => {},
      flow,
    }),
  );
}

describe("the mode the founder asked for", () => {
  it("is on the control with §6's own words", () => {
    expect(MODE_WORDS.flow.name).toBe("흐름 따라가기");
    expect(MODE_WORDS.flow.promise).toBe(
      "고른 곳에서 코드가 어디로 이어지는지, 한 걸음씩 따라가 드려요.",
    );
    expect(words(panel(null))).toContain("흐름 따라가기");
  });

  it("is never called 추적", () => {
    // The feature is 흐름 따라가기 and never 추적: an arrow sliding along a line
    // under that word would be a claim we ran somebody's app.
    for (const value of Object.values(MODE_WORDS.flow)) {
      expect(flowSentenceIssues(String(value))).toEqual([]);
    }
  });

  it("is live from either a typed question or a chosen place", () => {
    // The founder's example is a sentence; the map's selection is the other
    // way in. Requiring both would refuse the question.
    expect(MODE_WORDS.flow.needs).toBe("either");
  });
});

describe("the notice at the top", () => {
  it("says we did not open the app, once, unhidden", () => {
    const html = panel(controls());
    expect(words(html)).toContain(FLOW_NOTICE);
    // Not behind a disclosure triangle: a sentence most people never read is
    // not a sentence the product has said.
    expect(html).not.toMatch(/<details[^>]*>[^]*앱을 실행해 보는 게/);
  });
});

describe("the vocabulary, over everything the panel renders", () => {
  /**
   * `FLOW_NOTICE` is the one string allowed to contain 실행, because it is a
   * **denial** of the thing the word names. `flow.ts` states that exemption and
   * applies `flowSentenceIssues` to everything except it; this does the same.
   */
  function withoutTheNotice(text: string): string {
    return text.split(FLOW_NOTICE).join(" ");
  }

  const screens = [
    ["a walk in progress", panel(controls({ revealed: 2 }))],
    ["a finished walk", panel(controls({ revealed: 4 }))],
    ["a walk from a symbol", panel(controls({ startId: "s-pay", revealed: 3 }))],
    ["a refusal", panel(controls({ startId: "p-stripe" }))],
    [
      "words that matched nothing",
      panel(
        controls({
          question: "배송은 어떻게 되나요",
          session: { missed: noMatchSentence("배송은 어떻게 되나요"), candidates: [] },
        }),
      ),
    ],
    ["nothing chosen", panel(null)],
    [
      "a project with no way in",
      renderToStaticMarkup(
        createElement(NothingSelectedState, {
          view: NO_WAY_IN,
          onSelect: () => {},
          onFollow: () => {},
        }),
      ),
    ],
    [
      "a project read only shallowly",
      renderToStaticMarkup(
        createElement(NothingSelectedState, {
          view: SHALLOW,
          onSelect: () => {},
          onFollow: () => {},
        }),
      ),
    ],
  ] as const;

  for (const [name, html] of screens) {
    it(`keeps the forbidden words off ${name}`, () => {
      const text = withoutTheNotice(words(html));
      expect(text.length).toBeGreaterThan(20);
      expect(flowSentenceIssues(text)).toEqual([]);
      for (const word of FLOW_FORBIDDEN_WORDS) expect(text).not.toContain(word);
    });

    it(`never puts ${name} in the past tense of something having run`, () => {
      // §1: no hop may be phrased as an event that happened. We read code; we
      // did not watch a request go anywhere.
      const text = withoutTheNotice(words(html));
      expect(text).not.toMatch(/지나갔|불렀어요|실행됐|호출했어요|동작했어요/);
    });
  }
});

describe("the path, a step at a time", () => {
  it("shows exactly the steps the player has revealed", () => {
    const two = words(panel(controls({ revealed: 2 })));
    const all = words(panel(controls({ revealed: 4 })));

    // `createOrder` is step 2's landing place; `POST`'s handler is step 4's.
    expect(two).toContain("createOrder");
    expect(two).not.toContain("saveOrder");
    expect(all).toContain("saveOrder");
  });

  it("gives every revealed row its measured sentence straight away", () => {
    /*
     * §5's table: until a better sentence arrives a row shows the **measured**
     * one, never a spinner and never a placeholder. Phase 1 has no better
     * sentence to wait for, so a row with nothing on it would be a defect with
     * no cause.
     */
    const text = words(panel(controls({ revealed: 4 })));

    // The verb and the call site, from `RELATION_WORDS` and `edges.metadata`.
    expect(text).toContain("사용해요");
    expect(text).toContain("34줄");
    // The structural fact a joint states, never "이 주소가 이걸 불러요".
    expect(text).toContain("이 주소는");
    expect(text).toContain("맡고 있어요");
    /*
     * And the target's own line, from `describe.ts` — which has written
     * every one of these since long before this feature, with no model and no
     * Pass 2. The wording is that module's, quoted here rather than corrected:
     * `화면 조각예요` wants a 이 in front of the 에요 and `lib/graph/` is not this
     * wave's to edit.
     */
    expect(text).toContain("화면 조각");
    expect(text).toContain("1곳에서 써요");
  });

  it("holds the ending back until the reader arrives at it", () => {
    // The path is finished before the first step is drawn, so the panel has
    // the ending the whole time. "여기가 끝이에요" beside step 2 of 4 is a
    // contradiction rather than a spoiler.
    const trace = traceFlow(SHOP, { startId: "r-checkout" });
    const ending = trace.path!.text;

    expect(words(panel(controls({ revealed: 2 })))).not.toContain(ending);
    expect(words(panel(controls({ revealed: 4 })))).toContain(ending);
  });

  it("says how many other ways out of the step there were", () => {
    // §1: one path out of many shown alone is a claim that it is the only one.
    // Step 1 is the entry joint: the page holds two pieces and the walk took
    // one of them, so there really were two other ways out.
    expect(words(panel(controls({ revealed: 1 })))).toContain(
      "여기서 갈라지는 다른 길이 2개 더 있어요",
    );
  });

  it("explains the step the map has no line for", () => {
    // A joint is `route → file → symbol` collapsed, so no edge in the graph has
    // its two ends and the map draws nothing. A step missing from the picture
    // is a discrepancy the reader would otherwise have to explain to
    // themselves.
    expect(words(panel(controls({ revealed: 1 })))).toContain("지도에는 잇는 선이 없어요");
  });

  it("labels the whole flow by its weakest link, not its last one", () => {
    // `neighbourhood.ts` rule 2. The fixture's third hop is an `inferred`
    // fetch, so a four-step path that ends on a certain hop is still 짐작이에요.
    const text = words(panel(controls({ revealed: 4 })));
    expect(text).toContain("짐작이에요");
    expect(text).toContain("이 길 네 걸음 중에 한 군데는 짐작이에요");
  });

  it("says the address was a guess where the parser said so", () => {
    expect(words(panel(controls({ revealed: 3 })))).toContain(
      "주소 가운데가 그때그때 바뀌게 적혀 있어서",
    );
  });
});

describe("the transport", () => {
  const html = panel(controls({ revealed: 2, playing: false }));

  it("offers play, both steps, and replay", () => {
    for (const label of ["따라가기", "한 걸음 뒤로", "한 걸음 앞으로", "처음부터"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("changes the one button's word rather than its shape", () => {
    // Two different actions sharing a button, which is how every player does
    // it, and which a changed accessible name announces correctly.
    expect(panel(controls({ revealed: 2, playing: true }))).toContain(
      'aria-label="잠깐 멈추기"',
    );
    expect(panel(controls({ revealed: 4, playing: false }))).toContain(
      'aria-label="처음부터 다시 보기"',
    );
  });

  it("offers 1x and 2x, with one of them on", () => {
    expect(html).toContain(">1x<");
    expect(html).toContain(">2x<");
    expect(html).toContain('aria-label="보통 빠르기로"');
    expect(html).toContain('aria-label="2배 빠르기로"');
  });

  it("has a scrubber that says position rather than progress", () => {
    /*
     * §1 forbids implying duration "by a progress-looking element". Nothing is
     * being waited for: the whole path was computed before step 1 was drawn.
     * So the slider is labelled as a position in a finished path, and the
     * readout counts steps of a total.
     */
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="몇 번째 걸음까지 볼지"');
    expect(words(html)).toContain("2 / 4걸음");
    expect(html).not.toContain("progressbar");
    expect(words(html)).not.toMatch(/초|분|남았|걸려|진행/);
  });

  it("is 44px under the breakpoint, every control of it", () => {
    // D129 took the last sub-44px targets out of this product. These are the
    // newest ones in it.
    const buttons =
      html.match(
        /<button[^>]*aria-label="(따라가기|잠깐 멈추기|한 걸음 뒤로|한 걸음 앞으로|처음부터|보통 빠르기로|2배 빠르기로)"[^>]*>/g,
      ) ?? [];
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button).toMatch(/max-md:h-11|max-md:min-h-11/);
    }
    expect(html).toMatch(/type="range"[^>]*class="[^"]*h-11/);
  });
});

describe("prefers-reduced-motion", () => {
  it("shows the whole path at once and says why", () => {
    const html = panel(controls({ reduced: true }));
    const text = words(html);

    // Everything, not a faster animation of it.
    expect(text).toContain("saveOrder");
    expect(text).toContain("4 / 4걸음");
    expect(text).toContain("움직임을 줄이는 설정이 켜져 있어서");
    // And the ending, because the reader is already at it.
    expect(text).toContain(traceFlow(SHOP, { startId: "r-checkout" }).path!.text);
  });

  it("leaves the controls in place", () => {
    // Stepping through a path by hand is not motion, and is the more careful
    // way to read one anyway.
    const html = panel(controls({ reduced: true }));
    expect(html).toContain('aria-label="한 걸음 뒤로"');
    expect(html).toContain('type="range"');
  });
});

describe("when it cannot answer", () => {
  it("refuses a start that is somebody else's code, and offers a way on", () => {
    const text = words(panel(controls({ startId: "p-stripe" })));
    expect(text).toContain("밖에서 가져온 도구예요");
    expect(text).toContain("이 도구를 쓰는 자리를 골라 주시면");
  });

  it("says when the typed words matched nothing at all", () => {
    const html = panel(
      controls({
        question: "배송기",
        session: {
          missed: noMatchSentence("배송기"),
          candidates: startsForQuestion(SHOP, beam, "구매"),
        },
      }),
    );
    const text = words(html);
    expect(text).toContain("맞는 자리를 지도에서 찾지 못했어요");
    // Never a dead end: the refusal ends by offering the project's own flows.
    expect(text).toContain("따라가 볼 수 있는 흐름");
    expect(text).toContain("따라가 보기");
  });
});

describe("finding this without clicking anything first", () => {
  function discovery(view = SHOP): string {
    return renderToStaticMarkup(
      createElement(NothingSelectedState, {
        view,
        onSelect: () => {},
        onFollow: () => {},
      }),
    );
  }

  it("offers the project's flows, under the feature that claims them", () => {
    const text = words(discovery());
    expect(text).toContain("따라가 볼 수 있는 흐름");
    expect(text).toContain("구매");
    // Named by the label Pass 2 wrote, which is what a person recognises —
    // `/checkout` is on the row only when there is no label for it.
    expect(text).toContain("결제 화면");
    expect(text).toContain("주문 받는 곳");
    expect(text).toContain("따라가 보기");
  });

  it("never offers a feature as a start", () => {
    // `entryPointsOf` refuses one, so a button on a feature would be a button
    // whose only possible answer is a refusal.
    const html = discovery();
    const buttons = html.match(/<button[^>]*>[^]*?<\/button>/g) ?? [];
    const featureButtons = buttons.filter((one) => words(one) === "구매 따라가 보기");
    expect(featureButtons).toHaveLength(0);
  });

  it("says §7's sentence for a project with no way in", () => {
    // The common case: three of the four real projects on 2026-09-21.
    const text = words(discovery(NO_WAY_IN));
    expect(text).toContain("이 프로젝트에서는 아직 시작점을 찾지 못했어요");
    expect(text).toContain("파일을 하나 골라 주시면");
  });

  it("says the more specific sentence, with the project's own number", () => {
    const text = words(discovery(SHALLOW));
    expect(text).toContain("읽은 연결 2개는 모두");
    expect(text).toContain("순서대로 따라가 드리긴 어려워요");
  });

  it("uses the map's own sentence where no feature has been named", () => {
    const unnamed = { ...SHOP, items: SHOP.items.filter((one) => one.kind !== "feature") };
    expect(words(discovery(unnamed))).toContain(
      "기능 이름은 아직 붙이기 전이에요. 이름이 붙으면 여기서 기능별로 볼 수 있어요.",
    );
  });

  it("is left out entirely when nothing can start a flow", () => {
    // The same rule `onOpen` follows: an affordance with nothing behind it is
    // worse than no affordance.
    const html = renderToStaticMarkup(
      createElement(NothingSelectedState, { view: SHOP, onSelect: () => {} }),
    );
    expect(words(html)).not.toContain("따라가 볼 수 있는 흐름");
  });
});

describe("who wrote each sentence", () => {
  it("marks the step a model wrote, and only that one", () => {
    /*
     * §5: the UI has to be able to say who wrote a sentence, exactly as
     * `Description.fromModel` draws the same line. An arithmetic sentence and a
     * model's look alike and must not read alike — the reader cannot check
     * either one, and is entitled to know which of the two they are reading.
     */
    const html = panel(controls({ revealed: 4 }));
    const text = words(html);

    // Pass 3's sentence for the one connection that has one.
    expect(text).toContain("주문 내용을 서버로 보내요");
    expect(html.match(/모델이 쓴 말/g) ?? []).toHaveLength(2); // the row's tag, and the note under the list
    expect(text).toContain("표시가 없는 줄은 읽은 것만 가지고 적은 거예요");
  });

  it("says nothing about a model on a path no model touched", () => {
    // Every hop before the third is `measured`, so a flow that stops short of
    // the marked one carries no mark and no note at all.
    const html = panel(controls({ revealed: 2 }));
    expect(html).not.toContain("모델이 쓴 말");
  });

  it("never marks a joint, because a joint is not a connection", () => {
    // There is no edge for a purpose to be about. Step 1 is the entry joint.
    const trace = traceFlow(SHOP, { startId: "r-checkout" });
    expect(trace.path!.hops[0].narrator).toBe("measured");
    expect(trace.path!.hops[3].narrator).toBe("measured");
    expect(trace.path!.hops[2].narrator).toBe("purpose");
  });

  it("keeps the model's sentence inside the vocabulary too", () => {
    const text = words(panel(controls({ revealed: 4 })));
    expect(flowSentenceIssues(text.split(FLOW_NOTICE).join(" "))).toEqual([]);
  });
});

describe("an address we worked out rather than read", () => {
  /**
   * Every Streamlit route in production, and the walk cannot say it: the entry
   * joint is `certain` because reversing a `contains` is a structural fact
   * rather than a claim, which is the right answer to the question the joint is
   * asking and leaves this one unasked.
   */
  const html = panel(controls({ revealed: 4 }), GUESSED_ADDRESS);

  it("says the start itself is a guess", () => {
    expect(words(html)).toContain("이 주소가 있다는 것부터가 짐작이에요");
  });

  it("pulls the whole flow's label down with it", () => {
    // The weakest link, and the start is part of the chain: if we are not sure
    // the address is there, nothing that follows from it is surer.
    expect(words(html)).toContain("짐작이에요 · 모두 4걸음");
  });

  it("leaves a certain address alone", () => {
    expect(words(panel(controls({ revealed: 4 })))).not.toContain(
      "이 주소가 있다는 것부터가",
    );
  });
});

describe("the question, as the person wrote it", () => {
  it("is echoed back exactly, even when their words are ones we would not use", () => {
    /*
     * The vocabulary rule is about **our** sentences. 추적 is a word this
     * product never uses about itself, and a person is perfectly entitled to
     * type it — rewriting what somebody asked so it matches our house style
     * would be a worse dishonesty than the one the rule prevents, because they
     * would no longer be able to tell what question was answered.
     *
     * `walk-view.tsx` prints `session.question` the same way for the same
     * reason.
     */
    const asked = "배송 추적은 어떻게 되나요";
    const html = panel(
      controls({ question: asked, session: { missed: noMatchSentence(asked) } }),
    );
    expect(words(html)).toContain(asked);
  });
});

describe("one screen, one meaning", () => {
  it("gives the panel over to the flow while one is showing", () => {
    // A path and a neighbourhood are two answers to "what am I looking at",
    // and both at once leaves the reader to work out which one their question
    // produced.
    const text = words(panel(controls()));
    expect(text).not.toContain("이 프로젝트의 지도");
    expect(text).toContain("여기서부터");
  });

  it("offers a way to hand it back", () => {
    expect(words(panel(controls()))).toContain("그만 보기");
  });
});
