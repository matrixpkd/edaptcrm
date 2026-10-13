/**
 * Calendar keys and send times for alerts and digests. PURE (no server imports): unit tested in
 * tests/unit/alerts-schedule.test.ts. Every function takes `now` and a time zone, so "today", "this month"
 * and "this week" always mean the local calendar of the person (or of the business, Asia/Kolkata).
 */
import { TZDate } from "@date-fns/tz";
import { DEFAULT_TIME_ZONE, localDateAt, localDayStart, localIsoDate, validTimeZone } from "@/lib/today/time";

export { DEFAULT_TIME_ZONE, validTimeZone };

const DAY_MS = 24 * 3600 * 1000;

/** "YYYY-MM-DD" of `now` in `timeZone`. */
export function localDateKey(now: Date, timeZone: string | null | undefined): string {
  return localIsoDate(now, timeZone);
}

/** "YYYY-MM" of `now` in `timeZone` (dedupe key for monthly alerts such as at risk). */
export function monthKey(now: Date, timeZone: string | null | undefined): string {
  return localIsoDate(now, timeZone).slice(0, 7);
}

/** "YYYY-Qn" of `now` in `timeZone` (dedupe key for quarterly alerts such as VIP gone quiet). */
export function quarterKey(now: Date, timeZone: string | null | undefined): string {
  const local = new TZDate(now.getTime(), validTimeZone(timeZone));
  return `${local.getFullYear()}-Q${Math.floor(local.getMonth() / 3) + 1}`;
}

/** The instant of today's daily digest for someone in `timeZone`: `hour:minute` on their local date. */
export function digestSendTime(now: Date, timeZone: string | null | undefined, hour: number, minute: number): Date {
  const h = clampInt(hour, 0, 23, 8);
  const m = clampInt(minute, 0, 59, 30);
  // localDateAt only returns null for a malformed date string, never for localIsoDate's output
  return localDateAt(localIsoDate(now, timeZone), timeZone, h, m) ?? localDayStart(now, timeZone);
}

/** True once `now` has reached today's digest time in the person's own time zone. */
export function isDigestDue(now: Date, timeZone: string | null | undefined, hour: number, minute: number): boolean {
  return now.getTime() >= digestSendTime(now, timeZone, hour, minute).getTime();
}

export type WeekWindow = {
  /** 00:00 local on the Monday of the previous week */
  start: Date;
  /** 00:00 local on the Monday of `now`'s week (exclusive) */
  end: Date;
  /** 00:00 local, 7 days before `start` (the comparison week) */
  prevStart: Date;
  /** "YYYY-MM-DD" of the Monday of `now`'s local week: one weekly summary per key */
  weekKey: string;
};

/**
 * The weekly summary window: the last full calendar week, Monday to Sunday in local time, and the week before it
 * for comparison. Run on any day of a week (Monday's cron, or a retry on Tuesday) it covers the same period, so a
 * summary keyed by weekKey always says the same thing. Built from local midnights, so it is DST-safe.
 */
export function weekWindow(now: Date, timeZone: string | null | undefined): WeekWindow {
  const tz = validTimeZone(timeZone);
  const local = new TZDate(now.getTime(), tz);
  const sinceMonday = (local.getDay() + 6) % 7;
  const y = local.getFullYear();
  const mo = local.getMonth();
  const monday = local.getDate() - sinceMonday;
  const at = (days: number) => new Date(new TZDate(y, mo, monday + days, 0, 0, 0, 0, tz).getTime());
  return {
    start: at(-7),
    end: at(0),
    prevStart: at(-14),
    weekKey: localIsoDate(at(0), tz),
  };
}

/** Whole days from `from` to `to` (floored, never negative). */
export function wholeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
