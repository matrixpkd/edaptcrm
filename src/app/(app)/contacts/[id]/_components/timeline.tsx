import Link from "next/link";
import {
  ArrowRightLeft,
  CalendarClock,
  Flag,
  GitMerge,
  Hand,
  Inbox,
  LifeBuoy,
  Mail,
  MessageCircle,
  Phone,
  ShoppingBag,
  Star,
  StickyNote,
  Undo2,
  Users,
  Wallet,
} from "lucide-react";
import type { InteractionType, Stage } from "@/db/schema";
import type { TimelineItem } from "@/lib/contacts/queries";
import { Badge, STAGE_LABELS } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/card";
import { buttonClass } from "@/components/ui/button";
import {
  INTERACTION_LABELS,
  PAYMENT_MODE_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
  PURCHASE_STATUS_LABELS,
  PURCHASE_STATUS_TONE,
  RATING_SOURCE_LABELS,
  SPENDING_BAND_LABELS,
  formatAmount,
} from "@/components/contacts/labels";
import { formatPhone } from "@/lib/phone";
import { formatDateTime, formatRelative } from "@/lib/utils";
import type { Labels } from "./labels";

const INTERACTION_ICON: Record<InteractionType, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  whatsapp: MessageCircle,
  meeting: Users,
  email: Mail,
  note: StickyNote,
  support_issue: LifeBuoy,
};

function money(amount: number, currency: string, amountInr: number) {
  if (currency === "INR") return formatAmount(amount, "INR");
  return `${formatAmount(amount, currency)} (${formatAmount(amountInr, "INR")})`;
}

/** Children of a Row are passed through a server component, so each conditional child carries its own key. */
function Row({
  icon: Icon,
  title,
  meta,
  children,
  at,
  tz,
  now,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  meta?: React.ReactNode;
  children?: React.ReactNode;
  at: Date;
  tz: string;
  now: Date;
}) {
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      <span
        className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface"
        aria-hidden
      >
        <Icon className="h-4 w-4 text-foreground/70" />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="min-w-0 text-sm font-medium">{title}</p>
          <time dateTime={at.toISOString()} className="shrink-0 text-xs text-muted" title={formatDateTime(at, tz)}>
            {formatRelative(at, now)}
          </time>
        </div>
        {meta && <p className="mt-0.5 text-xs text-muted">{meta}</p>}
        {children && <div className="mt-1.5 text-sm text-foreground/85">{children}</div>}
      </div>
    </li>
  );
}

function by(name: string | null, fallback = "the system") {
  return name ? `by ${name}` : `by ${fallback}`;
}

