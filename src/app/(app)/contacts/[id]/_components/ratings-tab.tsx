import type { RatingRow } from "@/lib/contacts/queries";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { RATING_SOURCE_LABELS, SPENDING_BAND_LABELS } from "@/components/contacts/labels";
import { formatDateTime } from "@/lib/utils";
import type { Labels } from "./labels";

export function RatingsTab({
  ratings,
  contactId,
  canRate,
  labels,
  tz,
}: {
  ratings: RatingRow[];
  contactId: string;
  canRate: boolean;
  labels: Labels;
  tz: string;
}) {
  const rate = canRate ? (
    <ButtonLink href={`/contacts/${contactId}/rate`} size="md">
      Rate
    </ButtonLink>
  ) : null;
  if (!ratings.length) {
    return (
      <EmptyState
        title="Not rated yet"
        description="Four quick scales and a gut rating. A salesperson's rating overrides the customer's own answers."
        action={rate}
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">Every rating is kept. The contact shows the latest values.</p>
        {rate}
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
        {ratings.map((r) => {
          const values: [string, string][] = [];
          if (r.aiLevel != null) values.push(["AI knowledge", `${r.aiLevel} / 5`]);
          if (r.umerLevel != null) values.push(["Umer familiarity", `${r.umerLevel} / 5`]);
          if (r.spendingBand != null)
            values.push(["Spending power", SPENDING_BAND_LABELS[r.spendingBand] ?? String(r.spendingBand)]);
          if (r.gutStars != null) values.push(["Gut rating", "★".repeat(r.gutStars) + "☆".repeat(5 - r.gutStars)]);
          if (r.ageBand) values.push(["Age band", labels.ageBand(r.ageBand)]);
          if (r.industry) values.push(["Industry or role", labels.industry(r.industry)]);
          return (
            <li key={r.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  <Badge tone={r.source === "sales" ? "brand" : "neutral"}>{RATING_SOURCE_LABELS[r.source]}</Badge>
                  <span className="ml-2">
                    {r.source === "sales"
                      ? (r.ratedByName ?? "A team member")
                      : r.source === "self"
                        ? "The customer"
                        : "Import"}
                  </span>
                </p>
                <time className="text-xs text-muted" dateTime={r.createdAt.toISOString()}>
                  {formatDateTime(r.createdAt, tz)}
                </time>
              </div>
              {values.length > 0 && (
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
                  {values.map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-xs text-muted">{k}</dt>
                      <dd className="font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {r.notes && <p className="mt-2 whitespace-pre-line text-sm text-foreground/85">{r.notes}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
