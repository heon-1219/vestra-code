import { describe, expect, it } from "vitest";

import { LlmError, type Llm, type LlmReply, type LlmRequest } from "@/lib/llm/types";

import { patientLlm } from "./model-pool";
import { buildPurposeAsks } from "./purpose/ask";
import { runPurposePass } from "./purpose/pass";
import { createPythonAnalyzer } from "./python/analyzer";
import { recorder, tree } from "./python/__fixtures__/repo";
import { buildOutline } from "./semantic/outline";
import { runSemanticPass } from "./semantic/pass";
import { featureOutline, selectTargets } from "./semantic/select";
import { markSetAside, resolveSetAside, setAsideContext, SET_ASIDE_KEY } from "./set-aside";
import type { AnalyzedEdge, AnalyzedNode } from "./types";

/**
 * Several model calls at once must write exactly the rows one at a time did.
 *
 * Every pass here now keeps several questions in flight (D159), and the
 * founder's rule for it is one line: same input, byte-identical rows. So each
 * test runs a pass twice over the same input — once one at a time, once six
 * wide against a model whose answers arrive in a random order — and compares
 * everything the pass hands back. The model's answer depends only on the
 * question, as a real one's does at temperature 0; only its timing is random.
 *
 * No clock budget anywhere: a busy machine changes how long this takes and
 * nothing about what it asserts.
 */

const FULL = { mode: "full", reason: "no_base_run" } as const;

/** Deterministic in what it says, random in when it says it. */
function echoModel(answer: (request: LlmRequest) => unknown, seed = 7): {
  llm: Llm;
  calls: () => number;
  peak: () => number;
} {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  let calls = 0;
  let inFlight = 0;
  let peak = 0;
  return {
    calls: () => calls,
    peak: () => peak,
    llm: {
      async complete(request): Promise<LlmReply> {
        calls += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * 6)));
        inFlight -= 1;
        return {
          text: JSON.stringify(answer(request)),
          toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 50 },
          finishReason: "stop",
        };
      },
    },
  };
}

const userOf = (request: LlmRequest) =>
  request.messages.find((message) => message.role === "user")?.content ?? "";

const indicesIn = (text: string) =>
  [...text.matchAll(/^\s*\[(\d+)\]/gm)].map((match) => Number(match[1]));

/** Forty files, each with two pieces, each file importing the one before. */
function bigGraph(): { nodes: AnalyzedNode[]; edges: AnalyzedEdge[] } {
  const nodes: AnalyzedNode[] = [];
  const edges: AnalyzedEdge[] = [];
  for (let i = 0; i < 40; i += 1) {
    const filePath = `src/part${String(i).padStart(2, "0")}.ts`;
    nodes.push({ ref: { type: "file", filePath } });
    for (const name of [`make${i}`, `use${i}`]) {
      nodes.push({ ref: { type: "symbol", filePath, name }, kind: "function", startLine: 1 });
      edges.push({
        source: { type: "file", filePath },
        target: { type: "symbol", filePath, name },
        type: "contains",
        confidence: "certain",
      });
    }
    if (i > 0) {
      const previous = `src/part${String(i - 1).padStart(2, "0")}.ts`;
      edges.push({
        source: { type: "symbol", filePath, name: `use${i}` },
        target: { type: "symbol", filePath: previous, name: `make${i - 1}` },
        type: "calls",
        confidence: "certain",
      });
      edges.push({
        source: { type: "file", filePath },
        target: { type: "file", filePath: previous },
        type: "imports",
        confidence: "certain",
      });
    }
  }
  return { nodes, edges };
}

/** Names every index it was sent, and groups the first three into a feature. */
const namingAnswer = (request: LlmRequest) => {
  const indices = indicesIn(userOf(request));
  if (request.jsonSchema?.name === "vestra_features") {
    return { features: [{ name: "만들기", summary: "여러 가지를 만들어요.", files: indices.slice(0, 3) }] };
  }
  return {
    items: indices.map((i) => ({ i, label: `이름 ${i}번`, summary: `${i}번 일을 맡아요.` })),
  };
};

const purposeAnswer = (request: LlmRequest) => ({
  items: indicesIn(userOf(request)).map((i) => ({ i, why: `여기서 ${i}번 일을 부탁해요.` })),
});

