import Link from "next/link";
import { ChevronLeft, ChevronRight, Clock, Inbox, ShieldCheck } from "lucide-react";
import type { Role } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { PAYMENT_MODE_LABELS } from "@/components/contacts/labels";
import { Money, ProofThumb, PurchaseStatusBadge } from "@/components/payments/display";
import {
  PaymentsToaster,
  RecordInstalmentButton,
  RejectButton,
  VerifyButton,
} from "@/components/payments/money-actions";
import { dueState, isStaleClaim, waitingDays, waitingText } from "@/components/payments/rules";
import { can, canEditContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { formatPhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { localIsoDate, validTimeZone } from "@/lib/today/time";
import { cn, formatDate, formatINR, formatINRCompact } from "@/lib/utils";
import { recordInstalmentAction, rejectPaymentAction, verifyPaymentAction } from "./actions";
import {
  DESK_PAGE_SIZE,
  countRecentPurchases,
  getDeskTotals,
  listInstalmentsDue,
  listRecentPurchases,
  listUnverified,
  type DeskPaymentRow,
} from "./_lib/queries";

export const metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

const TABS = ["unverified", "due", "recent"] as const;
type Tab = (typeof TABS)[number];
type SP = { tab?: string; page?: string };

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser(["admin", "manager", "sales"]);
  const sp = await searchParams;
  const canVerify = can(user, "payments.verify");
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : canVerify ? "unverified" : "due";
  const page = Math.max(1, Math.min(10_000, Number.parseInt(sp.page ?? "1", 10) || 1));
  const offset = (page - 1) * DESK_PAGE_SIZE;

  const tz = validTimeZone(user.timezone);
  const now = new Date();
  const { thresholds } = await getSettings(["thresholds"]);
  const deskWindow = {
    now,
    timeZone: tz,
    withinDays: thresholds.instalmentDueDays,
    staleDays: thresholds.unverifiedPaymentDays,
  };
  const totals = await getDeskTotals(user, deskWindow);
  const dueCount = totals.overdueCount + totals.dueSoonCount;

  let total = 0;
  let body: React.ReactNode;
  if (tab === "unverified") {
    total = totals.unverifiedCount;
    const rows = await listUnverified(user, { limit: DESK_PAGE_SIZE, offset });
    body = rows.length ? (
      <UnverifiedList rows={rows} now={now} tz={tz} staleDays={thresholds.unverifiedPaymentDays} canVerify={canVerify} />
    ) : (
      <EmptyState
        icon={<ShieldCheck className="h-8 w-8" aria-hidden />}
        title={page > 1 ? "No more payments on this page" : "Nothing waiting for verification"}
        description="Bank, UPI and cash payments recorded by the team wait here until a manager checks them against the bank."
      />
    );
  } else if (tab === "due") {
    total = dueCount;
    const rows = await listInstalmentsDue(user, deskWindow, { limit: DESK_PAGE_SIZE, offset });
    const today = localIsoDate(now, tz);
    body = rows.length ? (
      <DueList rows={rows} now={now} tz={tz} today={today} user={user} canVerify={canVerify} />
    ) : (
      <EmptyState
        icon={<Clock className="h-8 w-8" aria-hidden />}
        title={page > 1 ? "No more instalments on this page" : `No instalments due in the next ${thresholds.instalmentDueDays} days`}
        description="Overdue instalments and those due soon show up here, with a button to record the payment."
      />
    );
  } else {
    total = await countRecentPurchases(user);
    const rows = await listRecentPurchases(user, { limit: DESK_PAGE_SIZE, offset });
    body = rows.length ? (
      <RecentList rows={rows} tz={tz} />
    ) : (
      <EmptyState
        icon={<Inbox className="h-8 w-8" aria-hidden />}
        title={page > 1 ? "No more purchases on this page" : "No purchases yet"}
        description="TagMango orders arrive on their own. Record bank and UPI payments from a contact's page."
        action={
          <Link href="/contacts" className={buttonClass("outline", "sm")}>
            Find a contact
          </Link>
        }
      />
    );
  }

  const scopeNote = can(user, "contacts.viewAll") ? null : "Your contacts and the unassigned pool.";

  return (
    <div>
      <PageHeader
        title="Payments"
        description={
          <>
            {canVerify
              ? "Verify bank and UPI claims, chase instalments and see the latest purchases."
              : "Track your customers' payments and instalments. A manager verifies bank and UPI payments."}
            {scopeNote && <span className="block text-xs">{scopeNote}</span>}
          </>
        }
      />

      <section aria-label="Totals" className="mb-5 grid grid-cols-3 gap-2 sm:gap-3">
        <Tile
          href="/payments?tab=unverified"
          label="Unverified"
          value={totals.unverifiedCount}
          hint={totals.unverifiedCount ? `${formatINRCompact(totals.unverifiedInr)} waiting` : "All clear"}
          alert={
            totals.staleCount
              ? `${totals.staleCount} over ${thresholds.unverifiedPaymentDays} ${thresholds.unverifiedPaymentDays === 1 ? "day" : "days"}`
              : null
          }
          title={`Unverified payments: ${totals.unverifiedCount}, ${formatINR(totals.unverifiedInr)}`}
        />
        <Tile
          href="/payments?tab=due"
          label="Overdue"
          value={totals.overdueCount}
          hint={totals.overdueCount ? `${formatINRCompact(totals.overdueInr)} to collect` : "All clear"}
          alert={totals.overdueCount ? "Instalments past due" : null}
          title={`Overdue instalments: ${totals.overdueCount}, ${formatINR(totals.overdueInr)}`}
        />
        <Tile
          href="/payments?tab=due"
          label={`Due in ${thresholds.instalmentDueDays}d`}
          value={totals.dueSoonCount}
          hint={totals.dueSoonCount ? `${formatINRCompact(totals.dueSoonInr)} expected` : "None"}
          title={`Instalments due in the next ${thresholds.instalmentDueDays} days: ${totals.dueSoonCount}, ${formatINR(totals.dueSoonInr)}`}
        />
      </section>

      <Tabs
        active={tab}
        tabs={[
          { key: "unverified", label: "Unverified", href: "/payments?tab=unverified", count: totals.unverifiedCount },
          { key: "due", label: "Instalments due", href: "/payments?tab=due", count: dueCount },
          { key: "recent", label: "Recent", href: "/payments?tab=recent" },
        ]}
      />

      <div className="mt-4 rounded-xl border border-border bg-surface">{body}</div>
      <Pager tab={tab} page={page} total={total} />
      <PaymentsToaster />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Tile({
  href,
  label,
  value,
  hint,
  alert,
  title,
}: {
  href: string;
  label: string;
  value: number;
  hint: string;
  alert?: string | null;
  title: string;
}) {
  return (
    <Link
      href={href}
      title={title}
      className="min-w-0 rounded-xl border border-border bg-surface p-3 hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4"
    >
      <p className="truncate text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold">{value}</p>
      <p className="truncate text-xs text-muted">{hint}</p>
      {alert && <p className="mt-1 truncate text-xs font-medium text-danger">{alert}</p>}
    </Link>
  );
}

function Pager({ tab, page, total }: { tab: Tab; page: number; total: number }) {
  const pages = Math.max(1, Math.ceil(total / DESK_PAGE_SIZE));
  if (total <= DESK_PAGE_SIZE && page === 1) return null;
  const from = Math.min(total, (page - 1) * DESK_PAGE_SIZE + 1);
  const to = Math.min(total, page * DESK_PAGE_SIZE);
  const href = (p: number) => `/payments?tab=${tab}&page=${p}`;
  return (
    <nav aria-label="Pages" className="mt-3 flex items-center justify-between gap-3 text-sm">
      <span className="text-muted tabular">
        {total ? `${from}–${to} of ${total}` : "Nothing here"}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className={buttonClass("outline", "sm", "max-sm:h-10")} rel="prev">
            <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
          </Link>
        ) : null}
        {page < pages ? (
          <Link href={href(page + 1)} className={buttonClass("outline", "sm", "max-sm:h-10")} rel="next">
            Next <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

function ContactCell({ row }: { row: Pick<DeskPaymentRow, "contactId" | "contactName" | "contactPhone" | "ownerName"> }) {
  return (
    <div className="min-w-0">
      <Link href={`/contacts/${row.contactId}`} className="block truncate font-medium hover:underline">
        {row.contactName}
      </Link>
      <p className="truncate text-xs text-muted">
        <span className="tabular">{formatPhone(row.contactPhone)}</span>
        {" · "}
        {row.ownerName ?? "Pool"}
      </p>
    </div>
  );
}

function ProductCell({ row }: { row: DeskPaymentRow }) {
  return (
    <div className="min-w-0">
      <Link href={`/payments/${row.purchaseId}`} className="line-clamp-2 text-sm font-medium hover:underline">
        {row.productName}
      </Link>
      <p className="truncate text-xs text-muted">
        {row.hasInstalments ? `Instalment ${row.seq} of ${Math.max(row.seq, row.instalmentCount)}` : "One-off payment"}
      </p>
    </div>
  );
}

const HEAD = "hidden border-b border-border bg-surface-muted/60 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted md:grid md:gap-4";

function UnverifiedList({
  rows,
  now,
  tz,
  staleDays,
  canVerify,
}: {
  rows: DeskPaymentRow[];
  now: Date;
  tz: string;
  staleDays: number;
  canVerify: boolean;
}) {
  const cols = canVerify
    ? "md:grid-cols-[3.5rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1.2fr)_12.5rem]"
    : "md:grid-cols-[3.5rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1.2fr)_9rem]";
  return (
    <div>
      <div className={cn(HEAD, cols)} aria-hidden>
        <span>Proof</span>
        <span>Contact</span>
        <span>Product</span>
        <span>Amount</span>
        <span>Reference · waiting</span>
        <span className="text-right">{canVerify ? "Verify" : "Status"}</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const since = r.paidAt ?? r.createdAt;
          const days = waitingDays(since, now);
          const stale = isStaleClaim(since, now, staleDays);
          const proof = r.proofUrl ?? r.purchaseProofUrl;
          return (
            <li key={r.paymentId} className={cn("grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 md:items-center md:gap-4", cols)}>
              <div className="row-span-2 md:row-span-1">
                <ProofThumb url={proof} label={`Proof from ${r.contactName}`} />
              </div>
              <ContactCell row={r} />
              <div className="col-start-2 md:col-start-auto">
                <ProductCell row={r} />
              </div>
              <div className="col-start-2 md:col-start-auto">
                <Money amount={r.amount} currency={r.currency} inr={r.amountInr} />
              </div>
              <div className="col-start-2 min-w-0 md:col-start-auto">
                <p className="text-sm text-muted">{r.mode ? PAYMENT_MODE_LABELS[r.mode] : "Payment"}</p>
                {r.reference ? (
                  <p className="break-all font-mono text-xs" title="UTR / reference">
                    {r.reference}
                  </p>
                ) : (
                  <p className="text-xs text-muted">No reference</p>
                )}
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <Badge tone={stale ? "danger" : days >= 1 ? "warning" : "neutral"} title={`Paid ${formatDate(since, tz)}`}>
                    {stale && <Clock className="h-3 w-3" aria-hidden />}
                    {days ? `Waiting ${waitingText(days)}` : "Waiting under a day"}
                  </Badge>
                  <span className="truncate">by {r.recordedByName ?? "the system"}</span>
                </p>
              </div>
              <div className="col-span-2 flex flex-wrap items-start gap-2 md:col-span-1 md:justify-end">
                {canVerify ? (
                  <>
                    <VerifyButton action={verifyPaymentAction} paymentId={r.paymentId} />
                    <RejectButton
                      action={rejectPaymentAction}
                      paymentId={r.paymentId}
                      summary={
                        <>
                          {r.contactName} · {r.productName}
                          {r.reference ? ` · ${r.reference}` : ""}
                        </>
                      }
                    />
                  </>
                ) : (
                  <span className="text-xs text-muted">Waiting for a manager</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DueList({
  rows,
  now,
  tz,
  today,
  user,
  canVerify,
}: {
  rows: DeskPaymentRow[];
  now: Date;
  tz: string;
  today: string;
  user: { id: string; role: Role };
  canVerify: boolean;
}) {
  const cols = "md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_11rem]";
  const canRecord = can(user, "payments.record");
  return (
    <div>
      <div className={cn(HEAD, cols)} aria-hidden>
        <span>Due</span>
        <span>Contact</span>
        <span>Product</span>
        <span>Amount</span>
        <span className="text-right">Record</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const due = r.dueAt ? dueState(r.dueAt, now, tz) : null;
          const dueText = r.dueAt ? `Due ${formatDate(r.dueAt, tz)}${due ? ` · ${due.text}` : ""}` : "No due date";
          return (
            <li key={r.paymentId} className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-4 py-3 md:items-center md:gap-4", cols)}>
              <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1 md:block">
                {due && <Badge tone={due.tone}>{due.text}</Badge>}
                <p className="text-xs text-muted md:mt-1">{r.dueAt ? formatDate(r.dueAt, tz) : "No due date"}</p>
              </div>
              <ContactCell row={r} />
              <div className="col-start-1 md:col-start-auto">
                <ProductCell row={r} />
              </div>
              <div className="col-start-2 row-start-2 text-right md:col-start-auto md:row-start-auto md:text-left">
                <Money amount={r.amount} currency={r.currency} inr={r.amountInr} />
              </div>
              <div className="col-span-2 md:col-span-1 md:text-right">
                {canRecord && canEditContact(user, { ownerId: r.ownerId }) ? (
                  <RecordInstalmentButton
                    action={recordInstalmentAction}
                    instalment={{ id: r.paymentId, seq: r.seq, amount: r.amount, currency: r.currency, mode: r.mode, dueText }}
                    contactName={r.contactName}
                    today={today}
                    canVerify={canVerify}
                    variant={due?.overdue ? "primary" : "outline"}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RecentList({ rows, tz }: { rows: Awaited<ReturnType<typeof listRecentPurchases>>; tz: string }) {
  const cols = "md:grid-cols-[6rem_minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_1.5rem]";
  return (
    <div>
      <div className={cn(HEAD, cols)} aria-hidden>
        <span>Date</span>
        <span>Contact</span>
        <span>Product</span>
        <span>Amount</span>
        <span>Status</span>
        <span />
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.purchaseId} className={cn("relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-surface-muted/40 md:items-center md:gap-4", cols)}>
            <p className="col-span-2 text-xs text-muted md:col-span-1 md:text-sm md:text-foreground">{formatDate(r.purchasedAt, tz)}</p>
            <div className="min-w-0">
              <Link href={`/contacts/${r.contactId}`} className="relative z-10 block truncate font-medium hover:underline">
                {r.contactName}
              </Link>
              <p className="truncate text-xs text-muted">
                {r.creditedUserName ? `${r.creditedUserName}${r.assisted ? " · assisted" : ""}` : "Self-serve"}
              </p>
            </div>
            <div className="col-start-1 min-w-0 md:col-start-auto">
              <Link
                href={`/payments/${r.purchaseId}`}
                className="block truncate text-sm font-medium after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {r.productName}
              </Link>
              <p className="truncate text-xs text-muted">
                {PAYMENT_MODE_LABELS[r.mode]}
                {r.hasInstalments ? " · instalments" : ""}
                {r.source === "import" ? " · imported" : r.source === "tagmango" && r.mode !== "tagmango" ? " · via TagMango" : ""}
              </p>
            </div>
            <div className="col-start-2 row-start-2 text-right md:col-start-auto md:row-start-auto md:text-left">
              <Money amount={r.amount} currency={r.currency} inr={r.amountInr} />
            </div>
            <div className="col-span-2 flex flex-wrap items-center gap-1.5 md:col-span-1">
              <PurchaseStatusBadge status={r.status} />
              {r.unverifiedCount > 0 && <Badge tone="warning">{r.unverifiedCount} unverified</Badge>}
              <span className="text-xs text-muted md:block md:w-full">
                {formatINR(r.receivedInr)} received
              </span>
            </div>
            <ChevronRight className="hidden h-4 w-4 text-muted md:block" aria-hidden />
          </li>
        ))}
      </ul>
    </div>
  );
}
