import { z } from "zod";

import { KIND_WORDS, type GraphItem } from "@/lib/graph/view";
// The leaf, for the reason `loop.ts` gives: the package index reaches `env.ts`.
import type { Llm } from "@/lib/llm/types";

import { GROUNDED_FALLBACK_SUMMARY } from "./answer";
import type { QaGraph } from "./tools";
import type { SourceReader } from "./source";
import type { Budget, StopReason } from "./types";

/**
 * 설명하기's deep read: the investigation loop, pointed at one place.
 *
 * The cheap answer comes first and costs nothing — Pass 2's label and summary,
 * the line `describe.ts` measured, the purpose sentences on its connections —
 * and it is rendered in the browser from the graph already on screen. This is
 * the second, on-demand depth: a model opens the selection's own source and
 * comes back with claims, each of which the citation ledger in `answer.ts` has
 * matched against lines this investigation actually read. **It is
 * `investigate()`, not a second loop** (D156); what this module adds is the
 * route's decisions, with everything they touch handed in so that a test can
 * drive them without an environment.
 *
 * ## The refusals, in the order they are asked
 *
 *   1. No session → 401. Somebody else's project, or no such project → the same
 *      404 with the same sentence, so the answer confirms nothing.
 *   2. No model → 409, never a fabricated answer.
 *   3. **An uploaded project that kept no files → 409 with a sentence.** The
 *      brief's promise is that we do not keep source; an upload made before we
 *      kept anything has nothing to open, and this is where that is said —
 *      plainly, in Korean, rather than as a loop that runs and reports it could
 *      open nothing.
 *   4. Nothing selected that the map holds, or a thing with no file behind it
 *      (a package, a feature) → a sentence that says why there is no code to
 *      read.
 */

/**
 * Smaller than `/ask`'s, because the question is smaller.
 *
 * `/ask` is hunting a symptom across a project and was measured at 16 steps of
 * 20. This is one place the person already pointed at: read it, open a
 * neighbour or two, report. D156 records the live runs these numbers came
 * from — 3 of 10 steps, 9.8k–11.0k input tokens and 5–8 s each, on three real
 * places — so the step ceiling has room for a place three times harder, and
 * the token ceiling (about nine runs' worth) is set so the step ceiling binds
 * first.
 */
export const EXPLAIN_BUDGET: Partial<Budget> = {
  maxSteps: 10,
  maxInputTokens: 90_000,
  maxOutputTokens: 15_000,
  maxMillis: 150_000,
};

/** The sentences this route refuses with. Exported for the tests. */
export const EXPLAIN_WORDS = {
  unauthenticated: "로그인이 필요해요. 다시 로그인한 뒤에 시도해 주세요.",
  notFound: "이 프로젝트를 찾지 못했어요.",
  unreadable: "무엇을 설명해 드릴지 읽지 못했어요.",
  noModel:
    "아직 모델이 연결되지 않아서 코드를 직접 읽어 드릴 수 없어요. 위에 적힌 설명은 그대로 보실 수 있어요.",
  noGraph: "아직 지도를 그리지 않아서 읽어 볼 곳이 없어요. 먼저 지도 그리기를 눌러 주세요.",
  noItem: "지도에서 이 곳을 찾지 못했어요. 지도를 새로 그렸다면 다시 골라 주세요.",
  noStoredSource:
    "올려 주신 폴더의 파일을 보관하지 않은 프로젝트라서, 코드를 직접 열어 읽어 볼 수 없어요. 위에 적힌 설명은 지도에서 읽은 것만으로 적은 거예요. 폴더를 다시 올리면 읽어 볼 수 있어요.",
  noSource: "이 프로젝트의 코드를 어디서 읽어 와야 할지 몰라서 열어 볼 수 없어요.",
  package: "밖에서 가져온 도구라서 이 프로젝트 안에는 읽을 코드가 없어요.",
  feature: "기능은 저희가 묶어 둔 이름이라서 따로 읽을 코드가 없어요. 기능 안에 있는 것을 하나 골라 주세요.",
  noPath: "이 곳은 파일이 정해져 있지 않아서 코드를 열어 볼 수 없어요.",
} as const;

export type ExplainProject = {
  id: string;
  source: "github" | "upload";
  repoOwner: string | null;
  repoName: string | null;
  defaultBranch: string | null;
};

export type ExplainDeps = {
  session: () => Promise<{ user: { id: string } } | null>;
  /** The project, only if it belongs to `userId`. */
  findOwnedProject: (projectId: string, userId: string) => Promise<ExplainProject | null>;
  llm: (model: "mimo" | "gemini" | "custom" | undefined) => Llm | null;
  loadGraph: (projectId: string) => Promise<QaGraph>;
  /** How many files an uploaded project kept. Never called for a GitHub one. */
  storedFiles: (projectId: string) => Promise<number>;
  /** How this project's files are reached, or null when they cannot be. */
  sourceFor: (project: ExplainProject) => Promise<SourceReader | null>;
};

export type ExplainPlan = {
  project: ExplainProject;
  item: GraphItem;
  graph: QaGraph;
  llm: Llm;
  source: SourceReader;
  question: string;
  effort: "fast" | "deep" | undefined;
};

export type ExplainPrepared =
  | { ok: true; plan: ExplainPlan }
  | { ok: false; status: number; message: string };

const paramsSchema = z.object({ id: z.uuid() });

const bodySchema = z.object({
  itemId: z.string().min(1).max(200),
  /** Whatever the person typed alongside, which narrows what gets explained. */
  question: z.string().trim().max(1000).optional(),
  model: z.enum(["mimo", "gemini", "custom"]).optional(),
  effort: z.enum(["fast", "deep"]).optional(),
});