describe("Pass 2 under concurrency", () => {
  const run = async (concurrency: number, extra: { maxTokens?: number; seed?: number } = {}) => {
    const model = echoModel(namingAnswer, extra.seed);
    const result = await runSemanticPass({
      llm: model.llm,
      outline: buildOutline(bigGraph()),
      scope: FULL,
      budget: { batchSize: 5, concurrency, ...(extra.maxTokens ? { maxTokens: extra.maxTokens } : {}) },
    });
    return { result, peak: model.peak(), calls: model.calls() };
  };

  it("writes byte-identical rows one at a time and six at a time", async () => {
    const one = await run(1);
    const six = await run(6, { seed: 99 });

    expect(six.peak).toBeGreaterThan(1);
    expect(one.peak).toBe(1);
    expect(JSON.stringify(six.result.text)).toBe(JSON.stringify(one.result.text));
    expect(JSON.stringify(six.result.nodes)).toBe(JSON.stringify(one.result.nodes));
    expect(JSON.stringify(six.result.edges)).toBe(JSON.stringify(one.result.edges));
    expect(six.result.examined).toEqual(one.result.examined);
    expect(six.result.notExamined).toEqual(one.result.notExamined);
    expect(six.result.drops).toEqual(one.result.drops);
    expect(six.result.spent).toEqual(one.result.spent);
    // Forty files named, and 80 pieces up to the allowance.
    expect(one.result.examined).toHaveLength(40);
  });

  it("stops at the same batch for a token budget, whatever finished first", async () => {
    // 150 tokens a call: the budget is spent after three naming batches.
    const one = await run(1, { maxTokens: 450 });
    const six = await run(6, { maxTokens: 450, seed: 3 });

    expect(one.result.stopped).toBe("token_budget");
    expect(six.result.stopped).toBe("token_budget");
    expect(one.result.examined).toHaveLength(15);
    expect(JSON.stringify(six.result.text)).toBe(JSON.stringify(one.result.text));
    expect(six.result.examined).toEqual(one.result.examined);
    expect(six.result.notExamined).toEqual(one.result.notExamined);
    // Every file is either opened or said not to be. Nothing falls between.
    expect(six.result.examined.length + six.result.notExamined.length).toBe(40);
  });

  it("does not lose a batch to a rate limit once the model is patient", async () => {
    const model = echoModel(namingAnswer);
    let refusals = 1;
    const flaky: Llm = {
      complete(request) {
        if (request.jsonSchema?.name === "vestra_naming" && refusals > 0) {
          refusals -= 1;
          return Promise.reject(new LlmError("429", "rate_limit", 429));
        }
        return model.llm.complete(request);
      },
    };
    const instant = { sleep: async () => {}, now: () => 0 };

    const lost = await runSemanticPass({
      llm: flaky,
      outline: buildOutline(bigGraph()),
      scope: FULL,
      budget: { batchSize: 5 },
    });
    // Without patience the refused batch is five files not opened — and the
    // counts still add up to the whole project.
    expect(lost.notExamined).toHaveLength(5);
    expect(lost.examined.length + lost.notExamined.length).toBe(40);

    refusals = 1;
    const kept = await runSemanticPass({
      llm: patientLlm(flaky, instant),
      outline: buildOutline(bigGraph()),
      scope: FULL,
      budget: { batchSize: 5 },
    });
    expect(kept.notExamined).toHaveLength(0);
    expect(kept.examined).toHaveLength(40);
  });
});

describe("Pass 3 under concurrency", () => {
  const run = async (concurrency: number, seed?: number) => {
    const model = echoModel(purposeAnswer, seed);
    const { asks } = buildPurposeAsks(bigGraph());
    const result = await runPurposePass({
      llm: model.llm,
      asks,
      known: new Map(),
      scope: FULL,
      budget: { batchSize: 4, concurrency },
    });
    return { result, peak: model.peak(), asks: asks.length };
  };

  it("writes the same sentences in the same order one at a time and six at a time", async () => {
    const one = await run(1);
    const six = await run(6, 42);

    expect(six.peak).toBeGreaterThan(1);
    expect([...six.result.answers]).toEqual([...one.result.answers]);
    expect(six.result.answered).toBe(one.result.answered);
    expect(six.result.notAnswered).toBe(one.result.notAnswered);
    expect(six.result.drops).toEqual(one.result.drops);
    expect(one.result.answered).toBe(one.asks);
  });
});

