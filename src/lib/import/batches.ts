import "server-only";
/**
 * The import wizard's batch service: upload (step 1), mapping (step 2), cleaning (step 3, chunked), the review
 * decisions (step 5) and the queries behind the screens. Matching is in ./match.ts, commit in ./commit.ts and
 * undo in ./undo.ts. Every function checks can(actor, "import.run") itself: never trust the caller.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { getCountries } from "libphonenumber-js/max";
import { db, type Tx } from "@/db";
import {
  contacts,
  importBatches,
  importRows,
  PAYMENT_MODES,
  products,
  users,
  type ImportMatchResult,
  type ImportStatus,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { cleanText, looseKey } from "@/lib/contacts/rules";
import { getSettings } from "@/lib/settings";
import { readStoredFile, saveFile } from "@/lib/storage";
import { isUuid } from "@/lib/utils";
import { aiAvailable, proposeMappingWithClaude } from "./ai";
import { applyMapping, cellText, cleanRow, type CleanContext } from "./clean";
import { csvLine } from "./csv";
import { heuristicMapping } from "./heuristic";
import {
  addCounts,
  assertCanImport,
  assertStatus,
  bulkUpdateRows,
  getBatchOrThrow,
  ImportError,
  loadBatch,
  refreshCounts,
  setProgress,
  type Actor,
} from "./internal";
import { parseImportFile, type ParsedFile } from "./parse";
import { lockedForSource, presetDefaults } from "./presets";
import {
  isImportSource,
  isTargetField,
  type BatchCounts,
  type BatchSettings,
  type ColumnMapping,
  type ImportDefaults,
  type ImportSource,
  type ProductChoice,
  type StoredClean,
} from "./types";

export { ImportError } from "./internal";
export { ImportFileError } from "./parse";

/** What every chunked phase returns to the screen's progress loop. */
export type PhaseResult = {
  /** rows handled by this call */
  processed: number;
  done: number;
  total: number;
  finished: boolean;
  /** another request is working on this batch right now: try again in a moment */
  busy?: boolean;
};

const EDITABLE: ImportStatus[] = ["uploaded", "mapped", "cleaned", "matched"];

// ---------------------------------------------------------------------------
// Step 1: upload
// ---------------------------------------------------------------------------

/** Up to 5 distinct non-empty sample values per column, from the first rows. */
export function columnSamples(headers: string[], raws: Record<string, unknown>[], scan = 500): { header: string; samples: string[] }[] {
  return headers.map((header) => {
    const seen: string[] = [];
    for (const raw of raws.slice(0, scan)) {
      const v = cellText(raw[header]);
      if (v && !seen.includes(v)) seen.push(v.slice(0, 80));
      if (seen.length >= 5) break;
    }
    return { header, samples: seen };
  });
}

/** Claude's mapping when it is available (completed by the heuristic for any column it left out), else the heuristic. */
async function proposeMapping(
  source: ImportSource,
  parsed: Pick<ParsedFile, "headers" | "rows" | "extractedBy">,
): Promise<{ mapping: ColumnMapping; by: "ai" | "heuristic"; note: string | null }> {
  const columns = columnSamples(parsed.headers, parsed.rows.map((r) => r.raw));
  const heuristic = heuristicMapping(columns);
  // rows Claude pulled out of a doc already carry our own field names
  if (parsed.extractedBy === "ai") return { mapping: heuristic, by: "ai", note: null };
  if (parsed.extractedBy === "heuristic") return { mapping: heuristic, by: "heuristic", note: null };
  if (!aiAvailable()) return { mapping: heuristic, by: "heuristic", note: "No Anthropic API key is set" };
  const ai = await proposeMappingWithClaude({ source, columns });
  if (!ai.ok) return { mapping: heuristic, by: "heuristic", note: ai.reason };
  const mapping: ColumnMapping = {};
  for (const h of parsed.headers) mapping[h] = ai.value[h] ?? heuristic[h] ?? "ignore";
  return { mapping, by: "ai", note: null };
}

