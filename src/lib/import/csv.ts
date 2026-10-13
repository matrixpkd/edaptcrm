/** CSV writing for the invalid-rows download. Pure. */
import { neutraliseFormula } from "@/lib/admin/csv";

/** A CSV cell; text that a spreadsheet would run as a formula is prefixed with ' so it stays text. */
export function csvCell(v: unknown): string {
  const s = neutraliseFormula(v === null || v === undefined ? "" : String(v));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}
