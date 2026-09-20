import { describe, expect, it, vi } from "vitest";

import type { GraphItem } from "@/lib/graph/view";

import { fixtureReader, GRAPH, SOURCE } from "./__fixtures__/project";
import type { SourceReader } from "./source";
import {
  createToolContext,
  QA_TOOL_SPECS,
  runTool,
  toArgumentObject,
  toolSpecsFor,
  type QaGraph,
} from "./tools";
import type { QaToolName } from "./types";

/**
 * The four tools, against a six-item project and a reader made of strings.
 *
 * What is tested is not "does it return something" but the two promises every
 * result makes: that it is small, and that it says so when it left something
 * out. A tool that quietly returns the top ten of forty has told the model
 * there are ten, and the answer will say ten.
 */

function context(
  graph: QaGraph = GRAPH,
  read: SourceReader | null = fixtureReader(),
) {
  return createToolContext(graph, read);
}

function run(
  name: QaToolName,
  args: Record<string, unknown>,
  ctx = context(),
) {
  return runTool(ctx, name, args);
}

function file(path: string, index: number): GraphItem {
  return {
    id: `f${index}`,
    kind: "file",
    shape: null,
    name: path,
    label: null,
    summary: null,
    path,
    startLine: null,
    endLine: null,
    fromUser: false,
    usedBy: 0,
    uses: 0,
  };
}

describe("the tool set", () => {
  it("makes every tool ask why it is being called", () => {
    // The hypothesis is what turns a sequence of calls into something a person
    // can watch, and it is free if it rides on the call that was happening
    // anyway.
    for (const tool of QA_TOOL_SPECS) {
      const parameters = tool.parameters as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(parameters.properties.why).toBeDefined();
      expect(parameters.properties.learned).toBeDefined();
      expect(parameters.required).toContain("why");
    }
  });

  it("drops read_source entirely when a project's files cannot be opened", () => {
    // Rather than leaving it in to refuse: a tool that always fails is a step
    // the user pays for to be told no.
    const names = toolSpecsFor(false).map((tool) => tool.name);
    expect(names).not.toContain("read_source");
    expect(names).toContain("report");
  });
});

describe("toArgumentObject", () => {
  it("takes an object or the JSON string some endpoints hand back", () => {
    expect(toArgumentObject({ words: "결제" })).toEqual({ words: "결제" });
    expect(toArgumentObject('{"words":"결제"}')).toEqual({ words: "결제" });
  });

  it("is null for anything else, so a caller says so instead of crashing", () => {
    expect(toArgumentObject("not json")).toBeNull();
    expect(toArgumentObject(["결제"])).toBeNull();
    expect(toArgumentObject(null)).toBeNull();
  });
});

describe("find_items", () => {
  it("searches the plain-language name, not only the code name", async () => {
    const outcome = await run("find_items", { why: "", words: "가격" });
    expect(outcome.text).toContain("formatPrice");
    expect(outcome.text).toContain("가격 표시");
  });

  it("is the map's own beam, so 초성 works here exactly as it does on screen", async () => {
    // Reusing `beam.ts` rather than writing a second search is what keeps the
    // user's own words answered the same way in both places.
    const outcome = await run("find_items", { why: "", words: "ㄱㅈ" });
    expect(outcome.text).toContain("PayButton");
  });

  it("puts a line range on the record only for things that have one", async () => {
    const outcome = await run("find_items", { why: "", words: "format" });
    // `formatPrice` knows where it lives; `format.ts` as a whole has no line
    // range, so seeing it in a result makes no line of it citable.
    expect(outcome.ledger).toEqual([
      { path: "src/lib/format.ts", startLine: 3, endLine: 8, read: false },
    ]);
  });

  it("says how many it found and how many it is showing", async () => {
    const many: GraphItem[] = Array.from({ length: 25 }, (_, i) => ({
      ...file(`src/lib/handler${i}.ts`, i),
      kind: "symbol" as const,
      name: `handler${i}`,
      startLine: 1,
      endLine: 5,
      usedBy: i,
    }));
    const outcome = await run(
      "find_items",
      { why: "", words: "handler" },
      context({ items: many, connections: [] }),
    );
    expect(outcome.text).toContain("25곳을 찾았어요");
    expect(outcome.text.split("\n").length).toBe(11);
    // Busiest first, deterministically, so two runs of one question compare.
    expect(outcome.text).toContain("handler24");
    expect(outcome.text).not.toContain("[1] handler0 ");
  });

  it("offers a way forward when nothing matched", async () => {
    const outcome = await run("find_items", { why: "", words: "존재하지않는말" });
    expect(outcome.text).toContain("list_files");
    expect(outcome.ledger).toEqual([]);
  });

  it("asks again instead of throwing when the words are missing", async () => {
    const outcome = await run("find_items", { why: "" });
    expect(outcome.text).toContain("낱말이 필요해요");
  });
});

