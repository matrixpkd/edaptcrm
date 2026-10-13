import Link from "next/link";
import type { ImportMatchResult } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import type { ReviewRow } from "@/lib/import/batches";
import { MATCH_LABELS, type AppliedRow } from "@/lib/import/types";
import { formatPhone } from "@/lib/phone";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import { ConflictButtons, SkipRowButton } from "./row-actions";

const TONE: Record<ImportMatchResult, "info" | "success" | "warning" | "danger" | "neutral"> = {
  new: "info",
  merge: "success",
  conflict: "warning",
  invalid: "danger",
  skip: "neutral",
};

function firstValue(raw: Record<string, unknown>): string {
  for (const v of Object.values(raw)) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

/** What happens (or happened) to the row, in words. */
function Outcome({ row, batchId, editable }: { row: ReviewRow; batchId: string; editable: boolean }) {
  const m = row.cleaned?.match ?? {};
  const applied = row.applied as AppliedRow | null;
  if (applied) {
    if (applied.error) return <p className="text-sm text-danger">Not imported: {applied.error}</p>;
    if (applied.undone) {
      const who = row.contactName ?? row.cleaned?.name ?? "the contact";
      if (applied.createdContact && !row.contactName) return <p className="text-sm text-muted">Created {who}; removed by the undo</p>;
      if (applied.withCreatedContact && !row.contactName) {
        return <p className="text-sm text-muted">Added to {who}, a contact this import created; removed by the undo</p>;
      }
      return (
        <div className="space-y-0.5 text-sm">
          <p>
            {applied.createdContact ? "Created " : "Was added to "}
            {row.contactId && row.contactName ? (
              <Link href={`/contacts/${row.contactId}`} className="font-medium underline underline-offset-2">
                {row.contactName}
              </Link>
            ) : (
              who
            )}
          </p>
          <p className="text-xs text-muted">
            {applied.undoNote ?? (applied.withCreatedContact ? "Undone with the contact this import created" : "Put back as it was by the undo")}
          </p>
        </div>
      );
    }
    const link = row.contactId ? (
      <Link href={`/contacts/${row.contactId}`} className="font-medium underline underline-offset-2">
        {row.contactName ?? "the contact"}
      </Link>
    ) : (
      <span className="font-medium">{row.contactName ?? "a contact that was removed"}</span>
    );
    return (
      <div className="space-y-0.5 text-sm">
        <p>
          {applied.createdContact ? "Created " : "Added to "}
          {link}
          {applied.purchaseId ? ", with the purchase" : ""}
        </p>
      </div>
    );
  }
  if (row.resolution === "skip" && row.matchResult !== "invalid" && row.matchResult !== "skip") {
    return <p className="text-sm text-muted">Skipped by hand</p>;
  }
  switch (row.matchResult) {
    case "new":
      return <p className="text-sm text-muted">A new contact</p>;
    case "merge":
      if (row.matchContactId) {
        return (
          <p className="text-sm">
            Matches{" "}
            <Link href={`/contacts/${row.matchContactId}`} className="font-medium underline underline-offset-2">
              {row.matchContactName ?? m.contactName ?? "a contact"}
            </Link>{" "}
            {m.by === "email" ? "by email" : m.by === "phone" ? "by phone" : `(same person as row ${m.sameAsRow})`}
          </p>
        );
      }
      return <p className="text-sm">Same person as row {m.sameAsRow}: one contact, several rows</p>;
    case "conflict": {
      const candidates = m.candidates ?? [];
      const decided =
        row.resolution === "create" ? "new" : row.resolution === "merge" ? (row.matchContactId ?? (m.conflictRow ? "row" : null)) : null;
      return (
        <div className="space-y-2">
          <p className="text-sm">
            Same name and city as{" "}
            {candidates.length
              ? candidates.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ", "}
                    <Link href={`/contacts/${c.id}`} className="font-medium underline underline-offset-2">
                      {c.name}
                    </Link>{" "}
                    <span className="tabular text-muted">({formatPhone(c.phone)})</span>
                  </span>
                ))
              : `row ${m.conflictRow}`}
            {!row.resolution && <span className="font-medium text-warning">: decide</span>}
          </p>
          {editable ? (
            <ConflictButtons
              batchId={batchId}
              rowId={row.id}
              candidates={candidates}
              conflictRow={m.conflictRow ?? null}
              conflictName={m.contactName ?? null}
              decided={decided}
            />
          ) : (
            <p className="text-xs text-muted">{decided === "new" ? "Imported as new" : decided ? "Merged" : "Not decided"}</p>
          )}
        </div>
      );
    }
    case "invalid":
      return <p className="text-sm text-danger">Not importable</p>;
    case "skip":
      return <p className="text-sm text-muted">Skipped: already in the CRM or repeated in the file</p>;
    default:
      return <p className="text-sm text-muted">Not checked yet</p>;
  }
}