describe("the Python analyzer's model half under concurrency", () => {
  /** Twelve modules, each calling the one before; one test file. */
  const repo = () => {
    const files: Record<string, string | null> = { "requirements.txt": "requests\n" };
    for (let k = 0; k < 12; k += 1) {
      files[`mod${k}.py`] =
        k === 0
          ? "def f0():\n    return 1\n"
          : `from mod${k - 1} import f${k - 1}\n\ndef f${k}():\n    return f${k - 1}()\n`;
    }
    files["tests/test_mod.py"] = "from mod3 import f3\n\ndef test_f3():\n    assert f3()\n";
    return tree(files);
  };

  /** Reads the prompt the way a careful model would, and answers only what is on a line. */
  const pythonAnswer = (request: LlmRequest) => {
    const text = userOf(request);
    const candidates = [...text.matchAll(/^(\d+)\. ([\w.]+) \((?:함수|클래스), ([^)]*)\)$/gm)].map(
      (match) => ({ index: Number(match[1]), name: match[2], where: match[3] }),
    );
    const lines = [...text.matchAll(/^(\d+): (.*)$/gm)].map((match) => ({
      line: Number(match[1]),
      code: match[2],
    }));
    const calls: { from: number; to: number; line: number }[] = [];
    const roles: { symbol: number; role: string }[] = [];
    for (const own of candidates.filter((candidate) => /줄$/.test(candidate.where))) {
      const [start, end] = own.where.replace("줄", "").split("-").map(Number);
      roles.push({ symbol: own.index, role: `${own.index}번 일을 해요` });
      for (const { line, code } of lines) {
        if (line < start || line > end) continue;
        for (const target of candidates) {
          if (target.index !== own.index && code.includes(`${target.name}(`)) {
            calls.push({ from: own.index, to: target.index, line });
          }
        }
      }
    }
    return { calls, roles };
  };

  const run = async (concurrency: number, seed?: number) => {
    const model = echoModel(pythonAnswer, seed);
    const record = recorder();
    const files = repo();
    const context = setAsideContext(files.map((file) => file.path));
    const analyzer = createPythonAnalyzer({
      llm: model.llm,
      budget: { concurrency },
      setAside: (graph) => resolveSetAside(graph, context),
    });
    const graph = await analyzer.analyze(files, "/repo", record.emit);
    markSetAside(graph, context);
    return { graph, peak: model.peak(), calls: model.calls() };
  };

  it("draws the same edges and roles one at a time and six at a time", async () => {
    const one = await run(1);
    const six = await run(6, 5);

    expect(six.peak).toBeGreaterThan(1);
    expect(JSON.stringify(six.graph.edges)).toBe(JSON.stringify(one.graph.edges));
    expect(JSON.stringify(six.graph.nodes)).toBe(JSON.stringify(one.graph.nodes));
    const inferred = one.graph.edges.filter((edge) => edge.confidence === "inferred");
    expect(inferred.length).toBeGreaterThanOrEqual(11);
  });

  it("does not ask about a test file, and does not count it as a shortfall", async () => {
    const { graph, calls } = await run(6);
    // Twelve modules, one call each. The test is parsed, never asked about.
    expect(calls).toBe(12);
    const test = graph.nodes.find((node) => node.ref.filePath === "tests/test_mod.py");
    expect(test?.metadata?.llmExamined).toBeUndefined();
    expect(test?.metadata?.[SET_ASIDE_KEY]).toBe("tests");
    // Its certain import is still on the map.
    expect(
      graph.edges.some(
        (edge) =>
          edge.type === "imports" &&
          edge.source.filePath === "tests/test_mod.py" &&
          edge.target.filePath === "mod3.py",
      ),
    ).toBe(true);
  });
});

describe("set-aside files and the passes that read the map", () => {
  /** Two source files and a test that calls into one of them. */
  const withTest = () => {
    const graph = bigGraph();
    graph.nodes.push({ ref: { type: "file", filePath: "src/part01.test.ts" } });
    graph.nodes.push({
      ref: { type: "symbol", filePath: "src/part01.test.ts", name: "onlyForTests" },
      kind: "function",
    });
    graph.edges.push(
      {
        source: { type: "file", filePath: "src/part01.test.ts" },
        target: { type: "symbol", filePath: "src/part01.test.ts", name: "onlyForTests" },
        type: "contains",
        confidence: "certain",
      },
      {
        source: { type: "file", filePath: "src/part01.test.ts" },
        target: { type: "symbol", filePath: "src/part01.ts", name: "use1" },
        type: "calls",
        confidence: "certain",
      },
      {
        source: { type: "file", filePath: "src/part01.test.ts" },
        target: { type: "file", filePath: "src/part01.ts" },
        type: "imports",
        confidence: "certain",
      },
    );
    markSetAside(graph, setAsideContext(graph.nodes.map((node) => node.ref.filePath)));
    return graph;
  };

  it("does not ask Pass 2 about a test, and counts it apart from any shortfall", async () => {
    const outline = buildOutline(withTest());
    const selection = selectTargets(outline, FULL);
    expect(selection.setAside.map((file) => file.filePath)).toEqual(["src/part01.test.ts"]);
    expect(selection.targets.map((t) => t.file.filePath)).not.toContain("src/part01.test.ts");
    expect(featureOutline(outline).map((file) => file.filePath)).not.toContain(
      "src/part01.test.ts",
    );

    const model = echoModel(namingAnswer);
    const result = await runSemanticPass({ llm: model.llm, outline, scope: FULL });
    expect(result.setAside).toEqual(["src/part01.test.ts"]);
    expect(result.notExamined).toEqual([]);
    expect(result.examined).toHaveLength(40);
  });

  it("does not ask Pass 3 about what only a test reaches for", () => {
    const { asks, setAside } = buildPurposeAsks(withTest());
    // `use1` is called only from the test — every other `use` is called by
    // nobody — and the test's own `onlyForTests` lives in a set-aside file.
    expect(asks.map((ask) => ask.targetName)).not.toContain("use1");
    expect(setAside).toBeGreaterThanOrEqual(1);
    // `part00.ts` is imported by `part01.ts`, which is read: still asked.
    expect(asks.some((ask) => ask.targetPath === "src/part00.ts")).toBe(true);
  });
});
