"use client";
import { useState } from "react";
import { Check, Copy, KeyRound, MessageCircle } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { inviteMessage, whatsappShareLink } from "@/lib/admin/invite";

export type ShareDetails = { email: string; phone?: string | null; loginUrl: string; reset?: boolean };

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // clipboard blocked (http, old browser): say so instead of pretending; the text is selectable
          setCopied(false);
        }
        setTimeout(() => setCopied(null), 2500);
      }}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {copied === true ? "Copied" : copied === false ? "Select and copy it" : label}
    </Button>
  );
}

/**
 * A temporary password, shown once after create or reset, with how to pass it on: a ready-made message with the
 * sign-in address, to copy or send on WhatsApp.
 */
export function TempPassword({ password, who, share }: { password: string; who: string; share?: ShareDetails }) {
  const message = share ? inviteMessage({ name: who, email: share.email, password, loginUrl: share.loginUrl, reset: share.reset }) : null;
  return (
    <div className="rounded-xl border border-foreground bg-surface p-4" role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Temporary password for {who}</p>
          <p className="mt-0.5 text-xs text-muted">
            Shown only now: it is not stored anywhere you can read it again. Send it to {who.split(" ")[0]} privately; if it gets lost, reset it
            again.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="select-all rounded-lg bg-surface-muted px-3 py-2 font-mono text-base tracking-wide" data-testid="temp-password">
              {password}
            </code>
            <CopyButton text={password} label="Copy" />
          </div>
          {message && share && (
            <div className="mt-4">
              <p className="text-xs font-medium">Message to send them</p>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-surface-muted px-3 py-2 font-sans text-sm" data-testid="invite-message">
                {message}
              </pre>
              <div className="mt-2 flex flex-wrap gap-2">
                <CopyButton text={message} label="Copy message" />
                <a href={whatsappShareLink(message, share.phone)} target="_blank" rel="noopener noreferrer" className={buttonClass("outline", "sm")}>
                  <MessageCircle className="h-4 w-4" aria-hidden /> Send on WhatsApp
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
