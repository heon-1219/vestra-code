import { describe, expect, it } from "vitest";

import type { AnalyzedEdge, AnalyzedNode } from "@/analysis/types";

import { recorder, replyJson, scriptedLlm, tree, type Scripted } from "./__fixtures__/repo";
import {
  createPythonAnalyzer,
  PYTHON_PROJECT_KINDS,
  pythonLlmCoverage,
  type PythonAnalyzerOptions,
} from "./analyzer";
import type { PythonLlmResult } from "./llm";

/**
 * The analyzer, run whole, against a repository that exists only in memory.
 *
 * Two halves and one rule between them: what the parser reads off the text is
 * `certain`, what the model says is `inferred`, and nothing crosses.
 */

async function analyze(
  entries: Record<string, string | null>,
  options: PythonAnalyzerOptions = {},
) {
  const record = recorder();
  const result = await createPythonAnalyzer(options).analyze(
    tree(entries),
    "/repo",
    record.emit,
  );
  return { ...result, record };
}

function edgesOf(edges: AnalyzedEdge[], type: AnalyzedEdge["type"], fromPath?: string) {
  return edges
    .filter((edge) => edge.type === type)
    .filter((edge) => fromPath === undefined || edge.source.filePath === fromPath)
    .map((edge) => ({
      to: edge.target.name ?? edge.target.filePath,
      confidence: edge.confidence,
    }));
}

function symbolsOf(nodes: AnalyzedNode[], filePath?: string): string[] {
  return nodes
    .filter((node) => node.ref.type === "symbol")
    .filter((node) => filePath === undefined || node.ref.filePath === filePath)
    .map((node) =>
      node.ref.container ? `${node.ref.container}.${node.ref.name}` : (node.ref.name ?? ""),
    );
}

// --- A small shop, written the way Python is actually written ---------------

const SHOP: Record<string, string | null> = {
  "requirements.txt": ["requests>=2.31", "PyYAML==6.0", "# a comment"].join("\n"),
  "main.py": [
    "from shop import orders",
    "import yaml",
    "",
    "",
    "def main():",
    '    return orders.place_order("AAPL")',
  ].join("\n"),
  "shop/__init__.py": '"""The shop package."""',
  "shop/db.py": ["def save(order):", "    return order"].join("\n"),
  "shop/models/__init__.py": "from .user import User",
  "shop/models/user.py": ["class User:", "    pass"].join("\n"),
  "shop/orders.py": [
    '"""Orders.',
    "",
    "import fake_module",
    '"""',
    "# import commented_out",
    "from .db import save",
    "from shop.models import User",
    "import requests",
    "import os",
    "",
    "",
    "class OrderBook:",
    "    def add(self, order):",
    "        def normalise(one):",
    "            return one",
    "        return save(normalise(order))",
    "",
    "",
    "def place_order(symbol):",
    "    return OrderBook().add(symbol)",
  ].join("\n"),
  "docs/logo.png": null,
};

describe("what this analyzer takes on", () => {
  it("is inert until `python` exists as a project kind", () => {
    // The enum has no `python` value yet and adding one is a schema change that
    // belongs with whoever wires this in. Until then `handles` says no to every
    // kind there is, which is the safe answer — and the test that will start
    // failing, loudly, the day the value lands without the wiring.
    const analyzer = createPythonAnalyzer();

    expect(analyzer.name).toBe("python");
    expect(analyzer.handles("nextjs")).toBe(false);
    expect(analyzer.handles("react_spa")).toBe(false);
    expect(analyzer.handles("static_site")).toBe(false);
    expect(analyzer.handles("unsupported")).toBe(false);
    expect(PYTHON_PROJECT_KINDS).toContain("python");
  });
});