async function insertRows(batchId: string, rows: ParsedFile["rows"], t: Tx): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    await t.insert(importRows).values(
      rows.slice(i, i + 1000).map((r) => ({ batchId, rowNumber: r.rowNumber, raw: r.raw, issues: [] as string[] })),
    );
  }
}

/**
 * Step 1: stores the file (folder "imports"), reads it, stores every row's raw values (never modified) and
 * proposes the column mapping. Returns the new batch id. The batch waits in "uploaded" for step 2.
 */
export async function createImportBatch(
  input: { fileName: string; fileType: string; bytes: Uint8Array; source: string },
  actor: Actor,
): Promise<string> {
  assertCanImport(actor);
  if (!isImportSource(input.source)) throw new ImportError("Choose where the file comes from.");
  const source = input.source;
  const fileName = cleanText(input.fileName) ?? "import";
  const defaults = presetDefaults(source);
  const parsed = await parseImportFile(input.bytes, fileName, { defaultCountry: defaults.defaultCountry, useAi: aiAvailable() });
  const fileUrl = await saveFile({ name: fileName, type: input.fileType || "application/octet-stream", data: input.bytes }, "imports");
  const proposal = await proposeMapping(source, parsed);
  const settings: BatchSettings = {
    ...defaults,
    file: {
      kind: parsed.kind,
      headers: parsed.headers,
      rowCount: parsed.rows.length,
      sheets: parsed.sheets,
      sheet: parsed.sheet ?? null,
      extractedBy: parsed.extractedBy ?? null,
      size: input.bytes.length,
      type: input.fileType,
    },
    mappingBy: proposal.by,
    mappingNote: [parsed.note, proposal.note].filter(Boolean).join(". ") || null,
    progress: {},
  };
  return db.transaction(async (t) => {
    const [b] = await t
      .insert(importBatches)
      .values({
        fileName,
        source,
        uploadedById: actor.id,
        status: "uploaded",
        counts: { total: parsed.rows.length },
        mapping: proposal.mapping,
        defaults: settings as unknown as Record<string, unknown>,
        fileUrl,
      })
      .returning({ id: importBatches.id });
    await insertRows(b.id, parsed.rows, t);
    await audit(
      {
        table: "import_batches",
        rowId: b.id,
        action: "insert",
        newValue: { fileName, source, rows: parsed.rows.length, mappingBy: proposal.by },
        userId: actor.id,
      },
      t,
    );
    return b.id;
  });
}

