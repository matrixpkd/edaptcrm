import "server-only";
import { db, type Tx } from "@/db";
import { auditLog } from "@/db/schema";

type AuditEntry = {
  table: string;
  rowId?: string | null;
  action?: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  userId?: string | null;
};

/** Append one or more entries to the audit log. */
export async function audit(entries: AuditEntry | AuditEntry[], tx: Tx = db): Promise<void> {
  const list = Array.isArray(entries) ? entries : [entries];
  if (!list.length) return;
  await tx.insert(auditLog).values(
    list.map((e) => ({
      tableName: e.table,
      rowId: e.rowId ?? null,
      action: e.action ?? "update",
      field: e.field ?? null,
      oldValue: (e.oldValue ?? null) as unknown,
      newValue: (e.newValue ?? null) as unknown,
      userId: e.userId ?? null,
    })),
  );
}

/**
 * Log every field that differs between `before` and `after` (only keys present in `after`).
 * Dates and arrays are compared by value.
 */
export async function auditDiff(
  table: string,
  rowId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  userId: string | null,
  tx: Tx = db,
): Promise<void> {
  const entries: AuditEntry[] = [];
  for (const [field, next] of Object.entries(after)) {
    if (field === "updatedAt") continue;
    const prev = before[field];
    if (JSON.stringify(normalise(prev)) === JSON.stringify(normalise(next))) continue;
    entries.push({ table, rowId, field, oldValue: normalise(prev), newValue: normalise(next), userId });
  }
  await audit(entries, tx);
}

function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined) return null;
  return v;
}
