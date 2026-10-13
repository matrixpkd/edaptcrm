import { cn } from "@/lib/utils";

/** Fit, Readiness and Value as three small 0–100 bars. Value is "not used" for leads. */
export function ScoreBars({
  fit,
  readiness,
  value,
  className,
}: {
  fit: number | null;
  readiness: number | null;
  value: number | null;
  className?: string;
}) {
  const items = [
    { label: "Fit", v: fit, hint: "Who they are" },
    { label: "Readiness", v: readiness, hint: "What is in their head" },
    { label: "Value", v: value, hint: value == null ? "Not used until they pay" : "What they have done" },
  ];
  return (
    <dl className={cn("grid grid-cols-3 gap-3", className)}>
      {items.map((i) => (
        <div key={i.label} title={i.hint}>
          <dt className="flex items-baseline justify-between text-xs text-muted">
            <span>{i.label}</span>
            <span className="tabular font-semibold text-foreground">{i.v ?? "–"}</span>
          </dt>
          <dd className="mt-1">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
              role="meter"
              aria-label={`${i.label} score`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={i.v ?? undefined}
              aria-valuetext={i.v == null ? "not scored" : `${i.v} of 100`}
            >
              <div
                className="h-full rounded-full bg-foreground"
                style={{ width: `${Math.max(0, Math.min(100, i.v ?? 0))}%` }}
              />
            </div>
          </dd>
        </div>
      ))}
    </dl>
  );
}
