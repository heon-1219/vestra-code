import { describe, expect, it } from "vitest";

import { detectProject, manifestsToFetch, type PackageManifest } from "./detect";

function pkg(path: string, deps: Record<string, string>): PackageManifest {
  return { path, json: { dependencies: deps } };
}

describe("detectProject — the deep classes", () => {
  it("recognises a Next.js App Router project", () => {
    const result = detectProject(
      ["package.json", "app/page.tsx", "app/checkout/page.tsx", "lib/price.ts"],
      [pkg("package.json", { next: "16.3.5", react: "19.2.8" })],
    );
    expect(result.kind).toBe("nextjs");
    expect(result.deep).toBe(true);
    expect(result.signals).toContain("app/ 라우트 파일");
  });

  it("recognises a Next.js Pages Router project", () => {
    const result = detectProject(
      ["package.json", "pages/index.jsx", "pages/api/hello.js"],
      [pkg("package.json", { next: "14.2.21" })],
    );
    expect(result.kind).toBe("nextjs");
    expect(result.signals).toContain("pages/ 라우트 파일");
  });

  it("recognises a React SPA", () => {
    const result = detectProject(
      ["package.json", "index.html", "vite.config.ts", "src/App.tsx"],
      [pkg("package.json", { react: "19.2.8" })],
    );
    expect(result.kind).toBe("react_spa");
    expect(result.deep).toBe(true);
  });

  it("recognises a hand-written static site, and claims only what it delivers", () => {
    const result = detectProject(
      ["index.html", "about.html", "projects/tessera.html", "styles.css", "assets/me.jpg"],
      [],
    );
    expect(result.kind).toBe("static_site");
    // Served by the shallow analyzer until D6's static-site analyzer exists,
    // which emits no symbols — so it must not promise to read inside the CSS.
    // Measured on the founder's own portfolio: 58 files, 57 links, 0 style rules.
    expect(result.deep).toBe(false);
    expect(result.summary).not.toContain("스타일이 어디에 쓰이는지");
    expect(result.summary).toContain("아직");
  });
});

describe("detectProject — a bundler entry point is not a static site", () => {
  /**
   * This is a regression test for a real misclassification found by running
   * detection against live repositories. A SolidJS app was called a
   * hand-written HTML site because its package.json sits under `frontend/`
   * rather than at the root, leaving one index.html and no visible dependency.
   * The product would have promised to read its pages and styles, then produced
   * almost nothing — the exact failure mode the honesty rule exists to prevent.
   */
  it("does not call a SolidJS app with a nested package.json a static site", () => {
    const paths = [
      "README.md",
      "frontend/package.json",
      "frontend/index.html",
      "frontend/vite.config.ts",
      "frontend/src/App.tsx",
      "backend/main.py",
      "backend/requirements.txt",
    ];
    const result = detectProject(paths, [
      pkg("frontend/package.json", { "solid-js": "^1.9.0" }),
    ]);
    expect(result.kind).toBe("unsupported");
    expect(result.deep).toBe(false);
    // And it names the framework, which is kinder than shrugging.
    expect(result.summary).toContain("SolidJS");
  });

  it("does not call a bundled app a static site even when the manifest is unreadable", () => {
    // A package.json we could not parse still proves this is a bundled project.
    const result = detectProject(
      ["frontend/package.json", "frontend/index.html", "frontend/src/main.js"],
      [{ path: "frontend/package.json", json: null }],
    );
    expect(result.kind).toBe("unsupported");
    expect(result.kind).not.toBe("static_site");
  });

  it("does not call a bundler-config repo a static site even with no manifest fetched", () => {
    const result = detectProject(["index.html", "vite.config.js", "src/main.js"], []);
    expect(result.kind).not.toBe("static_site");
  });
});

describe("detectProject — named frameworks we cannot read deeply", () => {
  it.each([
    ["svelte", "Svelte"],
    ["vue", "Vue"],
    ["@angular/core", "Angular"],
    ["astro", "Astro"],
    ["nuxt", "Nuxt"],
  ])("names %s in the message instead of shrugging", (dep, label) => {
    const result = detectProject(
      ["package.json", "src/main.ts"],
      [pkg("package.json", { [dep]: "1.0.0" })],
    );
    expect(result.kind).toBe("unsupported");
    expect(result.deep).toBe(false);
    expect(result.summary).toContain(label);
  });

  it("checks a shallow framework before React, since several ship React too", () => {
    const result = detectProject(
      ["package.json"],
      [pkg("package.json", { preact: "10.0.0", react: "19.0.0" })],
    );
    expect(result.kind).toBe("unsupported");
    expect(result.summary).toContain("Preact");
  });

  it("still promises a map for a repo it does not recognise at all", () => {
    const result = detectProject(
      ["main.py", "requirements.txt", "bot/strategy.py"],
      [],
    );
    expect(result.kind).toBe("unsupported");
    expect(result.deep).toBe(false);
    // D26: never tell someone their repository is unsupported. Offer the
    // shallower map and be honest that its connections are guesses.
    expect(result.summary).toContain("지도");
    expect(result.summary).toContain("짐작");
  });
});

describe("detectProject — hygiene", () => {
  it("ignores vendored directories when looking for signals", () => {
    const result = detectProject(
      ["node_modules/react/index.js", "node_modules/some-pkg/index.html", "main.py"],
      [],
    );
    expect(result.kind).toBe("unsupported");
  });

  it("never uses the forbidden graph vocabulary in anything a user reads", () => {
    const cases: [string[], PackageManifest[]][] = [
      [["app/page.tsx"], [pkg("package.json", { next: "16" })]],
      [["index.html", "a.html"], []],
      [["main.py"], []],
    ];
    for (const [paths, manifests] of cases) {
      expect(detectProject(paths, manifests).summary).not.toMatch(
        /노드|엣지|node|edge|entity|triple|ontology/i,
      );
    }
  });
});

describe("manifestsToFetch", () => {
  it("prefers the shallowest manifests and bounds how many we fetch", () => {
    const paths = [
      "apps/web/deep/package.json",
      "package.json",
      "frontend/package.json",
      "backend/package.json",
      "packages/ui/package.json",
      "packages/api/package.json",
    ];
    const chosen = manifestsToFetch(paths, 3);
    expect(chosen).toHaveLength(3);
    expect(chosen[0]).toBe("package.json");
    expect(chosen).toContain("backend/package.json");
    expect(chosen).toContain("frontend/package.json");
  });

  it("skips manifests inside vendored directories", () => {
    expect(manifestsToFetch(["node_modules/react/package.json", "package.json"])).toEqual([
      "package.json",
    ]);
  });
});
