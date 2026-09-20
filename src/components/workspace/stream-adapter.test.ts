import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AnalysisStreamState } from "@/hooks/use-analysis-stream";
import type { GraphItem, GraphView } from "@/lib/graph/view";

import { toAnalysisProgress, toRunProgress } from "./stream-adapter";
import { Workspace } from "./workspace";

/**
 * The seam between four pieces written at the same time by four people.
 *
 * Each of them named the same number differently, so the failures this guards
 * against are not crashes — they are a screen that reports a confident wrong
 * figure. A file list read backwards makes "지금 읽는 파일" the oldest file
 * instead of the newest; a skipped count taken from the list rather than from
 * the run undercounts after a refresh; `0` read as a denominator gives someone
 * "0 / 0" while their project is being read.
 */

function stream(overrides: Partial<AnalysisStreamState> = {}): AnalysisStreamState {
  return {
    phase: null,
    sawSemantic: false,
    filesParsed: 0,
    filesOffered: 0,
    progress: 0,
    files: [],
    skipped: [],
    skippedTotal: 0,
    itemCount: 0,
    connectionCount: 0,
    certainCount: 0,
    inferredCount: 0,
    featureCount: 0,
    coverage: null,
    finished: false,
    failure: null,
    limits: [],
    link: "idle",
    ...overrides,
  };
}

