import type { ChangeScope } from "../incremental";
import { normalizePath } from "../ids";

import type { Outline, OutlineEntry, OutlineFile } from "./outline";

/**
 * Which files the model is asked about, and which are left alone.
 *
 * Two rules decide everything here, and both are cost rules rather than
 * quality ones.
 *
 * **Files, never symbols (D52).** Production holds 1,442 nodes for a project
 * whose *files* number in the hundreds. Asking about every node would be an
 * order of magnitude more expensive and would produce a dozen wordings of one
 * fact — `PayButton.tsx`, `PayButton`, `PayButton`'s click handler and its
 * `useEffect` are one thing to the person reading the map. Pieces inherit
 * their file's feature through Pass 1's `contains` edges, which
 * `grouping.ts#byFeature` already implements. A small allowance of pieces
 * *does* get a name, because 결제 버튼 is worth having and D54 measured that
 * naming only the most connected ones costs ~4k output tokens instead of ~54k.
 *
 * **An unchanged file is never asked about twice.** Its label and summary are
 * already on the row and Pass 1's upsert does not touch those columns, so
 * carrying forward is the *absence* of work rather than a copy. On a re-read
 * where nothing changed this makes the whole pass cost zero tokens.
 *
 * Everything below is deterministic: same outline and same previous answers in,
 * same questions out, in the same order. That is what makes the measurement in
 * the report reproducible, and what a later cache on the outline bytes (D53)
 * would need.
 */

export type SemanticBudget = {
  /** Files the model is asked to name at all. The rest are reported, not asked. */
  maxFiles: number;
  /** Files per request. */
  batchSize: number;
  /** Of the files we ask about, how many also get their pieces named (D54). */
  maxPieceFiles: number;
  /** Pieces listed for one file. */
  maxPiecesPerFile: number;
  /** Files listed in the one feature request. */
  maxOutlineFiles: number;
  /** Input plus output tokens for the whole pass. */
  maxTokens: number;
  /**
   * Hard ceiling on one naming reply. The ceiling actually sent is computed
   * from the batch — see `outputCeilingFor` — and clamped to this, so a
   * runaway answer cannot eat the pass on its own.
   */
  maxOutputTokens: number;
  /** Ceiling on the feature reply, which is one call and answers about everything. */
  maxFeatureOutputTokens: number;
};

/*
 * Measured, not guessed. Numbers from `Kim-and-Chang-`
 * (e0ef56c2-386f-4862-a41b-69a8d1bab3dd), a real 284-edge Python project, and
 * from the `shop` fixture; see the report and `docs/DECISIONS.md` D78.
 *
 *  - `maxFiles: 120`. The project above offers 112 nameable files, so 120 opens
 *    all of it in one run. Above that a project is large enough that the map's
 *    value is in its shape rather than in every leaf being named, and the
 *    coverage event says out loud how many were left.
 *  - `batchSize: 12`. A batch is what one truncation costs, and the measured
 *    answer is ~55 output tokens per file plus ~25 per piece, so twelve files
 *    carrying four pieces each answers in ~1,500 tokens. Smaller batches
 *    multiply the fixed system prompt (~320 tokens) across more calls.
 *  - `maxPieceFiles: 40` x `maxPiecesPerFile: 4` = 160 piece names, which is
 *    D54's order of magnitude — thousands of output tokens rather than the
 *    ~54k of naming every symbol in the project.
 *  - `maxOutlineFiles: 400`. The feature call is one call over the whole
 *    project; D52 measured a 300-file outline at ~12k input tokens.
 *  - `maxTokens: 400_000`. A ceiling on the pass, not a target. The measured
 *    cost of a full first run on the project above is ~2% of it.
 */
export const DEFAULT_SEMANTIC_BUDGET: SemanticBudget = {
  maxFiles: 120,
  batchSize: 12,
  maxPieceFiles: 40,
  maxPiecesPerFile: 4,
  maxOutlineFiles: 400,
  maxTokens: 400_000,
  maxOutputTokens: 4_000,
  maxFeatureOutputTokens: 3_000,
};

/*
 * What one answer costs, measured rather than assumed.
 *
 * On `Kim-and-Chang-`: a batch of 20 files with no pieces answered in 1,014
 * output tokens and a batch of 8 in 427 — 51 and 53 tokens per file. A piece is
 * a name with no sentence (D54), so roughly half of that.
 *
 * **This is not decoration; it is the fix for a measured defect.** The first
 * version of this file sent a flat 2,000-token ceiling, and the very first
 * batch of the very first real run — 20 files carrying 120 pieces — came back
 * at 1,985 tokens with `finishReason: "length"` and was discarded whole. Every
 * Python source file in that project came back unnamed while its markdown was
 * named perfectly, and nothing anywhere reported it: the run completed, the
 * coverage event said full coverage, and the map simply had no words on the
 * half of it that mattered. A ceiling that is a constant is a ceiling that is
 * wrong for some batch.
 *
 * 70 and 30 rather than 55 and 25: a third of headroom, because the cost of
 * over-asking is nothing at all (the ceiling is not a reservation) and the cost
 * of under-asking is an entire batch.
 */
const OUTPUT_PER_FILE = 70;
const OUTPUT_PER_PIECE = 30;
/** The JSON scaffolding around the answers, plus room to close the object. */
const OUTPUT_OVERHEAD = 240;

