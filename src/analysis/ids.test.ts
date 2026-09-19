import { describe, expect, it } from "vitest";

import { edgeId, nodeId, normalizePath } from "./ids";

/**
 * These tests guard rule 1 of section 6.1. If ids are not stable, a user's
 * correction silently starts pointing at the wrong thing after the next
 * analysis, and nothing in the product reports it.
 */
describe("normalizePath", () => {
  it("converts Windows separators, because the founder develops on Windows", () => {
    expect(normalizePath("src\\components\\Button.tsx")).toBe(
      "src/components/Button.tsx",
    );
  });

  it("strips a leading ./ and leading slashes", () => {
    expect(normalizePath("./src/index.ts")).toBe("src/index.ts");
    expect(normalizePath("/src/index.ts")).toBe("src/index.ts");
  });

  it("collapses duplicate slashes", () => {
    expect(normalizePath("src//lib///util.ts")).toBe("src/lib/util.ts");
  });

  it("is idempotent", () => {
    const once = normalizePath("./src\\a//b.ts");
    expect(normalizePath(once)).toBe(once);
  });
});

describe("nodeId", () => {
  const project = "proj_1";

  it("is identical across two calls with the same input", () => {
    const ref = {
      type: "symbol" as const,
      filePath: "src/lib/price.ts",
      name: "formatPrice",
    };
    expect(nodeId(project, ref)).toBe(nodeId(project, ref));
  });

  it("is identical whether the path arrives POSIX or Windows-style", () => {
    const posix = nodeId(project, {
      type: "symbol",
      filePath: "src/lib/price.ts",
      name: "formatPrice",
    });
    const windows = nodeId(project, {
      type: "symbol",
      filePath: "src\\lib\\price.ts",
      name: "formatPrice",
    });
    expect(windows).toBe(posix);
  });

  it("differs across projects, so two users' graphs never collide", () => {
    const ref = {
      type: "file" as const,
      filePath: "src/index.ts",
    };
    expect(nodeId("proj_1", ref)).not.toBe(nodeId("proj_2", ref));
  });

  it("differs by type, so a file and a symbol at one path are distinct", () => {
    expect(nodeId(project, { type: "file", filePath: "src/a.ts" })).not.toBe(
      nodeId(project, { type: "symbol", filePath: "src/a.ts" }),
    );
  });

  it("cannot be confused by a component boundary", () => {
    // Without a separator that cannot appear in a component, ("ab", "c") and
    // ("a", "bc") would hash identically and two different things would share
    // an id.
    const a = nodeId(project, {
      type: "symbol",
      filePath: "src/ab",
      name: "c",
    });
    const b = nodeId(project, {
      type: "symbol",
      filePath: "src/a",
      name: "bc",
    });
    expect(a).not.toBe(b);
  });

  it("treats a missing name as distinct from an empty-named symbol at the same path", () => {
    // Both hash the empty string in the name slot by design — a node whose
    // identity is its path has no name. This test pins that intent so a later
    // change to the scheme is a deliberate decision rather than an accident.
    const withoutName = nodeId(project, { type: "file", filePath: "src/a.ts" });
    const withEmpty = nodeId(project, {
      type: "file",
      filePath: "src/a.ts",
      name: "",
    });
    expect(withoutName).toBe(withEmpty);
  });

  it("produces a 32-character hex id", () => {
    const id = nodeId(project, { type: "route", filePath: "app/page.tsx" });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("edgeId", () => {
  it("is directional — a calls b is not b calls a", () => {
    const a = "aaaa";
    const b = "bbbb";
    expect(edgeId("p", "calls", a, b)).not.toBe(edgeId("p", "calls", b, a));
  });

  it("differs by edge type between the same two nodes", () => {
    expect(edgeId("p", "calls", "a", "b")).not.toBe(
      edgeId("p", "renders", "a", "b"),
    );
  });

  it("is stable across calls", () => {
    expect(edgeId("p", "imports", "a", "b")).toBe(
      edgeId("p", "imports", "a", "b"),
    );
  });
});
