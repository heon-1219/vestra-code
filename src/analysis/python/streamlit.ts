/**
 * Turning a Streamlit project's file layout into the addresses a person opens.
 *
 * ## Why this exists at all
 *
 * Measured across the four real projects in the database, three produce **no
 * entry point**, so 흐름 따라가기 refuses on them entirely. The first guess was
 * that a Flask or Django decorator was going unparsed. It was wrong, and
 * checking the package nodes is what showed it: there is no Flask, FastAPI or
 * Django anywhere. `Kim-and-Chang-` is a **Streamlit** app — `streamlit` in
 * `pyproject.toml`, a `.streamlit/config.toml`, `dashboard.py` and
 * `pages/log.py`, `pages/positions.py` — and Streamlit has no route decorators
 * at all. **Its pages are a file convention**, which is the same shape as
 * Next.js `app/`, and `typescript/routes.ts` is the model this follows.
 *
 * ## The convention, from Streamlit's own documentation
 *
 * A `pages/` directory beside the entrypoint script makes every Python file in
 * it an additional page. A filename is parsed into four parts — a numerical
 * prefix, a separator, an identifier and the extension — and **the URL pathname
 * is the identifier with runs of spaces and underscores condensed to a single
 * underscore**, or the number when there is no identifier. The entrypoint
 * script itself is the home page, at the root URL.
 *
 * Read from the docs rather than from memory, and implemented as written: an
 * emoji in a filename stays in the identifier, because that is what
 * `🏠_Home.py` producing the title `🏠 Home` means. Stripping it would be our
 * invention, and an address we invent is a page of somebody's app that they
 * cannot visit.
 *
 * ## Why every route this emits is `inferred`
 *
 * Next.js's router **is** the file system: `app/checkout/page.tsx` is
 * `/checkout` and there is no other possibility, so `routes.ts`'s addresses are
 * `certain`. Streamlit's page set depends on which script you ran —
 * `streamlit run dashboard.py` — and that is a command line, not a file in the
 * repository. We read the convention and we are usually right; "usually right"
 * is exactly what `inferred` is for, and it is the same call
 * `typescript/fetches.ts` makes for a URL it had to assemble.
 *
 * This costs nothing in the walk: `flow.ts` reads a route's `contains` edge for
 * structure only, and the entry joint is `certain` because reversing a
 * `contains` is a structural fact rather than a claim. What it buys is a map
 * that draws these addresses hatched, which is us saying out loud that we
 * worked out the address rather than read it.
 */

import { normalizePath } from "../ids";

/** One address, and the file that answers to it. */
export type StreamlitPage = {
  /** Repo-relative, POSIX separators. */
  filePath: string;
  /** `/`, `/log`, `/Page_One`. */
  urlPath: string;
  /** Whether this is the script you run, as opposed to a file in `pages/`. */
  home: boolean;
};

export type StreamlitInput = {
  /** Every path in the project, repo-relative. */
  paths: readonly string[];
  /** Whether this file reaches for `streamlit`. */
  importsStreamlit: (path: string) => boolean;
  /** How many files in the project import this one. */
  importedBy: (path: string) => number;
};

const PYTHON = /\.py$/i;

/**
 * Names a person gives the script they run, when several files could be it.
 *
 * Only ever used to break a tie, never to make a choice on its own — a project
 * whose app root holds one Streamlit script does not need a convention, and one
 * that holds three and none of these names gets no home page rather than a
 * guess dressed as an answer.
 */
const CONVENTIONAL_ENTRY = [
  "streamlit_app.py",
  "app.py",
  "main.py",
  "Home.py",
  "home.py",
];

/**
 * Whether this project looks like a Streamlit app at all.
 *
 * Two independent signals, either of which is enough: a declared dependency on
 * `streamlit`, or a `.streamlit/` settings directory. A source file's `import
 * streamlit` is deliberately NOT one of them on its own — a repository can hold
 * one notebook-ish script that imports it without being a Streamlit app, and
 * the entry-point rules below already require that import anyway.
 */
export function looksLikeStreamlit(input: {
  paths: readonly string[];
  packages: readonly string[];
}): boolean {
  if (input.packages.some((name) => name.toLowerCase() === "streamlit")) return true;
  return input.paths.some((path) => normalizePath(path).startsWith(".streamlit/"));
}

/**
 * The addresses this project serves, or none.
 *
 * Returns nothing rather than guessing whenever the layout does not settle the
 * question. A missing address is a page the flow list does not offer; a wrong
 * one is a page of somebody's app that does not exist, which is the failure
 * this product may not have.
 */
