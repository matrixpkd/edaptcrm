import { describe, expect, it } from "vitest";
import {
  digestSendTime,
  isDigestDue,
  localDateKey,
  monthKey,
  quarterKey,
  weekWindow,
  wholeDaysBetween,
} from "@/lib/alerts/schedule";

const KERALA = "Asia/Kolkata"; // UTC+5:30
const DUBAI = "Asia/Dubai"; // UTC+4

describe("daily digest send time (each user's own time zone)", () => {
  it("is 8:30 local: 03:00 UTC in Kerala, 04:30 UTC in Dubai", () => {
    const now = new Date("2026-10-13T01:00:00Z");
    expect(digestSendTime(now, KERALA, 8, 30).toISOString()).toBe("2026-10-13T03:00:00.000Z");
    expect(digestSendTime(now, DUBAI, 8, 30).toISOString()).toBe("2026-10-13T04:30:00.000Z");
  });

  it("is due for the Kerala user at 08:30 IST while the Dubai user is still at 07:00", () => {
    const at = new Date("2026-10-13T03:00:00Z");
    expect(isDigestDue(new Date(at.getTime() - 60_000), KERALA, 8, 30)).toBe(false);
    expect(isDigestDue(at, KERALA, 8, 30)).toBe(true);
    expect(isDigestDue(at, DUBAI, 8, 30)).toBe(false);
    expect(isDigestDue(new Date("2026-10-13T04:29:00Z"), DUBAI, 8, 30)).toBe(false);
    expect(isDigestDue(new Date("2026-10-13T04:30:00Z"), DUBAI, 8, 30)).toBe(true);
  });

  it("uses the local calendar date: just after local midnight it is a new day, not yet due", () => {
    // 19:00 UTC on the 12th is 00:30 on the 13th in Kerala
    const now = new Date("2026-10-12T19:00:00Z");
    expect(localDateKey(now, KERALA)).toBe("2026-10-13");
    expect(localDateKey(now, DUBAI)).toBe("2026-10-12");
    expect(isDigestDue(now, KERALA, 8, 30)).toBe(false);
    // the Dubai user's 12th: 23:00 local, long past 8:30
    expect(isDigestDue(now, DUBAI, 8, 30)).toBe(true);
  });

  it("falls back to India time for a missing or unknown zone and clamps odd settings", () => {
    const now = new Date("2026-10-13T03:00:00Z");
    expect(isDigestDue(now, null, 8, 30)).toBe(true);
    expect(isDigestDue(now, "Mars/Olympus", 8, 30)).toBe(true);
    expect(digestSendTime(now, KERALA, 99, -5).toISOString()).toBe("2026-10-13T17:30:00.000Z"); // 23:00 IST
  });
});

describe("calendar keys", () => {
  it("month and quarter follow the local calendar", () => {
    // 30 Sep 19:00 UTC = 1 Oct 00:30 IST
    const now = new Date("2026-09-30T19:00:00Z");
    expect(monthKey(now, KERALA)).toBe("2026-10");
    expect(quarterKey(now, KERALA)).toBe("2026-Q4");
    expect(monthKey(now, "UTC")).toBe("2026-09");
    expect(quarterKey(now, "UTC")).toBe("2026-Q3");
    expect(quarterKey(new Date("2026-01-15T00:00:00Z"), KERALA)).toBe("2026-Q1");
  });

  it("the weekly window is the last full Monday-to-Sunday local week, keyed by this week's Monday", () => {
    // Monday 12 Oct, 09:00 IST
    const w = weekWindow(new Date("2026-10-12T03:30:00Z"), KERALA);
    expect(w.start.toISOString()).toBe("2026-10-04T18:30:00.000Z"); // Mon 5 Oct 00:00 IST
    expect(w.end.toISOString()).toBe("2026-10-11T18:30:00.000Z"); // Mon 12 Oct 00:00 IST
    expect(w.prevStart.toISOString()).toBe("2026-09-27T18:30:00.000Z");
    expect(w.weekKey).toBe("2026-10-12");
    // a retry later in the same week reports the same period
    expect(weekWindow(new Date("2026-10-14T10:00:00Z"), KERALA)).toEqual(w);
    // Sunday night IST is still the previous week
    const sunday = weekWindow(new Date("2026-10-11T18:00:00Z"), KERALA);
    expect(sunday.weekKey).toBe("2026-10-05");
    expect(sunday.end.toISOString()).toBe("2026-10-04T18:30:00.000Z");
    // across a month boundary: Thursday 1 Oct belongs to the week of Monday 28 Sep
    expect(weekWindow(new Date("2026-10-01T06:00:00Z"), KERALA).start.toISOString()).toBe("2026-09-20T18:30:00.000Z");
  });

  it("whole days are floored and never negative", () => {
    const a = new Date("2026-10-01T00:00:00Z");
    expect(wholeDaysBetween(a, new Date("2026-10-03T23:59:00Z"))).toBe(2);
    expect(wholeDaysBetween(a, new Date("2026-09-30T00:00:00Z"))).toBe(0);
  });
});
