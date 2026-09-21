import { normalizePath } from "./ids";
import { isSetAsideReason, type SetAsideReason } from "./set-aside-words";
import type { AnalyzedEdge, AnalyzedNode, FileLoad } from "./types";

/**
 * Files the model is not asked about, and why.
 *
 * Every file still becomes a node, still gets parsed, and keeps every
 * connection the parser found. **A map that quietly omits is a map that lies**,
 * so nothing here removes anything from the map. What is set aside is only the
 * expensive reading: the model's name and sentence for the file (Pass 2), the
 * model's reading of the calls inside it (the Python analyzer's model half),
 * and the purpose sentence for anything only it reaches for (Pass 3). And it is
 * said: the run ends with a sentence counting these files by reason, apart from
 * any budget sentence, because "we chose not to" and "we ran out" are different
 * facts and a person deserves to know which one happened.
 *
 * ## Why these three
 *
 * Measured on the four real projects in the database, not assumed (D160):
 *
 *   - **tool_settings.** `Kim-and-Chang-` paid to have `.obsidian/appearance.json`
 *     named 화면 꾸미기 설정 and `.claude/settings.local.json` named 인공지능
 *     도우미 설정 — five such files there, one in `vestra-code`.
 *   - **generated.** `vestra-code` has fourteen files drizzle-kit and a skills
 *     tool wrote — six migrations, seven snapshots, one lock file — and Pass 2
 *     named every one (첫 번째 저장소 사진, 두 번째 저장소 사진 …).
 *   - **tests.** 113 of `vestra-code`'s 325 files and 19 of `kakauto`'s 44. On
 *     the one project where they had been named, **76 of 76 test names say
 *     only that the file is a test** (…검사, …시험, …확인), nothing from source
 *     ever points into one (0 links), no feature territory holds one (98 of 98
 *     members are source), and of the 523 piece names Pass 2 hands out, test
 *     files drew 0 and their fixtures 22. They are
 *     parsed exactly as before — every import a test makes is still on the map.
 *
 * ## How a rule earns its place (D168)
 *
 * Every rule is a convention **the tool that owns the file** uses to find it —
 * a folder an editor keeps its state in, a name a generator stamps on its own
 * output, a name a test runner collects — and never an ordinary word. The first
 * version guessed from words (`fixtures/`, `spec/`, `src/tests/`, `ab_test.py`,
 * any `.sql` beside a drizzle journal) and a verifier found real-looking source
 * each one would have set aside: a sports app's `components/fixtures/`, an exam
 * app's `src/tests/`, an A/B-testing module, an OpenAPI `spec/`, a seed script.
 * So a word is never enough on its own:
 *
 *   - **A folder called `tests`, `spec`, `e2e`… counts only when the test
 *     runner would find a test in it** — a file whose own name is a test's
 *     (`*.test.ts`, `test_*.py`, `*_spec.rb`). Two conventions agreeing, not a
 *     folder name.
 *   - **Python's `test_*.py` / `*_test.py` outside such a folder counts only
 *     when the file defines what pytest collects** — a `test_…` function or a
 *     `Test…` class, spelled the way tests are written (D176) — because
 *     `ab_test.py`, `speed_test.py` and `train_test.py` are ordinary names
 *     for ordinary modules.
 *   - **drizzle-kit's output is matched by drizzle-kit's own file names**
 *     (`0000_name.sql`, `meta/0000_snapshot.json`, `meta/_journal.json`),
 *     not by extension.
 *
 * ## What is never set aside
 *
 * Two rules sit above every other, and they need the graph, which is why the
 * answer for a whole project comes from `resolveSetAside` rather than from a
 * path alone:
 *
 *   - **A file that serves an address** — a page, an API route, a Streamlit
 *     page — whatever folder it is in. It is somewhere a person can go, and
 *     where 흐름 따라가기 starts.
 *   - **A file something we read imports**, or loads while it runs
 *     (`next/dynamic`, `React.lazy`, `import()`, D176). If `dashboard.py`
 *     imports it, it is part of the program a person asks about, whatever it
 *     is called. On the
 *     real projects this protects nothing that was set aside (0 links from
 *     source into a test or its data), which is exactly why it is safe to add:
 *     it only ever fires on a project that is not shaped like the ones we have.
 *
 * `set-aside.test.ts` fails if any real source path from the four projects is
 * ever matched, and pins each of the verifier's look-alikes as read.
 *
 * ## What "framework-aware" means here
 *
 * The project's detected `kind` (nextjs, python, …) is not an input, and it is
 * said here because the first version took it as a parameter and never read
 * it. What decides a file is not which framework the project uses but **which
 * tool wrote the file**, and the file list says that more precisely than the
 * kind does — drizzle-kit is there when its journal is, Prisma when its schema
 * is, pytest when a folder of tests holds `test_*.py` — while a Next.js or
 * Streamlit page is protected because its analyzer has already found the
 * address it serves. Dropping the parameter changed 0 of the 475 real paths'
 * answers and 0 of the 431 tags on production rows.
 */