describe("open_item", () => {
  it("names both directions and how sure each link is", async () => {
    const outcome = await run("open_item", { why: "", item: 4 });
    expect(outcome.text).toContain("PayButton");
    expect(outcome.text).toContain("누르면 주문을 넣어요.");
    expect(outcome.text).toContain("여기서 나가는 연결");
    expect(outcome.text).toContain("여기로 들어오는 연결");
    // The one guessed link in the fixture has to read as a guess.
    expect(outcome.text).toContain("짐작이에요");
    expect(outcome.text).toContain("확실해요");
  });

  it("puts every neighbour with a line range on the record, unread", async () => {
    const outcome = await run("open_item", { why: "", item: 4 });
    expect(outcome.ledger).toContainEqual({
      path: "src/components/PayButton.tsx",
      startLine: 5,
      endLine: 18,
      read: false,
    });
    expect(outcome.ledger.every((entry) => !entry.read)).toBe(true);
  });

  it("says out loud when the cap left something out", async () => {
    const hub = file("src/lib/hub.ts", 0);
    const leaves: GraphItem[] = Array.from({ length: 12 }, (_, i) => ({
      ...file(`src/lib/leaf${i}.ts`, i + 1),
      id: `leaf${i}`,
    }));
    const outcome = await run(
      "open_item",
      { why: "", item: 1 },
      context({
        items: [hub, ...leaves],
        connections: leaves.map((leaf, i) => ({
          id: `c${i}`,
          from: "f0",
          to: leaf.id,
          relation: "imports" as const,
          certainty: "certain" as const,
        })),
      }),
    );
    // A list that stops at six with no note reads as "that is all there is",
    // which on this product is a false statement about somebody's code.
    expect(outcome.text).toContain("6개는 줄였어요");
  });

  it("takes a number that does not exist as input, not as a crash", async () => {
    const outcome = await run("open_item", { why: "", item: 99 });
    expect(outcome.text).toContain("없는 번호");
    expect(outcome.ledger).toEqual([]);
  });

  it("says plainly when nothing is connected yet", async () => {
    const outcome = await run(
      "open_item",
      { why: "", item: 1 },
      context({ items: [file("src/notes.md", 0)], connections: [] }),
    );
    // "연결이 없어요" is a fact. "쓰이지 않아요" would be a claim about the
    // user's code that a one-hop walk cannot support.
    expect(outcome.text).toContain("아직 알려진 연결이 없어요");
  });
});

describe("list_files", () => {
  it("lists what is under a folder, however the folder was spelled", async () => {
    for (const prefix of ["src/lib", "src/lib/", "./src/lib", "/src/lib"]) {
      const outcome = await run("list_files", { why: "", prefix });
      expect(outcome.text).toContain("src/lib/format.ts");
      expect(outcome.text).not.toContain("PayButton.tsx");
    }
  });

  it("never makes a line citable, because a name is not a reading", async () => {
    const outcome = await run("list_files", { why: "" });
    expect(outcome.ledger).toEqual([]);
  });

  it("folds a big folder into folders with counts", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      file(`src/parts/p${i}/index.ts`, i),
    );
    const outcome = await run(
      "list_files",
      { why: "", prefix: "src/parts/" },
      context({ items: many, connections: [] }),
    );
    expect(outcome.text).toContain("파일이 60개라 폴더로 묶어");
    expect(outcome.text).toContain("폴더 src/parts/p0/ — 파일 1개");
  });

  it("points at what does exist when a folder is empty", async () => {
    const outcome = await run("list_files", { why: "", prefix: "server/" });
    expect(outcome.text).toContain("파일이 없어요");
    expect(outcome.text).toContain("src/");
  });
});

describe("read_source", () => {
  it("returns a numbered window and records it as read", async () => {
    const outcome = await run("read_source", {
      why: "",
      path: "src/lib/format.ts",
      fromLine: 5,
      lines: 4,
    });
    expect(outcome.text).toContain("src/lib/format.ts 5-8줄 (전체 12줄)");
    expect(outcome.ledger).toEqual([
      { path: "src/lib/format.ts", startLine: 5, endLine: 8, read: true },
    ]);
  });

  it("refuses a path the project's own map does not hold", async () => {
    // The same rule the file endpoint enforces: a path the model produced is a
    // request, not a permission. Without it this is a reader for the whole
    // repository — harmless on a public repo, a real leak on a private one
    // reachable with the signed-in user's token.
    const outcome = await run("read_source", { why: "", path: "../../etc/passwd" });
    expect(outcome.text).toContain("지도에 없는 파일");
    expect(outcome.ledger).toEqual([]);
  });

  it("passes on the reader's refusal in words", async () => {
    const outcome = await run(
      "read_source",
      { why: "", path: "src/lib/format.ts" },
      context(GRAPH, fixtureReader({})),
    );
    expect(outcome.text).toContain("찾지 못했어요");
    expect(outcome.ledger).toEqual([]);
  });

  it("fetches one file once, however many windows are asked for", async () => {
    const read = vi.fn(fixtureReader());
    const ctx = context(GRAPH, read);
    await runTool(ctx, "read_source", { why: "", path: "src/lib/format.ts", fromLine: 1 });
    await runTool(ctx, "read_source", { why: "", path: "src/lib/format.ts", fromLine: 9 });
    // A real investigation reads the imports at the top and the defect at the
    // bottom. On a GitHub project each read is a round trip across the internet
    // counted against the wall-clock ceiling.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("explains the ceiling on inference when there is no source at all", async () => {
    const outcome = await run(
      "read_source",
      { why: "", path: "src/lib/format.ts" },
      context(GRAPH, null),
    );
    expect(outcome.text).toContain("inferred");
  });

  it("takes a line number that arrived as a string", async () => {
    const outcome = await run("read_source", {
      why: "",
      path: "src/lib/format.ts",
      fromLine: "7",
      lines: "1",
    });
    expect(outcome.text).toContain("src/lib/format.ts 7-7줄");
    expect(outcome.text).toContain(SOURCE["src/lib/format.ts"].split("\n")[6]);
  });
});
