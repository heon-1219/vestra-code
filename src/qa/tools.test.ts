import { describe, expect, it, vi } from "vitest";

import type { GraphItem } from "@/lib/graph/view";

import { fixtureReader, GRAPH, SOURCE } from "./__fixtures__/project";
import { checkFindings } from "./answer";
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
 * The tools, against a six-item project and a reader made of strings.
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

  it("drops every reading tool when a project's files cannot be opened", () => {
    // Rather than leaving them in to refuse: a tool that always fails is a
    // step the user pays for to be told no.
    const names = toolSpecsFor(false).map((tool) => tool.name);
    expect(names).not.toContain("read_source");
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("search_source");
    expect(names).toContain("report");
    // `follow_import` stays: resolving a name to the file it refers to is a
    // question about the graph, and the graph is there either way.
    expect(names).toContain("follow_import");
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

/**
 * The tools that let the loop actually go rummaging, and the one promise each
 * of them has to keep.
 *
 * Every test here that matters is about the **citation ledger**. A tool that
 * returns the text of a line and forgets to register it produces an
 * investigation whose true findings are all refused; a tool that registers
 * lines it never printed launders a guess into a fact. Both are failures of
 * this module, not of the model, so both are tested here rather than hoped
 * for in a live run.
 */

function manyFiles(count: number, prefix = "src/"): QaGraph {
  const items: GraphItem[] = [];
  for (let n = 0; n < count; n += 1) {
    items.push(file(`${prefix}mod${String(n).padStart(3, "0")}.ts`, n));
  }
  return { items, connections: [] };
}

describe("search_source", () => {
  it("finds a word written inside a file that no name contains", async () => {
    // The founder's own example: the project has nothing called 결제, and the
    // answer is a string in the middle of a file.
    const outcome = await run("search_source", { why: "", words: "en-US" });
    expect(outcome.text).toContain("src/lib/format.ts:7|");
    expect(outcome.text).toContain("en-US");
  });

  it("registers exactly the line it printed, and nothing around it", async () => {
    const outcome = await run("search_source", { why: "", words: "en-US" });
    expect(outcome.ledger).toContainEqual({
      path: "src/lib/format.ts",
      startLine: 7,
      endLine: 7,
      read: true,
    });

    // A claim about that one line stands as `certain`...
    const kept = checkFindings(
      [
        {
          claim: "이 줄에서 en-US 형식으로 숫자를 바꿔요.",
          certainty: "certain",
          citations: [{ path: "src/lib/format.ts", startLine: 7, endLine: 7 }],
        },
      ],
      outcome.ledger,
    );
    expect(kept.kept).toHaveLength(1);
    expect(kept.refused).toHaveLength(0);

    // ...and a claim about the lines around it does not. A search showed one
    // line; saying something about six is saying something about five nobody
    // read.
    const wider = checkFindings(
      [
        {
          claim: "이 함수 전체가 en-US를 써요.",
          certainty: "certain",
          citations: [{ path: "src/lib/format.ts", startLine: 3, endLine: 8 }],
        },
      ],
      outcome.ledger,
    );
    expect(wider.kept).toHaveLength(0);
    expect(wider.refused[0].reason).toBe("unread_citation");
  });

  it("puts the file and what is written on the matched line on the trail", async () => {
    const outcome = await run("search_source", { why: "", words: "en-US" });
    // The file it matched in, then the piece the line belongs to — the same
    // order a read puts them in, because the map animates them in that order.
    expect(outcome.items).toEqual(["f-format", "s-format"]);
    // A search is not a traversal. It crossed no connection to get there.
    expect(outcome.hops).toEqual([]);
  });

  it("says how many files it looked inside, and never implies it saw them all", async () => {
    const graph = manyFiles(200);
    const source: Record<string, string> = {};
    for (const item of graph.items) source[item.path ?? ""] = "const x = 1;\n";
    const outcome = await run(
      "search_source",
      { why: "", words: "결제" },
      context(graph, fixtureReader(source)),
    );
    // Two hundred files, sixty looked inside. The result says both numbers,
    // because "I searched the project" and "I searched sixty of its two
    // hundred files" are different statements about somebody's code.
    expect(outcome.text).toContain("200개 중 60개");
    // And the absence it reports is bounded by what it opened: "들여다본
    // 파일에는 없었어요", never "이 프로젝트에는 없어요".
    expect(outcome.text).toContain("들여다본 파일에는");
  });

  it("never turns what it could not open into an absence", async () => {
    // The failure this was found in: GitHub rate limited every read, and the
    // search reported that a word was not in a project that contains it. The
    // model believed it, and so would the person reading the trace.
    const graph = manyFiles(4);
    const blocked: SourceReader = async () => ({
      ok: false,
      reason: "rate_limited",
    });
    const outcome = await run(
      "search_source",
      { why: "", words: "stop_loss" },
      context(graph, blocked),
    );
    expect(outcome.text).toContain("있는지 없는지 말할 수 없어요");
    expect(outcome.text).not.toContain("없었어요");
    expect(outcome.ledger).toEqual([]);
  });

  it("looks inside each file once, however many searches ask", async () => {
    const graph = manyFiles(20);
    const source: Record<string, string> = {};
    for (const item of graph.items) source[item.path ?? ""] = "const x = 1;\n";
    const read = vi.fn(fixtureReader(source));
    const ctx = createToolContext(graph, read);
    await runTool(ctx, "search_source", { why: "", words: "결제" });
    const first = read.mock.calls.length;
    await runTool(ctx, "search_source", { why: "", words: "주문" });
    // Twenty files scanned twice is forty requests against a limit of sixty an
    // hour, and the rest of the investigation then reads nothing at all. This
    // is the bound that made a second search free.
    expect(read.mock.calls.length).toBe(first);
    expect(first).toBe(20);
  });

  it("keeps one loud file from crowding out the quiet ones", async () => {
    const graph = manyFiles(5);
    const source: Record<string, string> = {};
    for (const [index, item] of graph.items.entries()) {
      // The first file matches forty times; the others match once each.
      source[item.path ?? ""] =
        index === 0
          ? Array.from({ length: 40 }, () => "stripe()").join("\n")
          : "// stripe\n";
    }
    const outcome = await run(
      "search_source",
      { why: "", words: "stripe" },
      context(graph, fixtureReader(source)),
    );
    const paths = new Set(outcome.ledger.map((entry) => entry.path));
    // Three from the loud one, one from each of the other four.
    expect(paths.size).toBe(5);
    expect(outcome.ledger.filter((e) => e.path.endsWith("mod000.ts"))).toHaveLength(3);
  });

  it("narrows to a folder when asked", async () => {
    const outcome = await run("search_source", {
      why: "",
      words: "formatPrice",
      where: "src/components/",
    });
    expect(outcome.text).toContain("src/components/PayButton.tsx");
    expect(outcome.text).not.toContain("src/lib/format.ts:");
  });

  it("takes one file as the place to look, not as a folder that is not there", async () => {
    // Measured: a real investigation spent a step on
    // `where: "bot.py"` and was told to check the folder path. It wanted to
    // search one file, which is a reasonable thing to want.
    const outcome = await run("search_source", {
      why: "",
      words: "formatPrice",
      where: "src/components/PayButton.tsx",
    });
    expect(outcome.text).toContain("src/components/PayButton.tsx:1|");
    expect(outcome.text).toContain('"src/components/PayButton.tsx" 파일 1개');
    expect(outcome.ledger.every((e) => e.path === "src/components/PayButton.tsx")).toBe(true);
  });

  it("refuses a one-character search rather than spending sixty fetches on it", async () => {
    const outcome = await run("search_source", { why: "", words: "e" });
    expect(outcome.text).toContain("두 글자 이상");
    expect(outcome.ledger).toEqual([]);
  });

  it("says it cannot look inside when this project's files cannot be opened", async () => {
    const outcome = await run(
      "search_source",
      { why: "", words: "en-US" },
      context(GRAPH, null),
    );
    expect(outcome.text).toContain("find_items");
    expect(outcome.ledger).toEqual([]);
  });

  it("does not evict the window the loop is working with", async () => {
    const graph = manyFiles(40);
    const source: Record<string, string> = { ...SOURCE };
    for (const item of graph.items) source[item.path ?? ""] = "nothing here\n";
    const read = vi.fn(fixtureReader(source));
    const ctx = createToolContext(
      { items: [...GRAPH.items, ...graph.items], connections: [...GRAPH.connections] },
      read,
    );
    await runTool(ctx, "read_source", { why: "", path: "src/lib/format.ts" });
    await runTool(ctx, "search_source", { why: "", words: "짜장면" });
    const before = read.mock.calls.length;
    await runTool(ctx, "read_source", { why: "", path: "src/lib/format.ts" });
    // A forty-file sweep through an eight-file cache must not throw away the
    // file the investigation has been reading.
    expect(read.mock.calls.length).toBe(before);
  });
});

describe("list_tree", () => {
  it("counts everything beneath a folder, not just what sits in it", async () => {
    const graph: QaGraph = {
      items: [
        file("src/one.ts", 1),
        file("src/deep/two.ts", 2),
        file("src/deep/down/three.ts", 3),
        file("README.md", 4),
      ],
      connections: [],
    };
    const outcome = await run("list_tree", { why: "" }, context(graph, null));
    // `src/` says 3 rather than 1. A folder that reports only its own loose
    // files is the number that sends a loop into the wrong folder.
    expect(outcome.text).toContain("src/ — 파일 3개");
    expect(outcome.text).toContain("deep/ — 파일 2개");
    expect(outcome.text).toContain("down/ — 파일 1개");
    expect(outcome.text).toContain("바로 아래 파일 1개");
  });

  it("reveals no places, because a folder name is not one", async () => {
    const outcome = await run("list_tree", { why: "" });
    // Exactly the line `list_files` draws, and for the same reason: seeing a
    // name is not reading anything, so nothing here becomes citable.
    expect(outcome.ledger).toEqual([]);
    expect(outcome.items).toEqual([]);
  });

  it("says so when there are more folders than it showed", async () => {
    const items: GraphItem[] = [];
    for (let n = 0; n < 60; n += 1) items.push(file(`src/f${n}/x.ts`, n));
    const outcome = await run(
      "list_tree",
      { why: "" },
      context({ items, connections: [] }, null),
    );
    expect(outcome.text).toContain("줄였어요");
  });
});

describe("read_file", () => {
  it("returns a short file whole, and registers all of it as read", async () => {
    const outcome = await run("read_file", { why: "", path: "src/lib/format.ts" });
    const total = SOURCE["src/lib/format.ts"].trimEnd().split("\n").length;
    expect(outcome.text).toContain(`src/lib/format.ts 1-${total}줄`);
    expect(outcome.ledger).toEqual([
      { path: "src/lib/format.ts", startLine: 1, endLine: total, read: true },
    ]);

    // Which is the whole point: one step, and a claim anywhere in the file is
    // backed without a second round trip.
    const checked = checkFindings(
      [
        {
          claim: "이 파일 안에서 숫자를 글자로 바꿔요.",
          certainty: "certain",
          citations: [{ path: "src/lib/format.ts", startLine: 3, endLine: 8 }],
        },
      ],
      outcome.ledger,
    );
    expect(checked.kept).toHaveLength(1);
  });

  it("reads the front of a long file and says where to continue", async () => {
    const long = Array.from({ length: 400 }, (_, n) => `line ${n + 1}`).join("\n");
    const outcome = await run(
      "read_file",
      { why: "", path: "src/lib/format.ts" },
      context(GRAPH, fixtureReader({ "src/lib/format.ts": long })),
    );
    expect(outcome.text).toContain("(전체 400줄)");
    expect(outcome.text).toContain("줄부터는 다시 요청하면");
    // Bounded: a whole-file tool that returned four hundred lines is a tool
    // that will one day return forty thousand.
    expect(outcome.ledger[0].endLine).toBeLessThanOrEqual(160);
  });

  it("refuses a path the map does not hold", async () => {
    const outcome = await run("read_file", { why: "", path: "../../etc/passwd" });
    expect(outcome.text).toContain("지도에 없는 파일");
    expect(outcome.ledger).toEqual([]);
  });
});

describe("a repository that has stopped answering", () => {
  it("says so once, instead of letting the loop find out one file at a time", async () => {
    const blocked: SourceReader = async () => ({
      ok: false,
      reason: "rate_limited",
    });
    const ctx = context(GRAPH, blocked);

    const first = await runTool(ctx, "read_source", {
      why: "",
      path: "src/lib/format.ts",
    });
    expect(first.text).toContain("깃허브가 지금은");
    // One refusal is about one file. Nothing is claimed about the others yet.
    expect(first.text).not.toContain("계속 안 되고");

    await runTool(ctx, "read_source", { why: "", path: "src/components/PayButton.tsx" });
    const third = await runTool(ctx, "read_file", {
      why: "",
      path: "src/app/checkout/page.tsx",
    });
    // Three in a row is the repository, not the file. Measured: an
    // investigation spent seven of twenty steps discovering this by hand.
    expect(third.text).toContain("계속 안 되고");
    expect(third.text).toContain("inferred");
  });

  it("forgets the run as soon as a file opens", async () => {
    let attempts = 0;
    const flaky: SourceReader = async (path) => {
      attempts += 1;
      return attempts <= 2
        ? { ok: false, reason: "unavailable" }
        : { ok: true, text: SOURCE[path] ?? "x\n" };
    };
    const ctx = context(GRAPH, flaky);
    await runTool(ctx, "read_source", { why: "", path: "src/lib/format.ts" });
    await runTool(ctx, "read_source", { why: "", path: "src/components/PayButton.tsx" });
    await runTool(ctx, "read_source", { why: "", path: "src/app/checkout/page.tsx" });
    const after = await runTool(ctx, "read_file", { why: "", path: "src/lib/format.ts" });
    // A blip is not an outage, and a loop told to give up on a repository that
    // is working would answer `inferred` for no reason.
    expect(after.text).not.toContain("계속 안 되고");
  });
});

describe("follow_import", () => {
  it("crosses the import and reads what it landed on, in one step", async () => {
    const outcome = await run("follow_import", {
      why: "",
      path: "src/components/PayButton.tsx",
      name: "@/lib/format",
    });
    expect(outcome.text).toContain("src/lib/format.ts");
    expect(outcome.text).toContain("formatPrice");
    // The file stood on comes first. Without it `trail.ts` has only one end of
    // the hop on the walk, drops the edge, and redraws a real traversal as two
    // places that happen to be connected.
    expect(outcome.items[0]).toBe("f-pay");
    expect(outcome.items).toContain("f-format");
    // The graph's own connection, by its own id, so the map draws an edge it
    // already has rather than one we invented.
    expect(outcome.hops).toEqual([
      {
        connectionId: "c7",
        from: "f-pay",
        to: "f-format",
        relation: "imports",
        certainty: "certain",
      },
    ]);
  });

  it("registers the lines it opened, so the landing is citable", async () => {
    const outcome = await run("follow_import", {
      why: "",
      path: "src/components/PayButton.tsx",
      name: "format",
    });
    const read = outcome.ledger.filter((entry) => entry.read);
    expect(read).toHaveLength(1);
    expect(read[0].path).toBe("src/lib/format.ts");
    expect(read[0].startLine).toBe(1);

    const checked = checkFindings(
      [
        {
          claim: "여기서 숫자를 글자로 바꿔요.",
          certainty: "certain",
          citations: [{ path: "src/lib/format.ts", startLine: 7, endLine: 7 }],
        },
      ],
      outcome.ledger,
    );
    expect(checked.kept).toHaveLength(1);
  });

  it("reads a Python module path the way a person writes it", async () => {
    const graph: QaGraph = {
      items: [file("bot.py", 1), file("strategies/base.py", 2)],
      connections: [
        { id: "cx", from: "f1", to: "f2", relation: "imports", certainty: "certain" },
      ],
    };
    const outcome = await run(
      "follow_import",
      { why: "", path: "bot.py", name: "strategies.base" },
      context(graph, fixtureReader({ "strategies/base.py": "class Strategy:\n" })),
    );
    // `strategies.base` is a module path and `base.py` is a file with an
    // extension. Treating the dot the same way in both turns every Python
    // import into a lookup for a file called `strategies`.
    expect(outcome.text).toContain("strategies/base.py");
    expect(outcome.hops[0].connectionId).toBe("cx");
  });

  it("names what a file does import when the name does not match", async () => {
    const outcome = await run("follow_import", {
      why: "",
      path: "src/components/PayButton.tsx",
      name: "nowhere",
    });
    expect(outcome.text).toContain("못 찾았어요");
    expect(outcome.text).toContain("src/lib/format.ts");
    // Nothing was read, so nothing may be cited as read.
    expect(outcome.ledger.every((entry) => !entry.read)).toBe(true);
  });

  it("says a package came from outside instead of hunting for a file", async () => {
    const pkg: GraphItem = {
      ...file("alpaca", 9),
      id: "p1",
      kind: "package",
      name: "alpaca",
      path: null,
    };
    const graph: QaGraph = {
      items: [file("broker.py", 1), pkg],
      connections: [
        { id: "cp", from: "f1", to: "p1", relation: "uses_package", certainty: "certain" },
      ],
    };
    const outcome = await run(
      "follow_import",
      { why: "", path: "broker.py", name: "alpaca.trading.client" },
      context(graph, fixtureReader({})),
    );
    expect(outcome.text).toContain("밖에서 가져온 도구");
    expect(outcome.ledger.every((entry) => !entry.read)).toBe(true);
    expect(outcome.hops[0].connectionId).toBe("cp");
  });

  it("works without a reader, and says it could not open what it found", async () => {
    const outcome = await run(
      "follow_import",
      { why: "", path: "src/components/PayButton.tsx", name: "format" },
      context(GRAPH, null),
    );
    // A resolution is a question about the graph, and the graph is there
    // whether or not the bytes are.
    expect(outcome.hops[0].connectionId).toBe("c7");
    expect(outcome.text).toContain("inferred");
    expect(outcome.ledger.every((entry) => !entry.read)).toBe(true);
  });
});
