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
  /** The network, the token, the rate limit. Worth trying again later. */
  | "unavailable";

export type SourceResult =
  | { ok: true; text: string }
  | { ok: false; reason: SourceRefusal };

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
export type SourceReader = (
  path: string,
  signal?: AbortSignal,
) => Promise<SourceResult>;

export const SOURCE_MAX_BYTES = 512 * 1024;
export const MAX_LINE_CHARS = 200;
export const DEFAULT_WINDOW_LINES = 60;
export const MAX_WINDOW_LINES = 80;
export const MAX_WINDOW_CHARS = 5_000;

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
): SourceWindow {
  const all = linesOf(text);
  const totalLines = all.length;

  const count = clamp(Math.trunc(want), 1, MAX_WINDOW_LINES);
  const startLine = clamp(Math.trunc(from), 1, totalLines);

  const lines: SourceLine[] = [];
  let chars = 0;
  let clipped = false;
  let shortened = false;

  for (let n = startLine; n < startLine + count && n <= totalLines; n += 1) {
    const raw = all[n - 1];
    const cut = raw.length > MAX_LINE_CHARS;
    const body = cut ? raw.slice(0, MAX_LINE_CHARS) + " …(줄임)" : raw;
    if (chars + body.length > MAX_WINDOW_CHARS && lines.length > 0) {
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
