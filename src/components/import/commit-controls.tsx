"use client";
import { useState, useTransition } from "react";
import { Loader2, RotateCcw, Upload } from "lucide-react";
import { startCommitAction, startUndoAction } from "@/app/(app)/import/actions";
import { Button } from "@/components/ui/button";
import { PhaseRunner } from "./phase-runner";

/** Step 6: starts the commit (after a confirmation) and shows its progress. */
export function CommitButton({
  batchId,
  rows,
  disabledReason,
  summary,
}: {
  batchId: string;
  rows: number;
  disabledReason?: string | null;
  summary: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  if (started !== null) {
    return <PhaseRunner batchId={batchId} phases={["commit"]} autoStart initial={{ done: 0, total: started }} />;
  }
  return (
    <div className="space-y-2">
      <Button
        size="lg"
        className="w-full sm:w-auto"
        disabled={!!disabledReason || pending || rows === 0}
        aria-describedby={disabledReason ? `commit-why-${batchId}` : undefined}
        onClick={() => {
          if (!window.confirm(`Commit ${rows.toLocaleString("en-IN")} rows? ${summary} You can undo the whole import later in one click.`)) return;
          setError(null);
          startTransition(async () => {
            const res = await startCommitAction(batchId);
            if (!res || !res.ok) setError(res?.error ?? "Could not start the commit.");
            else setStarted(res.data ?? rows);
          });
        }}
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
        Commit import
      </Button>
      {disabledReason && (
        <p id={`commit-why-${batchId}`} className="text-xs text-muted">
          {disabledReason}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** One-click undo of a committed import (after a confirmation), with progress. */
export function UndoButton({
  batchId,
  fileName,
  created,
  updated,
  resume = false,
  size = "md",
}: {
  batchId: string;
  fileName: string;
  created: number;
  updated: number;
  /** an undo already started: show the progress and a Continue button */
  resume?: boolean;
  size?: "sm" | "md";
}) {
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  if (resume || total !== null) {
    return (
      <div className="min-w-56">
        <PhaseRunner batchId={batchId} phases={["undo"]} autoStart={total !== null} startLabel="Continue undo" initial={total !== null ? { done: 0, total } : undefined} />
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Button
        variant="outline"
        size={size}
        className={size === "sm" ? "max-md:h-10" : undefined}
        disabled={pending}
        onClick={() => {
          const msg =
            `Undo the import of ${fileName}? This deletes the ${created.toLocaleString("en-IN")} contacts it created ` +
            `(except any with calls, purchases or edits since), removes its purchases and enquiries, and puts back what it ` +
            `changed on ${updated.toLocaleString("en-IN")} existing contacts.`;
          if (!window.confirm(msg)) return;
          setError(null);
          startTransition(async () => {
            const res = await startUndoAction(batchId);
            if (!res || !res.ok) setError(res?.error ?? "Could not start the undo.");
            else setTotal(res.data ?? 0);
          });
        }}
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
        Undo import
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
