import { describe, expect, it } from "vitest";

import { createTypescriptAnalyzer } from "@/analysis/typescript/analyzer";
import type { AnalysisEmitter } from "@/analysis/types";

import { ingestUpload, type UploadPayload } from "./upload";

function payload(partial: Partial<UploadPayload>): UploadPayload {
  return { texts: [], assets: [], skippedCount: 0, limitsHit: [], ...partial };
}

const silent: AnalysisEmitter = {
  phase: () => {},
  fileParsed: () => {},
  nodes: () => {},
  edges: () => {},
  fileSkipped: () => {},
};

describe("ingestUpload — an uploaded folder becomes an ordinary ingest", () => {
  it("writes text to disk so module resolution can actually find it", async () => {
    // Not kept in memory on purpose: ts-morph resolves `@/components/Button`
    // through the filesystem, so the file has to exist for the import to
    // resolve at all.
    const result = await ingestUpload(
      payload({
        texts: [
          { path: "src/lib/price.ts", content: "export function formatPrice(n: number) { return `${n}원`; }\n" },
          { path: "src/app/page.tsx", content: "import { formatPrice } from '@/lib/price';\nexport default function Page() { return <p>{formatPrice(1)}</p>; }\n" },
          { path: "tsconfig.json", content: '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}' },
        ],
      }),
    );

    try {
      expect(result.files.map((f) => f.path).sort()).toEqual([
        "src/app/page.tsx",
        "src/lib/price.ts",
        "tsconfig.json",
      ]);
      expect(result.files[0].read?.()).toContain("formatPrice");

      const { nodes, edges } = await createTypescriptAnalyzer().analyze(
        result.files,
        result.root,
        silent,
      );

      // The alias import resolved, which is the whole point of writing to disk.
      expect(
        edges.some(
          (e) =>
            e.type === "imports" &&
            e.source.filePath === "src/app/page.tsx" &&
            e.target.filePath === "src/lib/price.ts",
        ),
      ).toBe(true);
      expect(
        edges.some((e) => e.type === "calls" && e.target.name === "formatPrice"),
      ).toBe(true);
      expect(nodes.some((n) => n.ref.type === "route")).toBe(true);
    } finally {
      await result.cleanup();
    }
  });

  it("records an asset without ever receiving its bytes", async () => {
    const result = await ingestUpload(
      payload({ assets: [{ path: "assets/me sitting 3.jpg", size: 2_500_000 }] }),
    );
    try {
      const asset = result.files.find((f) => f.path === "assets/me sitting 3.jpg");
      expect(asset).toBeDefined();
      // `read: null` is exactly how ingest marks a file whose bytes we do not
      // have, so nothing downstream needs to know an upload happened.
      expect(asset?.read).toBeNull();
      expect(asset?.size).toBe(2_500_000);
    } finally {
      await result.cleanup();
    }
  });

  it("refuses a path that climbs out of the folder", async () => {
    // The browser filtered already, but a request is untrusted no matter which
    // page it claims to come from.
    const result = await ingestUpload(
      payload({
        texts: [
          { path: "../../../etc/passwd.ts", content: "export const x = 1;" },
          { path: "src/ok.ts", content: "export const ok = 1;" },
        ],
      }),
    );
    try {
      expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain("폴더 밖");
    } finally {
      await result.cleanup();
    }
  });

  it("re-applies the server's own filter rather than trusting the browser's", async () => {
    const result = await ingestUpload(
      payload({
        texts: [
          { path: "node_modules/react/index.js", content: "module.exports = {};" },
          { path: "package-lock.json", content: "{}" },
          { path: "src/app.ts", content: "export const a = 1;" },
        ],
      }),
    );
    try {
      expect(result.files.map((f) => f.path)).toEqual(["src/app.ts"]);
    } finally {
      await result.cleanup();
    }
  });

  it("cleans up the directory it created", async () => {
    const { existsSync } = await import("node:fs");
    const result = await ingestUpload(
      payload({ texts: [{ path: "a.ts", content: "export const a = 1;" }] }),
    );
    expect(existsSync(result.root)).toBe(true);
    await result.cleanup();
    expect(existsSync(result.root)).toBe(false);
  });
});