/** The stored upload's bytes (local ./uploads or Supabase Storage). */
async function storedBytes(fileUrl: string | null): Promise<Uint8Array> {
  const key = fileUrl?.replace(/^\/api\/files\//, "");
  const file = key ? await readStoredFile(key) : null;
  if (!file) throw new ImportError("The uploaded file could not be found. Upload it again.");
  if ("bytes" in file) return file.bytes;
  const res = await fetch(file.redirect);
  if (!res.ok) throw new ImportError("The uploaded file could not be read. Upload it again.");
  return new Uint8Array(await res.arrayBuffer());
}

/** Step 2 (Excel): read another sheet of the same workbook. Replaces the rows and proposes a new mapping. */
export async function changeSheet(batchId: string, sheet: string, actor: Actor): Promise<void> {
  assertCanImport(actor);
  const b = await getBatchOrThrow(batchId);
  assertStatus(b, EDITABLE, "The sheet can only be changed before the import is committed.");
  if (b.settings.file.kind !== "xlsx" || !b.settings.file.sheets?.includes(sheet)) throw new ImportError("That sheet is not in this workbook.");
  const parsed = await parseImportFile(await storedBytes(b.fileUrl), b.fileName, { sheet, useAi: false });
  const proposal = await proposeMapping(b.source as ImportSource, parsed);
  await db.transaction(async (t) => {
    const locked = await loadBatch(batchId, t, { lock: "wait" });
    if (!locked) throw new ImportError("Import not found.");
    assertStatus(locked, EDITABLE, "The sheet can only be changed before the import is committed.");
    await t.delete(importRows).where(eq(importRows.batchId, batchId));
    await insertRows(batchId, parsed.rows, t);
    const settings: BatchSettings = {
      ...locked.settings,
      file: { ...locked.settings.file, headers: parsed.headers, rowCount: parsed.rows.length, sheet: parsed.sheet ?? sheet },
      mappingBy: proposal.by,
      mappingNote: proposal.note,
      productMap: {},
      progress: {},
    };
    await t
      .update(importBatches)
      .set({
        status: "uploaded",
        mapping: proposal.mapping,
        defaults: settings as unknown as Record<string, unknown>,
        counts: { total: parsed.rows.length },
      })
      .where(eq(importBatches.id, batchId));
    await audit({ table: "import_batches", rowId: batchId, action: "update", field: "sheet", oldValue: locked.settings.file.sheet, newValue: sheet, userId: actor.id }, t);
  });
}

// ---------------------------------------------------------------------------
// Step 2: mapping and defaults
// ---------------------------------------------------------------------------

export type MappingInput = {
  mapping: Record<string, string>;
  defaults: Partial<Omit<ImportDefaults, "source">>;
};

/** Validates the step 2 form against the file and Settings. Returns the clean mapping and defaults. */
async function validateMapping(
  b: { source: string; settings: BatchSettings },
  input: MappingInput,
  t: Tx,
): Promise<{ mapping: ColumnMapping; defaults: ImportDefaults }> {
  const headers = b.settings.file.headers;
  const mapping: ColumnMapping = {};
  for (const h of headers) {
    const f = input.mapping[h];
    mapping[h] = isTargetField(f) ? f : "ignore";
  }
  const used = Object.values(mapping);
  if (!used.includes("phone") && !used.includes("email")) {
    throw new ImportError("Map a column to Phone or Email: every row needs one of them.");
  }
  const s = await getSettings(["lists.firstDoors", "lists.campaigns", "ladder.families", "currency"], t);
  const d = input.defaults;
  const source = b.source as ImportSource;
  const base = { ...presetDefaults(source), ...b.settings };
  const out: ImportDefaults = {
    source,
    firstDoor: d.firstDoor === undefined ? base.firstDoor : cleanText(d.firstDoor),
    campaign: d.campaign === undefined ? base.campaign : cleanText(d.campaign),
    tags: d.tags === undefined ? base.tags : [...new Set(d.tags.map((x) => cleanText(x)).filter((x): x is string => !!x))].slice(0, 20),
    tagWithCampaign: d.tagWithCampaign ?? base.tagWithCampaign,
    defaultCountry: (d.defaultCountry ?? base.defaultCountry ?? "IN").toUpperCase(),
    ownerFallback: d.ownerFallback ?? base.ownerFallback ?? "pool",
    ownerFromFile: d.ownerFromFile ?? base.ownerFromFile ?? false,
    recordsDate: d.recordsDate === undefined ? (base.recordsDate ?? null) : cleanText(d.recordsDate),
    dayFirst: d.dayFirst ?? base.dayFirst ?? true,
    currency: (d.currency ?? base.currency ?? "INR").toUpperCase(),
    paymentMode: d.paymentMode ?? base.paymentMode ?? "other",
    verified: d.verified ?? base.verified ?? true,
    productFamily: d.productFamily === undefined ? base.productFamily : cleanText(d.productFamily),
    productMap: d.productMap ?? base.productMap ?? {},
    ...lockedForSource(source),
  };
  if (out.firstDoor && !s["lists.firstDoors"].some((i) => i.key === out.firstDoor)) throw new ImportError("Choose a first door from the list.");
  if (out.campaign && out.campaign.length > 120) throw new ImportError("The campaign is too long.");
  if (out.recordsDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.recordsDate) || Number.isNaN(Date.parse(`${out.recordsDate}T00:00:00Z`))) {
      throw new ImportError("Enter the date of these records as a date.");
    }
    if (Date.parse(`${out.recordsDate}T00:00:00Z`) > Date.now() + 24 * 3600 * 1000) throw new ImportError("The date of these records can't be in the future.");
  }
  if (!(getCountries() as string[]).includes(out.defaultCountry)) throw new ImportError("Choose a default country for phone numbers.");
  if (out.ownerFallback !== "pool" && out.ownerFallback !== "round_robin") {
    const [u] = isUuid(out.ownerFallback)
      ? await t.select({ id: users.id, active: users.active, role: users.role }).from(users).where(eq(users.id, out.ownerFallback)).limit(1)
      : [];
    if (!u || !u.active || u.role === "support") throw new ImportError("The owner must be an active team member who can own contacts.");
  }
  const currencies = ["INR", ...Object.keys(s.currency.rates ?? {}).map((c) => c.toUpperCase())];
  if (!currencies.includes(out.currency)) throw new ImportError(`There is no exchange rate for ${out.currency} in Settings.`);
  if (!(PAYMENT_MODES as readonly string[]).includes(out.paymentMode)) throw new ImportError("Choose a payment mode.");
  const families = s["ladder.families"].map((f) => f.key);
  if (out.productFamily && !families.includes(out.productFamily)) throw new ImportError("Choose a product family from the list.");
  const productMap: Record<string, ProductChoice> = {};
  const ids = Object.values(out.productMap).map((c) => c.productId).filter((x): x is string => !!x && isUuid(x));
  const known = ids.length ? new Set((await t.select({ id: products.id }).from(products).where(inArray(products.id, ids))).map((p) => p.id)) : new Set<string>();
  for (const [k, c] of Object.entries(out.productMap)) {
    const key = looseKey(k);
    if (!key) continue;
    if (c.productId && known.has(c.productId)) productMap[key] = { productId: c.productId };
    else if (c.family && families.includes(c.family)) productMap[key] = { family: c.family };
  }
  out.productMap = productMap;
  return { mapping, defaults: out };
}

