"use client";
import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action";
import { cn } from "@/lib/utils";

export type RecalcChunk = { processed: number; written: number; total: number; next: string | null };
type RecalcAction = (cursor: string | null) => Promise<ActionResult<RecalcChunk>>;

/**
 * "Recalculate all scores now": calls the server in chunks (a few hundred contacts each) until every contact is
 * done, with a progress bar. Safe to stop by leaving the page: the nightly job recalculates everyone anyway.
 */
export function RecalcButton({
  action,
  label = "Recalculate all scores now",
  hint = "Scores, grades and next offers are recalculated every night. Run it now to see the effect straight away.",
  className,
}: {
  action: RecalcAction;
  label?: string;
  hint?: string;
  className?: string;
}) {
  const [state, setState] = useState<
    { s: "idle" } | { s: "running"; done: number; total: number } | { s: "done"; done: number } | { s: "error"; error: string }
  >({ s: "idle" });

  async function run() {
    let cursor: string | null = null;
    let done = 0;
    setState({ s: "running", done: 0, total: 0 });
    for (;;) {
      let r: ActionResult<RecalcChunk>;
      try {
        r = await action(cursor);
      } catch {
        setState({ s: "error", error: "The connection dropped. Run it again: finished contacts are simply recalculated twice." });
        return;
      }
      if (!r?.ok || !r.data) {
        setState({ s: "error", error: r && !r.ok ? r.error : "Recalculation failed. Try again." });
        return;
      }
      done += r.data.processed;
      cursor = r.data.next;
      if (!cursor) {
        setState({ s: "done", done });
        return;
      }
      setState({ s: "running", done, total: r.data.total });
    }
  }

  const running = state.s === "running";
  const pct = running && state.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={run} disabled={running} aria-busy={running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          {running ? "Recalculating…" : label}
        </Button>
        {state.s === "idle" && hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      {running && (
        <div className="flex items-center gap-3" role="status" aria-live="polite">
          <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-surface-muted" aria-hidden>
            <div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="tabular text-xs text-muted">
            {state.total ? `${state.done.toLocaleString("en-IN")} of ${state.total.toLocaleString("en-IN")}` : "Starting…"}
          </span>
        </div>
      )}
      {state.s === "done" && (
        <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          Done: {state.done.toLocaleString("en-IN")} contact{state.done === 1 ? "" : "s"} recalculated.
        </p>
      )}
      {state.s === "error" && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
    </div>
  );
}
