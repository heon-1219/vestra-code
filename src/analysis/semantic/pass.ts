import type { ChangeScope } from "../incremental";
import type { NodeRef } from "../ids";
import type { AnalyzedEdge, AnalyzedNode } from "../types";
// `@/lib/llm/types` and never the package index. The index re-exports
// `llmFromEnv`, which reaches `env.ts` — and `env.ts` validates 21 variables at
// import time and throws when one is missing. `LlmError` is a class, so it is a
// runtime import; taken from the index it would make this module, and every
// test of it, unimportable on a machine with no API key.
import { LlmError, type Llm } from "@/lib/llm/types";

import { featureKey, type PreviousFeature } from "./features";
import type { Outline, OutlineFile } from "./outline";
import {
  noDrops,
  parseFeatureReply,
  parseNamingReply,
  type Drops,
  type NamedFeature,
} from "./parse";
import {
  buildFeaturePrompt,
  buildNamingPrompt,
  FEATURE_JSON_SCHEMA,
  FEATURE_SYSTEM_PROMPT,
  NAMING_JSON_SCHEMA,
  NAMING_SYSTEM_PROMPT,
} from "./prompt";
import {
  batches,
  DEFAULT_SEMANTIC_BUDGET,
  featureCeilingFor,
  featureOutline,
  outputCeilingFor,
  selectTargets,
  type NamingTarget,
  type SemanticBudget,
} from "./select";

/**
 * Pass 2, the semantic layer.
 *
 * Pass 1 draws the map. This pass writes the words on it: a plain-Korean name
 * and a one-sentence description for each file, and the 기능 territories —
 * 결제, 로그인, 장바구니 — that `grouping.ts#byFeature` has been waiting for since
 * before it was written.
 *
 * ## The three rules it is built around
 *
 * **Everything here is the model's opinion, so everything here is `inferred`
 * and `origin = 'llm'`.** There is no path through this file that produces a
 * `certain` row. The map draws a hatched territory from that fact and the
 * product's whole claim rests on it: a person who cannot read the code cannot
 * check us, so the one thing we owe them is knowing which half of the picture
 * was guessed.
 *
 * **A model failure is never a run failure.** The static graph is the floor.
 * If there is no API key, if the key is wrong, if the endpoint is down, if the
 * budget runs out — the pass returns what it has, the phase still advances, the
 * run still completes, and the coverage numbers say what was not opened. Every
 * `catch` in this file ends in a recorded reason, never in a throw.
 *
 * **An unchanged file is not asked about twice.** `select.ts` carries its name
 * and sentence forward by simply not asking, which works because Pass 1's
 * upsert deliberately never writes `label`, `summary` or `textLang`
 * (`persist.ts` says so in its header). A re-read of a repository nobody
 * pushed to therefore costs **zero model calls**, which is the case this code
 * will be in most often.
 *
 * ## What it does not do
 *
 * It does not name every node. Production holds 1,442 of them for a project
 * with a few hundred files; D52 settled that the question is asked about files,
 * and pieces inherit their file's feature through Pass 1's `contains` edges.
 * A small, ranked allowance of pieces gets a name anyway (D54), because 결제
 * 버튼 is worth having and the measured cost of naming only the most connected
 * ones is ~4k output tokens rather than ~54k.
 */

/** Progress, as it happens. The pipeline turns these into persisted events. */
export type SemanticEmitter = {
  featureCreated: (name: string, memberCount: number) => void;
  nodesAssigned: (count: number) => void;
};

/** One row of plain language, addressed the way analyzers address everything. */
export type SemanticText = {
  ref: NodeRef;
  label: string;
  /** Null for a piece: D54 keeps symbol summaries lazy. */
  summary: string | null;
};

/**
 * Why the pass stopped. The same vocabulary `python/llm.ts` uses, so
 * `llmCoveragePayload` translates both without a branch — and `null` for "no
 * model ran at all", which is an ordinary state and not a shortfall.
 */
export type SemanticStop =
  | "completed"
  | "token_budget"
  | "file_budget"
  | "llm_error"
  | "aborted";

