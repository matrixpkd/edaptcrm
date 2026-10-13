import { cn } from "@/lib/utils";
import type { Stage } from "@/db/schema";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-muted text-foreground/80 ring-border",
  brand: "bg-brand text-brand-foreground ring-brand",
  success: "bg-success/10 text-success ring-success/20",
  warning: "bg-warning/10 text-warning ring-warning/25",
  danger: "bg-danger/10 text-danger ring-danger/20",
  info: "bg-accent/10 text-accent ring-accent/20",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

const gradeClass: Record<string, string> = {
  A: "bg-grade-a text-white",
  B: "bg-grade-b text-white",
  C: "bg-grade-c text-white",
  D: "bg-grade-d text-white",
};

/** The A–D grade chip, optionally with the Edapt Score. */
export function GradeBadge({
  grade,
  score,
  size = "md",
}: {
  grade: string | null | undefined;
  score?: number | null;
  size?: "sm" | "md" | "lg";
}) {
  const dims = size === "lg" ? "h-12 min-w-12 text-xl" : size === "sm" ? "h-6 min-w-6 text-xs" : "h-8 min-w-8 text-sm";
  if (!grade) {
    return (
      <span
        className={cn("inline-flex items-center justify-center rounded-lg bg-surface-muted px-1.5 font-semibold text-muted", dims)}
        title="Not scored yet"
      >
        –
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5" title={score != null ? `Edapt Score ${score}` : undefined}>
      <span className={cn("inline-flex items-center justify-center rounded-lg px-1.5 font-bold", dims, gradeClass[grade])}>
        {grade}
      </span>
      {score != null && size !== "sm" && <span className="tabular text-sm font-medium text-muted">{score}</span>}
    </span>
  );
}

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  first_purchase: "First purchase",
  repeat: "Repeat customer",
  advocate: "Advocate",
  dormant: "Dormant",
  lost: "Lost",
};

const stageTone: Record<Stage, Tone> = {
  new: "info",
  contacted: "neutral",
  qualified: "warning",
  first_purchase: "success",
  repeat: "success",
  advocate: "brand",
  dormant: "neutral",
  lost: "danger",
};

export function StageBadge({ stage }: { stage: Stage }) {
  return <Badge tone={stageTone[stage]}>{STAGE_LABELS[stage] ?? stage}</Badge>;
}
