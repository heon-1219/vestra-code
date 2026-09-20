import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AnalysisProgress } from "./analysis-screen";
import { buildPhaseRows, type PhaseRow } from "./phase-checklist";

/**
 * Tests for the analysis screen's logic and its copy.
 *
 * No DOM library is installed (see the note in this step's report), so nothing
 * here renders. That is less of a loss than it sounds: what can actually be
 * wrong on this screen is which line claims a step happened, and what words it
 * uses to claim it — both of which live in `buildPhaseRows` and in the source
 * text. The states that matter most are also the ones a browser test could
 * barely reach, since they need a repository to fail halfway through a
 * download.
 *
 * The file is `.test.ts` rather than `.test.tsx` because `vitest.config.mts`
 * collects `src/**\/*.test.ts` only, and a test that is never collected is
 * worse than no test at all.
 */

const EMPTY: AnalysisProgress = {
  phase: null,
  stream: "opening",
  filesRead: 0,
  filesTotal: null,
  filesOffered: null,
  itemsFound: 0,
  connectionsFound: 0,
  certainCount: 0,
  inferredCount: 0,
  featuresNamed: 0,
  recentFiles: [],
  skipped: [],
  failure: null,
  coverage: null,
  completion: null,
};

const at = (rows: PhaseRow[], id: PhaseRow["id"]): PhaseRow => {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};

describe("the silent stretch", () => {
  it("shows no number at all before ingest finishes", () => {
    // The download emits no progress events — the ingest messages go to the
    // server log only. Any number here would be invented.
    const rows = buildPhaseRows({ ...EMPTY, phase: "ingest" }, "github");

    expect(rows.every((row) => row.detail === null || row.id === "features")).toBe(
      true,
    );
    expect(rows.every((row) => row.progress === null)).toBe(true);
    expect(at(rows, "ingest").state).toBe("active");
    expect(at(rows, "read").state).toBe("waiting");
  });

  it("closes the ingest row only when run.started proves the files are here", () => {
    const rows = buildPhaseRows(
      { ...EMPTY, phase: "static", filesOffered: 22 },
      "github",
    );

    expect(at(rows, "ingest").state).toBe("done");
    expect(at(rows, "ingest").detail).toBe("파일 22개 받았어요");
  });

  it("says folder rather than repository for an uploaded project", () => {
    const rows = buildPhaseRows({ ...EMPTY, phase: "ingest" }, "upload");
    expect(at(rows, "ingest").title).toContain("폴더");
    expect(at(rows, "ingest").title).not.toContain("코드를 가져");
  });
});

describe("mid-run", () => {
  const midRun: AnalysisProgress = {
    ...EMPTY,
    phase: "static",
    stream: "live",
    filesOffered: 22,
    filesRead: 9,
    filesTotal: 20,
    itemsFound: 31,
    connectionsFound: 48,
    certainCount: 48,
    recentFiles: ["src/app/checkout/page.tsx"],
  };

  it("counts against the denominator the stream gave, never an invented one", () => {
    const rows = buildPhaseRows(midRun, "github");
    expect(at(rows, "read").progress).toEqual({ done: 9, total: 20 });
    expect(at(rows, "read").detail).toBe("9 / 20");
  });

  it("runs the reading, structure and connection rows at once, because they do", () => {
    const rows = buildPhaseRows(midRun, "github");
    expect(at(rows, "read").state).toBe("active");
    expect(at(rows, "structure").state).toBe("active");
    expect(at(rows, "connections").state).toBe("active");
  });

  it("never lets the bar overshoot when more files parse than ingest counted", () => {
    const rows = buildPhaseRows({ ...midRun, filesRead: 24 }, "github");
    expect(at(rows, "read").progress).toEqual({ done: 20, total: 20 });
  });
});

