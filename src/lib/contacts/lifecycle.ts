import "server-only";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { MANUAL_STAGES, contacts, type Contact, type Stage } from "@/db/schema";
import { audit } from "@/lib/audit";
import { can, canEditContact } from "@/lib/auth/permissions";
import { recomputeContact } from "@/lib/metrics/recompute";
import { getSetting } from "@/lib/settings";
import { ContactForbiddenError, ContactValidationError } from "./errors";
import { getContact, getLiveContact, withTx, type Actor } from "./internal";

/**
 * Lifecycle stages (spec "Lifecycle stages"): the system moves contacts through six of the eight stages
 * (computed by recomputeContact in the metrics module); salespeople set only Qualified and Lost.
 * Lost needs a reason from settings lists.lostReasons.
 */

export type ManualStage = "qualified" | "lost";

/**
 * Sets Qualified or Lost by hand. Lost requires a lost reason key from settings lists.lostReasons;
 * Qualified clears any lost reason. Writes stage, stage_changed_at and lost_reason, audits, then recomputes.
 * A customer (purchase_count > 0) is already past Qualified, so only Lost can be set on one.
 */
export async function setManualStage(
  contactId: string,
  stage: ManualStage,
  opts: { lostReason?: string | null },
  actor: Actor,
  tx: Tx = db,
): Promise<Contact> {
  if (!MANUAL_STAGES.includes(stage as Stage)) {
    throw new ContactValidationError("Only Qualified and Lost are set by hand", "stage");
  }
  let lostReason: string | null = null;
  if (stage === "lost") {
    const key = opts.lostReason?.trim();
    if (!key) throw new ContactValidationError("Choose why the contact was lost", "lostReason");
    const reasons = await getSetting("lists.lostReasons", tx);
    if (!reasons.some((r) => r.key === key && r.active !== false)) {
      throw new ContactValidationError("Choose a lost reason from the list", "lostReason");
    }
    lostReason = key;
  }
  return withTx(tx, async (t) => {
    const c = await getLiveContact(contactId, t, { forUpdate: true });
    if (!can(actor, "contacts.setStage") || !canEditContact(actor, c)) {
      throw new ContactForbiddenError("You cannot change this contact's stage");
    }
    if (stage === "qualified" && c.purchaseCount > 0) {
      throw new ContactValidationError("Customers are already past Qualified", "stage");
    }
    if (c.stage === stage && c.lostReason === lostReason) return c;
    const now = new Date();
    await t
      .update(contacts)
      .set({ stage, lostReason, stageChangedAt: now, updatedAt: now })
      .where(eq(contacts.id, contactId));
    await audit(
      [
        { table: "contacts", rowId: contactId, action: "update", field: "stage", oldValue: c.stage, newValue: stage, userId: actor.id },
        ...(c.lostReason !== lostReason
          ? [{ table: "contacts", rowId: contactId, action: "update", field: "lost_reason", oldValue: c.lostReason, newValue: lostReason, userId: actor.id }]
          : []),
      ],
      t,
    );
    await recomputeContact(contactId, t);
    return getContact(contactId, t);
  });
}

/**
 * Clears Lost so the automatic stage applies again: stage goes to "new" (then recomputeContact moves it to the
 * right automatic stage). Allowed for a manager/admin or the contact's owner.
 */
export async function reopenContact(contactId: string, actor: Actor, tx: Tx = db): Promise<Contact> {
  return withTx(tx, async (t) => {
    const c = await getLiveContact(contactId, t, { forUpdate: true });
    const allowed = actor.role === "admin" || actor.role === "manager" || (c.ownerId !== null && c.ownerId === actor.id);
    if (!allowed) throw new ContactForbiddenError("Only the owner or a manager can reopen this contact");
    if (c.stage !== "lost") throw new ContactValidationError("Only a Lost contact can be reopened", "stage");
    const now = new Date();
    await t
      .update(contacts)
      .set({ stage: "new", lostReason: null, stageChangedAt: now, updatedAt: now })
      .where(eq(contacts.id, contactId));
    await audit(
      [
        { table: "contacts", rowId: contactId, action: "update", field: "stage", oldValue: "lost", newValue: "new", userId: actor.id },
        { table: "contacts", rowId: contactId, action: "update", field: "lost_reason", oldValue: c.lostReason, newValue: null, userId: actor.id },
      ],
      t,
    );
    await recomputeContact(contactId, t);
    return getContact(contactId, t);
  });
}
