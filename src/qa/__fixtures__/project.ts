import type { GraphConnection, GraphItem } from "@/lib/graph/view";
import type {
  Llm,
  LlmReply,
  LlmRequest,
  LlmToolCall,
} from "@/lib/llm/types";

import type { SourceReader } from "../source";
import type { QaGraph } from "../tools";

/**
 * A six-item project, small enough to assert every line of a tool result
 * against and shaped like the real one.
 *
 * A page renders a button, the button calls a formatter, and the formatter has
 * the defect. That is the shape the loop exists for: the symptom is on the
 * page, the cause is two hops away, and the only way to tell the difference is
 * to open the third file. A fixture where the first search lands on the answer
 * would let a broken loop pass.
 *
 * Item numbers are positions in this array (D46), so every test that says `[6]`
 * means `formatPrice` and will keep meaning it.
 */

function item(partial: Partial<GraphItem> & Pick<GraphItem, "id" | "kind" | "name">): GraphItem {
  return {
    shape: null,
    label: null,
    summary: null,
    path: null,
    startLine: null,
    endLine: null,
    fromUser: false,
    usedBy: 0,
    uses: 0,
    ...partial,
  };
}

export const ITEMS: GraphItem[] = [
  item({
    id: "f-page",
    kind: "file",
    name: "src/app/checkout/page.tsx",
    path: "src/app/checkout/page.tsx",
    uses: 1,
  }),
  item({
    id: "s-checkout",
    kind: "symbol",
    shape: "component",
    name: "CheckoutPage",
    label: "결제 화면",
    path: "src/app/checkout/page.tsx",
    startLine: 1,
    endLine: 20,
    uses: 1,
  }),
  item({
    id: "f-pay",
    kind: "file",
    name: "src/components/PayButton.tsx",
    path: "src/components/PayButton.tsx",
    usedBy: 1,
    uses: 1,
  }),
  item({
    id: "s-pay",
    kind: "symbol",
    shape: "component",
    name: "PayButton",
    label: "결제 버튼",
    summary: "누르면 주문을 넣어요.",
    path: "src/components/PayButton.tsx",
    startLine: 5,
    endLine: 18,
    usedBy: 1,
    uses: 1,
  }),
  item({
    id: "f-format",
    kind: "file",
    name: "src/lib/format.ts",
    path: "src/lib/format.ts",
    usedBy: 1,
  }),
  item({
    id: "s-format",
    kind: "symbol",
    shape: "function",
    name: "formatPrice",
    label: "가격 표시",
    path: "src/lib/format.ts",
    startLine: 3,
    endLine: 8,
    usedBy: 1,
  }),
];

export const CONNECTIONS: GraphConnection[] = [
  { id: "c1", from: "f-page", to: "s-checkout", relation: "contains", certainty: "certain" },
  { id: "c2", from: "f-pay", to: "s-pay", relation: "contains", certainty: "certain" },
  { id: "c3", from: "f-format", to: "s-format", relation: "contains", certainty: "certain" },
  { id: "c4", from: "s-checkout", to: "s-pay", relation: "renders", certainty: "certain" },
  { id: "c5", from: "s-pay", to: "s-format", relation: "calls", certainty: "inferred" },
  { id: "c6", from: "f-page", to: "f-pay", relation: "imports", certainty: "certain" },
  { id: "c7", from: "f-pay", to: "f-format", relation: "imports", certainty: "certain" },
];

export const GRAPH: QaGraph = { items: ITEMS, connections: CONNECTIONS };

/**
 * The source, with the defect on line 7 of `format.ts`.
 *
 * `en-US` in a Korean product is exactly the class of bug that passes a type
 * checker, a linter and every test: nothing about it is malformed, it is only
 * wrong in the rendered result.
 */
export const SOURCE: Record<string, string> = {
  "src/lib/format.ts": [
    "// 가격을 사람이 읽는 글자로 바꿔요.",
    "",
    "export function formatPrice(amount: number): string {",
    "  const rounded = Math.round(amount);",
    "  // 천 단위 쉼표를 넣어요.",
    "  // 아래 한 줄이 이 프로젝트의 통화와 맞지 않아요.",
    '  return rounded.toLocaleString("en-US") + "원";',
    "}",
    "",
    "export function formatCount(count: number): string {",
    "  return `${count}개`;",
    "}",
    "",
  ].join("\n"),
  "src/components/PayButton.tsx": [
    'import { formatPrice } from "@/lib/format";',
    "",
    "type Props = { amount: number };",
    "",
    "export function PayButton({ amount }: Props) {",
    "  return (",
    "    <button type=\"button\">",
    "      {formatPrice(amount)} 결제하기",
    "    </button>",
    "  );",
    "}",
    "",
  ].join("\n"),
};

/** Every file in `SOURCE`, and a plain refusal for anything else. */
export function fixtureReader(
  files: Record<string, string> = SOURCE,
): SourceReader {
  return async (path) => {
    const text = files[path];
    return text === undefined
      ? { ok: false, reason: "not_found" }
      : { ok: true, text };
  };
}

// --- A model that does exactly what the test says ---------------------------

export function call(
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}`,
): LlmToolCall {
  return { id, name, arguments: args };
}

/** A reply with tool calls, with the usage every test would otherwise repeat. */
export function replyWith(
  toolCalls: LlmToolCall[],
  extra: Partial<LlmReply> = {},
): LlmReply {
  return {
    text: null,
    toolCalls,
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: "tool_calls",
    ...extra,
  };
}

/** A reply that is only prose, which the loop has to handle rather than accept. */
export function replyText(
  text: string,
  extra: Partial<LlmReply> = {},
): LlmReply {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: "stop",
    ...extra,
  };
}

export type Scripted = LlmReply | (() => LlmReply);

/**
 * A model that returns a fixed sequence, and records what it was asked.
 *
 * There is no API key on this machine and there should not need to be — the
 * whole reason `Llm` is injected. Running off the end of the script throws
 * rather than looping, because a loop that took more steps than the test
 * scripted is the bug the test was written to catch.
 */
export function scriptedLlm(script: readonly Scripted[]): {
  llm: Llm;
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  let at = 0;
  const llm: Llm = {
    async complete(request) {
      requests.push(request);
      if (at >= script.length) {
        throw new Error(`대본에 없는 ${at + 1}번째 호출이에요.`);
      }
      const next = script[at];
      at += 1;
      return typeof next === "function" ? next() : next;
    },
  };
  return { llm, requests };
}
