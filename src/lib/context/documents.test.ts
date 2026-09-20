import { describe, expect, it } from "vitest";

import type { GraphItem } from "@/lib/graph/view";

import { contextDocumentPaths } from "./documents";

/**
 * Which of a project's files count as a description of it.
 *
 * The cases that matter are the ones where being wrong costs a read and a
 * share of a model call for a document about something else.
 */

function file(path: string): GraphItem {
  return {
    id: path,
    kind: "file",
    shape: null,
    name: path,
    label: null,
    summary: null,
    path,
    startLine: null,
    endLine: null,
    fromUser: false,
    usedBy: 0,
    uses: 0,
  };
}

describe("the documents a digest is built from", () => {
  it("puts the root README first, whatever order the map is in", () => {
    const paths = contextDocumentPaths([
      file("docs/DECISIONS.md"),
      file("AGENTS.md"),
      file("README.md"),
    ]);
    expect(paths[0]).toBe("README.md");
  });

  it("takes the files written for a machine, which say the most and sell the least", () => {
    const paths = contextDocumentPaths([
      file("AGENTS.md"),
      file("CLAUDE.md"),
      file("src/app/page.tsx"),
    ]);
    expect(paths).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("leaves a README that is not at the root alone", () => {
    // Nearly always describing one folder or a vendored library, so the budget
    // would buy a description of the wrong thing.
    expect(contextDocumentPaths([file("src/components/README.md")])).toEqual([]);
  });

  it("ignores everything that is not prose about the project", () => {
    const paths = contextDocumentPaths([
      file("LICENSE"),
      file("CHANGELOG.md"),
      file("package.json"),
      file("src/lib/format.ts"),
    ]);
    expect(paths).toEqual([]);
  });

  it("answers with nothing for a project that never wrote one down", () => {
    // The important case: no digest, and the loop runs exactly as it does
    // today. A smaller honest input rather than an invented one.
    expect(contextDocumentPaths([file("src/lib/format.ts")])).toEqual([]);
  });

  it("stops at the cap, best first", () => {
    const paths = contextDocumentPaths([
      file("CONTRIBUTING.md"),
      file("docs/b.md"),
      file("docs/a.md"),
      file("CLAUDE.md"),
      file("AGENTS.md"),
      file("README.md"),
    ]);
    expect(paths).toEqual(["README.md", "AGENTS.md", "CLAUDE.md", "docs/a.md"]);
  });

  it("orders two documents the same way on every machine", () => {
    // Not `localeCompare`: a digest built from a different pair of files on two
    // hosts is a difference nobody would think to look for.
    const items = [file("docs/Z.md"), file("docs/a.md"), file("docs/B.md")];
    expect(contextDocumentPaths(items, 3)).toEqual([
      "docs/B.md",
      "docs/Z.md",
      "docs/a.md",
    ]);
  });

  it("does not offer a path the map does not hold as a file", () => {
    const symbol: GraphItem = { ...file("README.md"), kind: "symbol" };
    expect(contextDocumentPaths([symbol])).toEqual([]);
  });
});