describe("the parser half, which is the certain half", () => {
  it("joins files to each other through relative imports", async () => {
    const { edges } = await analyze(SHOP);

    expect(edgesOf(edges, "imports", "shop/orders.py")).toEqual([
      { to: "shop/db.py", confidence: "certain" },
      { to: "shop/models/__init__.py", confidence: "certain" },
    ]);
  });

  it("records which names were taken out of the file it points at", async () => {
    const { edges } = await analyze(SHOP);
    const toDb = edges.find(
      (edge) => edge.type === "imports" && edge.target.filePath === "shop/db.py",
    );

    // The edge points at the file, because that is the connection the map
    // draws. Which names came out of it is read straight off the line, so it is
    // kept rather than thrown away.
    expect(toDb?.metadata).toMatchObject({ specifier: ".db", names: ["save"] });
  });

  it("resolves a package import onto its __init__.py, and the submodule beside it", async () => {
    const { edges } = await analyze(SHOP);

    // `from shop import orders` reaches two files, and both are true: importing
    // a submodule runs the package's `__init__.py` as well. Missing the second
    // is how a package's own assembly file ends up with no connections at all.
    expect(edgesOf(edges, "imports", "main.py")).toEqual([
      { to: "shop/__init__.py", confidence: "certain" },
      { to: "shop/orders.py", confidence: "certain" },
    ]);
    expect(edgesOf(edges, "imports", "shop/models/__init__.py")).toEqual([
      { to: "shop/models/user.py", confidence: "certain" },
    ]);
  });

  it("gives a method its class, and refuses a nested def", async () => {
    const { nodes } = await analyze(SHOP);

    expect(symbolsOf(nodes, "shop/orders.py")).toEqual([
      "OrderBook",
      "OrderBook.add",
      "place_order",
    ]);
    // `normalise` lives inside `add`. It is not a thing the user has a name for.
    expect(symbolsOf(nodes)).not.toContain("normalise");
  });

  it("makes one node when a file defines the same name twice", async () => {
    // A property and its setter, and a platform branch: both write one name as
    // two `def`s, and CPython's standard library does it in `os.py`,
    // `ntpath.py`, `ssl.py` and `socket.py`. Two entries would mean two ways to
    // name one node, and the second would carry a line range the node does not.
    const { nodes } = await analyze({
      "platform.py": [
        "import sys",
        "",
        "if sys.platform == 'win32':",
        "    def normpath(path):",
        "        return path.lower()",
        "else:",
        "    def normpath(path):",
        "        return path",
      ].join("\n"),
    });

    expect(symbolsOf(nodes, "platform.py")).toEqual(["normpath"]);
    const symbol = nodes.find((node) => node.ref.name === "normpath");
    expect(symbol?.startLine).toBe(4);
  });

  it("holds every symbol with a contains edge", async () => {
    const { edges } = await analyze(SHOP);

    expect(edgesOf(edges, "contains", "shop/orders.py")).toEqual([
      { to: "OrderBook", confidence: "certain" },
      { to: "add", confidence: "certain" },
      { to: "place_order", confidence: "certain" },
    ]);
  });

  it("does not believe a commented-out import or one inside a docstring", async () => {
    const { edges, nodes } = await analyze(SHOP);

    const reached = edges.map((edge) => edge.target.name ?? edge.target.filePath);
    expect(reached).not.toContain("commented_out");
    expect(reached).not.toContain("fake_module");
    expect(nodes.map((node) => node.ref.name)).not.toContain("fake_module");
  });

  it("names a package only when the project declared it", async () => {
    const { edges } = await analyze(SHOP);

    expect(edgesOf(edges, "uses_package", "shop/orders.py")).toEqual([
      { to: "requests", confidence: "certain" },
    ]);
    // `import os` is the standard library. Inventing a box called `os` would
    // put something on the map that nobody installed.
    expect(edgesOf(edges, "uses_package").map((edge) => edge.to)).not.toContain("os");
  });

  it("follows an import name back to the distribution name that was declared", async () => {
    const { edges } = await analyze(SHOP);

    // `import yaml` is `PyYAML` in requirements.txt. One dependency spelled two
    // ways, and dropping it would leave a declared library off its own map.
    expect(edgesOf(edges, "uses_package", "main.py")).toEqual([
      { to: "PyYAML", confidence: "certain" },
    ]);
  });

  it("reads a Pipfile and a pyproject.toml as well", async () => {
    const withPipfile = await analyze({
      Pipfile: ["[[source]]", 'name = "pypi"', "", "[packages]", 'flask = "*"'].join("\n"),
      "app.py": "import flask",
    });

    expect(edgesOf(withPipfile.edges, "uses_package", "app.py")).toEqual([
      { to: "flask", confidence: "certain" },
    ]);
    // `name = "pypi"` under `[[source]]` is an index, not a package.
    expect(withPipfile.nodes.filter((node) => node.ref.type === "package")).toHaveLength(1);

    const withPyproject = await analyze({
      "pyproject.toml": ["[project]", 'dependencies = ["httpx>=0.27"]'].join("\n"),
      "app.py": "import httpx",
    });

    expect(edgesOf(withPyproject.edges, "uses_package", "app.py")).toEqual([
      { to: "httpx", confidence: "certain" },
    ]);
  });

  it("runs to the end with no model, and says nothing it cannot back", async () => {
    const { edges, record } = await analyze(SHOP);

    expect(record.phases).toEqual(["static", "done"]);
    expect(edges.every((edge) => edge.confidence === "certain")).toBe(true);
    expect(edges.filter((edge) => edge.type === "calls")).toEqual([]);
    expect(record.parsed).toContain("shop/orders.py");
    expect(record.skipped).toEqual([]);
  });

  it("makes a node for a binary asset it will never read", async () => {
    const { nodes } = await analyze(SHOP);
    const logo = nodes.find((node) => node.ref.filePath === "docs/logo.png");

    expect(logo?.metadata).toMatchObject({ asset: true });
  });
});

