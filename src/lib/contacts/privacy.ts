import "server-only";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  auditLog,
  contactMerges,
  contacts,
  duplicateReviews,
  enquiries,
  importRows,
  interactions,
  notifications,
  payments,
  purchases,
  ratings,
  tasks,
  webhookEvents,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { recomputeContact } from "@/lib/metrics/recompute";
import { ContactForbiddenError, ContactValidationError } from "./errors";
import { getLiveContact, withTx, type Actor } from "./internal";
import { updateContactProfile } from "./profile";

/**
 * Data-privacy actions (DPDP in India, PDPL in the UAE; spec "Data hygiene"; docs/CRM_GAP_ANALYSIS.md).
 *
 * eraseContact: when a person asks to be forgotten, an admin erases their personal data. The contact row stays,
 * anonymised, because purchases and payments must be kept for accounting and LTV/revenue history must not shift:
 *   - contact: name "Erased contact", phone replaced by a placeholder no real number can match, email, alternates,
 *     city/state, designation, company, sales notes, tags and consent cleared; erased_at / erased_by_id set;
 *   - every free text that can hold personal data: interaction summaries, enquiry notes and raw payloads, rating
 *     notes, purchase notes and raw payloads, import rows, webhook payloads, task reasons and payloads;
 *   - old values in the audit log for this contact, and the "before" snapshots of its merges (so a merge involving
 *     it can no longer be undone);
 *   - its alerts in the bell are deleted; open tasks are closed; open duplicate reviews are dismissed.
 * Contact rows merged INTO it are erased the same way. The erasure itself is audited (who, when, the reason) without
 * any personal data. Erased contacts leave every contacts list and search (contactScope).
 *
 * An erasure is refused while a payment is waiting (unverified or a scheduled instalment): settle the money first.
 */

export const ERASED_NAME = "Erased contact";

/** The phone placeholder: unique per contact, never a valid number, so no capture or import can match it. */
export function erasedPhone(contactId: string): string {
  return `erased:${contactId}`;
}

export function isErasedPhone(phone: string | null | undefined): boolean {
  return !!phone && phone.startsWith("erased:");
}

export async function eraseContact(
  contactId: string,
  actor: Actor,
  reason: string,
  opts: { now?: Date } = {},
  tx: Tx = db,
): Promise<{ erasedIds: string[] }> {
  if (!can(actor, "contacts.erase")) throw new ContactForbiddenError("Only an admin can erase a contact's data");
  const why = (reason ?? "").trim();
  if (!why) throw new ContactValidationError("Say why (for example: the person asked by email on 12 Oct)", "reason");
  if (why.length > 500) throw new ContactValidationError("Keep the reason under 500 characters", "reason");
  const now = opts.now ?? new Date();

  return withTx(tx, async (t) => {
    const c = await getLiveContact(contactId, t, { forUpdate: true });
    if (c.erasedAt) throw new ContactValidationError("This contact's data was already erased", "reason");

    // the contact and every row ever merged into it (merges can chain)
    const ids = [c.id];
    for (let frontier = [c.id]; frontier.length; ) {
      const next = await t.select({ id: contacts.id }).from(contacts).where(inArray(contacts.mergedIntoId, frontier));
      frontier = next.map((r) => r.id).filter((id) => !ids.includes(id));
      ids.push(...frontier);
      if (ids.length > 1000) break;
    }

    const [{ waiting }] = await t
      .select({ waiting: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(inArray(payments.contactId, ids), inArray(payments.status, ["unverified", "scheduled"])));
    if (waiting > 0) {
      throw new ContactValidationError(
        `${waiting} payment${waiting === 1 ? " is" : "s are"} still waiting (unverified or a scheduled instalment). Verify, reject or cancel ${waiting === 1 ? "it" : "them"} first, then erase.`,
        "reason",
      );
    }

    for (const id of ids) {
      await t
        .update(contacts)
        .set({
          name: ERASED_NAME,
          phoneE164: erasedPhone(id),
          email: null,
          altPhones: [],
          altEmails: [],
          city: null,
          state: null,
          designation: null,
          companyName: null,
          salesNotes: null,
          tags: [],
          consent: false,
          consentAt: now,
          fieldSources: {},
          erasedAt: now,
          erasedById: actor.id,
          updatedAt: now,
        })
        .where(eq(contacts.id, id));
    }

    await t.update(interactions).set({ summary: null, pinnedAt: null }).where(inArray(interactions.contactId, ids));
    await t.update(enquiries).set({ rawPayload: null, notes: null }).where(inArray(enquiries.contactId, ids));
    await t.update(ratings).set({ notes: null }).where(inArray(ratings.contactId, ids));
    await t.update(purchases).set({ rawPayload: null, notes: null }).where(inArray(purchases.contactId, ids));
    await t
      .update(tasks)
      .set({ reason: ERASED_NAME, payload: null })
      .where(inArray(tasks.contactId, ids));
    await t
      .update(tasks)
      .set({ status: "dismissed", completedAt: now, completedById: actor.id })
      .where(and(inArray(tasks.contactId, ids), eq(tasks.status, "open")));
    await t.delete(notifications).where(inArray(notifications.contactId, ids));
    await t
      .update(importRows)
      .set({ raw: {}, mapped: null, cleaned: null })
      .where(or(inArray(importRows.contactId, ids), inArray(importRows.matchContactId, ids)));
    await t.update(webhookEvents).set({ payload: {} }).where(inArray(webhookEvents.contactId, ids));
    await t
      .update(auditLog)
      .set({ oldValue: null, newValue: null })
      .where(and(eq(auditLog.tableName, "contacts"), inArray(auditLog.rowId, ids)));
    await t
      .update(contactMerges)
      .set({ winnerBefore: {} })
      .where(or(inArray(contactMerges.winnerId, ids), inArray(contactMerges.loserId, ids)));
    await t
      .update(duplicateReviews)
      .set({ status: "dismissed", resolvedAt: now, resolvedById: actor.id })
      .where(and(eq(duplicateReviews.status, "open"), or(inArray(duplicateReviews.contactAId, ids), inArray(duplicateReviews.contactBId, ids))));

    await audit(
      { table: "contacts", rowId: c.id, action: "erase", field: "personal_data", oldValue: null, newValue: { reason: why, rows: ids.length }, userId: actor.id },
      t,
    );
    await recomputeContact(c.id, t);
    return { erasedIds: ids };
  });
}

/**
 * Records or withdraws marketing consent in one tap (through the profile service, so the rights, consent date,
 * audit and recompute are the same as the Edit form).
 */
export async function setConsent(contactId: string, consent: boolean | null, actor: Actor, tx: Tx = db) {
  const c = await getLiveContact(contactId, tx);
  if (c.erasedAt) throw new ContactValidationError("This contact's data was erased", "consent");
  return updateContactProfile(contactId, { consent }, actor, tx);
}
