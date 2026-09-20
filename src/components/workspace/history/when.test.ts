import { describe, expect, it } from "vitest";

import { exactWhen, formatWhen, parseWhen } from "./when";

/**
 * How long ago something was, in words.
 *
 * Every date here is built with the local-time constructor rather than from an
 * ISO string, deliberately: the module answers in the reader's own day, so a
 * test written in UTC would pass in one timezone and fail in another, which is
 * the failure that only shows up on someone else's machine.
 */

/** A fixed afternoon to measure everything against. */
const NOW = new Date(2026, 8, 20, 15, 30, 0);

/** `NOW` minus a number of minutes, kept readable at the call site. */
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

describe("formatWhen", () => {
  it("says 방금 전 for the first minute", () => {
    expect(formatWhen(minutesAgo(0), NOW)).toBe("방금 전");
    expect(formatWhen(minutesAgo(0.9), NOW)).toBe("방금 전");
  });

  it("says 방금 전 rather than a negative distance when the clocks disagree", () => {
    // The server writes the timestamp and the browser reads it; a few seconds
    // of drift would otherwise print "-1분 전" next to a run that just finished.
    const ahead = new Date(NOW.getTime() + 20_000);
    expect(formatWhen(ahead, NOW)).toBe("방금 전");
  });

  it("counts minutes up to the hour", () => {
    expect(formatWhen(minutesAgo(3), NOW)).toBe("3분 전");
    expect(formatWhen(minutesAgo(59), NOW)).toBe("59분 전");
  });

  it("counts hours for the rest of the same day", () => {
    expect(formatWhen(minutesAgo(60), NOW)).toBe("1시간 전");
    expect(formatWhen(new Date(2026, 8, 20, 2, 0), NOW)).toBe("13시간 전");
  });

  it("says 어제 for yesterday", () => {
    expect(formatWhen(new Date(2026, 8, 19, 20, 0), NOW)).toBe("어제");
    // Just after midnight yesterday is still yesterday, not two days.
    expect(formatWhen(new Date(2026, 8, 19, 0, 5), NOW)).toBe("어제");
  });

  it("prefers minutes to 어제 across midnight", () => {
    // 00:10 looking back at 23:55 is a quarter of an hour, not a different day
    // in any sense the person cares about.
    const justAfterMidnight = new Date(2026, 8, 20, 0, 10);
    const beforeMidnight = new Date(2026, 8, 19, 23, 55);
    expect(formatWhen(beforeMidnight, justAfterMidnight)).toBe("15분 전");
  });

  it("counts days up to a week", () => {
    expect(formatWhen(new Date(2026, 8, 18, 9, 0), NOW)).toBe("2일 전");
    expect(formatWhen(new Date(2026, 8, 14, 9, 0), NOW)).toBe("6일 전");
  });

  it("gives the date once a week has passed", () => {
    expect(formatWhen(new Date(2026, 8, 13, 9, 0), NOW)).toBe("9월 13일");
  });

  it("adds the year only when it is not this one", () => {
    expect(formatWhen(new Date(2026, 0, 4, 9, 0), NOW)).toBe("1월 4일");
    expect(formatWhen(new Date(2025, 11, 31, 9, 0), NOW)).toBe("2025년 12월 31일");
  });

  it("counts calendar days, not 24-hour blocks", () => {
    // 09:00 yesterday is 30 hours ago, which floors to one day either way; the
    // case that separates the two rules is a short gap across a boundary.
    // 23:00 yesterday to 01:00 today is two hours and one calendar day.
    const earlyMorning = new Date(2026, 8, 20, 1, 0);
    expect(formatWhen(new Date(2026, 8, 19, 23, 0), earlyMorning)).toBe("어제");
  });
});

describe("exactWhen", () => {
  it("writes the moment out in full", () => {
    expect(exactWhen(new Date(2026, 8, 20, 15, 4))).toBe("2026년 9월 20일 오후 3:04");
    expect(exactWhen(new Date(2026, 8, 20, 9, 30))).toBe("2026년 9월 20일 오전 9:30");
  });

  it("puts midnight and noon on a twelve-hour clock", () => {
    // `hour % 12` alone gives 0 for both, and 오전 0:05 is not a time anybody
    // writes.
    expect(exactWhen(new Date(2026, 8, 20, 0, 5))).toBe("2026년 9월 20일 오전 12:05");
    expect(exactWhen(new Date(2026, 8, 20, 12, 0))).toBe("2026년 9월 20일 오후 12:00");
  });
});

describe("parseWhen", () => {
  it("reads an ISO timestamp", () => {
    const at = parseWhen("2026-09-20T06:30:00.000Z");
    expect(at?.getTime()).toBe(Date.UTC(2026, 8, 20, 6, 30));
  });

  it("returns null rather than an Invalid Date", () => {
    // Everything downstream of an Invalid Date is NaN, and NaN reaches the
    // screen as "NaN분 전" beside runs that are real.
    expect(parseWhen("나중에")).toBeNull();
    expect(parseWhen("")).toBeNull();
  });
});