export async function prepareExplain(
  deps: ExplainDeps,
  rawParams: unknown,
  rawBody: () => Promise<unknown>,
): Promise<ExplainPrepared> {
  const session = await deps.session();
  if (!session) return refuse(EXPLAIN_WORDS.unauthenticated, 401);

  const params = paramsSchema.safeParse(rawParams);
  if (!params.success) return refuse(EXPLAIN_WORDS.notFound, 404);

  const project = await deps.findOwnedProject(params.data.id, session.user.id);
  if (!project) return refuse(EXPLAIN_WORDS.notFound, 404);

  let body: unknown;
  try {
    body = await rawBody();
  } catch {
    return refuse(EXPLAIN_WORDS.unreadable, 400);
  }
  const asked = bodySchema.safeParse(body);
  if (!asked.success) return refuse(EXPLAIN_WORDS.unreadable, 400);

  const llm = deps.llm(asked.data.model);
  if (!llm) return refuse(EXPLAIN_WORDS.noModel, 409);

  // Before the graph is read: the cheapest question that can end the request.
  if (project.source === "upload" && (await deps.storedFiles(project.id)) === 0) {
    return refuse(EXPLAIN_WORDS.noStoredSource, 409);
  }

  const graph = await deps.loadGraph(project.id);
  if (graph.items.length === 0) return refuse(EXPLAIN_WORDS.noGraph, 409);

  const item = graph.items.find((candidate) => candidate.id === asked.data.itemId);
  if (!item) return refuse(EXPLAIN_WORDS.noItem, 404);
  if (item.kind === "package") return refuse(EXPLAIN_WORDS.package, 409);
  if (item.kind === "feature") return refuse(EXPLAIN_WORDS.feature, 409);
  if (!item.path) return refuse(EXPLAIN_WORDS.noPath, 409);

  const source = await deps.sourceFor(project);
  if (!source) {
    return refuse(
      project.source === "upload" ? EXPLAIN_WORDS.noStoredSource : EXPLAIN_WORDS.noSource,
      409,
    );
  }

  return {
    ok: true,
    plan: {
      project,
      item,
      graph,
      llm,
      source,
      question: explainQuestion(item, asked.data.question ?? null),
      effort: asked.data.effort,
    },
  };
}

/**
 * What the model is asked, in the person's register.
 *
 * The place is named by its code name and its path, because those are what the
 * model will find when it opens the file — and by the plain name where Pass 2
 * wrote one, because that is what the person called it. Anything they typed
 * goes last and is quoted: it narrows the explanation, it does not replace it.
 */
export function explainQuestion(item: GraphItem, extra: string | null): string {
  const plain = item.label && item.label !== item.name ? ` (${item.label})` : "";
  const where = item.path ? `, ${item.path}${lineRange(item)}` : "";
  // 여기가, not 이 파일이 / 이 페이지가: the subject particle after a kind word
  // depends on its last syllable, and a sentence that never needs one cannot
  // get it wrong.
  const base = `${KIND_WORDS[item.kind]} ${item.name}${plain}${where} — 여기가 무슨 일을 하는지 코드를 읽고 쉬운 말로 설명해 주세요.`;
  const also = extra && extra.trim().length > 0 ? ` 덧붙인 질문: "${extra.trim()}"` : "";
  return base + also;
}

function lineRange(item: GraphItem): string {
  if (item.startLine === null) return "";
  const end = item.endLine ?? item.startLine;
  return end === item.startLine ? ` ${item.startLine}줄` : ` ${item.startLine}–${end}줄`;
}

/**
 * What the deep read says when it stops without an explanation.
 *
 * `/ask`'s sentences were written for a question, and three of them ended
 * "다시 물어봐 주세요" under a card whose button reads 다시 읽어 보기, over a
 * read nobody had phrased as a question. Only the budget sentences had been
 * adapted; these are the rest (D166). "원인을 짚어 드리기 어려워요" is
 * the right admission for a symptom and the wrong one here, where nothing was
 * broken and there was no cause to find.
 */
export const EXPLAIN_STOP_WORDS = {
  truncated: "설명이 중간에 잘려서 그대로 전해 드릴 수 없어요. 다시 읽어 보기를 눌러 주세요.",
  no_answer: "코드를 읽기는 했는데 정리된 설명을 받지 못했어요. 다시 읽어 보기를 눌러 주세요.",
  llm_failed: "읽는 도중에 모델과 연결이 끊겼어요. 잠시 후에 다시 읽어 보기를 눌러 주세요.",
  stopped: "읽다가 중간에 멈췄어요.",
  ungrounded:
    "이번에는 근거가 되는 줄을 확인하지 못해서, 모델이 쓴 설명을 그대로 전해 드릴 수 없어요. 위에 적힌 설명은 그대로 보실 수 있어요.",
} as const;

/**
 * Who wrote the deep read's paragraph: the model, or the loop.
 *
 * The model's own paragraph travels only on an answered read with at least one
 * finding that survived its citation check, and only when it is written in
 * words this product uses (`loop.ts`). Every other paragraph — a refused call,
 * a spent budget, a report that failed its check — is one of our sentences,
 * and the card must not mark it 모델이 쓴 말. Seen live when the provider
 * refused every call: the card read 모델이 코드를 직접 읽고 쓴 말 over
 * "찾아보는 도중에 연결이 끊겼어요", after 0 tokens in and 0 out.
 */
export function deepSummaryAuthor(answer: {
  stop: StopReason | null;
  findings: readonly unknown[];
  summary: string;
}): "model" | "product" {
  return answer.stop === "answered" &&
    answer.findings.length > 0 &&
    answer.summary !== GROUNDED_FALLBACK_SUMMARY
    ? "model"
    : "product";
}

function refuse(message: string, status: number): ExplainPrepared {
  return { ok: false, status, message };
}
