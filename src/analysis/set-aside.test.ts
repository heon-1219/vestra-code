import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { LlmReply, LlmRequest } from "@/lib/llm/types";

import { materializeFixture } from "./__fixtures__/load";
import { REAL_PATHS } from "./__fixtures__/real-paths";
import { createPythonAnalyzer } from "./python/analyzer";
import { createTypescriptAnalyzer } from "./typescript/analyzer";
import { recorder, tree } from "./python/__fixtures__/repo";
import {
  countSetAside,
  describeSetAside,
  markSetAside,
  resolveSetAside,
  setAsideContext,
  setAsideOf,
  setAsideReason,
  SET_ASIDE_KEY,
} from "./set-aside";
import type { AnalyzedEdge, AnalyzedNode } from "./types";

/**
 * Which files the model is not asked about.
 *
 * The first block is the one that matters: a rule here that ever matches a
 * file a person would ask about takes that file's name off the map, and the
 * person reading the map cannot open the code to notice. So every real path
 * of the four real projects is pinned, the ones that must be read are named
 * one by one on top of that, and so is every look-alike a verifier found the
 * first version setting aside (D168).
 */

const context = (paths: readonly string[] = []) => setAsideContext(paths);

const file = (filePath: string): AnalyzedNode => ({ ref: { type: "file", filePath } });
const imports = (from: string, to: string): AnalyzedEdge => ({
  source: { type: "file", filePath: from },
  target: { type: "file", filePath: to },
  type: "imports",
  confidence: "certain",
});

describe("real source is never set aside", () => {
  it.each([
    // vestra-code
    "src/lib/auth.ts",
    "src/lib/env.ts",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/api/projects/[id]/analyze/route.ts",
    "src/components/auth/sign-in-buttons.tsx",
    "src/components/app/add-project-form.tsx",
    "src/db/schema/app.ts",
    "src/analysis/pipeline.ts",
    "drizzle.config.ts",
    "next.config.ts",
    "package.json",
    "README.md",
    "docs/DECISIONS.md",
    "src/components/workspace/map/scale-fixture.ts",
    // Kim-and-Chang-, a Streamlit app
    "dashboard.py",
    "pages/log.py",
    "pages/positions.py",
    "backtest.py",
    "strategies/base.py",
    ".streamlit/config.toml",
    "pyproject.toml",
    // DCPortfolio, a static site
    "index.html",
    "styles.css",
    "projects/tessera/index.html",
    "assets/profile-photo.jpg",
    // kakauto
    "kakauto/features/send.py",
    "kakauto/__main__.py",
    "requirements.txt",
    // Shapes that sit next to a test convention without being one.
    "src/app/test/page.tsx",
    "app/tests/route.ts",
    "src/lib/testing.ts",
    "src/latest.ts",
    "contest.py",
    "docs/specs/plan.md",
    "src/fixture.ts",
    ".github/workflows/deploy.yml",
    "drizzle/schema.ts",
    "prisma/schema.prisma",
  ])("reads %s", (path) => {
    const withTools = context(["drizzle/meta/_journal.json", "prisma/schema.prisma"]);
    expect(setAsideReason(path, withTools)).toBeNull();
    expect(setAsideReason(path, context())).toBeNull();
  });

  it.each(Object.entries(REAL_PATHS))(
    "gives every file of %s the reason it was measured with",
    (_name, { files }) => {
      const real = context(files.map(([path]) => path));
      const got = files.map(([path]) => [path, setAsideReason(path, real)] as const);
      expect(got).toEqual(files);
    },
  );

  it("reads well over half of every real project", () => {
    // The whole feature is a trim, not a purge. If a rule change ever sets
    // aside most of a project, it has stopped describing tools and tests.
    for (const [name, { files }] of Object.entries(REAL_PATHS)) {
      const real = context(files.map(([path]) => path));
      const read = files.filter(([path]) => setAsideReason(path, real) === null).length;
      expect(read / files.length, name).toBeGreaterThan(0.5);
    }
  });
});

