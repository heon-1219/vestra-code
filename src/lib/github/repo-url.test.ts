import { describe, expect, it } from "vitest";

import { parseRepoUrl, REPO_URL_MESSAGES } from "./repo-url";

function expectRepo(input: string, owner: string, repo: string) {
  const result = parseRepoUrl(input);
  expect(result.ok, `expected "${input}" to parse`).toBe(true);
  if (!result.ok) return;
  expect(result.value.owner).toBe(owner);
  expect(result.value.repo).toBe(repo);
  expect(result.value.url).toBe(`https://github.com/${owner}/${repo}`);
}

function expectError(input: string, error: string) {
  const result = parseRepoUrl(input);
  expect(result.ok, `expected "${input}" to be rejected`).toBe(false);
  if (result.ok) return;
  expect(result.error).toBe(error);
}

describe("parseRepoUrl — the shapes people actually paste", () => {
  it("accepts a plain repo URL", () => {
    expectRepo("https://github.com/heon-1219/vestra-code", "heon-1219", "vestra-code");
  });

  it("accepts http, no scheme, and a bare owner/repo", () => {
    expectRepo("http://github.com/vercel/next.js", "vercel", "next.js");
    expectRepo("github.com/vercel/next.js", "vercel", "next.js");
    expectRepo("vercel/next.js", "vercel", "next.js");
  });

  it("accepts www and a trailing slash", () => {
    expectRepo("https://www.github.com/vercel/next.js/", "vercel", "next.js");
  });

  it("accepts an SSH remote, which people copy from their terminal", () => {
    expectRepo("git@github.com:heon-1219/vestra-code.git", "heon-1219", "vestra-code");
    expectRepo("ssh://git@github.com/heon-1219/vestra-code.git", "heon-1219", "vestra-code");
  });

  it("accepts a clone URL ending in .git", () => {
    expectRepo("https://github.com/heon-1219/vestra-code.git", "heon-1219", "vestra-code");
  });

  it("takes the repo from a deep link instead of making the user edit it", () => {
    expectRepo(
      "https://github.com/heon-1219/coding-interview-prep/tree/master/components",
      "heon-1219",
      "coding-interview-prep",
    );
    expectRepo(
      "https://github.com/heon-1219/coding-interview-prep/blob/master/lib/plan.js#L42",
      "heon-1219",
      "coding-interview-prep",
    );
    expectRepo("https://github.com/vercel/next.js/pull/1234", "vercel", "next.js");
  });

  it("ignores query strings and fragments", () => {
    expectRepo("https://github.com/vercel/next.js?tab=readme#install", "vercel", "next.js");
  });

  it("tolerates surrounding whitespace", () => {
    expectRepo("  https://github.com/vercel/next.js  \n", "vercel", "next.js");
  });

  it("strips .git only as a suffix, so a repo named dotgit survives", () => {
    expectRepo("https://github.com/someone/dotgit", "someone", "dotgit");
    expectRepo("https://github.com/someone/git", "someone", "git");
  });
});

describe("parseRepoUrl — what it refuses, and why that matters", () => {
  it("rejects an empty string", () => {
    expectError("", "empty");
    expectError("   ", "empty");
  });

  it("rejects other hosts rather than pretending to support them", () => {
    expectError("https://gitlab.com/owner/repo", "not_github");
    expectError("https://bitbucket.org/owner/repo", "not_github");
    expectError("git@gitlab.com:owner/repo.git", "not_github");
  });

  it("rejects gists by name, since they are not repositories", () => {
    expectError("https://gist.github.com/someone/abc123", "gist");
  });

  it("rejects GitHub pages that look like owner/repo but are not", () => {
    // Telling someone their settings page is "a private repository" would be a
    // confusing lie, so these are named rather than guessed at.
    expectError("https://github.com/settings/profile", "not_a_repo");
    expectError("https://github.com/marketplace/actions/checkout", "not_a_repo");
    expectError("https://github.com/explore/things", "not_a_repo");
  });

  it("distinguishes a missing repo name from a malformed one", () => {
    expectError("https://github.com/heon-1219", "missing_repo");
    expectError("heon-1219", "missing_repo");
  });

  it("rejects owner names GitHub itself would not allow", () => {
    expectError("https://github.com/-leading/repo", "bad_owner");
    expectError("https://github.com/trailing-/repo", "bad_owner");
    expectError("https://github.com/double--hyphen/repo", "bad_owner");
    expectError(`https://github.com/${"a".repeat(40)}/repo`, "bad_owner");
  });

  it("rejects path traversal, whichever layer catches it", () => {
    // As a full URL these never reach our checks: the URL constructor
    // normalises "/owner/.." to "/" and "/owner/." to "/owner/" first. That is
    // the safe outcome, so assert what actually happens rather than what the
    // guard would have returned.
    expectError("https://github.com/owner/..", "not_a_repo");
    expectError("https://github.com/owner/.", "missing_repo");

    // The bare form skips URL parsing entirely, so here the guard is the only
    // thing standing between a traversal segment and a repo name.
    expectError("owner/..", "bad_repo");
    expectError("owner/.", "bad_repo");
  });

  it("has a plain-language message for every failure it can return", () => {
    const errors = [
      "empty",
      "not_github",
      "not_a_repo",
      "gist",
      "missing_repo",
      "bad_owner",
      "bad_repo",
    ] as const;
    for (const error of errors) {
      const message = REPO_URL_MESSAGES[error];
      expect(message, `missing message for ${error}`).toBeTruthy();
      // The brief forbids the graph vocabulary in anything a user reads.
      expect(message).not.toMatch(/노드|엣지|node|edge|entity|triple|ontology/i);
    }
  });
});
