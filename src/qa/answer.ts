import { z } from "zod";

import { normalisePath } from "./source";
import type { LedgerEntry } from "./tools";
import type { Citation, Finding, RefusedFinding } from "./types";

/**
 * The gate every claim has to get through before a person reads it.
 *
 * This module is the reason the loop is worth building. A model that has looked
 * at four files writes a fluent paragraph about all of them, and the two
 * sentences it checked and the two it assembled from names read exactly alike.
 * Six real defects in this codebase passed a type checker, a linter and five
 * hundred tests while living in the rendered result — the thing that finds them
 * is looking, and the thing that makes looking trustworthy is refusing to
 * repeat anything that was not looked at.
 *
 * So: a claim carries the place it was checked, the place is matched against
 * what this investigation actually fetched, and `certain` is reserved for lines
 * that came back from `read_source`. Nothing here trusts the model's own
 * account of its diligence.
 */

/** Same coercion as the tools: `"42"` for a line number is not worth a retry. */
const integer = z.coerce.number().int();

const citationSchema = z
  .object({
    path: z.string().trim().min(1).max(1024),
    startLine: integer.min(1).max(10_000_000),
    endLine: integer.min(1).max(10_000_000),
  })
  .refine((c) => c.endLine >= c.startLine, {
    message: "끝 줄이 시작 줄보다 앞설 수 없어요",
  });

const findingSchema = z.object({
  claim: z.string().trim().min(1).max(400),
  /**
   * Two values, and the enum is where the third one dies.
   *
   * A model asked for a confidence label will happily write "likely" or
   * "probable" — that is the softer third word the product does not have. Here
   * it is a parse failure with a message, which costs one step and gets a
   * corrected report, rather than a new vocabulary word leaking onto a screen
   * beside 확실해요 and 짐작이에요.
   */
  certainty: z.enum(["certain", "inferred"]),
  citations: z.array(citationSchema).min(1).max(2),
});

export const reportSchema = z.object({
  answer: z.string().trim().min(1).max(1_500),
  /**
   * Default rather than required: "I found nothing" is a legitimate report, and
   * rejecting it would spend a step teaching the model to invent a finding.
   * What happens to an answer with nothing under it is decided in the loop, not
   * by making it unsayable here.
   */
  findings: z.array(findingSchema).max(8).default([]),
  ruledOut: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  unresolved: z.string().trim().max(400).optional(),
});

export type Report = z.infer<typeof reportSchema>;

/** The parse failure, as one line the model can act on. */
export function reportIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "값"}: ${issue.message}`)
    .join(", ");
}

/**
 * Words the product does not use, whoever wrote the sentence.
 *
 * `안전` because the brief is explicit: the UI may say there are no known
 * connections, and may not say that changing something is safe. We walked one
 * import graph; we do not know what is safe, and saying so to someone who is
 * frightened of their own project is the single most damaging sentence this
 * product could ship.
 *
 * `노드` and `엣지` because `view.ts` draws that boundary: past it a thing is an
 * 조각 and a link is a 연결. A model handed a graph reaches for the graph words,
 * and the user has never seen them.
 */
export const FORBIDDEN_WORDS = ["안전", "노드", "엣지"] as const;

/**
 * Hedges, refused only on a `certain` claim.
 *
 * A finding that says 확실해요 and then "…인 것 같아요" has contradicted its own
 * label, and the label is what the map draws. The same sentence under
 * `inferred` is fine — that is what `inferred` is for — so this is not a ban on
 * hedging, it is a ban on hedging while claiming to have read the line.
 *
 * Written as whole hedge forms rather than fragments on purpose: bare `같아요`
 * would also catch `똑같아요`, and refusing a checked claim over a false match
 * is the same kind of loss as passing an unchecked one on.
 */
export const HEDGE_WORDS = [
  "아마",
  "것 같",
  "듯해",
  "듯한",
  "추정",
  "가능성",
  "수도 있",
] as const;

export function forbiddenWordsIn(text: string): string[] {
  return FORBIDDEN_WORDS.filter((word) => text.includes(word));
}

export function hedgesIn(text: string): string[] {
  return HEDGE_WORDS.filter((word) => text.includes(word));
}

/**
 * Whether a cited range is somewhere this investigation actually went, and
 * whether it was read or only pointed at.
 *
 * Containment, not overlap. A model that read lines 40–92 and cites 40–200 has
 * told us about 108 lines it never saw, and an overlap test would let that
 * through on the strength of the 53 it did. The narrower claim is always
 * available to it: cite what came back.
 */
export function coverageOf(
  citation: Citation,
  ledger: readonly LedgerEntry[],
): { covered: boolean; read: boolean } {
  const path = normalisePath(citation.path);
  let covered = false;
  let read = false;
  for (const entry of ledger) {
    if (entry.path !== path) continue;
    if (entry.startLine > citation.startLine) continue;
    if (entry.endLine < citation.endLine) continue;
    covered = true;
    if (entry.read) read = true;
  }
  return { covered, read };
}

/**
 * Split what the model reported into what we will repeat and what we will not.
 *
 * The refused ones are returned rather than dropped, because "the model claimed
 * this and could not back it" is information the caller needs — it is how you
 * find out the loop is being run on a question it cannot answer, and it is the
 * only way a user ever hears that something was left out.
 */
export function checkFindings(
  findings: readonly Finding[],
  ledger: readonly LedgerEntry[],
): { kept: Finding[]; refused: RefusedFinding[] } {
  const kept: Finding[] = [];
  const refused: RefusedFinding[] = [];

  for (const raw of findings) {
    // The citation is normalised on the way through, so what the caller stores
    // and what the map holds are spelled the same way.
    const finding: Finding = {
      claim: raw.claim,
      certainty: raw.certainty,
      citations: raw.citations.map((citation) => ({
        ...citation,
        path: normalisePath(citation.path),
      })),
    };

    if (forbiddenWordsIn(finding.claim).length > 0) {
      refused.push({ ...finding, reason: "forbidden_words" });
      continue;
    }
    if (finding.certainty === "certain" && hedgesIn(finding.claim).length > 0) {
      refused.push({ ...finding, reason: "hedged_certainty" });
      continue;
    }

    const coverage = finding.citations.map((c) => coverageOf(c, ledger));
    if (coverage.some((one) => !one.covered)) {
      refused.push({ ...finding, reason: "unread_citation" });
      continue;
    }
    // Every citation on a `certain` claim has to have been read. One read line
    // and one guessed one is a claim that was half checked, which is `inferred`.
    if (finding.certainty === "certain" && coverage.some((one) => !one.read)) {
      refused.push({ ...finding, reason: "certain_without_reading" });
      continue;
    }

    kept.push(finding);
  }

  return { kept, refused };
}

/**
 * What we say when the model's own sentence cannot be repeated.
 *
 * Deliberately not "here is the answer, but…". An ungrounded paragraph with a
 * disclaimer under it is still read as the answer — that is the whole failure
 * this loop exists to prevent — so the paragraph does not travel. The findings
 * that did survive are returned beside this and carry the content.
 */
export const UNGROUNDED_SUMMARY =
  "이번에는 근거가 되는 줄을 확인하지 못했어요. 확인한 것만 알려드릴 수 있어서, 아직은 원인을 짚어 드리기 어려워요.";

export const GROUNDED_FALLBACK_SUMMARY =
  "근거를 확인한 것만 아래에 정리했어요.";
