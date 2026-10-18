import "server-only";
import { and, asc, desc, eq, gt, gte, lt, sql, type SQL } from "drizzle-orm";
import { db, queryRows, type Tx } from "@/db";
import { auditLog, users } from "@/db/schema";
import { isUuid } from "@/lib/utils";

/**
 * The audit log viewer (Settings > Audit log): newest first, keyset-paginated on the id (no OFFSET scans, no
 * COUNT over a table that grows by a row per reassigned contact).
 */

export type AuditFilters = {
  table?: string | null;
  userId?: string | null;
  action?: string | null;
  rowId?: string | null;
  /** inclusive lower bound */
  from?: Date | null;
  /** exclusive upper bound */
  to?: Date | null;
};

export type AuditRow = {
  id: number;
  tableName: string;
  rowId: string | null;
  action: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  userId: string | null;
  userName: string | null;
  changedAt: Date;
};

export type AuditPage = {
  rows: AuditRow[];
  /** id to pass as `before` for the next (older) page, or null at the end */
  olderCursor: number | null;
  /** id to pass as `after` for the previous (newer) page, or null on the newest page */
  newerCursor: number | null;
};

/** Actions written by the services; the filter offers these. */
export const AUDIT_ACTIONS = [
  "insert",
  "update",
  "delete",
  "reassign",
  "merge",
  "unmerge",
  "verify",
  "transfer_request",
  "import",
  "undo",
  "export",
  "export_denied",
  "recompute",
  "reprocess",
  "login",
] as const;

function where(f: AuditFilters): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  if (f.table) conds.push(eq(auditLog.tableName, f.table));
  if (f.userId && isUuid(f.userId)) conds.push(eq(auditLog.userId, f.userId));
  else if (f.userId === "system") conds.push(sql`${auditLog.userId} is null`);
  if (f.action) conds.push(eq(auditLog.action, f.action));
  if (f.rowId) conds.push(eq(auditLog.rowId, f.rowId));
  if (f.from) conds.push(gte(auditLog.changedAt, f.from));
  if (f.to) conds.push(lt(auditLog.changedAt, f.to));
  return conds.length ? and(...conds) : undefined;
}

/**
 * One page of the audit log. Without a cursor: the newest `limit` rows. `before`: rows older than that id.
 * `after`: rows newer than that id (the previous page), still returned newest first.
 */
export async function listAuditLog(
  filters: AuditFilters,
  opts: { before?: number | null; after?: number | null; limit?: number } = {},
  tx: Tx = db,
): Promise<AuditPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const base = where(filters);
  const cols = {
    id: auditLog.id,
    tableName: auditLog.tableName,
    rowId: auditLog.rowId,
    action: auditLog.action,
    field: auditLog.field,
    oldValue: auditLog.oldValue,
    newValue: auditLog.newValue,
    userId: auditLog.userId,
    userName: users.name,
    changedAt: auditLog.changedAt,
  };
  const forward = opts.after != null && Number.isFinite(opts.after);
  const cursor = forward
    ? gt(auditLog.id, Number(opts.after))
    : opts.before != null && Number.isFinite(opts.before)
      ? lt(auditLog.id, Number(opts.before))
      : undefined;
  const rows = await tx
    .select(cols)
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(and(base, cursor))
    .orderBy(forward ? asc(auditLog.id) : desc(auditLog.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  if (forward) page.reverse();
  const first = page[0]?.id ?? null;
  const last = page[page.length - 1]?.id ?? null;
  return {
    rows: page as AuditRow[],
    olderCursor: forward ? (last !== null ? last : null) : more ? last : null,
    newerCursor: forward ? (more ? first : null) : opts.before != null ? first : null,
  };
}

/** Distinct table names in the log (a loose index scan over audit_log_row_idx: one probe per name). */
export async function auditTableNames(tx: Tx = db): Promise<string[]> {
  const rows = await queryRows<{ v: string }>(sql`
    with recursive t(v) as (
      (select table_name from audit_log order by table_name limit 1)
      union all
      select (select a.table_name from audit_log a where a.table_name > t.v order by a.table_name limit 1)
      from t where t.v is not null
    )
    select v from t where v is not null
  `, tx);
  return rows.map((r) => r.v);
}