describe("toAnalysisProgress", () => {
  it("says nothing about a total it has not been told", () => {
    const progress = toAnalysisProgress(stream({ link: "connecting" }));

    // Not 0 — a denominator of zero would draw "0 / 0" over someone's project
    // while the download is still going.
    expect(progress.filesTotal).toBeNull();
    expect(progress.filesOffered).toBeNull();
    expect(progress.stream).toBe("opening");
    expect(progress.completion).toBeNull();
  });

  it("tells a first connection apart from a reconnect", () => {
    const first = toAnalysisProgress(stream({ link: "connecting", phase: null }));
    const again = toAnalysisProgress(stream({ link: "connecting", phase: "static" }));

    expect(first.stream).toBe("opening");
    // The stream was open once — it said which phase it was in — so this is a
    // reconnect, and the screen is allowed to say so.
    expect(again.stream).toBe("retrying");
  });

  it("hands the newest file over first", () => {
    // The hook appends, so its last entry is the file being read right now.
    const progress = toAnalysisProgress(
      stream({ files: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
    );

    expect(progress.recentFiles[0]).toBe("src/c.ts");
  });

  it("carries the demo repo's measured run through to the finish", () => {
    const progress = toAnalysisProgress(
      stream({
        phase: "done",
        link: "closed",
        filesParsed: 18,
        filesOffered: 22,
        itemCount: 68,
        connectionCount: 121,
        certainCount: 121,
        inferredCount: 0,
        skippedTotal: 2,
        finished: true,
        limits: [],
      }),
    );

    expect(progress.completion).toEqual({
      itemCount: 68,
      connectionCount: 121,
      filesParsed: 18,
      filesSkipped: 2,
      limits: [],
    });
    expect(progress.stream).toBe("closed");
  });

  it("counts skipped files from the run, not from the list it happened to see", () => {
    // After a mid-run refresh the browser replays from its cursor, so it holds
    // one of the two `file.skipped` events. The run's own figure is the truth.
    const progress = toAnalysisProgress(
      stream({
        finished: true,
        skippedTotal: 2,
        skipped: [{ path: "src/legacy/totals.ts", reason: "구문 오류 3건" }],
      }),
    );

    expect(progress.completion?.filesSkipped).toBe(2);
  });

  it("carries the model's coverage through untouched, null and all", () => {
    // Null is an answer here, not a missing one: it is what a run with full
    // coverage and a run with no model both look like, and the screen draws
    // nothing for it. Inventing a zero would put a shortfall on a project that
    // never had one.
    expect(toAnalysisProgress(stream({ finished: true })).coverage).toBeNull();

    const partial = toAnalysisProgress(
      stream({
        finished: true,
        coverage: { examined: 40, notExamined: 80, reason: "file_budget" },
      }),
    );

    expect(partial.coverage).toEqual({
      examined: 40,
      notExamined: 80,
      reason: "file_budget",
    });
  });

  it("keeps coverage out of the completion, because they answer different questions", () => {
    // `completion` is what the run found. Coverage is what it never looked at.
    // Folding one into the other is how a summary starts reading as complete.
    const progress = toAnalysisProgress(
      stream({
        finished: true,
        itemCount: 68,
        connectionCount: 121,
        coverage: { examined: 40, notExamined: 80, reason: "token_budget" },
      }),
    );

    expect(progress.completion).not.toHaveProperty("coverage");
    expect(progress.coverage?.notExamined).toBe(80);
  });

  it("never reports a completion for a run that stopped", () => {
    const progress = toAnalysisProgress(
      stream({ finished: true, failure: "읽는 도중에 멈췄어요.", itemCount: 31 }),
    );

    expect(progress.completion).toBeNull();
    expect(progress.failure).toBe("읽는 도중에 멈췄어요.");
  });
});

describe("toRunProgress", () => {
  it("reads a live run as running", () => {
    const run = toRunProgress(
      stream({ phase: "static", link: "open", filesParsed: 9, filesOffered: 20 }),
    );

    expect(run.status).toBe("running");
    expect(run.filesTotal).toBe(20);
    expect(run.filesParsed).toBe(9);
  });

  it("calls a run that has said nothing yet an ingest", () => {
    // The panel has no null phase, and "fetching" is what a run that has not
    // reported is doing.
    expect(toRunProgress(stream({ link: "connecting" })).phase).toBe("ingest");
  });

  it("separates a failure from a completion", () => {
    expect(toRunProgress(stream({ finished: true })).status).toBe("completed");
    expect(toRunProgress(stream({ finished: true, failure: "멈췄어요" })).status).toBe(
      "failed",
    );
  });
});

/* ------------------------------------------------------------- the shell */

function fileItem(id: string, path: string): GraphItem {
  return {
    id,
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

function view(items: GraphItem[]): GraphView {
  return {
    projectId: "p1",
    items,
    connections: [],
    lastRun: {
      id: "r1",
      status: "completed",
      finishedAt: "2026-09-19T00:00:00.000Z",
      filesParsed: items.length,
      filesSkipped: [],
      error: null,
    },
  };
}

function render(props: Parameters<typeof Workspace>[0]): string {
  return renderToStaticMarkup(createElement(Workspace, props));
}

const PROJECT = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "coding-interview-prep",
  source: "github" as const,
  repoOwner: "heon-1219",
  repoName: "coding-interview-prep",
};

describe("the workspace shell", () => {
  it("holds exactly one beam input, in every state", () => {
    // Warning 2 of UI_DIRECTION section 5: an input that moves to a different
    // parent is remounted, and a remount throws away the IME's composition
    // state — a half-typed 한글 syllable disappears. One input in one place for
    // every state is the structural guarantee that it cannot happen.
    const withMap = render({
      project: PROJECT,
      initialView: view([fileItem("a", "src/app/page.jsx")]),
      activeRunId: null,
    });
    const midRun = render({
      project: PROJECT,
      initialView: view([]),
      activeRunId: "22222222-2222-4222-8222-222222222222",
    });
    const neverRead = render({
      project: PROJECT,
      initialView: { projectId: "p1", items: [], connections: [], lastRun: null },
      activeRunId: null,
    });

    for (const html of [withMap, midRun, neverRead]) {
      expect(html.match(/aria-label="지도에서 찾기"/g)).toHaveLength(1);
    }
  });

  it("offers to read a project nobody has read yet", () => {
    const html = render({
      project: PROJECT,
      initialView: { projectId: "p1", items: [], connections: [], lastRun: null },
      activeRunId: null,
    });

    expect(html).toContain("아직 읽지 않은 프로젝트예요");
    expect(html).toContain("지도 그리기");
  });

  it("reads well on a project with no symbols at all", () => {
    // The founder's portfolio shape: files and links, nothing cut out of them.
    const files = Array.from({ length: 58 }, (_, index) =>
      fileItem(`f${index}`, index % 2 === 0 ? `pages/p${index}.html` : `assets/a${index}.css`),
    );
    const html = render({ project: PROJECT, initialView: view(files), activeRunId: null });

    // The left panel names its territories rather than going blank, and no
    // count of a kind this project does not have appears anywhere.
    expect(html).toContain("파일");
    expect(html).not.toContain("조각 0");
  });

  it("never uses the words the product is not allowed to use", () => {
    const html = render({
      project: PROJECT,
      initialView: view([fileItem("a", "src/app/page.jsx")]),
      activeRunId: null,
    });

    // Section 1's forbidden vocabulary, plus the one promise section 3 forbids:
    // we may say there is no known connection, never that anything is safe.
    const visible = html.replace(/<[^>]*>/g, " ");
    for (const banned of ["노드", "엣지", "온톨로지", "안전", "entity", "triple"]) {
      expect(visible).not.toContain(banned);
    }
  });
});
