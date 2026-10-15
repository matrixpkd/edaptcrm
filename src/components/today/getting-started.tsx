import Link from "next/link";
import { CheckCircle2, ChevronRight, Circle, Rocket, X } from "lucide-react";
import { checklistSummary } from "@/lib/admin/checklist";
import type { Onboarding } from "@/lib/admin/onboarding";
import { onboardingVisibilityAction } from "@/app/(app)/today/actions";
import { cn } from "@/lib/utils";

/**
 * The admin's "Getting started" checklist: six set-up steps, each linking to its screen and ticked off from the
 * data (src/lib/admin/checklist.ts). On Today it can be hidden; Settings always shows it until everything is done.
 */
export function GettingStarted({ onboarding, dismissible = true }: { onboarding: Onboarding; dismissible?: boolean }) {
  const { items, done, total } = onboarding;
  return (
    <section aria-labelledby="getting-started-title" className="mb-5 rounded-2xl border border-border bg-surface">
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-white">
          <Rocket className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="getting-started-title" className="font-semibold">
            Getting started
          </h2>
          <p className="text-sm text-muted">
            {checklistSummary(items)}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
            <div className="h-full rounded-full bg-foreground" style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </div>
        </div>
        {dismissible && (
          <form action={onboardingVisibilityAction}>
            <button
              type="submit"
              className="-mr-1 rounded-lg p-2 text-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Hide the getting started checklist"
              title="Hide (Settings still shows it)"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </form>
        )}
      </header>
      <ol className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className="flex items-center gap-3 px-4 py-3 hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {item.done ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-label="Done" />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-muted" aria-label="To do" />
              )}
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm font-medium", item.done && "text-muted line-through decoration-1")}>{item.title}</span>
                <span className="block text-xs text-muted">{item.detail}</span>
              </span>
              <span className="hidden shrink-0 text-xs font-medium sm:inline">{item.action}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
