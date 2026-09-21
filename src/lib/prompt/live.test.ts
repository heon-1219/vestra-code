import { describe, expect, it } from "vitest";

/**
 * 프롬프트 만들기 and 설명하기's free half, measured on a real project.
 *
 *   VESTRA_PROMPT_LIVE=<projectId> npx vitest run src/lib/prompt/live.test.ts --reporter=verbose
 *
 * Add `VESTRA_PROMPT_LIVE_MODEL=1` to also restate three goals with the real
 * model, which is the only part of either feature that spends tokens.
 *
 * Opt-in and a tool rather than a test, the shape `flow-live.test.ts` and
 * `reanalyze.test.ts` already have: it reads the production database, so
 * nothing here may run by default, and it asserts almost nothing, because a
 * measurement that fails the build when a project changes is one nobody runs.
 *
 * What it answers, each with a number:
 *
 *   1. **Is the prompt built instantly?** `buildPrompt` over every selection a
 *      person could make, timed. The claim in D153 is that building needs no
 *      server and no wait; this is where that claim is paid for.
 *   2. **How often is the "only here or everywhere?" question asked?** §6.4
 *      puts it before generation, so its rate is how often generation has an
 *      extra click.
 *   3. **Does a prompt ever contradict itself?** Locked lines inside the
 *      allowed selection, a feature's id in the text, an "already uses" entry
 *      that rests on a guess — each was found here and each should read 0.
 *   4. **Can 설명하기 answer for free?** How many items have a sentence from
 *      Pass 2 and how many connections a purpose from Pass 3 — the share of
 *      selections the zero-model half actually explains — and how long
 *      `explainKnown` takes, because D155 says it renders in the click's frame.
 */

const projectId = process.env.VESTRA_PROMPT_LIVE ?? "";
const live = projectId.length > 0;

