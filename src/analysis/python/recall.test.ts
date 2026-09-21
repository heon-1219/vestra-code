import { describe, expect, it } from "vitest";

import type { Llm, LlmReply, LlmRequest } from "@/lib/llm/types";

import { createPythonAnalyzer, LLM_ANSWER_KEY } from "./analyzer";
import { readRememberedAnswer, type RememberedAnswer } from "./llm";
import { recorder, tree } from "./__fixtures__/repo";

/**
 * The same question is not asked twice (D161).
 *
 * Measured on `Kim-and-Chang-`: a re-read with nothing pushed asked the model
 * about all 17 Python files again — 54,110 input tokens and 13 of the run's 21
 * seconds — while Pass 2 and Pass 3 beside it cost nothing. An answer is kept
 * on its file node under a digest of the exact question, and a later run with
 * a byte-identical question uses it instead of asking.
 */

const files = (overrides: Record<string, string> = {}) =>
  tree({
    "requirements.txt": "requests\n",
    "db.py": "def save(order):\n    return order\n",
    "orders.py": "from db import save\n\ndef place(order):\n    return save(order)\n",
    "api.py": "from orders import place\n\ndef handle(request):\n    return place(request)\n",
    ...overrides,
  });

/** Answers the way a careful model would: calls that are on the line, and a role. */
function honestModel(): { llm: Llm; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    llm: {
      async complete(request: LlmRequest): Promise<LlmReply> {
        const text = request.messages.find((m) => m.role === "user")?.content ?? "";
        asked.push(/^파일: (.*)$/m.exec(text)?.[1] ?? "?");
        const candidates = [...text.matchAll(/^(\d+)\. ([\w.]+) \(/gm)].map((m) => ({
          index: Number(m[1]),
          name: m[2],
        }));
        const lines = [...text.matchAll(/^(\d+): (.*)$/gm)].map((m) => ({
          line: Number(m[1]),
          code: m[2],
        }));
        const calls = [];
        for (const { line, code } of lines) {
          for (const target of candidates) {
            if (target.index !== 0 && code.includes(`${target.name}(`)) {
              calls.push({ from: 0, to: target.index, line });
            }
          }
        }
        return {
          text: JSON.stringify({ calls, roles: [{ symbol: 0, role: "일을 맡아요" }] }),
          toolCalls: [],
          usage: { inputTokens: 300, outputTokens: 40 },
          finishReason: "stop",
        };
      },
    },
  };
}

const run = async (
  llm: Llm,
  source = files(),
  recall?: (path: string) => RememberedAnswer | null,
) => {
  const record = recorder();
  const graph = await createPythonAnalyzer({ llm, ...(recall ? { recall } : {}) }).analyze(
    source,
    "/repo",
    record.emit,
  );
  const memory = new Map<string, RememberedAnswer>();
  for (const node of graph.nodes) {
    const kept = readRememberedAnswer(node.metadata?.[LLM_ANSWER_KEY]);
    if (node.ref.type === "file" && kept) memory.set(node.ref.filePath, kept);
  }
  return { graph, memory };
};

describe("remembering what the model said about a file", () => {
  it("asks nothing on a re-read whose questions are unchanged, and draws the same map", async () => {
    const first = honestModel();
    const cold = await run(first.llm);
    expect(first.asked.sort()).toEqual(["api.py", "db.py", "orders.py"]);

    const second = honestModel();
    const warm = await run(second.llm, files(), (path) => cold.memory.get(path) ?? null);

    expect(second.asked).toEqual([]);
    expect(JSON.stringify(warm.graph.edges)).toBe(JSON.stringify(cold.graph.edges));
    expect(JSON.stringify(warm.graph.nodes)).toBe(JSON.stringify(cold.graph.nodes));
    expect(warm.graph.edges.filter((edge) => edge.confidence === "inferred")).toHaveLength(2);
  });

  it("asks again about a file whose question changed, and only that file", async () => {
    const cold = await run(honestModel().llm);

    const second = honestModel();
    await run(
      second.llm,
      files({ "api.py": "from orders import place\n\ndef handle(request):\n    return place(request) or None\n" }),
      (path) => cold.memory.get(path) ?? null,
    );
    // `orders.py` imports `db.py`, whose symbols did not change, so its question
    // is word for word the same and it is not asked again.
    expect(second.asked).toEqual(["api.py"]);
  });

  it("asks again when a file it imports gains a name it could call", async () => {
    // Nothing in `orders.py` changed. Its question did: the list of things it
    // can call now has one more entry. A path comparison would miss this.
    const cold = await run(honestModel().llm);

    const second = honestModel();
    await run(
      second.llm,
      files({ "db.py": "def save(order):\n    return order\n\ndef load(order_id):\n    return None\n" }),
      (path) => cold.memory.get(path) ?? null,
    );
    expect(second.asked.sort()).toEqual(["db.py", "orders.py"]);
  });

  it("checks a remembered answer against the file like a fresh one", async () => {
    // An answer claiming a call on a line where the name is not written is
    // dropped on recall exactly as it would be on arrival.
    const cold = await run(honestModel().llm);
    const forged = new Map(cold.memory);
    const orders = forged.get("orders.py");
    expect(orders).toBeDefined();
    if (!orders) return;
    forged.set("orders.py", {
      key: orders.key,
      answer: { ...orders.answer, calls: [{ from: 0, to: 1, line: 1 }] },
    });

    const warm = await run(honestModel().llm, files(), (path) => forged.get(path) ?? null);
    const fromOrders = warm.graph.edges.filter(
      (edge) => edge.confidence === "inferred" && edge.source.filePath === "orders.py",
    );
    expect(fromOrders).toEqual([]);
  });

  it("does not trust a row that is not an answer", () => {
    expect(readRememberedAnswer(null)).toBeNull();
    expect(readRememberedAnswer("abc")).toBeNull();
    expect(readRememberedAnswer({ key: "", answer: {} })).toBeNull();
    expect(readRememberedAnswer({ key: "k", answer: { calls: "many" } })).toBeNull();
    expect(readRememberedAnswer({ key: "k", answer: { calls: [] } })).toEqual({
      key: "k",
      answer: { calls: [] },
    });
  });
});
