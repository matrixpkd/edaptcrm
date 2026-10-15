import Link from "next/link";
import { BadgeCheck, CalendarClock, ChevronRight, Inbox, Upload, UserPlus, Users, type LucideIcon } from "lucide-react";
import type { PaymentsDesk } from "@/lib/today/desk";
import { cn, formatINRCompact } from "@/lib/utils";

export type NextStep = { key: string; href: string; icon: LucideIcon; title: string; detail: string };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/**
 * "What to do next" when the queue is empty: so day one (and a quiet afternoon) still points somewhere useful.
 * Each step is shown only to roles that can act on it.
 */
export function nextSteps(opts: {
  canCreate: boolean;
  canImport: boolean;
  isLead: boolean;
  isSupport: boolean;
  poolCount: number;
}): NextStep[] {
  const steps: NextStep[] = [];
  if (opts.canCreate) {
    steps.push({
      key: "add",
      href: "/contacts/new",
      icon: UserPlus,
      title: "Add a lead",
      detail: "Someone who called or messaged you: phone, name, channel and first door.",
    });
  }
  if (!opts.isSupport && opts.poolCount > 0) {
    steps.push({
      key: "pool",
      href: "/contacts?owner=pool",
      icon: Inbox,
      title: `Work the pool: ${plural(opts.poolCount, "contact", "contacts")} with no owner`,
      detail: opts.isLead ? "Assign them to the team, or take them yourself." : "Open one and request it, or call them first.",
    });
  }
  steps.push({
    key: "contacts",
    href: opts.isSupport || opts.isLead ? "/contacts" : "/contacts?owner=mine",
    icon: Users,
    title: opts.isSupport || opts.isLead ? "Browse contacts" : "Go through your contacts",
    detail: "Search and filter by grade, stage, door or tag, and set follow-ups so they come back here.",
  });
  if (opts.canImport) {
    steps.push({
      key: "import",
      href: "/import",
      icon: Upload,
      title: "Import your old records",
      detail: "TagMango orders first, then Zoho and sheets. Duplicates are matched by phone.",
    });
  }
  if (opts.isLead) {
    steps.push({
      key: "team",
      href: "/today?view=team",
      icon: Users,
      title: "See the team's queues",
      detail: "Everyone's Today in one place, with the unassigned pool.",
    });
  }
  return steps;
}

/** The empty-queue card: "all clear", then the next steps as big tap targets. */
export function NextSteps({ steps, deskWaiting }: { steps: NextStep[]; deskWaiting: boolean }) {
  return (
    <section aria-labelledby="all-clear-title" className="rounded-2xl border border-border bg-surface">
      <div className="px-5 pb-3 pt-6 text-center sm:px-6">
        <h2 id="all-clear-title" className="text-lg font-semibold">
          {deskWaiting ? "No calls due right now" : "All clear for today"}
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          {deskWaiting
            ? "Payments are waiting on you above. New leads, follow-ups and alerts land here the moment they are due."
            : "Nothing is waiting for you. New leads, follow-ups and alerts land here the moment they are due."}
        </p>
      </div>
      {steps.length > 0 && (
        <>
          <h3 className="px-5 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted sm:px-6">What to do next</h3>
          <ul className="divide-y divide-border border-t border-border">
            {steps.map((s) => (
              <li key={s.key}>
                <Link
                  href={s.href}
                  className="flex min-h-14 items-center gap-3 px-5 py-3 hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-muted">
                    <s.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{s.title}</span>
                    <span className="block text-xs text-muted">{s.detail}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * A manager's money work on Today: unverified payments and overdue instalments, each linking to its Payments tab.
 * Renders nothing when there is nothing to do.
 */
export function PaymentsDeskStrip({ desk }: { desk: PaymentsDesk }) {
  const items: { key: string; href: string; icon: LucideIcon; title: string; detail: string; urgent: boolean }[] = [];
  if (desk.unverified > 0) {
    items.push({
      key: "verify",
      href: "/payments?tab=unverified",
      icon: BadgeCheck,
      title: `${plural(desk.unverified, "payment", "payments")} to verify`,
      detail:
        `${formatINRCompact(desk.unverifiedInr)} waiting` +
        (desk.stale > 0 ? ` · ${desk.stale.toLocaleString("en-IN")} for ${desk.staleDays}+ ${desk.staleDays === 1 ? "day" : "days"}` : ""),
      urgent: desk.stale > 0,
    });
  }
  if (desk.overdueInstalments > 0) {
    items.push({
      key: "overdue",
      href: "/payments?tab=due",
      icon: CalendarClock,
      title: `${plural(desk.overdueInstalments, "instalment", "instalments")} overdue`,
      detail: "Chase them, or record what came in.",
      urgent: true,
    });
  }
  if (!items.length) return null;
  return (
    <nav aria-label="Waiting on you" className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href}
          className={cn(
            "flex min-h-14 min-w-0 items-center gap-3 rounded-xl border bg-surface px-4 py-3 hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            i.urgent ? "border-warning/40" : "border-border",
          )}
        >
          <i.icon className={cn("h-5 w-5 shrink-0", i.urgent ? "text-warning" : "text-muted")} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{i.title}</span>
            <span className="block truncate text-xs text-muted">{i.detail}</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </Link>
      ))}
    </nav>
  );
}
