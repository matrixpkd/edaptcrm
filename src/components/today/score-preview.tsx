"use client";
import type { ContactScore } from "@/lib/metrics/scoring";
import { cn } from "@/lib/utils";

const gradeClass: Record<string, string> = {
  A: "bg-grade-a text-white",
  B: "bg-grade-b text-white",
  C: "bg-grade-c text-white",
  D: "bg-grade-d text-white",
};

function Delta({ now, was }: { now: number | null; was: number | null }) {
  if (now === null || was === null || now === was) return null;
  const d = now - was;
  return (
    <span className={cn("tabular text-[11px] font-semibold", d > 0 ? "text-success" : "text-danger")}>
      {d > 0 ? `+${d}` : `−${Math.abs(d)}`}
    </span>
  );
}

function Cell({
  label,
  value,
  was,
  big = false,
}: {
  label: string;
  value: number | null;
  was: number | null;
  big?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="flex items-baseline gap-1">
        <span className={cn("tabular font-semibold leading-tight", big ? "text-2xl" : "text-lg")}>
          {value === null ? "—" : value}
        </span>
        <Delta now={value} was={was} />
      </p>
    </div>
  );
}

/**
 * Live Fit / Readiness / Value / Edapt / grade while rating. `before` is the same formula on the values the
 * contact has now, so the deltas show exactly what this rating changes.
 */
export function ScorePreview({
  after,
  before,
  layout = "bar",
}: {
  after: ContactScore;
  before: ContactScore;
  layout?: "bar" | "card";
}) {
  const changed = after.edaptScore !== before.edaptScore || after.grade !== before.grade;
  const summary = `Edapt Score ${after.edaptScore}, grade ${after.grade}${changed ? `, was ${before.edaptScore} (${before.grade})` : ""}`;
  const grade = (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-lg font-bold",
        layout === "card" ? "h-12 min-w-12 px-2 text-xl" : "h-9 min-w-9 px-1.5 text-base",
        gradeClass[after.grade],
      )}
      aria-hidden
    >
      {after.grade}
    </span>
  );

  if (layout === "bar") {
    return (
      <div className="flex items-center gap-3">
        <div className="grid flex-1 grid-cols-4 gap-2">
          <Cell label="Fit" value={after.fit} was={before.fit} />
          <Cell label="Ready" value={after.readiness} was={before.readiness} />
          <Cell label="Value" value={after.value} was={before.value} />
          <Cell label="Edapt" value={after.edaptScore} was={before.edaptScore} />
        </div>
        {grade}
        <p className="sr-only" aria-live="polite">
          {summary}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {grade}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Edapt Score</p>
          <p className="flex items-baseline gap-1.5">
            <span className="tabular text-3xl font-semibold leading-none">{after.edaptScore}</span>
            <Delta now={after.edaptScore} was={before.edaptScore} />
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 border-t border-border pt-3">
        <Cell label="Fit" value={after.fit} was={before.fit} />
        <Cell label="Readiness" value={after.readiness} was={before.readiness} />
        <Cell label="Value" value={after.value} was={before.value} />
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {after.isCustomer
          ? "Customer: a quarter Fit, a quarter Readiness, half Value, plus the gut adjustment."
          : "Lead: half Fit, half Readiness, plus the gut adjustment. Value counts once they pay."}
        {after.breakdown.gut !== 0 && (
          <>
            {" "}
            Gut: {after.breakdown.gut > 0 ? "+" : "−"}
            {Math.abs(after.breakdown.gut)}.
          </>
        )}
      </p>
      {changed && (
        <p className="text-xs text-muted">
          Before this rating: {before.edaptScore} ({before.grade})
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {summary}
      </p>
    </div>
  );
}
