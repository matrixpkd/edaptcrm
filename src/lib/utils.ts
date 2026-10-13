import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

const inrFormatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

/** ₹1,20,000 */
export function formatINR(n: number | null | undefined): string {
  return inrFormatter.format(Number(n ?? 0));
}

/** ₹1.2L, ₹45K, ₹2.3Cr — for dense tables and tiles */
export function formatINRCompact(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${trim(abs / 1e3)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

function trim(n: number) {
  return n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, "");
}

export function formatMoney(amount: number | null | undefined, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(
      Number(amount ?? 0),
    );
  } catch {
    return `${currency} ${Number(amount ?? 0).toLocaleString("en-IN")}`;
  }
}

export function formatDate(d: Date | string | null | undefined, timeZone = "Asia/Kolkata"): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone }).format(
    new Date(d),
  );
}

export function formatDateTime(d: Date | string | null | undefined, timeZone = "Asia/Kolkata"): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(d));
}

/** "3 days ago", "in 2 hours", "just now" */
export function formatRelative(d: Date | string | null | undefined, now: Date = new Date()): string {
  if (!d) return "";
  const diff = new Date(d).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const min = 60_000, hour = 60 * min, day = 24 * hour;
  if (abs < min) return "just now";
  if (abs < hour) return rtf.format(Math.round(diff / min), "minute");
  if (abs < day) return rtf.format(Math.round(diff / hour), "hour");
  if (abs < 30 * day) return rtf.format(Math.round(diff / day), "day");
  if (abs < 365 * day) return rtf.format(Math.round(diff / (30 * day)), "month");
  return rtf.format(Math.round(diff / (365 * day)), "year");
}

export const DAY_MS = 24 * 3600 * 1000;

export function daysBetween(a: Date | string, b: Date | string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** "MOHAMMED ali k" -> "Mohammed Ali K" */
export function properCase(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s\-'.(])(\p{L})/gu, (_, p, c: string) => p + c.toUpperCase());
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

/** True for a canonical uuid (any version). Ids from forms, URLs and webhooks are checked before they reach SQL. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