describe("ordinary words are not a tool's convention (D168)", () => {
  // Each of these came back set aside from the first version. Every one is
  // a plausible file of somebody's product.
  it.each([
    // A sports app's fixtures, an exam app's tests.
    ["src/components/fixtures/FixtureCard.tsx", ["src/components/fixtures/FixtureCard.tsx"]],
    ["src/tests/QuizRunner.tsx", ["src/tests/QuizRunner.tsx", "src/tests/Score.tsx"]],
    // A Python module about A/B testing, a network speed checker.
    ["ab_test.py", ["ab_test.py", "app.py"]],
    ["speed_test.py", ["speed_test.py"]],
    // An OpenAPI description, an end-to-end runner script with no tests in it.
    ["spec/openapi.yaml", ["spec/openapi.yaml"]],
    ["e2e/run.py", ["e2e/run.py"]],
    // Named with a word a generator also uses.
    ["src/lib/user-generated.ts", ["src/lib/user-generated.ts"]],
    ["src/lib/generated.ts", ["src/lib/generated.ts"]],
  ])("reads %s", (path, paths) => {
    expect(setAsideReason(path, context(paths))).toBeNull();
  });

  it("reads SQL beside a drizzle journal that drizzle-kit did not write", () => {
    // Journal at the project root: drizzle-kit writes to the root, and a
    // query somewhere below it is still the person's.
    const atRoot = context(["meta/_journal.json", "0000_init.sql", "src/db/queries/report.sql"]);
    expect(setAsideReason("src/db/queries/report.sql", atRoot)).toBeNull();
    expect(setAsideReason("0000_init.sql", atRoot)).toBe("generated");

    // Journal under `db/`: the seed script beside the migrations is the person's.
    const inDb = context(["db/meta/_journal.json", "db/seed.sql", "db/0003_add_users.sql"]);
    expect(setAsideReason("db/seed.sql", inDb)).toBeNull();
    expect(setAsideReason("db/0003_add_users.sql", inDb)).toBe("generated");
    expect(setAsideReason("db/meta/0003_snapshot.json", inDb)).toBe("generated");
    expect(setAsideReason("db/meta/notes.json", inDb)).toBeNull();
  });

  it("does not look at the project's kind at all", () => {
    // The kind is not an input: the tool that wrote a file decides, and the
    // file list says which tools are there.
    expect(setAsideContext.length).toBe(1);
  });
});

describe("what is set aside, and why", () => {
  it("sets aside a tool's own settings", () => {
    for (const path of [
      ".claude/settings.local.json",
      ".claude/launch.json",
      "Instructions/.obsidian/appearance.json",
      ".cursor/rules/style.mdc",
      ".agents/config.json",
    ]) {
      expect(setAsideReason(path, context()), path).toBe("tool_settings");
    }
  });

  it("sets aside what drizzle-kit wrote, but only where drizzle-kit writes", () => {
    const drizzle = context(["drizzle/meta/_journal.json", "drizzle.config.ts"]);
    expect(setAsideReason("drizzle/0000_loose_black_bolt.sql", drizzle)).toBe("generated");
    expect(setAsideReason("drizzle/meta/0005_snapshot.json", drizzle)).toBe("generated");
    expect(setAsideReason("drizzle/meta/_journal.json", drizzle)).toBe("generated");
    // No journal, no generator: somebody's own SQL.
    expect(setAsideReason("drizzle/0000_loose_black_bolt.sql", context())).toBeNull();
  });

  it("sets aside Prisma's migrations only when there is a Prisma schema", () => {
    const path = "prisma/migrations/20260101_init/migration.sql";
    expect(setAsideReason(path, context(["prisma/schema.prisma"]))).toBe("generated");
    expect(setAsideReason(path, context())).toBeNull();
  });

  it("sets aside lock files and caches ingest lets through", () => {
    expect(setAsideReason("skills-lock.json", context())).toBe("generated");
    expect(setAsideReason(".pytest_cache/README.md", context())).toBe("generated");
    expect(setAsideReason("src/__snapshots__/view.test.ts.snap", context())).toBe("generated");
    expect(setAsideReason("src/api.generated.ts", context())).toBe("generated");
  });

  it("sets aside tests and their data, by the conventions test runners use", () => {
    const paths = [
      "src/analysis/pipeline.test.ts",
      "src/components/workspace/coverage.test.ts",
      "src/analysis/__fixtures__/shop/src/app/page.tsx.txt",
      "src/qa/__fixtures__/project.ts",
      "tests/test_send.py",
      "tests/conftest.py",
      "tests/fixtures/chatlog_baseline.png",
      "tests/helpers.py",
      "e2e/checkout.spec.ts",
      "e2e/support/login.ts",
      "cypress/e2e/cart.cy.ts",
      "src/__tests__/cart.tsx",
      "handlers/orders_test.go",
    ];
    const project = context(paths);
    for (const path of paths) {
      expect(setAsideReason(path, project), path).toBe("tests");
    }
  });

  it("sets aside a Python file named like a test only when it defines one", () => {
    // pytest collects `test…` functions and `Test…` classes from such a file;
    // a file with neither is not a test to pytest either.
    const project = context(["test_orders.py", "orders_test.py"]);
    expect(setAsideReason("test_orders.py", project)).toBeNull();
    expect(setAsideReason("test_orders.py", project, { definesTests: true })).toBe("tests");
    expect(setAsideReason("orders_test.py", project, { definesTests: true })).toBe("tests");
  });
});

