import Link from "next/link";
import { asc } from "drizzle-orm";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AUDIT_ACTIONS, auditTableNames, listAuditLog, type AuditFilters, type AuditRow } from "@/lib/admin/audit-log";
import { jsonChanges, showValue } from "@/lib/admin/diff";
import { requireUser } from "@/lib/auth/session";
import { localDateAt } from "@/lib/today/time";
import { cn, formatDateTime, isUuid } from "@/lib/utils";
import { SettingsHeader } from "../_components/settings-header";

export const metadata = { title: "Audit log" };

type SP = { table?: string; user?: string; action?: string; row?: string; from?: string; to?: string; before?: string; after?: string };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SIZE = 50;

const ACTION_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger" | "brand"> = {
  insert: "success",
  update: "neutral",
  delete: "danger",
  reassign: "info",
  merge: "warning",
  unmerge: "warning",
  export: "brand",
  export_denied: "danger",
  verify: "success",
};

function rowLink(r: AuditRow): string | null {
  if (!r.rowId) return null;
  if (r.tableName === "contacts" && isUuid(r.rowId)) return `/contacts/${r.rowId}`;
  if (r.tableName === "users" && isUuid(r.rowId)) return `/team/${r.rowId}`;
  if (r.tableName === "products" && isUuid(r.rowId)) return `/settings/products/${r.rowId}`;
  if (r.tableName === "organisations" && isUuid(r.rowId)) return `/organisations/${r.rowId}`;
  return null;
}

