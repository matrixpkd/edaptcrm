/** CSV writing for the invalid-rows download. Pure. */

/** A CSV cell; text that a spreadsheet would run as a formula is prefixed with ' so it stays text. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+@\t\r]|^-(?!\d)/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}