export {
  countSetAside,
  describeSetAside,
  SET_ASIDE_REASONS,
  type SetAsideCount,
  type SetAsideReason,
} from "./set-aside-words";

/**
 * Folders an editor or an AI assistant keeps its own state in.
 *
 * They are the tool's, not the project's: which panes were open, which theme
 * the notes app uses, which commands the assistant may run without asking.
 * `.vscode` and `.idea` never reach this far — ingest already refuses them —
 * and are listed anyway, so this set is the whole answer to "is this a tool's
 * folder" rather than half of it.
 *
 * `.github` is deliberately absent. A workflow is how a site gets deployed,
 * which is a question a person does ask, and none of the four real projects
 * has one — so there is no measured saving to weigh against that.
 * `.streamlit` is absent for the same kind of reason: its `config.toml` is the
 * app's own theme, part of what the person sees.
 */
const TOOL_DIRS = new Set([
  ".obsidian",
  ".claude",
  ".cursor",
  ".agents",
  ".windsurf",
  ".continue",
  ".zed",
  ".fleet",
  ".vscode",
  ".idea",
  ".devcontainer",
  ".husky",
]);

/**
 * Folders a program fills and nobody edits: caches ingest does not already
 * refuse, and snapshot folders test runners write. `.pytest_cache` is the
 * measured one — `kakauto` carries the README pytest writes into it.
 */
const GENERATED_DIRS = new Set([
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".ipynb_checkpoints",
  "__snapshots__",
]);

/**
 * Lock files ingest does not already refuse.
 *
 * `ingest/limits.ts` drops the common ones before they become nodes at all.
 * These are the ones it misses, and `skills-lock.json` is the measured case:
 * `vestra-code` has it and Pass 2 named it 부가 기능 고정 장부.
 */
const LOCK_FILES = new Set([
  "skills-lock.json",
  "npm-shrinkwrap.json",
  "deno.lock",
  "uv.lock",
  "Pipfile.lock",
  "pdm.lock",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
]);

/**
 * A generator marking its own output in the name (`api.generated.ts`, the
 * GraphQL codegen convention), or a snapshot a test runner wrote. Dot-separated
 * only: `user-generated.ts` is somebody's module about user-generated content.
 */
const GENERATED_NAME = /\.generated\.[a-z]+$|\.snap$/i;

/**
 * Folders that hold tests and nothing else, by a test runner's own spelling.
 * The double underscore is the tell: nobody names a folder of product code
 * `__fixtures__`.
 */
const TEST_DIRS = new Set(["__tests__", "__fixtures__", "__mocks__"]);

/**
 * Folder names that are a test folder only when a test runner agrees.
 *
 * Matched at the top of the project or directly under `src/`, where runners
 * look, and even there only when the folder holds a file named like a test —
 * see `setAsideContext`. `fixtures` and `testdata` are here rather than
 * matched anywhere because a sports app has fixtures and a quiz app has tests.
 */
const TEST_DIR_WORDS = new Set(["test", "tests", "spec", "e2e", "cypress", "fixtures", "testdata"]);

/**
 * A file its test runner collects by name alone, in a language where that name
 * is the whole convention: Vitest, Jest, Playwright and Cypress; pytest's own
 * `conftest.py`; Go's toolchain; RSpec.
 */
const TEST_FILE_BY_NAME =
  /\.(test|spec|cy)\.[cm]?[jt]sx?$|(^|\/)conftest\.py$|_test\.go$|_spec\.rb$/;

/**
 * pytest's file convention, which is also an ordinary way to name a module
 * (`ab_test.py`, `speed_test.py`). Enough to make a folder a test folder;
 * never enough on its own to set a file aside — see `FileFacts.definesTests`.
 */
const PYTEST_FILE = /(^|\/)test_[^/]*\.py$|_test\.py$/;

/**
 * What a whole project tells us about where its tools write.
 *
 * Built once per run from the full path list, because the rule for a folder
 * depends on what else is in the project: a `drizzle/` with no
 * `meta/_journal.json` beside it is somebody's own code, and a `tests/` with
 * no test in it is somebody's own folder.
 */
export type SetAsideContext = {
  /** Folders drizzle-kit writes into: the parent of every `meta/_journal.json`. */
  drizzleOut: readonly string[];
  /** Whether the project has a Prisma schema, so `prisma/migrations` is Prisma's. */
  prisma: boolean;
  /**
   * Test folders a test runner would find tests in, each with its trailing
   * slash (`tests/`, `src/e2e/`). Only these count as test folders.
   */
  testFolders: readonly string[];
};

