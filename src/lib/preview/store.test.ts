import { describe, expect, it } from "vitest";

import type { Db } from "@/db";

import {
  listProjectFiles,
  readProjectFiles,
  STORE_BUDGET_BYTES,
  STORE_MAX_ROWS,
  storeDecision,
  storeProjectFiles,
  type StorableFile,
  type StoredFile,
} from "./store";

/**
 * The caps and the batching, without a database.
 *
 * Everything worth getting wrong in this module is arithmetic: which files are
 * kept, in what order the budget runs out, and how the kept ones are split into
 * statements. A real Postgres would test the same arithmetic far more slowly
 * and would not test it any harder — the opt-in DB test covers the round trip.
 */

/** Records what each INSERT was handed, which is the thing under test. */
function fakeDb() {
  const batches: { path: string; size: number }[][] = [];
  const db = {
    insert() {
      return {
        values(rows: { path: string; size: number }[]) {
          batches.push(rows.map((row) => ({ path: row.path, size: row.size })));
          return { onConflictDoUpdate: async () => undefined };
        },
      };
    },
  };
  return { db: db as unknown as Db, batches };
}

function file(path: string, size: number): StorableFile {
  return { path, content: Buffer.alloc(size) };
}

describe("storeDecision", () => {
  it("keeps a file we can draw", () => {
    expect(storeDecision("src/app.ts", 2_000, STORE_BUDGET_BYTES).keep).toBe(true);
    expect(storeDecision("docs/plan.pdf", 2_000, STORE_BUDGET_BYTES).keep).toBe(true);
    expect(storeDecision("public/logo.png", 2_000, STORE_BUDGET_BYTES).keep).toBe(true);
  });

  it("refuses a kind with no viewer, because storing it helps nobody", () => {
    // The person still could not open it; the bytes would be pure cost.
    //
    // A zip rather than a spreadsheet, and that is the point: which formats have
    // a viewer changes as viewers are written, and this test is about the rule,
    // not about one extension. An archive is one we will never draw.
    const decision = storeDecision("archive/backup.zip", 2_000, STORE_BUDGET_BYTES);
    expect(decision).toMatchObject({ keep: false, reason: "unsupported" });
  });

  it("refuses a file over its own kind's ceiling, not some global one", () => {
    // 12 MB: fine for a PDF (20 MB), over the line for an image (8 MB). The
    // ceiling that decides what we render decides what we keep.
    expect(storeDecision("a/big.pdf", 12 * 1024 * 1024, STORE_BUDGET_BYTES).keep).toBe(true);
    expect(storeDecision("a/big.png", 12 * 1024 * 1024, STORE_BUDGET_BYTES)).toMatchObject({
      keep: false,
      reason: "too_large",
    });
  });

  it("refuses what does not fit in the budget left", () => {
    expect(storeDecision("a/photo.png", 5_000, 4_999)).toMatchObject({
      keep: false,
      reason: "budget",
    });
  });
});