describe("the whole-graph answer", () => {
  it("never sets aside a file that serves an address, whatever folder it is in", () => {
    // A page is somewhere a person can go, and where a flow starts.
    const nodes: AnalyzedNode[] = [
      file("tests/app.py"),
      { ref: { type: "route", filePath: "tests/app.py", name: "/" } },
      file("tests/test_app.py"),
      file("pages/test_results.py"),
      { ref: { type: "route", filePath: "pages/test_results.py", name: "/test_results" } },
      { ref: { type: "symbol", filePath: "pages/test_results.py", name: "test_chart" }, kind: "function" },
    ];
    const paths = nodes.filter((n) => n.ref.type === "file").map((n) => n.ref.filePath);
    const tagged = resolveSetAside({ nodes, edges: [] }, context(paths));
    expect([...tagged.keys()]).toEqual(["tests/test_app.py"]);
  });

  it("reads a file something we read imports, however it is named", () => {
    const nodes = [
      file("src/app/page.tsx"),
      file("src/components/fixtures/teams.json"),
      file("src/__fixtures__/demo.ts"),
      file("src/__fixtures__/demo-data.ts"),
      file("src/__fixtures__/only-tests.ts"),
      file("src/page.test.tsx"),
    ];
    const edges = [
      // The page imports a demo fixture, which imports its data: both read.
      imports("src/app/page.tsx", "src/__fixtures__/demo.ts"),
      imports("src/__fixtures__/demo.ts", "src/__fixtures__/demo-data.ts"),
      // Only the test imports this one: it stays set aside.
      imports("src/page.test.tsx", "src/__fixtures__/only-tests.ts"),
      imports("src/page.test.tsx", "src/app/page.tsx"),
    ];
    const paths = nodes.map((node) => node.ref.filePath);
    const tagged = resolveSetAside({ nodes, edges }, context(paths));
    expect([...tagged].sort()).toEqual([
      ["src/__fixtures__/only-tests.ts", "tests"],
      ["src/page.test.tsx", "tests"],
    ]);
  });

  it("uses what a Python file defines to decide a pytest-named file", () => {
    const nodes: AnalyzedNode[] = [
      file("ab_test.py"),
      { ref: { type: "symbol", filePath: "ab_test.py", name: "run_ab_test" }, kind: "function" },
      file("test_orders.py"),
      { ref: { type: "symbol", filePath: "test_orders.py", name: "test_total" }, kind: "function" },
      file("orders_test.py"),
      { ref: { type: "symbol", filePath: "orders_test.py", name: "TestOrders" }, kind: "class" },
      file("speed_test.py"),
      // A class named `test…` is not something pytest collects.
      { ref: { type: "symbol", filePath: "speed_test.py", name: "testbench" }, kind: "class" },
    ];
    const paths = nodes.filter((n) => n.ref.type === "file").map((n) => n.ref.filePath);
    const tagged = resolveSetAside({ nodes, edges: [] }, context(paths));
    expect([...tagged.keys()].sort()).toEqual(["orders_test.py", "test_orders.py"]);
  });

  it("counts a pytest name only when it is spelled the way tests are (D176)", () => {
    const fn = (filePath: string, name: string): AnalyzedNode => ({
      ref: { type: "symbol", filePath, name },
      kind: "function",
    });
    const cls = (filePath: string, name: string): AnalyzedNode => ({
      ref: { type: "symbol", filePath, name },
      kind: "class",
    });
    const nodes: AnalyzedNode[] = [
      // The verifier's entry script: `train()` and `testing_split()`.
      file("train_test.py"),
      fn("train_test.py", "train"),
      fn("train_test.py", "testing_split"),
      // A model class somebody called Testimonial.
      file("reviews_test.py"),
      cls("reviews_test.py", "Testimonial"),
      // Real tests, in each spelling pytest users write.
      file("test_a.py"),
      fn("test_a.py", "test_total"),
      file("test_b.py"),
      fn("test_b.py", "testTotal"),
      file("test_c.py"),
      fn("test_c.py", "test"),
      file("c_test.py"),
      cls("c_test.py", "TestOrders"),
      file("d_test.py"),
      cls("d_test.py", "Test_orders"),
    ];
    const paths = nodes.filter((n) => n.ref.type === "file").map((n) => n.ref.filePath);
    const tagged = resolveSetAside({ nodes, edges: [] }, context(paths));
    expect([...tagged.keys()].sort()).toEqual([
      "c_test.py",
      "d_test.py",
      "test_a.py",
      "test_b.py",
      "test_c.py",
    ]);
  });

  it("reads what a read file loads while it runs, and what that imports (D176)", () => {
    const nodes = [
      file("src/app/quiz/page.tsx"),
      file("src/tests/QuizRunner.tsx"),
      file("src/tests/Score.tsx"),
      file("src/tests/QuizRunner.test.tsx"),
      file("src/tests/only-tests.ts"),
    ];
    const edges = [
      imports("src/tests/QuizRunner.tsx", "src/tests/Score.tsx"),
      imports("src/tests/QuizRunner.test.tsx", "src/tests/QuizRunner.tsx"),
      imports("src/tests/QuizRunner.test.tsx", "src/tests/only-tests.ts"),
    ];
    const paths = nodes.map((node) => node.ref.filePath);
    const withoutLoads = resolveSetAside({ nodes, edges }, context(paths));
    expect([...withoutLoads.keys()].sort()).toEqual([
      "src/tests/QuizRunner.test.tsx",
      "src/tests/QuizRunner.tsx",
      "src/tests/Score.tsx",
      "src/tests/only-tests.ts",
    ]);

    const loads = [{ from: "src/app/quiz/page.tsx", to: "src/tests/QuizRunner.tsx" }];
    const withLoads = resolveSetAside({ nodes, edges, loads }, context(paths));
    expect([...withLoads.keys()].sort()).toEqual([
      "src/tests/QuizRunner.test.tsx",
      "src/tests/only-tests.ts",
    ]);
  });

  it("writes the reason onto the file node and nothing else, and takes a stale one off", () => {
    const nodes: AnalyzedNode[] = [
      { ref: { type: "file", filePath: "src/lib/auth.ts" }, metadata: { [SET_ASIDE_KEY]: "tests" } },
      file("src/lib/auth.test.ts"),
      { ref: { type: "symbol", filePath: "src/lib/auth.test.ts", name: "it" } },
    ];
    const tagged = markSetAside({ nodes, edges: [] }, context());

    expect([...tagged]).toEqual([["src/lib/auth.test.ts", "tests"]]);
    expect(setAsideOf(nodes[0])).toBeNull();
    expect(nodes[0].metadata).toEqual({});
    expect(setAsideOf(nodes[1])).toBe("tests");
    expect(nodes[2].metadata).toBeUndefined();
  });
});

