"use client";
import { useState } from "react";
import { ChevronDown, ShieldCheck, ShieldX } from "lucide-react";
import {
  consentAction,
  eraseContactAction,
} from "@/app/(app)/contacts/[id]/privacy/actions";
import { ActionForm } from "@/components/contacts/action-form";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Sheet } from "@/components/ui/sheet";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";

/**
 * Privacy on the contact page: marketing consent in one tap (sales with edit rights, managers, admins) and, for
 * admins, "Erase personal data" for a person who asks to be forgotten (DPDP / UAE PDPL).
 */
export function PrivacyCard({
  contactId,
  name,
  consent,
  consentSince,
  canConsent,
  canErase,
}: {
  contactId: string;
  name: string;
  consent: boolean | null;
  consentSince: string | null;
  canConsent: boolean;
  canErase: boolean;
}) {
  const [erasing, setErasing] = useState(false);
  const status =
    consent === null
      ? "Not asked yet"
      : consent
        ? `Yes${consentSince ? `, since ${consentSince}` : ""}`
        : `No${consentSince ? `, since ${consentSince}` : ""}`;
  return (
    // folded by default: a rare action, and on a phone the timeline should not sink below it
    <details
      className="group rounded-xl border border-border bg-surface"
      aria-labelledby="privacy-title"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
        <span id="privacy-title" className="text-sm font-semibold">
          Privacy
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-sm">
          <span className="text-muted">Consent: </span>
          <span className="font-medium" data-testid="consent-status">
            {status}
          </span>
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="border-t border-border px-4 pb-4 pt-3">
        <p className="text-sm text-muted">
          Marketing consent is what lets Edapt send offers (DPDP / UAE data
          protection).
        </p>
        {canConsent && (
          <ActionForm
            action={consentAction}
            className="mt-2"
            aria-label="Marketing consent"
          >
            <input type="hidden" name="contactId" value={contactId} />
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["yes", "Agreed"],
                  ["no", "Withdrawn"],
                ] as const
              ).map(([value, label]) => {
                const on =
                  (value === "yes" && consent === true) ||
                  (value === "no" && consent === false);
                return (
                  <button
                    key={value}
                    type="submit"
                    name="consent"
                    value={value}
                    aria-pressed={on}
                    disabled={on}
                    className={cn(
                      "h-10 rounded-full border px-3.5 text-sm font-medium",
                      on
                        ? "border-foreground bg-foreground text-white"
                        : "border-border bg-surface hover:bg-surface-muted",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </ActionForm>
        )}
        {canErase && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 text-danger"
              onClick={() => setErasing(true)}
            >
              <ShieldX className="h-4 w-4" aria-hidden /> Erase personal data
            </Button>
            <Sheet
              open={erasing}
              onClose={() => setErasing(false)}
              title={`Erase ${name}'s personal data?`}
            >
              <div className="space-y-3 text-sm">
                <p>
                  For a person who asked to be forgotten. Their name, phone,
                  email, notes, message texts and raw form or checkout data are
                  wiped, open tasks close and alerts about them go.{" "}
                  <strong>This cannot be undone.</strong>
                </p>
                <p className="text-muted">
                  Purchases and payments stay for the accounts, attached to an
                  anonymous record, so revenue and LTV do not change. If they
                  contact Edapt again they start as a new contact.
                </p>
                <ActionForm
                  action={eraseContactAction}
                  className="space-y-3"
                  aria-label="Erase personal data"
                >
                  <input type="hidden" name="contactId" value={contactId} />
                  <Field
                    label="Why (kept in the audit log)"
                    htmlFor="erase-reason"
                    required
                  >
                    <Input
                      id="erase-reason"
                      name="reason"
                      required
                      maxLength={500}
                      placeholder="e.g. Asked by email on 12 Oct"
                    />
                  </Field>
                  <Field
                    label="Type ERASE to confirm"
                    htmlFor="erase-confirm"
                    required
                  >
                    <Input
                      id="erase-confirm"
                      name="confirm"
                      required
                      autoComplete="off"
                    />
                  </Field>
                  <div className="flex gap-2">
                    <SubmitButton variant="danger" pendingText="Erasing…">
                      Erase for good
                    </SubmitButton>
                    <Button variant="ghost" onClick={() => setErasing(false)}>
                      Cancel
                    </Button>
                  </div>
                </ActionForm>
              </div>
            </Sheet>
          </>
        )}
      </div>
    </details>
  );
}
