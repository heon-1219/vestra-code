import { z } from "zod";

import { FLOW_FORBIDDEN_EXTRA, FORBIDDEN_WORDS } from "./words";

/**
 * The model's reply, and every reason to throw a piece of it away.
 *
 * This is the file that decides what a person who cannot read code is told
 * about their own project, so it is written the way `python/llm.ts` is: an
 * answer that fails any check is **dropped, not repaired**. There is no lower
 * confidence to fall to and the reader cannot open the code to check, so a
 * plausible sentence that is wrong is the worst thing this pass can produce.
 * A missing label is visibly missing; a wrong one is not.
 *
 * Every drop is counted. A prompt that has started producing rubbish shows up
 * as a number in the run log rather than as a quietly emptier map.
 *
 * ## The checks, and what each one is for
 *
 *  1. **The index was one we sent.** D46's whole point: the model answers with
 *     integers into a list we built, so "drop any id that does not exist"
 *     becomes a set membership test that cannot be talked around.
 *  2. **There is Hangul in it.** "No English reaches a user" is a product rule,
 *     and the failure it catches is the common one: a model asked for a plain
 *     name that returns `PayButton` has not answered the question.
 *  3. **The label is not the identifier.** Same failure, one step subtler —
 *     `pay_button.py` → `pay_button`. Compared against the basename with
 *     separators and case removed.
 *  4. **The summary is 해요체.** Every sentence in this product's UI is, in all
 *     53 of them with no exceptions (D74). A 합니다체 sentence from a model would
 *     be the first, and it would read as a different voice in the middle of the
 *     map.
 *  5. **No forbidden word.** 안전 · 노드 · 엣지, as everywhere else.
 *  6. **Length.** A name is a name; a summary is one sentence. A model that
 *     answers with a paragraph is answering a different question, and the
 *     paragraph would be truncated by the layout rather than by us.
 */

const integer = z.coerce.number().int();

const namingSchema = z.object({
  items: z
    .array(
      z.object({
        i: integer.min(0),
        label: z.string().optional(),
        summary: z.string().optional(),
      }),
    )
    .max(400)
    .optional(),
});

const featureSchema = z.object({
  features: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string().optional(),
        files: z.array(integer.min(0)).max(600).optional(),
      }),
    )
    .max(40)
    .optional(),
});

/** Why something the model said did not reach the database. */
export type DropReason =
  | "unknown_index"
  | "duplicate"
  | "not_korean"
  | "echoes_the_code"
  | "not_haeyoche"
  | "forbidden_word"
  | "too_long"
  | "empty"
  | "no_members"
  | "unreadable_reply"
  /** A reply cut off at the completion ceiling. Kept whole or not at all. */
  | "truncated";

export type Drops = Record<DropReason, number>;

export function noDrops(): Drops {
  return {
    unknown_index: 0,
    duplicate: 0,
    not_korean: 0,
    echoes_the_code: 0,
    not_haeyoche: 0,
    forbidden_word: 0,
    too_long: 0,
    empty: 0,
    no_members: 0,
    unreadable_reply: 0,
    truncated: 0,
  };
}

/** A name and, for a file, a sentence. Both already checked. */
export type NamedItem = {
  index: number;
  label: string;
  /** Null for a piece: D54 keeps symbol summaries lazy. */
  summary: string | null;
};

export type NamedFeature = {
  name: string;
  summary: string | null;
  /** File indices, de-duplicated, in the order the model gave them. */
  files: number[];
};

/** A name is a name. Past this it is being used as a sentence. */
export const MAX_LABEL_CHARS = 24;
/** One sentence, in a panel that is not a document viewer. */
export const MAX_SUMMARY_CHARS = 120;
/** 결제, 로그인, 장바구니. A feature whose name needs more is not a feature. */
export const MAX_FEATURE_NAME_CHARS = 16;

