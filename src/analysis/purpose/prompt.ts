import { KIND_WORDS } from "../semantic/words";

import type { PurposeAsk } from "./ask";

/**
 * What the model is shown when it is asked what a connection is for.
 *
 * One question, asked in batches. Each block is one purpose — a relation and
 * the thing on the far end — and the answer is one sentence that will be shown
 * beside **every** connection that shares it. Twelve components calling
 * `formatPrice` read the same words, which is the founder's own requirement and
 * matters more for trust than for cost: a map that words one fact twelve ways
 * is a map nobody believes.
 *
 * **No source text, anywhere.** D49 and §6.2, the same line Pass 2 draws. A
 * path, a symbol name, a count and the Korean Pass 2 already wrote are facts we
 * derived. A file's own prose is the repository talking, and a repository must
 * not be able to influence what we tell its owner their code does.
 *
 * Every rule below has a matching check in `parse.ts`. A rule here without a
 * check there is decoration.
 */
export const PURPOSE_SYSTEM_PROMPT = [
  "당신은 코드를 못 읽는 사람에게, 이 프로그램의 한 부분이 다른 부분을 왜 쓰는지 알려 주는 사람이에요.",
  "",
  "지켜야 할 것.",
  "1. 번호마다 한 문장이에요. 반드시 해요체로 끝나요. “…해요.”, “…이에요.”",
  "2. 이름을 옮겨 적지 말고, 그걸 써서 무슨 일이 되는지 써요.",
  "   formatPrice → “여기서 가격을 사람이 읽기 좋은 모양으로 바꿔요.”",
  "   useCart → “장바구니에 담긴 걸 여기서 꺼내 써요.”",
  "3. 모두 한국어로 써요. 코드에 있는 영어 이름을 그대로 쓰지 마세요.",
  "4. 30자 안쪽으로 짧게 써요. 목록의 한 줄에 들어가야 해요.",
  "5. '안전', '노드', '엣지', '실행', '추적', '실시간'이라는 말은 쓰지 마세요.",
  "6. 번호는 보내 드린 것만 써요. 없는 번호를 지어내지 마세요.",
  "7. 모르겠으면 그 번호는 빼고 답하세요. 그럴듯하게 지어내는 것보다 비워 두는 게 나아요.",
  "",
  "JSON만 답해요. 설명은 넣지 마세요.",
  '{"items":[{"i":3,"why":"여기서 가격을 사람이 읽기 좋은 모양으로 바꿔요."}]}',
].join("\n");

/** The shape sent as `json_schema`, honoured only where the endpoint has it (D47). */
export const PURPOSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          why: { type: "string" },
        },
        required: ["i", "why"],
      },
    },
  },
  required: ["items"],
};

/**
 * How each relation is put to the model.
 *
 * The same words `RELATION_WORDS` shows the user, so the question is asked in
 * the vocabulary the answer will be read in — and so a model handed a graph is
 * never taught the graph's own words. `contains` and `belongs_to` are absent
 * because `groups.ts` refuses to explain them at all.
 */
const RELATION_ASKED: Record<string, string> = {
  calls: "이걸 불러다 써요",
  renders: "이걸 화면에 그려요",
  fetches: "이 주소로 데이터를 주고받아요",
  imports: "이 파일을 가져다 써요",
  uses_package: "이 바깥 도구를 가져다 써요",
};

/**
 * One request.
 *
 * Returns the indices it sent alongside the text. The parser takes that set
 * and refuses anything outside it, which is the whole of "drop any id that does
 * not exist" reduced to a membership test by D46's integers.
 */
export function buildPurposePrompt(asks: readonly PurposeAsk[]): {
  text: string;
  allowed: Set<number>;
} {
  const allowed = new Set<number>();
  const blocks: string[] = [];

  for (const ask of asks) {
    allowed.add(ask.index);

    const what = ask.targetLabel
      ? `${ask.targetLabel} (${ask.targetName})`
      : ask.targetName;
    const lines = [`[${ask.index}] ${RELATION_ASKED[ask.relation] ?? "이걸 써요"}: ${what}`];

    lines.push(`    무엇: ${wordFor(ask)}`);
    if (ask.targetSummary) lines.push(`    이미 알고 있는 것: ${ask.targetSummary}`);
    if (ask.targetPath !== "") {
      lines.push(
        ask.homeLabel
          ? `    사는 곳: ${ask.targetPath} (${ask.homeLabel})`
          : `    사는 곳: ${ask.targetPath}`,
      );
    }
    lines.push(`    ${ask.sources}곳에서 이걸 써요`);
    if (ask.examples.length > 0) {
      lines.push(`    예를 들면: ${ask.examples.join(", ")}`);
    }

    blocks.push(lines.join("\n"));
  }

  const text = [
    "아래는 이 프로젝트 안에서 반복되는 연결이에요.",
    "번호마다, 이 연결이 무슨 일을 하는 건지 한 문장으로 알려 주세요.",
    "",
    blocks.join("\n\n"),
  ].join("\n");

  return { text, allowed };
}

/** The word the map uses for this kind of thing, so both say it the same way. */
function wordFor(ask: PurposeAsk): string {
  if (ask.targetKind === "symbol") {
    return KIND_WORDS[ask.targetShape ?? "function"] ?? KIND_WORDS.function;
  }
  return KIND_WORDS[ask.targetKind] ?? KIND_WORDS.file;
}
