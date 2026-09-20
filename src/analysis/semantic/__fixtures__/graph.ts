import type { AnalyzedEdge, AnalyzedNode, SymbolKind } from "@/analysis/types";
import type { Llm, LlmReply, LlmRequest } from "@/lib/llm/types";

/**
 * A graph, a model and a clock that do not exist.
 *
 * Pass 2 is pure over (outline, model): it never reads a file, never opens a
 * connection and never looks at the environment. So a fixture here is a literal
 * rather than a temp directory — which is the property `pass.ts` is written to
 * have, and the one thing that would break first if somebody reached for
 * `env.ts` inside it.
 */

export function file(path: string): AnalyzedNode {
  return { ref: { type: "file", filePath: path } };
}

export function symbol(
  path: string,
  name: string,
  kind: SymbolKind = "function",
  startLine = 1,
): AnalyzedNode {
  return { ref: { type: "symbol", filePath: path, name }, kind, startLine };
}

export function route(path: string, address: string): AnalyzedNode {
  return { ref: { type: "route", filePath: path, name: address } };
}

export function endpoint(path: string, address: string): AnalyzedNode {
  return { ref: { type: "api_endpoint", filePath: path, name: address } };
}

export function pkg(name: string): AnalyzedNode {
  return { ref: { type: "package", filePath: "", name } };
}

export function contains(path: string, child: AnalyzedNode): AnalyzedEdge {
  return {
    source: { type: "file", filePath: path },
    target: child.ref,
    type: "contains",
    confidence: "certain",
  };
}

export function imports(from: string, to: string): AnalyzedEdge {
  return {
    source: { type: "file", filePath: from },
    target: { type: "file", filePath: to },
    type: "imports",
    confidence: "certain",
  };
}

export function usesPackage(from: string, name: string): AnalyzedEdge {
  return {
    source: { type: "file", filePath: from },
    target: { type: "package", filePath: "", name },
    type: "uses_package",
    confidence: "certain",
  };
}

/**
 * A small shop, shaped like the real demo repo: a page, an endpoint, a shared
 * helper everything imports, and one file nothing points at.
 */
export function shopGraph(): { nodes: AnalyzedNode[]; edges: AnalyzedEdge[] } {
  const payButton = symbol("src/components/PayButton.tsx", "PayButton", "component", 4);
  const useCart = symbol("src/lib/useCart.ts", "useCart", "hook", 3);
  const addItem = symbol("src/lib/useCart.ts", "addItem", "function", 20);
  const formatPrice = symbol("src/lib/format.ts", "formatPrice", "function", 1);
  const checkoutRoute = route("src/app/checkout/page.tsx", "/checkout");
  const ordersEndpoint = endpoint("src/app/api/orders/route.ts", "POST /api/orders");

  const nodes: AnalyzedNode[] = [
    file("src/app/checkout/page.tsx"),
    file("src/app/api/orders/route.ts"),
    file("src/components/PayButton.tsx"),
    file("src/lib/useCart.ts"),
    file("src/lib/format.ts"),
    file("src/legacy/old-banner.js"),
    pkg("stripe"),
    payButton,
    useCart,
    addItem,
    formatPrice,
    checkoutRoute,
    ordersEndpoint,
  ];

  const edges: AnalyzedEdge[] = [
    contains("src/app/checkout/page.tsx", checkoutRoute),
    contains("src/app/api/orders/route.ts", ordersEndpoint),
    contains("src/components/PayButton.tsx", payButton),
    contains("src/lib/useCart.ts", useCart),
    contains("src/lib/useCart.ts", addItem),
    contains("src/lib/format.ts", formatPrice),
    imports("src/app/checkout/page.tsx", "src/components/PayButton.tsx"),
    imports("src/app/checkout/page.tsx", "src/lib/useCart.ts"),
    imports("src/components/PayButton.tsx", "src/lib/format.ts"),
    imports("src/components/PayButton.tsx", "src/lib/useCart.ts"),
    imports("src/app/api/orders/route.ts", "src/lib/format.ts"),
    usesPackage("src/app/api/orders/route.ts", "stripe"),
  ];

  return { nodes, edges };
}

/** A reply that is only JSON, which is what this pass asks for. */
export function replyJson(body: unknown, extra: Partial<LlmReply> = {}): LlmReply {
  return {
    text: JSON.stringify(body),
    toolCalls: [],
    usage: { inputTokens: 600, outputTokens: 200 },
    finishReason: "stop",
    ...extra,
  };
}

export type Scripted = LlmReply | (() => LlmReply);

/**
 * A model that returns a fixed sequence and records what it was asked.
 *
 * Running off the end throws rather than looping, because a pass that asked
 * more questions than the test scripted is exactly the budget bug these tests
 * exist to catch.
 */
export function scriptedLlm(script: readonly Scripted[]): {
  llm: Llm;
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  let at = 0;
  const llm: Llm = {
    complete(request) {
      requests.push(request);
      if (at >= script.length) {
        throw new Error(`대본에 없는 ${at + 1}번째 호출이에요.`);
      }
      const next = script[at];
      at += 1;
      return Promise.resolve(typeof next === "function" ? next() : next);
    },
  };
  return { llm, requests };
}

/** The user turn of a request, which is where the prompt under test lives. */
export function userText(request: LlmRequest): string {
  return request.messages.find((message) => message.role === "user")?.content ?? "";
}
