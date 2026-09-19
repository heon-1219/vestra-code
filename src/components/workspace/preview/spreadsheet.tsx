"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { extensionOf, formatBytes, type PreviewShape } from "./preview-kinds";

/**
 * A table, drawn as a table.
 *
 * The founder asked for 이미지, PDF, xlsx, 코드. Three of those opened; a
 * spreadsheet was refused before a byte moved, because reading one needs a
 * parser. This module is that parser's front door, and it covers two quite
 * different files under one word:
 *
 *   - **`.csv` and `.tsv` are already text.** Nothing is installed for them.
 *     What they need is a reader that understands quoting, which is the whole
 *     reason they were shown as plain text until now — see `parseDelimited`.
 *   - **`.xlsx` is a zip of XML** and needs a real reader. `read-excel-file` is
 *     dynamically imported the first time someone opens a workbook, so nobody
 *     who never opens one pays for it. (The obvious package, `xlsx`, is stale
 *     on the npm registry and its published version carries two unfixed
 *     advisories; a known-vulnerable parser running on user-supplied files is
 *     not a trade this product makes.)
 *
 * The rules this owes the person reading:
 *
 *   - **Nothing is claimed about their data.** No header row, no thousands
 *     separators, no guessed types. Row numbers and A/B/C column letters come
 *     from us and are obviously ours; everything inside a cell is theirs,
 *     printed as it came out of the file.
 *   - **Anything left out is said out loud**, in the same voice as the code
 *     viewer's "파일이 길어서 …줄만 보여 드려요".
 */

/* --------------------------------------------------------------- the logic */

/**
 * How much of a table we will draw at once.
 *
 * 500 × 30 is fifteen thousand cells, and a cell is one element. The code
 * viewer's ceiling is four thousand lines at two elements each, so this is
 * roughly twice its budget, for a thing that is genuinely wider. Past it a
 * popup takes a visible second to appear and nobody reads row 501 of a
 * spreadsheet in a preview anyway — they open the file.
 *
 * Both numbers are round on purpose: they end up in a Korean sentence a person
 * reads, and "앞에서 512줄만" invites the question "왜 512?".
 */
export const TABLE_MAX_ROWS = 500;
export const TABLE_MAX_COLUMNS = 30;

/** The separators we can read, by extension. */
const DELIMITERS: Record<string, string> = {
  csv: ",",
  tsv: "\t",
};

/** The separator for a path, or null when the file is not delimited text. */
export function delimiterFor(path: string): string | null {
  return DELIMITERS[extensionOf(path)] ?? null;
}

/** Where a table's cells come from. Built by the viewer, read only here. */
export type SpreadsheetSource =
  | { kind: "delimited"; text: string; delimiter: string }
  | { kind: "workbook"; bytes: ArrayBuffer };

/**
 * One sheet's cells, before anything has been capped or turned into text.
 *
 * `unknown` rather than the reader's own cell union, deliberately. The reader
 * hands back strings, numbers, booleans, `Date`s and nulls, and its published
 * types spell one of those wrong (`typeof Date`, the constructor, where it
 * means an instance). Narrowing from `unknown` in `cellText` is both correct
 * and independent of a type we do not control — and it costs nothing, because
 * every one of those values has to be narrowed before it can be printed.
 */
export type SheetCells = {
  /** Null when the file has no sheets — a `.csv` is one table with no name. */
  name: string | null;
  rows: readonly (readonly unknown[])[];
};

export type ClippedTable = {
  /** Already text, already inside both ceilings, already rectangular. */
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  clippedRows: boolean;
  clippedColumns: boolean;
};

/**
 * A field, as text.
 *
 * Everything here is a narrowing of one value, and the last branch is the one
 * worth reading: a shape none of the others covers becomes an empty cell rather
 * than `[object Object]`, because a blank is a smaller lie about somebody's
 * data than a JavaScript internal.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  // Printed, never formatted. `toLocaleString` would turn the year 2024 into
  // "2,024" — a number that is not in their file, in the one place where being
  // checkable against the file is the whole point.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  // TRUE / FALSE rather than 예 / 아니요, because that is what the cell says in
  // Excel itself, Korean Excel included.
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return dateText(value);
  return "";
}

/**
 * A date cell, read in UTC.
 *
 * A workbook stores a date as a number of days, and the reader turns that into
 * a `Date` at UTC midnight. Printing it with local getters would shift it by
 * the reader's own offset — west of UTC that lands on the day before, so the
 * date in the file and the date on screen would differ by one, silently, for
 * everyone in the Americas. The time is shown only when there is one.
 */
