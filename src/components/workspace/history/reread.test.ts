import { describe, expect, it } from "vitest";

import {
  ALREADY_NOTE,
  GENERIC_NOTE,
  OFFLINE_NOTE,
  adoptedRunId,
  hasDrawnMap,
  noteIsWrong,
  readStartResponse,
  rereadState,
  runIsGoing,
  startNote,
} from "./reread";

/**
 * The 다시 읽기 button, as a set of answers rather than as a rendering.
 *
 * Two failures are what these are for, and neither is visible on the screen:
 * a 202 that started nothing being read as a fresh run, and a refusal losing
 * the sentence the endpoint wrote for this person.
 */

/** A well-formed run id, since the wire schema insists on one. */
const RUN = "9c1a2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const OTHER_RUN = "1a2b3c4d-5e6f-4a7b-9c8d-0e1f2a3b4c5e";

describe("runIsGoing", () => {
  it("is going while the workspace is watching a run", () => {
    expect(runIsGoing({ activeRunId: RUN, lastRunStatus: "completed" })).toBe(
      true,
    );
  });

  it("is going for a run this band did not start", () => {
    // The centre button, or another tab. Either way the band does not own it
    // and must not offer a second one.
    expect(runIsGoing({ activeRunId: null, lastRunStatus: "running" })).toBe(true);
    expect(runIsGoing({ activeRunId: null, lastRunStatus: "pending" })).toBe(true);
  });

  it("is not going for a run that has ended, or for no run at all", () => {
    expect(runIsGoing({ activeRunId: null, lastRunStatus: "completed" })).toBe(
      false,
    );
    expect(runIsGoing({ activeRunId: null, lastRunStatus: "failed" })).toBe(false);
    expect(runIsGoing({ activeRunId: null, lastRunStatus: null })).toBe(false);
  });
});

describe("hasDrawnMap", () => {
  it("counts the run the workspace's map came from, before the band's own list arrives", () => {
    expect(
      hasDrawnMap({ lastRunStatus: "completed", runStatuses: [] }),
    ).toBe(true);
  });

  it("counts a completed run anywhere in the band's list", () => {
    expect(
      hasDrawnMap({
        lastRunStatus: "failed",
        runStatuses: ["failed", "completed"],
      }),
    ).toBe(true);
  });

  it("is false for a project whose every run stopped or is still going", () => {
    expect(
      hasDrawnMap({ lastRunStatus: "failed", runStatuses: ["failed", "running"] }),
    ).toBe(false);
    expect(hasDrawnMap({ lastRunStatus: null, runStatuses: [] })).toBe(false);
  });
});

describe("rereadState", () => {
  it("offers the first reading of a project nobody has read", () => {
    const state = rereadState({ starting: false, going: false, drawn: false });
    expect(state).toEqual({
      kind: "ready",
      label: "지도 그리기",
      turning: false,
      pressable: true,
    });
  });

  it("offers another reading of a project that has a map", () => {
    const state = rereadState({ starting: false, going: false, drawn: true });
    expect(state.kind).toBe("ready");
    expect(state.label).toBe("지도 다시 그리기");
    expect(state.pressable).toBe(true);
  });

  it("says so while its own request is out", () => {
    const state = rereadState({ starting: true, going: false, drawn: true });
    expect(state).toEqual({
      kind: "starting",
      label: "시작하는 중…",
      turning: true,
      pressable: false,
    });
  });

  it("does not offer a second run while one is going", () => {
    const state = rereadState({ starting: false, going: true, drawn: true });
    expect(state.kind).toBe("going");
    expect(state.label).toBe("지금 읽고 있어요");
    expect(state.turning).toBe(true);
    expect(state.pressable).toBe(false);
  });

  it("lets a run that is going outrank its own request", () => {
    // A run found in flight is the state the band does not own, and it wins
    // over anything this button thinks it is in the middle of.
    expect(rereadState({ starting: true, going: true, drawn: true }).kind).toBe(
      "going",
    );
  });
});

describe("readStartResponse", () => {
  it("reads a started run", () => {
    expect(readStartResponse(202, { runId: RUN, started: true })).toEqual({
      kind: "started",
      runId: RUN,
    });
  });

  it("does not read started:false as a start", () => {
    // The endpoint found a run already in flight and handed that one back.
    // Calling it a fresh start would report a re-read that never happened.
    expect(readStartResponse(202, { runId: OTHER_RUN, started: false })).toEqual({
      kind: "already",
      runId: OTHER_RUN,
    });
  });

  it("refuses to guess at a 202 it cannot read", () => {
    expect(readStartResponse(202, { runId: "not-an-id", started: true })).toEqual({
      kind: "unreadable",
    });
    expect(readStartResponse(202, null)).toEqual({ kind: "unreadable" });
  });

  it("keeps the endpoint's own sentence for every refusal", () => {
    expect(
      readStartResponse(401, { message: "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요." }),
    ).toEqual({
      kind: "refused",
      message: "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.",
    });
    expect(readStartResponse(404, { message: "이 프로젝트를 찾지 못했어요. 목록에서 다시 열어 주세요." })).toEqual({
      kind: "refused",
      message: "이 프로젝트를 찾지 못했어요. 목록에서 다시 열어 주세요.",
    });
  });

  it("has no sentence to keep when the refusal carried none", () => {
    expect(readStartResponse(500, null)).toEqual({
      kind: "refused",
      message: null,
    });
  });
});

describe("adoptedRunId", () => {
  it("hands up a run it started and a run it found", () => {
    expect(adoptedRunId({ kind: "started", runId: RUN })).toBe(RUN);
    expect(adoptedRunId({ kind: "already", runId: OTHER_RUN })).toBe(OTHER_RUN);
  });

  it("has nothing to hand up when nothing is running", () => {
    expect(adoptedRunId({ kind: "refused", message: "안 돼요." })).toBeNull();
    expect(adoptedRunId({ kind: "unreadable" })).toBeNull();
    expect(adoptedRunId({ kind: "offline" })).toBeNull();
  });
});

describe("startNote", () => {
  it("says nothing when the screen itself is the answer", () => {
    expect(startNote({ kind: "started", runId: RUN })).toBeNull();
  });

  it("says a run was already going", () => {
    expect(startNote({ kind: "already", runId: RUN })).toBe(ALREADY_NOTE);
  });

  it("prints the refusal as the endpoint wrote it", () => {
    const told = "올려주신 폴더를 보관하지 않아서 다시 읽을 수 없어요.";
    expect(startNote({ kind: "refused", message: told })).toBe(told);
  });

  it("falls back only when the refusal said nothing", () => {
    expect(startNote({ kind: "refused", message: null })).toBe(GENERIC_NOTE);
    expect(startNote({ kind: "refused", message: "   " })).toBe(GENERIC_NOTE);
    expect(startNote({ kind: "unreadable" })).toBe(GENERIC_NOTE);
  });

  it("names the connection when the request never arrived", () => {
    expect(startNote({ kind: "offline" })).toBe(OFFLINE_NOTE);
  });
});

describe("noteIsWrong", () => {
  it("does not dress a run that is already going as a failure", () => {
    expect(noteIsWrong({ kind: "already", runId: RUN })).toBe(false);
    expect(noteIsWrong({ kind: "started", runId: RUN })).toBe(false);
  });

  it("marks the three that are", () => {
    expect(noteIsWrong({ kind: "refused", message: null })).toBe(true);
    expect(noteIsWrong({ kind: "unreadable" })).toBe(true);
    expect(noteIsWrong({ kind: "offline" })).toBe(true);
  });
});
