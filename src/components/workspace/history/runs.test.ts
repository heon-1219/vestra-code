import { describe, expect, it } from "vitest";

import {
  buildRunEntries,
  changedSentence,
  runFacts,
  runHeadline,
  runTone,
  shortSha,
  type RunRecord,
} from "./runs";

/**
 * What changed between one reading of a project and the next.
 *
 * This is the half of the band that can be wrong without looking wrong. A
 * difference taken against the wrong run still renders as a tidy Korean
 * sentence — 항목 143개가 줄었어요 — next to a map that is sitting there
 * complete, and there is nothing on the screen to check it against. So the
 * cases that matter here are the ones where a run is *not* a valid thing to
 * subtract from: a failed one, an in-flight one, and the one at the far end of
 * a window with more history behind it.
 */

let serial = 0;

/** A run, with only the fields a case is about spelled out. */
function run(over: Partial<RunRecord> = {}): RunRecord {
  serial += 1;
  return {
    id: `run-${serial}`,
    status: "completed",
    // Minutes apart and ascending with `serial`, so a fixture written in the
    // order a person thinks in comes out in the order the route would send it.
    startedAt: new Date(Date.UTC(2026, 8, 20, 0, serial)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 8, 20, 0, serial, 30)).toISOString(),
    commitSha: null,
    itemCount: 0,
    connectionCount: 0,
    filesParsed: 0,
    skippedCount: 0,
    error: null,
    ...over,
  };
}

/** Newest first, the way the route sends them. */
const newestFirst = (...runs: RunRecord[]) => [...runs].reverse();

describe("buildRunEntries", () => {
  it("calls a project's only run its first", () => {
    const [entry] = buildRunEntries([run({ itemCount: 68, connectionCount: 121 })]);
    expect(entry.change).toEqual({ kind: "first" });
    expect(runHeadline(entry)).toBe("처음 그린 지도예요");
  });

  it("differences each run against the one before it", () => {
    const first = run({ itemCount: 68, connectionCount: 121 });
    const second = run({ itemCount: 80, connectionCount: 118 });

    const entries = buildRunEntries(newestFirst(first, second));

    expect(entries[0].run.id).toBe(second.id);
    expect(entries[0].change).toEqual({ kind: "changed", items: 12, connections: -3 });
    expect(entries[1].change).toEqual({ kind: "first" });
  });

  it("orders by when a run started, whatever order it was handed", () => {
    // The subtraction is directional: the same two runs in the wrong order do
    // not look broken, they look like a project that has been shrinking.
    const first = run({ itemCount: 10, connectionCount: 10 });
    const second = run({ itemCount: 30, connectionCount: 10 });

    const entries = buildRunEntries([first, second]);

    expect(entries[0].run.id).toBe(second.id);
    expect(entries[0].change).toEqual({ kind: "changed", items: 20, connections: 0 });
  });

  it("never subtracts against a failed run", () => {
    /*
     * `pipeline.ts` writes node_count and edge_count on the success path only,
     * so a failed run carries the column defaults. Differencing against one
     * would announce that the project lost everything, on the screen of a
     * person whose map D20 left completely intact.
     */
    const first = run({ itemCount: 68, connectionCount: 121 });
    const broke = run({ status: "failed", error: "코드를 받아오지 못했어요." });
    const third = run({ itemCount: 70, connectionCount: 121 });

    const entries = buildRunEntries(newestFirst(first, broke, third));

    expect(entries[0].change).toEqual({ kind: "changed", items: 2, connections: 0 });
    expect(entries[1].change).toEqual({ kind: "none" });
    expect(entries[2].change).toEqual({ kind: "first" });
  });

  it("never subtracts against a run that is still going", () => {
    const first = run({ itemCount: 68, connectionCount: 121 });
    const going = run({ status: "running", finishedAt: null });

    const entries = buildRunEntries(newestFirst(first, going));

    expect(entries[0].change).toEqual({ kind: "none" });
    expect(runHeadline(entries[0])).toBe("지금 읽고 있어요");
    // And a run with no end yet is dated by its start, not by nothing.
    expect(entries[0].at).toBe(going.startedAt);
  });

  it("refuses to call the oldest run in a truncated window the first one", () => {
    const older = run({ itemCount: 68, connectionCount: 121 });
    const newer = run({ itemCount: 70, connectionCount: 121 });

    const entries = buildRunEntries(newestFirst(older, newer), true);

    expect(entries[1].change).toEqual({ kind: "unknown" });
    expect(runHeadline(entries[1])).toBe("이때 다시 읽었어요");
    // The one that does have a predecessor in the window is unaffected.
    expect(entries[0].change).toEqual({ kind: "changed", items: 2, connections: 0 });
  });

  it("says nothing at all about a project with no runs", () => {
    expect(buildRunEntries([])).toEqual([]);
  });
});

