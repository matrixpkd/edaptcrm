"use client";
/**
 * The dashboard's one filter row: This month / Last 30 days / Last 90 days / Custom. Plain links and a GET form,
 * so it works without JavaScript; with JavaScript the navigation runs in a transition and the cockpit below holds
 * its previous render at reduced opacity until the new numbers arrive (no skeleton flash, no layout jump).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

type PendingCtx = { pending: boolean; go: (href: string) => void };
const Ctx = createContext<PendingCtx>({ pending: false, go: () => {} });

export function DashboardPending({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = (href: string) => start(() => router.push(href, { scroll: false }));
  return <Ctx.Provider value={{ pending, go }}>{children}</Ctx.Provider>;
}

/** Wraps everything the period scopes; dims while a new period loads. */
export function PendingArea({ children }: { children: React.ReactNode }) {
  const { pending } = useContext(Ctx);
  return (
    <div aria-busy={pending} className={cn("transition-opacity duration-150", pending && "pointer-events-none opacity-60")}>
      {children}
    </div>
  );
}

type Preset = { key: string; label: string; href: string };

export function PeriodPicker({
  presets,
  active,
  from,
  to,
  maxDate,
  basePath,
  openCustom = false,
}: {
  presets: Preset[];
  active: string;
  from: string;
  to: string;
  maxDate: string;
  basePath: string;
  /** open the custom range form (e.g. to correct a range that could not be used) */
  openCustom?: boolean;
}) {
  const { pending, go } = useContext(Ctx);
  const [customOpen, setCustomOpen] = useState(active === "custom" || openCustom);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <nav aria-label="Period" className="flex flex-wrap gap-1.5">
        {presets.map((p) => {
          const on = p.key === active;
          return (
            <Link
              key={p.key}
              href={p.href}
              scroll={false}
              aria-current={on ? "true" : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                setCustomOpen(false);
                go(p.href);
              }}
              className={cn(
                "inline-flex h-10 items-center gap-1.5 rounded-full sm:h-9 border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                on ? "border-foreground bg-foreground text-white" : "border-border bg-surface text-foreground hover:bg-surface-muted",
              )}
            >
              {on && <Check className="h-4 w-4" strokeWidth={3} aria-hidden />}
              {p.label}
            </Link>
          );
        })}
        <button
          type="button"
          aria-expanded={customOpen}
          aria-controls="dashboard-custom-range"
          onClick={() => setCustomOpen((v) => !v)}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-full sm:h-9 border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            active === "custom" ? "border-foreground bg-foreground text-white" : "border-border bg-surface text-foreground hover:bg-surface-muted",
          )}
        >
          {active === "custom" && <Check className="h-4 w-4" strokeWidth={3} aria-hidden />}
          Custom
        </button>
      </nav>

      {customOpen && (
        <form
          id="dashboard-custom-range"
          action={basePath}
          method="get"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const q = new URLSearchParams({ period: "custom", from: String(fd.get("from") ?? ""), to: String(fd.get("to") ?? "") });
            go(`${basePath}?${q.toString()}`);
          }}
          className="flex w-full flex-wrap items-end gap-2 border-t border-border pt-3 sm:w-auto sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0"
        >
          <input type="hidden" name="period" value="custom" />
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            From
            <input
              type="date"
              name="from"
              required
              defaultValue={from}
              max={maxDate}
              className="h-10 rounded-lg border border-border bg-surface px-2 sm:h-9 text-sm text-foreground focus:border-foreground focus:outline-none focus:ring-2 focus:ring-black/10"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            To
            <input
              type="date"
              name="to"
              required
              defaultValue={to}
              max={maxDate}
              className="h-10 rounded-lg border border-border bg-surface px-2 sm:h-9 text-sm text-foreground focus:border-foreground focus:outline-none focus:ring-2 focus:ring-black/10"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center rounded-lg bg-brand sm:h-9 px-3.5 text-sm font-medium text-brand-foreground hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
          >
            Apply
          </button>
        </form>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? "Loading the new period" : ""}
      </span>
    </div>
  );
}
