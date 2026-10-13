import Link from "next/link";
import { ArrowDown, GitMerge, Search } from "lucide-react";
import type { ContactFootprint, ContactHeader, ContactPick, MergeHistoryRow } from "@/lib/contacts/queries";
import { GradeBadge, StageBadge } from "@/components/ui/badge";
import { Button, ButtonLink, buttonClass } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ActionForm } from "@/components/contacts/action-form";
import { formatPhone } from "@/lib/phone";
import { formatDate, formatDateTime, formatINR } from "@/lib/utils";
import { mergeAction, undoMergeAction } from "../actions";
import type { Labels } from "./labels";

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function Side({ c, title, labels, tz }: { c: ContactHeader; title: string; labels: Labels; tz: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{title}</p>
      <div className="mt-1 flex items-start justify-between gap-2">
        <p className="min-w-0 truncate font-semibold">{c.name}</p>
        <GradeBadge grade={c.grade} score={c.edaptScore} size="sm" />
      </div>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Phone</dt>
          <dd className="tabular text-right">{formatPhone(c.phoneE164)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Email</dt>
          <dd className="truncate text-right">{c.email ?? "–"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">City</dt>
          <dd className="text-right">{c.city ?? "–"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">First door</dt>
          <dd className="text-right">{labels.door(c.firstDoor)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Owner</dt>
          <dd className="text-right">{c.ownerName ?? "Pool"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">LTV</dt>
          <dd className="tabular text-right">{formatINR(c.ltvInr)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Added</dt>
          <dd className="text-right">{formatDate(c.createdAt, tz)}</dd>
        </div>
      </dl>
    </div>
  );
}

export function MergeTab({
  c,
  q,
  results,
  other,
  otherFootprint,
  otherVisible,
  history,
  labels,
  tz,
}: {
  c: ContactHeader;
  q: string;
  results: ContactPick[];
  other: ContactHeader | null;
  otherFootprint: ContactFootprint | null;
  otherVisible: boolean;
  history: MergeHistoryRow[];
  labels: Labels;
  tz: string;
}) {
  // ---- confirmation screen
  if (other && otherFootprint) {
    const older = other.createdAt < c.createdAt ? other : c;
    const newer = older === c ? other : c;
    const firstOwner = older.firstOwnerName ?? newer.firstOwnerName ?? (c.ownerName ? null : other.ownerName);
    const owner = c.ownerName ?? other.ownerName;
    const moves = [
      plural(otherFootprint.purchases, "purchase"),
      plural(otherFootprint.payments, "payment"),
      plural(otherFootprint.enquiries, "enquiry", "enquiries"),
      plural(otherFootprint.interactions, "interaction"),
      plural(otherFootprint.ratings, "rating"),
      plural(otherFootprint.referred, "referred person", "referred people"),
    ];
    const alternates = [
      formatPhone(other.phoneE164),
      ...other.altPhones.map(formatPhone),
      other.email,
      ...other.altEmails,
    ].filter(Boolean);
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <GitMerge className="h-5 w-5" aria-hidden />
          <h3 className="text-base font-semibold">
            Merge {other.name} into {c.name}?
          </h3>
        </div>
        <div className="grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
          <Side c={other} title="Merged away" labels={labels} tz={tz} />
          <ArrowDown className="mx-auto h-5 w-5 text-muted sm:-rotate-90" aria-hidden />
          <Side c={c} title="Stays" labels={labels} tz={tz} />
        </div>
        <Card className="p-4">
          <h4 className="text-sm font-semibold">What happens</h4>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm">
            <li>
              <strong>{c.name}</strong> stays. {other.name}&apos;s record is kept, marked as merged, and no longer shows
              in lists.
            </li>
            <li>Moves over: {moves.join(", ")}.</li>
            {alternates.length > 0 && (
              <li>
                Kept as alternates on {c.name}: {alternates.join(", ")}.
              </li>
            )}
            <li>
              First door: <strong>{labels.door(older.firstDoor)}</strong> (the older record&apos;s).
            </li>
            <li>
              Owner: <strong>{owner ?? "the pool"}</strong>
              {firstOwner ? (
                <>
                  ; first owner stays <strong>{firstOwner}</strong>
                </>
              ) : null}
              .
            </li>
            <li>Empty profile fields are filled from {other.name}; a salesperson&apos;s rating beats a self-rating.</li>
            <li>Nothing is deleted. The merge is logged and can be undone from this tab.</li>
          </ul>
        </Card>
        <ActionForm action={mergeAction} className="space-y-3">
          <input type="hidden" name="winnerId" value={c.id} />
          <input type="hidden" name="loserId" value={other.id} />
          <Field label="Reason (optional)" htmlFor="merge-reason">
            <Input id="merge-reason" name="reason" placeholder="e.g. Same person, second number" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <SubmitButton pendingText="Merging…">
              <GitMerge className="h-4 w-4" aria-hidden /> Merge into {c.name}
            </SubmitButton>
            <ButtonLink href={`/contacts/${c.id}?tab=merge`} variant="ghost">
              Cancel
            </ButtonLink>
            {otherVisible && (
              <ButtonLink href={`/contacts/${other.id}?tab=merge&with=${c.id}`} variant="outline">
                Keep {other.name} instead
              </ButtonLink>
            )}
          </div>
        </ActionForm>
      </div>
    );
  }

  // ---- search + history
  // undo works newest first: a later merge into this contact must be undone before an earlier one
  const latestActive = history.find((h) => h.role === "winner" && !h.undoneAt);
  return (
    <div className="space-y-5">
      <section aria-labelledby="merge-search-title" className="space-y-3">
        <div>
          <h3 id="merge-search-title" className="text-sm font-semibold">
            Merge a duplicate into {c.name}
          </h3>
          <p className="text-sm text-muted">
            Search by name, phone or email. You will see exactly what happens before anything changes.
          </p>
        </div>
        <form method="get" action={`/contacts/${c.id}`} className="flex gap-2" role="search">
          <input type="hidden" name="tab" value="merge" />
          <label htmlFor="merge-q" className="sr-only">
            Search contacts
          </label>
          <Input
            id="merge-q"
            name="mq"
            defaultValue={q}
            placeholder="Name, phone or email"
            className="flex-1"
            autoComplete="off"
          />
          <Button type="submit" variant="outline">
            <Search className="h-4 w-4" aria-hidden /> Search
          </Button>
        </form>
        {q && results.length === 0 && <p className="text-sm text-muted">No other contact matches “{q}”.</p>}
        {results.length > 0 && (
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
            {results.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                <GradeBadge grade={r.grade} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="tabular truncate text-xs text-muted">
                    {formatPhone(r.phoneE164)}
                    {r.email ? ` · ${r.email}` : ""}
                    {r.city ? ` · ${r.city}` : ""} · {r.ownerName ?? "Pool"} · added {formatDate(r.createdAt, tz)}
                  </p>
                </div>
                <div className="hidden sm:block">
                  <StageBadge stage={r.stage} />
                </div>
                <Link href={`/contacts/${c.id}?tab=merge&with=${r.id}`} className={buttonClass("outline", "md")}>
                  Review
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="merge-history-title" className="space-y-2">
        <h3 id="merge-history-title" className="text-sm font-semibold">
          Merge history
        </h3>
        {history.length === 0 ? (
          <EmptyState
            title="No merges"
            description="Merges into or out of this contact show here, each with an undo."
          />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
            {history.map((h) => {
              const canUndo = latestActive?.id === h.id;
              return (
                <li key={h.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {h.role === "winner" ? (
                        <>
                          Merged in{" "}
                          <Link href={`/contacts/${h.otherId}`} className="underline-offset-2 hover:underline">
                            {h.otherName}
                          </Link>
                        </>
                      ) : (
                        <>
                          This record was merged into{" "}
                          <Link href={`/contacts/${h.otherId}`} className="underline-offset-2 hover:underline">
                            {h.otherName}
                          </Link>
                        </>
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      <span className="tabular">{formatPhone(h.otherPhone)}</span> · {formatDateTime(h.mergedAt, tz)}
                      {h.mergedByName ? ` by ${h.mergedByName}` : ""}
                      {h.reason ? ` · ${h.reason}` : ""}
                      {h.undoneAt
                        ? ` · undone ${formatDateTime(h.undoneAt, tz)}${h.undoneByName ? ` by ${h.undoneByName}` : ""}`
                        : ""}
                    </p>
                  </div>
                  {canUndo ? (
                    <ActionForm
                      action={undoMergeAction}
                      confirm={`Undo the merge? ${h.otherName} becomes a separate contact again.`}
                    >
                      <input type="hidden" name="mergeId" value={h.id} />
                      <input type="hidden" name="contactId" value={c.id} />
                      <SubmitButton variant="outline" size="md" pendingText="Undoing…">
                        Undo
                      </SubmitButton>
                    </ActionForm>
                  ) : h.role === "winner" && !h.undoneAt ? (
                    <span className="text-xs text-muted">Undo the later merge first</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
