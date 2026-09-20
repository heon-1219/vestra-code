/**
 * When something happened, said the way a person says it out loud.
 *
 * The band's whole job is "what happened to my project, and when", and the
 * *when* half is answered by a timestamp nobody reads: `2026-09-20T09:14:22Z`
 * tells the target user of this product nothing at all. 3분 전 does.
 *
 * Two rules, and both are about not lying:
 *
 *   1. **Relative only while relative is still an answer.** 3분 전, 어제, 4일 전
 *      are all distances a person is holding in their head already. 43일 전 is
 *      arithmetic they have to do in reverse to get back to a date, so past a
 *      week this gives the date instead. The threshold is a week rather than
 *      "a few days" because within a week the distance is still the thing
 *      someone actually wants — it was before the weekend, or after it.
 *   2. **Never a number nobody measured.** Every function here takes `now` as
 *      an argument rather than reading the clock. That is what makes the whole
 *      module testable without freezing time, and it is also what stops a
 *      React component from formatting a time during render from a clock that
 *      differs between the server and the browser — the band passes a `now` it
 *      keeps in state, so the server and the first client render agree.
 *
 * Everything is computed in the browser's local time, deliberately. The
 * timestamps arrive as UTC and the person reading them is in their own day, not
 * in UTC's — "어제" has to mean their yesterday.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Where relative stops and a date starts.
 *
 * Also the reason `RunChange` has an `unknown` case: past this, nothing about
 * the wording is doing arithmetic the reader cannot check.
 */
const RELATIVE_DAYS = 7;

/**
 * An ISO string from the wire, or null if it is not a time.
 *
 * `new Date("나중에")` is an Invalid Date rather than a throw, and every piece
 * of arithmetic downstream of one returns NaN — which reaches the screen as
 * "NaN분 전" next to a real run. The band would rather say nothing about when a
 * run happened than say that, so this is the one place the check lives.
 */
export function parseWhen(value: string): Date | null {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** "방금 전", "3분 전", "어제", "4일 전", "9월 12일", "2025년 9월 12일". */
export function formatWhen(at: Date, now: Date): string {
  const elapsed = now.getTime() - at.getTime();

  /*
   * A run that finished in the future is a clock difference, not a run.
   *
   * The timestamp is written by the server and read by the browser, and the two
   * clocks are routinely a few seconds apart — enough for a run that has just
   * completed to be "-1분 전". 방금 전 is true for both sides of that gap.
   */
  if (elapsed < MINUTE) return "방금 전";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}분 전`;

  /*
   * Past an hour the answer switches from elapsed time to calendar days, and
   * the order of these two checks is the whole point: at 00:10, something from
   * 23:55 is 15분 전 and not 어제, because the person was awake for both.
   */
  const days = calendarDaysBetween(at, now);
  if (days === 0) return `${Math.floor(elapsed / HOUR)}시간 전`;
  if (days === 1) return "어제";
  if (days < RELATIVE_DAYS) return `${days}일 전`;

  // The year only when it is not this one. A date carrying "2026년" on every
  // row of a list where every row is 2026 is noise standing where a fact was.
  return at.getFullYear() === now.getFullYear()
    ? `${at.getMonth() + 1}월 ${at.getDate()}일`
    : `${at.getFullYear()}년 ${at.getMonth() + 1}월 ${at.getDate()}일`;
}

/**
 * The same moment in full, for the places a relative distance is not enough —
 * a hover on a strip too short to show anything else, and the second line of a
 * row in the maximised list.
 *
 * Written out by hand rather than through `toLocaleString`, because the exact
 * output of that depends on which locale data the runtime shipped with, and a
 * string this module promises is a string it can be tested on.
 */
export function exactWhen(at: Date): string {
  const hour = at.getHours();
  // 0시 and 12시 are both 12 on a twelve-hour clock; `% 12` alone gives 0.
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  const minute = String(at.getMinutes()).padStart(2, "0");
  return `${at.getFullYear()}년 ${at.getMonth() + 1}월 ${at.getDate()}일 ${
    hour < 12 ? "오전" : "오후"
  } ${twelve}:${minute}`;
}

/**
 * Whole days between two moments, counted on a calendar rather than divided.
 *
 * A calendar day is 23 or 25 hours long where the clocks change, so
 * `elapsed / DAY` puts a run from yesterday evening in "오늘" or the day before
 * yesterday, depending on the month. Snapping both ends to local midnight and
 * rounding the difference is right in every zone — including the ones this
 * product was not written in, which is the browser's business and not ours.
 */
function calendarDaysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY);
}

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}