/**
 * Step 2: saves the confirmed mapping and defaults, and resets every later step (rows are cleaned and matched
 * again). Allowed until the import is committed.
 */
export async function saveMapping(batchId: string, input: MappingInput, actor: Actor): Promise<void> {
  assertCanImport(actor);
  await db.transaction(async (t) => {
    const b = await loadBatch(batchId, t, { lock: "wait" });
    if (!b) throw new ImportError("Import not found.");
    assertStatus(b, EDITABLE, "The mapping can only be changed before the import is committed.");
    const { mapping, defaults } = await validateMapping(b, input, t);
    const settings: BatchSettings = { ...b.settings, ...defaults, progress: {} };
    await t
      .update(importBatches)
      .set({
        mapping,
        defaults: settings as unknown as Record<string, unknown>,
        status: "mapped",
        counts: { total: b.countsT.total ?? b.settings.file.rowCount },
        error: null,
      })
      .where(eq(importBatches.id, batchId));
    await t
      .update(importRows)
      .set({ mapped: null, cleaned: null, issues: [], matchResult: null, matchContactId: null, resolution: null })
      .where(eq(importRows.batchId, batchId));
    await audit(
      { table: "import_batches", rowId: batchId, action: "update", field: "mapping", oldValue: b.mapping, newValue: { mapping, defaults }, userId: actor.id },
      t,
    );
  });
}

// ---------------------------------------------------------------------------
// Step 3: clean (chunked)
// ---------------------------------------------------------------------------

export async function loadCleanContext(
  settings: BatchSettings,
  t: Tx,
  opts: { now?: Date; timeZone?: string } = {},
): Promise<CleanContext> {
  const s = await getSettings(
    ["lists.firstDoors", "lists.campaigns", "lists.languages", "lists.ageBands", "lists.industries", "ladder.families", "currency"],
    t,
  );
  const team = await t
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active })
    .from(users);
  const catalogue = await t
    .select({ id: products.id, name: products.name, family: products.family, externalIds: products.externalIds })
    .from(products);
  return {
    defaults: settings,
    now: opts.now ?? new Date(),
    timeZone: opts.timeZone,
    lists: {
      firstDoors: s["lists.firstDoors"],
      campaigns: s["lists.campaigns"],
      languages: s["lists.languages"],
      ageBands: s["lists.ageBands"],
      industries: s["lists.industries"],
      families: s["ladder.families"],
    },
    currencies: ["INR", ...Object.keys(s.currency.rates ?? {}).map((c) => c.toUpperCase())],
    users: team,
    products: catalogue,
  };
}