describe("the two repositories this has to look right on", () => {
  it("the demo repo: 68 items, 121 connections, all certain", () => {
    const rows = buildPhaseRows(
      {
        ...EMPTY,
        phase: "done",
        stream: "closed",
        filesOffered: 22,
        filesRead: 18,
        filesTotal: 20,
        itemsFound: 68,
        connectionsFound: 121,
        certainCount: 121,
        completion: {
          itemCount: 68,
          connectionCount: 121,
          filesParsed: 18,
          filesSkipped: 0,
          limits: [],
        },
      },
      "github",
    );

    expect(at(rows, "read").detail).toBe("18개 읽었어요");
    expect(at(rows, "structure").detail).toBe("68개 찾았어요");
    expect(at(rows, "connections").detail).toBe("121개 정리했어요");
    for (const id of ["ingest", "read", "structure", "connections"] as const) {
      expect(at(rows, id).state).toBe("done");
    }
    // The bar is gone once the real figure is in: the denominator was an upper
    // bound and the finished row says what actually happened.
    expect(at(rows, "read").progress).toBeNull();
  });

  it("a static site: 58 items, 57 connections, and not one symbol", () => {
    const rows = buildPhaseRows(
      {
        ...EMPTY,
        phase: "done",
        filesOffered: 60,
        filesRead: 58,
        itemsFound: 58,
        connectionsFound: 57,
        certainCount: 57,
        completion: {
          itemCount: 58,
          connectionCount: 57,
          filesParsed: 58,
          filesSkipped: 2,
          limits: [],
        },
      },
      "upload",
    );

    // No row goes blank on the repository that produces no symbols: every line
    // still has something true to say.
    for (const id of ["ingest", "read", "structure", "connections"] as const) {
      expect(at(rows, id).detail).not.toBeNull();
      expect(at(rows, id).state).toBe("done");
    }
    expect(at(rows, "read").detail).toContain("2개는");
  });

  it("says there are no known connections rather than that anything is fine", () => {
    const rows = buildPhaseRows(
      {
        ...EMPTY,
        phase: "done",
        filesOffered: 3,
        filesRead: 3,
        itemsFound: 3,
        completion: {
          itemCount: 3,
          connectionCount: 0,
          filesParsed: 3,
          filesSkipped: 0,
          limits: [],
        },
      },
      "github",
    );

    expect(at(rows, "connections").detail).toBe("아는 연결이 없어요");
  });
});

describe("naming features, which Pass 2 does not do yet", () => {
  it("never checks the row off for work nobody did", () => {
    const rows = buildPhaseRows(
      {
        ...EMPTY,
        phase: "done",
        filesOffered: 22,
        itemsFound: 68,
        connectionsFound: 121,
        completion: {
          itemCount: 68,
          connectionCount: 121,
          filesParsed: 18,
          filesSkipped: 0,
          limits: [],
        },
      },
      "github",
    );

    expect(at(rows, "features").state).toBe("unavailable");
    expect(at(rows, "features").detail).toBe("아직 준비 중인 단계예요");
  });

  it("fills in once feature.created actually arrives", () => {
    const rows = buildPhaseRows(
      { ...EMPTY, phase: "semantic", filesOffered: 22, featuresNamed: 7 },
      "github",
    );
    expect(at(rows, "features").state).toBe("active");
    expect(at(rows, "features").detail).toBe("기능 7개에 이름을 붙였어요");
  });
});

describe("a run that stopped", () => {
  const stopped = buildPhaseRows(
    {
      ...EMPTY,
      phase: "static",
      stream: "closed",
      filesOffered: 22,
      filesRead: 6,
      filesTotal: 20,
      itemsFound: 12,
      failure: "저장소가 너무 커서 읽지 못했어요.",
    },
    "github",
  );

  it("keeps what was finished and marks only what was under way", () => {
    expect(at(stopped, "ingest").state).toBe("done");
    expect(at(stopped, "read").state).toBe("stopped");
    expect(at(stopped, "structure").state).toBe("stopped");
  });

  it("does not stop a step that had not started", () => {
    expect(at(stopped, "connections").state).toBe("waiting");
  });

  it("claims nothing finished", () => {
    expect(stopped.some((row) => row.title.includes("다 읽었어요"))).toBe(false);
  });
});

describe("the words on screen", () => {
  const sources = ["./analysis-screen.tsx", "./phase-checklist.tsx"].map((file) => ({
    file,
    text: readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"),
  }));

  /**
   * Every phrase a person could read, approximately: the source with its
   * Latin-only string literals removed, so a Tailwind class named `border-edge`
   * cannot be mistaken for the word this product is forbidden to use.
   */
  function readableLines(text: string): string[] {
    const stripped = text.replace(
      /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
      (match) => (/[가-힣]/.test(match) ? match : " "),
    );
    return stripped.split("\n").filter((line) => /[가-힣]/.test(line));
  }

  it("never uses the vocabulary the brief bans", () => {
    const banned = [/노드/, /엣지/, /node/i, /edge/i, /entity/i, /triple/i, /ontology/i];
    for (const { file, text } of sources) {
      for (const line of readableLines(text)) {
        for (const pattern of banned) {
          expect(`${file}: ${line}`).not.toMatch(pattern);
        }
      }
    }
  });

  it("never tells anyone something is safe", () => {
    for (const { file, text } of sources) {
      for (const line of readableLines(text)) {
        expect(`${file}: ${line}`).not.toMatch(/안전/);
      }
    }
  });

  it("speaks 해요체, not 합니다체", () => {
    for (const { file, text } of sources) {
      for (const line of readableLines(text)) {
        expect(`${file}: ${line}`).not.toMatch(/합니다|습니다/);
      }
    }
  });
});