/** The folder a runner would treat as a test folder, if this path is in one. */
function testFolderOf(segments: readonly string[]): string | null {
  const folders = segments.slice(0, -1);
  const depth = folders[0] === "src" ? 1 : 0;
  const word = folders[depth];
  if (word === undefined || !TEST_DIR_WORDS.has(word)) return null;
  return `${folders.slice(0, depth + 1).join("/")}/`;
}

export function setAsideContext(paths: readonly string[]): SetAsideContext {
  const normalized = paths.map(normalizePath);
  const drizzleOut = normalized
    .filter((path) => path === "meta/_journal.json" || path.endsWith("/meta/_journal.json"))
    .map((path) => path.slice(0, path.length - "meta/_journal.json".length));
  const prisma = normalized.some(
    (path) => path === "prisma/schema.prisma" || path.endsWith("/prisma/schema.prisma"),
  );
  const testFolders = new Set<string>();
  for (const path of normalized) {
    if (!TEST_FILE_BY_NAME.test(path) && !PYTEST_FILE.test(path)) continue;
    const folder = testFolderOf(path.split("/"));
    if (folder) testFolders.add(folder);
  }
  return { drizzleOut, prisma, testFolders: [...testFolders].sort() };
}

/**
 * What the graph knows about one file that its path cannot say.
 *
 * Absent means unknown, and unknown always falls on the side of reading: a
 * path-only question can set aside less than the graph would, never more.
 */
export type FileFacts = {
  /** It serves an address — a page, an API route, a Streamlit page. */
  servesAddress?: boolean;
  /** It defines a test the way tests are spelled: a `test_…` function or a `Test…` class (D176). */
  definesTests?: boolean;
};

/**
 * Why this file is not read by a model, or null when it is.
 *
 * Null is the default and the common answer. Everything below is a positive
 * match on a tool's, a generator's or a test runner's own convention. Tool
 * folders are checked first: a test file inside `.claude/` is the tool's.
 *
 * This is the per-file half. Whether something we read imports the file is a
 * question about the whole project, and `resolveSetAside` asks it on top.
 */