if (live) {
  try {
    // Vitest does not read `.env.local`; Next does.
    process.loadEnvFile(".env.local");
  } catch {
    // `env.ts` will say what is missing, which is the useful failure.
  }
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`;
}

describe.skipIf(!live)("prompt and explanation, on a real project", () => {
  it("builds every possible prompt and explanation, and says how long it took", async () => {
    const { db } = await import("@/db");
    const { loadGraphView } = await import("@/lib/graph/load");
    const { buildPrompt, requestWords, REUSE_FLOOD, reuseCandidates, scopeQuestion } = await import(
      "./build"
    );
    const { buildBeamIndex, runBeam } = await import("@/components/workspace/map/beam");
    const { withoutParticle } = await import("@/components/workspace/flow/start");
    const { explainKnown } = await import("@/components/workspace/explain/known");

    const loadStarted = performance.now();
    const view = await loadGraphView(db, projectId);
    const loadMs = performance.now() - loadStarted;
    const graph = { items: view.items, connections: view.connections };
    expect(graph.items.length, "the project has no map").toBeGreaterThan(0);

    const selectable = graph.items.filter(
      (item) => item.kind !== "package" && item.kind !== "feature",
    );
    console.log(
      `\n${graph.items.length} items, ${graph.connections.length} connections ` +
        `(loaded in ${loadMs.toFixed(0)} ms); ${selectable.length} a person could select`,
    );

    // 1. Build time and size, over every selectable item.
    const buildMs: number[] = [];
    const lengths: number[] = [];
    let shared = 0;
    let withReuse = 0;
    let withAlready = 0;
    let withMatched = 0;
    const request = "이 부분 글자 색을 파란색으로 바꿔줘";
    let withPurposeInContext = 0;
    let sampleShared: string | null = null;
    for (const item of selectable) {
      const question = scopeQuestion(graph, [item.id]);
      if (question) shared += 1;
      const started = performance.now();
      const built = buildPrompt({
        graph,
        selectionIds: [item.id],
        hops: 1,
        locks: {},
        request,
        goal: null,
        scope: question ? { kind: "only_here", placeId: question.places[0].id } : null,
      });
      buildMs.push(performance.now() - started);
      lengths.push(built.promptText.length);
      if (built.counts.reuse > 0) withReuse += 1;
      const reuse = reuseCandidates(graph, [item.id], request);
      if (reuse.some((entry) => entry.why === "already")) withAlready += 1;
      if (reuse.some((entry) => entry.why === "matched")) withMatched += 1;
      if (built.promptText.includes("무엇을 위한 연결인지(짐작)")) withPurposeInContext += 1;
      if (question && !sampleShared && item.kind === "symbol" && question.places.length <= 4) {
        sampleShared = built.promptText + "\n\n[확인 문장] " + built.confirmationText;
      }
    }
    console.log(
      `buildPrompt: median ${quantile(buildMs, 0.5).toFixed(2)} ms, ` +
        `p95 ${quantile(buildMs, 0.95).toFixed(2)} ms, max ${Math.max(...buildMs).toFixed(2)} ms`,
    );
    console.log(
      `prompt length: median ${quantile(lengths, 0.5)} chars, p95 ${quantile(lengths, 0.95)}, max ${Math.max(...lengths)}`,
    );
    console.log(
      `asked "only here or everywhere?" first: ${shared}/${selectable.length} (${pct(shared, selectable.length)})`,
    );
    console.log(
      `"다시 쓸 것" had something to offer: ${withReuse}/${selectable.length} (${pct(withReuse, selectable.length)}) — ` +
        `already used by the selection ${withAlready} (${pct(withAlready, selectable.length)}), ` +
        `matched by the request's words ${withMatched} (${pct(withMatched, selectable.length)})`,
    );
    console.log(
      `a Pass 3 purpose sentence in 이어진 것: ${withPurposeInContext}/${selectable.length} (${pct(withPurposeInContext, selectable.length)})`,
    );

    // 3. What the free half of 설명하기 has to say.
    const knownMs: number[] = [];
    let labelled = 0;
    let summarised = 0;
    let written = 0;
    let purposes = 0;
    let unused = 0;
    for (const item of selectable) {
      const started = performance.now();
      const known = explainKnown(graph, item.id);
      knownMs.push(performance.now() - started);
      if (!known) continue;
      if (known.written.label) labelled += 1;
      if (known.written.summary) summarised += 1;
      if (known.written.summary || known.written.label) written += 1;
      if (known.written.purposes > 0) purposes += 1;
      if (known.measured.usedBy.total === 0) unused += 1;
    }
    console.log(
      `explainKnown: median ${quantile(knownMs, 0.5).toFixed(2)} ms, ` +
        `p95 ${quantile(knownMs, 0.95).toFixed(2)} ms, max ${Math.max(...knownMs).toFixed(2)} ms`,
    );
    console.log(
      `free explanation carries a model sentence (label or summary): ${written}/${selectable.length} (${pct(written, selectable.length)}); ` +
        `summary ${summarised} (${pct(summarised, selectable.length)}), label ${labelled} (${pct(labelled, selectable.length)}), ` +
        `a purpose on one of its connections ${purposes} (${pct(purposes, selectable.length)}); ` +
        `nothing found using it ${unused} (${pct(unused, selectable.length)})`,
    );

    const connectionsWithPurpose = graph.connections.filter((c) => c.purpose).length;
    console.log(
      `connections with a purpose sentence: ${connectionsWithPurpose}/${graph.connections.length} (${pct(connectionsWithPurpose, graph.connections.length)})`,
    );

    // Which of the request's words point somewhere, and which flood.
    const pool = graph.items.filter(
      (item) =>
        item.kind === "symbol" &&
        ["component", "hook", "function"].includes(item.shape ?? "") &&
        item.usedBy >= 2,
    );
    const index = buildBeamIndex(pool);
    for (const word of requestWords(request)) {
      const stem = withoutParticle(word);
      const landed = new Set([
        ...runBeam(index, word).matched,
        ...(stem ? runBeam(index, stem).matched : []),
      ]);
      const names = [...landed].slice(0, 4).map((id) => graph.items.find((item) => item.id === id)?.name);
      console.log(
        `  word "${word}"${stem ? ` (+"${stem}")` : ""} lands on ${landed.size} pieces` +
          `${landed.size > REUSE_FLOOD ? " — a flood, ignored" : ""}: ${names.join(", ")}`,
      );
    }

    if (sampleShared) console.log(`\n--- one real prompt ---\n${sampleShared}\n--- end ---`);
  }, 5 * 60_000);

  it("counts the four ways a prompt contradicted itself (D162, D164, D165, D171)", async () => {
    // Every one of these was found by measuring, and each should read 0. They
    // are counted with no switch touched, because that is the prompt most
    // people send.
    const { db } = await import("@/db");
    const { loadGraphView } = await import("@/lib/graph/load");
    const { buildPrompt, canPromptAbout, reuseCandidates, scopeQuestion } = await import("./build");
    const view = await loadGraphView(db, projectId);
    const graph = { items: view.items, connections: view.connections };
    const byId = new Map(graph.items.map((item) => [item.id, item]));
    const within = (inner: (typeof graph.items)[number], outer: (typeof graph.items)[number]) =>
      inner.path !== null &&
      inner.path === outer.path &&
      (outer.startLine === null ||
        (inner.startLine !== null &&
          outer.startLine <= inner.startLine &&
          (inner.endLine ?? inner.startLine) <= (outer.endLine ?? outer.startLine)));

    const code = graph.items.filter(canPromptAbout);
    let lockedInsideAllowed = 0;
    let featureIds = 0;
    let alreadyEntries = 0;
    let alreadyGuessed = 0;
    // D171: the cap's sentence, which the lock lists never show.
    let capped = 0;
    let cappedAlongside = 0;
    let capForbidsAll = 0;
    for (const item of code) {
      const question = scopeQuestion(graph, [item.id]);
      const built = buildPrompt({
        graph,
        selectionIds: [item.id],
        hops: 1,
        locks: {},
        request: "이름 글자를 굵게 해줘",
        goal: null,
        scope: question ? { kind: "everywhere" } : null,
      });
      if (built.lockState.locked.some((id) => within(byId.get(id)!, item))) lockedInsideAllowed += 1;
      if (built.promptText.includes("`feature:")) featureIds += 1;
      if (built.counts.hidden > 0) {
        capped += 1;
        if (built.promptText.includes("4번에 적은 곳 안에 적힌 것이라")) cappedAlongside += 1;
        if (built.promptText.includes("목록에 없는 것은 건드리지 마세요")) capForbidsAll += 1;
      }
      for (const entry of reuseCandidates(graph, [item.id], "이름 글자를 굵게 해줘")) {
        if (entry.why !== "already") continue;
        alreadyEntries += 1;
        const links = graph.connections.filter((c) => c.from === item.id && c.to === entry.item.id);
        if (links.every((c) => c.certainty === "inferred")) alreadyGuessed += 1;
      }
    }
    const notCode = graph.items.length - code.length;
    console.log(
      `\nlocked lines inside the allowed selection: ${lockedInsideAllowed}/${code.length}; ` +
        `prompts naming a feature by its id: ${featureIds}; ` +
        `"already uses" entries resting only on a guess: ${alreadyGuessed}/${alreadyEntries}; ` +
        `features and packages a prompt refuses: ${notCode}; ` +
        `capped lists ${capped}, of which say what they left out of an allowed place may change with it ${cappedAlongside}, ` +
        `and forbid everything unlisted ${capForbidsAll}`,
    );
  }, 5 * 60_000);

  it("says which helpers seven ordinary requests would be pointed at", async () => {
    // D153's instrument for 다시 쓸 것's matched leads. Seven requests a person
    // might type, against the busiest labelled component; each lead is printed
    // with how many of the request's words landed on it, so a change to the
    // rule can be judged against the same seven.
    const { db } = await import("@/db");
    const { loadGraphView } = await import("@/lib/graph/load");
    const { reuseCandidates, requestWords } = await import("./build");
    const view = await loadGraphView(db, projectId);
    const graph = { items: view.items, connections: view.connections };
    const selection = graph.items
      .filter((item) => item.kind === "symbol" && item.shape === "component" && item.label)
      .sort((a, b) => b.usedBy - a.usedBy)[0];
    const requests = [
      "이 부분 글자 색을 파란색으로 바꿔줘",
      "프로필 사진을 동그랗게 바꿔줘",
      "파일 목록에서 경로를 짧게 보여줘",
      "변경 기록 띠 높이를 줄여줘",
      "확실해요 표시를 더 크게 해줘",
      "모델 고르는 버튼을 하나 더 추가해줘",
      "지도 이름표가 겹치지 않게 해줘",
    ];
    let leads = 0;
    console.log(`
pointing at ${selection.name} (${selection.label})`);
    for (const request of requests) {
      const matched = reuseCandidates(graph, [selection.id], request).filter(
        (entry) => entry.why === "matched",
      );
      leads += matched.length;
      console.log(`  "${request}" words=${JSON.stringify(requestWords(request))}`);
      for (const entry of matched) {
        console.log(
          `     ${entry.words.length} word(s) ${JSON.stringify(entry.words)} → ${entry.item.name} (${entry.item.label}), used in ${entry.item.usedBy}`,
        );
      }
    }
    console.log(`  ${leads} leads across ${requests.length} requests`);
  }, 2 * 60_000);

  it.skipIf(process.env.VESTRA_PROMPT_LIVE_MODEL !== "1")(
    "restates three goals with the real model",
    async () => {
      const { db } = await import("@/db");
      const { loadGraphView } = await import("@/lib/graph/load");
      const { llmFromEnv } = await import("@/lib/llm");
      const { restateGoal } = await import("./goal");

      const llm = llmFromEnv();
      expect(llm, "no model configured").not.toBeNull();
      const view = await loadGraphView(db, projectId);
      const pick = view.items
        .filter((item) => item.kind === "symbol" && item.label)
        .sort((a, b) => b.usedBy - a.usedBy)[0];
      expect(pick, "no labelled piece to point at").toBeDefined();

      const requests = [
        "이거 글자 좀 크게 해줘",
        "여기 버튼 누르면 확인 창이 한 번 더 뜨게 해줘",
        "색을 파란색으로 바꿔줘",
      ];
      const places = [{ name: pick.name, label: pick.label, path: pick.path }];
      console.log(`\npointing at ${pick.name} (${pick.label}) · ${pick.path}`);
      for (const request of requests) {
        const started = performance.now();
        const outcome = await restateGoal({ llm, request, places });
        const ms = performance.now() - started;
        console.log(
          `  ${ms.toFixed(0)} ms · "${request}" → ${outcome.ok ? outcome.goal : `(${outcome.reason})`}`,
        );
      }
    },
    2 * 60_000,
  );
});
