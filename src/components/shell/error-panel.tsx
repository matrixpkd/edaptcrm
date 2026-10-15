"use client";
import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "./client-error-reporter";

/** Friendly error screen for error boundaries. Reports the error (with its digest) to the error log once. */
export function ErrorPanel({
  error,
  reset,
  title = "Something went wrong on this screen",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}) {
  useEffect(() => {
    reportClientError({ message: error.message || "Render error", stack: error.stack ?? null, digest: error.digest ?? null, source: "boundary" });
  }, [error]);
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-border bg-surface p-6 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-2 text-sm text-muted">
        It has been recorded for the admin (Settings → Error log). Try again; if it keeps happening, share this
        reference: <span className="font-mono">{error.digest ?? "no reference"}</span>
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <Button variant="outline" onClick={() => reset()}>
          <RotateCcw className="h-4 w-4" aria-hidden /> Try again
        </Button>
        <Button variant="ghost" onClick={() => window.location.assign("/today")}>
          Go to Today
        </Button>
      </div>
    </div>
  );
}