describe("storeProjectFiles", () => {
  it("keeps what fits and reports what it refused", async () => {
    const { db, batches } = fakeDb();
    const outcome = await storeProjectFiles(db, "p1", [
      file("src/a.ts", 100),
      file("archive/b.zip", 100),
      file("img/c.png", 100),
    ]);

    expect(outcome.stored).toBe(2);
    expect(outcome.storedBytes).toBe(200);
    expect(outcome.refused).toEqual([{ path: "archive/b.zip", reason: "unsupported" }]);
    expect(batches).toHaveLength(1);
  });

  it("spends the budget in order, and one refusal does not end the run", async () => {
    const { db } = fakeDb();
    const mb = 1024 * 1024;
    // 32 MB of pictures, each exactly at the image ceiling, leaves 8 MB. The
    // PDF is under its OWN ceiling (20 MB) and over what is left, which is the
    // case that distinguishes a budget refusal from a size refusal.
    const outcome = await storeProjectFiles(db, "p1", [
      file("a.png", 8 * mb),
      file("b.png", 8 * mb),
      file("c.png", 8 * mb),
      file("d.png", 8 * mb),
      file("big.pdf", 20 * mb),
      file("after.ts", 10),
    ]);

    // The small file after the refusal is still kept: running out of room for
    // one file is not running out for every file, and stopping at the first
    // refusal would silently drop the rest of the folder.
    expect(outcome.stored).toBe(5);
    expect(outcome.refused).toEqual([{ path: "big.pdf", reason: "budget" }]);
  });

  it("counts a budget already spent by an earlier batch", async () => {
    const { db } = fakeDb();
    const outcome = await storeProjectFiles(
      db,
      "p1",
      [file("a.png", 1_000)],
      { bytes: STORE_BUDGET_BYTES - 999, rows: 4 },
    );
    expect(outcome.stored).toBe(0);
    expect(outcome.refused).toEqual([{ path: "a.png", reason: "budget" }]);
  });

  it("stops at the row ceiling even when there are bytes to spare", async () => {
    const { db } = fakeDb();
    const outcome = await storeProjectFiles(db, "p1", [file("a.ts", 1)], {
      bytes: 0,
      rows: STORE_MAX_ROWS,
    });
    expect(outcome.refused).toEqual([{ path: "a.ts", reason: "count" }]);
  });

  it("splits into statements by row count", async () => {
    const { db, batches } = fakeDb();
    const files = Array.from({ length: 450 }, (_, i) => file(`src/f${i}.ts`, 10));
    const outcome = await storeProjectFiles(db, "p1", files);

    expect(outcome.stored).toBe(450);
    // 200 rows per statement, so three of them — not one 450-row INSERT.
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
  });

  it("splits into statements by weight, not only by count", async () => {
    const { db, batches } = fakeDb();
    // Three 1 MB images: under the 200-row ceiling, over the 2 MB one.
    const files = Array.from({ length: 3 }, (_, i) =>
      file(`img/${i}.png`, 1024 * 1024),
    );
    await storeProjectFiles(db, "p1", files);

    expect(batches.map((b) => b.length)).toEqual([2, 1]);
  });

  it("writes nothing when there is nothing to write", async () => {
    const { db, batches } = fakeDb();
    const outcome = await storeProjectFiles(db, "p1", [file("a.zip", 10)]);
    expect(outcome.stored).toBe(0);
    // An empty INSERT is a syntax error in Postgres, so this is not cosmetic.
    expect(batches).toHaveLength(0);
  });
});

/** Records the columns of each SELECT, which is half of what is under test. */
function fakeReadDb(rows: StoredFile[]) {
  const asked: string[][] = [];

  type Chain = {
    from: () => Chain;
    where: () => Chain;
    orderBy: () => Promise<unknown[]>;
  };

  const db = {
    select(columns: Record<string, unknown>) {
      const wanted = Object.keys(columns);
      asked.push(wanted);
      const answer = wanted.includes("content")
        ? rows
        : rows.map((row) => ({ path: row.path, size: row.size }));
      const chain: Chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => Promise.resolve(answer),
      };
      return chain;
    },
  };

  return { db: db as unknown as Db, asked };
}

describe("reading files back", () => {
  const kept: StoredFile[] = [
    { path: "src/app.ts", size: 3, content: Buffer.from("abc", "utf8") },
  ];

  it("lists what a project kept without moving a byte of it", async () => {
    const { db, asked } = fakeReadDb(kept);
    const listed = await listProjectFiles(db, "p1");

    expect(listed).toEqual([{ path: "src/app.ts", size: 3 }]);
    // The whole reason this is not one function: a project may hold 40 MB of
    // photographs, and asking what it has must not fetch them.
    expect(asked).toEqual([["path", "size"]]);
  });

  it("fetches the bytes only when asked for named files", async () => {
    const { db, asked } = fakeReadDb(kept);
    const files = await readProjectFiles(db, "p1", ["src/app.ts"]);

    expect(files[0].content.toString("utf8")).toBe("abc");
    expect(asked[0]).toContain("content");
  });

  it("asks nothing at all when nothing is named", async () => {
    const { db, asked } = fakeReadDb(kept);
    // `IN ()` is not valid SQL, and "none of them" is a real question with a
    // real answer rather than an error.
    await expect(readProjectFiles(db, "p1", [])).resolves.toEqual([]);
    expect(asked).toHaveLength(0);
  });

  it("reads in batches rather than one enormous IN list", async () => {
    const { db, asked } = fakeReadDb([]);
    const paths = Array.from({ length: 1_200 }, (_, i) => `src/f${i}.ts`);
    await readProjectFiles(db, "p1", paths);

    // One bound parameter per path against Postgres' ceiling of 65,535.
    expect(asked).toHaveLength(3);
  });
});
