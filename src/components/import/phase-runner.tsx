"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { runImportPhaseAction, type ImportPhase } from "@/app/(app)/import/actions";
import { Button } from "@/components/ui/button";

const LABELS: Record<ImportPhase, { running: string; unit: string }> = {
  clean: { running: "Cleaning rows", unit: "rows cleaned" },
  match: { running: "Matching against the CRM", unit: "rows matched" },
  commit: { running: "Committing", unit: "rows imported" },
  undo: { running: "Undoing the import", unit: "rows undone" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the long phases of an import one server-side chunk at a time (about 500-2,000 rows per request, so 50,000
 * rows never hit a time-out), showing progress. Every chunk is saved, so closing the tab only pauses the work:
 * it continues from the same row next time.
 */
export function PhaseRunner({
  batchId,
  phases,
  autoStart,
  startLabel = "Continue",
  initial,
  hint,
}: {
  batchId: string;
  phases: ImportPhase[];
  autoStart: boolean;
  startLabel?: string;
  initial?: { done: number; total: number };
  hint?: string;
}) {
  const router = useRouter();
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [progress, setProgress] = useState(initial ?? { done: 0, total: 0 });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    for (let i = phaseIdx; i < phases.length; i++) {
      setPhaseIdx(i);
      for (let n = 0; n < 100_000; n++) {
        let res: Awaited<ReturnType<typeof runImportPhaseAction>>;
        try {
          res = await runImportPhaseAction(batchId, phases[i]);
        } catch {
          res = { ok: false, error: "The connection dropped. Your progress is saved." };
        }
        if (!res || !res.ok) {
          setError(res?.error ?? "Something went wrong.");
          setRunning(false);
          return;
        }
        const d = res.data!;
        if (d.busy) {
          // another tab or request is working on this import: wait for it
          await sleep(1500);
          continue;
        }
        setProgress({ done: d.done, total: d.total });
        if (d.finished) break;
      }
    }
    setRunning(false);
    setFinished(true);
    router.refresh();
  }, [batchId, phaseIdx, phases, router]);

  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      void run();
    }
  }, [autoStart, run]);

  // leaving mid-way is safe, but say so
  useEffect(() => {
    if (!running) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [running]);

  const phase = phases[Math.min(phaseIdx, phases.length - 1)];
  const pct = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const label = LABELS[phase];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2 font-medium">
          {running && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {finished ? "Done" : running ? `${label.running}…` : error ? "Paused" : label.running}
          {phases.length > 1 && !finished && (
            <span className="text-xs font-normal text-muted">
              (step {phaseIdx + 1} of {phases.length})
            </span>
          )}
        </span>
        <span className="tabular text-muted">{progress.total ? `${pct}%` : ""}</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-label={label.running}
        aria-valuemin={0}
        aria-valuemax={progress.total || 100}
        aria-valuenow={progress.done}
      >
        <div className="h-full rounded-full bg-foreground transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <p className="tabular text-xs text-muted" aria-live="polite">
        {progress.total
          ? `${progress.done.toLocaleString("en-IN")} of ${progress.total.toLocaleString("en-IN")} ${label.unit}`
          : running
            ? "Starting…"
            : hint ?? ""}
      </p>
      {running && <p className="text-xs text-muted">You can leave this page: the work is saved after every chunk and continues from the same row.</p>}
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {!running && !finished && (
        <Button onClick={() => void run()} variant={error ? "outline" : "primary"}>
          {error ? "Try again" : startLabel}
        </Button>
      )}
    </div>
  );
}
