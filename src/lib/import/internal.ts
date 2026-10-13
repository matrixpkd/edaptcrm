import "server-only";
/**
 * Shared plumbing for the import services: permission check, batch loading/locking, bulk row updates and the
 * batch counts. Not part of the public API.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { db, type Database, type Tx } from "@/db";
import { importBatches, type ImportBatch, type ImportStatus } from "@/db/schema";
import { can } from "@/lib/auth/permissions";
import type { Role } from "@/db/schema";
import { isUuid } from "@/lib/utils";
import type { BatchCounts, BatchProgress, BatchSettings } from "./types";

export type Actor = { id: string; role: Role };

/** A problem the admin can act on; the message is shown as is. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export function assertCanImport(actor: Actor | null | undefined): asserts actor is Actor {
  if (!actor || !can(actor, "import.run")) throw new ImportError("Only an admin can run imports.");
}

export function inTx<T>(tx: Tx, fn: (t: Tx) => Promise<T>): Promise<T> {
  return (tx as Database).transaction((t) => fn(t));
}

export type LoadedBatch = ImportBatch & { settings: BatchSettings; countsT: BatchCounts };

function withTyped(b: ImportBatch): LoadedBatch {
  return { ...b, settings: b.defaults as unknown as BatchSettings, countsT: (b.counts ?? {}) as BatchCounts };
}

/** The batch, or an ImportError. `lock` takes a row lock for the rest of the transaction. */
export async function loadBatch(
  batchId: string,
  t: Tx = db,
  opts: { lock?: "wait" | "skip" } = {},
): Promise<LoadedBatch | null> {
  if (!isUuid(batchId)) throw new ImportError("Import not found.");
  const q = t.select().from(importBatches).where(eq(importBatches.id, batchId)).limit(1);
  const rows = opts.lock === "skip" ? await q.for("update", { skipLocked: true }) : opts.lock === "wait" ? await q.for("update") : await q;
  if (!rows[0]) {
    if (opts.lock === "skip") {
      // either missing or busy: tell them apart
      const exists = await t.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.id, batchId)).limit(1);
      if (exists[0]) return null;
    }
    throw new ImportError("Import not found.");
  }
  return withTyped(rows[0]);
}

export async function getBatchOrThrow(batchId: string, t: Tx = db): Promise<LoadedBatch> {
  const b = await loadBatch(batchId, t);
  if (!b) throw new ImportError("Import not found.");
  return b;
}

export function assertStatus(b: { status: ImportStatus }, allowed: ImportStatus[], message: string): void {
  if (!allowed.includes(b.status)) throw new ImportError(message);
}

/** A text[] built from a JSON array parameter (safe for any value, including commas). */
export function textArray(values: readonly string[]): SQL {
  return sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}

export function uuidArray(values: readonly string[]): SQL {
  return sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)::uuid)`;
}

type RowPatch = {
  id: string;
  mapped?: unknown;
  cleaned?: unknown;
  issues?: string[];
  matchResult?: string | null;
  matchContactId?: string | null;
  resolution?: string | null;
  contactId?: string | null;
  applied?: unknown;
};

const ROW_COLS: Record<Exclude<keyof RowPatch, "id">, { col: string; type: string }> = {
  mapped: { col: "mapped", type: "jsonb" },
  cleaned: { col: "cleaned", type: "jsonb" },
  issues: { col: "issues", type: "jsonb" },
  matchResult: { col: "match_result", type: "text" },
  matchContactId: { col: "match_contact_id", type: "uuid" },
  resolution: { col: "resolution", type: "text" },
  contactId: { col: "contact_id", type: "uuid" },
  applied: { col: "applied", type: "jsonb" },
};

/**
 * Writes many import rows in one statement per 1,000 (jsonb_to_recordset). Every patch must carry the same
 * keys; `keys` lists them.
 */
export async function bulkUpdateRows(
  batchId: string,
  patches: RowPatch[],
  keys: (keyof typeof ROW_COLS)[],
  t: Tx,
): Promise<void> {
  if (!patches.length || !keys.length) return;
  const setList = keys.map((k) => `"${ROW_COLS[k].col}" = v."${ROW_COLS[k].col}"`).join(", ");
  const recordDef = ["id uuid", ...keys.map((k) => `"${ROW_COLS[k].col}" ${ROW_COLS[k].type}`)].join(", ");
  for (let i = 0; i < patches.length; i += 1000) {
    const payload = patches.slice(i, i + 1000).map((p) => {
      const o: Record<string, unknown> = { id: p.id };
      for (const k of keys) o[ROW_COLS[k].col] = p[k] ?? null;
      return o;
    });
    await t.execute(sql`
      update import_rows as r set ${sql.raw(setList)}
      from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as v(${sql.raw(recordDef)})
      where r.id = v.id and r.batch_id = ${batchId}
    `);
  }
}

/**
 * Counts of rows, written to the batch. They partition the file: new / merge / conflict count rows that will be
 * imported (manually skipped rows are left out), invalid rows, and skip (duplicates and rows skipped by hand).
 * `unresolved` is the conflicts still waiting for a decision; `toCommit` the rows commit will process.
 */
export async function refreshCounts(batchId: string, t: Tx, extra: BatchCounts = {}): Promise<BatchCounts> {
  const rows = await t.execute<{ match_result: string | null; resolution: string | null; n: number }>(sql`
    select match_result, resolution, count(*)::int as n from import_rows where batch_id = ${batchId} group by 1, 2
  `);
  const [b] = await t.select({ counts: importBatches.counts }).from(importBatches).where(eq(importBatches.id, batchId)).limit(1);
  const counts: BatchCounts = { ...((b?.counts ?? {}) as BatchCounts) };
  const c = { total: 0, new: 0, merge: 0, conflict: 0, invalid: 0, skip: 0, unresolved: 0, toCommit: 0 };
  for (const r of rows) {
    c.total += r.n;
    if (r.match_result === "invalid") c.invalid += r.n;
    else if (r.resolution === "skip" || r.match_result === "skip") c.skip += r.n;
    else if (r.match_result === "new" || r.match_result === "merge" || r.match_result === "conflict") c[r.match_result] += r.n;
    if (r.match_result === "conflict" && !r.resolution) c.unresolved += r.n;
    if (r.resolution === "create" || r.resolution === "merge") c.toCommit += r.n;
  }
  Object.assign(counts, c, extra);
  await t.update(importBatches).set({ counts }).where(eq(importBatches.id, batchId));
  return counts;
}

/** Merge new values into the batch progress json. */
export async function setProgress(batchId: string, progress: BatchProgress, t: Tx): Promise<void> {
  await t.execute(sql`
    update import_batches
    set defaults = jsonb_set(defaults, '{progress}', coalesce(defaults->'progress', '{}'::jsonb) || ${JSON.stringify(progress)}::jsonb)
    where id = ${batchId}
  `);
}

/** Add to numeric counts atomically. */
export async function addCounts(batchId: string, add: BatchCounts, t: Tx): Promise<void> {
  const entries = Object.entries(add).filter(([, v]) => typeof v === "number" && v !== 0);
  if (!entries.length) return;
  let expr = sql`counts`;
  for (const [k, v] of entries) {
    expr = sql`jsonb_set(${expr}, ${`{${k}}`}::text[], to_jsonb(coalesce((counts->>${k})::int, 0) + ${v}::int))`;
  }
  await t.execute(sql`update import_batches set counts = ${expr} where id = ${batchId}`);
}
