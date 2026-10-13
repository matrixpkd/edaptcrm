import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ContactPurchase } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import {
  PAYMENT_MODE_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
  PURCHASE_STATUS_LABELS,
  PURCHASE_STATUS_TONE,
  formatAmount,
} from "@/components/contacts/labels";
import { formatDate, formatINR } from "@/lib/utils";
import type { Labels } from "./labels";

export function PurchasesTab({
  purchases,
  contactId,
  canRecord,
  labels,
  tz,
}: {
  purchases: ContactPurchase[];
  contactId: string;
  canRecord: boolean;
  labels: Labels;
  tz: string;
}) {
  const record = canRecord ? (
    <ButtonLink href={`/contacts/${contactId}/payment`} size="md">
      Record payment
    </ButtonLink>
  ) : null;
  if (!purchases.length) {
    return (
      <EmptyState
        title="No purchases yet"
        description="TagMango orders arrive here on their own. Bank and UPI payments are recorded by hand."
        action={record}
      />
    );
  }
  return (
    <div className="space-y-3">
      {record && <div className="flex justify-end">{record}</div>}
      <ul className="space-y-3">
        {purchases.map((p) => {
          const foreign = p.currency !== "INR";
          const instalments = p.payments.filter((x) => x.kind === "payment");
          const refunds = p.payments.filter((x) => x.kind === "refund");
          return (
            <li key={p.id} className="rounded-xl border border-border bg-surface">
              <div className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-semibold">{p.productName}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {labels.family(p.family)} · {formatDate(p.purchasedAt, tz)} ·{" "}
                    {PAYMENT_MODE_LABELS[p.mode] ?? p.mode}
                    {p.reference && <> · ref {p.reference}</>}
                  </p>
                </div>
                <Badge tone={PURCHASE_STATUS_TONE[p.status]}>{PURCHASE_STATUS_LABELS[p.status]}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border px-4 py-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted">Amount</dt>
                  <dd className="tabular font-medium">
                    {formatAmount(p.amount, p.currency)}
                    {foreign && (
                      <span className="block text-xs font-normal text-muted">
                        {formatINR(p.amountInr)} at {p.fxRate}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Received (verified)</dt>
                  <dd className="tabular font-medium">
                    {formatAmount(p.totals.net, p.currency)}
                    {foreign && (
                      <span className="block text-xs font-normal text-muted">{formatINR(p.totals.netInr)}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Outstanding</dt>
                  <dd className="tabular font-medium">{formatAmount(p.totals.outstanding, p.currency)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Sales credit</dt>
                  <dd className="font-medium">
                    {p.creditedUserName ? `${p.creditedUserName}${p.assisted ? " (assisted)" : ""}` : "Self-serve"}
                  </dd>
                </div>
              </dl>
              {(p.hasInstalments || p.totals.unverified > 0 || refunds.length > 0) && (
                <div className="border-t border-border px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">
                    {p.hasInstalments ? "Instalments" : "Payments"}
                  </p>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {instalments.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="tabular">
                          {p.hasInstalments ? `#${x.seq} ` : ""}
                          {formatAmount(x.amount, x.currency)}
                          <span className="text-muted">
                            {x.paidAt
                              ? ` · paid ${formatDate(x.paidAt, tz)}`
                              : x.dueAt
                                ? ` · due ${formatDate(x.dueAt, tz)}`
                                : ""}
                            {x.reference ? ` · ${x.reference}` : ""}
                          </span>
                        </span>
                        <Badge tone={PAYMENT_STATUS_TONE[x.status]}>{PAYMENT_STATUS_LABELS[x.status]}</Badge>
                      </li>
                    ))}
                    {refunds.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 text-danger">
                        <span className="tabular">
                          Refund {formatAmount(x.amount, x.currency)}
                          {x.reason && <span className="text-muted"> · {x.reason}</span>}
                        </span>
                        <Badge tone="danger">Refund</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <Link
                href={`/payments/${p.id}`}
                className="flex items-center justify-between rounded-b-xl border-t border-border px-4 py-2.5 text-sm font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                Payments, verification and refunds
                <ChevronRight className="h-4 w-4 text-muted" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
