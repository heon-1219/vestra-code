/**
 * Reading a window of somebody's file, and the rules that keep it a window.
 *
 * This is the only tool in the loop that returns source, so it is the only one
 * that can blow the token budget or break section 3's promise. Four caps, each
 * for its own reason, and each one is a bug that happened somewhere before it
 * was a constant here:
 *
 *   1. **Lines, not files.** A tool that returns a whole file is a bug in a
 *      product whose stated goal is fewer tokens in and out. Eighty lines is
 *      about what fits on a screen, which is also about what a person can hold
 *      in their head while being told what it means.
 *   2. **Characters per line.** One `bundle.js` is a single line of forty
 *      thousand characters. Without this, a single call spends the whole input
 *      budget on a file nobody wrote by hand.
 *   3. **Characters per window.** Eighty lines of dense JSX is not eighty lines
 *      of imports. The line cap alone does not bound the answer.
 *   4. **Bytes per file, before we even slice.** We have to hold the text to
 *      count its lines, and holding is the one thing this product is careful
 *      about. Half a megabyte is roughly fifteen thousand lines of source —
 *      past that, reading more buys nothing a sixty-line window can use.
 *
 * Nothing here writes anything anywhere. The text is held long enough to cut
 * sixty lines out of it and is then gone with the request, which is the same
 * bargain the preview endpoint makes: we keep the map, not the code.
 */

/** What a `SourceReader` could not do. Each maps to one sentence a person reads. */
export type SourceRefusal =
  /** The project's own map does not hold this path. Decided before any I/O. */
  | "not_in_project"
  /** GitHub no longer has it, or the upload never kept it. */
  | "not_found"
  /** An image, a PDF, a compiled blob: bytes with no lines to cite. */
  | "not_text"
  | "too_large"
  /**
   * GitHub answered 403: it is refusing, and it will keep refusing.
   *
   * Its own reason, apart from `unavailable`, because it is the one failure
   * that will not clear within this investigation and the loop can act on
   * knowing that — an unauthenticated read is rated at sixty an hour and a
   * content search looks inside tens of files at once, so this is a failure
   * the product meets rather than a theoretical one. Named after GitHub's own
   * `rate_limited`, which is also what it returns for a file the token may not
   * read; the sentence a person sees does not guess between the two.
   */
  | "rate_limited"
  /** The network, the token, an unreachable host. Worth trying again later. */
  | "unavailable";

/**
 * What the place we just read from says is left of our allowance.
 *
 * GitHub puts `x-ratelimit-remaining` on every answer it gives, including the
 * ones that refuse, and a search that knows the number can size its sweep to
 * it instead of walking into the wall and reporting the wall as an absence
 * (D112). Optional everywhere: a reader that has no such notion — an uploaded
 * project read out of our own database — simply never sets it, and nothing
 * above here has to know which kind it holds.
 */
export type SourceQuota = {
  /** Requests left in the current window. */
  remaining: number;
  /** When the window resets, in seconds since the epoch, where it is known. */
  reset: number | null;
};

export type SourceResult =
  | { ok: true; text: string; quota?: SourceQuota }
  | { ok: false; reason: SourceRefusal; quota?: SourceQuota };

/** One line of one file, found without the caller having opened it. */
export type SourceSearchMatch = SourceMatch & { path: string };

export type SourceSearchResult = {
  /** In the order `paths` was given, then by line. */
  matches: SourceSearchMatch[];
  /**
   * How many of the files asked about were actually looked inside.
   *
   * Never the number asked for. A file the upload never kept, one over the
   * reader's ceiling, one whose bytes are not text: none of those were looked
   * inside, and the difference is what the caller says it could not open
   * rather than what it did not find (D112).
   */
  searched: number;
};

/**
 * Looking inside every file at once, where the source is somewhere that can do
 * that.
 *
 * Only an uploaded project has one: its bytes are rows in our own database, so
 * one query searches the whole project. A GitHub project stores no source and
 * must keep storing none (D77), so it has no `searchAll` and its search stays
 * a sweep of fetches — which is precisely why that sweep has to size itself to
 * the quota it has left.
 *
 * `paths` is both the permission and the ranking: the map is the authority for
 * what may be read, and the order it is given in is the order matches come
 * back in.
 */