/**
 * Names and sentences, minus everything that failed a check.
 *
 * `allowed` is the set of indices this request actually sent, and `wantsSummary`
 * the subset that are files. A piece that comes back with a summary simply
 * loses the summary — the name is still useful and there is no reason to
 * discard it over an extra field.
 */
export function parseNamingReply(
  text: string | null,
  allowed: ReadonlySet<number>,
  wantsSummary: ReadonlySet<number>,
  /** Code names by index, so a label can be checked against the thing it names. */
  codeNames: ReadonlyMap<number, string>,
  drops: Drops = noDrops(),
): { items: NamedItem[]; drops: Drops } {
  const body = extractJson(text);
  const parsed = body === null ? null : namingSchema.safeParse(body);
  if (!parsed?.success) {
    drops.unreadable_reply += 1;
    return { items: [], drops };
  }

  const items: NamedItem[] = [];
  const seen = new Set<number>();

  for (const raw of parsed.data.items ?? []) {
    if (!allowed.has(raw.i)) {
      drops.unknown_index += 1;
      continue;
    }
    if (seen.has(raw.i)) {
      // Two answers for one thing is not two facts. The first wins, because
      // taking the last would make the result depend on the order a model
      // happened to repeat itself in.
      drops.duplicate += 1;
      continue;
    }

    const label = cleanLabel(raw.label ?? "", codeNames.get(raw.i) ?? "", drops);
    if (label === null) continue;

    const summary = wantsSummary.has(raw.i)
      ? cleanSummary(raw.summary ?? "", drops)
      : null;

    seen.add(raw.i);
    items.push({ index: raw.i, label, summary });
  }

  return { items, drops };
}

export function parseFeatureReply(
  text: string | null,
  allowed: ReadonlySet<number>,
  drops: Drops = noDrops(),
): { features: NamedFeature[]; drops: Drops } {
  const body = extractJson(text);
  const parsed = body === null ? null : featureSchema.safeParse(body);
  if (!parsed?.success) {
    drops.unreadable_reply += 1;
    return { features: [], drops };
  }

  const features: NamedFeature[] = [];
  const takenNames = new Set<string>();

  for (const raw of parsed.data.features ?? []) {
    const name = cleanName(raw.name, drops);
    if (name === null) continue;
    if (takenNames.has(name)) {
      drops.duplicate += 1;
      continue;
    }

    const files: number[] = [];
    const seen = new Set<number>();
    for (const index of raw.files ?? []) {
      if (!allowed.has(index)) {
        drops.unknown_index += 1;
        continue;
      }
      if (seen.has(index)) continue;
      seen.add(index);
      files.push(index);
    }

    // A feature with nothing in it is a word, not a territory. It would draw an
    // empty district on the map and read as a part of the app that exists and
    // is empty — which is a claim about the user's code we did not make.
    if (files.length === 0) {
      drops.no_members += 1;
      continue;
    }

    takenNames.add(name);
    features.push({ name, summary: cleanSummary(raw.summary ?? "", drops), files });
  }

  return { features, drops };
}

/**
 * A plain-Korean name, or nothing.
 *
 * `codeName` is what the thing is called in the code. A label that survives
 * flattening to the same string is a transliteration rather than a name, which
 * is the single most common way this pass fails usefully-looking.
 */
export function cleanLabel(raw: string, codeName: string, drops: Drops): string | null {
  const text = tidy(raw);
  if (text === "") {
    drops.empty += 1;
    return null;
  }
  if ([...text].length > MAX_LABEL_CHARS) {
    drops.too_long += 1;
    return null;
  }
  if (hasForbidden(text)) {
    drops.forbidden_word += 1;
    return null;
  }
  if (!hasHangul(text)) {
    drops.not_korean += 1;
    return null;
  }
  if (codeName !== "" && flatten(text) === flatten(basename(codeName))) {
    drops.echoes_the_code += 1;
    return null;
  }
  return text;
}

