import Link from "next/link";
import { redirect } from "next/navigation";
import { GitMerge } from "lucide-react";
import { GradeBadge, StageBadge } from "@/components/ui/badge";
import { EmptyState, PageHeader } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ActionForm } from "@/components/contacts/action-form";
import { countryName } from "@/components/contacts/labels";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { listOpenDuplicateReviews, type DuplicateReviewSide } from "@/lib/contacts/merge";
import { countPossibleDuplicates } from "@/lib/contacts/queries";
import { formatPhone } from "@/lib/phone";
import { getSetting, labelFor, type ListItem } from "@/lib/settings";
import { cn, formatDate, formatINR } from "@/lib/utils";
import { dismissPairAction, mergePairAction } from "./actions";

export const metadata = { title: "Duplicates" };

const LIMIT = 100;

/** The record to keep by default: the one with more money on it, then more purchases, then the older one. */
function suggestedWinner(a: DuplicateReviewSide, b: DuplicateReviewSide): "a" | "b" {
  if (a.ltvInr !== b.ltvInr) return a.ltvInr > b.ltvInr ? "a" : "b";
  if (a.purchaseCount !== b.purchaseCount) return a.purchaseCount > b.purchaseCount ? "a" : "b";
  return new Date(a.createdAt) <= new Date(b.createdAt) ? "a" : "b";
}

type Field = {
  label: string;
  get: (s: DuplicateReviewSide) => React.ReactNode;
  key: (s: DuplicateReviewSide) => string;
};

function SideCard({
  side,
  other,
  fields,
  suggested,
  tz,
}: {
  side: DuplicateReviewSide;
  other: DuplicateReviewSide;
  fields: Field[];
  suggested: boolean;
  tz: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-xl border p-3", suggested ? "border-foreground" : "border-border")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/contacts/${side.id}`}
            className="block truncate font-semibold underline-offset-2 hover:underline"
          >
            {side.name}
          </Link>
          <p className="text-xs text-muted">Added {formatDate(side.createdAt, tz)}</p>
        </div>
        <GradeBadge grade={side.grade} size="sm" />
      </div>
      {suggested && <p className="mt-1 text-xs font-medium">Suggested to keep</p>}
      <dl className="mt-2 space-y-1 text-sm">
        {fields.map((f) => {
          const same = f.key(side) !== "" && f.key(side) === f.key(other);
          return (
            <div key={f.label} className="flex justify-between gap-3">
              <dt className="shrink-0 text-muted">{f.label}</dt>
              <dd
                className={cn("min-w-0 truncate text-right", same && "font-semibold")}
                title={same ? "Same on both" : undefined}
              >
                {f.get(side) || <span className="text-muted">–</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** The name, plus the end of the number when both records have the same name. */
function who(s: DuplicateReviewSide, other: DuplicateReviewSide): string {
  return s.name.trim().toLowerCase() === other.name.trim().toLowerCase()
    ? `${s.name} (…${s.phoneE164.slice(-4)})`
    : s.name;
}

export default async function DuplicatesPage() {
  const user = await requireUser();
  if (!can(user, "contacts.merge")) redirect("/today?denied=1");
  const tz = user.timezone || "Asia/Kolkata";
  const [reviews, total, doors] = await Promise.all([
    listOpenDuplicateReviews(undefined, { limit: LIMIT }),
    countPossibleDuplicates(),
    getSetting("lists.firstDoors"),
  ]);
  const fields = (doorList: ListItem[]): Field[] => [
    {
      label: "Phone",
      get: (s) => <span className="tabular">{formatPhone(s.phoneE164)}</span>,
      key: (s) => s.phoneE164,
    },
    { label: "Email", get: (s) => s.email, key: (s) => (s.email ?? "").toLowerCase() },
    { label: "City", get: (s) => s.city, key: (s) => (s.city ?? "").trim().toLowerCase() },
    { label: "Country", get: (s) => (s.country ? countryName(s.country) : null), key: (s) => s.country ?? "" },
    { label: "First door", get: (s) => labelFor(doorList, s.firstDoor), key: (s) => s.firstDoor },
    { label: "Stage", get: (s) => <StageBadge stage={s.stage} />, key: () => "" },
    { label: "Purchases", get: (s) => String(s.purchaseCount), key: () => "" },
    { label: "LTV", get: (s) => <span className="tabular">{formatINR(s.ltvInr)}</span>, key: () => "" },
    { label: "Owner", get: (s) => s.ownerName ?? "Pool", key: (s) => s.ownerId ?? "" },
  ];
  const f = fields(doors);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Duplicates"
        description={
          total === 0
            ? "Possible duplicates are pairs the system will not merge on its own, such as the same name in the same city."
            : `${total} possible duplicate${total === 1 ? "" : "s"} waiting. Same name in the same city is never merged automatically.`
        }
      />
      {reviews.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<GitMerge className="h-6 w-6" />}
            title="Nothing to review"
            description="When two records look like the same person, they show up here side by side."
          />
        </div>
      ) : (
        <ul className="space-y-4">
          {reviews.map((r) => {
            const win = suggestedWinner(r.a, r.b);
            const [keep, drop] = win === "a" ? [r.a, r.b] : [r.b, r.a];
            return (
              <li key={r.id} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{r.reason}</p>
                  <p className="text-xs text-muted">Flagged {formatDate(r.createdAt, tz)}</p>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <SideCard side={r.a} other={r.b} fields={f} suggested={win === "a"} tz={tz} />
                  <SideCard side={r.b} other={r.a} fields={f} suggested={win === "b"} tz={tz} />
                </div>
                <div className="mt-3 flex flex-wrap items-start gap-2">
                  <ActionForm
                    action={mergePairAction}
                    className="min-w-0 max-w-full"
                    confirm={`Keep ${who(keep, drop)} and merge ${who(drop, keep)} into it? Nothing is deleted and it can be undone.`}
                  >
                    <input type="hidden" name="winnerId" value={keep.id} />
                    <input type="hidden" name="loserId" value={drop.id} />
                    <SubmitButton pendingText="Merging…" className="max-w-full">
                      <GitMerge className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="truncate">Keep {who(keep, drop)}</span>
                    </SubmitButton>
                  </ActionForm>
                  <ActionForm
                    action={mergePairAction}
                    className="min-w-0 max-w-full"
                    confirm={`Keep ${who(drop, keep)} and merge ${who(keep, drop)} into it? Nothing is deleted and it can be undone.`}
                  >
                    <input type="hidden" name="winnerId" value={drop.id} />
                    <input type="hidden" name="loserId" value={keep.id} />
                    <SubmitButton variant="outline" pendingText="Merging…" className="max-w-full">
                      <span className="truncate">Keep {who(drop, keep)}</span>
                    </SubmitButton>
                  </ActionForm>
                  <ActionForm action={dismissPairAction} className="sm:ml-auto">
                    <input type="hidden" name="reviewId" value={r.id} />
                    <SubmitButton variant="ghost" pendingText="Saving…">
                      Not the same person
                    </SubmitButton>
                  </ActionForm>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {total > reviews.length && (
        <p className="text-sm text-muted">
          Showing the newest {reviews.length} of {total}. Resolve these to see more.
        </p>
      )}
    </div>
  );
}
