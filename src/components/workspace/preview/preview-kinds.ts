/**
 * From a path, how to show the file — and how much of it we are willing to move.
 *
 * Pure on purpose. This module is imported by the browser (which decides what
 * kind of viewer to mount) AND by the route handler (which decides what to
 * fetch, what `Content-Type` to answer with, and when to refuse). If the two
 * ever disagree, the viewer mounts an image tag over a PDF, or the route serves
 * a spreadsheet the viewer cannot draw. One table, imported twice.
 *
 * Three rules are baked in here rather than left to the caller:
 *
 *   1. **We never answer with the file's own type for text.** A `.html` file
 *      from someone's repository, served as `text/html` from our own origin,
 *      is their code running on our domain with their session attached. Every
 *      text file goes out as `text/plain`, whatever it is.
 *   2. **A kind with no content type is a kind we never fetch.** An `.xls` or
 *      an `.ods` needs a reader we do not have, so the honest answer is to say
 *      so before moving a single byte, not to stream 4 MB and then draw nothing.
 *   3. **Every kind carries its own ceiling**, because the reasons differ: a
 *      code file that is too big to read is a different judgement from a photo
 *      that is too big to send.
 *
 * Section 3 is the constraint behind all of it: we do not keep source. What a
 * preview moves, it moves once, on demand, and throws away.
 */

export type PreviewKind = "code" | "image" | "pdf" | "spreadsheet" | "unknown";

export type PreviewShape = {
  kind: PreviewKind;
  /**
   * What we answer with. Null means we never fetch this kind at all — the
   * viewer says so and offers GitHub instead.
   */
  contentType: string | null;
  /** The hard ceiling for this kind, in bytes. */
  maxBytes: number;
  /** The word a person reads for this kind of file. */
  word: string;
  /** A short badge for a text file: TypeScript, CSS, 표. Null otherwise. */
  language: string | null;
};

/**
 * The ceilings, and why each one is where it is.
 *
 * `code` is deliberately the same number as the ingest cap in
 * `src/analysis/ingest/limits.ts` (`maxFileBytes`, 512 KB). Anything larger was
 * never parsed, so it is not on the map, so nobody can ask to open it — and
 * picking a smaller number here would mean a file we happily analysed could not
 * be looked at, which reads as a bug rather than as a limit.
 *
 * `image` is 8 MB because a photo straight off a phone is 3-6 MB and a
 * portfolio is full of them; above that it is a print asset, and we would be
 * moving it again on every single open (nothing here may be cached).
 *
 * `pdf` is 20 MB because the browser's own viewer has to receive the whole file
 * before it draws anything, so this ceiling is a ceiling on someone staring at
 * a blank rectangle. A 20 MB PDF is already a long wait.
 *
 * `sheet` is 4 MB, and it is the smallest of the three that we do fetch,
 * because a table is read by a machine before it is read by a person. An
 * `.xlsx` is zipped XML that routinely unpacks to ten times its own size, and a
 * 4 MB `.csv` is several hundred thousand cells; either way the browser parses
 * the whole thing before a single row appears. So this is the same judgement as
 * the PDF ceiling — how long someone waits at a popup that has not drawn yet —
 * on a smaller number, because here the waiting is our work and not the
 * browser's. It is also, by the rule in `lib/preview/store`, the most one
 * spreadsheet in an uploaded folder may take out of that project's storage
 * budget, which is a second reason not to be generous.
 *
 * A kind we cannot draw gets 0: we refuse before fetching, not after.
 */
export const PREVIEW_MAX_BYTES = {
  code: 512 * 1024,
  image: 8 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  sheet: 4 * 1024 * 1024,
  none: 0,
} as const;

/**
 * Text we show as text. The value is the badge in the corner of the viewer, so
 * it is a word a person recognises rather than a file extension.
 *
 * `.csv` used to be here, shown as text, because drawing it as a table needs
 * quote-aware parsing — a comma inside a quoted field is the case every naive
 * `split(",")` gets wrong — and a table with the columns silently shifted is
 * worse than the file itself. That reasoning was right about the risk and wrong
 * about the cost: the parser is forty lines, the cases that break it are
 * enumerable, and they are now tested by name in `spreadsheet.test.ts`. A `.csv`
 * is a table, so it is shown as one.
 */
