import { KIND_WORDS } from "./words";

import type { OutlineEntry, OutlineFile } from "./outline";
import type { NamingTarget } from "./select";

/**
 * What the model is actually shown.
 *
 * Two questions, deliberately separate, because they want different context and
 * fail differently.
 *
 *   - **Naming**, in batches. One file per block, with the pieces inside it and
 *     the handful of facts that make its job guessable. A batch that truncates
 *     costs that batch and nothing else.
 *   - **Features**, once. One line per file over the whole project, because a
 *     feature is a claim about the shape of the thing and cannot be made from a
 *     twentieth of it.
 *
 * **No source text, anywhere.** Section 6.2 says so and D52 measured why: a
 * 300-file project outlines to ~12k tokens and reads as ~100k. It is also the
 * trust line — D49 keeps this pass off the user's own prose precisely so that a
 * file inside the repository cannot influence what we tell its owner their app
 * contains. A path, a symbol name and an import count are facts we derived; a
 * README is the repository talking.
 *
 * Everything the model may refer to carries an integer (D46). Nothing in either
 * prompt contains a node id.
 */

/**
 * The rules, restated for the model in the language the answer has to be in.
 *
 * Numbered because a numbered rule is one a model keeps; every one of them has
 * a matching check in `parse.ts`, and the check is what actually holds. A rule
 * here without a check there is decoration.
 */
export const NAMING_SYSTEM_PROMPT = [
  "당신은 코드를 못 읽는 사람에게 이 프로젝트가 뭘로 이루어져 있는지 알려 주는 사람이에요.",
  "",
  "지켜야 할 것.",
  "1. 모두 한국어로 써요. 영어 단어를 그대로 옮겨 적지 마세요.",
  "2. 이름(label)은 파일 이름을 번역한 게 아니라, 그게 하는 일을 부르는 말이어야 해요.",
  "   PayButton.tsx → “결제 버튼”, useCart.ts → “장바구니 기억해 두는 곳”.",
  "3. 설명(summary)은 한 문장이고, 반드시 해요체로 끝나요. “…해요.”, “…이에요.”",
  "4. 이름은 20자 안쪽, 설명은 한 문장 안쪽으로 짧게 써요.",
  "5. '안전', '노드', '엣지'라는 말은 쓰지 마세요.",
  "6. 번호는 보내 드린 것만 써요. 모르겠으면 그 번호는 빼고 답하세요. 지어내지 마세요.",
  "",
  "JSON만 답해요. 설명은 넣지 마세요.",
  '{"items":[{"i":3,"label":"결제 버튼","summary":"결제를 눌렀을 때 주문을 넣어요."}]}',
].join("\n");

export const FEATURE_SYSTEM_PROMPT = [
  "당신은 이 프로젝트가 어떤 기능들로 이루어져 있는지 정리해 주는 사람이에요.",
  "",
  "지켜야 할 것.",
  "1. 기능 이름은 결제, 로그인, 장바구니처럼 앱을 쓰는 사람이 아는 말이어야 해요.",
  "   AuthProvider, api, utils 같은 코드 쪽 이름은 기능 이름이 아니에요.",
  "2. 모두 한국어로 써요. 이름은 15자 안쪽이에요.",
  "3. 설명(summary)은 한 문장이고, 반드시 해요체로 끝나요.",
  "4. 기능은 3개에서 12개 사이로 묶어요. 하나에 다 넣지 마세요.",
  "5. files에는 보내 드린 번호만 넣어요. 없는 번호는 지어내지 마세요.",
  "6. 어디에도 넣기 애매한 파일은 그냥 빼세요. 억지로 넣지 마세요.",
  "7. '안전', '노드', '엣지'라는 말은 쓰지 마세요.",
  "",
  "JSON만 답해요. 설명은 넣지 마세요.",
  '{"features":[{"name":"결제","summary":"물건 값을 받는 일을 해요.","files":[3,7,12]}]}',
].join("\n");

/** The shape sent as `json_schema`, honoured only where the endpoint has it (D47). */
export const NAMING_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          label: { type: "string" },
          summary: { type: "string" },
        },
        required: ["i", "label"],
      },
    },
  },
  required: ["items"],
};

export const FEATURE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    features: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
          files: { type: "array", items: { type: "integer" } },
        },
        required: ["name", "files"],
      },
    },
  },
  required: ["features"],
};

/**
 * One naming request.
 *
 * Returns the indices it sent alongside the text. The parser takes that set
 * and refuses anything outside it — which is the whole of "drop any id that
 * does not exist", reduced to a set membership test by D46's integers.
 */
export function buildNamingPrompt(targets: readonly NamingTarget[]): {
  text: string;
  /** Indices the model is allowed to answer about. */
  allowed: Set<number>;
  /** Of those, the ones that are files and therefore also want a summary. */
  files: Set<number>;
} {
  const allowed = new Set<number>();
  const files = new Set<number>();
  const blocks: string[] = [];

  for (const { file, pieces } of targets) {
    allowed.add(file.index);
    files.add(file.index);

    const lines = [`[${file.index}] ${file.filePath}`];

    if (file.addresses.length > 0) {
      lines.push(`    여는 주소: ${file.addresses.join(", ")}`);
    }
    if (file.importedBy > 0) {
      lines.push(`    ${file.importedBy}개 파일이 이걸 가져다 써요`);
    }
    if (file.pointsAt.length > 0) {
      lines.push(`    이 파일이 쓰는 것: ${file.pointsAt.slice(0, 6).join(", ")}`);
    }
    if (file.packages.length > 0) {
      lines.push(`    밖에서 가져온 것: ${file.packages.slice(0, 6).join(", ")}`);
    }

    for (const piece of pieces) {
      allowed.add(piece.index);
      lines.push(`    [${piece.index}] ${piece.name} (${wordFor(piece)})`);
    }

    blocks.push(lines.join("\n"));
  }

  const text = [
    "파일마다 한국어 이름(label)과 한 문장 설명(summary)을 붙여 주세요.",
    "안쪽에 번호가 붙은 조각이 있으면, 그 조각에는 label만 붙이면 돼요.",
    "",
    blocks.join("\n\n"),
  ].join("\n");

  return { text, allowed, files };
}

/**
 * The one feature request.
 *
 * A file already named in an earlier batch is shown by its Korean name rather
 * than only its path, because the naming pass is the cheaper, more local
 * question and its answers are better evidence than a folder name. It costs
 * nothing: the line is one string either way.
 */
export function buildFeaturePrompt(files: readonly OutlineFile[]): {
  text: string;
  allowed: Set<number>;
} {
  const allowed = new Set<number>();
  const lines: string[] = [];

  for (const file of files) {
    allowed.add(file.index);
    const parts = [`[${file.index}] ${file.filePath}`];
    if (file.label) parts.push(`— ${file.label}`);
    if (file.addresses.length > 0) parts.push(`(주소: ${file.addresses.join(", ")})`);
    lines.push(parts.join(" "));
  }

  const text = [
    "이 프로젝트의 파일 목록이에요. 어떤 기능들로 이루어져 있는지 묶어 주세요.",
    "",
    lines.join("\n"),
  ].join("\n");

  return { text, allowed };
}

function wordFor(piece: OutlineEntry): string {
  if (piece.kind === "route") return KIND_WORDS.route;
  if (piece.kind === "api_endpoint") return KIND_WORDS.api_endpoint;
  return KIND_WORDS[piece.shape ?? "function"] ?? KIND_WORDS.function;
}
