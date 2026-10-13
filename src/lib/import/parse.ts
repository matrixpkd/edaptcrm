import "server-only";
/**
 * Step 1: reading the uploaded file into rows of text cells.
 * - CSV / TSV (papaparse), with a windows-1252 fallback for files that are not UTF-8.
 * - Excel .xlsx (exceljs): the first sheet with data, or the sheet chosen in step 2.
 * - Word .docx (mammoth): a table becomes rows; free text goes to Claude (or the line heuristic).
 * - Plain .txt: delimited text is read like a CSV, free text like a doc.
 * The raw rows are stored as they are (import_rows.raw) and never modified.
 */
import Papa from "papaparse";
import { extractRowsWithClaude, DOC_ROW_HEADERS } from "./ai";
import { extractRowsFromText, TEXT_ROW_HEADERS } from "./heuristic";
import type { FileKind } from "./types";

export const MAX_FILE_BYTES = 24 * 1024 * 1024;
export const MAX_ROWS = 100_000;

/** A problem with the file itself, shown to the admin as is. */
export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

export type ParsedRow = { rowNumber: number; raw: Record<string, string> };

export type ParsedFile = {
  kind: FileKind;
  headers: string[];
  rows: ParsedRow[];
  sheets?: string[];
  sheet?: string | null;
  extractedBy?: "table" | "ai" | "heuristic" | null;
  /** why Claude was not used for a doc */
  note?: string | null;
};

export function fileKindOf(fileName: string): FileKind {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "xlsx") return "xlsx";
  if (ext === "docx") return "docx";
  if (ext === "txt" || ext === "text") return "txt";
  if (ext === "xls") throw new ImportFileError("Old .xls files can't be read. Open it in Excel and save it as .xlsx or .csv.");
  if (ext === "doc") throw new ImportFileError("Old .doc files can't be read. Open it in Word and save it as .docx.");
  throw new ImportFileError("Upload a CSV, an Excel (.xlsx) file, a Word (.docx) document or a .txt file.");
}

/** UTF-8 when it is valid UTF-8 (BOM removed), otherwise windows-1252 (old Excel CSV exports). */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^﻿/, "");
}

/** Unique, non-empty headers: blanks become "Column 3", repeats "Name (2)". */
export function uniqueHeaders(cells: string[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((c, i) => {
    let h = (c ?? "").replace(/\s+/g, " ").trim() || `Column ${i + 1}`;
    const n = (seen.get(h.toLowerCase()) ?? 0) + 1;
    seen.set(h.toLowerCase(), n);
    if (n > 1) h = `${h} (${n})`;
    return h;
  });
}

/** Turns a grid (first non-empty row = headers) into rows. `rowNumbers[i]` is the sheet row of grid row i. */
function gridToRows(grid: string[][], rowNumbers?: number[]): { headers: string[]; rows: ParsedRow[] } {
  const first = grid.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (first < 0) return { headers: [], rows: [] };
  const width = Math.max(...grid.map((r) => r.length));
  const headerCells = Array.from({ length: width }, (_, i) => grid[first][i] ?? "");
  // trailing columns with neither a header nor data are dropped
  let last = width - 1;
  while (last >= 0 && !headerCells[last]?.trim() && !grid.some((r) => (r[last] ?? "").trim())) last--;
  const headers = uniqueHeaders(headerCells.slice(0, last + 1));
  const rows: ParsedRow[] = [];
  for (let i = first + 1; i < grid.length; i++) {
    const cells = grid[i];
    if (!cells.some((c) => (c ?? "").trim() !== "")) continue;
    const raw: Record<string, string> = {};
    headers.forEach((h, j) => {
      raw[h] = (cells[j] ?? "").trim();
    });
    rows.push({ rowNumber: rowNumbers?.[i] ?? i + 1, raw });
    if (rows.length > MAX_ROWS) throw new ImportFileError(`This file has more than ${MAX_ROWS.toLocaleString("en-IN")} rows. Split it into smaller files.`);
  }
  return { headers, rows };
}

export function parseCsvText(text: string, delimiter?: string): { headers: string[]; rows: ParsedRow[] } {
  const res = Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter: delimiter ?? "" });
  const grid = res.data.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : []));
  // papaparse rows are lines here (multi-line cells are rare); row numbers follow the file
  return gridToRows(grid);
}

/** True when most lines split into the same number (>1) of cells by one delimiter. */
function looksDelimited(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 50);
  if (lines.length < 2) return null;
  for (const d of ["\t", ",", ";", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const common = counts.filter((c) => c === counts[0] && c > 0).length;
    if (counts[0] > 0 && common / lines.length >= 0.8) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** An Excel cell as text. Dates become "YYYY-MM-DD" (or with the time), read as local time later. */
export function excelCellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const hasTime = v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds();
    return hasTime ? `${date} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}` : date;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    // whole numbers such as phone numbers must not turn into 9.19876543210e+11
    return Number.isInteger(v) ? BigInt(v).toString() : String(v);
  }
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
    if ("result" in o) return excelCellText(o.result);
    if ("text" in o) return excelCellText(o.text);
    if ("error" in o) return "";
    if ("hyperlink" in o) return String(o.hyperlink ?? "");
  }
  return String(v);
}

