"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, type Option } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ActionForm } from "@/components/contacts/action-form";
import { reassignAction, reopenAction, requestTransferAction, setStageAction } from "../actions";

type Panel = null | "lost" | "owner";

/**
 * Stage buttons (Mark qualified, Mark lost with a reason, Reopen) and the owner action that fits the viewer:
 * reassign (manager/admin), request this contact (a salesperson who does not own it) or ask to hand it over
 * (the owning salesperson). The server checks every right again.
 */
export function ManageControls({
  contactId,
  canQualify,
  canLose,
  canReopen,
  lostReasons,
  ownerMode,
  people,
  currentOwnerId,
}: {
  contactId: string;
  canQualify: boolean;
  canLose: boolean;
  canReopen: boolean;
  lostReasons: Option[];
  ownerMode: "reassign" | "request" | "handover" | null;
  people: Option[];
  currentOwnerId: string | null;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const close = () => setPanel(null);
  const ownerLabel =
    ownerMode === "reassign"
      ? "Reassign"
      : ownerMode === "request"
        ? "Request transfer"
        : ownerMode === "handover"
          ? "Hand over"
          : null;

  if (!canQualify && !canLose && !canReopen && !ownerMode) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canQualify && (
          <ActionForm action={setStageAction}>
            <input type="hidden" name="contactId" value={contactId} />
            <input type="hidden" name="stage" value="qualified" />
            <SubmitButton variant="outline" size="md" pendingText="Saving…">
              Mark qualified
            </SubmitButton>
          </ActionForm>
        )}
        {canLose && (
          <Button variant="outline" size="md" onClick={() => toggle("lost")} aria-expanded={panel === "lost"}>
            Mark lost
          </Button>
        )}
        {canReopen && (
          <ActionForm action={reopenAction}>
            <input type="hidden" name="contactId" value={contactId} />
            <SubmitButton variant="outline" size="md" pendingText="Reopening…">
              Reopen
            </SubmitButton>
          </ActionForm>
        )}
        {ownerLabel && (
          <Button variant="outline" size="md" onClick={() => toggle("owner")} aria-expanded={panel === "owner"}>
            {ownerLabel}
          </Button>
        )}
      </div>

      {panel === "lost" && (
        <ActionForm
          action={setStageAction}
          onSuccess={close}
          className="space-y-3 rounded-lg bg-surface-muted p-3"
          aria-label="Mark lost"
        >
          <input type="hidden" name="contactId" value={contactId} />
          <input type="hidden" name="stage" value="lost" />
          <Field
            label="Why was this contact lost?"
            htmlFor="lost-reason"
            hint="Lost reasons show on the dashboard as product feedback."
          >
            <Select
              id="lost-reason"
              name="lostReason"
              required
              defaultValue=""
              placeholder="Choose a reason…"
              options={lostReasons}
            />
          </Field>
          <div className="flex gap-2">
            <SubmitButton variant="danger" size="md" pendingText="Saving…">
              Mark lost
            </SubmitButton>
            <Button variant="ghost" size="md" onClick={close}>
              Cancel
            </Button>
          </div>
        </ActionForm>
      )}

      {panel === "owner" && ownerMode === "reassign" && (
        <ActionForm
          action={reassignAction}
          onSuccess={close}
          className="space-y-3 rounded-lg bg-surface-muted p-3"
          aria-label="Reassign"
        >
          <input type="hidden" name="contactId" value={contactId} />
          <Field label="New owner" htmlFor="reassign-to">
            <Select id="reassign-to" name="toUserId" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {currentOwnerId && <option value="pool">Back to the pool</option>}
              {people
                .filter((p) => p.value !== currentOwnerId)
                .map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Reason" htmlFor="reassign-reason" hint="Kept in the ownership log.">
            <Input id="reassign-reason" name="reason" required placeholder="e.g. Speaks Arabic, better fit for Dubai" />
          </Field>
          <div className="flex gap-2">
            <SubmitButton size="md" pendingText="Reassigning…">
              Reassign
            </SubmitButton>
            <Button variant="ghost" size="md" onClick={close}>
              Cancel
            </Button>
          </div>
        </ActionForm>
      )}

      {panel === "owner" && (ownerMode === "request" || ownerMode === "handover") && (
        <ActionForm
          action={requestTransferAction}
          className="space-y-3 rounded-lg bg-surface-muted p-3"
          aria-label={ownerLabel ?? undefined}
        >
          <input type="hidden" name="contactId" value={contactId} />
          {ownerMode === "handover" && (
            <Field label="Hand over to" htmlFor="handover-to">
              <Select
                id="handover-to"
                name="toUserId"
                required
                defaultValue=""
                placeholder="Choose a colleague…"
                options={people}
              />
            </Field>
          )}
          <Field
            label={ownerMode === "handover" ? "Why?" : "Why do you need this contact?"}
            htmlFor="transfer-reason"
            hint="Your manager decides. Only managers reassign."
          >
            <Input
              id="transfer-reason"
              name="reason"
              required
              placeholder={
                ownerMode === "handover" ? "e.g. They prefer to speak Hindi" : "e.g. They called me directly"
              }
            />
          </Field>
          <div className="flex gap-2">
            <SubmitButton size="md" pendingText="Sending…">
              Send request
            </SubmitButton>
            <Button variant="ghost" size="md" onClick={close}>
              Cancel
            </Button>
          </div>
        </ActionForm>
      )}
    </div>
  );
}