/** A feature name. Same rules, a tighter ceiling, and nothing to echo. */
export function cleanName(raw: string, drops: Drops): string | null {
  const text = tidy(raw);
  if (text === "") {
    drops.empty += 1;
    return null;
  }
  if ([...text].length > MAX_FEATURE_NAME_CHARS) {
    drops.too_long += 1;
    return null;
  }
  if (hasForbidden(text)) {
    drops.forbidden_word += 1;
    return null;
  }
  if (!hasHangul(text)) {
    drops.not_korean += 1;
    return null;
  }
  return text;
}

/**
 * One sentence, 해요체, or nothing.
 *
 * A summary is optional everywhere it is used — the panel shows the name alone
 * when there is none — so dropping one costs a line and never a screen. That
 * asymmetry is what lets this be strict.
 */
export function cleanSummary(raw: string, drops: Drops): string | null {
  const text = tidy(raw);
  if (text === "") {
    drops.empty += 1;
    return null;
  }
  if ([...text].length > MAX_SUMMARY_CHARS) {
    drops.too_long += 1;
    return null;
  }
  if (hasForbidden(text)) {
    drops.forbidden_word += 1;
    return null;
  }
  if (!hasHangul(text)) {
    drops.not_korean += 1;
    return null;
  }
  if (!isHaeyoche(text)) {
    drops.not_haeyoche += 1;
    return null;
  }
  return text;
}

/**
 * Whether a sentence ends the way every sentence in this product ends.
 *
 * 해요체's endings all land on 요 — 해요, 이에요, 예요, 있어요, 보내요 — so the test is
 * the last syllable once the punctuation is off. Deliberately not a list of
 * endings: a list would be a guess about Korean morphology that gets one verb
 * wrong and silently drops a good sentence.
 *
 * It rejects 합니다체 (…합니다), 반말 (…해) and a bare noun phrase (…하는 곳),
 * which are the three things a model actually returns when it ignores rule 3.
 */
export function isHaeyoche(text: string): boolean {
  const stripped = text.replace(/[\s.!?~・…]+$/u, "");
  return stripped.endsWith("요");
}

export function hasHangul(text: string): boolean {
  return /[가-힣]/u.test(text);
}

/**
 * Both lists, not just the first three.
 *
 * Pass 2's output is not only read on the map. A `label` is the subject of
 * every row in 흐름 따라가기 and the words under every district, so a name this
 * pass coins is a sentence the flow shows — and the flow may not say 실행,
 * 추적 or 실시간, because we never ran anybody's code.
 *
 * **Found in production.** `/api/projects/:id/events` had been named
 * **실시간 상황 주소** by this pass and was appearing in the flow panel, on the
 * map and in the file list. Every other place a model writes Korean here
 * already refuses those three — `purpose/parse.ts` does, `flow.ts` does — and
 * this was the one door nobody was watching. Echoing a *user's* 추적 back to
 * them is fine; a word we chose ourselves is a claim.
 *
 * A dropped label costs the node its plain name and nothing else: it falls
 * back to what the code calls it, which is true, and D88's counters record
 * that it happened rather than hiding it.
 */
function hasForbidden(text: string): boolean {
  return (
    FORBIDDEN_WORDS.some((word) => text.includes(word)) ||
    FLOW_FORBIDDEN_EXTRA.some((word) => text.includes(word))
  );
}

function tidy(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}

/** The last path segment without its extension: `src/PayButton.tsx` → `PayButton`. */
function basename(pathOrName: string): string {
  const last = pathOrName.split("/").pop() ?? pathOrName;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}

/** Case, spaces and separators removed, so `pay_button` and `Pay Button` agree. */
function flatten(value: string): string {
  return value.toLowerCase().replace(/[\s_\-.]/gu, "");
}

/**
 * The model's JSON, however it wrapped it.
 *
 * Only endpoints that advertise `json_schema` are held to it on the wire (D47),
 * so elsewhere the object arrives inside prose or a fenced block. Returning
 * null on anything unreadable is the whole of the error handling this needs: a
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
