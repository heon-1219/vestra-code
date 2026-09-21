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
 * model wired up behind any of them" — and that premise has expired.** Every
 * mode has a handler behind it now, and the workspace hands each one over:
 * 물어보기 runs the investigation loop (`qa/loop.ts`); 흐름 따라가기 walks the
 * graph in the browser (`lib/graph/flow.ts`); 프롬프트 만들기 builds its prompt
 * from the graph with a template (`lib/prompt/build.ts`) and uses a model only
 * to restate the goal, and builds it without one when none is connected;
 * 설명하기 answers first from what the graph already holds, with no model at
 * all (`explain/known.ts`), and runs the same loop pointed at one place only
 * when the person asks for the deep read. What a user sees for all four is the
 * `promise`. `notYet` stays, per mode, for a screen that does not hand a mode
 * its handler — the panel's own fallback — and so that such a screen still
 * says something true rather than nothing.
 *
 * 흐름 따라가기 is the one mode that **never calls a model, on any path.** (설명하기
 * does not either until its deep read is asked for, and 프롬프트 만들기 works
 * without one; both can use one.) The walk is `lib/graph/flow.ts` over a graph the browser already holds: zero
 * model calls, warm or cold (`FLOW_TRACKING.md` §4). Its `notYet` is therefore
 * not a wait for a key — it is what a screen that does not hand this mode a
 * handler should say, and the workspace always hands it one.
 */

import type { ItemKind } from "@/lib/graph/view";

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
   *
   * `both` is 프롬프트 만들기's. A prompt is instructions about a place — its
   * 바꿀 곳, 고쳐도 되는 것 and 건드리지 말 것 are all read off the selection
   * and its switches — so a request with nothing selected has nowhere to be
   * about, and a request-less selection has nothing to ask for.
   */
  needs: "text" | "selection" | "either" | "both";
  /**
   * What the footer says when this mode needs a selection and there is none.
   *
   * Without it the send button sat greyed out beside a sentence promising the
   * mode would work, and nothing said the missing piece was a click on the
   * map. Only the modes that need a selection have one.
   */
  pick?: string;
  /**
   * Kinds of selection this mode cannot act on, each with the sentence that
   * says why and what to pick instead.
   *
   * 프롬프트 만들기's, for two kinds. A feature is a grouping a model made and a
   * package is somebody else's code, and neither is a place an agent can be
   * sent to change — yet both are one click away on the map, and 기능 is the
   * sidebar's first tab. Without this, a feature produced a prompt whose 바꿀 곳
   * was its internal id (`feature:1c8e949eccd7`), and a package one that gave
   * an agent permission to edit `dotenv`. Data rather than a branch in the box,
   * for the reason `needs` is.
   */
  cannot?: Partial<Record<ItemKind, string>>;
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
    needs: "both",
    pick: "지도에서 바꿀 곳을 먼저 골라 주세요.",
    cannot: {
      feature:
        "기능은 저희가 묶어 둔 이름이라서 고칠 코드가 따로 없어요. 기능 안에 있는 것을 하나 골라 주세요.",
      package:
        "밖에서 가져온 도구는 이 프로젝트에서 고칠 코드가 아니에요. 이 도구를 쓰는 곳을 하나 골라 주세요.",
    },
  },
  explain: {
    name: "설명하기",
    promise: "고른 것이 무슨 일을 하는지, 평소 쓰는 말로 풀어 드려요.",
    notYet:
      "고른 것이 무슨 일을 하는지 평소 쓰는 말로 풀어 드릴 거예요. 풀어 드리는 건 아직 준비 중이에요.",
    needs: "selection",
    pick: "지도에서 설명을 들을 곳을 먼저 골라 주세요.",
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