/** Step 3, one chunk: maps and cleans the next rows. The batch moves to "cleaned" when every row is done. */
export async function runCleanChunk(
  batchId: string,
  actor: Actor,
  opts: { limit?: number; timeZone?: string; now?: Date } = {},
): Promise<PhaseResult> {
  assertCanImport(actor);
  const limit = Math.max(1, Math.min(opts.limit ?? 2000, 5000));
  return db.transaction(async (t) => {
    const b = await loadBatch(batchId, t, { lock: "skip" });
    if (!b) return { processed: 0, done: 0, total: 0, finished: false, busy: true };
    const total = b.countsT.total ?? b.settings.file.rowCount;
    if (b.status !== "mapped") {
      if (["cleaned", "matched", "committing", "committed"].includes(b.status)) return { processed: 0, done: total, total, finished: true };
      throw new ImportError("Confirm the column mapping first.");
    }
    const cursor = b.settings.progress?.cleanCursor ?? 0;
    const rows = await t
      .select({ id: importRows.id, rowNumber: importRows.rowNumber, raw: importRows.raw })
      .from(importRows)
      .where(and(eq(importRows.batchId, batchId), gt(importRows.rowNumber, cursor)))
      .orderBy(asc(importRows.rowNumber))
      .limit(limit);
    if (!rows.length) {
      await t.update(importBatches).set({ status: "cleaned" }).where(eq(importBatches.id, batchId));
      return { processed: 0, done: total, total, finished: true };
    }
    const ctx = await loadCleanContext(b.settings, t, { now: opts.now, timeZone: opts.timeZone });
    const mapping = (b.mapping ?? {}) as ColumnMapping;
    const headers = b.settings.file.headers;
    const patches = rows.map((r) => {
      const mapped = applyMapping(r.raw, mapping, headers);
      const cleaned = cleanRow(mapped, ctx);
      return { id: r.id, mapped, cleaned, issues: [...cleaned.errors, ...cleaned.warnings] };
    });
    await bulkUpdateRows(batchId, patches, ["mapped", "cleaned", "issues"], t);
    await setProgress(batchId, { cleanCursor: rows[rows.length - 1].rowNumber }, t);
    await addCounts(batchId, { cleaned: rows.length }, t);
    const done = (b.countsT.cleaned ?? 0) + rows.length;
    return { processed: rows.length, done, total, finished: false };
  });
}

// ---------------------------------------------------------------------------
// Step 5: review decisions
// ---------------------------------------------------------------------------

async function lockForReview(batchId: string, t: Tx) {
  const b = await loadBatch(batchId, t, { lock: "wait" });
  if (!b) throw new ImportError("Import not found.");
  assertStatus(b, ["matched"], "Rows can only be changed while the import is being reviewed.");
  return b;
}

/** Skip rows, or bring skipped rows back (invalid rows and duplicate orders always stay skipped). */
export async function setRowsSkipped(batchId: string, rowIds: string[], skip: boolean, actor: Actor): Promise<number> {
  assertCanImport(actor);
  const ids = rowIds.filter(isUuid);
  if (!ids.length) return 0;
  return db.transaction(async (t) => {
    await lockForReview(batchId, t);
    const res = skip
      ? await t
          .update(importRows)
          .set({ resolution: "skip" })
          .where(and(eq(importRows.batchId, batchId), inArray(importRows.id, ids), inArray(importRows.matchResult, ["new", "merge", "conflict"])))
          .returning({ id: importRows.id })
      : await t
          .update(importRows)
          .set({
            resolution: sql`case ${importRows.matchResult} when 'new' then 'create' when 'merge' then 'merge' else null end`,
          })
          .where(
            and(
              eq(importRows.batchId, batchId),
              inArray(importRows.id, ids),
              eq(importRows.resolution, "skip"),
              inArray(importRows.matchResult, ["new", "merge", "conflict"]),
            ),
          )
          .returning({ id: importRows.id });
    await refreshCounts(batchId, t);
    return res.length;
  });
}