function dateText(value: Date): string {
  const stamp = value.getTime();
  if (!Number.isFinite(stamp)) return "";
  const day = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  const hours = value.getUTCHours();
  const minutes = value.getUTCMinutes();
  if (hours === 0 && minutes === 0) return day;
  return `${day} ${pad(hours)}:${pad(minutes)}`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * The spreadsheet name for a column: A, B, … Z, AA, AB.
 *
 * Ours, not theirs. A preview that used the first row as column names would be
 * asserting that the first row is a header, which for a great many real files
 * is simply false — and a table whose columns are labelled with somebody's
 * first data row is worse than one with no labels at all.
 */
export function columnLabel(index: number): string {
  if (!Number.isFinite(index) || index < 0) return "";
  let remaining = Math.floor(index);
  let label = "";
  // Bijective base 26: there is no "zero" column, so each step borrows one.
  do {
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
}

/**
 * The part of a table we will draw, and the honest size of the whole.
 *
 * The totals are measured over every row, including the ones being dropped —
 * a notice that said "전체는 500줄이에요" because it only counted what it kept
 * would be worse than no notice.
 */
export function clipTable(source: readonly (readonly unknown[])[]): ClippedTable {
  const totalRows = source.length;
  let totalColumns = 0;
  for (const row of source) {
    if (row.length > totalColumns) totalColumns = row.length;
  }

  const shownColumns = Math.min(totalColumns, TABLE_MAX_COLUMNS);
  const shownRows = Math.min(totalRows, TABLE_MAX_ROWS);

  const rows: string[][] = [];
  for (let r = 0; r < shownRows; r += 1) {
    const row = source[r];
    const cells: string[] = [];
    // Padded to a rectangle. Real files are ragged — a trailing empty column is
    // written on some rows and not others — and a short row would slide every
    // cell after it under the wrong letter.
    for (let c = 0; c < shownColumns; c += 1) cells.push(cellText(row[c]));
    rows.push(cells);
  }

  return {
    rows,
    totalRows,
    totalColumns,
    clippedRows: totalRows > TABLE_MAX_ROWS,
    clippedColumns: totalColumns > TABLE_MAX_COLUMNS,
  };
}

/**
 * Nothing in it.
 *
 * Not only "zero rows": a `.csv` that is a single newline parses to one row of
 * one empty field, and an untouched sheet in a workbook comes back the same
 * way. Both are empty to the person looking at them, and drawing a one-cell
 * grid to prove otherwise would be the product being pedantic at them.
 */
export function isBlankTable(table: ClippedTable): boolean {
  if (table.totalRows === 0 || table.totalColumns === 0) return true;
  if (table.totalRows > 1) return false;
  return table.rows[0].every((cell) => cell === "");
}

/** "표가 길어서 앞에서 500줄만 보여 드려요. 전체는 12,480줄이에요." */
export function clipNotice(table: ClippedTable): string | null {
  const said: string[] = [];
  if (table.clippedRows) {
    said.push(
      `표가 길어서 앞에서 ${count(TABLE_MAX_ROWS)}줄만 보여 드려요. 전체는 ${count(table.totalRows)}줄이에요.`,
    );
  }
  if (table.clippedColumns) {
    // "칸도" only when something else was already cut, so the sentence does not
    // imply a first half that is not there.
    const lead = table.clippedRows ? "칸도 많아서" : "칸이 많아서";
    said.push(
      `${lead} 앞에서 ${count(TABLE_MAX_COLUMNS)}칸만 보여 드려요. 전체는 ${count(table.totalColumns)}칸이에요.`,
    );
  }
  return said.length === 0 ? null : said.join(" ");
}

function count(value: number): string {
  return value.toLocaleString("ko-KR");
}

/**
 * Delimited text, read the way the format actually works.
 *
 * This function is the reason `.csv` was shown as plain text for so long, and
 * every line of it is one of the cases a `split(",")` gets wrong:
 *
 *   - A separator **inside quotes** is data. `홍길동,"서울, 강남구",30` is three
 *     fields, and the naive split makes it four with every later column shifted
 *     one place — a table that is wrong without looking wrong, which is the
 *     failure this product cannot ship.
 *   - `""` **inside quotes is one quote.** That is how the format escapes
 *     itself; there is no backslash in CSV.
 *   - A **newline inside quotes** is part of the field. Excel writes them, and
 *     splitting on newlines first tears one record into two half-records.
 *   - **CRLF** is one line break, not two, and inside a quoted field it becomes
 *     the `\n` the cell renders — the same normalisation the code viewer does.
 *   - A **byte order mark** would otherwise become part of the first cell's
 *     name, so the first column would silently never match anything.
 *
 * Lenient where the format is ambiguous: a quote in the middle of an unquoted
 * field (`3" pipe`) is a character, not the start of quoting, because refusing
 * the file would leave the reader with nothing.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  // A BOM belongs to the file, not to the first cell.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  /**
   * Whether anything has been read since the last record ended. It is what
   * makes "a,b\n" two fields rather than three: a newline at the very end of a
   * file closes the last record, and must not then open an empty one.
   */
  let started = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  while (index < source.length) {
    const char = source[index];

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      if (char === "\r") {
        field += "\n";
        if (source[index + 1] === "\n") index += 1;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    // Quoting only opens at the start of a field. Anywhere else it is a
    // character somebody typed.
    if (char === '"' && field === "") {
      quoted = true;
      started = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      started = true;
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      endRow();
      index += 1;
      continue;
    }
    field += char;
    started = true;
    index += 1;
  }

  if (started || field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * The cells, from whichever kind of file this is.
 *
 * The workbook reader is imported here and nowhere else, so it lands in its own
 * chunk: someone who only ever opens `.tsx` files never downloads a spreadsheet
 * parser. `readXlsxFile` returns every sheet in one pass, which is what makes
 * the sheet picker instant rather than a second parse per tab.
 */
async function readCells(source: SpreadsheetSource): Promise<SheetCells[]> {
  if (source.kind === "delimited") {
    return [{ name: null, rows: parseDelimited(source.text, source.delimiter) }];
  }
  const { default: readXlsxFile } = await import("read-excel-file/browser");
  const sheets = await readXlsxFile(source.bytes);
  return sheets.map((sheet) => ({ name: sheet.sheet, rows: sheet.data }));
}

/* ------------------------------------------------------------- the drawing */

const FAILED =
  "이 표를 펼쳐서 보여드리지 못했어요. 저희가 아직 읽지 못하는 형태예요. 파일을 받아서 열어보실 수 있어요.";

type Reading =
  | { state: "reading" }
  | { state: "ready"; sheets: SheetCells[] }
  | { state: "failed" };

export function SpreadsheetBody({
  source,
  size,
  shape,
}: {
  source: SpreadsheetSource;
  size: number | null;
  shape: PreviewShape;
}) {
  /*
   * Both pieces of state are kept with the file they belong to, the same way
   * the popup keeps its fetch. Opening a second spreadsheet then shows
   * "읽는 중" again, and lands back on the first sheet, without anything having
   * to reset them — which matters because the obvious way to reset them is a
   * `setState` at the top of the effect below, and that is a cascading render
   * the React compiler rejects outright (the same rule D75 ran into).
   */
  const [parsed, setParsed] = useState<{ from: SpreadsheetSource; value: Reading } | null>(
    null,
  );
  const [picked, setPicked] = useState<{ from: SpreadsheetSource; index: number } | null>(
    null,
  );
  const pickerId = useId();

  const reading: Reading =
    parsed && parsed.from === source ? parsed.value : { state: "reading" };
  const sheetIndex = picked && picked.from === source ? picked.index : 0;

  useEffect(() => {
    /*
     * Parsed here rather than while rendering, even for a `.csv` that needs no
     * import. A 4 MB table is hundreds of thousands of cells, and doing that
     * work inside `useMemo` would freeze the popup between "받아오는 중" and the
     * first row with nothing on screen to say why.
     */
    let cancelled = false;

    void (async () => {
      try {
        const sheets = await readCells(source);
        if (!cancelled) setParsed({ from: source, value: { state: "ready", sheets } });
      } catch {
        // A workbook we cannot read, or a chunk that would not load. Either way
        // the answer is a sentence, not an empty frame.
        if (!cancelled) setParsed({ from: source, value: { state: "failed" } });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source]);

  const sheets = reading.state === "ready" ? reading.sheets : null;
  const sheet = sheets?.[sheetIndex] ?? null;
  const table = useMemo(() => (sheet ? clipTable(sheet.rows) : null), [sheet]);

  if (reading.state === "reading") {
    return <Centred>표를 읽는 중이에요.</Centred>;
  }
  if (reading.state === "failed") {
    return <Centred>{FAILED}</Centred>;
  }
  if (!sheets || sheets.length === 0 || !sheet || !table) {
    return <Centred>이 표는 비어 있어요.</Centred>;
  }

  const notice = clipNotice(table);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        A dropdown rather than a row of tabs. The number of sheets is set by
        somebody else's file, so a control sized by what fits on a row would
        break on the first workbook with nine of them — and at 375px, where this
        popup is the whole screen, that is every workbook with three. Same
        reasoning as D75.
      */}
      {sheets.length > 1 ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2">
          <label htmlFor={pickerId} className="shrink-0 text-[11px] text-said-faint">
            시트
          </label>
          <select
            id={pickerId}
            value={sheetIndex}
            onChange={(event) =>
              setPicked({ from: source, index: Number(event.currentTarget.value) })
            }
            /*
             * `color-scheme` on the control itself, because this is the first
             * <select> in the product and the site never declares one. The two
             * parts of a select a stylesheet cannot reach — the arrow and the
             * open list — are drawn by the browser from that property, so
             * without it the arrow is painted dark onto our dark background and
             * the list opens white. Scoped here rather than on :root, which
             * would be a decision about every surface in the app made in a
             * spreadsheet viewer.
             */
            className="min-w-0 flex-1 rounded-md border border-edge-lit bg-ink-raised px-2 py-1 text-[12px] text-said outline-none [color-scheme:dark] focus-visible:ring-1 focus-visible:ring-lamp-dim"
          >
            {sheets.map((option, index) => (
              <option key={index} value={index}>
                {option.name && option.name.length > 0 ? option.name : `시트 ${index + 1}`}
              </option>
            ))}
          </select>
          <span className="shrink-0 text-[11px] text-said-faint">
            {sheets.length.toLocaleString("ko-KR")}개 중 {sheetIndex + 1}번째
          </span>
        </div>
      ) : null}

      {notice ? (
        <p className="shrink-0 border-b border-edge px-4 py-2 text-[12px] leading-[1.7] text-said-soft">
          {notice}
        </p>
      ) : null}

      {isBlankTable(table) ? (
        <Centred>{sheets.length > 1 ? "이 시트는 비어 있어요." : "이 표는 비어 있어요."}</Centred>
      ) : (
        <div
          // Focusable for the same reason the code viewer's frame is: a table
          // that scrolls in both directions is unreachable by keyboard
          // otherwise.
          tabIndex={0}
          role="region"
          aria-label="표 내용"
          className="min-h-0 flex-1 overflow-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-lamp-dim"
        >
          <table className="border-separate border-spacing-0 font-mono text-[12px] leading-[1.6]">
            <thead>
              <tr>
                {/*
                  The corner. Sticky on both axes, so it sits above the row
                  numbers and the column letters where they cross — without it
                  the two sticky layers overlap and the letters slide under the
                  numbers when you scroll right.
                */}
                <th
                  scope="col"
                  className="sticky left-0 top-0 z-30 border-b border-r border-edge bg-ink-raised px-2 py-1"
                >
                  <span className="sr-only">줄 번호</span>
                </th>
                {table.rows[0].map((_, column) => (
                  <th
                    key={column}
                    scope="col"
                    className="sticky top-0 z-20 border-b border-r border-edge bg-ink-raised px-2 py-1 text-left font-normal text-said-faint"
                  >
                    {columnLabel(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, index) => (
                <tr key={index}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-b border-r border-edge bg-ink-raised px-2 py-1 text-right align-top font-normal text-said-faint"
                  >
                    {index + 1}
                  </th>
                  {row.map((cell, column) => (
                    <td
                      key={column}
                      // `pre-wrap` because a cell can genuinely contain a line
                      // break, and the ceiling because one long cell would
                      // otherwise stretch its column past every other one.
                      className="max-w-[24rem] whitespace-pre-wrap break-words border-b border-r border-edge px-2 py-1 align-top text-said-soft"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="shrink-0 border-t border-edge px-4 py-2 text-[11px] text-said-faint">
        {count(table.totalRows)}줄 · {count(table.totalColumns)}칸
        {size !== null ? ` · ${formatBytes(size)}` : ""}
        {shape.language ? ` · ${shape.language}` : ""}
      </p>
    </div>
  );
}

function Centred({ children }: { children: React.ReactNode }) {
  return (
    // `h-full` for the two cases where this is the whole body, `flex-1` for the
    // one where it sits under a sheet picker. In a column flex parent the basis
    // wins, outside one the height does, so both are needed and neither is dead.
    <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <p className="max-w-[44ch] text-center text-[14px] leading-[1.85] text-said-soft">
        {children}
      </p>
    </div>
  );
}