export type SourceSearch = (
  needle: string,
  options: {
    paths: readonly string[];
    /** Most matched lines overall. */
    limit: number;
    /** Most matched lines from any one file. */
    perFile: number;
    prefix?: string;
  },
) => Promise<SourceSearchResult>;

/**
 * How this project's source is reached, decided by the caller and never here.
 *
 * A GitHub project fetches on demand and keeps nothing; an uploaded project
 * reads the bytes it kept in `project_files`. That distinction already exists
 * in the file endpoint and this module refuses to invent a third version of it
 * — the loop takes whichever reader it is handed and cannot tell them apart,
 * which is also what lets every test here run without a network or a database.
 *
 * Null is a legitimate value at the call site above: a project whose source we
 * cannot reach still has a graph, and the loop degrades to `inferred`-only
 * findings rather than pretending it read something.
 */
export type SourceReader = {
  (path: string, signal?: AbortSignal): Promise<SourceResult>;
  /**
   * Present only where every file can be looked inside in one go.
   *
   * A property on the reader rather than a second thing to thread through the
   * loop, because it is not a second source: it is the same bytes, reached the
   * way that source can reach all of them at once. Everything above still takes
   * one `SourceReader`, every fake in the tests is still a plain function, and
   * a caller that has one and does not use it is only slower.
   */
  searchAll?: SourceSearch;
};

export const SOURCE_MAX_BYTES = 512 * 1024;
export const MAX_LINE_CHARS = 200;
export const DEFAULT_WINDOW_LINES = 60;
export const MAX_WINDOW_LINES = 80;
export const MAX_WINDOW_CHARS = 5_000;

/**
 * The ceiling for "just give me the whole file", and why it is only a little
 * bigger than a window.
 *
 * Most modules in a small project are under a hundred and sixty lines, and
 * reading one of them in two eighty-line steps costs a step and a second round
 * trip to fetch the same file twice. That is the saving. What it must not
 * become is a tool that returns a megabyte — so the char budget is 6,000
 * against the window's 5,000, which is at most one-fifth more than a single
 * read and nowhere near a fifth of a budget.
 *
 * A file over this is not refused. It comes back as its first lines with the
 * usual header saying where to continue, which is what `read_source` would
 * have given anyway.
 */
export const WHOLE_FILE_LINES = 160;
export const WHOLE_FILE_CHARS = 6_000;

/**
 * How big one window may get, so a caller can ask for a longer, still-bounded
 * one without a second copy of the slicing.
 *
 * Optional at the call site and defaulted to the window's own ceilings, which
 * is what makes this additive: `windowOf(path, text, from)` means exactly what
 * it meant before this existed.
 */
export type WindowLimits = { maxLines: number; maxChars: number };

const WINDOW_LIMITS: WindowLimits = {
  maxLines: MAX_WINDOW_LINES,
  maxChars: MAX_WINDOW_CHARS,
};

export type SourceLine = { number: number; text: string };

export type SourceWindow = {
  path: string;
  /** Both inclusive, and both are what was ACTUALLY returned after clamping. */
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: SourceLine[];
  /** True when at least one line was cut at `MAX_LINE_CHARS`. */
  clipped: boolean;
  /** True when the window stopped early at `MAX_WINDOW_CHARS`. */
  shortened: boolean;
};

/**
 * Count lines the way an editor does.
 *
 * `"a\nb\n".split("\n")` is three elements and the last one is empty. A person
 * looking at that file sees two lines, and telling them their file has a line 3
 * they cannot see is the kind of small wrongness that makes every other number
 * in the answer suspect. Only ONE trailing empty is dropped — a file that
 * genuinely ends in two blank lines keeps the first of them.
 */
export function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A window, clamped into the file and reported as what it actually is.
 *
 * `from` past the end is clamped rather than refused, because "line 400 of a
 * 120-line file" is what a model asks when it has the wrong file, and the
 * honest reply is the end of the file with its real numbers on it — from which
 * the model can see its mistake. The header always states the range returned,
 * so a clamp can never become a silent lie.
 */
