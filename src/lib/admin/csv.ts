/**
 * CSV writing for exports. PURE.
 * - RFC 4180 quoting (commas, quotes, line breaks).
 * - Spreadsheet formula injection is neutralised: a cell that would start a formula (=, @, tab, carriage return,
 *   or + / - not followed by a number) gets a leading apostrophe. Phone numbers such as +919876543210 and
 *   negative amounts stay as they are.
 */

export type CsvValue = string | number | boolean | Date | null | undefined;

/** UTF-8 byte order mark, so Excel opens Malayalam and Arabic names correctly. */
export const CSV_BOM = "﻿";

const NUMBER_LIKE = /^[+-]?\d[\d\s.,]*$/;

export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = Number.isNaN(v.getTime()) ? "" : v.toISOString();
  else if (typeof v === "number") s = Number.isFinite(v) ? String(v) : "";
  else if (typeof v === "boolean") s = v ? "yes" : "no";
  else s = v;
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !NUMBER_LIKE.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: CsvValue[]): string {
  return values.map(csvCell).join(",") + "\r\n";
}

/** "2026-10-13 14:05" in the given time zone (exports show local time; the header names the zone). */
export function csvDateTime(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** "edapt-contacts-2026-10-13.csv" (the date in the admin's time zone). */
export function exportFileName(kind: string, now: Date, timeZone: string): string {
  return `edapt-${kind}-${csvDateTime(now, timeZone).slice(0, 10)}.csv`;
}
