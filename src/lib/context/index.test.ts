import { describe, expect, it, vi } from "vitest";

import type { Db } from "@/db";
import type { GraphItem } from "@/lib/graph/view";
import type { Llm, LlmReply } from "@/lib/llm/types";
import type { SourceReader } from "@/qa/source";

import { projectDigest } from "./index";

/**
 * When a digest is built, when it is fetched, and when neither happens.
 *
 * No database and no network. What is worth getting wrong here is ordering —
 * which of the cache, the file reads and the model call happen, and in what
 * order — and that is exactly what a fake can hold still. The round trip
 * through Postgres is one `INSERT` and one indexed `SELECT`; a mock would agree
 * with whatever this code believes about them and prove nothing, which is the
 * same line `src/lib/preview/store.test.ts` draws.
 */

/**
 * A database that keeps whatever was written and hands it back.
 *
 * The `where` predicate is ignored, so every test here stores at most one
 * digest — enough to test "was it built again?", which is the question. A fake
 * that parsed drizzle's condition objects would be testing drizzle.
 */
function fakeDb() {
  const rows: { basis: string; about: string; words: string[]; sources: string[] }[] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit: async () =>
                  rows.map(({ about, words, sources }) => ({ about, words, sources })),
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(row: { basis: string; about: string; words: string[]; sources: string[] }) {
          rows.push(row);
          return { onConflictDoNothing: async () => undefined };
        },
      };
    },
  };
  return { db: db as unknown as Db, rows };
}

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

const ITEMS = [file("README.md"), file("src/lib/format.ts")];

const REPLY: LlmReply = {
  text: JSON.stringify({ about: "가게 앱이에요.", words: [] }),
  toolCalls: [],
  usage: { inputTokens: 800, outputTokens: 60 },
  finishReason: "stop",
};

function fakeLlm() {
  const complete = vi.fn(async () => REPLY);
  return { llm: { complete } as unknown as Llm, complete };
}

const reader: SourceReader = async (path) =>
  path === "README.md"
    ? { ok: true, text: "# 가게\n물건을 파는 앱이에요." }
    : { ok: false, reason: "not_found" };

describe("a project with nothing written down", () => {
  it("costs no read and no model call", async () => {
    const { db } = fakeDb();
    const { llm, complete } = fakeLlm();
    const read = vi.fn(reader);

    const digest = await projectDigest({
      db,
      projectId: "p1",
      commitSha: "abc",
      items: [file("src/lib/format.ts")],
      read,
      llm,
    });

    // The loop then runs exactly as it does today. A smaller honest input.
    expect(digest).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("asks for nothing when the files cannot be opened at all", async () => {
    const { db } = fakeDb();
    const { llm, complete } = fakeLlm();
    const digest = await projectDigest({
      db,
      projectId: "p1",
      commitSha: "abc",
      items: ITEMS,
      read: null,
      llm,
    });
    expect(digest).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("gives back nothing when every candidate refuses to open", async () => {
    const { db } = fakeDb();
    const { llm, complete } = fakeLlm();
    const digest = await projectDigest({
      db,
      projectId: "p1",
      commitSha: "abc",
      items: ITEMS,
      read: async () => ({ ok: false, reason: "not_found" }),
      llm,
    });
    expect(digest).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("keyed on the commit", () => {
  it("builds it once and keeps it against that commit", async () => {
    const { db, rows } = fakeDb();
    const { llm, complete } = fakeLlm();

    const first = await projectDigest({
      db, projectId: "p1", commitSha: "abc", items: ITEMS, read: reader, llm,
    });

    expect(first?.about).toBe("가게 앱이에요.");
    expect(first?.sources).toEqual(["README.md"]);
    expect(complete).toHaveBeenCalledTimes(1);
    // The commit is the key, because the commit is exactly when a README stops
    // being true — and it is the same signal `analysis/incremental.ts` uses.
    expect(rows[0].basis).toBe("commit:abc");
  });

  it("reads no file at all on every question after the first", async () => {
    const { db } = fakeDb();
    const { llm, complete } = fakeLlm();
    const read = vi.fn(reader);
    const input = {
      db, projectId: "p1", commitSha: "abc", items: ITEMS, read, llm,
    };

    await projectDigest(input);
    read.mockClear();
    complete.mockClear();

    const again = await projectDigest(input);

    // The whole win: with a commit sha the cache is checked before anything is
    // opened, so a second question costs one indexed query.
    expect(again?.about).toBe("가게 앱이에요.");
    expect(read).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("with no commit to key on", () => {
  it("keys on the documents instead, and says what that costs", async () => {
    const { db, rows } = fakeDb();
    const { llm, complete } = fakeLlm();
    const read = vi.fn(reader);
    const input = {
      db, projectId: "p1", commitSha: null, items: ITEMS, read, llm,
    };

    await projectDigest(input);
    expect(rows[0].basis).toMatch(/^docs:[0-9a-f]{32}$/);

    read.mockClear();
    complete.mockClear();
    const again = await projectDigest(input);

    expect(again?.about).toBe("가게 앱이에요.");
    // The model call is saved, which is the expensive half. The reads are not,
    // because the documents ARE the key — stated here rather than discovered
    // later. For an upload those reads are rows in this same database.
    expect(read).toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("when the digest cannot be built", () => {
  it("keeps nothing and fails nothing", async () => {
    const { db, rows } = fakeDb();
    const complete = vi.fn(async () => {
      throw new Error("endpoint down");
    });

    const digest = await projectDigest({
      db,
      projectId: "p1",
      commitSha: "abc",
      items: ITEMS,
      read: reader,
      llm: { complete } as unknown as Llm,
    });

    expect(digest).toBeNull();
    // Nothing cached, so the next question tries again rather than inheriting
    // one bad minute for the life of the commit.
    expect(rows).toEqual([]);
  });
});