export function windowOf(
  path: string,
  text: string,
  from: number,
  want: number = DEFAULT_WINDOW_LINES,
  limits: WindowLimits = WINDOW_LIMITS,
): SourceWindow {
  const all = linesOf(text);
  const totalLines = all.length;

  const count = clamp(Math.trunc(want), 1, limits.maxLines);
  const startLine = clamp(Math.trunc(from), 1, totalLines);

  const lines: SourceLine[] = [];
  let chars = 0;
  let clipped = false;
  let shortened = false;

  for (let n = startLine; n < startLine + count && n <= totalLines; n += 1) {
    const raw = all[n - 1];
    const cut = raw.length > MAX_LINE_CHARS;
    const body = cut ? raw.slice(0, MAX_LINE_CHARS) + " …(줄임)" : raw;
    if (chars + body.length > limits.maxChars && lines.length > 0) {
      shortened = true;
      break;
    }
    if (cut) clipped = true;
    chars += body.length;
    lines.push({ number: n, text: body });
  }

  return {
    path,
    startLine,
    // An empty file has no lines at all, and claiming it ends at line 1 would
    // hand out a citable range for something there is nothing in.
    endLine: lines.length === 0 ? startLine : lines[lines.length - 1].number,
    totalLines,
    lines,
    clipped,
    shortened,
  };
}

/**
 * The window as the model reads it.
 *
 * The line number goes on every line rather than only in the header, because
 * the model has to produce one of these numbers back as a citation and counting
 * down from a header is exactly where an off-by-four comes from. The header
 * states the whole file's length too, so "there is more below" is a fact rather
 * than something to infer from the window ending.
 */
export function renderWindow(window: SourceWindow): string {
  const head = `${window.path} ${window.startLine}-${window.endLine}줄 (전체 ${window.totalLines}줄)`;
  if (window.lines.length === 0) return `${head}\n(내용이 없어요)`;

  const body = window.lines
    .map((line) => `${String(line.number).padStart(5, " ")}| ${line.text}`)
    .join("\n");

  const notes: string[] = [];
  if (window.clipped) notes.push("긴 줄은 잘라서 보여드렸어요.");
  if (window.shortened) notes.push("분량이 커서 여기까지만 읽었어요.");
  if (window.endLine < window.totalLines) {
    notes.push(`${window.endLine + 1}줄부터는 다시 요청하면 읽을 수 있어요.`);
  }

  return notes.length === 0
    ? `${head}\n${body}`
    : `${head}\n${body}\n(${notes.join(" ")})`;
}

/**
 * How much of a matching line comes back from a search.
 *
 * Shorter than `MAX_LINE_CHARS`, and deliberately: a search returns ten of
 * these where a read returns one, so the per-line cost is what decides whether
 * the whole result stays near a window's worth of tokens. A hundred and twenty
 * characters is a long line of Python with its indentation, which is what a
 * person needs to see to know whether this is the line they wanted.
 */
export const MATCH_LINE_CHARS = 120;

export type SourceMatch = { line: number; text: string };

/**
 * Where a word appears inside a file, by line.
 *
 * A plain case-insensitive substring, never a regular expression. A pattern
 * written by a model is a pattern nobody reviewed, running over the user's own
 * files: the cheap version of that mistake is a catastrophic backtrack that
 * spends the whole wall-clock budget on one file, and the expensive version is
 * a search whose meaning nobody can explain to the person watching. Substring
 * is what "결제가 어디서 이뤄져요" actually needs.
 *
 * `limit` is per file rather than overall, so one generated file with four
 * hundred hits cannot crowd out the nine other files that matched once each.
 */
export function matchesIn(
  text: string,
  needle: string,
  limit: number,
): SourceMatch[] {
  const wanted = needle.toLowerCase();
  if (wanted === "") return [];

  const out: SourceMatch[] = [];
  const all = linesOf(text);
  for (let n = 0; n < all.length && out.length < limit; n += 1) {
    const raw = all[n];
    if (!raw.toLowerCase().includes(wanted)) continue;
    out.push({ line: n + 1, text: matchText(raw) });
  }
  return out;
}

/**
 * One matched line as it is shown, wherever the match was found.
 *
 * Its own function because a match can now be found in two places — here, over
 * text we fetched, and in the database over an uploaded project's stored bytes
 * — and a line that looked different depending on which found it would be two
 * answers to one question. The finding is done twice because the two sources
 * are genuinely different; the presentation is done once.
 */
