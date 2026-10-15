"use client";
import { useState } from "react";
import { Hand, UserRoundPlus } from "lucide-react";
import { ActionForm } from "@/components/contacts/action-form";
import { AssignOwnerForm } from "@/components/contacts/assign-owner";
import type { Option } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";
import { requestPoolLeadAction } from "../actions";

/**
 * The Owner column of the Contacts list. Managers assign or change the owner in place; a salesperson asks for a
 * pool lead with one tap (the manager approves it from Today).
 */
export function OwnerCell({
  contactId,
  ownerId,
  ownerName,
  meId,
  mode,
  people,
  className,
}: {
  contactId: string;
  ownerId: string | null;
  ownerName: string | null;
  meId: string;
  mode: "assign" | "request" | null;
  people: Option[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const label = ownerName ? (ownerId === meId ? "You" : ownerName) : "Pool";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn("truncate", ownerName ? "" : "font-medium text-warning")}>{label}</span>
        {mode === "assign" && !open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-lg border px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ownerId
                ? "border-border bg-surface text-muted hover:text-foreground"
                : "border-foreground bg-foreground text-white hover:bg-black/85",
            )}
            aria-label={ownerId ? `Change the owner of this contact` : `Assign this contact`}
          >
            <UserRoundPlus className="h-3.5 w-3.5" aria-hidden />
            {ownerId ? "Change" : "Assign"}
          </button>
        )}
        {mode === "request" && !ownerId && !requested && (
          <ActionForm action={requestPoolLeadAction} onSuccess={() => setRequested(true)} messageClassName="mt-1 text-xs">
            <input type="hidden" name="contactId" value={contactId} />
            <SubmitButton variant="outline" size="sm" className="h-8 px-2 text-xs" pendingText="Asking…">
              <Hand className="h-3.5 w-3.5" aria-hidden /> Request
            </SubmitButton>
          </ActionForm>
        )}
        {requested && <span className="text-xs text-muted">Requested</span>}
      </div>
      {open && (
        <AssignOwnerForm
          compact
          className="mt-2 min-w-56"
          contactId={contactId}
          people={people}
          currentOwnerId={ownerId}
          meId={meId}
          onDone={() => setOpen(false)}
        />
      )}
    </div>
  );
}