/** The rows of the review (and of a committed import), one block per row; a grid on laptops, stacked on phones. */
export function ReviewRows({
  rows,
  batchId,
  editable,
  tz,
}: {
  rows: ReviewRow[];
  batchId: string;
  editable: boolean;
  tz: string;
}) {
  return (
    <div>
      <div className="hidden grid-cols-[96px_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.5fr)_80px] gap-3 border-b border-border bg-surface-muted/60 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted md:grid">
        <span>Row</span>
        <span>Person</span>
        <span>Purchase</span>
        <span>What happens</span>
        <span className="sr-only">Actions</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const c = r.cleaned;
          const p = c?.purchase;
          const result = r.matchResult;
          const skippedByHand = r.resolution === "skip" && result !== "invalid" && result !== "skip";
          const applied = r.applied as AppliedRow | null;
          // after the commit the badge says what happened, not what was planned
          const badge: { tone: "neutral" | "info" | "success" | "warning" | "danger"; label: string } | null = applied
            ? applied.error
              ? { tone: "danger", label: "Failed" }
              : applied.undone
                ? { tone: "neutral", label: "Undone" }
                : applied.createdContact
                  ? { tone: "info", label: "Created" }
                  : { tone: "success", label: "Merged" }
            : result
              ? { tone: skippedByHand ? "neutral" : TONE[result], label: skippedByHand ? "Skipped" : MATCH_LABELS[result] }
              : null;
          const issues = r.issues ?? [];
          const errors = new Set(c?.errors ?? []);
          return (
            <li
              key={r.id}
              className={cn(
                "relative grid gap-2 px-4 py-3 md:grid-cols-[96px_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.5fr)_80px] md:gap-3",
                skippedByHand && "opacity-60",
              )}
            >
              <div className="flex items-center gap-2 pr-20 md:flex-col md:items-start md:gap-1 md:pr-0">
                <span className="tabular text-xs text-muted">Row {r.rowNumber}</span>
                {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
              </div>
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium">{c?.name ?? <span className="text-muted">{firstValue(r.raw) || "No name"}</span>}</p>
                <p className="tabular truncate text-xs text-muted">
                  {c?.phone ? formatPhone(c.phone) : "No valid phone"}
                  {c?.email ? ` · ${c.email}` : ""}
                </p>
                {(!!c?.city || !!c?.altPhones?.length) && (
                  <p className="truncate text-xs text-muted">
                    {[c?.city, c?.altPhones?.length ? `+${c.altPhones.length} other number${c.altPhones.length > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
              <div className="min-w-0 text-sm">
                {p ? (
                  <>
                    <p className="truncate">{p.productName}</p>
                    <p className="tabular truncate text-xs text-muted">
                      {formatMoney(p.amount, p.currency)}
                      {p.purchasedAt ? ` · ${formatDate(p.purchasedAt, tz)}` : ""}
                    </p>
                    {p.orderId && <p className="tabular truncate text-xs text-muted">Order {p.orderId}</p>}
                  </>
                ) : (
                  <span className="text-xs text-muted">No purchase</span>
                )}
              </div>
              <div className="min-w-0 space-y-1">
                <Outcome row={r} batchId={batchId} editable={editable} />
                {issues.length > 0 && (
                  <ul className="space-y-0.5">
                    {issues.slice(0, 4).map((i, k) => (
                      <li key={k} className={cn("text-xs", errors.has(i) || result === "invalid" ? "text-danger" : "text-muted")}>
                        {i}
                      </li>
                    ))}
                    {issues.length > 4 && <li className="text-xs text-muted">and {issues.length - 4} more</li>}
                  </ul>
                )}
              </div>
              <div className="absolute right-3 top-2 md:static md:text-right">
                {editable && (result === "new" || result === "merge" || result === "conflict") && (
                  <SkipRowButton batchId={batchId} rowId={r.id} skip={r.resolution !== "skip"} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