// --- The model half ---------------------------------------------------------

const CALLER: Record<string, string> = {
  "app/broker.py": ["def place_order(symbol):", "    return symbol"].join("\n"),
  "app/main.py": [
    "from .broker import place_order",
    "",
    "",
    "def run():",
    '    return place_order("AAPL")',
  ].join("\n"),
};

/** `app/broker.py` is ranked first (one file imports it), `app/main.py` second. */
function callerScript(mainReply: unknown): Scripted[] {
  return [replyJson({ calls: [] }), replyJson(mainReply)];
}

async function analyzeCaller(mainReply: unknown) {
  const { llm, requests } = scriptedLlm(callerScript(mainReply));
  let llmResult: PythonLlmResult | null = null;
  const run = await analyze(CALLER, {
    llm,
    onLlmResult: (result) => {
      llmResult = result;
    },
  });
  return { ...run, requests, llmResult: llmResult as PythonLlmResult | null };
}

describe("the model half, which is the inferred half", () => {
  it("keeps a call it can check against the line it was claimed on", async () => {
    const { edges, record, llmResult } = await analyzeCaller({
      calls: [{ from: 0, to: 1, line: 5 }],
      roles: [{ symbol: 0, role: "주문을 넣어요" }],
      fileRole: "주문을 보내는 곳이에요",
    });

    expect(record.phases).toEqual(["static", "semantic", "done"]);
    expect(edgesOf(edges, "calls", "app/main.py")).toEqual([
      { to: "place_order", confidence: "inferred" },
    ]);

    const call = edges.find((edge) => edge.type === "calls");
    expect(call?.source).toEqual({ type: "symbol", filePath: "app/main.py", name: "run" });
    expect(call?.target).toEqual({
      type: "symbol",
      filePath: "app/broker.py",
      name: "place_order",
    });
    // Never `certain`, whatever the model's confidence, and always marked as
    // the model's so the graph can be asked which half produced it.
    expect(call?.confidence).toBe("inferred");
    expect(call?.metadata).toMatchObject({ origin: "llm", line: 5 });
    expect(llmResult?.dropped.unknown_target).toBe(0);
  });

  it("drops a reply that names a symbol which does not exist", async () => {
    const { edges, llmResult } = await analyzeCaller({
      calls: [
        { from: 0, to: 99, line: 5 },
        { from: 41, to: 1, line: 5 },
      ],
    });

    expect(edges.filter((edge) => edge.type === "calls")).toEqual([]);
    expect(llmResult?.dropped.unknown_target).toBe(1);
    expect(llmResult?.dropped.unknown_source).toBe(1);
  });

  it("drops a call whose name is not written on the line it cites", async () => {
    // Line 4 is `def run():`. A model reasoning loosely about a file produces
    // exactly this: a plausible call, attributed to a line that does not make
    // it. Nothing downstream could catch it, and the user cannot open the code.
    const { edges, llmResult } = await analyzeCaller({ calls: [{ from: 0, to: 1, line: 4 }] });

    expect(edges.filter((edge) => edge.type === "calls")).toEqual([]);
    expect(llmResult?.dropped.name_not_on_line).toBe(1);
  });

  it("drops a call attributed to a line outside the calling symbol", async () => {
    const { edges, llmResult } = await analyzeCaller({ calls: [{ from: 0, to: 1, line: 1 }] });

    expect(edges.filter((edge) => edge.type === "calls")).toEqual([]);
    expect(llmResult?.dropped.line_outside_source).toBe(1);
  });

  it("drops a symbol calling itself", async () => {
    const { edges, llmResult } = await analyzeCaller({ calls: [{ from: 0, to: 0, line: 5 }] });

    expect(edges.filter((edge) => edge.type === "calls")).toEqual([]);
    expect(llmResult?.dropped.self_call).toBe(1);
  });

  it("keeps a call written through the module it came from", async () => {
    // `orders.place_order(...)` is how most of Python's calls are actually
    // written. A check that demanded a bare name would throw away nearly every
    // method call and every call through an imported module.
    const qualified = {
      "app/broker.py": ["def place_order(symbol):", "    return symbol"].join("\n"),
      "app/main.py": [
        "from . import broker",
        "",
        "",
        "def run():",
        '    return broker.place_order("AAPL")',
      ].join("\n"),
    };
    const { llm } = scriptedLlm([
      replyJson({ calls: [] }),
      replyJson({ calls: [{ from: 0, to: 1, line: 5 }] }),
    ]);
    const { edges } = await analyze(qualified, { llm });

    expect(edgesOf(edges, "calls")).toEqual([
      { to: "place_order", confidence: "inferred" },
    ]);
  });

  it("keeps a call spelled through the name it was imported as", async () => {
    const aliased = {
      "app/broker.py": ["def place_order(symbol):", "    return symbol"].join("\n"),
      "app/main.py": [
        "from .broker import place_order as po",
        "",
        "",
        "def run():",
        '    return po("AAPL")',
      ].join("\n"),
    };
    const { llm } = scriptedLlm([
      replyJson({ calls: [] }),
      replyJson({ calls: [{ from: 0, to: 1, line: 5 }] }),
    ]);
    const { edges } = await analyze(aliased, { llm });

    expect(edgesOf(edges, "calls")).toEqual([
      { to: "place_order", confidence: "inferred" },
    ]);
  });

  it("puts a role on the thing it described, marked as the model's", async () => {
    const { nodes } = await analyzeCaller({
      calls: [],
      roles: [{ symbol: 0, role: "주문을 넣어요" }],
      fileRole: "주문을 보내는 곳이에요",
    });

    const symbol = nodes.find((node) => node.ref.name === "run");
    expect(symbol?.metadata).toMatchObject({ role: "주문을 넣어요", roleOrigin: "llm" });

    const file = nodes.find((node) => node.ref.filePath === "app/main.py");
    expect(file?.metadata).toMatchObject({ role: "주문을 보내는 곳이에요" });
  });

  it("refuses a role that uses a word the product does not say", async () => {
    const { nodes } = await analyzeCaller({
      calls: [],
      roles: [{ symbol: 0, role: "여기는 고쳐도 안전해요" }],
    });

    const symbol = nodes.find((node) => node.ref.name === "run");
    expect(symbol?.metadata).not.toHaveProperty("role");
  });

  it("ignores a reply that was cut off mid-answer", async () => {
    const { llm } = scriptedLlm([
      replyJson({ calls: [] }),
      replyJson({ calls: [{ from: 0, to: 1, line: 5 }] }, { finishReason: "length" }),
    ]);
    const { edges } = await analyze(CALLER, { llm });

    // A truncated reply is not a reply. Keeping the part that happened to parse
    // would quietly drop the rest and report it as a complete answer.
    expect(edges.filter((edge) => edge.type === "calls")).toEqual([]);
  });

  it("reads a reply the endpoint wrapped in prose and a fence", async () => {
    const { llm } = scriptedLlm([
      replyJson({ calls: [] }),
      {
        text: '네, 확인했어요.\n```json\n{"calls":[{"from":0,"to":1,"line":5}]}\n```',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10 },
        finishReason: "stop",
      },
    ]);
    const { edges } = await analyze(CALLER, { llm });

    expect(edges.filter((edge) => edge.type === "calls")).toHaveLength(1);
  });

  it("sends numbers and names, never a node id", async () => {
    const { requests } = await analyzeCaller({ calls: [] });
    const prompt = requests[1].messages[1].content;

    expect(prompt).toContain("app/main.py");
    expect(prompt).toContain("0. run");
    expect(prompt).toContain("1. place_order");
    expect(prompt).toContain("5:     return place_order");
    expect(prompt).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe("the budget, and saying what was not looked at", () => {
  it("stops at the file ceiling and reports which files it never opened", async () => {
    const { llm, requests } = scriptedLlm([replyJson({ calls: [] })]);
    let llmResult: PythonLlmResult | null = null;
    const { nodes } = await analyze(CALLER, {
      llm,
      budget: { maxFiles: 1 },
      onLlmResult: (result) => {
        llmResult = result;
      },
    });

    expect(requests).toHaveLength(1);

    // "We did not look" and "there is nothing there" are opposite claims, and
    // the count has to survive into the graph so it can still be said a day
    // later, from the database, with the analyzer long gone.
    const reported = llmResult as PythonLlmResult | null;
    expect(reported?.stopped).toBe("file_budget");
    expect(reported?.examined).toEqual(["app/broker.py"]);
    expect(reported?.notExamined).toEqual(["app/main.py"]);
    expect(pythonLlmCoverage(nodes)).toEqual({ examined: 1, notExamined: 1 });
  });

  it("stops when the tokens run out rather than spending more", async () => {
    const { llm, requests } = scriptedLlm([
      replyJson({ calls: [] }, { usage: { inputTokens: 9_000, outputTokens: 2_000 } }),
      replyJson({ calls: [{ from: 0, to: 1, line: 5 }] }),
    ]);
    let llmResult: PythonLlmResult | null = null;
    await analyze(CALLER, {
      llm,
      budget: { maxTokens: 1_000 },
      onLlmResult: (result) => {
        llmResult = result;
      },
    });

    expect(requests).toHaveLength(1);
    const reported = llmResult as PythonLlmResult | null;
    expect(reported?.stopped).toBe("token_budget");
    expect(reported?.notExamined).toEqual(["app/main.py"]);
  });

  it("truncates a long file and refuses claims about the part it did not send", async () => {
    const filler = Array.from({ length: 400 }, (_, index) => `    value_${index} = ${index}`);
    const long = {
      "app/broker.py": ["def place_order(symbol):", "    return symbol"].join("\n"),
      "app/main.py": [
        "from .broker import place_order",
        "",
        "",
        "def run():",
        ...filler,
        '    return place_order("AAPL")',
      ].join("\n"),
    };
    const claimedLine = 5 + filler.length;

    const { llm, requests } = scriptedLlm([
      replyJson({ calls: [] }),
      replyJson({ calls: [{ from: 0, to: 1, line: claimedLine }] }),
    ]);
    let llmResult: PythonLlmResult | null = null;
    const { edges } = await analyze(long, {
      llm,
      budget: { maxFileChars: 400 },
      onLlmResult: (result) => {
        llmResult = result;
      },
    });

    expect(requests[1].messages[1].content).toContain("보내지 않았어요");
    expect(edges.filter((edge) => edge.type === "calls")).toEqual([]);
    expect((llmResult as PythonLlmResult | null)?.dropped.line_not_sent).toBe(1);
  });
});
