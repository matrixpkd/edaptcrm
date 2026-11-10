import "server-only";
import { db, type Tx } from "@/db";
import type { Contact, Stage } from "@/db/schema";
import { can, canEditContact, canViewContact } from "@/lib/auth/permissions";
import {
  ContactForbiddenError,
  ContactMergedError,
  ContactNotFoundError,
  ContactValidationError,
} from "@/lib/contacts/errors";
import { getContact, withTx, type Actor } from "@/lib/contacts/internal";
import { reopenContact, setManualStage } from "@/lib/contacts/lifecycle";
import { moveIntent } from "./rules";

export type BoardMove = { kind: "qualify" | "lose" | "reopen"; contact: Contact };

/**
 * A card dropped on the pipeline board (or moved with the phone's Move menu): Qualified, Lost (with a reason) or
 * Reopen, through the lifecycle service, which re-checks the rights and the rules.
 *
 * Rights come first. A contact the actor may not open fails exactly like one that does not exist
 * (ContactNotFoundError), before any reply that depends on the record ("It is already there", "Customers are
 * already past Qualified", who may reopen it), so a salesperson cannot learn a colleague's contact's stage by
 * dropping its id on a column.
 */
export async function moveBoardCard(
  contactId: string,
  to: Stage,
  opts: { lostReason?: string | null },
  actor: Actor,
  tx: Tx = db,
): Promise<BoardMove> {
  if (!can(actor, "contacts.setStage")) throw new ContactForbiddenError("You cannot change stages");
  return withTx(tx, async (t) => {
    const c = await getContact(contactId, t, { forUpdate: true }); // ContactNotFoundError when there is none
    if (!canViewContact(actor, c)) throw new ContactNotFoundError();
    if (c.mergedIntoId) throw new ContactMergedError(c.mergedIntoId);
    if (!canEditContact(actor, c)) throw new ContactForbiddenError("You cannot change this contact's stage");
    const intent = moveIntent(c.stage, to, c.purchaseCount);
    if (intent.kind === "none") throw new ContactValidationError(intent.reason, "stage");
    const after =
      intent.kind === "reopen"
        ? await reopenContact(contactId, actor, t)
        : intent.kind === "qualify"
          ? await setManualStage(contactId, "qualified", {}, actor, t)
          : await setManualStage(contactId, "lost", { lostReason: opts.lostReason }, actor, t);
    return { kind: intent.kind, contact: after };
  });
}
