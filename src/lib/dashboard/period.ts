/**
 * The dashboard's period selector: this month, last 30 days, last 90 days or a custom range, each with the
 * period before it for comparisons. PURE (no server imports): pass `now` and the viewer's time zone.
 *
 * Every range is half-open, [start, end). Months and custom dates follow the viewer's own calendar
 * (default Asia/Kolkata), so "this month" starts at local midnight on the 1st.
 *
 * | key    | current                                   | previous                                   |
 * | month  | 1st of this month (local) -> now          | all of last month                          |
 * | 30d    | now - 30 days -> now                      | the 30 days before that                    |
 * | 90d    | now - 90 days -> now                      | the 90 days before that                    |
 * | custom | from 00:00 -> the day after `to`, 00:00   | the same number of days just before `from` |
 *
 * `prevToDateEnd` cuts the previous period at the same elapsed time as the current one (1-13 Sep against
 * 1-13 Oct), so a half-finished month is compared fairly. For the rolling and custom periods it equals prevEnd.
 */
import { TZDate } from "@date-fns/tz";

export const PERIOD_KEYS = ["month", "30d", "90d", "custom"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  month: "This month",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  custom: "Custom",
};

/** Longest custom range accepted, so one request can never scan years of history by accident. */
export const MAX_CUSTOM_DAYS = 731;

export type DashboardRange = {
  key: PeriodKey;
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
  /** previous period cut at the same elapsed time as the current one */
  prevToDateEnd: Date;
  /** "October so far", "Last 30 days", "1 Sep – 30 Sep 2026" */
  label: string;
  /** "September 2026", "previous 30 days", "2 Aug – 31 Aug 2026" */
  prevLabel: string;
  /** what KPI deltas compare against: "1 Sep – 13 Sep 2026" for this month, otherwise prevLabel */
  compareLabel: string;
  /** custom range inputs as YYYY-MM-DD (local), for the form */
  from: string;
  to: string;
  timeZone: string;
  /** set when the custom range could not be used and the default was shown instead */
  error: string | null;
};

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_TZ = "Asia/Kolkata";

function safeTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Local midnight of a calendar date (month is 0-based, day may overflow: 32 Jan -> 1 Feb). */
function localMidnight(y: number, m: number, d: number, tz: string): Date {
  return new Date(new TZDate(y, m, d, 0, 0, 0, 0, tz).getTime());
}

/** YYYY-MM-DD of an instant in the given zone. */
export function isoDateIn(d: Date, tz: string): string {
  const l = new TZDate(d.getTime(), safeTz(tz));
  return `${l.getFullYear()}-${String(l.getMonth() + 1).padStart(2, "0")}-${String(l.getDate()).padStart(2, "0")}`;
}