/** How long this batch's answer is allowed to be. */
export function outputCeilingFor(
  targets: readonly NamingTarget[],
  budget: SemanticBudget = DEFAULT_SEMANTIC_BUDGET,
): number {
  const pieces = targets.reduce((count, target) => count + target.pieces.length, 0);
  const wanted =
    OUTPUT_OVERHEAD + targets.length * OUTPUT_PER_FILE + pieces * OUTPUT_PER_PIECE;
  return Math.min(wanted, budget.maxOutputTokens);
}

/** One file to ask about, with the pieces that go in the question. */
export type NamingTarget = {
  file: OutlineFile;
  /** Pieces to name alongside it. Empty for most files, by budget. */
  pieces: readonly OutlineEntry[];
};

export type Selection = {
  /** In the order they will be asked, batched by the caller. */
  targets: readonly NamingTarget[];
  /** Files whose stored label and summary this run keeps without asking. */
  carried: readonly OutlineFile[];
  /** Files the budget could not reach. Neither asked nor already known. */
  skipped: readonly OutlineFile[];
};

/**
 * Rank, and then cut at the budget.
 *
 * The order is the order a person would look in: the files that serve an
 * address first, because `/checkout` is the thing someone points at when they
 * ask what their app does; then the most connected, because a file everything
 * else touches is the one whose missing name is most visible on the map. Ties
 * break on the path, so the questions are identical between two runs.
 */
export function selectTargets(
  outline: Outline,
  scope: ChangeScope,
  budget: SemanticBudget = DEFAULT_SEMANTIC_BUDGET,
): Selection {
  const changed =
    scope.mode === "incremental"
      ? new Set([...scope.changed].map(normalizePath))
      : null;

  const carried: OutlineFile[] = [];
  const candidates: OutlineFile[] = [];

  for (const file of outline.files) {
    // Already named, and nothing in it moved. There is no work to do: the row
    // keeps the text it has, because Pass 1's upsert never writes these
    // columns (see `persist.ts`) and the sweep is what carries the row itself.
    //
    // `changed === null` is a full run, which by definition does not know what
    // moved. Re-asking is then the only honest option, and the budget is what
    // stops it being expensive.
    const known = file.label !== null && file.summary !== null;
    if (known && changed !== null && !changed.has(file.filePath)) {
      carried.push(file);
      continue;
    }
    candidates.push(file);
  }

  const ranked = [...candidates].sort(compareFiles);
  const chosen = ranked.slice(0, budget.maxFiles);
  const skipped = ranked.slice(budget.maxFiles);

  // Which of the chosen also get their pieces named. Ranked the same way, so
  // the allowance lands on the files a person opens first — and computed over
  // the chosen set rather than the whole project, because a piece in a file
  // the model never read cannot be named from anything.
  const withPieces = new Set(
    chosen
      .filter((file) => file.pieces.length > 0)
      .slice(0, budget.maxPieceFiles)
      .map((file) => file.filePath),
  );

  const targets = chosen.map<NamingTarget>((file) => ({
    file,
    pieces: withPieces.has(file.filePath)
      ? rankPieces(file).slice(0, budget.maxPiecesPerFile)
      : [],
  }));

  return { targets, carried, skipped };
}

/** Cut a selection into requests. One shape, so the parser has one job. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, size);
  for (let at = 0; at < items.length; at += step) out.push(items.slice(at, at + step));
  return out;
}

/**
 * The files the feature question is asked over.
 *
 * Every file, not only the ones we named: features are a statement about the
 * shape of the whole project, and a feature list drawn from the first 120 files
 * of a 400-file repo would be a confident claim about a project we half read.
 * Capped anyway, because one call has to fit in one context.
 */
export function featureOutline(
  outline: Outline,
  budget: SemanticBudget = DEFAULT_SEMANTIC_BUDGET,
): readonly OutlineFile[] {
  return [...outline.files].sort(compareFiles).slice(0, budget.maxOutlineFiles);
}

function compareFiles(a: OutlineFile, b: OutlineFile): number {
  const byAddress = Number(b.addresses.length > 0) - Number(a.addresses.length > 0);
  if (byAddress !== 0) return byAddress;
  if (a.degree !== b.degree) return b.degree - a.degree;
  if (a.importedBy !== b.importedBy) return b.importedBy - a.importedBy;
  return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
}

/**
 * Which pieces of a file are worth a name.
 *
 * Addresses first — a page or an endpoint is a thing the user can point at.
 * Then components and hooks, which are what a screen is made of, then
 * everything else. A `type` last: it is a shape, and a plain-Korean name for a
 * shape is the least useful sentence this pass can produce.
 */
const PIECE_RANK: Record<string, number> = {
  route: 0,
  api_endpoint: 0,
  component: 1,
  hook: 2,
  class: 3,
  function: 4,
  style_rule: 5,
  type: 6,
};

function rankPieces(file: OutlineFile): OutlineEntry[] {
  return [...file.pieces].sort((a, b) => {
    const rank = (entry: OutlineEntry) =>
      PIECE_RANK[entry.kind === "symbol" ? (entry.shape ?? "function") : entry.kind] ?? 9;
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return a.index - b.index;
  });
}