export function setAsideReason(
  rawPath: string,
  context: SetAsideContext,
  facts: FileFacts = {},
): SetAsideReason | null {
  if (facts.servesAddress === true) return null;

  const path = normalizePath(rawPath);
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  const folders = segments.slice(0, -1);

  if (folders.some((folder) => TOOL_DIRS.has(folder))) return "tool_settings";

  if (folders.some((folder) => GENERATED_DIRS.has(folder))) return "generated";
  if (LOCK_FILES.has(base)) return "generated";
  if (GENERATED_NAME.test(base)) return "generated";
  // Next.js writes this and says so in its first line. Ingest already drops
  // every `.d.ts`; stated here so the rule lives where the question is asked.
  if (base === "next-env.d.ts") return "generated";
  // drizzle-kit's output folder, by drizzle-kit's own names: the numbered SQL
  // it generates from the schema, directly in the folder, and the journal and
  // numbered snapshots under `meta/`. A seed script or a hand-written query in
  // the same folder is the person's and is read.
  for (const out of context.drizzleOut) {
    if (!path.startsWith(out)) continue;
    const rest = path.slice(out.length);
    if (/^\d{4}_[^/]+\.sql$/.test(rest)) return "generated";
    if (rest === "meta/_journal.json" || /^meta\/\d{4}_snapshot\.json$/.test(rest)) {
      return "generated";
    }
  }
  // `prisma migrate dev` writes one folder per migration. `schema.prisma` is
  // the person's own file and does not live under `migrations/`.
  if (context.prisma && /(^|\/)prisma\/migrations\//.test(path)) return "generated";

  if (folders.some((folder) => TEST_DIRS.has(folder))) return "tests";
  if (context.testFolders.some((folder) => path.startsWith(folder))) return "tests";
  if (TEST_FILE_BY_NAME.test(path)) return "tests";
  if (PYTEST_FILE.test(path) && facts.definesTests === true) return "tests";

  return null;
}

/** The key the reason is written under on a file node's metadata. */
export const SET_ASIDE_KEY = "setAside";

/** The reason a node carries, if any. Tolerant of whatever a row holds. */
export function setAsideOf(node: { metadata?: Record<string, unknown> }): SetAsideReason | null {
  const value = node.metadata?.[SET_ASIDE_KEY];
  return isSetAsideReason(value) ? value : null;
}

/*
 * pytest's collection rule for names, as tests are actually written: a
 * function `test`, `test_total` or `testTotal`, a class `Test`, `TestOrders`
 * or `Test_orders`.
 *
 * Narrower than pytest's own prefix match on purpose (D176). pytest would
 * collect `testing_split` and `Testimonial` too, and a verifier's
 * `train_test.py` — an entry script with `train()` and `testing_split()` —
 * was set aside as a test on that rule alone. Nobody writes a test called
 * `testing_…`; plenty of people write a helper called that. The cost of the
 * narrower rule is only ever a test file that gets read.
 */
const PYTEST_FUNCTION = /^test(?:$|_|[A-Z0-9])/;
const PYTEST_CLASS = /^Test(?:$|_|[A-Z0-9])/;

function collectedByPytest(node: AnalyzedNode): boolean {
  const name = node.ref.name ?? "";
  return node.kind === "class" ? PYTEST_CLASS.test(name) : PYTEST_FUNCTION.test(name);
}

export type { FileLoad };

/**
 * Which files of a whole graph the model is not asked about, and why.
 *
 * The one answer every model pass uses. The Python analyzer asks it of its own
 * graph just before its model half, and the pipeline asks it again of the
 * finished graph to tag the rows — and the two answers are the same by
 * construction, because this reads only what the parser half produced:
 * files, the addresses they serve, the names they define, and `imports`. The
 * model half adds `calls` and roles, neither of which is read here.
 *
 * On top of `setAsideReason`, one project-wide rule: **a file that something we
 * read imports is read.** Worked outwards from every file that is read, so a
 * helper imported by a helper imported by a page is read too, and a fixture
 * imported only by tests stays set aside. "Imports" includes loading one
 * while running (`loads`, D176), which the TypeScript analyzer reports beside
 * the graph rather than in it.
 */
export function resolveSetAside(
  graph: {
    nodes: readonly AnalyzedNode[];
    edges: readonly AnalyzedEdge[];
    loads?: readonly FileLoad[];
  },
  context: SetAsideContext,
): Map<string, SetAsideReason> {
  const files: string[] = [];
  const serves = new Set<string>();
  const definesTests = new Set<string>();
  for (const node of graph.nodes) {
    const path = normalizePath(node.ref.filePath);
    if (node.ref.type === "file") files.push(path);
    else if (node.ref.type === "route" || node.ref.type === "api_endpoint") serves.add(path);
    else if (node.ref.type === "symbol" && collectedByPytest(node)) definesTests.add(path);
  }

  const candidates = new Map<string, SetAsideReason>();
  for (const path of files) {
    const reason = setAsideReason(path, context, {
      servesAddress: serves.has(path),
      definesTests: definesTests.has(path),
    });
    if (reason) candidates.set(path, reason);
  }
  if (candidates.size === 0) return candidates;

  const importsOf = new Map<string, string[]>();
  const link = (rawFrom: string, rawTo: string) => {
    const from = normalizePath(rawFrom);
    const to = normalizePath(rawTo);
    if (from === to) return;
    const list = importsOf.get(from);
    if (list) list.push(to);
    else importsOf.set(from, [to]);
  };
  for (const edge of graph.edges) {
    if (edge.type === "imports") link(edge.source.filePath, edge.target.filePath);
  }
  for (const load of graph.loads ?? []) link(load.from, load.to);

  const queue = files.filter((path) => !candidates.has(path));
  while (queue.length > 0) {
    const reader = queue.pop() as string;
    for (const imported of importsOf.get(reader) ?? []) {
      if (!candidates.delete(imported)) continue;
      queue.push(imported);
    }
  }
  return candidates;
}

/**
 * Tag every file node the model should not read, in place.
 *
 * On the node rather than in a side list, for the reason the Python analyzer
 * writes `llmExamined` there: the pipeline persists what `analyze` returned, so
 * the reason survives into the database — and the next pass reads it off the
 * same object.
 *
 * A node that carries a reason from an earlier tagging and no longer earns one
 * loses it, so the tag is always this run's answer.
 *
 * The answer for one file depends on other files — who imports it, what else
 * is in its folder — so a file nobody edited can change answer. An
 * incremental write re-states every file whose answer differs from the tag
 * its stored row carries (`incremental.ts#resolveWriteScope`, D175), which is
 * what keeps the row's tag this run's answer too, and not the answer of
 * whichever run last happened to rewrite that file.
 */
export function markSetAside(
  graph: {
    nodes: AnalyzedNode[];
    edges: readonly AnalyzedEdge[];
    loads?: readonly FileLoad[];
  },
  context: SetAsideContext,
): Map<string, SetAsideReason> {
  const tagged = resolveSetAside(graph, context);
  for (const node of graph.nodes) {
    if (node.ref.type !== "file") continue;
    const reason = tagged.get(normalizePath(node.ref.filePath));
    if (reason) {
      node.metadata = { ...node.metadata, [SET_ASIDE_KEY]: reason };
    } else if (node.metadata && SET_ASIDE_KEY in node.metadata) {
      const rest = { ...node.metadata };
      delete rest[SET_ASIDE_KEY];
      node.metadata = rest;
    }
  }
  return tagged;
}
