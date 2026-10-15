import Link from "next/link";
import { ArrowRightLeft, CheckCircle2, MessageCircle, Phone, ShieldCheck, StickyNote, UserPlus, Wallet } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { ACTIVITY_FILTERS, getActivityFeed, type ActivityItem } from "@/lib/activity/feed";
import { requireUser } from "@/lib/auth/session";
import { listOwnerOptions } from "@/lib/contacts/queries";
import { getSettings, labelFor } from "@/lib/settings";
import { compactAgo, validTimeZone } from "@/lib/today/time";
import { cn, formatDateTime, formatINR, isUuid } from "@/lib/utils";

export const metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

type SP = { show?: string; who?: string; before?: string };

const INTERACTION_LABELS: Record<string, string> = {
  call: "logged a call with",
  whatsapp: "logged a WhatsApp chat with",
  meeting: "logged a meeting with",
  email: "logged an email to",
  note: "added a note on",
  support_issue: "logged a support issue for",
};

const STAGE_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  first_purchase: "First purchase",
  repeat: "Repeat",
  advocate: "Advocate",
  dormant: "Dormant",
  lost: "Lost",
};

function iconFor(item: ActivityItem) {
  switch (item.kind) {
    case "interaction":
      return item.detail === "call" ? Phone : item.detail === "note" ? StickyNote : MessageCircle;
    case "lead":
      return UserPlus;
    case "payment":
      return Wallet;
    case "verify":
      return ShieldCheck;
    case "stage":
    case "owner":
      return ArrowRightLeft;
    default:
      return CheckCircle2;
  }
}

/** Team activity for managers and admins: who did what, newest first. */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser(["admin", "manager"]);
  const sp = await searchParams;
  const filter = ACTIVITY_FILTERS.find((f) => f.key === sp.show) ?? ACTIVITY_FILTERS[0];
  const who = sp.who && isUuid(sp.who) ? sp.who : null;
  const before = sp.before ? new Date(sp.before) : null;
  const tz = validTimeZone(user.timezone);
  const now = new Date();
  const [{ items, nextBefore }, people, s] = await Promise.all([
    getActivityFeed(user, { kinds: filter.kinds, userId: who, before: before && !Number.isNaN(before.getTime()) ? before : null }),
    listOwnerOptions(),
    getSettings(["lists.outcomes", "lists.channels"]),
  ]);
  const href = (patch: Partial<SP>) => {
    const q = new URLSearchParams();
    const next = { show: filter.key === "all" ? undefined : filter.key, who: who ?? undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    const str = q.toString();
    return `/activity${str ? `?${str}` : ""}`;
  };

  function sentence(item: ActivityItem): React.ReactNode {
    const contact = item.contactId ? (
      <Link href={`/contacts/${item.contactId}`} className="font-medium hover:underline">
        {item.contactName}
      </Link>
    ) : null;
    switch (item.kind) {
      case "interaction":
        return (
          <>
            {INTERACTION_LABELS[item.detail ?? ""] ?? "logged a touch with"} {contact}
            {item.extra && <span className="text-muted"> · {labelFor(s["lists.outcomes"], item.extra)}</span>}
          </>
        );
      case "lead":
        return (
          <>
            added the lead {contact}
            {item.detail && <span className="text-muted"> · {labelFor(s["lists.channels"], item.detail)}</span>}
          </>
        );
      case "payment":
        return (
          <>
            recorded a {item.detail === "refund" ? "refund" : "payment"} of {formatINR(item.amountInr)} for {contact}
            {item.extra === "unverified" && <span className="text-muted"> · waiting to be verified</span>}
          </>
        );
      case "verify":
        return (
          <>
            {item.extra === "rejected" ? "rejected" : "verified"} {formatINR(item.amountInr)} from {contact}
          </>
        );
      case "stage":
        return (
          <>
            moved {contact} to {STAGE_LABELS[item.detail ?? ""] ?? item.detail}
          </>
        );
      case "owner":
        return (
          <>
            gave {contact} to {item.detail}
            {item.extra && <span className="text-muted"> · {item.extra}</span>}
          </>
        );
      case "task":
        return (
          <>
            finished {item.extra === "follow_up" ? "a follow-up" : "the task"} “{item.detail}”{contact && <> for {contact}</>}
          </>
        );
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Activity" description="What the team did, newest first: calls and messages, leads, payments, stages, owners and tasks." />
      <Tabs
        className="mb-4"
        active={filter.key}
        tabs={ACTIVITY_FILTERS.map((f) => ({ key: f.key, label: f.label, href: href({ show: f.key === "all" ? undefined : f.key, before: undefined }) }))}
      />
      <form method="get" action="/activity" className="mb-4 flex flex-wrap items-end gap-2">
        {filter.key !== "all" && <input type="hidden" name="show" value={filter.key} />}
        <label className="flex flex-col gap-1 text-sm font-medium">
          Person
          <select name="who" defaultValue={who ?? ""} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm">
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonClass("outline", "md")}>
          Show
        </button>
      </form>
      {items.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface px-6 py-12 text-center">
          <p className="font-medium">No activity yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            Calls logged, leads added, payments recorded and stage changes show here as the team works.
          </p>
        </div>
      ) : (
        <ol className="divide-y divide-border rounded-2xl border border-border bg-surface" aria-label="Team activity">
          {items.map((item) => {
            const Icon = iconFor(item);
            return (
              <li key={item.id} className="flex items-start gap-3 px-4 py-3">
                <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-muted")}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="break-words">
                    <span className="font-semibold">{item.actorName ?? "Someone"}</span> {sentence(item)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted" title={formatDateTime(item.at, tz)}>
                    {compactAgo(item.at, now)} · {formatDateTime(item.at, tz)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {nextBefore && (
        <div className="mt-4 text-center">
          <Link href={href({ before: nextBefore.toISOString() })} className={buttonClass("outline", "md")}>
            Older activity
          </Link>
        </div>
      )}
    </div>
  );
}
