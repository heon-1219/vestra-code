/**
 * What we will and will not take on, and what the user is told when we stop.
 *
 * The cap is measured on SOURCE, never on repository size. The founder's own
 * portfolio is roughly 110 MB as an archive for about 200 KB of actual text —
 * a byte cap on the repository would reject the one repo that motivated static
 * site support (D6) at the front door, while a 40 MB repo of small TypeScript
 * files is exactly what we want to analyse.
 */

export const LIMITS = {
  /** Source files handed to an analyzer. */
  maxSourceFiles: 1500,
  /** Total text we will parse. */
  maxTextBytes: 12 * 1024 * 1024,
  /**
   * A single text file. Above this it is a bundle, a generated client, or a
   * vendored library — never something a person edits, and parsing it costs
   * more than everything else combined.
   */
  maxFileBytes: 512 * 1024,
  /** Binary assets we record as nodes but never read. */
  maxAssets: 3000,
  /** A guard against an archive that expands without bound. */
  maxExtractedBytes: 1024 * 1024 * 1024,
} as const;

export type IngestLimit = "files" | "text_bytes" | "extracted_bytes";

/**
 * Plain language, and specific about which limit was reached — "too large" on
 * its own leaves someone with nothing to act on.
 */
export const LIMIT_MESSAGES: Record<IngestLimit, string> = {
  files: `이 저장소는 지금 한 번에 읽기에는 파일이 너무 많아요. 파일 ${LIMITS.maxSourceFiles.toLocaleString("ko-KR")}개까지 읽고 멈췄고, 거기까지로 지도를 그렸어요. 지도에 빠진 부분이 있을 수 있어요.`,
  text_bytes:
    "이 저장소는 지금 한 번에 읽기에는 코드 양이 많아요. 읽을 수 있는 만큼 읽고 멈췄고, 거기까지로 지도를 그렸어요. 지도에 빠진 부분이 있을 수 있어요.",
  extracted_bytes:
    "저장소를 받는 중에 예상보다 훨씬 커져서 멈췄어요. 다른 저장소로 시도해 보시거나, 잠시 후 다시 시도해 주세요.",
};

/** Directories whose contents are never source the user wrote. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "bower_components",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
]);

/** Extensions we read as text and may hand to an analyzer. */
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "html", "htm", "css", "scss", "sass", "less",
  "json", "md", "mdx", "txt", "yml", "yaml", "toml",
  "py", "rb", "go", "rs", "java", "kt", "php", "cs", "swift",
  "sql", "graphql", "gql", "vue", "svelte", "astro",
]);

/**
 * Binary we record but never read. An asset still becomes a node — "nothing on
 * your site uses this photo" is one of only a few honest things we can say
 * about a static site, and it depends on the photo existing in the graph.
 */
const ASSET_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp",
  "mp4", "webm", "mov", "avi", "mp3", "wav", "ogg",
  "woff", "woff2", "ttf", "otf", "eot",
  "pdf", "zip", "gz", "tar", "rar", "7z",
  /*
   * Spreadsheets, on the same footing as the PDF above: recorded, never
   * parsed, and openable.
   *
   * They were `skip`, which is a harsher answer than it looks. A skipped file
   * is not a node, so it is not on the map, so the preview endpoint's "is this
   * a file of this project" check answers no — and a viewer for it can never be
   * reached however good it is. On an uploaded folder it is worse: the browser
   * runs this same function before sending anything, so the file never left the
   * user's machine at all, and their folder appeared on screen with a hole in
   * it where their data was.
   *
   * `csv` and `tsv` are here rather than in TEXT_EXTENSIONS on purpose. They
   * are text, but they are not source: handing one to the analyzer means
   * parsing a data file looking for imports, and a 40 MB export would be the
   * single most expensive file in a repository for nothing.
   *
   * The formats we cannot draw — `xls`, `xlsb`, `ods`, `numbers`, `xlsm` — are
   * here too, and that is deliberate. They become nodes and the viewer refuses
   * them by name with a sentence about what it is. A file the map silently
   * pretends is not in your folder is worse than one that says it cannot open
   * yet.
   */
  "xlsx", "csv", "tsv",
  "xls", "xlsb", "ods", "numbers", "xlsm",
]);

export type FileClass = "text" | "asset" | "skip";

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Three outcomes, not two.
 *
 * An earlier design had keep-or-skip, which would have dropped binaries
 * entirely — and then "nothing uses this photo" could not be built without
 * re-running ingest on every existing project.
 */
export function classifyFile(repoPath: string, size: number): FileClass {
  const segments = repoPath.split("/");
  const base = segments[segments.length - 1];

  for (const segment of segments.slice(0, -1)) {
    if (SKIP_DIRS.has(segment)) return "skip";
  }
  if (SKIP_FILES.has(base)) return "skip";

  // Generated or vendored bundles: never authored, always expensive.
  if (/\.(min|bundle|chunk)\.(js|css)$/i.test(base)) return "skip";
  if (/\.d\.ts$/i.test(base)) return "skip";
  if (/\.(map|log)$/i.test(base)) return "skip";

  const extension = extensionOf(repoPath);
  if (ASSET_EXTENSIONS.has(extension)) return "asset";
  if (!TEXT_EXTENSIONS.has(extension)) return "skip";
  if (size > LIMITS.maxFileBytes) return "skip";

  return "text";
}
