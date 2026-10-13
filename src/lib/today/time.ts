/**
 * Local-calendar helpers for the Today queue, Log interaction and Rate screens.
 * PURE (no server imports): safe in client components. Every function takes `now` so it is testable.
 * "Today" always means the user's own calendar day in their time zone (default Asia/Kolkata).
 */
import { TZDate } from "@date-fns/tz";
import { localTimeInDays } from "@/lib/contacts/follow-up";

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

const DAY_MS = 24 * 3600 * 1000;

/** The zone itself when the runtime knows it, otherwise India time. */
export function validTimeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** 00:00 of `now`'s local calendar day, as a UTC instant. */
export function localDayStart(now: Date, timeZone: string | null | undefined): Date {
  return localTimeInDays(now, validTimeZone(timeZone), 0, 0, 0);
}

/** 00:00 of the next local calendar day (exclusive end of "today"), as a UTC instant. */
export function localDayEnd(now: Date, timeZone: string | null | undefined): Date {
  return localTimeInDays(now, validTimeZone(timeZone), 1, 0, 0);
}

/** Whole local calendar days from `from` to `to` (positive when `to` is later). DST-safe. */
export function localDaysBetween(from: Date, to: Date, timeZone: string | null | undefined): number {
  const a = localDayStart(from, timeZone).getTime();
  const b = localDayStart(to, timeZone).getTime();
  return Math.round((b - a) / DAY_MS);
}

/** The local hour (0-23) of `now`. */
export function localHour(now: Date, timeZone: string | null | undefined): number {
  return new TZDate(now.getTime(), validTimeZone(timeZone)).getHours();
}

/** "Good morning" before 12:00, "Good afternoon" before 17:00, then "Good evening" (local time). */
export function greetingFor(now: Date, timeZone: string | null | undefined): string {
  const h = localHour(now, timeZone);
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** "12 Oct" (adds the year when it is not the current local year). */
export function shortDate(d: Date, now: Date, timeZone: string | null | undefined): string {
  const tz = validTimeZone(timeZone);
  const sameYear = new TZDate(d.getTime(), tz).getFullYear() === new TZDate(now.getTime(), tz).getFullYear();
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: tz,
  }).format(d);
}

/** "Tue 14 Oct" */
export function weekdayDate(d: Date, timeZone: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: validTimeZone(timeZone),
  }).format(d);
}

/** "4:30 pm" */
export function localTime(d: Date, timeZone: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: validTimeZone(timeZone) })
    .format(d)
    .replace(/\s?([ap])\.?m\.?$/i, (_, p: string) => ` ${p.toLowerCase()}m`);
}

/** Compact "how long ago": "just now", "5m ago", "2h ago", "3d ago", "4w ago", "5mo ago", "2y ago". */
export function compactAgo(d: Date, now: Date): string {
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** "YYYY-MM-DD" of `now`'s local date (for <input type="date"> min values). */
export function localIsoDate(now: Date, timeZone: string | null | undefined): string {
  const local = new TZDate(now.getTime(), validTimeZone(timeZone));
  const mm = String(local.getMonth() + 1).padStart(2, "0");
  const dd = String(local.getDate()).padStart(2, "0");
  return `${local.getFullYear()}-${mm}-${dd}`;
}

/**
 * The instant that is `hour:minute` local time on the calendar date "YYYY-MM-DD" in `timeZone`.
 * Returns null when the string is not a real date.
 */
export function localDateAt(ymd: string, timeZone: string | null | undefined, hour = 10, minute = 0): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const local = new TZDate(y, mo - 1, d, hour, minute, 0, 0, validTimeZone(timeZone));
  // reject roll-overs such as 31 Feb -> 3 Mar
  if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d) return null;
  return new Date(local.getTime());
}