describe("a component a page loads while it runs, through the real TypeScript analyzer", () => {
  // The verifier's reproduction (D176): a page that loads its quiz with
  // `next/dynamic`, from a folder that also holds the quiz's test. With
  // static imports only, both quiz files were set aside and Pass 2 left them
  // unnamed — while the page a person opens renders them.
  const QUIZ = {
    "src/app/quiz/page.tsx":
      'import dynamic from "next/dynamic";\n\n' +
      'const QuizRunner = dynamic(() => import("../../tests/QuizRunner"));\n\n' +
      "export default function QuizPage() {\n  return <QuizRunner />;\n}\n",
    "src/tests/QuizRunner.tsx":
      'import { Score } from "./Score";\n\n' +
      "export default function QuizRunner() {\n  return <Score points={3} />;\n}\n",
    "src/tests/Score.tsx":
      "export function Score({ points }: { points: number }) {\n  return <p>{points}</p>;\n}\n",
    "src/tests/QuizRunner.test.tsx":
      'import QuizRunner from "./QuizRunner";\n\nexport const rendered = QuizRunner();\n',
    // Loaded the other ways a person writes it, from files that are read.
    "src/lib/lazy.ts":
      'import { lazy } from "react";\n\nexport const LazyPrice = lazy(() => import("@/components/PriceTag"));\n',
    "src/lib/legacy.js": 'const totals = require("../legacy/totals");\nmodule.exports = { totals };\n',
    // A specifier nobody can resolve, and one outside the repository: neither
    // becomes anything.
    "src/lib/plugins.ts":
      'export const load = (name: string) => import(`./plugins/${name}`);\n' +
      'export const missing = () => import("./does-not-exist");\n',
  };

  it("finds each load, and reads what it reaches", async () => {
    const fixture = materializeFixture("shop", QUIZ);
    try {
      const graph = await createTypescriptAnalyzer().analyze(
        fixture.files,
        fixture.root,
        recorder().emit,
      );
      expect(
        (graph.loads ?? []).map((load) => `${load.from} -> ${load.to}`).sort(),
      ).toEqual([
        "src/app/quiz/page.tsx -> src/tests/QuizRunner.tsx",
        "src/lib/lazy.ts -> src/components/PriceTag.tsx",
        "src/lib/legacy.js -> src/legacy/totals.ts",
      ]);
      // Reported beside the graph, never drawn on it: no stored row changes.
      expect(
        graph.edges.filter(
          (edge) =>
            edge.source.filePath === "src/app/quiz/page.tsx" &&
            edge.target.filePath === "src/tests/QuizRunner.tsx",
        ),
      ).toEqual([]);

      const project = setAsideContext(fixture.files.map((entry) => entry.path));
      const tagged = markSetAside(graph, project);
      expect([...tagged].filter(([path]) => path.startsWith("src/tests/"))).toEqual([
        ["src/tests/QuizRunner.test.tsx", "tests"],
      ]);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("the Python model half asks the same question the rows are tagged with", () => {
  // The verifier's reproduction, as a test (D168): two Streamlit pages whose
  // names look like tests. Asked one path at a time, the model half skipped
  // both, flagged neither and counted neither — their flows led nowhere and
  // nothing on screen said why.
  const streamlitApp = () =>
    tree({
      "requirements.txt": "streamlit\n",
      "app.py": "import streamlit as st\nfrom db import load\n\nst.title('home')\nload()\n",
      "db.py": "def load():\n    return []\n",
      "pages/ab_test.py":
        "import streamlit as st\nfrom db import load\n\ndef test_variant():\n    return load()\n\nst.write(test_variant())\n",
      "pages/test_results.py":
        "import streamlit as st\nfrom db import load\n\nst.write(load())\n",
      "tests/test_db.py": "from db import load\n\ndef test_load():\n    assert load() == []\n",
    });

  const askedModel = () => {
    const asked: string[] = [];
    return {
      asked,
      llm: {
        async complete(request: LlmRequest): Promise<LlmReply> {
          const user = request.messages.find((message) => message.role === "user")?.content ?? "";
          for (const match of user.matchAll(/^파일: (.+)$/gm)) asked.push(match[1]);
          return {
            text: JSON.stringify({ calls: [], roles: [] }),
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 5 },
            finishReason: "stop",
          };
        },
      },
    };
  };

  it("reads a page named like a test, flags it, and tags only the real test", async () => {
    const files = streamlitApp();
    const project = setAsideContext(files.map((entry) => entry.path));
    const model = askedModel();
    const analyzer = createPythonAnalyzer({
      llm: model.llm,
      setAside: (graph) => resolveSetAside(graph, project),
    });
    const graph = await analyzer.analyze(files, "/repo", recorder().emit);

    const routes = graph.nodes.filter((node) => node.ref.type === "route");
    expect(routes.map((node) => node.ref.filePath).sort()).toEqual([
      "app.py",
      "pages/ab_test.py",
      "pages/test_results.py",
    ]);

    const tagged = markSetAside(graph, project);
    expect([...tagged]).toEqual([["tests/test_db.py", "tests"]]);

    // What the model was shown, and what the rows say, are one answer. The
    // page that defines a function is put to the model; the one with only
    // top-level code has nothing to ask and still counts as looked at, which
    // is the model half's own rule. The test is never shown.
    expect(model.asked).toContain("pages/ab_test.py");
    expect(model.asked).not.toContain("tests/test_db.py");
    const flag = (path: string) =>
      graph.nodes.find((node) => node.ref.type === "file" && node.ref.filePath === path)?.metadata;
    for (const path of ["app.py", "db.py", "pages/ab_test.py", "pages/test_results.py"]) {
      expect(flag(path)?.llmExamined, path).toBe(true);
    }
    expect(flag("pages/ab_test.py")?.[SET_ASIDE_KEY]).toBeUndefined();
    expect(flag("tests/test_db.py")?.llmExamined).toBeUndefined();
    expect(flag("tests/test_db.py")?.[SET_ASIDE_KEY]).toBe("tests");

    // Every parsed Python file is exactly one of: read by the model, or set
    // aside and counted. Never neither.
    for (const node of graph.nodes) {
      if (node.ref.type !== "file" || !node.ref.filePath.endsWith(".py")) continue;
      const read = node.metadata?.llmExamined !== undefined;
      const aside = setAsideOf(node) !== null;
      expect(read !== aside, node.ref.filePath).toBe(true);
    }
  });

  it("reads an entry script whose name pytest would take for a test (D176)", async () => {
    // The verifier's `train_test.py`: pytest's own prefix rule would collect
    // `testing_split`, and the file was set aside as a test.
    const files = tree({
      "requirements.txt": "scikit-learn\n",
      "data.py": "def load():\n    return []\n",
      "train_test.py":
        "from data import load\n\n" +
        "def testing_split(rows):\n    return rows[:1], rows[1:]\n\n" +
        "def train():\n    return testing_split(load())\n\n" +
        "if __name__ == '__main__':\n    train()\n",
      "tests/test_data.py": "from data import load\n\ndef test_load():\n    assert load() == []\n",
    });
    const project = setAsideContext(files.map((entry) => entry.path));
    const model = askedModel();
    const graph = await createPythonAnalyzer({
      llm: model.llm,
      setAside: (parsed) => resolveSetAside(parsed, project),
    }).analyze(files, "/repo", recorder().emit);

    expect(model.asked).toContain("train_test.py");
    expect(model.asked).not.toContain("tests/test_data.py");
    expect([...markSetAside(graph, project)]).toEqual([["tests/test_data.py", "tests"]]);
  });
});

describe("what a person is told", () => {
  it("can be said in the browser: the words import nothing", () => {
    // The band over the map says the same sentence from the counts the map
    // carries. `set-aside.ts` reaches `node:crypto` through `ids.ts`, so the
    // sentence lives where nothing is imported at all.
    const source = readFileSync(new URL("./set-aside-words.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it("counts by reason in a fixed order and says nothing when there is nothing", () => {
    const counts = countSetAside(
      new Map([
        [".claude/launch.json", "tool_settings"],
        ["a.test.ts", "tests"],
        ["b.test.ts", "tests"],
        ["skills-lock.json", "generated"],
      ] as const),
    );
    expect(counts).toEqual([
      { reason: "tests", count: 2 },
      { reason: "generated", count: 1 },
      { reason: "tool_settings", count: 1 },
    ]);
    expect(describeSetAside([])).toBeNull();
    expect(countSetAside(new Map())).toEqual([]);
  });

  it("says how many, of what kind, that it was a choice, and that the map still has them", () => {
    const sentence = describeSetAside([
      { reason: "tests", count: 113 },
      { reason: "generated", count: 14 },
      { reason: "tool_settings", count: 1 },
    ]);
    expect(sentence).toContain("113개");
    expect(sentence).toContain("14개");
    expect(sentence).toContain("1개");
    expect(sentence).toContain("일부러");
    expect(sentence).toContain("지도에는 그대로 있어요");
    // Not a budget sentence: those say we stopped, this says we chose.
    expect(sentence).not.toMatch(/멈췄|다 써서|한도/);
    // Words the product may not use about its own behaviour, and the graph's
    // own vocabulary, which never reaches a person.
    for (const word of ["실행", "추적", "실시간", "노드", "엣지", "안전"]) {
      expect(sentence).not.toContain(word);
    }
    // 해요체, every sentence.
    for (const part of (sentence ?? "").split(". ").filter(Boolean)) {
      expect(part.replace(/\.$/, "")).toMatch(/요$/);
    }
  });
});
