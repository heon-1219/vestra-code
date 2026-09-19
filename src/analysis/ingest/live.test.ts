import { describe, expect, it } from "vitest";

import { ingestRepo } from "./index";

/**
 * Hits the network and a specific repository, so it is opt-in: `npm test` must
 * stay hermetic and must not depend on GitHub being reachable or on anonymous
 * rate limit headroom. Run it deliberately:
 *
 *   VESTRA_LIVE=1 npm test -- src/analysis/ingest/live.test.ts
 */
const live = process.env.VESTRA_LIVE ? describe : describe.skip;

live("ingest against a real repository", () => {
  it("downloads, strips the archive prefix, and selects source", async () => {
    const result = await ingestRepo("heon-1219", "coding-interview-prep", "master", null);
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (!result.ok) return;

    const { files, skipped, limitsHit, cleanup } = result.value;
    const text = files.filter((f) => f.read !== null);
    const assets = files.filter((f) => f.read === null);

    console.log(`  text=${text.length} assets=${assets.length} skipped=${skipped.length} limits=${JSON.stringify(limitsHit)}`);
    console.log(`  paths: ${text.map((f) => f.path).sort().join(", ")}`);

    // D18: no stored path may carry the archive's {owner}-{repo}-{sha} prefix.
    for (const file of files) {
      expect(file.path, "archive prefix leaked into path").not.toMatch(/coding-interview-prep-[0-9a-f]{7,}/);
      expect(file.path, "backslash in stored path").not.toContain("\\");
      expect(file.path.startsWith("/"), "absolute stored path").toBe(false);
    }

    expect(text.length).toBeGreaterThan(5);
    expect(files.some((f) => f.path === "package.json")).toBe(true);
    expect(files.some((f) => f.path.startsWith("components/"))).toBe(true);

    // The reader must actually work.
    const pkg = text.find((f) => f.path === "package.json");
    expect(pkg?.read?.()).toContain("\"next\"");

    await cleanup();
  }, 120000);
});
