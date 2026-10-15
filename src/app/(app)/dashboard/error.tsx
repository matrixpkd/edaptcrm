"use client";
import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { reportClientError } from "@/components/shell/client-error-reporter";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";

/** Shown when the dashboard's numbers could not be loaded (e.g. the database was unreachable). */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportClientError({ message: error.message || "Dashboard error", stack: error.stack ?? null, digest: error.digest ?? null, source: "boundary" });
  }, [error]);
  return (
    <div className="rounded-xl border border-border bg-surface">
      <EmptyState
        title="The dashboard could not load right now"
        description="Nothing is lost; the numbers are worked out fresh each time. Try again in a moment, and if it keeps happening let Umer know."
        action={
          <Button variant="outline" onClick={() => reset()}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            Try again
          </Button>
        }
      />
    </div>
  );
}
