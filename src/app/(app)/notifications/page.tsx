import Link from "next/link";
import {
  Bell,
  BellOff,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crown,
  Flame,
  Handshake,
  HeartHandshake,
  MessageCircle,
  ShieldAlert,
  ShoppingCart,
  TrendingUp,
  TriangleAlert,
  UserCheck,
  UserPlus,
  UserX,
  Wallet,
} from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { requireUser } from "@/lib/auth/session";
import { listNotifications, type InboxItem } from "@/lib/today/inbox";
import { compactAgo, validTimeZone } from "@/lib/today/time";
import { cn, formatDateTime } from "@/lib/utils";
import { markAllReadAction, markReadAction, openNotificationAction } from "./actions";

export const metadata = { title: "Alerts" };
export const dynamic = "force-dynamic";

const ICONS: Record<string, { icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  hot_lead: { icon: Flame, tone: "bg-danger/10 text-danger" },
  abandoned_checkout: { icon: ShoppingCart, tone: "bg-danger/10 text-danger" },
  new_lead: { icon: UserPlus, tone: "bg-accent/10 text-accent" },
  new_enquiry: { icon: MessageCircle, tone: "bg-accent/10 text-accent" },
  untouched_lead: { icon: TriangleAlert, tone: "bg-warning/10 text-warning" },
  lead_released: { icon: UserX, tone: "bg-warning/10 text-warning" },
  transfer_request: { icon: Handshake, tone: "bg-surface-muted text-foreground" },
  contacts_assigned: { icon: UserCheck, tone: "bg-success/10 text-success" },
  instalment_due: { icon: Wallet, tone: "bg-warning/10 text-warning" },
  unverified_payment: { icon: ShieldAlert, tone: "bg-warning/10 text-warning" },
  at_risk: { icon: TriangleAlert, tone: "bg-warning/10 text-warning" },
  follow_up_due: { icon: CalendarClock, tone: "bg-accent/10 text-accent" },
  task_assigned: { icon: CalendarClock, tone: "bg-accent/10 text-accent" },
  next_rung: { icon: TrendingUp, tone: "bg-success/10 text-success" },
  new_advocate: { icon: HeartHandshake, tone: "bg-success/10 text-success" },
  vip_quiet: { icon: Crown, tone: "bg-warning/10 text-warning" },
  duplicate_review: { icon: Copy, tone: "bg-surface-muted text-foreground" },
};

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; gone?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const inbox = await listNotifications(user.id, { page: Number(sp.page) || 1 });
  const tz = validTimeZone(user.timezone);
  const now = new Date();
  const unreadHere = inbox.items.filter((n) => !n.readAt);
  const readHere = inbox.items.filter((n) => n.readAt);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Alerts"
        description={
          inbox.unread > 0
            ? `${inbox.unread} unread · newest first`
            : inbox.total > 0
              ? "You are all caught up"
              : undefined
        }
        actions={
          inbox.unread > 0 ? (
            <form action={markAllReadAction}>
              <SubmitButton variant="outline" size="md" pendingText="Marking…">
                <Check className="h-4 w-4" aria-hidden /> Mark all read
              </SubmitButton>
            </form>
          ) : null
        }
      />

      {sp.gone && (
        <p role="status" className="mb-4 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          That contact is no longer yours, so it cannot be opened. Ask your manager if you still need it.
        </p>
      )}

      {inbox.total === 0 ? (
        <div className="rounded-2xl border border-border bg-surface px-6 py-14 text-center">
          <BellOff className="mx-auto mb-3 h-8 w-8 text-muted" aria-hidden />
          <p className="font-medium">No alerts yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            Hot leads, new leads, untouched leads, instalments and transfer requests will show up here.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {unreadHere.length > 0 && <Group title="Unread" items={unreadHere} now={now} tz={tz} />}
          {readHere.length > 0 && <Group title={unreadHere.length ? "Earlier" : "Read"} items={readHere} now={now} tz={tz} />}
          {inbox.pages > 1 && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3 pt-1">
              <PageLink page={inbox.page - 1} disabled={inbox.page <= 1}>
                <ChevronLeft className="h-4 w-4" aria-hidden /> Newer
              </PageLink>
              <span className="tabular text-sm text-muted">
                Page {inbox.page} of {inbox.pages}
              </span>
              <PageLink page={inbox.page + 1} disabled={inbox.page >= inbox.pages}>
                Older <ChevronRight className="h-4 w-4" aria-hidden />
              </PageLink>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

function PageLink({ page, disabled, children }: { page: number; disabled: boolean; children: React.ReactNode }) {
  if (disabled) {
    return (
      <span className={buttonClass("outline", "md", "pointer-events-none opacity-40")} aria-disabled="true">
        {children}
      </span>
    );
  }
  return (
    <Link href={page <= 1 ? "/notifications" : `/notifications?page=${page}`} className={buttonClass("outline", "md")}>
      {children}
    </Link>
  );
}

function Group({ title, items, now, tz }: { title: string; items: InboxItem[]; now: Date; tz: string }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
        {items.map((n) => (
          <Item key={n.id} n={n} now={now} tz={tz} />
        ))}
      </ul>
    </section>
  );
}

function Item({ n, now, tz }: { n: InboxItem; now: Date; tz: string }) {
  const meta = ICONS[n.type] ?? { icon: Bell, tone: "bg-surface-muted text-foreground" };
  const Icon = meta.icon;
  const unread = !n.readAt;
  const showContact = n.contactName && !n.title.includes(n.contactName);
  return (
    <li className={cn("flex items-stretch", unread && "bg-accent/[0.03]")}>
      <form action={openNotificationAction} className="min-w-0 flex-1">
        <input type="hidden" name="id" value={n.id} />
        <button
          type="submit"
          className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-surface-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full", meta.tone)}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-3">
              <span className={cn("min-w-0 text-sm leading-snug", unread ? "font-semibold" : "font-medium text-foreground/85")}>
                {unread && <span className="sr-only">Unread: </span>}
                {n.title}
              </span>
              <time
                dateTime={n.createdAt.toISOString()}
                title={formatDateTime(n.createdAt, tz)}
                className="tabular shrink-0 text-xs text-muted"
              >
                {compactAgo(n.createdAt, now)}
              </time>
            </span>
            {(n.body || showContact) && (
              <span className="mt-0.5 block text-sm leading-snug text-muted">
                {showContact && <span className="font-medium text-foreground/80">{n.contactName}</span>}
                {showContact && n.body ? " · " : null}
                {n.body}
              </span>
            )}
          </span>
          {unread && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />}
        </button>
      </form>
      {unread && (
        <form action={markReadAction} className="flex items-center border-l border-border">
          <input type="hidden" name="id" value={n.id} />
          <button
            type="submit"
            aria-label={`Mark read: ${n.title}`}
            title="Mark read"
            className="flex h-full min-h-12 w-12 items-center justify-center text-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <Check className="h-4 w-4" aria-hidden />
          </button>
        </form>
      )}
    </li>
  );
}
