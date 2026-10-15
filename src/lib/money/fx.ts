/**
 * Currency conversion. INR is the base; Settings > Currency holds "INR per 1 unit" by month.
 * Every purchase and payment stores the rate it used, so past LTV never shifts when a rate is edited.
 *
 * Pure: safe for client components (e.g. the live INR preview on Record payment).
 * The server-side settings read lives in ./fx-server.ts (getFxRate).
 */
import type { CurrencyConfig } from "@/lib/settings/defaults";
import { UnknownCurrencyError } from "./errors";

export const BASE_CURRENCY = "INR";
/** Months are counted in Edapt's books time zone. */
export const BOOKS_TIME_ZONE = "Asia/Kolkata";

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "INR", "aed " -> "AED" */
export function normalizeCurrency(currency: string | null | undefined): string {
  return (currency ?? "").trim().toUpperCase();
}

/** The "YYYY-MM" month a moment falls in, in the given time zone (default Asia/Kolkata). */
export function monthKeyOf(at: Date, timeZone: string = BOOKS_TIME_ZONE): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new RangeError("Invalid date");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(at);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}`;
}

/** A "YYYY-MM" month key as people read it ("Oct 2026"); anything else comes back unchanged. */
export function monthKeyLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return key;
  return new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}

/**
 * INR per 1 unit of `currency` for a payment made at `at`.
 * - INR -> 1.
 * - Otherwise the rate of the latest month key ("YYYY-MM") at or before the payment month;
 *   if every month in the table is later than the payment, the earliest available month.
 * - A currency with no valid rate -> UnknownCurrencyError.
 * Invalid month keys and non-positive rates in the table are ignored.
 */
export function rateFromTable(
  rates: CurrencyConfig["rates"],
  currency: string,
  at: Date,
  timeZone: string = BOOKS_TIME_ZONE,
): number {
  const cur = normalizeCurrency(currency);
  if (cur === BASE_CURRENCY) return 1;
  if (!cur) throw new UnknownCurrencyError(currency);
  const table =
    rates?.[cur] ?? Object.entries(rates ?? {}).find(([k]) => normalizeCurrency(k) === cur)?.[1] ?? undefined;
  const months = Object.entries(table ?? {})
    .filter(([k, v]) => MONTH_KEY.test(k) && typeof v === "number" && Number.isFinite(v) && v > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!months.length) throw new UnknownCurrencyError(cur);
  const month = monthKeyOf(at, timeZone);
  let chosen = months[0];
  for (const m of months) {
    if (m[0] <= month) chosen = m;
    else break;
  }
  return chosen[1];
}

/** Round to 2 decimals (paise / fils), half away from zero, without float drift (1.005 -> 1.01). */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) throw new RangeError("Invalid amount");
  const abs = Math.abs(n);
  const r = Math.round((abs + abs * Number.EPSILON) * 100) / 100;
  return (n < 0 ? -r : r) || 0;
}

/** Amount in INR at the given rate, rounded to 2 decimals. */
export function toInr(amount: number, rate: number): number {
  return roundMoney(amount * rate);
}

/** Rates are stored with 6 decimals. */
export function roundRate(rate: number): number {
  return Number(rate.toFixed(6));
}

/** Currencies that have at least one usable rate, INR first. */
export function currenciesWithRates(cfg: Pick<CurrencyConfig, "rates">): string[] {
  const out = [BASE_CURRENCY];
  for (const [cur, table] of Object.entries(cfg.rates ?? {})) {
    const c = normalizeCurrency(cur);
    if (c === BASE_CURRENCY || out.includes(c)) continue;
    if (Object.entries(table ?? {}).some(([k, v]) => MONTH_KEY.test(k) && typeof v === "number" && v > 0)) out.push(c);
  }
  return out;
}