export type SemanticResult = {
  /** `feature` nodes. Always `origin = 'llm'`. */
  nodes: AnalyzedNode[];
  /** `belongs_to`, member → feature. Always `inferred`, always `origin = 'llm'`. */
  edges: AnalyzedEdge[];
  /** `label` / `summary` / `textLang`, for the writer in `persist.ts`. */
  text: SemanticText[];
  /** Features, for the log and for the report's numbers. */
  features: { key: string; label: string; memberCount: number }[];
  /** Files the model read this run. */
  examined: string[];
  /** Files it read in an earlier run and was not asked about again. */
  carried: string[];
  /**
   * Files nobody has ever opened. **"We did not look" and "there is nothing
   * there" are opposite claims** and a map drawn from a half-read project looks
   * exactly like a map of a project with little in it.
   */
  notExamined: string[];
  stopped: SemanticStop | null;
  /** The failure, in Korean, when one happened. */
  error: string | null;
  spent: { calls: number; inputTokens: number; outputTokens: number };
  drops: Drops;
};

export type SemanticPassInput = {
  /** Null is ordinary: no key configured. The pass then does nothing and says so. */
  llm: Llm | null;
  outline: Outline;
  /** What changed since the last run. Decides what is carried forward. */
  scope: ChangeScope;
  /** Features the last run wrote, so their ids survive a rename (D55). */
  previousFeatures?: readonly PreviousFeature[];
  budget?: Partial<SemanticBudget>;
  emit?: SemanticEmitter;
  signal?: AbortSignal;
};

/**
 * Ask, check, and hand back rows. No database, no HTTP, no environment.
 *
 * Injected model, injected outline, injected budget — the same shape
 * `RunAnalysisInput` uses, and for the same reason: a unit test of this file
 * must not drag `env.ts` in. Persistence is the caller's, in `persist.ts`.
 */