export type ConflictDecision = { kind: "new" } | { kind: "contact"; contactId: string } | { kind: "row" };

/**
 * One conflict (same name in the same city): import it as a new contact, merge it into one of the existing
 * contacts that were found, or into the earlier row of this file with the same name and city.
 */
export async function resolveConflict(batchId: string, rowId: string, decision: ConflictDecision, actor: Actor): Promise<void> {
  assertCanImport(actor);
  if (!isUuid(rowId)) throw new ImportError("Row not found.");
  await db.transaction(async (t) => {
    await lockForReview(batchId, t);
    const [row] = await t
      .select()
      .from(importRows)
      .where(and(eq(importRows.batchId, batchId), eq(importRows.id, rowId)))
      .limit(1);
    if (!row || row.matchResult !== "conflict") throw new ImportError("This row is not a conflict.");
    const match = (row.cleaned as StoredClean | null)?.match ?? {};
    if (decision.kind === "new") {
      await t.update(importRows).set({ resolution: "create" }).where(eq(importRows.id, rowId));
    } else if (decision.kind === "contact") {
      if (!match.candidates?.some((c) => c.id === decision.contactId)) throw new ImportError("Choose one of the contacts that were found.");
      await t.update(importRows).set({ resolution: "merge", matchContactId: decision.contactId }).where(eq(importRows.id, rowId));
    } else {
      if (!match.conflictRow) throw new ImportError("There is no earlier row to merge into.");
      await t.update(importRows).set({ resolution: "merge", matchContactId: null }).where(eq(importRows.id, rowId));
    }
    await refreshCounts(batchId, t);
  });
}

/** One click: every undecided conflict is imported as a new contact (the same-name pairs are flagged for review). */
export async function resolveAllConflictsAsNew(batchId: string, actor: Actor): Promise<number> {
  assertCanImport(actor);
  return db.transaction(async (t) => {
    await lockForReview(batchId, t);
    const res = await t
      .update(importRows)
      .set({ resolution: "create" })
      .where(and(eq(importRows.batchId, batchId), eq(importRows.matchResult, "conflict"), isNull(importRows.resolution)))
      .returning({ id: importRows.id });
    await refreshCounts(batchId, t);
    return res.length;
  });
}

/** Deletes an import that was never committed (its rows go with it). */
export async function discardBatch(batchId: string, actor: Actor): Promise<void> {
  assertCanImport(actor);
  await db.transaction(async (t) => {
    const b = await loadBatch(batchId, t, { lock: "wait" });
    if (!b) throw new ImportError("Import not found.");
    if (["committing", "committed"].includes(b.status)) throw new ImportError("A committed import cannot be discarded: undo it instead.");
    if (b.status === "undone") throw new ImportError("An undone import is kept as a record.");
    await t.delete(importBatches).where(eq(importBatches.id, batchId));
    await audit({ table: "import_batches", rowId: batchId, action: "delete", oldValue: { fileName: b.fileName, source: b.source }, userId: actor.id }, t);
  });
}

// ---------------------------------------------------------------------------
// Queries for the screens
// ---------------------------------------------------------------------------

export type BatchListItem = {
  id: string;
  fileName: string;
  source: string;
  status: string;
  counts: BatchCounts;
  uploadedByName: string | null;
  createdAt: Date;
  committedAt: Date | null;
  undoneAt: Date | null;
  undoing: boolean;
};

