import type { GraphItem } from "@/lib/graph/view";

import { kindTally } from "./tools";

/**
 * What the model is told before it starts, and nothing more.
 *
 * The temptation with a graph in hand is to send the graph. D52 measured that
 * on a 300-file repo an outline is 12k tokens even after every saving worth
 * making — and an outline is the wrong thing anyway. A model handed the whole
 * map answers from the map, which is precisely the single-shot answer this loop
 * exists to replace. It gets a map it must walk instead: a sentence about the
 * size of the project, the folders it starts from, and four tools.
 *
 * Roughly four hundred tokens, re-sent on every turn. Every line in it is
 * either a rule the answer is checked against — so the model can pass a check
 * it knows about — or orientation it would otherwise spend a step discovering.
 *
 * Korean, because the answer must be Korean and a model asked in one language
 * for an answer in another spends part of its reply switching. The rules read
 * like the product's own voice for the same reason: 해요체 in the prompt is what
 * 해요체 in the answer sounds like.
 */

export type SystemPromptInput = {
  items: readonly GraphItem[];
  /** False when this project's files cannot be opened at all. */
  hasSource: boolean;
};

export function buildSystemPrompt(input: SystemPromptInput): string {
  const files = input.items.filter((item) => item.kind === "file");
  const folders = topFolders(files);

  const rules = [
    "당신은 코드를 직접 읽지 못하는 사람 대신, 증상 하나를 붙잡고 원인을 찾아보는 조사자예요.",
    "",
    "이렇게 일해요.",
    "1. 짐작하지 말고 열어보세요. 한 번에 도구 하나만 부르고, 부를 때마다 why에 지금 무엇을 확인하려는지 한 문장으로 적어요. 앞 결과에서 알게 된 건 learned에 한 문장으로 적어요.",
    "2. 처음 떠오른 파일이 답이 아닐 때가 많아요. 열어보고 아니면 그렇다고 적고 다음으로 넘어가요.",
    "3. 읽지 않은 곳은 말하지 마세요. report의 항목마다 실제로 열어본 파일과 줄 번호를 붙여요. 붙일 게 없으면 그 항목은 빼요.",
    input.hasSource
      ? "4. certainty는 둘 중 하나예요. read_source로 그 줄을 직접 읽고 확인했으면 certain, 이름이나 연결만 보고 짐작한 거면 inferred. 셋째 값은 없어요."
      : "4. 이 프로젝트는 파일을 직접 열어볼 수 없어요. 지도에 있는 이름과 연결만 볼 수 있으니 certainty는 모두 inferred예요.",
    "5. certain 항목에는 '아마', '…인 것 같아요' 같은 말을 쓰지 마세요. 짐작이면 inferred예요.",
    "6. 답은 한국어 해요체로, 코드를 모르는 사람이 읽을 수 있게 써요. 파일은 장소처럼 부르고, 줄 번호는 그대로 적어요.",
    "7. 사용자의 코드를 탓하지 마세요. '안전하다'는 말은 쓰지 마세요. '노드', '엣지' 대신 '조각', '연결'이라고 해요.",
    "8. 다 확인했거나 남은 걸음이 얼마 없으면 report를 부르세요. 원인을 못 찾았으면 못 찾았다고 적어요. 그것도 답이에요.",
    "",
    `이 프로젝트: 파일 ${files.length}개, 전체 ${input.items.length}개 (${kindTally(input.items)}).`,
  ];

  if (folders.length > 0) {
    rules.push(
      `맨 위 폴더: ${folders.map((f) => `${f.folder} (${f.files})`).join(", ")}.`,
    );
  }

  return rules.join("\n");
}

/**
 * Where the project starts, so the first step is not spent asking.
 *
 * Eight at most and with counts, because the counts are what make it useful:
 * `src/ (214)` beside `public/ (3)` tells the model where the app is without a
 * listing. Files at the root are named as a group rather than listed — a
 * `package.json` is rarely the answer and always in the way.
 */
function topFolders(
  files: readonly GraphItem[],
): { folder: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (!file.path) continue;
    const cut = file.path.indexOf("/");
    const folder = cut === -1 ? "(맨 위)" : file.path.slice(0, cut + 1);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([folder, files]) => ({ folder, files }));
}

/**
 * The budget, told to the model rather than sprung on it.
 *
 * Eight tokens on the end of every tool result, and it buys the difference
 * between a loop that stops mid-thought and one that files what it has. A model
 * that does not know it is on its last step spends it opening a fifth file.
 */
export function stepsLeftNote(left: number): string {
  if (left <= 0) return "\n(남은 걸음이 없어요. 지금 report로 마무리해 주세요.)";
  if (left === 1) return "\n(남은 걸음 1번. 다음 차례에는 report로 마무리해 주세요.)";
  return `\n(남은 걸음 ${left}번)`;
}

/**
 * What we say when the model answers in prose instead of calling anything.
 *
 * One nudge, not a conversation. Prose is the model trying to give the answer
 * the way it usually does, and the answer has a shape here for a reason — but a
 * loop that keeps asking burns a user's budget on etiquette.
 */
export const NUDGE =
  "도구를 부르거나 report로 마무리해 주세요. 글로만 답하면 근거를 붙일 수 없어서 전달해 드릴 수 없어요.";
