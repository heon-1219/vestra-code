import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { Llm, LlmReply } from "@/lib/llm/types";

import { GOAL_NOTES, readGoal, restateGoal } from "./goal";
import { handleGoalRequest, type GoalRouteDeps } from "./goal-route";
import { ownedProject, ROUTE_WORDS } from "./owned";

/**
 * `POST /api/projects/:id/prompt`, driven without an environment.
 *
 * The ownership check is the part that matters most and the part a test is
 * most tempted to take on trust, so it is pinned twice: once as the SQL the
 * condition actually renders to — both halves, both parameters — and once as
 * behaviour, where a project that belongs to somebody else answers exactly as
 * a project that does not exist.
 */

const PROJECT = "6a069e22-91c8-492a-baea-820be1f8d7f6";
const OWNER = "user-owner";

function llmSaying(text: string | null, finishReason: LlmReply["finishReason"] = "stop"): Llm {
  return {
    complete: vi.fn(async () => ({
      text,
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 20 },
      finishReason,
    })),
  };
}

function deps(overrides: Partial<GoalRouteDeps> = {}): GoalRouteDeps {
  return {
    session: async () => ({ user: { id: OWNER } }),
    findOwnedProject: async (projectId, userId) =>
      projectId === PROJECT && userId === OWNER ? { id: PROJECT } : null,
    selectionNames: async () => [{ name: "PayButton", label: "결제 버튼", path: "src/components/PayButton.tsx" }],
    llm: () => llmSaying("결제 버튼(PayButton)의 색을 파란색으로 바꿔 주세요."),
    ...overrides,
  };
}

const BODY = { request: "이거 파란색으로 바꿔줘", selectionIds: ["s-pay"] };

describe("the ownership condition", () => {
  it("renders as the id AND the owner, with both as parameters", () => {
    const query = new PgDialect().sqlToQuery(ownedProject(PROJECT, OWNER));
    expect(query.sql).toBe('("projects"."id" = $1 and "projects"."user_id" = $2)');
    expect(query.params).toEqual([PROJECT, OWNER]);
  });
});

describe("who may ask", () => {
  it("refuses without a session before reading anything", async () => {
    const findOwnedProject = vi.fn();
    const body = vi.fn();
    const reply = await handleGoalRequest(
      deps({ session: async () => null, findOwnedProject }),
      { id: PROJECT },
      body,
    );
    expect(reply).toEqual({ status: 401, body: { message: ROUTE_WORDS.unauthenticated } });
    expect(findOwnedProject).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });

  it("asks for the project as the signed-in user, and nobody else", async () => {
    const findOwnedProject = vi.fn(async () => ({ id: PROJECT }));
    await handleGoalRequest(deps({ findOwnedProject }), { id: PROJECT }, async () => BODY);
    expect(findOwnedProject).toHaveBeenCalledWith(PROJECT, OWNER);
  });

  it("answers somebody else's project exactly as a missing one, and never calls the model", async () => {
    const llm = vi.fn(() => llmSaying("x"));
    const stranger = await handleGoalRequest(
      deps({ session: async () => ({ user: { id: "someone-else" } }), llm }),
      { id: PROJECT },
      async () => BODY,
    );
    const missing = await handleGoalRequest(
      deps({ llm }),
      { id: "00000000-0000-4000-8000-000000000000" },
      async () => BODY,
    );
    expect(stranger).toEqual({ status: 404, body: { message: ROUTE_WORDS.notFound } });
    expect(missing).toEqual(stranger);
    expect(llm).not.toHaveBeenCalled();
  });

  it("looks the selection up inside the owned project only", async () => {
    const selectionNames = vi.fn(async () => []);
    await handleGoalRequest(deps({ selectionNames }), { id: PROJECT }, async () => BODY);
    expect(selectionNames).toHaveBeenCalledWith(PROJECT, ["s-pay"]);
  });

  it("refuses a malformed id as not found, and a malformed body as unreadable", async () => {
    expect((await handleGoalRequest(deps(), { id: "nope" }, async () => BODY)).status).toBe(404);
    expect(
      (await handleGoalRequest(deps(), { id: PROJECT }, async () => ({ request: "" }))).status,
    ).toBe(400);
    expect(
      (
        await handleGoalRequest(deps(), { id: PROJECT }, async () => {
          throw new SyntaxError("bad json");
        })
      ).status,
    ).toBe(400);
  });
});

describe("the restatement", () => {
  it("comes back as the goal", async () => {
    const reply = await handleGoalRequest(deps(), { id: PROJECT }, async () => BODY);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ goal: "결제 버튼(PayButton)의 색을 파란색으로 바꿔 주세요.", note: null });
  });

  it("refuses with a sentence when no model is connected, rather than inventing a goal", async () => {
    const reply = await handleGoalRequest(deps({ llm: () => null }), { id: PROJECT }, async () => BODY);
    expect(reply).toEqual({ status: 409, body: { message: ROUTE_WORDS.noModel } });
  });

  it("says the goal is the person's own words when the model's could not be used", async () => {
    const reply = await handleGoalRequest(
      deps({ llm: () => llmSaying("이 버튼을 바꾸는 건 안전해요.") }),
      { id: PROJECT },
      async () => BODY,
    );
    expect(reply.body).toEqual({ goal: null, reason: "unusable", note: GOAL_NOTES.unusable });
  });
});

describe("reading the model's goal", () => {
  it("takes one or two lines and strips the quotes a model adds anyway", () => {
    expect(readGoal("“결제 버튼을 파란색으로 바꿔 주세요.”")).toBe("결제 버튼을 파란색으로 바꿔 주세요.");
    expect(readGoal("결제 버튼을\n파란색으로 바꿔 주세요.")).toBe("결제 버튼을 파란색으로 바꿔 주세요.");
  });

  it("refuses an essay, an empty answer and a forbidden word", () => {
    expect(readGoal("하나\n둘\n셋")).toBeNull();
    expect(readGoal("")).toBeNull();
    expect(readGoal(null)).toBeNull();
    expect(readGoal("노드 색을 바꿔 주세요.")).toBeNull();
    expect(readGoal("가".repeat(301))).toBeNull();
  });

  it("treats a reply cut off at the ceiling as unusable, and a thrown one as failed", async () => {
    expect(
      await restateGoal({ llm: llmSaying("결제 버튼을", "length"), request: "x", places: [] }),
    ).toEqual({ ok: false, reason: "unusable" });
    const throwing: Llm = { complete: async () => Promise.reject(new Error("boom")) };
    expect(await restateGoal({ llm: throwing, request: "x", places: [] })).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await restateGoal({ llm: null, request: "x", places: [] })).toEqual({
      ok: false,
      reason: "no_model",
    });
  });

  it("tells the model the selection's name, so 이거 can become a name", async () => {
    const llm = llmSaying("결제 버튼을 파란색으로 바꿔 주세요.");
    await restateGoal({
      llm,
      request: "이거 파란색으로",
      places: [{ name: "PayButton", label: "결제 버튼", path: "src/components/PayButton.tsx" }],
    });
    const call = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toContain("PayButton · 쉬운 이름: 결제 버튼 · src/components/PayButton.tsx");
    expect(call.messages[1]).toEqual({ role: "user", content: "이거 파란색으로" });
    // One call, no tools: the model's only job is the goal.
    expect(call.tools).toBeUndefined();
  });

  it("writes every note in 해요체", () => {
    for (const note of Object.values(GOAL_NOTES)) {
      expect(note).toMatch(/요\.$/);
      expect(note).not.toMatch(/습니다|합니다/);
    }
  });
});