const CODE_LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  html: "HTML",
  htm: "HTML",
  xml: "XML",
  json: "JSON",
  jsonc: "JSON",
  md: "Markdown",
  mdx: "Markdown",
  txt: "글",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  sql: "SQL",
  graphql: "GraphQL",
  gql: "GraphQL",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  php: "PHP",
  cs: "C#",
  swift: "Swift",
  sh: "셸",
  bash: "셸",
};

/**
 * Pictures, and the type we answer with.
 *
 * `.svg` is the one that needs a sentence. An SVG is a document, not a bitmap:
 * it can carry script and can reach out to other addresses. It is inert inside
 * an `<img>` tag — the browser refuses to run script in an image document —
 * and the viewer in this folder only ever puts it there. The route additionally
 * answers an SVG with a content policy that allows nothing, so even someone who
 * opens the address directly gets a picture and not a page.
 */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/**
 * A table written as text, and the badge for it.
 *
 * The separator is the only difference between the two, and the viewer works it
 * out from the extension. They keep `text/plain` like every other text file
 * (rule 1) — what makes them a table is how the viewer draws them, not how they
 * travel.
 */
const DELIMITED_LANGUAGES: Record<string, string> = {
  csv: "쉼표로 나뉜 글",
  tsv: "탭으로 나뉜 글",
};

/**
 * The one workbook format we can actually open, and the type we answer with.
 *
 * It is the file's own type, which rule 1 forbids for text and permits here for
 * the reason rule 1 exists: the danger in answering `text/html` is that the
 * browser *runs* it on our origin. An OOXML package is a zip a browser will
 * never execute — it downloads it — so naming it honestly costs nothing and
 * buys the fallback we want anyway. Someone whose browser declines to hand it
 * to our viewer gets a file they can open in Excel instead of a page of
 * mojibake, and `nosniff` on the response stops it being read as anything else.
 */
const WORKBOOK_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Tables we recognise and still cannot read.
 *
 * `.xls` and `.xlsb` are binary formats that predate or sidestep OOXML and
 * share no reader with it; `.ods` and `.numbers` are different packages again.
 * Adding any of them is another parser, not another line here.
 *
 * `.xlsm` is the odd one out: it is byte-for-byte the same zip as an `.xlsx`
 * and our reader would open it without noticing. It is refused anyway, because
 * the macro is the whole difference between the two formats, and an endpoint
 * that hands a macro-carrying workbook to a browser `inline` is offering to
 * open it in Excel. The download link does that too — but it says so, and we
 * would not.
 */
const UNREADABLE_SPREADSHEETS = new Set(["xls", "xlsm", "xlsb", "ods", "numbers"]);

/**
 * Never previewed, whatever their extension says.
 *
 * An `.env` file is the one file in a repository whose whole job is to hold
 * secrets. It should not be in a public repository at all, but it sometimes is,
 * and a product that offers to put it on screen is a product that helps leak
 * it. These never reach our analyser either, so in practice this is a second
 * lock on a door that is already shut — which is the right number of locks for
 * this particular door.
 */
function isNeverPreviewed(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.");
}

const UNKNOWN: PreviewShape = {
  kind: "unknown",
  contentType: null,
  maxBytes: PREVIEW_MAX_BYTES.none,
  word: "파일",
  language: null,
};

