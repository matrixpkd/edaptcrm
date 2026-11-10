import { ShieldX } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { ERASED_MESSAGE } from "@/lib/contacts/errors";

/**
 * Shown instead of a form (edit, log, rate, record payment) on a contact whose personal data was erased: the
 * services refuse every such write (src/lib/contacts/privacy.ts), so the screen says so instead of offering it.
 */
export function ErasedNotice({ contactId }: { contactId: string }) {
  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <ShieldX className="h-8 w-8 text-muted" aria-hidden />
      <p className="font-medium">{ERASED_MESSAGE}</p>
      <p className="max-w-sm text-sm text-muted">Nothing new can be added. Their purchases and payments are kept for the accounts.</p>
      <ButtonLink href={`/contacts/${contactId}`} variant="outline" className="mt-2">
        Back to the contact
      </ButtonLink>
    </div>
  );
}
