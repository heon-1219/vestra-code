/**
 * What the request box is *for*, as a choice the user makes.
 *
 * It was two buttons side by side — 물어보기 and 프롬프트 만들기 — and the founder
 * asked for a third: "물어보기 / 프롬프트 만들기 / 설명하기 이렇게 모드를 고를 수 있게
 * 하자. 다 따로 버튼을 만들지말고, 모드를 그냥 고를 수 있게." A button per mode means
 * the footer grows a button every time the product learns to do one more thing,
 * and the user reads a row of verbs with no way to tell which one they are in.
 * One choice and one action reads as a single sentence instead: 이걸로, 이것을.
 *
 * ## Why the words live here and not in the component
 *
 * Each mode carries the one sentence that says what it does, so the control can
 * render three options without knowing what any of them means, and so the
 * sentence the user reads and the mode the code branches on can never drift
 * apart. Adding a fourth mode is a row in this file.
 *
 * ## The part that is not decoration
 *
 * Section 3's rule — we never say something works when it does not — is why
 * every mode carries `notYet` as well as `promise`: while a mode has no handler
 * behind it, the panel says what *that* mode will do and that it cannot do it
 * yet, in that mode's own words. It replaces one generic "묻고 답하기와 프롬프트
 * 만들기는 아직 준비 중이에요", which told someone nothing about the thing they had
 * just chosen. D68 is the precedent: a sentence we could not back reached the
 * founder's own site, and a per-mode sentence is harder to get wrong than a
 * shared one.
 *
 * **This file used to say flatly that none of its modes works — "There is no
 * model wired up behind any of them" — and that premise has expired.**
 * `lib/llm/config.ts` and `client.ts` exist and `qa/loop.ts` is built and
 * tested, so the claim is no longer true of the whole file. It is corrected
 * here only for 흐름 따라가기, which is the one mode this wave wired; whether
 * 물어보기 / 프롬프트 만들기 / 설명하기 still need their apology is a question about
 * screens somebody else owns, and answering it from here would be this file
 * making a claim about work it has not seen.
 *
 * 흐름 따라가기 is also the one mode whose promise **needs no model at all.** The
 * walk is `lib/graph/flow.ts` over a graph the browser already holds: zero
 * model calls, warm or cold (`FLOW_TRACKING.md` §4). Its `notYet` is therefore
 * not a wait for a key — it is what a screen that does not hand this mode a
 * handler should say, and the workspace always hands it one.
 */

/** The four things the box can be pointed at. */
export type PanelMode = "ask" | "prompt" | "explain" | "flow";

/**
 * 물어보기 opens the panel, because it is the only one of the three that needs
 * nothing explained first — someone who has just clicked a thing on the map
 * already has a question, and may not yet know what a 프롬프트 is.
 */
export const DEFAULT_PANEL_MODE: PanelMode = "ask";

/**
 * Every mode, in the order the control lists them.
 *
 * 흐름 따라가기 goes last rather than beside 설명하기, which it is closest to in
 * meaning. The row wraps at this column's width (240px at its narrowest), and a
 * wrapped row reads top-to-bottom: putting the one mode that works in the
 * middle would leave the first line a pair of promises and the second line the
 * thing that answers. Last is also where it is found by someone reading along
 * and not finding what the first three offer.
 */
export const PANEL_MODES: readonly PanelMode[] = ["ask", "prompt", "explain", "flow"];

export type ModeWords = {
  /** The word on the control, and on the button that runs it. */
  name: string;
  /** What this mode does, in one sentence, once it does it. */
  promise: string;
  /**
   * The same sentence while it is still only a promise. Says what the mode will
   * do *and* that it cannot yet — both, because either half alone is a lie by
   * omission.
   */
  notYet: string;
  /**
   * What this mode needs before its button can do anything. 설명하기 works on the
   * thing already chosen on the map, so waiting for typed text would leave its
   * button dead next to a sentence promising it explains 고른 것.
   *
   * `either` is 흐름 따라가기's, and it is a third value rather than a branch on
   * the mode name inside the box for the reason this whole table exists: the
   * control renders its options without knowing what any of them means, and a
   * component that asked "is this the flow one?" would be the first place the
   * sentence a user reads and the rule the code runs could drift apart. A flow
   * starts from a typed question — "이 구매 기능 어떻게 동작하는지 말해줘", the
   * founder's own example — resolved against the map by the same beam that
   * lights it, or from whatever is already chosen. Requiring both would refuse
   * the question; requiring only the selection would leave the box that the
   * question goes in doing nothing.
   */
  needs: "text" | "selection" | "either";
};

/**
 * Written in parallel — same shape, same order of clauses — so the four read
 * as one set of choices rather than four unrelated features, and so the
 * difference between them is the only thing that stands out.
 *
 * 물어보기 and 설명하기 are close enough to be worth separating out loud: 물어보기
 * answers a question the user brings, 설명하기 answers the question they did not
 * know how to ask about the thing they just clicked. The sentences carry that
 * difference in their first clause.
 *
 * 흐름 따라가기 is the fourth, and its sentence is `FLOW_TRACKING.md` §6's,
 * unchanged. It is **흐름 따라가기 and never 추적**: the product reads code and
 * writes down which place reaches for which, and never runs anybody's app. 한
 * 걸음씩 is the whole feature in two words — the path is computed before the
 * first step is drawn, and shown a step at a time because that is how a person
 * reads a path, not because anything is still being worked out.
 */
export const MODE_WORDS: Record<PanelMode, ModeWords> = {
  ask: {
    name: "물어보기",
    promise: "궁금한 걸 적어서 물어보면, 읽은 것만 가지고 답해 드려요.",
    notYet: "궁금한 걸 적어서 물어보면 읽은 것만 가지고 답해 드릴 거예요. 답하는 건 아직 준비 중이에요.",
    needs: "text",
  },
  prompt: {
    name: "프롬프트 만들기",
    promise: "바꾸고 싶은 걸 적으면, 열어 둔 것만 고치라고 적힌 글을 만들어 드려요.",
    notYet:
      "바꾸고 싶은 걸 적으면 열어 둔 것만 고치라고 적힌 글을 만들어 드릴 거예요. 만드는 건 아직 준비 중이에요.",
    needs: "text",
  },
  explain: {
    name: "설명하기",
    promise: "고른 것이 무슨 일을 하는지, 평소 쓰는 말로 풀어 드려요.",
    notYet:
      "고른 것이 무슨 일을 하는지 평소 쓰는 말로 풀어 드릴 거예요. 풀어 드리는 건 아직 준비 중이에요.",
    needs: "selection",
  },
  flow: {
    name: "흐름 따라가기",
    promise: "고른 곳에서 코드가 어디로 이어지는지, 한 걸음씩 따라가 드려요.",
    /*
     * Kept, and reached only by a screen that does not hand this mode a
     * handler. The workspace always does, so what a user sees is the promise.
     * Written anyway because `notYet` is what the panel falls back to, and a
     * mode with an empty one would show nothing at all where every other mode
     * shows a sentence.
     */
    notYet:
      "고른 곳에서 코드가 어디로 이어지는지 한 걸음씩 따라가 드릴 거예요. 따라가는 건 아직 준비 중이에요.",
    needs: "either",
  },
};
