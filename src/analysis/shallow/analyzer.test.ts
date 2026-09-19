import { describe, expect, it } from "vitest";

import type {
  AnalysisEmitter,
  AnalyzedEdge,
  AnalyzedNode,
  SourceFile,
} from "@/analysis/types";

import { createShallowAnalyzer } from "./analyzer";

/**
 * The analyzer is pure over (files, root, emit), so every one of these runs the
 * real thing against a tree that exists only in memory — no GitHub, no
 * database, no temp directory. That is the whole point of the Analyzer
 * signature, and it means a fixture is four lines rather than a fixture repo.
 */

/** `null` content means a binary asset, which ingest offers but never reads. */
function tree(entries: Record<string, string | null>): SourceFile[] {
  return Object.entries(entries).map(([path, content]) => ({
    path,
    absolutePath: `/repo/${path}`,
    size: content === null ? 2048 : Buffer.byteLength(content, "utf8"),
    read: content === null ? null : () => content,
  }));
}

type Recorded = {
  nodes: AnalyzedNode[];
  edges: AnalyzedEdge[];
  phases: string[];
  parsed: string[];
  skipped: { path: string; reason: string }[];
  emit: AnalysisEmitter;
};

function recorder(): Recorded {
  const record: Recorded = {
    nodes: [],
    edges: [],
    phases: [],
    parsed: [],
    skipped: [],
    emit: {
      phase: (phase) => void record.phases.push(phase),
      fileParsed: (path) => void record.parsed.push(path),
      nodes: (nodes) => void record.nodes.push(...nodes),
      edges: (edges) => void record.edges.push(...edges),
      fileSkipped: (path, reason) => void record.skipped.push({ path, reason }),
    },
  };
  return record;
}

async function analyze(entries: Record<string, string | null>) {
  const record = recorder();
  const result = await createShallowAnalyzer().analyze(
    tree(entries),
    "/repo",
    record.emit,
  );
  return { ...result, record };
}

function packageNames(nodes: AnalyzedNode[]): string[] {
  return nodes
    .filter((node) => node.ref.type === "package")
    .map((node) => node.ref.name ?? "")
    .sort();
}

function edgesOf(
  edges: AnalyzedEdge[],
  type: AnalyzedEdge["type"],
  fromPath?: string,
) {
  return edges
    .filter((edge) => edge.type === type)
    .filter((edge) => fromPath === undefined || edge.source.filePath === fromPath)
    .map((edge) => ({
      to: edge.target.name ?? edge.target.filePath,
      confidence: edge.confidence,
    }));
}

// ---------------------------------------------------------------------------

describe("what this analyzer takes on", () => {
  it("handles the kinds nothing else does", () => {
    const analyzer = createShallowAnalyzer();
    expect(analyzer.name).toBe("shallow");
    expect(analyzer.handles("unsupported")).toBe(true);
    // Until the static-site analyzer exists, a shallower map of a real site
    // beats an error message.
    expect(analyzer.handles("static_site")).toBe(true);
    expect(analyzer.handles("nextjs")).toBe(false);
    expect(analyzer.handles("react_spa")).toBe(false);
  });

  it("reports progress in the order the stream expects", async () => {
    const { record } = await analyze({ "main.go": "package main" });
    expect(record.phases).toEqual(["static", "done"]);
    expect(record.parsed).toEqual(["main.go"]);
  });
});

