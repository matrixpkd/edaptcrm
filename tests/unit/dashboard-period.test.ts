import { describe, expect, it } from "vitest";
import {
  customRange,
  monthRange,
  periodQuery,
  rangeLabel,
  resolvePeriod,
  rollingRange,
  trailingMonths,
} from "@/lib/dashboard/period";
import { count, deltaOf, formatHours, plural, pointsDelta, share } from "@/lib/dashboard/format";
import { canViewCalibration, canViewDashboard } from "@/lib/dashboard/access";

const TZ = "Asia/Kolkata";
// Tue 13 Oct 2026, 12:00 India time
const NOW = new Date("2026-10-13T06:30:00Z");

describe("dashboard periods", () => {
  it("this month runs from local midnight on the 1st to now, against all of last month", () => {
    const r = monthRange(NOW, TZ);
    expect(r.start.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(r.end).toEqual(NOW);
    expect(r.prevStart.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(r.prevEnd.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    // same elapsed time into September: 12.5 days
    expect(r.prevToDateEnd.toISOString()).toBe("2026-09-13T06:30:00.000Z");
    expect(r.label).toBe("October so far");
    expect(r.prevLabel).toBe("September 2026");
    expect(r.compareLabel).toBe("1–13 Sept 2026");
    expect([r.from, r.to]).toEqual(["2026-10-01", "2026-10-13"]);
  });

  it("month boundaries follow the viewer's time zone", () => {
    // 31 Oct 21:00 UTC is already 1 Nov in Dubai (UTC+4) and in India
    const late = new Date("2026-10-31T21:00:00Z");
    expect(monthRange(late, "Asia/Dubai").start.toISOString()).toBe("2026-10-31T20:00:00.000Z");
    expect(monthRange(late, "UTC").start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // an unknown zone falls back to India time
    expect(monthRange(NOW, "Not/AZone").start.toISOString()).toBe("2026-09-30T18:30:00.000Z");
  });

  it("the previous-to-date cut never runs past the end of a shorter previous month", () => {
    // 31 Mar: February has 28 days
    const r = monthRange(new Date("2026-03-31T12:00:00Z"), "UTC");
    expect(r.prevToDateEnd.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("rolling 30 and 90 days", () => {
    const r = rollingRange(NOW, 30, TZ);
    expect(r.start.toISOString()).toBe("2026-09-13T06:30:00.000Z");
    expect(r.prevStart.toISOString()).toBe("2026-08-14T06:30:00.000Z");
    expect(r.prevEnd).toEqual(r.start);
    expect(r.prevToDateEnd).toEqual(r.start);
    expect(r.label).toBe("Last 30 days");
    expect(rollingRange(NOW, 90, TZ).key).toBe("90d");
  });

  it("a custom range covers whole local days and compares with the same number of days before", () => {
    const r = customRange("2026-09-01", "2026-09-30", NOW, TZ);
    if (!("key" in r)) throw new Error(r.error);
    expect(r.start.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(r.end.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(r.prevStart.toISOString()).toBe("2026-08-01T18:30:00.000Z");
    expect(r.label).toBe("1–30 Sept 2026");
    expect(r.prevLabel).toBe("2–31 Aug 2026");
    expect([r.from, r.to]).toEqual(["2026-09-01", "2026-09-30"]);
    const one = customRange("2026-10-05", "2026-10-05", NOW, TZ);
    expect("key" in one && one.label).toBe("5 Oct 2026");
  });

  it("rejects bad custom ranges with a friendly reason", () => {
    expect(customRange("", "2026-10-01", NOW, TZ)).toEqual({ error: "Pick both a start and an end date." });
    expect(customRange("2026-02-30", "2026-03-01", NOW, TZ)).toEqual({ error: "Pick both a start and an end date." });
    expect(customRange("2026-10-05", "2026-10-01", NOW, TZ)).toEqual({ error: "The end date is before the start date." });
    expect(customRange("2026-11-01", "2026-11-05", NOW, TZ)).toEqual({ error: "The range starts in the future." });
    expect(customRange("2020-01-01", "2026-10-01", NOW, TZ)).toEqual({ error: "Pick a range of at most 731 days." });
  });

  it("resolvePeriod reads the query string and falls back to this month", () => {
    expect(resolvePeriod({}, NOW, TZ).key).toBe("month");
    expect(resolvePeriod({ period: "30d" }, NOW, TZ).key).toBe("30d");
    expect(resolvePeriod({ period: ["90d", "30d"] }, NOW, TZ).key).toBe("90d");
    expect(resolvePeriod({ period: "custom", from: "2026-09-01", to: "2026-09-30" }, NOW, TZ).key).toBe("custom");
    const bad = resolvePeriod({ period: "custom", from: "2026-10-05", to: "2026-10-01" }, NOW, TZ);
    expect(bad.key).toBe("month");
    expect(bad.error).toBe("The end date is before the start date.");
    expect(resolvePeriod({ period: "forever" }, NOW, TZ).key).toBe("month");
  });

  it("builds the query string for links", () => {
    expect(periodQuery({ key: "month", from: "", to: "" })).toBe("");
    expect(periodQuery({ key: "30d", from: "", to: "" })).toBe("?period=30d");
    expect(periodQuery({ key: "custom", from: "2026-09-01", to: "2026-09-30" })).toBe("?period=custom&from=2026-09-01&to=2026-09-30");
  });

  it("trailing months end with the month that holds the end of the range", () => {
    const m = trailingMonths(NOW, 3, TZ);
    expect(m.map((x) => [x.key, x.label])).toEqual([
      ["2026-08", "Aug"],
      ["2026-09", "Sept"],
      ["2026-10", "Oct"],
    ]);
    expect(m[2].start.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(m[2].end.toISOString()).toBe("2026-10-31T18:30:00.000Z");
    // an exclusive end at local midnight on 1 Oct belongs to September
    expect(trailingMonths(new Date("2026-09-30T18:30:00Z"), 1, TZ)[0].key).toBe("2026-09");
  });

  it("range labels stay short: one month, one year, or both years", () => {
    expect(rangeLabel(new Date("2025-12-20T00:00:00Z"), new Date("2026-01-05T00:00:00Z"), "UTC")).toBe("20 Dec 2025 – 4 Jan 2026");
    expect(rangeLabel(new Date("2026-08-20T00:00:00Z"), new Date("2026-09-05T00:00:00Z"), "UTC")).toBe("20 Aug – 4 Sept 2026");
    expect(rangeLabel(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-14T00:00:00Z"), "UTC")).toBe("1–13 Oct 2026");
  });
});

describe("dashboard formatting", () => {
  it("deltas say which way and by how much, never colour alone", () => {
    expect(deltaOf(120, 100)).toMatchObject({ direction: "up", text: "+20%" });
    expect(deltaOf(80, 100)).toMatchObject({ direction: "down", text: "−20%" });
    expect(deltaOf(100, 100)).toMatchObject({ direction: "flat", text: "No change" });
    expect(deltaOf(50, 0)).toMatchObject({ direction: "up", text: "New", change: null });
    expect(deltaOf(0, 0)).toMatchObject({ direction: "flat", text: "No change" });
    expect(pointsDelta(0.42, 0.38)).toMatchObject({ direction: "up", text: "+4 pts" });
    expect(pointsDelta(null, 0.38).text).toBe("");
  });

  it("shares, hours and counts", () => {
    expect(share(0.456)).toBe("46%");
    expect(share(0.004)).toBe("0.4%");
    expect(share(0)).toBe("0%");
    expect(share(null)).toBe("—");
    expect(formatHours(0)).toBe("under 1 min");
    expect(formatHours(0.25)).toBe("15 min");
    expect(formatHours(3)).toBe("3 h");
    expect(formatHours(26.44)).toBe("26.4 h");
    expect(formatHours(72)).toBe("3 days");
    expect(formatHours(null)).toBe("—");
    expect(count(123456)).toBe("1,23,456");
    expect(plural(1, "customer")).toBe("1 customer");
    expect(plural(2, "enquiry", "enquiries")).toBe("2 enquiries");
  });
});

describe("dashboard access", () => {
  it("admins and managers see the dashboard; only admins the calibration report", () => {
    expect(canViewDashboard({ role: "admin" })).toBe(true);
    expect(canViewDashboard({ role: "manager" })).toBe(true);
    expect(canViewDashboard({ role: "sales" })).toBe(false);
    expect(canViewDashboard({ role: "support" })).toBe(false);
    expect(canViewDashboard(null)).toBe(false);
    expect(canViewCalibration({ role: "admin" })).toBe(true);
    expect(canViewCalibration({ role: "manager" })).toBe(false);
    expect(canViewCalibration({ role: "sales" })).toBe(false);
  });
});
