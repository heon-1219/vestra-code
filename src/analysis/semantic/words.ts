/**
 * The Korean this pass is allowed to use, and the Korean it may not produce.
 *
 * Restated here rather than imported, for the reason `python/llm.ts` gives for
 * the same three words: `src/qa/answer.ts` reaches `src/qa/tools.ts`, which
 * imports the workspace map components, and an analyzer that pulled a React
 * component tree into itself could no longer be run from a plain test. That is
 * the one property the `Analyzer` signature exists to protect, and Pass 2 has
 * to keep it too — `src/lib/graph/view.ts` is import-free today and is a shared
 * boundary file several agents edit.
 *
 * Six words and three prohibitions is a cheap thing to keep in step. If a
 * fourth forbidden word is ever added it belongs in `qa/answer.ts`,
 * `python/llm.ts` and here.
 */

/**
 * `안전` because the product may never tell someone a change is safe. `노드` and
 * `엣지` because past `lib/graph/view.ts` a thing is a 조각 and a link is a 연결,
 * and a model handed a graph reaches for the graph's words.
 */
export const FORBIDDEN_WORDS = ["안전", "노드", "엣지"] as const;

/**
 * Three more, for a sentence that will be read as a step in 흐름 따라가기.
 *
 * D78: the feature narrates a path the code makes possible, and it never runs
 * anybody's code. 실행 · 추적 · 실시간 are the words that would quietly turn it
 * into a claim we do not make, so `lib/graph/flow.ts` refuses them in every
 * flow sentence — including one a model wrote, which is what `purpose/` now
 * produces. Kept here beside the other three rather than imported from
 * `flow.ts`, which reaches `qa/answer.ts` and from there the workspace
 * components: an analysis pass that pulled a React tree into itself could no
 * longer be run from a plain test, and that is the one property the `Analyzer`
 * signature exists to protect. `purpose/parse.test.ts` pins this list against
 * `FLOW_FORBIDDEN_WORDS` so the copy cannot drift.
 */
export const FLOW_FORBIDDEN_EXTRA = ["실행", "추적", "실시간"] as const;

/**
 * What each kind of thing is called on screen. The same words `KIND_WORDS` and
 * `grouping.ts`'s `JOB_WORDS` use, so the prompt teaches the model the
 * vocabulary the map will show its answer in.
 */
export const KIND_WORDS: Record<string, string> = {
  file: "파일",
  symbol: "조각",
  route: "페이지",
  api_endpoint: "서버 주소",
  package: "외부 도구",
  feature: "기능",
  component: "화면 조각",
  hook: "화면 도우미",
  function: "일 처리",
  class: "설계도",
  type: "정해 둔 모양",
  style_rule: "꾸미기",
};

/**
 * The language tag written onto every row this pass produces.
 *
 * D2: the tag exists from the first migration so that English can be added
 * later as a fallback to these columns rather than as a migration over live
 * data. Writing it is therefore not optional bookkeeping — a row without it is
 * a row a second language cannot be added beside.
 */
export const TEXT_LANG = "ko";