describe("the file tree", () => {
  it("gives every file ingest offered a place on the map", async () => {
    const { nodes } = await analyze({
      "index.html": "<html></html>",
      "styles/main.css": "body { color: red; }",
      "images/hero.png": null,
      "src/deeply/nested/thing.rb": "puts 1",
    });

    expect(nodes.filter((node) => node.ref.type === "file").map((n) => n.ref.filePath))
      .toEqual([
        "index.html",
        "styles/main.css",
        "images/hero.png",
        "src/deeply/nested/thing.rb",
      ]);
  });

  it("marks binary assets, because 'nothing uses this photo' needs the photo", async () => {
    const { nodes } = await analyze({
      "images/hero.png": null,
      "app.js": "",
    });

    const asset = nodes.find((node) => node.ref.filePath === "images/hero.png");
    expect(asset?.metadata).toEqual({ asset: true, size: 2048 });
    const code = nodes.find((node) => node.ref.filePath === "app.js");
    expect(code?.metadata).toEqual({ size: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("dependency manifests, one ecosystem at a time", () => {
  it("reads package.json", async () => {
    const { nodes, edges } = await analyze({
      "package.json": JSON.stringify({
        dependencies: { react: "19.2.8", "@tanstack/query": "^5" },
        devDependencies: { vitest: "^5" },
        peerDependencies: { typescript: "^5" },
      }),
    });

    expect(packageNames(nodes)).toEqual([
      "@tanstack/query",
      "react",
      "typescript",
      "vitest",
    ]);
    expect(edgesOf(edges, "uses_package", "package.json")).toHaveLength(4);
  });

  it("reads requirements.txt, ignoring pip's own instructions", async () => {
    const { nodes } = await analyze({
      "requirements.txt": [
        "# runtime",
        "Django==5.0.6",
        "psycopg[binary]>=3.1",
        "requests  # http client",
        'httpx>=0.27; python_version >= "3.9"',
        "-r shared.txt",
        "-e ./local-lib",
        "python-dotenv",
      ].join("\n"),
    });

    expect(packageNames(nodes)).toEqual([
      "Django",
      "httpx",
      "psycopg",
      "python-dotenv",
      "requests",
    ]);
  });

  it("reads pyproject.toml in both the standard and the Poetry shape", async () => {
    const { nodes } = await analyze({
      "pyproject.toml": [
        "[project]",
        'name = "svc"',
        'requires-python = ">=3.11"',
        "dependencies = [",
        '  "httpx[http2]>=0.27",',
        '  "fastapi",',
        "]",
        "",
        "[project.optional-dependencies]",
        'dev = ["pytest>=8", "ruff"]',
        "",
        "[build-system]",
        'requires = ["hatchling"]',
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'requests = "^2.31"',
      ].join("\n"),
    });

    // `hatchling` builds the package rather than running in it, and `python`
    // is a constraint rather than something anyone installed.
    expect(packageNames(nodes)).toEqual([
      "fastapi",
      "httpx",
      "pytest",
      "requests",
      "ruff",
    ]);
  });

  it("reads go.mod and leaves out the transitive dependencies", async () => {
    const { nodes } = await analyze({
      "go.mod": [
        "module example.com/app",
        "",
        "go 1.22",
        "",
        "require (",
        "\tgithub.com/gin-gonic/gin v1.10.0",
        "\tgithub.com/redis/go-redis/v9 v9.6.1",
        "\tgolang.org/x/sync v0.8.0 // indirect",
        ")",
        "",
        "require github.com/google/uuid v1.6.0",
      ].join("\n"),
    });

    expect(packageNames(nodes)).toEqual([
      "github.com/gin-gonic/gin",
      "github.com/google/uuid",
      "github.com/redis/go-redis/v9",
    ]);
  });

  it("reads a Gemfile", async () => {
    const { nodes } = await analyze({
      Gemfile: [
        'source "https://rubygems.org"',
        'gem "rails", "~> 7.1"',
        "gem 'pg'",
        '# gem "debug"',
        "group :development do",
        '  gem "rspec-rails"',
        "end",
      ].join("\n"),
    });

    expect(packageNames(nodes)).toEqual(["pg", "rails", "rspec-rails"]);
  });

  it("reads Cargo.toml in all three shapes a crate can be written", async () => {
    const { nodes } = await analyze({
      "Cargo.toml": [
        "[package]",
        'name = "app"',
        'version = "0.1.0"',
        "",
        "[dependencies]",
        'serde = { version = "1", features = ["derive"] }',
        'tokio = "1.38"  # async runtime',
        "",
        "[dependencies.reqwest]",
        'version = "0.12"',
        'features = ["json"]',
        "",
        "[dev-dependencies]",
        'proptest = "1"',
        "",
        "[target.'cfg(unix)'.dependencies]",
        'nix = "0.29"',
      ].join("\n"),
    });

    // `version` and `features` under [dependencies.reqwest] are settings for
    // reqwest, not crates of their own.
    expect(packageNames(nodes)).toEqual([
      "nix",
      "proptest",
      "reqwest",
      "serde",
      "tokio",
    ]);
  });

  it("reads composer.json and leaves out platform constraints", async () => {
    const { nodes } = await analyze({
      "composer.json": JSON.stringify({
        require: {
          php: ">=8.2",
          "ext-json": "*",
          "laravel/framework": "^11.0",
        },
        "require-dev": { "phpunit/phpunit": "^11" },
      }),
    });

    expect(packageNames(nodes)).toEqual([
      "laravel/framework",
      "phpunit/phpunit",
    ]);
  });

  it("reads pom.xml dependencies and not its plugins", async () => {
    const { nodes } = await analyze({
      "pom.xml": [
        "<project>",
        "  <dependencies>",
        "    <dependency>",
        "      <groupId>org.springframework.boot</groupId>",
        "      <artifactId>spring-boot-starter-web</artifactId>",
        "      <version>3.3.2</version>",
        "    </dependency>",
        "    <dependency>",
        "      <groupId>com.google.guava</groupId>",
        "      <artifactId>guava</artifactId>",
        "    </dependency>",
        "  </dependencies>",
        "  <build><plugins><plugin>",
        "    <groupId>org.apache.maven.plugins</groupId>",
        "    <artifactId>maven-surefire-plugin</artifactId>",
        "  </plugin></plugins></build>",
        "</project>",
      ].join("\n"),
    });

    expect(packageNames(nodes)).toEqual([
      "com.google.guava:guava",
      "org.springframework.boot:spring-boot-starter-web",
    ]);
  });

  it("finds a manifest that is not at the repository root", async () => {
    const { nodes, edges } = await analyze({
      "backend/requirements.txt": "flask",
      "frontend/package.json": JSON.stringify({ dependencies: { vue: "^3" } }),
    });

    expect(packageNames(nodes)).toEqual(["flask", "vue"]);
    expect(edgesOf(edges, "uses_package", "frontend/package.json")).toEqual([
      { to: "vue", confidence: "certain" },
    ]);
  });

  it("keeps going when a manifest is malformed, and says so in plain language", async () => {
    const { nodes, record } = await analyze({
      "package.json": '{ "dependencies": ["react"] }',
      "broken/composer.json": "{ not json at all",
      "app.js": "",
    });

    expect(packageNames(nodes)).toEqual([]);
    expect(record.skipped.map((entry) => entry.path).sort()).toEqual([
      "broken/composer.json",
      "package.json",
    ]);
    expect(record.skipped[0].reason).toContain("읽지 못했어요");
    // The file is still on the map even though we could not read inside it.
    expect(nodes.some((node) => node.ref.filePath === "package.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("literal paths, which the browser resolves with no configuration", () => {
  it("follows script, link and img with certainty", async () => {
    const { edges } = await analyze({
      "index.html": [
        "<!doctype html>",
        '<link rel="stylesheet" href="./styles/main.css">',
        '<img src="images/hero.png?v=2" alt="">',
        '<script src="./app.js"></script>',
      ].join("\n"),
      "styles/main.css": "",
      "images/hero.png": null,
      "app.js": "",
    });

    expect(edgesOf(edges, "imports", "index.html")).toEqual([
      { to: "styles/main.css", confidence: "certain" },
      { to: "images/hero.png", confidence: "certain" },
      { to: "app.js", confidence: "certain" },
    ]);
  });

  it("follows a page in a subdirectory relative to itself", async () => {
    const { edges } = await analyze({
      "pages/about.html": '<script src="../js/app.js"></script>',
      "js/app.js": "",
    });

    expect(edgesOf(edges, "imports", "pages/about.html")).toEqual([
      { to: "js/app.js", confidence: "certain" },
    ]);
  });

  it("only guesses at a root-absolute path, because the site root is a deploy setting", async () => {
    const { edges } = await analyze({
      "index.html": '<link rel="icon" href="/favicon.ico">',
      "favicon.ico": null,
    });

    expect(edgesOf(edges, "imports", "index.html")).toEqual([
      { to: "favicon.ico", confidence: "inferred" },
    ]);
  });

  it("ignores other origins and inline data", async () => {
    const { edges } = await analyze({
      "index.html": [
        '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
        '<script src="//cdn.example.com/lib.js"></script>',
        '<img src="data:image/gif;base64,R0lGOD">',
        '<a href="./about.html">about</a>',
      ].join("\n"),
      "about.html": "",
    });

    // The anchor is navigation, not something the page pulls in.
    expect(edges).toEqual([]);
  });

  it("is not fooled by a lazy-loading placeholder attribute", async () => {
    const { edges } = await analyze({
      "index.html": '<img data-src="images/lazy.png" src="images/real.png">',
      "images/lazy.png": null,
      "images/real.png": null,
    });

    expect(edgesOf(edges, "imports", "index.html")).toEqual([
      { to: "images/real.png", confidence: "certain" },
    ]);
  });

  it("follows CSS @import and url(), in both quoting styles", async () => {
    const { edges } = await analyze({
      "styles/main.css": [
        '@import "./reset.css";',
        "@import url('../tokens.css');",
        '.hero { background: url("../images/hero.png"); }',
        ".icon { background: url(data:image/svg+xml;base64,AAA); }",
      ].join("\n"),
      "styles/reset.css": "",
      "tokens.css": "",
      "images/hero.png": null,
    });

    expect(edgesOf(edges, "imports", "styles/main.css")).toEqual([
      { to: "styles/reset.css", confidence: "certain" },
      { to: "tokens.css", confidence: "certain" },
      { to: "images/hero.png", confidence: "certain" },
    ]);
  });

  it("never guesses an extension for a literal path", async () => {
    // A browser does not; neither do we.
    const { edges } = await analyze({
      "index.html": '<script src="./app"></script>',
      "app.js": "",
    });

    expect(edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("relative imports in source, which are always a guess", () => {
  const repo = {
    "app.js": [
      'import { format } from "./lib/format";',
      'import Widget from "./components/Widget";',
      'import "./styles/main.css";',
      'const legacy = require("./legacy/util.js");',
      'export { thing } from "./lib/thing";',
      'import(/* webpackChunkName: "late" */ "./lazy/panel.js");',
    ].join("\n"),
    "lib/format.ts": "",
    "components/Widget/index.jsx": "",
    "styles/main.css": "",
    "legacy/util.js": "",
    "lib/thing.mjs": "",
    "lazy/panel.js": "",
  };

  it("probes for an extension and for an index file", async () => {
    const { edges } = await analyze(repo);

    expect(edgesOf(edges, "imports", "app.js")).toEqual([
      { to: "lib/format.ts", confidence: "inferred" },
      { to: "components/Widget/index.jsx", confidence: "inferred" },
      { to: "styles/main.css", confidence: "inferred" },
      { to: "legacy/util.js", confidence: "inferred" },
      { to: "lib/thing.mjs", confidence: "inferred" },
      { to: "lazy/panel.js", confidence: "inferred" },
    ]);
  });

  it("produces nothing at all when the file it names is not there", async () => {
    const { edges } = await analyze({
      "app.js": 'import missing from "./nope";\nimport x from "./lib/gone.js";',
      "lib/format.ts": "",
    });

    // A dangling line is a claim about a file that does not exist. Silence.
    expect(edges).toEqual([]);
  });

  it("does not follow an import that someone commented out", async () => {
    const { edges } = await analyze({
      "app.js": [
        '// import ghost from "./ghost";',
        '/* import spectre from "./spectre"; */',
        'import real from "./real";',
      ].join("\n"),
      "ghost.js": "",
      "spectre.js": "",
      "real.js": "",
    });

    expect(edgesOf(edges, "imports", "app.js")).toEqual([
      { to: "real.js", confidence: "inferred" },
    ]);
  });

  it("reads an import statement written across several lines", async () => {
    const { edges } = await analyze({
      "app.ts": ["import {", "  alpha,", "  beta,", '} from "./multi";'].join("\n"),
      "multi.ts": "",
    });

    expect(edgesOf(edges, "imports", "app.ts")).toEqual([
      { to: "multi.ts", confidence: "inferred" },
    ]);
  });

  it("does not let one statement reach across a string into the next", async () => {
    const { edges } = await analyze({
      "app.js": ['import "./first.css"', 'export { x } from "./second.js"'].join("\n"),
      "first.css": "",
      "second.js": "",
    });

    expect(edgesOf(edges, "imports", "app.js")).toEqual([
      { to: "first.css", confidence: "inferred" },
      { to: "second.js", confidence: "inferred" },
    ]);
  });

  it("reads a Vue router, which is the shape this analyzer meets most", async () => {
    const { edges } = await analyze({
      "src/router/index.js": [
        'import HomeView from "../views/HomeView.vue";',
        "const routes = [",
        '  { path: "/", component: HomeView },',
        "  {",
        '    path: "/about",',
        '    component: () => import(/* webpackChunkName: "about" */ "../views/AboutView.vue"),',
        "  },",
        "];",
      ].join("\n"),
      "src/views/HomeView.vue": "",
      "src/views/AboutView.vue": "",
    });

    // Without the lazy one, the router file — the only file that says what the
    // app's pages are — would name just half of them.
    expect(edgesOf(edges, "imports", "src/router/index.js")).toEqual([
      { to: "src/views/HomeView.vue", confidence: "inferred" },
      { to: "src/views/AboutView.vue", confidence: "inferred" },
    ]);
  });

  it("stops at the repository boundary", async () => {
    const { edges } = await analyze({
      "app.js": 'import x from "../outside/secret.js";',
    });

    expect(edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("bare specifiers", () => {
  it("is certain about a package the manifest declares", async () => {
    const { edges } = await analyze({
      "package.json": JSON.stringify({ dependencies: { react: "19", lodash: "4" } }),
      "src/app.js": [
        'import React from "react";',
        'import debounce from "lodash/debounce";',
      ].join("\n"),
    });

    expect(edgesOf(edges, "uses_package", "src/app.js")).toEqual([
      { to: "react", confidence: "certain" },
      // A subpath is a fully specified npm rule, so it stays certain.
      { to: "lodash", confidence: "certain" },
    ]);
  });

  it("stays quiet about a name no manifest mentions", async () => {
    const { nodes, edges } = await analyze({
      "package.json": JSON.stringify({ dependencies: { react: "19" } }),
      "src/server.js": ['import fs from "node:fs";', 'import os from "os";'].join("\n"),
    });

    // `os` is the standard library, not something anyone installed. Inventing a
    // package for it would put a thing on the map that does not exist.
    expect(packageNames(nodes)).toEqual(["react"]);
    expect(edgesOf(edges, "uses_package", "src/server.js")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the shape of the whole result", () => {
  const repo = {
    "package.json": JSON.stringify({ dependencies: { vue: "^3" } }),
    "index.html": '<link rel="stylesheet" href="./styles.css">\n<script src="./main.js"></script>',
    "styles.css": '@import "./theme.css";',
    "theme.css": "",
    "main.js": 'import { boot } from "./boot";\nimport { createApp } from "vue";',
    "boot.js": "",
    "logo.svg": null,
  };

  it("never emits an edge pointing at something that is not on the map", async () => {
    const { nodes, edges } = await analyze(repo);

    const known = new Set(
      nodes.map((node) =>
        JSON.stringify([node.ref.type, node.ref.filePath, node.ref.name ?? ""]),
      ),
    );
    for (const edge of edges) {
      for (const end of [edge.source, edge.target]) {
        expect(
          known.has(JSON.stringify([end.type, end.filePath, end.name ?? ""])),
        ).toBe(true);
      }
    }
  });

  it("never emits the same line twice, or a line from a file to itself", async () => {
    const { edges } = await analyze({
      ...repo,
      // Two ways of saying the same thing, plus a stylesheet importing itself.
      "styles.css": '@import url("./theme.css");\n@import "./theme.css";\n@import "./styles.css";',
    });

    const keys = edges.map((edge) =>
      JSON.stringify([edge.type, edge.source.filePath, edge.target.filePath, edge.target.name]),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      edges.some(
        (edge) =>
          edge.source.filePath === edge.target.filePath &&
          edge.source.type === edge.target.type,
      ),
    ).toBe(false);
  });

  it("draws solid boxes and only some dotted lines, which is the point of this layer", async () => {
    const { edges } = await analyze(repo);

    const certain = edges.filter((edge) => edge.confidence === "certain").length;
    const inferred = edges.filter((edge) => edge.confidence === "inferred").length;

    // package.json -> vue, index.html -> styles.css, index.html -> main.js,
    // styles.css -> theme.css, main.js -> vue.
    expect(certain).toBe(5);
    // main.js -> boot.js, the one crossing a file boundary by name.
    expect(inferred).toBe(1);
  });

  it("still produces a map when nothing in the repository can be read", async () => {
    const { nodes, edges } = await analyze({
      "photos/a.jpg": null,
      "photos/b.jpg": null,
    });

    expect(nodes).toHaveLength(2);
    expect(edges).toEqual([]);
  });
});
