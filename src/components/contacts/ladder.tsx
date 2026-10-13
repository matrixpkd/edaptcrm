import { ArrowRight, TrendingUp } from "lucide-react";
import type { ProductFamily, Rung } from "@/lib/settings/defaults";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatINR, pct } from "@/lib/utils";

/**
 * "A ladder, not a funnel": every contact page shows the current rung, the next rung, the next best offer,
 * the expected 90-day revenue and when the next purchase is expected (or that they are at risk).
 */
export function LadderCard({
  currentRung,
  rungs,
  families,
  bought,
  nextOffer,
  expected90dInr,
  repeatProb90d,
  nextExpectedAt,
  atRisk,
  purchaseCount,
  nextRungDays,
  timeZone,
  now = new Date(),
}: {
  currentRung: number;
  rungs: Rung[];
  families: ProductFamily[];
  bought: string[];
  nextOffer: string | null;
  expected90dInr: number | null;
  repeatProb90d: number | null;
  nextExpectedAt: Date | null;
  atRisk: boolean;
  purchaseCount: number;
  nextRungDays: number;
  timeZone: string;
  now?: Date;
}) {
  const ordered = [...rungs].sort((a, b) => a.rung - b.rung);
  const current = ordered.find((r) => r.rung === currentRung) ?? null;
  const next = ordered.find((r) => r.rung > currentRung) ?? null;
  const sideGroups = families.filter((f) => f.rung == null && bought.includes(f.key));
  const daysToNext = nextExpectedAt
    ? Math.round((new Date(nextExpectedAt).getTime() - now.getTime()) / 86_400_000)
    : null;
  const dueSoon = !atRisk && daysToNext != null && daysToNext <= nextRungDays;

  return (
    <section aria-labelledby="ladder-title" className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="ladder-title" className="text-sm font-semibold">
          The ladder
        </h2>
        {atRisk ? (
          <Badge tone="danger">At risk</Badge>
        ) : dueSoon ? (
          <Badge tone="warning">Due for the next rung</Badge>
        ) : null}
      </div>

      <ol
        className="mt-3 grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${Math.max(ordered.length, 1)}, minmax(0, 1fr))` }}
      >
        {ordered.map((r) => {
          const done = r.rung <= currentRung;
          const isCurrent = r.rung === currentRung;
          const isNext = next?.rung === r.rung;
          return (
            <li key={r.rung} className="min-w-0">
              <div
                className={cn(
                  "h-2 rounded-full",
                  done ? "bg-foreground" : isNext ? "bg-foreground/25 ring-1 ring-foreground/40" : "bg-surface-muted",
                )}
                aria-hidden
              />
              <p
                className={cn(
                  "mt-1.5 line-clamp-2 break-words text-[11px] leading-tight",
                  isCurrent ? "font-semibold text-foreground" : isNext ? "font-medium text-foreground" : "text-muted",
                )}
                title={r.description ?? r.label}
              >
                <span className="sr-only">{isCurrent ? "Current rung: " : isNext ? "Next rung: " : ""}</span>
                {r.rung}. {r.label}
              </p>
            </li>
          );
        })}
      </ol>

      <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2 text-sm">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Now</dt>
          <dd className="font-medium">{current ? current.label : "Not on the ladder yet"}</dd>
        </div>
        <ArrowRight className="mt-4 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0">
          <dt className="text-xs text-muted">Next rung</dt>
          <dd className="font-semibold">{next ? next.label : "Top rung: renewal and referrals"}</dd>
        </div>
      </dl>
      {sideGroups.length > 0 && (
        <p className="mt-1 text-xs text-muted">Also bought: {sideGroups.map((f) => f.label).join(", ")}</p>
      )}

      <div className="mt-3 rounded-lg bg-surface-muted px-3 py-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Next best offer</p>
        <p className="mt-0.5 flex items-start gap-1.5 font-semibold">
          <TrendingUp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {nextOffer ?? "No offer rule matches yet"}
        </p>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted">Expected 90-day revenue</dt>
          <dd className="tabular mt-0.5 font-semibold">
            {expected90dInr != null ? (
              formatINR(expected90dInr)
            ) : (
              <span className="font-normal text-muted">
                {purchaseCount === 0 ? "After a first purchase" : "Not forecast yet"}
              </span>
            )}
            {repeatProb90d != null && (
              <span className="ml-1 text-xs font-normal text-muted">({pct(repeatProb90d)} chance)</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{atRisk ? "Expected purchase was" : "Expected next purchase"}</dt>
          <dd className={cn("mt-0.5 font-semibold", atRisk && "text-danger")}>
            {nextExpectedAt
              ? formatDate(nextExpectedAt, timeZone)
              : purchaseCount === 0
                ? "After a first purchase"
                : "–"}
            {atRisk && daysToNext != null && (
              <span className="block text-xs font-normal">{Math.abs(daysToNext)} days ago</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
