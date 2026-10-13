"use client";
import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A temporary password, shown once after create or reset, with a copy button. */
export function TempPassword({ password, who }: { password: string; who: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-foreground bg-surface p-4" role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Temporary password for {who}</p>
          <p className="mt-0.5 text-xs text-muted">
            Shown only now. Give it to them privately; you can reset it again any time.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="select-all rounded-lg bg-surface-muted px-3 py-2 font-mono text-base tracking-wide">{password}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(password);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  /* clipboard blocked: the text is selectable */
                }
              }}
            >
              {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
