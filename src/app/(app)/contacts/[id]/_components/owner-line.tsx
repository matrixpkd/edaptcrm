"use client";
import { useState } from "react";
import { UserRoundPlus } from "lucide-react";
import { AssignOwnerForm } from "@/components/contacts/assign-owner";
import type { Option } from "@/components/ui/form";

/**
 * "Owner: Kavya · Assign" under the contact's name. Managers and admins assign or unassign right here; everyone
 * else just reads who owns the contact.
 */
export function OwnerLine({
  ownerLabel,
  inPool,
  ownerInactive,
  extra,
  assign,
}: {
  ownerLabel: string;
  inPool: boolean;
  ownerInactive: boolean;
  /** first owner, organisation: server-rendered */
  extra?: React.ReactNode;
  assign: { contactId: string; people: Option[]; currentOwnerId: string | null; meId: string } | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <p className="text-sm">
        <span className="text-muted">Owner: </span>
        <span className={inPool ? "font-medium text-warning" : "font-medium"}>{ownerLabel}</span>
        {ownerInactive && <span className="text-danger"> (inactive)</span>}
        {assign && (
          <>
            <span className="text-muted"> · </span>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="inline-flex min-h-8 items-center gap-1 rounded-md font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <UserRoundPlus className="h-3.5 w-3.5" aria-hidden />
              {inPool ? "Assign" : "Change"}
            </button>
          </>
        )}
        {extra}
      </p>
      {open && assign && (
        <AssignOwnerForm
          className="mt-2"
          contactId={assign.contactId}
          people={assign.people}
          currentOwnerId={assign.currentOwnerId}
          meId={assign.meId}
          onDone={() => setOpen(false)}
        />
      )}
    </div>
  );
}
