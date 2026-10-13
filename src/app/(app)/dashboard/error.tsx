"use client";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";

/** Shown when the dashboard's numbers could not be loaded (e.g. the database was unreachable). */
export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
