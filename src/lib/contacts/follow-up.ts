/**
 * Next follow-up chips on the Log interaction sheet: tomorrow, in 3 days, in 1 week, each at 10:00
 * in the user's own time zone. Pure (safe in client components); pass `now` so it is testable.
 */
import { TZDate } from "@date-fns/tz";

export const FOLLOW_UP_HOUR = 10;

export const FOLLOW_UP_PRESETS = [
  { key: "tomorrow", label: "Tomorrow", days: 1 },
  { key: "in3Days", label: "3 days", days: 3 },
  { key: "in1Week", label: "1 week", days: 7 },
] as const;

export type FollowUpPresetKey = (typeof FOLLOW_UP_PRESETS)[number]["key"];

/**
 * The instant that is `hour:minute` local time, `days` calendar days after `now`'s local date in `timeZone`.
 * Calendar days, not 24-hour blocks, so a late-night call still gets "tomorrow 10:00" in local time.
 */
export function localTimeInDays(now: Date, timeZone: string, days: number, hour = FOLLOW_UP_HOUR, minute = 0): Date {
  const tz = safeTimeZone(timeZone);
  const local = new TZDate(now.getTime(), tz);
  const target = new TZDate(local.getFullYear(), local.getMonth(), local.getDate() + days, hour, minute, 0, 0, tz);
  return new Date(target.getTime());
}

/** { tomorrow, in3Days, in1Week } as UTC instants for 10:00 in the user's time zone. */
export function followUpPresets(now: Date, timeZone: string): Record<FollowUpPresetKey, Date> {
  return {
    tomorrow: localTimeInDays(now, timeZone, 1),
    in3Days: localTimeInDays(now, timeZone, 3),
    in1Week: localTimeInDays(now, timeZone, 7),
  };
}

/** Zones already checked: building an Intl.DateTimeFormat is slow and the Today queue calls this per row. */
const checkedZones = new Map<string, string>();

/** Falls back to India time when the stored time zone is missing or unknown. */
function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return "Asia/Kolkata";
  const known = checkedZones.get(tz);
  if (known) return known;
  let out: string;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    out = tz;
  } catch {
    out = "Asia/Kolkata";
  }
  if (checkedZones.size < 500) checkedZones.set(tz, out);
  return out;
}
