"use client";
import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Controlled one-tap choices built on native radio inputs, so they submit with the form, move with the
 * arrow keys and read correctly in screen readers. `allowClear` lets a second tap on the chosen chip clear it.
 */

export type Choice<T extends string> = { value: T; label: React.ReactNode; hint?: string };

export function RadioChips<T extends string>({
  name,
  legend,
  legendExtra,
  options,
  value,
  onChange,
  allowClear = false,
  size = "md",
  error,
  className,
}: {
  name: string;
  legend: React.ReactNode;
  /** shown at the right of the legend row */
  legendExtra?: React.ReactNode;
  options: Choice<T>[];
  value: T | null;
  onChange: (v: T | null) => void;
  allowClear?: boolean;
  size?: "sm" | "md";
  error?: string | null;
  className?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  // the legend sits in a layout row, not as the fieldset's first child, so it names the group explicitly
  const legendId = useId();
  return (
    <fieldset className={className} aria-describedby={errorId} aria-labelledby={legendId}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <legend id={legendId} className="text-sm font-semibold">
          {legend}
        </legend>
        {legendExtra}
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = value === o.value;
          return (
            <label key={o.value} className="relative cursor-pointer" title={o.hint}>
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                onChange={() => onChange(o.value)}
                onClick={() => {
                  if (allowClear && on) onChange(null);
                }}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "inline-flex select-none items-center rounded-full border font-medium transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
                  size === "sm" ? "h-10 px-3 text-sm" : "h-11 px-4 text-sm",
                  on
                    ? "border-foreground bg-foreground text-white"
                    : "border-border bg-surface text-foreground hover:bg-surface-muted active:bg-surface-muted",
                )}
              >
                {o.label}
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p id={errorId} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export type Anchor = { value: number; label: React.ReactNode; text: React.ReactNode; sub?: React.ReactNode };

/** An anchored scale: one full-width row per level with its anchor sentence. */
export function ScaleRadios({
  name,
  legend,
  hint,
  badge,
  anchors,
  value,
  onChange,
  canClear,
  clearLabel = "Clear",
}: {
  name: string;
  legend: React.ReactNode;
  hint?: React.ReactNode;
  badge?: React.ReactNode;
  anchors: Anchor[];
  value: number | null;
  onChange: (v: number | null) => void;
  /** show the clear button (default: when something is chosen) */
  canClear?: boolean;
  clearLabel?: string;
}) {
  const showClear = canClear ?? value !== null;
  const legendId = useId();
  return (
    <fieldset aria-labelledby={legendId}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <legend id={legendId} className="text-sm font-semibold">
            {legend}
          </legend>
          {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {badge}
          {showClear && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="-my-2 inline-flex h-10 items-center rounded-md px-2 text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {clearLabel}
            </button>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        {anchors.map((a) => {
          const on = value === a.value;
          return (
            <label key={a.value} className="block cursor-pointer">
              <input
                type="radio"
                name={name}
                value={a.value}
                checked={on}
                onChange={() => onChange(a.value)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "flex min-h-12 select-none items-center gap-3 rounded-xl border px-3 py-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
                  on
                    ? "border-foreground bg-foreground text-white"
                    : "border-border bg-surface hover:bg-surface-muted active:bg-surface-muted",
                )}
              >
                <span
                  className={cn(
                    "tabular flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-1.5 text-sm font-semibold",
                    on ? "bg-white text-foreground" : "bg-surface-muted text-foreground",
                  )}
                >
                  {a.label}
                </span>
                <span className="min-w-0 text-sm leading-snug">
                  {a.text}
                  {a.sub && <span className={cn("block text-xs", on ? "text-white/75" : "text-muted")}>{a.sub}</span>}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
