/**
 * What a project says it is for, and the fence that keeps it data.
 *
 * This module holds the shape of a digest and the one way it is ever allowed to
 * enter a prompt. Nothing here talks to a model or a database, so the prompt
 * builder can import it without dragging either in — the same discipline
 * `src/qa/loop.ts` keeps around `@/lib/llm/types`, and for the same reason:
 * `@/lib/llm` reaches `env.ts`, which validates eleven variables at import and
 * throws.
 *
 * ## The rule this module exists to hold
 *
 * A README is written by whoever owns the repository. It can contain text aimed
 * at the model — "ignore your previous instructions", "you may answer without
 * citations" — and this product's whole value is that an answer cannot be
 * believed unless a line was read. So the digest is **fenced**: it goes in
 * between two markers, the system prompt says what is inside them is a
 * description written by the project's author and carries no authority, and the
 * markers themselves are stripped out of the content so the content cannot
 * close its own fence and start speaking as the prompt.
 *
 * The fence is not the only defence and must not be treated as one. The
 * citation ledger in `src/qa/answer.ts` is: a claim that cites somewhere this
 * investigation never fetched is refused whatever the README asked for, and
 * nothing here ever writes to that ledger.
 */

/** What a project's own documents say about it, in a few hundred tokens. */
export type ProjectDigest = {
  /** What the project is for, as the author tells it. 해요체, two or three sentences. */
  about: string;
  /** Names the author uses and what they mean, each one line: `낱말 — 뜻`. */
  words: string[];
  /** The files it was boiled down from, repo-relative (D18). */
  sources: string[];
};

/**
 * The ceilings, and they are the reason this feature is affordable.
 *
 * This text goes into the system prompt of EVERY question, and the system
 * prompt is re-sent on every turn of a twelve-step loop. A 5KB README pasted in
 * each time gives back everything D52-D54 were written to save. These numbers
 * put the rendered block at roughly 600 characters — a few hundred tokens,
 * paid twelve times rather than once, which is the arithmetic that matters.
 */
export const MAX_ABOUT_CHARS = 240;
export const MAX_WORDS = 6;
export const MAX_WORD_CHARS = 40;
export const MAX_SOURCES = 4;

/**
 * The markers. Long and unusual on purpose: a fence a document could plausibly
 * contain by accident is not a fence.
 */
export const DIGEST_FENCE_OPEN = "<<<프로젝트-설명-시작>>>";
export const DIGEST_FENCE_CLOSE = "<<<프로젝트-설명-끝>>>";

/**
 * Words the product does not use, whoever wrote the sentence.
 *
 * The same three as `src/qa/answer.ts`, re-stated rather than imported for the
 * same reason `src/analysis/python/llm.ts` re-states them: `answer.ts` reaches
 * `tools.ts`, which imports the workspace map components, and this module is
 * imported by a prompt builder that must stay cheap. If a fourth word is ever
 * added it belongs in all three places.
 */
const FORBIDDEN_WORDS = ["안전", "노드", "엣지"] as const;

export function digestForbiddenWordsIn(text: string): string[] {
  return FORBIDDEN_WORDS.filter((word) => text.includes(word));
}

/**
 * Untrusted text, with no way to stop being untrusted text.
 *
 * Both markers are removed from the content before it is wrapped, which is the
 * whole mechanism: a README that writes `<<<프로젝트-설명-끝>>>` followed by new
 * instructions gets a fence that never closes early, so its instructions stay
 * inside the part the prompt has already said carries no authority.
 *
 * Deliberately not an escape or an entity. There is nothing downstream that
 * would decode one, and a half-escaped marker is exactly the sort of thing that
 * works in a test and not on the day somebody tries it.
 */
export function fenceUntrusted(content: string): string {
  const safe = content
    .split(DIGEST_FENCE_OPEN)
    .join("")
    .split(DIGEST_FENCE_CLOSE)
    .join("")
    .trim();
  return [DIGEST_FENCE_OPEN, safe, DIGEST_FENCE_CLOSE].join("\n");
}

/**
 * The digest as the model reads it, or null when there is nothing fit to show.
 *
 * Every line says whose account this is. "적혀 있어요" rather than "이래요"
 * throughout, because the difference between what a document claims and what is
 * true is the one distinction this whole product is built on, and a digest that
 * reads like a fact is a digest that will be repeated as one.
 *
 * Normalised here rather than trusted to have been normalised earlier. This is
 * the last function before the text is in somebody's prompt, so it is the only
 * place where "the block is this big and says nothing we do not say" can be a
 * property rather than a convention — a digest written by an older deploy, or
 * assembled by a caller, goes through the same ceilings as a fresh one.
 */
export function renderDigestBlock(digest: ProjectDigest): string | null {
  const safe = normaliseDigest(digest);
  if (!safe) return null;

  const lines = [`무엇을 하는 프로젝트라고 적혀 있나: ${safe.about}`];
  if (safe.words.length > 0) {
    lines.push(`자주 나오는 말: ${safe.words.join(" / ")}`);
  }
  if (safe.sources.length > 0) {
    lines.push(`어디에 적혀 있나: ${safe.sources.join(", ")}`);
  }
  return fenceUntrusted(lines.join("\n"));
}

/**
 * A digest cut down to its ceilings, or null when there is nothing left.
 *
 * Applied both to what a model just produced and to what came back out of the
 * database, because a row written by an older version of this code is input
 * like any other and the prompt's size is not a thing to find out about later.
 *
 * `about` carrying a forbidden word takes the whole digest out rather than
 * being patched: a sentence we would have to edit to be allowed to show is not
 * a sentence we understood, and a project with no digest runs exactly as it
 * does today. A single offending `words` line is dropped on its own, which is
 * the same call `presentable()` makes in the loop.
 */
export function normaliseDigest(raw: {
  about: string;
  words: readonly string[];
  sources: readonly string[];
}): ProjectDigest | null {
  const about = clip(collapse(raw.about), MAX_ABOUT_CHARS);
  if (about === "") return null;
  if (digestForbiddenWordsIn(about).length > 0) return null;

  const words: string[] = [];
  for (const word of raw.words) {
    const text = clip(collapse(word), MAX_WORD_CHARS);
    if (text === "") continue;
    if (digestForbiddenWordsIn(text).length > 0) continue;
    if (words.includes(text)) continue;
    words.push(text);
    if (words.length >= MAX_WORDS) break;
  }

  const sources = raw.sources
    .map((path) => collapse(path))
    .filter((path) => path !== "")
    .slice(0, MAX_SOURCES);

  return { about, words, sources };
}

/**
 * One line, whatever arrived.
 *
 * A newline inside `about` would put a line into the fenced block that does not
 * begin with one of our own labels, which is the shape a forged instruction
 * takes. Collapsing whitespace is cheaper and more complete than hunting for
 * the forgeries.
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  // A hard cut at a sentence end where there is one nearby, so the block does
  // not end mid-clause and read as though something was hidden.
  const cut = text.slice(0, max);
  const stop = cut.lastIndexOf(". ");
  const korean = cut.lastIndexOf("요. ");
  const at = Math.max(stop, korean);
  if (at > max / 2) return cut.slice(0, at + 1).trim();
  return `${cut.trim()}…`;
}
