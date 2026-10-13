import Link from "next/link";
import { ChevronDown, PartyPopper, ShieldAlert, UserPlus, Users } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { BandCounts, QueueList } from "@/components/today/queue-list";
import { ROLE_LABELS, can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getTeamQueues, getTodayQueue, type TeamQueueGroup } from "@/lib/today/queue";
import { greetingFor, validTimeZone } from "@/lib/today/time";
import { cn } from "@/lib/utils";

export const metadata = { title: "Today" };
export const dynamic = "force-dynamic";

type Search = { view?: string; denied?: string };

export default async function TodayPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const isLead = user.role === "admin" || user.role === "manager";
  const view = isLead && sp.view === "team" ? "team" : "mine";
  const now = new Date();
  const tz = validTimeZone(user.timezone);
  const firstName = user.name.split(" ")[0] || user.name;
  const dateLine = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(
    now,
  );

  return (
    <div className="mx-auto max-w-3xl">
      {sp.denied && (
        <p
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
          That page is not available for your role, so you are back on Today.
        </p>
      )}

      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {greetingFor(now, tz)}, {firstName}
          </h1>
          <p className="mt-0.5 text-sm text-muted">{dateLine}</p>
        </div>
        {isLead && <ViewToggle view={view} />}
      </header>

      {view === "team" ? <TeamView user={user} now={now} /> : <MyQueue user={user} now={now} />}
    </div>
  );
}

function ViewToggle({ view }: { view: "mine" | "team" }) {
  const item = (key: "mine" | "team", label: string, href: string) => (
    <Link
      href={href}
      aria-current={view === key ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        view === key ? "bg-foreground text-white" : "text-muted hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Queue view" className="flex shrink-0 rounded-lg border border-border bg-surface p-0.5">
      {item("mine", "Mine", "/today")}
      {item("team", "Team", "/today?view=team")}
    </nav>
  );
}

type PageUser = Awaited<ReturnType<typeof requireUser>>;

async function MyQueue({ user, now }: { user: PageUser; now: Date }) {
  const queue = await getTodayQueue(user, now);
  const isLead = user.role === "admin" || user.role === "manager";

  if (queue.total === 0) {
    return (
      <div className="rounded-2xl border border-border bg-surface px-6 py-14 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-foreground text-white">
          <PartyPopper className="h-7 w-7" aria-hidden />
        </div>
        <h2 className="text-lg font-semibold">All clear for today</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
          Nothing is waiting for you. New leads, follow-ups and alerts land here the moment they are due.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {can(user, "contacts.create") && (
            <ButtonLink href="/contacts/new" variant="primary">
              <UserPlus className="h-4 w-4" aria-hidden /> Add a lead
            </ButtonLink>
          )}
          {isLead && (
            <ButtonLink href="/today?view=team" variant="outline">
              <Users className="h-4 w-4" aria-hidden /> See the team
            </ButtonLink>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="mb-3 text-sm">
        <span className="font-semibold">
          {queue.total} {queue.total === 1 ? "action" : "actions"}
        </span>
        <span className="text-muted"> ranked for you{queue.leftOut > 0 ? `, top ${queue.cap} shown` : ""}</span>
      </p>
      <div className="mb-5">
        <BandCounts counts={queue.counts} />
      </div>
      <QueueList rows={queue.rows} canAnswerTransfer={can(user, "contacts.reassign")} />
      {queue.leftOut > 0 && <LeftOut n={queue.leftOut} />}
    </>
  );
}

function LeftOut({ n, compact = false }: { n: number; compact?: boolean }) {
  return (
    <p
      className={cn(
        "rounded-xl border border-dashed border-border text-center text-sm text-muted",
        compact ? "mt-2 px-3 py-2" : "mt-4 px-4 py-4",
      )}
    >
      <span className="font-semibold text-foreground">{n} more</span> {n === 1 ? "is" : "are"} waiting below the cap.
      Clear a few and they move up.
    </p>
  );
}

async function TeamView({ user, now }: { user: PageUser; now: Date }) {
  const groups = await getTeamQueues(user, now);
  if (!groups.length) {
    return (
      <div className="rounded-2xl border border-border bg-surface px-6 py-14 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-foreground text-white">
          <PartyPopper className="h-7 w-7" aria-hidden />
        </div>
        <h2 className="text-lg font-semibold">The whole team is clear</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">No one has anything due today, and the pool is empty.</p>
      </div>
    );
  }
  const total = groups.reduce((n, g) => n + g.queue.total, 0);
  return (
    <>
      <p className="mb-3 text-sm">
        <span className="font-semibold">
          {total} {total === 1 ? "action" : "actions"}
        </span>
        <span className="text-muted">
          {" "}
          across {groups.length} {groups.length === 1 ? "queue" : "queues"}
        </span>
      </p>
      <div className="space-y-3">
        {groups.map((g, i) => (
          <TeamGroup key={g.userId ?? "pool"} group={g} open={i < 3} canAnswerTransfer={can(user, "contacts.reassign")} />
        ))}
      </div>
    </>
  );
}

function TeamGroup({
  group,
  open,
  canAnswerTransfer,
}: {
  group: TeamQueueGroup;
  open: boolean;
  canAnswerTransfer: boolean;
}) {
  const q = group.queue;
  const prefix = `${group.userId ?? "pool"}-`;
  const plural = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : null);
  const parts = [
    plural(q.counts.abandoned, "checkout", "checkouts"),
    plural(q.counts.overdue, "overdue", "overdue"),
    plural(q.counts.customers, "customer", "customers"),
    plural(q.counts.leads + q.counts.other, "lead", "leads"),
  ].filter(Boolean);
  return (
    <details open={open} className="group rounded-2xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {group.userId ? (
          <Avatar name={group.name} />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
            <Users className="h-4 w-4" aria-hidden />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{group.name}</span>
            {group.role && <span className="text-xs text-muted">{ROLE_LABELS[group.role]}</span>}
            {!group.active && <Badge tone="warning">Inactive</Badge>}
          </span>
          <span className="block truncate text-xs text-muted">
            {group.userId ? parts.join(" · ") : `Unassigned work: ${parts.join(" · ")}`}
          </span>
        </span>
        <span className="tabular rounded-full bg-surface-muted px-2 py-0.5 text-sm font-semibold">{q.total}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-border px-2 py-3 sm:p-4">
        <QueueList
          rows={q.rows}
          idPrefix={prefix}
          returnTo="/today?view=team"
          canAnswerTransfer={canAnswerTransfer}
        />
        {q.leftOut > 0 && <LeftOut n={q.leftOut} compact />}
      </div>
    </details>
  );
}