export function Timeline({
  items,
  page,
  hasMore,
  contactId,
  labels,
  tz,
  now = new Date(),
}: {
  items: TimelineItem[];
  page: number;
  hasMore: boolean;
  contactId: string;
  labels: Labels;
  tz: string;
  now?: Date;
}) {
  if (!items.length && page === 1) {
    return (
      <EmptyState
        title="Nothing here yet"
        description="Calls, chats, enquiries, purchases and ratings show up here as they happen."
      />
    );
  }
  return (
    <div>
      <ol
        className="relative before:absolute before:bottom-2 before:left-4 before:top-2 before:w-px before:bg-border"
        aria-label="Timeline"
      >
        {items.map((i) => {
          const k = `${i.kind}:${i.id}`;
          const common = { at: i.at, tz, now };
          switch (i.kind) {
            case "enquiry":
              return (
                <Row
                  {...common}
                  key={k}
                  icon={Inbox}
                  title={<>Enquiry via {labels.channel(i.channel)}</>}
                  meta={[
                    i.campaign ? labels.campaign(i.campaign) : null,
                    i.status !== "open" && i.status !== "handled" ? i.status.replace(/_/g, " ") : null,
                    i.byName ? `added ${by(i.byName)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {i.productInterest && <p key="interest">Interested in {i.productInterest}</p>}
                  {i.notes && (
                    <p key="notes" className="whitespace-pre-line">
                      {i.notes}
                    </p>
                  )}
                </Row>
              );
            case "interaction": {
              const Icon = INTERACTION_ICON[i.type] ?? StickyNote;
              return (
                <Row
                  {...common}
                  key={k}
                  icon={Icon}
                  title={
                    <span>
                      {i.direction === "in"
                        ? `Inbound ${(INTERACTION_LABELS[i.type] ?? i.type).toLowerCase()}`
                        : (INTERACTION_LABELS[i.type] ?? i.type)}
                      {i.outcome && <span className="font-normal text-muted"> · {labels.outcome(i.outcome)}</span>}
                    </span>
                  }
                  meta={by(i.byName)}
                >
                  {i.summary && (
                    <p key="summary" className="whitespace-pre-line">
                      {i.summary}
                    </p>
                  )}
                  {i.nextFollowUpAt && (
                    <p key="follow-up" className="mt-1 inline-flex items-center gap-1 text-xs text-muted">
                      <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Follow-up{" "}
                      {formatDateTime(i.nextFollowUpAt, tz)}
                    </p>
                  )}
                </Row>
              );
            }
            case "purchase":
              return (
                <Row
                  {...common}
                  key={k}
                  icon={ShoppingBag}
                  title={
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      Bought {i.productName}
                      <Badge tone={PURCHASE_STATUS_TONE[i.status]}>{PURCHASE_STATUS_LABELS[i.status]}</Badge>
                    </span>
                  }
                  meta={[
                    money(i.amount, i.currency, i.amountInr),
                    PAYMENT_MODE_LABELS[i.mode] ?? i.mode,
                    i.byName ? `credited to ${i.byName}` : "self-serve",
                  ].join(" · ")}
                />
              );
            case "payment":
              return i.paymentKind === "refund" ? (
                <Row
                  {...common}
                  key={k}
                  icon={Undo2}
                  title={<>Refund of {money(i.amount, i.currency, i.amountInr)}</>}
                  meta={[i.productName, i.reason].filter(Boolean).join(" · ")}
                />
              ) : (
                <Row
                  {...common}
                  key={k}
                  icon={Wallet}
                  title={
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {i.hasInstalments ? `Instalment ${i.seq}` : "Payment"} of{" "}
                      {money(i.amount, i.currency, i.amountInr)}
                      <Badge tone={PAYMENT_STATUS_TONE[i.status]}>{PAYMENT_STATUS_LABELS[i.status]}</Badge>
                    </span>
                  }
                  meta={[
                    i.productName,
                    i.mode ? PAYMENT_MODE_LABELS[i.mode] : null,
                    i.reference ? `ref ${i.reference}` : null,
                    i.status === "rejected" && i.reason ? i.reason : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
              );
            case "rating": {
              const parts = [
                i.aiLevel != null ? `AI knowledge ${i.aiLevel}/5` : null,
                i.umerLevel != null ? `Umer familiarity ${i.umerLevel}/5` : null,
                i.spendingBand != null ? `Spending ${SPENDING_BAND_LABELS[i.spendingBand] ?? i.spendingBand}` : null,
                i.gutStars != null ? `Gut ${"★".repeat(i.gutStars)}` : null,
                i.ageBand ? `Age ${labels.ageBand(i.ageBand)}` : null,
                i.industry ? labels.industry(i.industry) : null,
              ].filter(Boolean);
              return (
                <Row
                  {...common}
                  key={k}
                  icon={Star}
                  title={<>{RATING_SOURCE_LABELS[i.source] ?? "Rating"}</>}
                  meta={
                    i.source === "sales"
                      ? by(i.byName)
                      : i.source === "self"
                        ? "answered by the customer"
                        : "from an import"
                  }
                >
                  {parts.length > 0 && <p key="values">{parts.join(" · ")}</p>}
                  {i.notes && (
                    <p key="notes" className="whitespace-pre-line text-muted">
                      {i.notes}
                    </p>
                  )}
                </Row>
              );
            }
            case "ownership":
              return (
                <Row
                  {...common}
                  key={k}
                  icon={ArrowRightLeft}
                  title={
                    !i.toName ? (
                      <>Moved to the pool{i.fromName ? ` from ${i.fromName}` : ""}</>
                    ) : i.fromName ? (
                      <>
                        Owner {i.fromName} → {i.toName}
                      </>
                    ) : (
                      <>Assigned to {i.toName}</>
                    )
                  }
                  meta={[i.reason, by(i.byName)].filter(Boolean).join(" · ")}
                />
              );
            case "stage":
              return (
                <Row
                  {...common}
                  key={k}
                  icon={Flag}
                  title={
                    i.field === "lost_reason" ? (
                      i.to ? (
                        <>Lost reason: {labels.lostReason(i.to)}</>
                      ) : (
                        <>Lost reason cleared</>
                      )
                    ) : (
                      <>
                        Stage {i.from ? `${STAGE_LABELS[i.from as Stage] ?? i.from} → ` : ""}
                        {i.to ? (STAGE_LABELS[i.to as Stage] ?? i.to) : "–"}
                      </>
                    )
                  }
                  meta={i.byName ? by(i.byName) : "set automatically"}
                />
              );
            case "merge":
              return (
                <Row
                  {...common}
                  key={k}
                  icon={GitMerge}
                  title={
                    i.action === "merge" ? (
                      <>Merged {i.otherName ?? "a duplicate record"} into this contact</>
                    ) : (
                      <>Merge undone{i.otherName ? `: ${i.otherName} is separate again` : ""}</>
                    )
                  }
                  meta={[i.otherPhone ? formatPhone(i.otherPhone) : null, by(i.byName)].filter(Boolean).join(" · ")}
                />
              );
            case "transfer":
              return (
                <Row {...common} key={k} icon={Hand} title={<>Transfer requested {by(i.byName)}</>}>
                  {i.reason && <p>{i.reason}</p>}
                </Row>
              );
          }
        })}
      </ol>
      {(page > 1 || hasMore) && (
        <nav className="mt-5 flex items-center justify-between gap-2" aria-label="Timeline pages">
          {page > 1 ? (
            <Link
              href={`/contacts/${contactId}?tab=timeline&tp=${page - 1}`}
              scroll={false}
              className={buttonClass("outline", "md")}
            >
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          {hasMore && (
            <Link
              href={`/contacts/${contactId}?tab=timeline&tp=${page + 1}`}
              scroll={false}
              className={buttonClass("outline", "md")}
            >
              Older →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