async function parseXlsx(bytes: Uint8Array, sheet?: string | null): Promise<ParsedFile> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch {
    throw new ImportFileError("This Excel file could not be opened. Save it again as .xlsx (or export a CSV) and retry.");
  }
  const sheets = wb.worksheets.map((w) => w.name);
  const ws =
    (sheet ? wb.worksheets.find((w) => w.name === sheet) : null) ??
    wb.worksheets.find((w) => w.actualRowCount > 0) ??
    wb.worksheets[0];
  if (!ws) throw new ImportFileError("This Excel file has no sheets.");
  const grid: string[][] = [];
  const rowNumbers: number[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = Array.isArray(row.values) ? row.values : [];
    // row.values is 1-based
    grid.push(values.slice(1).map((v) => excelCellText(v).trim()));
    rowNumbers.push(rowNumber);
  });
  const { headers, rows } = gridToRows(grid, rowNumbers);
  return { kind: "xlsx", headers, rows, sheets, sheet: ws.name };
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Every <table> in mammoth's HTML as a grid of cell texts. */
export function htmlTables(html: string): string[][][] {
  const tables: string[][][] = [];
  for (const t of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const grid: string[][] = [];
    for (const tr of t.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map((td) =>
        decodeEntities(td.replace(/<\/p>/gi, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
      );
      grid.push(cells);
    }
    if (grid.length) tables.push(grid);
  }
  return tables;
}

/** Rows from free text: Claude when available, else the line heuristic. */
async function rowsFromText(text: string, defaultCountry: string, useAi: boolean): Promise<Omit<ParsedFile, "kind">> {
  let note: string | null = null;
  if (useAi) {
    const ai = await extractRowsWithClaude(text);
    if (ai.ok) {
      return {
        headers: DOC_ROW_HEADERS,
        rows: ai.value.map((raw, i) => ({ rowNumber: i + 1, raw })),
        extractedBy: "ai",
      };
    }
    note = ai.reason;
  }
  const rows = extractRowsFromText(text, defaultCountry);
  return {
    headers: TEXT_ROW_HEADERS,
    rows: rows.map((raw, i) => ({ rowNumber: i + 1, raw })),
    extractedBy: "heuristic",
    note: note ?? "No Anthropic API key is set: rows were taken from lines with a phone number or email",
  };
}

async function parseDocx(bytes: Uint8Array, defaultCountry: string, useAi: boolean): Promise<ParsedFile> {
  const mammoth = (await import("mammoth")).default;
  const buffer = Buffer.from(bytes);
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer })).value;
  } catch {
    throw new ImportFileError("This Word document could not be opened. Save it again as .docx and retry.");
  }
  // a document holding a table is really a sheet
  const tables = htmlTables(html).filter((t) => t.length >= 2 && Math.max(...t.map((r) => r.length)) >= 2);
  if (tables.length) {
    const biggest = tables.reduce((a, b) => (b.length > a.length ? b : a));
    const { headers, rows } = gridToRows(biggest);
    return { kind: "docx", headers, rows, extractedBy: "table" };
  }
  const text = (await mammoth.extractRawText({ buffer })).value;
  return { kind: "docx", ...(await rowsFromText(text, defaultCountry, useAi)) };
}

/**
 * Reads an uploaded file into header + rows. Throws ImportFileError with a friendly message when the file
 * cannot be used.
 */
export async function parseImportFile(
  bytes: Uint8Array,
  fileName: string,
  opts: { sheet?: string | null; defaultCountry?: string; useAi?: boolean } = {},
): Promise<ParsedFile> {
  if (!bytes.length) throw new ImportFileError("The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new ImportFileError("The file is larger than 24 MB. Split it into smaller files.");
  const kind = fileKindOf(fileName);
  const defaultCountry = opts.defaultCountry ?? "IN";
  const useAi = opts.useAi !== false;
  let parsed: ParsedFile;
  if (kind === "xlsx") parsed = await parseXlsx(bytes, opts.sheet);
  else if (kind === "docx") parsed = await parseDocx(bytes, defaultCountry, useAi);
  else {
    const text = decodeText(bytes);
    const delimiter = kind === "csv" ? (fileName.toLowerCase().endsWith(".tsv") ? "\t" : undefined) : looksDelimited(text);
    if (kind === "csv" || delimiter) parsed = { kind, ...parseCsvText(text, delimiter ?? undefined) };
    else parsed = { kind, ...(await rowsFromText(text, defaultCountry, useAi)) };
  }
  if (!parsed.headers.length || !parsed.rows.length) {
    throw new ImportFileError(
      kind === "docx" || (kind === "txt" && parsed.extractedBy)
        ? "No people were found in this document (no lines with a phone number or email)."
        : "No rows were found under the header row.",
    );
  }
  return parsed;
}
