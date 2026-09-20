import { describe, expect, it } from "vitest";

import { looksLikeStreamlit, pageUrl, streamlitPages } from "./streamlit";

/**
 * The page convention, and the three ways of getting it wrong that would each
 * put an address on somebody's map that their app does not serve.
 *
 * The shape under test is `Kim-and-Chang-`
 * (e0ef56c2-386f-4862-a41b-69a8d1bab3dd), measured from the real graph: nine
 * Python files at the root, `dashboard.py` and `bot.py` both imported by
 * nobody, and only `dashboard.py` importing `streamlit`. Getting `bot.py` —
 * a trading daemon with no address at all — is the failure this is written
 * against.
 */

const KIM = {
  paths: [
    ".streamlit/config.toml",
    "pyproject.toml",
    "backtest.py",
    "bot.py",
    "broker.py",
    "config.py",
    "dashboard.py",
    "db.py",
    "notifications.py",
    "pages/log.py",
    "pages/positions.py",
    "safety.py",
    "universe.py",
    "strategies/__init__.py",
    "strategies/base.py",
  ],
  streamlit: new Set(["dashboard.py", "pages/log.py", "pages/positions.py"]),
  /** How many project files import each one, from the real graph. */
  importedBy: {
    "backtest.py": 1,
    "bot.py": 0,
    "broker.py": 3,
    "config.py": 3,
    "dashboard.py": 0,
    "db.py": 7,
    "notifications.py": 3,
    "pages/log.py": 0,
    "pages/positions.py": 0,
    "safety.py": 1,
    "universe.py": 1,
    "strategies/__init__.py": 4,
    "strategies/base.py": 6,
  } as Record<string, number>,
};

function pagesOf(over: Partial<typeof KIM> = {}) {
  const input = { ...KIM, ...over };
  return streamlitPages({
    paths: input.paths,
    importsStreamlit: (path) => input.streamlit.has(path),
    importedBy: (path) => input.importedBy[path] ?? 0,
  });
}

describe("recognising a Streamlit project", () => {
  it("takes a declared dependency as proof", () => {
    expect(looksLikeStreamlit({ paths: [], packages: ["streamlit", "pandas"] })).toBe(true);
  });

  it("takes a settings directory as proof", () => {
    expect(
      looksLikeStreamlit({ paths: [".streamlit/config.toml"], packages: ["pandas"] }),
    ).toBe(true);
  });

  it("does not take one script's import as proof on its own", () => {
    // A repository can hold a notebook-ish script that imports streamlit
    // without being a Streamlit app, and an address invented from that is a
    // page of somebody's project that does not exist.
    expect(looksLikeStreamlit({ paths: ["scratch.py"], packages: ["pandas"] })).toBe(false);
  });
});

describe("the real project this was built for", () => {
  it("finds the home page and both pages, and nothing else", () => {
    expect(pagesOf()).toEqual([
      { filePath: "dashboard.py", urlPath: "/", home: true },
      { filePath: "pages/log.py", urlPath: "/log", home: false },
      { filePath: "pages/positions.py", urlPath: "/positions", home: false },
    ]);
  });

  it("does not call the trading daemon a page", () => {
    // `bot.py` is imported by nobody and has 21 outgoing calls — the richest
    // part of that graph — and it is still not an address. It does not import
    // streamlit, and a script is not a page.
    expect(pagesOf().map((page) => page.filePath)).not.toContain("bot.py");
  });

  it("gives up on the home page rather than guessing between two scripts", () => {
    const pages = pagesOf({
      streamlit: new Set(["dashboard.py", "bot.py", "pages/log.py", "pages/positions.py"]),
    });
    expect(pages.filter((page) => page.home)).toHaveLength(0);
    // The pages themselves are still real: `pages/` is beside both candidates.
    expect(pages.map((page) => page.urlPath)).toEqual(["/log", "/positions"]);
  });

  it("breaks a tie on a name people actually give an entrypoint", () => {
    const pages = pagesOf({
      paths: [...KIM.paths, "streamlit_app.py"],
      streamlit: new Set(["dashboard.py", "streamlit_app.py", "pages/log.py"]),
      importedBy: { ...KIM.importedBy, "streamlit_app.py": 0 },
    });
    expect(pages.find((page) => page.home)?.filePath).toBe("streamlit_app.py");
  });
});

describe("a project with no pages directory", () => {
  it("offers the one script you would run, and only when there is one", () => {
    expect(
      streamlitPages({
        paths: ["app.py", "helpers.py"],
        importsStreamlit: (path) => path === "app.py",
        importedBy: (path) => (path === "helpers.py" ? 1 : 0),
      }),
    ).toEqual([{ filePath: "app.py", urlPath: "/", home: true }]);
  });

  it("offers nothing when no file answers to the description", () => {
    expect(
      streamlitPages({
        paths: ["lib.py"],
        importsStreamlit: () => true,
        // Imported by something, so it is a module rather than the script you run.
        importedBy: () => 2,
      }),
    ).toEqual([]);
  });
});

describe("a pages directory that is really a Python package", () => {
  it("does not read a dunder file as an address", () => {
    const pages = streamlitPages({
      paths: ["app.py", "pages/__init__.py", "pages/view.py"],
      importsStreamlit: (path) => path === "app.py",
      importedBy: () => 0,
    });
    expect(pages.map((page) => page.urlPath)).toEqual(["/", "/view"]);
  });
});

describe("filename to URL, as Streamlit documents it", () => {
  it("drops the numerical prefix and its separator", () => {
    expect(pageUrl("1_Positions.py")).toBe("/Positions");
    expect(pageUrl("02-Log.py")).toBe("/Log");
    expect(pageUrl("3 Report.py")).toBe("/Report");
  });

  it("condenses runs of spaces and underscores into one underscore", () => {
    expect(pageUrl("1_Page__One.py")).toBe("/Page_One");
    expect(pageUrl("Page  Two.py")).toBe("/Page_Two");
  });

  it("keeps the case, because the URL keeps it", () => {
    expect(pageUrl("log.py")).toBe("/log");
    expect(pageUrl("Log.py")).toBe("/Log");
  });

  it("keeps an emoji, because stripping it would make the address ours", () => {
    expect(pageUrl("1_📈_Log.py")).toBe("/📈_Log");
  });

  it("falls back to the number when there is no identifier", () => {
    expect(pageUrl("7.py")).toBe("/7");
  });

  it("gives no address to a file that is only a separator", () => {
    expect(pageUrl("_.py")).toBeNull();
  });
});
