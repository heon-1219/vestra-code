import { afterEach, describe, expect, it, vi } from "vitest";

import { compareCommits, fetchCommitSha } from "./api";

/**
 * What the compare call is allowed to claim.
 *
 * This is the only factual basis incremental re-analysis has for "which parts
 * changed", so the tests that matter most here are the ones about *not*
 * claiming: a list GitHub may have truncated, a word we do not recognise, a
 * rename with no previous name. Each of those has to come back marked, because
 * one level up an unmarked gap becomes a stale row nobody ever notices.
 *
 * Section 8's rule applies to every field: the response is untrusted input and
 * goes through a schema, so a shape we did not expect is a failure rather than
 * an `undefined` travelling into the planner.
 */

const OWNER = "heon-1219";
const REPO = "vestra-demo";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function respond(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compareCommits", () => {
  it("asks the compare endpoint for the three-dot range, and says who is asking", async () => {
    respond({ status: "ahead", files: [] });

    await compareCommits(OWNER, REPO, BASE, HEAD, "gho_abc");

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(call[0]).toBe(
      `https://api.github.com/repos/${OWNER}/${REPO}/compare/${BASE}...${HEAD}`,
    );
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_abc");
    expect(call[1].cache).toBe("no-store");
  });

  it("maps every status GitHub uses onto the four we act on", async () => {
    respond({
      status: "ahead",
      files: [
        { filename: "src/new.ts", status: "added" },
        { filename: "src/gone.ts", status: "removed" },
        { filename: "src/edit.ts", status: "modified" },
        { filename: "src/mode.ts", status: "changed" },
        { filename: "src/same.ts", status: "unchanged" },
        { filename: "src/copy.ts", status: "copied" },
        {
          filename: "src/after.ts",
          status: "renamed",
          previous_filename: "src/before.ts",
        },
      ],
    });

    const result = await compareCommits(OWNER, REPO, BASE, HEAD, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.gap).toBeNull();
    expect(result.value.files).toEqual([
      { path: "src/new.ts", previousPath: null, status: "added" },
      { path: "src/gone.ts", previousPath: null, status: "removed" },
      { path: "src/edit.ts", previousPath: null, status: "modified" },
      // A mode change and an edited-and-edited-back file are re-parsed rather
      // than reasoned about: parsing one file is free, being wrong is not.
      { path: "src/mode.ts", previousPath: null, status: "modified" },
      { path: "src/same.ts", previousPath: null, status: "modified" },
      // A copy is a path that did not exist before, which is all an id cares about.
      { path: "src/copy.ts", previousPath: null, status: "added" },
      { path: "src/after.ts", previousPath: "src/before.ts", status: "renamed" },
    ]);
  });

  it("marks a list GitHub may have truncated", async () => {
    respond({
      status: "ahead",
      files: Array.from({ length: 300 }, (_, i) => ({
        filename: `src/file-${i}.ts`,
        status: "modified",
      })),
    });

    const result = await compareCommits(OWNER, REPO, BASE, HEAD, null);
    expect(result.ok && result.value.gap).toBe("file_cap");
  });

  it("marks a status it does not understand, and leaves that file out", async () => {
    respond({
      status: "ahead",
      files: [
        { filename: "src/a.ts", status: "modified" },
        { filename: "src/b.ts", status: "teleported" },
      ],
    });

    const result = await compareCommits(OWNER, REPO, BASE, HEAD, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Marked, not guessed. We cannot tell whether that file needs adding,
    // re-parsing or deleting, and one level up the mark means "analyse
    // everything" rather than "analyse everything except b.ts".
    expect(result.value.gap).toBe("unknown_status");
    expect(result.value.files.map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  it("marks a rename it cannot undo", async () => {
    respond({
      status: "ahead",
      files: [{ filename: "src/after.ts", status: "renamed" }],
    });

    // Without the old path its rows would survive the sweep, and the user would
    // see the same file twice with their correction attached to the dead copy.
    const result = await compareCommits(OWNER, REPO, BASE, HEAD, null);
    expect(result.ok && result.value.gap).toBe("unknown_status");
  });

  it("carries a rewritten history through in the status", async () => {
    respond({ status: "diverged", files: [] });
    const result = await compareCommits(OWNER, REPO, BASE, HEAD, null);
    expect(result.ok && result.value.status).toBe("diverged");
  });

  it("treats a missing files array as no file changes", async () => {
    respond({ status: "identical" });
    const result = await compareCommits(OWNER, REPO, BASE, HEAD, null);
    expect(result.ok && result.value.files).toEqual([]);
  });

  it("reports a base commit GitHub no longer has", async () => {
    respond({ message: "Not Found" }, 404);
    const result = await compareCommits(OWNER, REPO, BASE, HEAD, null);
    expect(result).toMatchObject({ ok: false, error: "not_found" });
  });

  it("refuses a response whose shape is not the one we validated", async () => {
    respond({ status: "sideways", files: [] });
    expect(await compareCommits(OWNER, REPO, BASE, HEAD, null)).toMatchObject({
      ok: false,
      error: "malformed",
    });
  });

  it("does not throw when GitHub cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.reject(new Error("ENOTFOUND"))),
    );
    expect(await compareCommits(OWNER, REPO, BASE, HEAD, null)).toMatchObject({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("fetchCommitSha", () => {
  it("returns the commit a ref points at", async () => {
    respond({ sha: HEAD });
    expect(await fetchCommitSha(OWNER, REPO, "main", null)).toBe(HEAD);
  });

  it("returns null rather than failing the run", async () => {
    // A run without a recorded commit is a graph that cannot be dated, which is
    // worth strictly less than a run that did not happen.
    respond({ message: "Not Found" }, 404);
    expect(await fetchCommitSha(OWNER, REPO, "main", null)).toBeNull();
  });
});
