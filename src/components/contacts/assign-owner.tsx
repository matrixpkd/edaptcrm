"use client";
import { useId, useState } from "react";
import { UserMinus } from "lucide-react";
import { reassignAction } from "@/app/(app)/contacts/[id]/actions";
import { ActionForm } from "@/components/contacts/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select, type Option } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";

/**
 * Manager/admin: assign one contact to a team member, or unassign it back to the pool. The reason is optional
 * (the ownership log fills in what kind of move it was). Used in the contact page header, the Stage and owner
 * card and the Owner column of the Contacts list.
 */
export function AssignOwnerForm({
  contactId,
  people,
  currentOwnerId,
  meId,
  onDone,
  compact = false,
  className,
}: {
  contactId: string;
  people: Option[];
  currentOwnerId: string | null;
  meId?: string;
  onDone?: () => void;
  /** the list's inline version: one row, no reason box */
  compact?: boolean;
  className?: string;
}) {
  const id = useId();
  const choices = people.filter((p) => p.value !== currentOwnerId);
  const [to, setTo] = useState("");
  return (
    <ActionForm
      action={reassignAction}
      onSuccess={onDone}
      className={cn(compact ? "space-y-2" : "space-y-3 rounded-lg bg-surface-muted p-3", className)}
      aria-label={currentOwnerId ? "Assign to someone else" : "Assign this contact"}
    >
      <input type="hidden" name="contactId" value={contactId} />
      <div className={cn("flex flex-col gap-1.5", compact && "gap-1")}>
        <label htmlFor={`${id}-to`} className={cn("text-sm font-medium", compact && "sr-only")}>
          Assign to
        </label>
        <Select
          id={`${id}-to`}
          name="toUserId"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className={compact ? "h-9" : undefined}
          autoFocus
        >
          <option value="">{choices.length ? "Choose a team member…" : "No other team member yet"}</option>
          {choices.map((p) => (
            <option key={p.value} value={p.value}>
              {p.value === meId ? `${p.label} · you` : p.label}
            </option>
          ))}
        </Select>
        {!choices.length && (
          <p className="text-xs text-muted">Add salespeople on the Team page, then assign leads to them here.</p>
        )}
      </div>
      {!compact && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-reason`} className="text-sm font-medium">
            Reason <span className="font-normal text-muted">(optional, kept in the ownership log)</span>
          </label>
          <Input id={`${id}-reason`} name="reason" maxLength={500} placeholder="e.g. Speaks Arabic, better fit for Dubai" />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton size={compact ? "sm" : "md"} pendingText="Assigning…" disabled={!to}>
          Assign
        </SubmitButton>
        {currentOwnerId && (
          <SubmitButton
            variant="outline"
            size={compact ? "sm" : "md"}
            name="unassign"
            value="1"
            pendingText="Saving…"
            title="Back to the unassigned pool"
          >
            <UserMinus className="h-4 w-4" aria-hidden /> Unassign to pool
          </SubmitButton>
        )}
        {onDone && (
          <Button variant="ghost" size={compact ? "sm" : "md"} onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </ActionForm>
  );
}