/** Parses YYYY-MM-DD; null when it is not a real calendar date. */
export function parseIsoDate(s: string | null | undefined): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const check = new Date(Date.UTC(y, m, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

function fmt(d: Date, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-IN", { ...opts, timeZone: tz }).format(d);
}

/**
 * "1–30 Sept 2026", "20 Aug – 4 Sept 2026" or "20 Dec 2025 – 4 Jan 2026" for [start, end), where end is the
 * instant after the last day (month names as en-IN writes them, like every other date in the app).
 */
export function rangeLabel(start: Date, end: Date, tz: string): string {
  const zone = safeTz(tz);
  const last = new Date(end.getTime() - 1);
  const [a, b] = [isoDateIn(start, zone), isoDateIn(last, zone)];
  const full = fmt(last, zone, { day: "numeric", month: "short", year: "numeric" });
  if (a === b) return full;
  if (a.slice(0, 7) === b.slice(0, 7)) return `${Number(a.slice(8, 10))}–${full}`;
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  return `${fmt(start, zone, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })} – ${full}`;
}

/** This calendar month (local) to `now`, against all of last month. */
export function monthRange(now: Date, timeZone?: string | null): DashboardRange {
  const tz = safeTz(timeZone);
  const l = new TZDate(now.getTime(), tz);
  const start = localMidnight(l.getFullYear(), l.getMonth(), 1, tz);
  const prevStart = localMidnight(l.getFullYear(), l.getMonth() - 1, 1, tz);
  const prevEnd = start;
  const elapsed = now.getTime() - start.getTime();
  const prevToDateEnd = new Date(Math.min(prevEnd.getTime(), prevStart.getTime() + elapsed));
  return {
    key: "month",
    start,
    end: now,
    prevStart,
    prevEnd,
    prevToDateEnd,
    label: `${fmt(now, tz, { month: "long" })} so far`,
    prevLabel: fmt(prevStart, tz, { month: "long", year: "numeric" }),
    compareLabel: rangeLabel(prevStart, prevToDateEnd, tz),
    from: isoDateIn(start, tz),
    to: isoDateIn(now, tz),
    timeZone: tz,
    error: null,
  };
}

/** The last `days` days to `now`, against the `days` before that. */
export function rollingRange(now: Date, days: 30 | 90, timeZone?: string | null): DashboardRange {
  const tz = safeTz(timeZone);
  const span = days * DAY_MS;
  const start = new Date(now.getTime() - span);
  const prevStart = new Date(start.getTime() - span);
  return {
    key: days === 30 ? "30d" : "90d",
    start,
    end: now,
    prevStart,
    prevEnd: start,
    prevToDateEnd: start,
    label: `Last ${days} days`,
    prevLabel: `previous ${days} days`,
    compareLabel: `previous ${days} days`,
    from: isoDateIn(start, tz),
    to: isoDateIn(now, tz),
    timeZone: tz,
    error: null,
  };
}

/**
 * A custom range of whole local days, `from` to `to` inclusive. Returns an error string instead when the dates
 * are missing, not real, reversed, in the future or longer than MAX_CUSTOM_DAYS.
 */
export function customRange(
  from: string | null | undefined,
  to: string | null | undefined,
  now: Date,
  timeZone?: string | null,
): DashboardRange | { error: string } {
  const tz = safeTz(timeZone);
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) return { error: "Pick both a start and an end date." };
  const start = localMidnight(a.y, a.m, a.d, tz);
  const end = localMidnight(b.y, b.m, b.d + 1, tz);
  if (end.getTime() <= start.getTime()) return { error: "The end date is before the start date." };
  if (start.getTime() > now.getTime()) return { error: "The range starts in the future." };
  // whole local days; DST-safe because both ends are local midnights
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  if (days > MAX_CUSTOM_DAYS) return { error: `Pick a range of at most ${MAX_CUSTOM_DAYS} days.` };
  const prevStart = localMidnight(a.y, a.m, a.d - days, tz);
  return {
    key: "custom",
    start,
    end,
    prevStart,
    prevEnd: start,
    prevToDateEnd: start,
    label: rangeLabel(start, end, tz),
    prevLabel: rangeLabel(prevStart, start, tz),
    compareLabel: rangeLabel(prevStart, start, tz),
    from: isoDateIn(start, tz),
    to: isoDateIn(new Date(end.getTime() - 1), tz),
    timeZone: tz,
    error: null,
  };
}

/** Resolves the dashboard's query string (?period=month|30d|90d|custom&from=&to=). Defaults to this month. */
export function resolvePeriod(
  params: { period?: string | string[] | null; from?: string | string[] | null; to?: string | string[] | null },
  now: Date,
  timeZone?: string | null,
): DashboardRange {
  const one = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  const key = one(params.period);
  if (key === "30d") return rollingRange(now, 30, timeZone);
  if (key === "90d") return rollingRange(now, 90, timeZone);
  if (key === "custom") {
    const r = customRange(one(params.from), one(params.to), now, timeZone);
    if ("key" in r) return r;
    return { ...monthRange(now, timeZone), error: r.error };
  }
  return monthRange(now, timeZone);
}

/** Query string for a period (used by the selector links and the calibration back link). */
export function periodQuery(range: Pick<DashboardRange, "key" | "from" | "to">): string {
  if (range.key === "custom") return `?period=custom&from=${range.from}&to=${range.to}`;
  if (range.key === "month") return "";
  return `?period=${range.key}`;
}

/**
 * The `count` calendar months (local) ending with the month that contains the end of the range, oldest first,
 * as { key: "YYYY-MM", label: "Oct", start, end }. Used for monthly trend lines.
 */
export function trailingMonths(
  rangeEnd: Date,
  count: number,
  timeZone?: string | null,
): { key: string; label: string; start: Date; end: Date }[] {
  const tz = safeTz(timeZone);
  const last = new TZDate(rangeEnd.getTime() - 1, tz);
  const out: { key: string; label: string; start: Date; end: Date }[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = localMidnight(last.getFullYear(), last.getMonth() - i, 1, tz);
    const end = localMidnight(last.getFullYear(), last.getMonth() - i + 1, 1, tz);
    const l = new TZDate(start.getTime(), tz);
    out.push({
      key: `${l.getFullYear()}-${String(l.getMonth() + 1).padStart(2, "0")}`,
      label: fmt(start, tz, { month: "short" }),
      start,
      end,
    });
  }
  return out;
}