/** "old -> new" lines: a path-by-path diff for JSON documents (settings), else the two values. */
function Change({ r }: { r: AuditRow }) {
  const isDoc = (v: unknown) => typeof v === "object" && v !== null;
  if (r.action === "export" || r.action === "export_denied") {
    const v = (r.newValue ?? {}) as { filters?: Record<string, string>; rows?: number; fileName?: string };
    const f = Object.entries(v.filters ?? {})
      .map(([k, x]) => `${k}=${x}`)
      .join(", ");
    return (
      <span>
        {r.action === "export" ? `${(v.rows ?? 0).toLocaleString("en-IN")} rows` : "Refused"}
        {f ? <span className="text-muted"> · {f}</span> : <span className="text-muted"> · no filters</span>}
      </span>
    );
  }
  if (r.action === "login") return <span className="text-muted">Signed in</span>;
  if (isDoc(r.oldValue) && isDoc(r.newValue)) {
    const changes = jsonChanges(r.oldValue, r.newValue, 8);
    if (!changes.length) return <span className="text-muted">No difference</span>;
    return (
      <ul className="flex flex-col gap-0.5">
        {changes.map((c) => (
          <li key={c.path} className="break-words">
            <span className="font-mono text-xs text-muted">{c.path}</span>{" "}
            <span className="text-muted line-through decoration-muted/50">{showValue(c.before, 60)}</span> → <span>{showValue(c.after, 60)}</span>
          </li>
        ))}
        {changes.length === 8 && <li className="text-xs text-muted">and more…</li>}
      </ul>
    );
  }
  if (r.oldValue === null && r.newValue === null) return <span className="text-muted">–</span>;
  if (r.oldValue === null || r.oldValue === undefined) return <span className="break-words">{showValue(r.newValue, 200)}</span>;
  return (
    <span className="break-words">
      <span className="text-muted line-through decoration-muted/50">{showValue(r.oldValue, 100)}</span> → {showValue(r.newValue, 100)}
    </span>
  );
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireUser(["admin"]);
  const sp = await searchParams;
  const tz = me.timezone || "Asia/Kolkata";
  const from = sp.from && YMD.test(sp.from) ? sp.from : null;
  const to = sp.to && YMD.test(sp.to) ? sp.to : null;
  const toStart = to ? localDateAt(to, tz, 0, 0) : null;
  const filters: AuditFilters = {
    table: sp.table?.slice(0, 60) || null,
    userId: sp.user === "system" || isUuid(sp.user) ? sp.user : null,
    action: sp.action?.slice(0, 40) || null,
    rowId: sp.row?.slice(0, 120) || null,
    from: from ? localDateAt(from, tz, 0, 0) : null,
    to: toStart ? new Date(toStart.getTime() + 24 * 3600 * 1000) : null,
  };
  const before = Number(sp.before);
  const after = Number(sp.after);
  const [page, tables, people] = await Promise.all([
    listAuditLog(filters, {
      before: Number.isFinite(before) && before > 0 ? before : null,
      after: Number.isFinite(after) && after > 0 ? after : null,
      limit: PAGE_SIZE,
    }),
    auditTableNames(),
    db.select({ id: users.id, name: users.name }).from(users).orderBy(asc(users.name)),
  ]);
  const actions = [...new Set([...AUDIT_ACTIONS, ...(filters.action ? [filters.action] : [])])];
  const keep = new URLSearchParams();
  for (const k of ["table", "user", "action", "row", "from", "to"] as const) if (sp[k]) keep.set(k, sp[k]!);
  const href = (extra: Record<string, string>) => {
    const q = new URLSearchParams(keep);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return `/settings/audit?${q.toString()}`;
  };
  const filtered = keep.toString() !== "";

  return (
    <div className="mx-auto max-w-6xl">
      <SettingsHeader title="Audit log" description="Profile edits, stage changes, verifications, merges, reassignments, exports and settings changes, newest first." />

      <form method="get" action="/settings/audit" className="mb-4 grid gap-3 rounded-xl border border-border bg-surface p-3 sm:grid-cols-3 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]" aria-label="Filter the audit log">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Table
          <Select name="table" defaultValue={filters.table ?? ""} placeholder="All tables" options={[...new Set([...tables, ...(filters.table ? [filters.table] : [])])].map((t) => ({ value: t, label: t }))} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Who
          <Select name="user" defaultValue={sp.user ?? ""} placeholder="Everyone">
            <option value="system">The system</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Action
          <Select name="action" defaultValue={filters.action ?? ""} placeholder="All actions" options={actions.map((a) => ({ value: a, label: a.replace(/_/g, " ") }))} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          From
          <Input type="date" name="from" defaultValue={from ?? ""} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          To
          <Input type="date" name="to" defaultValue={to ?? ""} />
        </label>
        {sp.row && <input type="hidden" name="row" value={sp.row} />}
        <div className="flex items-end gap-2">
          <button type="submit" className={buttonClass("primary", "md", "flex-1 lg:flex-none")}>
            Filter
          </button>
          {filtered && (
            <Link href="/settings/audit" className={buttonClass("ghost", "md")}>
              Clear
            </Link>
          )}
        </div>
        {sp.row && (
          <p className="text-xs text-muted sm:col-span-3 lg:col-span-6">
            Showing one record: <span className="font-mono">{sp.row}</span>
          </p>
        )}
      </form>

      <Card>
        {page.rows.length === 0 ? (
          <EmptyState title={filtered ? "Nothing matches these filters" : "Nothing logged yet"} description={filtered ? "Try a wider date range or clear a filter." : undefined} />
        ) : (
          <ul className="divide-y divide-border">
            {page.rows.map((r) => {
              const link = rowLink(r);
              return (
                <li key={r.id} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[9rem_10rem_minmax(0,1fr)] md:gap-4">
                  <div className="flex items-center gap-2 text-xs text-muted md:block">
                    <time dateTime={new Date(r.changedAt).toISOString()}>{formatDateTime(r.changedAt, tz)}</time>
                    <span className="md:mt-0.5 md:block">{r.userName ?? (r.userId ? "Former user" : "System")}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 md:block">
                    <Badge tone={ACTION_TONE[r.action] ?? "neutral"}>{r.action.replace(/_/g, " ")}</Badge>
                    <span className="text-xs md:mt-1 md:block">
                      {r.tableName}
                      {r.field && r.field !== r.rowId ? <span className="text-muted"> · {r.field}</span> : null}
                    </span>
                    {r.rowId && (
                      <span className="block max-w-full truncate font-mono text-xs text-muted">
                        {link ? (
                          <Link href={link} className="underline-offset-2 hover:underline">
                            {r.rowId}
                          </Link>
                        ) : (
                          r.rowId
                        )}
                      </span>
                    )}
                  </div>
                  <div className={cn("min-w-0 text-sm")}>
                    <Change r={r} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {(page.newerCursor || page.olderCursor) && (
          <nav className="flex items-center justify-between border-t border-border px-4 py-3" aria-label="Pages">
            {page.newerCursor ? (
              <Link href={href({ after: String(page.newerCursor) })} className={buttonClass("outline", "sm")}>
                <ChevronLeft className="h-4 w-4" aria-hidden /> Newer
              </Link>
            ) : (
              <span />
            )}
            {page.olderCursor ? (
              <Link href={href({ before: String(page.olderCursor) })} className={buttonClass("outline", "sm")}>
                Older <ChevronRight className="h-4 w-4" aria-hidden />
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </Card>
    </div>
  );
}
