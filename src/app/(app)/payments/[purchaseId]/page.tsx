import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Building2, ChevronLeft, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardHeader, EmptyState } from "@/components/ui/card";
import { FlashBanner } from "@/components/contacts/flash-banner";
import { PAYMENT_MODE_LABELS, formatAmount } from "@/components/contacts/labels";
import { describeAudit } from "@/components/payments/audit";
import { Fact, Money, PaymentStatusBadge, ProofThumb, PurchaseStatusBadge } from "@/components/payments/display";
import {
  AddPaymentButton,
  CancelPurchaseButton,
  CreditForm,
  PaymentsToaster,
  RecordInstalmentButton,
  RefundButton,
  RejectButton,
  VerifyButton,
} from "@/components/payments/money-actions";
import { dueState } from "@/components/payments/rules";
import { ROLE_LABELS, can, canEditContact, canViewContact } from "@/lib/auth/permissions";
import { getCurrentUser, requireUser } from "@/lib/auth/session";
import { currenciesWithRates, normalizeCurrency } from "@/lib/money/fx";
import { formatPhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { localIsoDate, validTimeZone } from "@/lib/today/time";
import { cn, formatDate, formatDateTime, formatINR } from "@/lib/utils";
import {
  addPaymentAction,
  adjustCreditAction,
  cancelPurchaseAction,
  recordInstalmentAction,
  recordRefundAction,
  rejectPaymentAction,
  verifyPaymentAction,
} from "../actions";
import { getPurchaseAudit, getPurchaseDetail, listCreditOptions, userNames, type PaymentLine } from "../_lib/queries";

export const dynamic = "force-dynamic";

/** One read per request, shared by the title and the page. */
const loadPurchase = cache((id: string) => getPurchaseDetail(id));

export async function generateMetadata({ params }: { params: Promise<{ purchaseId: string }> }): Promise<Metadata> {
  const { purchaseId } = await params;
  const user = await getCurrentUser();
  const d = user ? await loadPurchase(purchaseId) : null;
  return { title: d && user && canViewContact(user, d.contact) ? `${d.purchase.productName} · ${d.contact.name}` : "Purchase" };
}

const MONTH = new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const SOURCE_LABELS = { tagmango: "TagMango", manual: "Recorded by hand", import: "Imported" } as const;

export default async function PurchasePage({
  params,
  searchParams,
}: {
  params: Promise<{ purchaseId: string }>;
  searchParams: Promise<{ recorded?: string }>;
}) {
  const user = await requireUser();
  const { purchaseId } = await params;
  const sp = await searchParams;
  const d = await loadPurchase(purchaseId);
  if (!d || !canViewContact(user, d.contact)) notFound();

  const { purchase: p, contact, totals } = d;
  const tz = validTimeZone(user.timezone);
  const now = new Date();
  const today = localIsoDate(now, tz);
  const settings = await getSettings(["currency", "ladder.families", "thresholds"]);
  const creditDays = settings.thresholds.salesCreditDays;
  const family = settings["ladder.families"].find((f) => f.key === p.family);
  const familyText = family ? (family.rung != null ? `${family.label} · rung ${family.rung}` : family.label) : p.family;

  const cancelled = p.status === "cancelled";
  const refunded = p.status === "refunded";
  const editable = can(user, "payments.record") && canEditContact(user, contact);
  const canVerify = can(user, "payments.verify");
  const canRefund = can(user, "payments.refund") && !cancelled && totals.net > 0;
  const canCredit = can(user, "credit.adjust");
  const anyVerified = d.payments.some((x) => x.kind === "payment" && x.status === "verified");
  const canCancel = editable && !cancelled && !anyVerified;
  const canAddPart = editable && !cancelled && !refunded && totals.collectable > 0;
  const canPayInstalment = editable && !cancelled && !refunded;

  const withRates = currenciesWithRates(settings.currency);
  const currencies = ["INR", ...settings.currency.enabled.map(normalizeCurrency).filter((c) => c !== "INR" && withRates.includes(c))];

  const [audit, creditOptions] = await Promise.all([
    getPurchaseAudit(p.id, d.payments.map((x) => x.id)),
    canCredit ? listCreditOptions(p.creditedUserId) : Promise.resolve([]),
  ]);
  const creditIds = audit.flatMap((a) => (a.field === "creditedUserId" ? [a.oldValue, a.newValue] : [])).filter((v): v is string => typeof v === "string");
  const names = await userNames(creditIds);
  const auditCtx = {
    currency: p.currency,
    hasInstalments: p.hasInstalments,
    payments: new Map(d.payments.map((x) => [x.id, { seq: x.seq, kind: x.kind }])),
    names,
  };
  const foreign = p.currency !== "INR";
  const paidShare = p.amount > 0 ? Math.min(1, totals.paid / Number(p.amount)) : 0;

  const actions = (
    <>
      {canAddPart && (
        <AddPaymentButton
          action={addPaymentAction}
          purchaseId={p.id}
          currency={p.currency}
          currencies={currencies}
          collectable={totals.collectable}
          defaultMode={p.mode === "tagmango" ? null : p.mode}
          today={today}
          canVerify={canVerify}
        />
      )}
      {canRefund && <RefundButton action={recordRefundAction} purchaseId={p.id} currency={p.currency} maxRefund={totals.net} today={today} />}
      {canCancel && <CancelPurchaseButton action={cancelPurchaseAction} purchaseId={p.id} />}
    </>
  );

  return (
    <div>
      {sp.recorded === "1" && (
        <FlashBanner
          param="recorded"
          message={
            totals.unverified > 0
              ? "Payment recorded. It counts toward LTV once a manager verifies it."
              : p.hasInstalments && totals.paid === 0
                ? "Purchase and instalment schedule saved."
                : "Payment recorded."
          }
        />
      )}

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <Link href="/payments" className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronLeft className="h-4 w-4" aria-hidden /> Payments
            </Link>
            <span aria-hidden>·</span>
            <Link href={`/contacts/${contact.id}`} className="rounded hover:text-foreground hover:underline">
              {contact.name}
            </Link>
          </div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight sm:text-2xl">
            {p.productName}
            <PurchaseStatusBadge status={p.status} />
          </h1>
          <p className="mt-1 text-sm text-muted">
            {familyText} · bought {formatDate(p.purchasedAt, tz)} · {SOURCE_LABELS[p.source]}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr] lg:items-start">
        {/* ---------------- Amounts */}
        <section className="rounded-xl border border-border bg-surface lg:col-start-2 lg:row-start-1" aria-labelledby="amt-h">
          <CardHeader title={<span id="amt-h">Amounts</span>} />
          <div className="space-y-4 p-4">
            <div>
              <p className="tabular text-2xl font-semibold">{formatAmount(p.amount, p.currency)}</p>
              <p className="text-xs text-muted">
                {foreign ? (
                  <>
                    {formatINR(p.amountInr)} at ₹{Number(p.fxRate)} per {p.currency} ({MONTH.format(p.purchasedAt)} rate)
                  </>
                ) : (
                  "Final amount in INR"
                )}
              </p>
              {p.listPrice != null && Number(p.listPrice) > 0 && (
                <p className="mt-1 text-xs text-muted">
                  List {formatAmount(p.listPrice, p.currency)}
                  {Number(p.discount) > 0 && <> · discount {formatAmount(p.discount, p.currency)}</>}
                </p>
              )}
            </div>
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={`${Math.round(paidShare * 100)}% received and verified`}>
                <div className="h-full rounded-full bg-success" style={{ width: `${paidShare * 100}%` }} />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Fact label="Received (verified)">
                <Money amount={totals.paid} currency={p.currency} inr={foreign ? totals.paidInr : null} />
              </Fact>
              <Fact label="Waiting verification">
                <span className={cn("tabular font-medium", totals.unverified > 0 && "text-warning")}>{formatAmount(totals.unverified, p.currency)}</span>
              </Fact>
              <Fact label="Scheduled">
                <span className="tabular font-medium">{formatAmount(totals.scheduled, p.currency)}</span>
              </Fact>
              <Fact label="Outstanding">
                <span className="tabular font-medium">{formatAmount(cancelled ? 0 : totals.outstanding, p.currency)}</span>
              </Fact>
              {totals.refunded > 0 && (
                <Fact label="Refunded">
                  <span className="tabular font-medium text-danger">{formatAmount(totals.refunded, p.currency)}</span>
                </Fact>
              )}
              <Fact label="Counts toward LTV">
                <span className="tabular font-semibold">{formatINR(totals.netInr)}</span>
              </Fact>
            </dl>
          </div>
        </section>

        <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          {/* ---------------- Payments */}
          <section className="rounded-xl border border-border bg-surface" aria-labelledby="pay-h">
            <CardHeader
              title={<span id="pay-h">{p.hasInstalments ? "Instalments, payments and refunds" : "Payments and refunds"}</span>}
              description="Verified payments count toward LTV. Unverified ones wait for a manager; scheduled ones are still to come."
            />
            {d.payments.length ? (
              <ul className="divide-y divide-border">
                {d.payments.map((x) => (
                  <PaymentRow
                    key={x.id}
                    line={x}
                    hasInstalments={p.hasInstalments}
                    contactName={contact.name}
                    now={now}
                    tz={tz}
                    today={today}
                    canPay={canPayInstalment}
                    canVerify={canVerify && !cancelled}
                    canVerifyRejected={canVerify && !cancelled && !refunded}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState title="No payments yet" description="Nothing has been paid or scheduled on this purchase." />
            )}
          </section>

          {/* ---------------- History */}
          <section className="rounded-xl border border-border bg-surface" aria-labelledby="hist-h">
            <CardHeader title={<span id="hist-h">History</span>} description="Every change to this purchase and its payments." />
            {audit.length ? (
              <ol className="space-y-0 px-4 py-2">
                {audit.map((a) => {
                  const t = describeAudit(a, auditCtx);
                  if (!t) return null;
                  return (
                    <li key={a.id} className="flex gap-3 border-b border-border py-2.5 last:border-b-0">
                      <History className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{t.title}</p>
                        {t.detail && <p className="break-words text-xs text-muted">{t.detail}</p>}
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted">
                        <p>{a.userName ?? "System"}</p>
                        <time dateTime={a.changedAt.toISOString()}>{formatDateTime(a.changedAt, tz)}</time>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="px-4 py-6 text-sm text-muted">No changes recorded yet.</p>
            )}
          </section>
        </div>

        <aside className="space-y-4 lg:col-start-2 lg:row-start-2" aria-label="Sales credit and details">
          {/* ---------------- Credit */}
          <section className="rounded-xl border border-border bg-surface" aria-labelledby="credit-h">
            <CardHeader title={<span id="credit-h">Sales credit</span>} />
            <div className="space-y-3 p-4">
              <div>
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {d.creditedUserName ?? "Self-serve"}
                  {d.creditedUserName && <Badge tone={p.assisted ? "success" : "neutral"}>{p.assisted ? "Assisted" : "Credited"}</Badge>}
                </p>
                <p className="text-xs text-muted">
                  {d.creditAdjustedByName
                    ? `Set by hand by ${d.creditAdjustedByName}.`
                    : d.creditedUserName
                      ? `Assisted: the owner logged a touch in the ${creditDays} days before the purchase.`
                      : `Self-serve: the owner logged no touch in the ${creditDays} days before the purchase.`}
                </p>
              </div>
              {canCredit && (
                <CreditForm
                  key={p.creditedUserId ?? "self"}
                  action={adjustCreditAction}
                  purchaseId={p.id}
                  current={p.creditedUserId ?? "self"}
                  options={creditOptions.map((o) => ({
                    value: o.id,
                    label: `${o.name} · ${ROLE_LABELS[o.role]}${o.active ? "" : " (inactive)"}`,
                  }))}
                />
              )}
            </div>
          </section>

          {/* ---------------- Details */}
          <section className="rounded-xl border border-border bg-surface" aria-labelledby="det-h">
            <CardHeader title={<span id="det-h">Details</span>} />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
              <Fact label="Contact" className="col-span-2">
                <Link href={`/contacts/${contact.id}`} className="font-medium hover:underline">
                  {contact.name}
                </Link>
                <span className="tabular text-muted"> · {formatPhone(contact.phoneE164)}</span>
                <span className="block text-xs text-muted">Owner: {contact.ownerName ?? "Pool"}</span>
              </Fact>
              {d.organisation && (
                <Fact label="Organisation" className="col-span-2">
                  <Link href={`/organisations/${d.organisation.id}`} className="inline-flex items-center gap-1 font-medium hover:underline">
                    <Building2 className="h-3.5 w-3.5" aria-hidden /> {d.organisation.name}
                  </Link>
                </Fact>
              )}
              <Fact label="Mode">{PAYMENT_MODE_LABELS[p.mode]}</Fact>
              <Fact label="Reference">{p.reference ? <span className="break-all font-mono text-xs">{p.reference}</span> : <span className="text-muted">None</span>}</Fact>
              <Fact label="Recorded by">{d.createdByName ?? (p.source === "manual" ? "Unknown" : "System")}</Fact>
              <Fact label="Recorded on">{formatDate(p.createdAt, tz)}</Fact>
              {p.campaign && <Fact label="Campaign" className="col-span-2">{p.campaign}</Fact>}
              {p.notes && (
                <Fact label="Notes" className="col-span-2">
                  <span className="whitespace-pre-line break-words">{p.notes}</span>
                </Fact>
              )}
              <Fact label="Proof" className="col-span-2">
                <ProofThumb url={p.proofUrl} label="Purchase proof" size="lg" />
              </Fact>
            </dl>
          </section>
        </aside>
      </div>
      <PaymentsToaster />
    </div>
  );
}

function PaymentRow({
  line: x,
  hasInstalments,
  contactName,
  now,
  tz,
  today,
  canPay,
  canVerify,
  canVerifyRejected,
}: {
  line: PaymentLine;
  hasInstalments: boolean;
  contactName: string;
  now: Date;
  tz: string;
  today: string;
  canPay: boolean;
  canVerify: boolean;
  canVerifyRejected: boolean;
}) {
  const refund = x.kind === "refund";
  const name = refund ? `Refund${x.seq > 1 ? ` ${x.seq}` : ""}` : hasInstalments ? `Instalment ${x.seq}` : x.seq > 1 ? `Payment ${x.seq}` : "Payment";
  const due = x.status === "scheduled" && x.dueAt ? dueState(x.dueAt, now, tz) : null;
  const dueText = x.dueAt ? `Due ${formatDate(x.dueAt, tz)}${due ? ` · ${due.text}` : ""}` : "No due date";
  return (
    <li className={cn("flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start", refund && "bg-danger/[0.03]")}>
      <div className="flex min-w-0 flex-1 gap-3">
        {x.status !== "scheduled" && !refund ? (
          <ProofThumb url={x.proofUrl} label={`${name} proof`} size="sm" />
        ) : (
          <span aria-hidden className="h-10 w-10 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{name}</p>
            {refund ? <Badge tone="danger">Refund</Badge> : <PaymentStatusBadge status={x.status} />}
            {due && <Badge tone={due.tone}>{due.text}</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {x.paidAt
              ? `${refund ? "Refunded" : "Paid"} ${formatDate(x.paidAt, tz)}`
              : x.dueAt
                ? `Due ${formatDate(x.dueAt, tz)}`
                : ""}
            {x.mode && x.status !== "scheduled" ? ` · ${PAYMENT_MODE_LABELS[x.mode]}` : ""}
            {x.reference && (
              <>
                {" · "}
                <span className="break-all font-mono">{x.reference}</span>
              </>
            )}
          </p>
          {x.status === "verified" && !refund && (
            <p className="text-xs text-muted">
              Verified{x.verifiedByName ? ` by ${x.verifiedByName}` : " automatically"}
              {x.verifiedAt ? ` · ${formatDate(x.verifiedAt, tz)}` : ""}
            </p>
          )}
          {x.status === "unverified" && <p className="text-xs text-muted">Recorded by {x.recordedByName ?? "the system"} · waiting for a manager</p>}
          {x.reason && (refund || x.status === "rejected") && (
            <p className={cn("text-xs", refund ? "text-foreground" : "text-danger")}>
              {refund ? "Reason: " : "Rejected: "}
              {x.reason}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-start justify-between gap-3 sm:flex-col sm:items-end">
        <Money amount={refund ? -Number(x.amount) : Number(x.amount)} currency={x.currency} inr={refund ? -Number(x.amountInr) : x.amountInr} className="sm:items-end sm:text-right" />
        <div className="flex flex-wrap justify-end gap-2">
          {x.status === "scheduled" && !refund && canPay && (
            <RecordInstalmentButton
              action={recordInstalmentAction}
              instalment={{ id: x.id, seq: x.seq, amount: Number(x.amount), currency: x.currency, mode: x.mode, dueText }}
              contactName={contactName}
              today={today}
              canVerify={canVerify}
              variant={due?.overdue ? "primary" : "outline"}
            />
          )}
          {x.status === "unverified" && canVerify && (
            <>
              <VerifyButton action={verifyPaymentAction} paymentId={x.id} />
              <RejectButton action={rejectPaymentAction} paymentId={x.id} summary={<>{name} · {formatAmount(x.amount, x.currency)}{x.reference ? ` · ${x.reference}` : ""}</>} />
            </>
          )}
          {x.status === "rejected" && !refund && canVerifyRejected && x.paidAt && (
            <VerifyButton action={verifyPaymentAction} paymentId={x.id} label="Verify anyway" />
          )}
        </div>
      </div>
    </li>
  );
}
