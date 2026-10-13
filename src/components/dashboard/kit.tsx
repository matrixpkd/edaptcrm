/**
 * Building blocks for the growth cockpit: stat tiles, section cards, table toggles, a meter and a two-part split
 * bar. Server components (no client JS). Text wears ink tokens; colour marks sit beside the text they identify.
 */
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { Delta } from "@/lib/dashboard/format";
import { cn } from "@/lib/utils";
import { VIZ } from "./palette";

/**
 * A KPI tile: label, value, optional delta against a named period and a hint. The delta carries an arrow and
 * words, never colour alone; `upIsGood` decides whether up reads as good (green) or bad (red).
 */
export function StatTile({
  label,
  value,
  title,
  delta,
  compare,
  upIsGood = true,
  hint,
  href,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
  delta?: Delta | null;
  compare?: string;
  upIsGood?: boolean;
  hint?: React.ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground" title={title}>
        {value}
      </p>
      {delta && delta.text && <DeltaLine delta={delta} compare={compare} upIsGood={upIsGood} />}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </>
  );
  const cls = "block min-w-0 rounded-xl border border-border bg-surface p-4";
  return href ? (
    <Link
      href={href}
      className={cn(cls, "hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function DeltaLine({ delta, compare, upIsGood = true }: { delta: Delta; compare?: string; upIsGood?: boolean }) {
  const good = delta.direction === "flat" ? null : (delta.direction === "up") === upIsGood;
  const Icon = delta.direction === "up" ? ArrowUpRight : delta.direction === "down" ? ArrowDownRight : Minus;
  const words = delta.direction === "up" ? "up" : delta.direction === "down" ? "down" : "";
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs">
      <span
        className={cn(
          "inline-flex items-center gap-0.5 font-medium",
          good === true ? "text-success" : good === false ? "text-danger" : "text-muted",
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">{words}</span>
        {delta.text}
      </span>
      {compare && <span className="text-muted">vs {compare}</span>}
    </p>
  );
}

/** A card for one cockpit metric: title, what it tells you, which period it covers. */
export function Section({
  id,
  title,
  why,
  scope,
  actions,
  className,
  bodyClassName,
  children,
}: {
  id: string;
  title: string;
  why: string;
  scope: string;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className={cn("min-w-0 rounded-xl border border-border bg-surface", className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3 sm:flex-nowrap">
        <div className="min-w-0 sm:flex-1">
          <h2 id={`${id}-title`} className="text-sm font-semibold">
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-muted">{why}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-muted">{scope}</span>
        </div>
      </header>
      <div className={bodyClassName ?? "p-4"}>{children}</div>
    </section>
  );
}

/** The accessible twin of a chart: a native disclosure with the same numbers as a table. */
export function TableToggle({ label = "Show as table", children }: { label?: string; children: React.ReactNode }) {
  return (
    <details className="group mt-3">
      <summary className="inline-flex min-h-10 cursor-pointer select-none items-center gap-1 rounded text-xs sm:min-h-0 font-medium text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="group-open:hidden">{label}</span>
        <span className="hidden group-open:inline">Hide table</span>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

/** A single ratio against its whole: blue fill on a lighter step of the same ramp. */
export function Meter({ value, label }: { value: number | null; label: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(pct)}
      aria-valuetext={value === null ? "No data" : `${Math.round(pct)}%`}
      className="h-2.5 w-full overflow-hidden rounded-full"
      style={{ background: VIZ.track }}
    >
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: VIZ.series1 }} />
    </div>
  );
}

/**
 * Two parts of a whole side by side (e.g. assisted vs self-serve), separated by a 2px surface gap. Negative or
 * empty totals show an empty track.
 */
export function SplitBar({
  parts,
  label,
}: {
  parts: { name: string; value: number; color: string }[];
  label: string;
}) {
  const positive = parts.map((p) => Math.max(0, p.value));
  const total = positive.reduce((a, b) => a + b, 0);
  return (
    <div role="img" aria-label={label} className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-surface-muted">
      {total > 0 &&
        parts.map((p, i) =>
          positive[i] > 0 ? (
            <div
              key={p.name}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(positive[i] / total) * 100}%`, background: p.color }}
            />
          ) : null,
        )}
    </div>
  );
}

export function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />;
}

/** A small "number + label" pair used inside sections. */
export function Figure({ label, value, hint, title }: { label: string; value: React.ReactNode; hint?: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tracking-tight" title={title}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Friendly empty state inside a section. */
export function SectionEmpty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-sm text-xs text-muted">{children}</p>}
    </div>
  );
}
