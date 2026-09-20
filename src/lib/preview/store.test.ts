import { randomUUID } from "node:crypto";

import { config } from "dotenv";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { projects, user } from "@/db/schema";

import {
  escapeBytes,
  listProjectFiles,
  readProjectFiles,
  searchProjectFiles,
  STORE_BUDGET_BYTES,
  STORE_MAX_ROWS,
  storeDecision,
  storeProjectFiles,
  unescapeBytes,
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

describe("the spelling Postgres uses for bytes", () => {
  it("escapes what encode(bytea, 'escape') escapes, and nothing else", () => {
    // Verified against the production database rather than remembered: NUL, a
    // backslash and the high bit, while a tab and a newline go through raw.
    // `byteaout` escapes control characters too and this encoder does not.
    expect(escapeBytes(Buffer.from([0x41, 0x09, 0x0a]))).toBe("A\t\n");
    expect(escapeBytes(Buffer.from([0x5c]))).toBe("\\\\");
    expect(escapeBytes(Buffer.from([0x00]))).toBe("\\000");
    expect(escapeBytes(Buffer.from("결제", "utf8"))).toBe("\\352\\262\\260\\354\\240\\234");
  });

  it("reads its own spelling back, byte for byte", () => {
    for (const word of ["결제", "stop_loss", "a\\b", "탭\there", ""]) {
      expect(unescapeBytes(escapeBytes(Buffer.from(word, "utf8")))).toBe(word);
    }
  });
});

/**
 * The search, against a real Postgres, because there is nothing else it could
 * be tested against.
 *
 * Every way this can go wrong is SQL: `encode(bytea, 'escape')` spelling bytes
 * the way `escapeBytes` above believes it does, `string_to_array` numbering
 * lines the way an editor does, `array_position` carrying the caller's ranking
 * through, and a count that survives a search that matched nothing. A mock
 * database would agree with whatever this code believes and prove none of it.
 *
 *   VESTRA_DB=1 npm test -- src/lib/preview/store.test.ts
 */
config({ path: ".env.local", quiet: true });

const withDb = process.env.VESTRA_DB ? describe : describe.skip;

const TEST_USER_ID = "vestra-test-store-user";
const TEST_PROJECT_PREFIX = "vestra-test-store-";

withDb("searchProjectFiles against a real database", () => {
  let pool: Pool;
  let db: Db;
  let projectId: string;

  const remove = async () => {
    await db.delete(projects).where(like(projects.id, `${TEST_PROJECT_PREFIX}%`));
    await db.delete(user).where(eq(user.id, TEST_USER_ID));
  };

  const kept: StorableFile[] = [
    {
      path: "src/checkout.py",
      content: Buffer.from(
        ["import stripe", "", "def pay():", '    # 결제를 여기서 해요', "    return STOP_LOSS", ""].join("\n"),
        "utf8",
      ),
    },
    {
      // CRLF, because a line number that is off by one on a Windows upload is
      // a citation that points at the wrong line.
      path: "src/loud.ts",
      content: Buffer.from(
        Array.from({ length: 8 }, (_, i) => `const stripe${i} = 1;`).join("\r\n"),
        "utf8",
      ),
    },
    {
      // Bytes, not text: a PNG with NUL in it that happens to contain the word.
      path: "public/logo.png",
      content: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
        Buffer.from("stripe", "utf8"),
        Buffer.from([0x00, 0xff]),
      ]),
    },
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    db = drizzle(pool, { schema });
    await remove();
    await db.insert(user).values({
      id: TEST_USER_ID,
      name: "store test",
      email: "store-test@vestra.invalid",
      emailVerified: false,
    });
    projectId = `${TEST_PROJECT_PREFIX}${randomUUID()}`;
    await db.insert(projects).values({
      id: projectId,
      userId: TEST_USER_ID,
      repoOwner: null,
      repoName: null,
      repoUrl: null,
      defaultBranch: null,
      displayName: "store fixture",
      kind: "python",
      source: "upload",
    });
    await storeProjectFiles(db, projectId, kept);
  }, 60_000);

  afterAll(async () => {
    await remove();
    await pool.end();
  }, 60_000);

  const paths = kept.map((f) => f.path);

  it("finds a word in the bytes and says which line it is on", async () => {
    const found = await searchProjectFiles(db, projectId, "import stripe", { paths });
    expect(found.matches).toContainEqual({
      path: "src/checkout.py",
      line: 1,
      text: "import stripe",
    });
  });

  it("finds Korean, which is four bytes Postgres never sees as text", async () => {
    const found = await searchProjectFiles(db, projectId, "결제", { paths });
    expect(found.matches).toEqual([
      { path: "src/checkout.py", line: 4, text: "    # 결제를 여기서 해요" },
    ]);
  });

  it("does not care about case, the way the loop's own matcher does not", async () => {
    const found = await searchProjectFiles(db, projectId, "stop_loss", { paths });
    expect(found.matches.map((m) => m.line)).toEqual([5]);
  });

  it("counts lines the way an editor does, through a CRLF file", async () => {
    const found = await searchProjectFiles(db, projectId, "stripe7", { paths });
    // Line 8 of eight, and no stray carriage return riding on the text.
    expect(found.matches).toEqual([
      { path: "src/loud.ts", line: 8, text: "const stripe7 = 1;" },
    ]);
  });

  it("never looks inside a file that is not text, whatever its bytes say", async () => {
    const found = await searchProjectFiles(db, projectId, "stripe", { paths });
    expect(found.matches.some((m) => m.path === "public/logo.png")).toBe(false);
    // And it is not counted as looked-inside either, so the caller can say how
    // many it could not open rather than implying it saw them all.
    expect(found.searched).toBe(2);
  });

  it("keeps one loud file from crowding out the quiet ones", async () => {
    const found = await searchProjectFiles(db, projectId, "stripe", {
      paths,
      perFile: 3,
      limit: 10,
    });
    expect(found.matches.filter((m) => m.path === "src/loud.ts")).toHaveLength(3);
    expect(found.matches.some((m) => m.path === "src/checkout.py")).toBe(true);
  });

  it("ranks the matches in the order the caller asked for them", async () => {
    const forward = await searchProjectFiles(db, projectId, "stripe", { paths });
    const backward = await searchProjectFiles(db, projectId, "stripe", {
      paths: [...paths].reverse(),
    });
    expect(forward.matches[0].path).toBe("src/checkout.py");
    expect(backward.matches[0].path).toBe("src/loud.ts");
  });

  it("says how many files it looked inside even when it found nothing", async () => {
    // The case where the number matters most: "없었어요" is only allowed to
    // mean "not in the two files I opened".
    const found = await searchProjectFiles(db, projectId, "zzz-not-here", { paths });
    expect(found.matches).toEqual([]);
    expect(found.searched).toBe(2);
  });

  it("narrows to a folder without treating the prefix as a pattern", async () => {
    const found = await searchProjectFiles(db, projectId, "stripe", {
      paths,
      prefix: "src/",
    });
    expect(found.matches.every((m) => m.path.startsWith("src/"))).toBe(true);
    expect(found.searched).toBe(2);

    // `%` is a wildcard in LIKE and a plain character in a path.
    const none = await searchProjectFiles(db, projectId, "stripe", {
      paths,
      prefix: "s%c/",
    });
    expect(none.searched).toBe(0);
  });

  it("asks nothing at all when there is nothing to look inside", async () => {
    await expect(
      searchProjectFiles(db, projectId, "stripe", { paths: [] }),
    ).resolves.toEqual({ matches: [], searched: 0 });
  });

  it("looks only inside the files it was handed", async () => {
    const found = await searchProjectFiles(db, projectId, "stripe", {
      paths: ["src/checkout.py"],
    });
    expect(found.searched).toBe(1);
    expect(found.matches.every((m) => m.path === "src/checkout.py")).toBe(true);
  });

  /**
   * The claim this module makes, measured rather than argued.
   *
   * Its own switch because it writes a real project's worth of rows to a real
   * database and then deletes them, which is not something an ordinary test
   * run should do:
   *
   *   VESTRA_DB=1 VESTRA_DB_MEASURE=1 npm test -- src/lib/preview/store.test.ts
   *
   * Best of several on both sides, and the machine this runs on is busy — the
   * number to look at is the ratio, not the milliseconds.
   */
  it.skipIf(!process.env.VESTRA_DB_MEASURE)(
    "searches a whole project for less than sixty files cost to fetch",
    async () => {
      // Real-sized files, because the sweep's cost is mostly bytes on the wire
      // and a fixture of one-line modules would flatter it into looking fine.
      // About 10 KB each, which is what a module in this repository weighs.
      const body = Array.from(
        { length: 200 },
        (_, line) => `  const value${line} = compute(${line}); // 값을 계산해요`,
      ).join("\n");
      const many = Array.from({ length: 200 }, (_, i) => ({
        path: `bulk/mod${String(i).padStart(3, "0")}.ts`,
        content: Buffer.from(
          [
            `// 파일 ${i}`,
            "import { pay } from './pay';",
            i === 175 ? "const stop_loss = 0.02;" : "const rate = 0.01;",
            "export function run() {",
            body,
            "  return pay(rate);",
            "}",
            "",
          ].join("\n"),
          "utf8",
        ),
      }));
      await storeProjectFiles(db, projectId, many);
      const paths = many.map((f) => f.path);

      const best = async (runs: number, work: () => Promise<unknown>) => {
        let ms = Infinity;
        for (let run = 0; run < runs; run += 1) {
          const at = Date.now();
          await work();
          ms = Math.min(ms, Date.now() - at);
        }
        return ms;
      };

      // Before: what the sweep does on an upload — sixty files, one query per
      // file, six at a time.
      const sweep = await best(3, async () => {
        for (let at = 0; at < 60; at += 6) {
          await Promise.all(
            paths.slice(at, at + 6).map((p) => readProjectFiles(db, projectId, [p])),
          );
        }
      });

      let found = { matches: [] as { path: string }[], searched: 0 };
      const query = await best(5, async () => {
        found = await searchProjectFiles(db, projectId, "stop_loss", { paths });
      });

      console.log(
        `[measure] 60 files fetched: ${sweep}ms | all ${found.searched} searched: ${query}ms`,
      );
      // The one match is the 176th file by path, which the sixty-file sweep
      // could never have reached at all.
      expect(found.matches.map((m) => m.path)).toEqual(["bulk/mod175.ts"]);
      expect(found.searched).toBeGreaterThanOrEqual(200);
      // Not a millisecond budget: the whole project, searched, against sixty
      // files fetched, on the same connection in the same run.
      expect(query).toBeLessThan(sweep);
    },
    120_000,
  );
});