export async function listBatches(actor: Actor, opts: { limit?: number } = {}): Promise<BatchListItem[]> {
  assertCanImport(actor);
  const rows = await db
    .select({
      id: importBatches.id,
      fileName: importBatches.fileName,
      source: importBatches.source,
      status: importBatches.status,
      counts: importBatches.counts,
      defaults: importBatches.defaults,
      uploadedByName: users.name,
      createdAt: importBatches.createdAt,
      committedAt: importBatches.committedAt,
      undoneAt: importBatches.undoneAt,
    })
    .from(importBatches)
    .leftJoin(users, eq(users.id, importBatches.uploadedById))
    .orderBy(desc(importBatches.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));
  return rows.map(({ defaults, ...r }) => ({
    ...r,
    counts: r.counts as BatchCounts,
    undoing: !!(defaults as unknown as BatchSettings)?.progress?.undoStartedAt && r.status === "committed",
  }));
}

export type BatchView = Awaited<ReturnType<typeof getBatchView>>;

export async function getBatchView(batchId: string, actor: Actor) {
  assertCanImport(actor);
  if (!isUuid(batchId)) return null;
  const b = await loadBatch(batchId).catch(() => null);
  if (!b) return null;
  const names = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [b.uploadedById, b.undoneById].filter((x): x is string => !!x)));
  const nameOf = (id: string | null) => names.find((n) => n.id === id)?.name ?? null;
  return { ...b, uploadedByName: nameOf(b.uploadedById), undoneByName: nameOf(b.undoneById) };
}

export const ROW_VIEWS = ["all", "new", "merge", "conflict", "invalid", "skip", "failed", "kept"] as const;
export type RowView = (typeof ROW_VIEWS)[number];

export type ReviewRow = {
  id: string;
  rowNumber: number;
  raw: Record<string, unknown>;
  cleaned: StoredClean | null;
  issues: string[];
  matchResult: ImportMatchResult | null;
  matchContactId: string | null;
  matchContactName: string | null;
  resolution: string | null;
  contactId: string | null;
  contactName: string | null;
  applied: Record<string, unknown> | null;
};

function viewCondition(view: RowView) {
  switch (view) {
    case "new":
    case "merge":
    case "conflict":
      return and(eq(importRows.matchResult, view), sql`${importRows.resolution} is distinct from 'skip'`);
    case "invalid":
      return eq(importRows.matchResult, "invalid");
    case "skip":
      return and(ne(importRows.matchResult, "invalid"), sql`(${importRows.resolution} = 'skip' or ${importRows.matchResult} = 'skip')`);
    case "failed":
      return and(isNotNull(importRows.applied), sql`${importRows.applied}->>'error' is not null`);
    case "kept":
      return sql`${importRows.applied}->>'undoNote' is not null`;
    default:
      return undefined;
  }
}

