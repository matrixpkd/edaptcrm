"use client";
import { useState } from "react";
import { cn } from "@/lib/utils";

export type ChipOption = { value: string; label: React.ReactNode; hint?: string };

/**
 * One-tap choice chips that submit through a hidden input named `name`.
 * Single select by default; `multiple` submits one hidden input per selected value.
 */
export function ChipGroup({
  name,
  options,
  defaultValue,
  multiple = false,
  onChange,
  className,
  allowDeselect = true,
  size = "md",
}: {
  name: string;
  options: ChipOption[];
  defaultValue?: string | string[] | null;
  multiple?: boolean;
  onChange?: (value: string[]) => void;
  className?: string;
  allowDeselect?: boolean;
  size?: "sm" | "md";
}) {
  const init = defaultValue == null ? [] : Array.isArray(defaultValue) ? defaultValue : [defaultValue];
  const [selected, setSelected] = useState<string[]>(init);

  function toggle(v: string) {
    let next: string[];
    if (multiple) next = selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v];
    else next = selected[0] === v ? (allowDeselect ? [] : selected) : [v];
    setSelected(next);
    onChange?.(next);
  }

  return (
    <div className={cn("flex flex-wrap gap-2", className)} role={multiple ? "group" : "radiogroup"}>
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            role={multiple ? "checkbox" : "radio"}
            aria-checked={on}
            title={o.hint}
            onClick={() => toggle(o.value)}
            className={cn(
              "rounded-full border font-medium transition-colors",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
              on ? "border-foreground bg-foreground text-white" : "border-border bg-surface text-foreground hover:bg-surface-muted",
            )}
          >
            {o.label}
          </button>
        );
      })}
      {multiple ? (
        selected.map((v) => <input key={v} type="hidden" name={name} value={v} />)
      ) : (
        <input type="hidden" name={name} value={selected[0] ?? ""} />
      )}
    </div>
  );
}

/** 1–5 star input that submits through a hidden input. */
export function StarInput({
  name,
  defaultValue,
  onChange,
}: {
  name: string;
  defaultValue?: number | null;
  onChange?: (v: number | null) => void;
}) {
  const [value, setValue] = useState<number | null>(defaultValue ?? null);
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Gut rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          onClick={() => {
            const next = value === n ? null : n;
            setValue(next);
            onChange?.(next);
          }}
          className={cn("text-3xl leading-none transition-transform active:scale-90", value && n <= value ? "text-warning" : "text-border")}
        >
          ★
        </button>
      ))}
      <input type="hidden" name={name} value={value ?? ""} />
    </div>
  );
}
