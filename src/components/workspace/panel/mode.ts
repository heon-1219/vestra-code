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
 * **None of these three works yet.** There is no model wired up behind any of
 * them. Section 3's rule — we never say something works when it does not — is
 * why every mode carries `notYet` as well as `promise`: while a mode has no
 * handler behind it, the panel says what *that* mode will do and that it cannot
 * do it yet, in that mode's own words. It replaces one generic "묻고 답하기와
 * 프롬프트 만들기는 아직 준비 중이에요", which told someone nothing about the thing
 * they had just chosen. D68 is the precedent: a sentence we could not back
 * reached the founder's own site, and a per-mode sentence is harder to get
 * wrong than a shared one.
 */

/** The three things the box can be pointed at. */
export type PanelMode = "ask" | "prompt" | "explain";

/**
 * 물어보기 opens the panel, because it is the only one of the three that needs
 * nothing explained first — someone who has just clicked a thing on the map
 * already has a question, and may not yet know what a 프롬프트 is.
 */
export const DEFAULT_PANEL_MODE: PanelMode = "ask";

/** Every mode, in the order the control lists them. */
export const PANEL_MODES: readonly PanelMode[] = ["ask", "prompt", "explain"];

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
   */
  needs: "text" | "selection";
};

/**
 * Written in parallel — same shape, same order of clauses — so the three read
 * as one set of choices rather than three unrelated features, and so the
 * difference between them is the only thing that stands out.
 *
 * 물어보기 and 설명하기 are close enough to be worth separating out loud: 물어보기
 * answers a question the user brings, 설명하기 answers the question they did not
 * know how to ask about the thing they just clicked. The sentences carry that
 * difference in their first clause.
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
};