export function streamlitPages(input: StreamlitInput): StreamlitPage[] {
  const paths = input.paths.map(normalizePath);
  const pythonFiles = paths.filter((path) => PYTHON.test(path));

  const roots = pagesRoots(pythonFiles);
  const pages: StreamlitPage[] = [];

  if (roots.size === 0) {
    /*
     * No `pages/` directory, so this is either a single-page app or one built
     * with `st.navigation`, which names its pages in a call rather than in the
     * file tree. Either way the only thing the layout can tell us is which
     * script is the one you run, and only when exactly one file answers to the
     * description.
     */
    const home = soleEntry(pythonFiles, input);
    if (home) pages.push({ filePath: home, urlPath: "/", home: true });
    return pages;
  }

  for (const root of roots) {
    const siblings = pythonFiles.filter((path) => directoryOf(path) === root);
    const home = soleEntry(siblings, input);
    if (home) pages.push({ filePath: home, urlPath: "/", home: true });

    const directory = root === "" ? "pages/" : `${root}/pages/`;
    for (const path of pythonFiles) {
      if (directoryOf(path) !== (root === "" ? "pages" : `${root}/pages`)) continue;
      if (!isPageFile(path)) continue;
      const urlPath = pageUrl(path.slice(directory.length));
      if (urlPath === null) continue;
      pages.push({ filePath: path, urlPath, home: false });
    }
  }

  return pages.sort((a, b) =>
    a.urlPath < b.urlPath ? -1 : a.urlPath > b.urlPath ? 1 : 0,
  );
}

/**
 * Directories holding a `pages/` that has Python in it.
 *
 * Returned as the PARENT, because that is what the convention is about: the
 * pages belong to the entrypoint beside them, not to `pages/` itself.
 */
function pagesRoots(pythonFiles: readonly string[]): Set<string> {
  const roots = new Set<string>();
  for (const path of pythonFiles) {
    const directory = directoryOf(path);
    if (directory !== "pages" && !directory.endsWith("/pages")) continue;
    if (!isPageFile(path)) continue;
    roots.add(directory === "pages" ? "" : directory.slice(0, -"/pages".length));
  }
  return roots;
}

/**
 * The one script in this directory that a person would run, or nothing.
 *
 * Three conditions, and all three are measured rather than assumed: it reaches
 * for `streamlit`, **nothing in the project imports it** — a module everything
 * imports is a library, and a script is the thing at the end of the chain — and
 * it is alone in answering to that, or bears a name people give an entrypoint.
 *
 * `Kim-and-Chang-` is the case this was measured against: nine Python files sit
 * at its root, `bot.py` and `dashboard.py` are both imported by nobody, and
 * only `dashboard.py` imports `streamlit`. `bot.py` is a trading daemon with 21
 * outgoing calls and no address at all, and calling it a page would be inventing
 * one.
 */
function soleEntry(candidates: readonly string[], input: StreamlitInput): string | null {
  const scripts = candidates.filter(
    (path) =>
      isPageFile(path) &&
      input.importsStreamlit(path) &&
      input.importedBy(path) === 0,
  );

  if (scripts.length === 1) return scripts[0];
  if (scripts.length === 0) return null;

  const named = scripts.filter((path) => CONVENTIONAL_ENTRY.includes(basename(path)));
  return named.length === 1 ? named[0] : null;
}

/**
 * A file in `pages/` that Streamlit would actually show.
 *
 * `__init__.py` and anything else dunder-named is a package marker rather than
 * a page — and a `pages/` directory carrying one is a plain Python package that
 * happens to share the name, which is the one way this convention can be read
 * onto a project that is not using it.
 */
function isPageFile(path: string): boolean {
  const name = basename(path);
  return PYTHON.test(name) && !name.startsWith("__") && !name.startsWith(".");
}

/**
 * `log.py` → `/log`. `1_Positions.py` → `/Positions`. `1_📈_Log.py` →
 * `/📈_Log`, because the emoji is part of the identifier rather than an icon
 * we are entitled to strip — `🏠_Home.py` is documented as producing the title
 * `🏠 Home`, and removing it here would make the address our invention.
 *
 * The filename is parsed into a numerical prefix, a separator and an
 * identifier. The pathname is the identifier with runs of spaces and
 * underscores condensed to one underscore, or the number when there is no
 * identifier. A file that is nothing but a separator is not shown in the
 * navigation at all, so it gets no address here either.
 */
export function pageUrl(fileName: string): string | null {
  const bare = fileName.replace(PYTHON, "");
  const parsed = /^([0-9]*)[_ -]*(.*)$/u.exec(bare);
  if (!parsed) return null;

  const identifier = parsed[2].replace(/[_ ]+/gu, "_").trim();
  if (identifier !== "") return `/${identifier}`;
  // No identifier. The number is the address, and a file with neither is one
  // Streamlit leaves out of the navigation.
  return parsed[1] === "" ? null : `/${parsed[1]}`;
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
