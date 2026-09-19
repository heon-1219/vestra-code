import { describe, expect, it } from "vitest";

import {
  cellText,
  clipNotice,
  clipTable,
  columnLabel,
  delimiterFor,
  isBlankTable,
  parseDelimited,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
} from "./spreadsheet";

/**
 * A `.csv` was shown as plain text for months, and the comment explaining why
 * named one case: a comma inside a quoted field. These are that case and its
 * relatives, written down first so that the parser is allowed to exist only
 * because they pass — the alternative was never "a slightly wrong table", it
 * was a table with every column after the quote shifted one place, which is
 * wrong without looking wrong.
 */
describe("parseDelimited", () => {
  it("reads plain rows", () => {
    expect(parseDelimited("a,b,c\n1,2,3", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps a separator that is inside quotes", () => {
    // The headline case. `split(",")` makes this four fields and puts 30 under
    // the address column.
    expect(parseDelimited('홍길동,"서울, 강남구",30', ",")).toEqual([
      ["홍길동", "서울, 강남구", "30"],
    ]);
  });

  it('reads "" inside quotes as one quote, because CSV has no backslash', () => {
    expect(parseDelimited('note\n"그는 ""좋아요"" 라고 했어요"', ",")).toEqual([
      ["note"],
      ['그는 "좋아요" 라고 했어요'],
    ]);
  });

  it("keeps a quoted field that is only a pair of quotes", () => {
    expect(parseDelimited('a,"",c', ",")).toEqual([["a", "", "c"]]);
  });

  it("keeps a newline that is inside quotes, instead of tearing the record in two", () => {
    // Excel writes these. Splitting on newlines first would give two rows, the
    // first of them missing its last column and the second missing its first.
    expect(parseDelimited('a,"1행\n2행",c\nd,e,f', ",")).toEqual([
      ["a", "1행\n2행", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("treats CRLF as one line break, between records and inside a field", () => {
    expect(parseDelimited("a,b\r\nc,d", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    // Normalised to the same break the code viewer shows, so one cell does not
    // render with a stray carriage return in the middle of it.
    expect(parseDelimited('"1행\r\n2행"', ",")).toEqual([["1행\n2행"]]);
  });

  it("does not turn the newline at the end of a file into an extra row", () => {
    // Same judgement `splitLines` makes for code: a file that ends in a newline
    // and a file that ends in a blank line cannot be told apart, and every
    // editor picks this answer.
    expect(parseDelimited("a,b\nc,d\n", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps a blank line that is in the middle, because the file has one", () => {
    expect(parseDelimited("a\n\nb", ",")).toEqual([["a"], [""], ["b"]]);
  });

  it("drops a byte order mark rather than gluing it to the first cell", () => {
    // Built rather than typed, for the reason in `preview-kinds.test.ts`: an
    // invisible character pasted into source is a character that gets mangled
    // in transit and then silently stops being tested.
    const bom = String.fromCharCode(0xfeff);
    expect(parseDelimited(`${bom}이름,나이\n홍길동,30`, ",")).toEqual([
      ["이름", "나이"],
      ["홍길동", "30"],
    ]);
  });

  it("reads a quote in the middle of an unquoted field as a character", () => {
    // `3" 파이프` is a measurement, not the start of a quoted field. The format
    // does not say what this means, and refusing the file would leave the
    // reader with nothing.
    expect(parseDelimited('3" 파이프,2개', ",")).toEqual([['3" 파이프', "2개"]]);
  });

  it("closes a field whose quote was never closed instead of losing it", () => {
    // A truncated export. The last field is still shown; nothing hangs.
    expect(parseDelimited('a,"b,c', ",")).toEqual([["a", "b,c"]]);
  });

  it("splits a .tsv on tabs, including a comma that is only data there", () => {
    expect(parseDelimited("이름\t주소\n홍길동\t서울, 강남구", "\t")).toEqual([
      ["이름", "주소"],
      ["홍길동", "서울, 강남구"],
    ]);
  });

  it("reads an empty file as no rows at all", () => {
    expect(parseDelimited("", ",")).toEqual([]);
  });
});

describe("delimiterFor", () => {
  it("knows the two it can read and nothing else", () => {
    expect(delimiterFor("data/rows.csv")).toBe(",");
    expect(delimiterFor("data/rows.tsv")).toBe("\t");
    expect(delimiterFor("data/book.xlsx")).toBeNull();
    expect(delimiterFor("src/app.ts")).toBeNull();
  });
});

describe("cellText", () => {
  it("prints a number rather than formatting it", () => {
    // `toLocaleString` would turn the year 2024 into "2,024" — a number that is
    // not in their file, on the one screen whose job is to be checkable.
    expect(cellText(2024)).toBe("2024");
    expect(cellText(1200)).toBe("1200");
    expect(cellText(3.5)).toBe("3.5");
  });

  it("says TRUE and FALSE, which is what the cell says in Excel", () => {
    expect(cellText(true)).toBe("TRUE");
    expect(cellText(false)).toBe("FALSE");
  });

  it("reads a date in UTC, so nobody west of it sees the day before", () => {
    // The reader builds a date from the workbook's day number at UTC midnight.
    // Local getters would shift it by the reader's own offset.
    expect(cellText(new Date(Date.UTC(2026, 8, 20)))).toBe("2026-09-20");
    expect(cellText(new Date(Date.UTC(2026, 0, 5, 9, 30)))).toBe("2026-01-05 09:30");
  });

  it("leaves an empty cell empty", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
    expect(cellText("")).toBe("");
  });

  it("prints nothing rather than a JavaScript internal", () => {
    // A blank is a smaller lie about somebody's data than "[object Object]".
    expect(cellText({ a: 1 })).toBe("");
    expect(cellText(new Date(Number.NaN))).toBe("");
    expect(cellText(Number.NaN)).toBe("");
  });

  it("keeps a string exactly as it came out of the file", () => {
    expect(cellText("  띄어쓰기  ")).toBe("  띄어쓰기  ");
  });
});

describe("columnLabel", () => {
  it("counts the way a spreadsheet counts", () => {
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(25)).toBe("Z");
    expect(columnLabel(26)).toBe("AA");
    expect(columnLabel(51)).toBe("AZ");
    expect(columnLabel(52)).toBe("BA");
    expect(columnLabel(701)).toBe("ZZ");
    expect(columnLabel(702)).toBe("AAA");
  });
});

describe("clipTable", () => {
  const rows = (count: number, width: number) =>
    Array.from({ length: count }, (_, r) =>
      Array.from({ length: width }, (_, c) => `${r}:${c}`),
    );

  it("draws a small table whole", () => {
    const table = clipTable(rows(3, 2));
    expect(table.rows).toHaveLength(3);
    expect(table.totalRows).toBe(3);
    expect(table.totalColumns).toBe(2);
    expect(table.clippedRows).toBe(false);
    expect(table.clippedColumns).toBe(false);
  });

  it("caps both directions and still reports the real size", () => {
    // The reason the totals are measured over every row: a notice that said
    // "전체는 500줄이에요" because it only counted what it kept would be worse
    // than no notice at all.
    const table = clipTable(rows(TABLE_MAX_ROWS + 120, TABLE_MAX_COLUMNS + 14));
    expect(table.rows).toHaveLength(TABLE_MAX_ROWS);
    expect(table.rows[0]).toHaveLength(TABLE_MAX_COLUMNS);
    expect(table.totalRows).toBe(TABLE_MAX_ROWS + 120);
    expect(table.totalColumns).toBe(TABLE_MAX_COLUMNS + 14);
    expect(table.clippedRows).toBe(true);
    expect(table.clippedColumns).toBe(true);
  });

  it("draws well under a hundred thousand cells however big the file is", () => {
    // 40,000 × 400 is sixteen million cells. The fixture shares one row rather
    // than building them, because building them is slower than the thing being
    // tested — and because `clipTable` only ever reads a row's length past the
    // five hundredth, which is exactly the property that makes it safe here.
    const wide = Array.from({ length: 400 }, (_, c) => `c${c}`);
    const table = clipTable(Array.from({ length: 40_000 }, () => wide));
    expect(table.rows.length * table.rows[0].length).toBeLessThanOrEqual(15_000);
    expect(table.totalRows).toBe(40_000);
    expect(table.totalColumns).toBe(400);
  });

  it("squares off a ragged table so the row numbers keep pointing at the right cells", () => {
    const table = clipTable([["a"], ["b", "c", "d"], []]);
    expect(table.totalColumns).toBe(3);
    expect(table.rows).toEqual([
      ["a", "", ""],
      ["b", "c", "d"],
      ["", "", ""],
    ]);
  });

  it("turns every cell into text on the way through", () => {
    const table = clipTable([[1, true, null, new Date(Date.UTC(2026, 8, 20))]]);
    expect(table.rows[0]).toEqual(["1", "TRUE", "", "2026-09-20"]);
  });
});

describe("isBlankTable", () => {
  it("calls an empty sheet empty, however it arrived", () => {
    expect(isBlankTable(clipTable([]))).toBe(true);
    // A file that is a single newline parses to one row of one empty field.
    expect(isBlankTable(clipTable(parseDelimited("\n", ",")))).toBe(true);
    expect(isBlankTable(clipTable([[]]))).toBe(true);
    expect(isBlankTable(clipTable([["", ""]]))).toBe(true);
  });

  it("does not call a table with something in it empty", () => {
    expect(isBlankTable(clipTable([["a"]]))).toBe(false);
    expect(isBlankTable(clipTable([[""], [""]]))).toBe(false);
  });
});

describe("clipNotice", () => {
  it("says nothing when nothing was left out", () => {
    expect(clipNotice(clipTable([["a", "b"]]))).toBeNull();
  });

  it("says how much of a long table is on screen, and how long it really is", () => {
    const notice = clipNotice(clipTable(Array.from({ length: 12_480 }, () => ["a"])));
    expect(notice).toContain("500줄만");
    expect(notice).toContain("12,480줄");
  });

  it("says the same about columns, and joins the two without repeating itself", () => {
    const wide = clipTable(
      Array.from({ length: 900 }, () => Array.from({ length: 64 }, () => "a")),
    );
    const notice = clipNotice(wide);
    expect(notice).toContain("칸도 많아서");
    expect(notice).toContain("64칸");
    expect(notice).toContain("900줄");
  });

  it("does not say 칸도 when the columns are the only thing that was cut", () => {
    // "도" implies a first half of the sentence that would not be there.
    const notice = clipNotice(clipTable([Array.from({ length: 64 }, () => "a")]));
    expect(notice).toContain("칸이 많아서");
    expect(notice).not.toContain("칸도");
  });
});