describe("changedSentence", () => {
  it("joins two increases into one clause", () => {
    expect(changedSentence(12, 9)).toBe("항목 12개, 연결 9개가 늘었어요");
  });

  it("joins two decreases into one clause", () => {
    expect(changedSentence(-4, -2)).toBe("항목 4개, 연결 2개가 줄었어요");
  });

  it("keeps an increase and a decrease in separate clauses", () => {
    expect(changedSentence(12, -3)).toBe("항목 12개가 늘고, 연결 3개가 줄었어요");
  });

  it("leaves out the number that did not move", () => {
    expect(changedSentence(12, 0)).toBe("항목 12개가 늘었어요");
    expect(changedSentence(0, -3)).toBe("연결 3개가 줄었어요");
  });

  it("says so plainly when a re-read changed nothing", () => {
    // A common outcome rather than an edge case — D53 caches Pass 2 on exactly
    // this — and silence here would read as a run that failed to report.
    expect(changedSentence(0, 0)).toBe("지난번과 똑같아요");
  });

  it("groups thousands, because a real project reaches them", () => {
    expect(changedSentence(1234, 0)).toBe("항목 1,234개가 늘었어요");
  });
});

describe("runHeadline", () => {
  it("repeats the stored reason for a failed run, unchanged", () => {
    // The column already holds a sentence written for this person; anything
    // technical went to the logs and must not be reconstructed here.
    const [entry] = buildRunEntries([
      run({ status: "failed", error: "코드를 받아오지 못했어요. 주소를 확인해 주세요." }),
    ]);
    expect(runHeadline(entry)).toBe("코드를 받아오지 못했어요. 주소를 확인해 주세요.");
  });

  it("still says something when a failed run stored no reason", () => {
    const [entry] = buildRunEntries([run({ status: "failed", error: null })]);
    expect(runHeadline(entry)).toBe("지도를 그리다가 멈췄어요");
  });
});

describe("runFacts", () => {
  it("reports what a completed run measured", () => {
    expect(
      runFacts(run({ itemCount: 143, connectionCount: 210, filesParsed: 68 })),
    ).toEqual(["항목 143개", "연결 210개", "파일 68개를 읽었어요"]);
  });

  it("adds the files it could not read, as a count", () => {
    const facts = runFacts(run({ itemCount: 1, connectionCount: 1, skippedCount: 3 }));
    expect(facts).toContain("읽지 못한 파일 3개가 있어요");
  });

  it("reports nothing for a run that never wrote a count", () => {
    // 항목 0개 beside a run that stopped halfway is a measurement nobody took.
    expect(runFacts(run({ status: "failed" }))).toEqual([]);
    expect(runFacts(run({ status: "running", finishedAt: null }))).toEqual([]);
  });
});

describe("shortSha", () => {
  it("keeps seven characters", () => {
    expect(shortSha("4f2a9c1de83b77aa091c2e5d6f0a1b2c3d4e5f60")).toBe("4f2a9c1");
  });

  it("is null for a project that has no commit", () => {
    // An uploaded folder was never resolved against a repository.
    expect(shortSha(null)).toBeNull();
    expect(shortSha("   ")).toBeNull();
  });
});

describe("runTone", () => {
  it("separates the three things a run can be", () => {
    expect(runTone(run({ status: "completed" }))).toBe("drawn");
    expect(runTone(run({ status: "failed" }))).toBe("stopped");
    expect(runTone(run({ status: "running" }))).toBe("reading");
    expect(runTone(run({ status: "pending" }))).toBe("reading");
  });
});
