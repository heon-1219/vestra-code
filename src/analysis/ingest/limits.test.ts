import { describe, expect, it } from "vitest";

import { classifyFile, LIMITS } from "./limits";

describe("classifyFile", () => {
  it("keeps the source a person actually wrote", () => {
    expect(classifyFile("src/app/page.tsx", 2_000)).toBe("text");
    expect(classifyFile("components/Tracker.jsx", 9_000)).toBe("text");
    expect(classifyFile("lib/plan.js", 1_200)).toBe("text");
    expect(classifyFile("index.html", 4_000)).toBe("text");
    expect(classifyFile("styles.css", 8_000)).toBe("text");
  });

  it("records binaries as assets rather than dropping them", () => {
    // Dropping these would make "nothing on your site uses this photo"
    // unbuildable without re-ingesting every existing project.
    expect(classifyFile("assets/me sitting 3.jpg", 900_000)).toBe("asset");
    expect(classifyFile("public/logo.svg", 3_000)).toBe("asset");
    expect(classifyFile("fonts/Pretendard.woff2", 400_000)).toBe("asset");
  });

  it("skips vendored and generated directories at any depth", () => {
    expect(classifyFile("node_modules/react/index.js", 100)).toBe("skip");
    expect(classifyFile("packages/ui/node_modules/x/a.ts", 100)).toBe("skip");
    expect(classifyFile(".next/static/chunk.js", 100)).toBe("skip");
    expect(classifyFile("dist/app.js", 100)).toBe("skip");
    expect(classifyFile("coverage/lcov-report/index.html", 100)).toBe("skip");
  });

  it("skips lockfiles, which are enormous and tell us nothing", () => {
    expect(classifyFile("package-lock.json", 900_000)).toBe("skip");
    expect(classifyFile("pnpm-lock.yaml", 400_000)).toBe("skip");
    expect(classifyFile("Cargo.lock", 40_000)).toBe("skip");
  });

  it("skips bundles, maps and declaration files", () => {
    expect(classifyFile("public/app.min.js", 200_000)).toBe("skip");
    expect(classifyFile("public/vendor.bundle.js", 200_000)).toBe("skip");
    expect(classifyFile("dist/app.js.map", 200_000)).toBe("skip");
    expect(classifyFile("types/index.d.ts", 5_000)).toBe("skip");
  });

  it("skips a text file that is too large to be hand-written", () => {
    expect(classifyFile("src/generated/client.ts", LIMITS.maxFileBytes + 1)).toBe("skip");
    expect(classifyFile("src/generated/client.ts", LIMITS.maxFileBytes - 1)).toBe("text");
  });

  it("keeps package.json, which detection depends on", () => {
    expect(classifyFile("package.json", 800)).toBe("text");
    expect(classifyFile("frontend/package.json", 800)).toBe("text");
  });

  it("skips file types we have no analyzer for", () => {
    expect(classifyFile("bin/tool.exe", 100)).toBe("skip");
    expect(classifyFile("data.sqlite", 100)).toBe("skip");
    expect(classifyFile("LICENSE", 1_000)).toBe("skip");
  });
});

describe("the cap is measured on source, not on repository size", () => {
  it("would accept a repo whose weight is entirely binary", () => {
    // The founder's portfolio is ~110 MB of archive for ~200 KB of text. A
    // byte cap on the repository would reject the very repo that motivated
    // static-site support (D6) at the front door.
    const portfolio = [
      ...Array.from({ length: 40 }, (_, i) => ({
        path: `assets/photo-${i}.jpg`,
        size: 2_500_000,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({ path: `p${i}.html`, size: 12_000 })),
      { path: "styles.css", size: 40_000 },
    ];

    const text = portfolio.filter((f) => classifyFile(f.path, f.size) === "text");
    const assets = portfolio.filter((f) => classifyFile(f.path, f.size) === "asset");
    const textBytes = text.reduce((sum, f) => sum + f.size, 0);

    expect(assets).toHaveLength(40);
    expect(text).toHaveLength(11);
    expect(textBytes).toBeLessThan(LIMITS.maxTextBytes);
    expect(text.length).toBeLessThan(LIMITS.maxSourceFiles);
  });
});
