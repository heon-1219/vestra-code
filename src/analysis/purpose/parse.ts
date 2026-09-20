import { z } from "zod";

import { cleanSummary, noDrops, type Drops } from "../semantic/parse";
import { FLOW_FORBIDDEN_EXTRA } from "../semantic/words";

/**
 * The model's reply, and every reason to throw a sentence away.
 *
 * Written the way `semantic/parse.ts` is, and it reuses that file's checker
 * rather than restating it: an answer that fails any check is **dropped, not
 * repaired**. A purpose sentence is shown beside a connection to somebody who
 * cannot open the code to check it, so a plausible sentence that is wrong is
 * the worst thing this pass can produce. A missing one is visibly missing — the
 * connection keeps its structural verb, which is true and was never wrong, only
 * general.
 *
 * ## The checks, and which file holds each
 *
 *  1. **The index was one we sent.** D46: the model answers with integers into
 *     a list we built, so this is a bounds check that cannot be talked around.
 *  2. **Hangul, 해요체, length, and the three forbidden words** — all of these
 *     are `semantic/parse.ts#cleanSummary`, imported rather than copied. That
 *     is the filter that fired on real output when a repository containing
 *     `safety.py` made the model reach for 안전 (D95), and a second copy of it
 *     would be the drift it exists to prevent.
 *  3. **The three flow words**, on top. A purpose sentence becomes a hop's
 *     sentence in 흐름 따라가기, and D78 refuses 실행 · 추적 · 실시간 there.
 *  4. **A tighter ceiling than a summary's.** A purpose is read on one line of
 *     a 317px panel, beside a name and a verb. `cleanSummary` allows 120
 *     characters because a file's summary has a paragraph to itself; here that
 *     would be three wrapped lines per connection row.
 */

const integer = z.coerce.number().int();

const purposeSchema = z.object({
  items: z
    .array(z.object({ i: integer.min(0), why: z.string().optional() }))
    .max(400)
    .optional(),
});

/**
 * One line, beside a name and a verb, in the narrowest column on the screen.
 *
 * The prompt asks for 30 and this allows 60. The headroom is deliberate and is
 * D88's lesson applied the other way round: the cost of allowing a slightly
 * long sentence is one wrapped line, and the cost of refusing it is a
 * connection that keeps 사용해요 for ever.
 */
export const MAX_PURPOSE_CHARS = 60;

export type PurposeAnswer = { index: number; sentence: string };

/**
 * Sentences, minus everything that failed a check.
 *
 * `allowed` is the set of indices this request actually sent. Drops are counted
 * into the same `Drops` record Pass 2 uses, so one run log reads in one
 * vocabulary.
 */
export function parsePurposeReply(
  text: string | null,
  allowed: ReadonlySet<number>,
  drops: Drops = noDrops(),
): { items: PurposeAnswer[]; drops: Drops } {
  const body = extractJson(text);
  const parsed = body === null ? null : purposeSchema.safeParse(body);
  if (!parsed?.success) {
    drops.unreadable_reply += 1;
    return { items: [], drops };
  }

  const items: PurposeAnswer[] = [];
  const seen = new Set<number>();

  for (const raw of parsed.data.items ?? []) {
    if (!allowed.has(raw.i)) {
      drops.unknown_index += 1;
      continue;
    }
    if (seen.has(raw.i)) {
      // Two answers for one purpose is not two facts. The first wins, because
      // taking the last would make the result depend on the order a model
      // happened to repeat itself in.
      drops.duplicate += 1;
      continue;
    }

    const sentence = cleanPurpose(raw.why ?? "", drops);
    if (sentence === null) continue;

    seen.add(raw.i);
    items.push({ index: raw.i, sentence });
  }

  return { items, drops };
}

/** One sentence a connection row can carry, or nothing. */
export function cleanPurpose(raw: string, drops: Drops): string | null {
  const text = cleanSummary(raw, drops);
  if (text === null) return null;

  if ([...text].length > MAX_PURPOSE_CHARS) {
    drops.too_long += 1;
    return null;
  }
  if (FLOW_FORBIDDEN_EXTRA.some((word) => text.includes(word))) {
    drops.forbidden_word += 1;
    return null;
  }
  return text;
}

/**
 * The model's JSON, however it wrapped it.
 *
 * The same reader `semantic/parse.ts` uses and for the same reason (D47): only
 * endpoints that advertise `json_schema` are held to it on the wire, so
 * elsewhere the object arrives inside prose or a fenced block. Returning null
 * on anything unreadable is the whole of the error handling this needs — a
 * reply we cannot read produces no rows, which is the correct outcome.
 */
function extractJson(text: string | null): unknown {
  if (!text) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}