export function matchText(raw: string): string {
  const body = raw.trim();
  return body.length > MATCH_LINE_CHARS
    ? `${body.slice(0, MATCH_LINE_CHARS)} …(줄임)`
    : body;
}

/**
 * Whether it is worth spending a fetch on this path at all.
 *
 * A guess from the extension, and only ever used to SKIP work — `asText` is
 * still what decides whether bytes are text, so a `.dat` file full of source
 * is read correctly the moment anyone asks for it by name. This exists because
 * a content search fetches tens of files speculatively, and an uploaded
 * project keeps images and PDFs beside its code (D77): without it, a search
 * for 결제 spends a third of its budget downloading photographs.
 */
const NOT_TEXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svgz",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "mkv",
  "exe", "dll", "so", "dylib", "bin", "wasm", "class", "pyc", "pyo",
  "xlsx", "xls", "docx", "doc", "pptx", "ppt", "psd", "sketch", "fig",
  "db", "sqlite", "sqlite3", "lock",
]);

/**
 * Text, and enormous, and never the answer.
 *
 * A lock file is the largest text file in most projects and nothing a person
 * would ask about is written in one. Most are caught by the `.lock` extension
 * above; these three are not, and `package-lock.json` in particular sorts near
 * the front of a root listing, so without this a search would spend a quarter
 * of its byte budget on it before reaching any source.
 */
const GENERATED = new Set(["package-lock.json", "pnpm-lock.yaml", "go.sum"]);

export function probablyText(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (GENERATED.has(base)) return false;
  const dot = base.lastIndexOf(".");
  // No extension at all is a `Dockerfile` or a `Makefile` far more often than
  // it is a binary, so it is worth the look.
  if (dot <= 0) return true;
  return !NOT_TEXT.has(base.slice(dot + 1));
}

/**
 * `./src/x.ts`, `/src/x.ts`, `src\x.ts` and `src/x.ts` are one file to a person
 * and one of them is how the map spells it (D18: repo-relative, POSIX
 * separators, no leading slash).
 *
 * Normalising both the path a tool is asked to read and the path a citation
 * names matters for more than convenience: a citation that fails to match its
 * own ledger entry over a leading `./` would be refused as unread, and the
 * answer would lose a finding that was in fact checked.
 */
export function normalisePath(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  while (path.startsWith("/")) path = path.slice(1);
  return path;
}

/** One sentence per refusal, in the words the rest of the product uses. */
export const SOURCE_REFUSAL_WORDS: Record<SourceRefusal, string> = {
  not_in_project: "이 프로젝트의 지도에 없는 파일이에요. 경로를 다시 확인해 주세요.",
  not_found: "지금은 그 파일을 찾지 못했어요. 지도를 그린 뒤에 지워졌거나 이름이 바뀌었을 수 있어요.",
  not_text: "글자로 된 파일이 아니라서 줄 단위로 읽을 수 없어요.",
  too_large: "파일이 너무 커서 여기서는 열지 않았어요.",
  // Not "요청이 너무 많았어요": GitHub answers 403 both for a rate limit and
  // for a file this token may not read, and it does not say which. The
  // sentence carries what we know — it refused, it will keep refusing, try
  // later — and does not name a cause we would be guessing at.
  rate_limited:
    "깃허브가 지금은 이 파일을 내주지 않아요. 조금 뒤에 다시 물어봐 주세요.",
  unavailable: "지금은 이 파일을 읽어올 수 없어요.",
};

/**
 * Text, or the reason it is not.
 *
 * A NUL byte is the cheap, reliable "this is not source" test: no text file in
 * a repository contains one, and every compiled artefact does. It matters
 * because an uploaded project keeps images and PDFs beside its code (D77), and
 * decoding a PNG as UTF-8 produces thousands of replacement characters that
 * look exactly like a file the model should keep reading.
 */
export function asText(bytes: Uint8Array): SourceResult {
  if (bytes.byteLength > SOURCE_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.includes("\0")) return { ok: false, reason: "not_text" };
  return { ok: true, text };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), Math.max(low, high));
}
