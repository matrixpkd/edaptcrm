import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const STEPS = ["Upload", "Map", "Clean", "Match", "Review", "Commit"] as const;

/**
 * The six steps of the wizard. `current` is 1-based; `complete` marks every step done (committed).
 * On a phone only the numbers show, with the current step's name.
 */
export function Stepper({ current, complete = false }: { current: number; complete?: boolean }) {
  return (
    <nav aria-label="Import steps" className="mb-5">
      <ol className="flex items-center gap-1 sm:gap-2">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = complete || n < current;
          const active = !complete && n === current;
          return (
            <li key={label} className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2" aria-current={active ? "step" : undefined}>
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  done ? "bg-foreground text-white" : active ? "border-2 border-foreground text-foreground" : "border border-border text-muted",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : n}
              </span>
              <span
                className={cn(
                  "sr-only text-sm md:not-sr-only md:truncate",
                  active ? "font-semibold" : "text-muted",
                  done && "text-foreground",
                )}
              >
                {label}
                <span className="sr-only">{done ? " (done)" : active ? " (current step)" : ""}</span>
              </span>
              {n < STEPS.length && <span className={cn("h-px flex-1", done ? "bg-foreground" : "bg-border")} aria-hidden />}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-sm md:hidden" aria-hidden>
        {complete ? (
          <span className="font-semibold">All six steps done</span>
        ) : (
          <>
            Step {current} of {STEPS.length}: <span className="font-semibold">{STEPS[current - 1]}</span>
          </>
        )}
      </p>
    </nav>
  );
}