/** The last segment of a repo path. `""` for a path that ends in a slash. */
export function fileNameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Lowercased extension without the dot. `""` when there is none, or when the dot leads. */
export function extensionOf(path: string): string {
  const base = fileNameOf(path);
  const dot = base.lastIndexOf(".");
  // `dot <= 0` covers both "no dot" and a dotfile like `.gitignore`, whose
  // trailing word is a name and not a type. Same rule the ingest classifier
  // uses, so the two cannot disagree about what a file is.
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * How to show this file.
 *
 * Total: every path gets an answer, and the answer for "we have no idea" is a
 * shape the viewer knows how to render as a sentence.
 */
export function previewShapeFor(path: string): PreviewShape {
  const name = fileNameOf(path);
  if (name === "" || isNeverPreviewed(name)) return UNKNOWN;

  const extension = extensionOf(path);
  if (extension === "") return UNKNOWN;

  const image = IMAGE_TYPES[extension];
  if (image) {
    return {
      kind: "image",
      contentType: image,
      maxBytes: PREVIEW_MAX_BYTES.image,
      word: "그림",
      language: null,
    };
  }

  if (extension === "pdf") {
    return {
      kind: "pdf",
      contentType: "application/pdf",
      maxBytes: PREVIEW_MAX_BYTES.pdf,
      word: "PDF",
      language: null,
    };
  }

  const workbook = WORKBOOK_TYPES[extension];
  if (workbook) {
    return {
      kind: "spreadsheet",
      contentType: workbook,
      maxBytes: PREVIEW_MAX_BYTES.sheet,
      word: "표",
      language: "엑셀",
    };
  }

  const delimited = DELIMITED_LANGUAGES[extension];
  if (delimited) {
    return {
      kind: "spreadsheet",
      // Text, so `text/plain` like all the rest of it. See rule 1.
      contentType: "text/plain; charset=utf-8",
      maxBytes: PREVIEW_MAX_BYTES.sheet,
      word: "표",
      language: delimited,
    };
  }

  if (UNREADABLE_SPREADSHEETS.has(extension)) {
    // A table we can name and cannot open. `spreadsheet` with no content type
    // is that exact pair, and it is what the viewer branches on to say the
    // narrower sentence instead of "글도 그림도 아니라서".
    return {
      kind: "spreadsheet",
      contentType: null,
      maxBytes: PREVIEW_MAX_BYTES.none,
      word: "표",
      language: null,
    };
  }

  const language = CODE_LANGUAGES[extension];
  if (language) {
    return {
      kind: "code",
      // Never the file's own type. See rule 1 at the top of this file.
      contentType: "text/plain; charset=utf-8",
      maxBytes: PREVIEW_MAX_BYTES.code,
      word: "글",
      language,
    };
  }

  return UNKNOWN;
}

/** True when we will fetch this path at all. */
export function canPreview(path: string): boolean {
  return previewShapeFor(path).contentType !== null;
}

/**
 * A repo path we are willing to put in a URL.
 *
 * The real defence against reading somebody else's file is upstream of this:
 * the route looks the path up among the project's own files and refuses
 * anything it does not find, so a crafted path matches nothing. This function
 * is the cheap second check, and it exists because the first one is a database
 * query someone could one day "optimise" away.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.startsWith("/")) return false;
  // A backslash is a separator on the machine this repository was written on,
  // and never one in a repo path (D18: POSIX separators, no archive prefix).
  if (path.includes("\\")) return false;
  if (path.includes("\0")) return false;
  // Control characters would survive into a header value.
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  return true;
}

/**
 * How many lines the code viewer draws at once.
 *
 * A 512 KB source file is roughly fifteen thousand lines, and a line is two
 * elements — a number and the text. Building forty thousand nodes to show
 * someone a file they are going to read a screen of is a second of frozen tab
 * for nothing. Four thousand lines is well past any hand-written file (the
 * demo repo's longest is under three hundred) and draws in a blink.
 */
export const MAX_RENDERED_LINES = 4000;

export type LineWindow = {
  /** 1-indexed, inclusive. */
  from: number;
  to: number;
  /** True when the file is longer than the window. */
  clipped: boolean;
};

/**
 * Which lines to draw.
 *
 * When something on the map was selected — a component, a helper — its own line
 * range is the reason the file is open at all, so the window is centred on it
 * rather than starting at the top. A file whose interesting part is at line
 * 9,000 would otherwise open at line 1 and say "그 뒤로 더 있어요", which is a
 * technically true sentence that answers the wrong question.
 */
export function lineWindow(
  totalLines: number,
  focus: { startLine: number; endLine: number | null } | null,
  max: number = MAX_RENDERED_LINES,
): LineWindow {
  const total = Math.max(0, Math.floor(totalLines));
  if (total === 0) return { from: 1, to: 0, clipped: false };
  if (total <= max) return { from: 1, to: total, clipped: false };

  if (!focus || !Number.isFinite(focus.startLine) || focus.startLine < 1) {
    return { from: 1, to: max, clipped: true };
  }

  const start = Math.min(Math.max(1, Math.floor(focus.startLine)), total);
  const end = Math.min(
    Math.max(start, Math.floor(focus.endLine ?? focus.startLine)),
    total,
  );
  const span = end - start + 1;

  // The focus itself may be longer than the window; then it wins and we start
  // at its first line rather than centring on a midpoint nobody asked about.
  if (span >= max) return { from: start, to: start + max - 1, clipped: true };

  const padding = Math.floor((max - span) / 2);
  let from = start - padding;
  if (from < 1) from = 1;
  let to = from + max - 1;
  if (to > total) {
    to = total;
    from = to - max + 1;
  }
  return { from, to, clipped: true };
}

/**
 * Bytes, in the size a person would say out loud.
 *
 * Shared by the route (which has to explain a refusal in a sentence) and the
 * viewer (which shows what it just moved), so the number in the refusal and the
 * number on screen are formatted by the same code.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "크기를 알 수 없어요";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`;
}

/**
 * The sentences a person reads when we will not, or cannot, show a file.
 *
 * Every one of them says what happened and what to do next (section 8), and
 * none of them blames the user for a limit we chose.
 */
export const PREVIEW_MESSAGES = {
  /**
   * Said only about a file we do not have, which is now a narrow case: it was
   * over its kind's ceiling when the folder was uploaded, or the project had
   * filled its storage. Never said about an uploaded project as a whole — those
   * keep their files, and most of them open.
   */
  upload:
    "이 파일은 따로 보관하지 못했어요. 용량이 크거나 아직 열어볼 수 없는 종류예요. 폴더를 다시 올리시면 같이 보관할게요.",
  /**
   * Said only about the table formats we cannot read — `.xls`, `.xlsb`, `.ods`,
   * `.numbers`, `.xlsm`. It names the two we can, because "표 파일은 열 수
   * 없어요" next to an `.xlsx` that opens fine would read as the product being
   * broken rather than as a limit.
   */
  spreadsheet:
    "이 표 파일은 아직 열어볼 수 없어요. 지금은 엑셀 파일(.xlsx)과 쉼표·탭으로 나뉜 표(.csv, .tsv)만 펼쳐서 보여드릴 수 있어요. 이 파일은 받아서 열어보셔야 해요.",
  unknown:
    "이 파일은 아직 열어볼 수 없어요. 글도 그림도 아니라서 보여드릴 방법을 아직 준비하지 못했어요. GitHub에서 열어보실 수 있어요.",
  notFound:
    "지금은 그 파일을 찾지 못했어요. 지도를 그린 뒤에 지워졌거나 이름이 바뀌었을 수 있어요. 다시 읽기를 하면 지도가 최신이 돼요.",
  failed: "파일을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
  empty: "이 파일은 비어 있어요.",
  /** The promise, said where its cost is visible. */
  trust: "코드는 보관하지 않아요. 열어볼 때만 GitHub에서 받아와서 보여드려요.",
} as const;

/** Why a file was not shown, in a word the viewer can branch on. */
export type PreviewRefusal =
  | "unauthenticated"
  | "not_found"
  | "upload"
  | "unsupported"
  | "too_large"
  | "github";

/** "파일이 12MB라 여기서는 열지 않았어요…" — said with both numbers. */
export function tooLargeMessage(size: number | null, maxBytes: number): string {
  const ceiling = formatBytes(maxBytes);
  if (size === null) {
    return `파일이 커서 여기서는 열지 않았어요. ${ceiling}까지 보여드릴 수 있어요. GitHub에서 열어보실 수 있어요.`;
  }
  return `파일이 ${formatBytes(size)}라 여기서는 열지 않았어요. ${ceiling}까지 보여드릴 수 있어요. GitHub에서 열어보실 수 있어요.`;
}

/**
 * The same file on GitHub, with the lines anchored when we know them.
 *
 * `ref` defaults to `HEAD`, which GitHub resolves to the repository's default
 * branch. That is deliberately not the commit we analysed: this link is an
 * escape hatch for someone who wants to see the file as it is now, and a link
 * to a commit that has since been rewritten or force-pushed is a dead end.
 */
export function githubBlobUrl(
  repo: { owner: string; name: string; ref?: string | null },
  path: string,
  focus?: { startLine: number; endLine: number | null } | null,
): string | null {
  if (!isSafeRepoPath(path)) return null;
  const ref = repo.ref && repo.ref.length > 0 ? repo.ref : "HEAD";
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const base = `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/blob/${encodeURIComponent(ref)}/${encoded}`;
  if (!focus || focus.startLine < 1) return base;
  const end = focus.endLine && focus.endLine > focus.startLine ? `-L${focus.endLine}` : "";
  return `${base}#L${focus.startLine}${end}`;
}