/** One page of rows for the review table. */
export async function listRows(
  batchId: string,
  actor: Actor,
  opts: { view?: RowView; page?: number; pageSize?: number } = {},
): Promise<{ rows: ReviewRow[]; total: number; page: number; pageSize: number }> {
  assertCanImport(actor);
  if (!isUuid(batchId)) return { rows: [], total: 0, page: 1, pageSize: 50 };
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 10), 200);
  const where = and(eq(importRows.batchId, batchId), viewCondition(opts.view ?? "all"));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(importRows).where(where);
  const pages = Math.max(1, Math.ceil(n / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const matched = sql<string | null>`(select name from contacts where id = ${importRows.matchContactId})`;
  const committed = sql<string | null>`(select name from contacts where id = ${importRows.contactId})`;
  const rows = await db
    .select({
      id: importRows.id,
      rowNumber: importRows.rowNumber,
      raw: importRows.raw,
      cleaned: importRows.cleaned,
      issues: importRows.issues,
      matchResult: importRows.matchResult,
      matchContactId: importRows.matchContactId,
      matchContactName: matched,
      resolution: importRows.resolution,
      contactId: importRows.contactId,
      contactName: committed,
      applied: importRows.applied,
    })
    .from(importRows)
    .where(where)
    .orderBy(asc(importRows.rowNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    rows: rows.map((r) => ({ ...r, cleaned: r.cleaned as StoredClean | null, applied: r.applied as Record<string, unknown> | null })),
    total: n,
    page,
    pageSize,
  };
}

/** Sample values per column for step 2 (from the first rows of the file). */
export async function batchColumnSamples(batchId: string, headers: string[]): Promise<{ header: string; samples: string[] }[]> {
  const rows = await db
    .select({ raw: importRows.raw })
    .from(importRows)
    .where(eq(importRows.batchId, batchId))
    .orderBy(asc(importRows.rowNumber))
    .limit(300);
  return columnSamples(headers, rows.map((r) => r.raw));
}

/** The distinct values of the product column (most common first), for the product choices in step 2. */
export async function productValues(batchId: string, column: string, limit = 150): Promise<{ value: string; n: number }[]> {
  const rows = await db.execute<{ value: string; n: number }>(sql`
    select trim(raw->>${column}) as value, count(*)::int as n
    from import_rows
    where batch_id = ${batchId} and coalesce(trim(raw->>${column}), '') <> ''
    group by 1 order by 2 desc, 1 limit ${limit}
  `);
  return [...rows];
}

/** What a commit will do, for the confirmation: rows, new contacts, merges and payments. */
export async function commitPreview(batchId: string): Promise<{ rows: number; create: number; merge: number; purchases: number }> {
  const [r] = await db.execute<{ rows: number; create: number; merge: number; purchases: number }>(sql`
    select count(*)::int as rows,
      count(*) filter (where resolution = 'create')::int as create,
      count(*) filter (where resolution = 'merge')::int as merge,
      count(*) filter (where jsonb_typeof(cleaned->'purchase') = 'object' and cleaned->'match'->>'duplicatePurchase' is null)::int as purchases
    from import_rows where batch_id = ${batchId} and resolution in ('create', 'merge')
  `);
  return { rows: r?.rows ?? 0, create: r?.create ?? 0, merge: r?.merge ?? 0, purchases: r?.purchases ?? 0 };
}

/** Every non-merged contact who has paid at least once: Edapt's true count of unique customers. */
export async function uniqueCustomerCount(tx: Tx = db): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(isNull(contacts.mergedIntoId), gt(contacts.purchaseCount, 0)));
  return r?.n ?? 0;
}

/** Which sources already have a committed import, for the recommended-order checklist. */
export async function committedSources(): Promise<Record<string, Date>> {
  const rows = await db
    .select({ source: importBatches.source, at: sql<Date>`max(${importBatches.committedAt})` })
    .from(importBatches)
    .where(eq(importBatches.status, "committed"))
    .groupBy(importBatches.source);
  return Object.fromEntries(rows.map((r) => [r.source, new Date(r.at)]));
}

// ---------------------------------------------------------------------------
// Invalid rows as CSV
// ---------------------------------------------------------------------------

/** The invalid rows with their original values and the problems, as CSV text pieces (streamed by the route). */
export async function* invalidRowsCsv(batchId: string, actor: Actor): AsyncGenerator<string> {
  assertCanImport(actor);
  const b = await getBatchOrThrow(batchId);
  const headers = b.settings.file.headers;
  // a download of people's raw rows is an export: logged like every export (spec "Data hygiene")
  await audit({
    table: "import_rows",
    rowId: batchId,
    action: "export",
    field: "invalid_rows",
    newValue: { fileName: b.fileName, rows: b.countsT.invalid ?? 0 },
    userId: actor.id,
  });
  yield "\uFEFF" + csvLine(["Row", ...headers, "Problems"]);
  let after = 0;
  for (;;) {
    const rows = await db
      .select({ rowNumber: importRows.rowNumber, raw: importRows.raw, issues: importRows.issues })
      .from(importRows)
      .where(and(eq(importRows.batchId, batchId), eq(importRows.matchResult, "invalid"), gt(importRows.rowNumber, after)))
      .orderBy(asc(importRows.rowNumber))
      .limit(2000);
    if (!rows.length) break;
    yield rows
      .map((r) => csvLine([r.rowNumber, ...headers.map((h) => cellText(r.raw[h])), (r.issues ?? []).join("; ")]))
      .join("");
    after = rows[rows.length - 1].rowNumber;
  }
}