export async function runSemanticPass(
  input: SemanticPassInput,
): Promise<SemanticResult> {
  const budget = { ...DEFAULT_SEMANTIC_BUDGET, ...input.budget };
  const previous = input.previousFeatures ?? [];

  const result: SemanticResult = {
    nodes: [],
    edges: [],
    text: [],
    features: [],
    examined: [],
    carried: [],
    notExamined: [],
    stopped: "completed",
    error: null,
    spent: { calls: 0, inputTokens: 0, outputTokens: 0 },
    drops: noDrops(),
  };

  if (!input.llm) {
    // No model configured. Not a failure and not reported as one: the parser
    // half produced a real map, and "0개 열어 봤어요" over it would turn a
    // configuration we chose into a fault the user cannot fix and did not
    // cause. The features the last run wrote are restated so the sweep that
    // follows a successful run does not delete them.
    result.stopped = null;
    carryFeaturesForward(previous, result, input.emit);
    return result;
  }

  const llm = input.llm;
  const selection = selectTargets(input.outline, input.scope, budget);
  result.carried = selection.carried.map((file) => file.filePath);
  result.notExamined = selection.skipped.map((file) => file.filePath);
  if (selection.skipped.length > 0) result.stopped = "file_budget";

  const labelled = new Map<number, string>();
  const groups = batches(selection.targets, budget.batchSize);

  for (let at = 0; at < groups.length; at += 1) {
    const group = groups[at];
    const paths = group.map((target) => target.file.filePath);

    if (input.signal?.aborted) {
      result.stopped = "aborted";
      result.notExamined.push(...pathsFrom(groups, at));
      break;
    }
    if (spent(result) >= budget.maxTokens) {
      // Out of budget, not out of files. Everything from here is a file nobody
      // opened, and saying which is the whole point of the distinction.
      result.stopped = "token_budget";
      result.notExamined.push(...pathsFrom(groups, at));
      break;
    }

    let asked: NamingTarget[] = [...group];
    let fatalError: unknown = null;
    /** Whether the model actually got as far as answering about these files. */
    let opened = false;

    /*
     * Two attempts at most, and the second one is narrower rather than the same
     * question again.
     *
     * A truncated reply is not a reply — half a JSON object would name the
     * first few files and lose the rest with nothing on screen to say any are
     * missing. Measured on a real project: one batch of 20 files carrying 120
     * pieces answered at 1,985 tokens against a flat 2,000-token ceiling and
     * was thrown away whole, so every source file in that repository came back
     * unnamed while its documentation was named perfectly.
     *
     * `outputCeilingFor` is the fix for that; this is the belt. Dropping the
     * pieces cuts the answer by roughly two thirds and keeps the part D52 says
     * is the point: the file's own name and sentence.
     */
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = buildNamingPrompt(asked);
      const codeNames = new Map<number, string>();
      for (const target of asked) {
        codeNames.set(target.file.index, target.file.filePath);
        for (const piece of target.pieces) codeNames.set(piece.index, piece.name);
      }

      let reply;
      try {
        reply = await llm.complete({
          messages: [
            { role: "system", content: NAMING_SYSTEM_PROMPT },
            { role: "user", content: prompt.text },
          ],
          maxOutputTokens: outputCeilingFor(asked, budget),
          temperature: 0,
          jsonSchema: { name: "vestra_naming", schema: NAMING_JSON_SCHEMA },
          effort: "fast",
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        /*
         * One batch's failure is not the run's failure — unless retrying cannot
         * help. A wrong key will still be wrong on the sixth batch, and six
         * requests spent discovering that is the user's time.
         */
        result.error = describeFailure(error);
        fatalError = fatal(error) ? error : null;
        if (!fatalError) result.notExamined.push(...paths);
        break;
      }

      result.spent.calls += 1;
      result.spent.inputTokens += reply.usage.inputTokens;
      result.spent.outputTokens += reply.usage.outputTokens;
      // The model read them. Whether its answer survived the parser is a
      // separate question from whether the files were opened, and the coverage
      // sentence a user reads is about the second one.
      if (!opened) {
        result.examined.push(...paths);
        opened = true;
      }

      if (reply.finishReason === "length") {
        // Counted, always. A batch silently discarded is the exact failure this
        // retry exists for, and it must show up as a number in the run log
        // rather than as a map that quietly has fewer words on it.
        result.drops.truncated += 1;
        const narrower = asked.filter((target) => target.pieces.length > 0);
        if (attempt === 0 && narrower.length > 0) {
          asked = asked.map((target) => ({ file: target.file, pieces: [] }));
          continue;
        }
        break;
      }

      const named = parseNamingReply(
        reply.text,
        prompt.allowed,
        prompt.files,
        codeNames,
        result.drops,
      );

      for (const item of named.items) {
        const entry = input.outline.byIndex.get(item.index);
        if (!entry) continue;
        result.text.push({ ref: entry.ref, label: item.label, summary: item.summary });
        if (entry.kind === "file") labelled.set(item.index, item.label);
      }
      break;
    }

    if (fatalError) {
      result.stopped = stopFor(fatalError);
      result.notExamined.push(...pathsFrom(groups, at));
      break;
    }
  }

  await nameFeatures({
    llm,
    outline: input.outline,
    budget,
    previous,
    freshLabels: labelled,
    asked: selection.targets.length,
    signal: input.signal,
    emit: input.emit,
    result,
  });

  return result;
}

// ---------------------------------------------------------------------------

/**
 * The one feature call.
 *
 * One, and over the whole project rather than over the files this run happened
 * to name: a feature is a claim about the shape of the thing, and a feature
 * list drawn from a fifth of a repository would be a confident statement about
 * a project we half read. D52 measured a 300-file outline at ~12k input tokens,
 * so the whole-project version is affordable exactly because the outline is
 * file-level.
 *
 * Skipped entirely when there is nothing new to say — no file was named this
 * run and nothing changed — in which case the previous run's answer is restated
 * verbatim. That is the case that makes a re-read of an untouched repository
 * cost nothing at all.
 */
async function nameFeatures(input: {
  llm: Llm;
  outline: Outline;
  budget: SemanticBudget;
  previous: readonly PreviousFeature[];
  freshLabels: ReadonlyMap<number, string>;
  /** How many files this run was asked about. Zero means nothing moved. */
  asked: number;
  signal?: AbortSignal;
  emit?: SemanticEmitter;
  result: SemanticResult;
}): Promise<void> {
  const { llm, outline, budget, previous, freshLabels, result } = input;

  const stalled =
    result.stopped === "aborted" ||
    result.stopped === "llm_error" ||
    result.stopped === "token_budget";

  /*
   * Nothing was asked and the last run already answered, so there is nothing to
   * re-derive from: every file has the name it had and the grouping over them
   * is the grouping we drew. This is the zero-token re-read, and it is the
   * state this pass will be in most often.
   *
   * Deliberately "nothing was asked" and not "nothing came back named". A batch
   * whose answers were all dropped is a signal that something is wrong with the
   * prompt or the endpoint, and it must not be quietly read as "the project did
   * not change" — the features would then be frozen at whatever the last good
   * run said, for ever, with nothing reporting it.
   */
  if (stalled || (input.asked === 0 && previous.length > 0)) {
    carryFeaturesForward(previous, result, input.emit);
    return;
  }

  // The model sees the Korean names this run just produced rather than only
  // paths: 결제 버튼 is better evidence for "this is 결제" than
  // `src/components/PayButton.tsx`, and it costs nothing — the line is one
  // string either way. Copies, so nothing mutates the outline the caller holds.
  const files = featureOutline(outline, budget).map<OutlineFile>((file) => ({
    ...file,
    label: freshLabels.get(file.index) ?? file.label,
  }));
  if (files.length === 0) return;

  const prompt = buildFeaturePrompt(files);

  let reply;
  try {
    reply = await llm.complete({
      messages: [
        { role: "system", content: FEATURE_SYSTEM_PROMPT },
        { role: "user", content: prompt.text },
      ],
      maxOutputTokens: featureCeilingFor(files, budget),
      temperature: 0,
      jsonSchema: { name: "vestra_features", schema: FEATURE_JSON_SCHEMA },
      effort: "fast",
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    // The naming half may have worked perfectly. Losing the territories the
    // last run drew, on top of that, would make a partial failure look like a
    // regression of the whole map.
    result.error = describeFailure(error);
    if (result.stopped === "completed") result.stopped = stopFor(error);
    carryFeaturesForward(previous, result, input.emit);
    return;
  }

  result.spent.calls += 1;
  result.spent.inputTokens += reply.usage.inputTokens;
  result.spent.outputTokens += reply.usage.outputTokens;

  if (reply.finishReason === "length") {
    // Half a feature list is a map missing territories with no sign that any
    // are missing, which is worse than keeping last run's complete one.
    result.drops.unreadable_reply += 1;
    carryFeaturesForward(previous, result, input.emit);
    return;
  }

  const answer = parseFeatureReply(reply.text, prompt.allowed, result.drops);
  if (answer.features.length === 0) {
    carryFeaturesForward(previous, result, input.emit);
    return;
  }

  writeFeatures(answer.features, outline, previous, result, input.emit);
}

/**
 * Turn accepted features into rows.
 *
 * Direction matters and is written once, here: `belongs_to` goes **member →
 * feature**. `grouping.ts#byFeature` finds the feature by looking at which end
 * *is* a feature rather than by trusting the arrow, so a reversed edge would
 * not crash anything — it would quietly put the feature inside the file.
 */
function writeFeatures(
  features: readonly NamedFeature[],
  outline: Outline,
  previous: readonly PreviousFeature[],
  result: SemanticResult,
  emit?: SemanticEmitter,
): void {
  const taken = new Set<string>();
  let assigned = 0;

  for (const feature of features) {
    const members: NodeRef[] = [];
    const memberPaths: string[] = [];
    for (const index of feature.files) {
      const entry = outline.byIndex.get(index);
      if (!entry || entry.kind !== "file") continue;
      members.push(entry.ref);
      memberPaths.push(entry.filePath);
    }
    if (members.length === 0) {
      result.drops.no_members += 1;
      continue;
    }

    const key = featureKey({
      label: feature.name,
      memberPaths,
      previous,
      taken,
    });
    const ref: NodeRef = { type: "feature", filePath: "", name: key };

    result.nodes.push({
      ref,
      metadata: {
        // Read by the pipeline to write these rows with `origin: 'llm'` rather
        // than `static`. A feature is the one node type a model invents.
        origin: "llm",
        via: "semantic",
        memberCount: members.length,
      },
    });
    // `label` and `summary` are not columns `persistGraph` writes, by design —
    // see its header. They go through `persist.ts` in a second statement.
    result.text.push({ ref, label: feature.name, summary: feature.summary });

    for (const member of members) {
      result.edges.push({
        source: member,
        target: ref,
        type: "belongs_to",
        // A model's opinion is never `certain`. There is no exception for how
        // confident it sounded.
        confidence: "inferred",
        metadata: { origin: "llm", via: "semantic" },
      });
      assigned += 1;
    }

    result.features.push({ key, label: feature.name, memberCount: members.length });
    emit?.featureCreated(feature.name, members.length);
  }

  if (assigned > 0) emit?.nodesAssigned(assigned);
}

/**
 * Restate last run's features without asking anything.
 *
 * Not an optimisation — a correctness requirement. A `feature` node has no file
 * path, so `carryForwardSkipped` (which finds rows by path) cannot stamp it,
 * and D20's sweep deletes every row this run did not see. Without this, one
 * run with no model or one failed feature call would delete every territory on
 * the map **and**, through `ON DELETE CASCADE`, every `belongs_to` edge
 * pointing at it — including the user's own corrections.
 */
function carryFeaturesForward(
  previous: readonly PreviousFeature[],
  result: SemanticResult,
  emit?: SemanticEmitter,
): void {
  let assigned = 0;

  for (const feature of previous) {
    const ref: NodeRef = { type: "feature", filePath: "", name: feature.key };
    result.nodes.push({
      ref,
      metadata: {
        origin: "llm",
        via: "semantic",
        memberCount: feature.memberPaths.length,
        // So a run log can tell a restated territory from a freshly named one.
        carriedForward: true,
      },
    });

    for (const path of feature.memberPaths) {
      result.edges.push({
        source: { type: "file", filePath: path },
        target: ref,
        type: "belongs_to",
        confidence: "inferred",
        metadata: { origin: "llm", via: "semantic", carriedForward: true },
      });
      assigned += 1;
    }

    result.features.push({
      key: feature.key,
      label: feature.label ?? feature.key,
      memberCount: feature.memberPaths.length,
    });
    if (feature.label) emit?.featureCreated(feature.label, feature.memberPaths.length);
  }

  if (assigned > 0) emit?.nodesAssigned(assigned);
}

function pathsFrom(groups: readonly { file: OutlineFile }[][], from: number): string[] {
  return groups.slice(from).flatMap((group) => group.map((target) => target.file.filePath));
}

function spent(result: SemanticResult): number {
  return result.spent.inputTokens + result.spent.outputTokens;
}

function fatal(error: unknown): boolean {
  return !(error instanceof LlmError) || !error.retryable;
}

function stopFor(error: unknown): SemanticStop {
  return error instanceof LlmError && error.kind === "aborted" ? "aborted" : "llm_error";
}

function describeFailure(error: unknown): string {
  if (error instanceof LlmError) {
    if (error.kind === "auth") return "모델 열쇠가 맞지 않아서 이름을 다 붙이지 못했어요.";
    if (error.kind === "rate_limit") return "모델이 잠시 바빠서 이름을 다 붙이지 못했어요.";
    if (error.kind === "aborted") return "분석이 중간에 멈춰서 이름을 다 붙이지 못했어요.";
  }
  return "이름을 붙이다가 문제가 생겨서 일부는 그대로 두었어요.";
}
