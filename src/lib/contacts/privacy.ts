import "server-only";
import { and, eq, inArray, ne, notLike, or, sql } from "drizzle-orm";
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
  ownershipLog,
  payments,
  purchases,
  ratings,
  tasks,
  webhookEvents,
} from "@/db/schema";
import { recordAppError } from "@/lib/app-errors";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { recomputeContact } from "@/lib/metrics/recompute";
import { PROOF_FOLDER, deleteStoredFile, redactStoredKey, storedKeyFolder, storedKeyFromUrl } from "@/lib/storage";
import { HANDOVER_REASON } from "./assignment";
import { ContactForbiddenError, ContactValidationError, assertNotErased } from "./errors";
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
 *     notes, import rows (with their issues and the before/after values an import undo would put back), webhook
 *     payloads, task reasons and payloads, the reasons typed for its owner changes and merges;
 *   - money rows keep what the accounts need (reference = TagMango order id / UTR, amounts, currency, fx, dates,
 *     product, status, credited user) and lose their free text: purchase notes and raw payloads, payment and refund
 *     reasons (rejection notes), the same reasons in their audit trail, and their payment proofs (below);
 *   - old values in the audit log for this contact, and the "before" snapshots of its merges (so a merge involving
 *     it can no longer be undone);
 *   - its alerts in the bell are deleted; open tasks are closed; open duplicate reviews are dismissed.
 * Contact rows merged INTO it are erased the same way. The erasure itself is audited (who, when, the reason) without
 * any personal data. Erased contacts leave every contacts list and search (contactScope).
 *
 * Payment proofs (screenshots, PDFs): inside the erasure transaction no purchase or payment points at them any more,
 * so /api/files answers 404 for them at once (canReadStoredFile serves a proof only through a row that holds it).
 * Once the erasure is committed the stored files are deleted; a delete that fails is written to the error log
 * (Settings > Error log) for someone to finish by hand, and the erasure still stands.
 *
 * After the erasure the contact is locked against new personal data: every write service refuses it with
 * ContactErasedError (assertNotErased in ./errors), and its screens show a short notice instead of their forms.
 * Money already recorded stays workable (see src/lib/money/purchases.ts).
 *
 * An erasure is refused while a payment is waiting (unverified or a scheduled instalment): settle the money first.
 */

export const ERASED_NAME = "Erased contact";

/** What replaces a reason typed for an owner change of an erased contact. */
export const ERASED_REASON = "Reason erased";

/**
 * ownership_log reasons the dashboard tells apart (src/lib/dashboard/metrics.ts first-response time): fixed texts,
 * kept as they are so erasing never shifts that history. The import one is written by src/lib/import/commit.ts.
 */
const IMPORT_REASON_PREFIX = "Import:";

/** The phone placeholder: unique per contact, never a valid number, so no capture or import can match it. */
export function erasedPhone(contactId: string): string {
  return `erased:${contactId}`;
}

export function isErasedPhone(phone: string | null | undefined): boolean {
  return !!phone && phone.startsWith("erased:");
}

/** True when the contact's personal data was erased (false for a contact that does not exist). */
export async function isContactErased(contactId: string, tx: Tx = db): Promise<boolean> {
  const [c] = await tx.select({ erasedAt: contacts.erasedAt }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
  return !!c?.erasedAt;
}

export type EraseResult = {
  erasedIds: string[];
  /** storage keys of the payment proofs this erasure unlinked (their files are deleted after the commit) */
  proofKeys: string[];
  /** proof files deleted from storage (0 when the caller owns the transaction and deletes them itself) */
  filesDeleted: number;
  /** proof files that could not be deleted (each one is in the error log) */
  fileErrors: number;
};

/** A jsonb audit value without the free text an object can carry ("reason", "notes"); anything else stays. */
function withoutFreeText(col: typeof auditLog.oldValue | typeof auditLog.newValue) {
  return sql`case when jsonb_typeof(${col}) = 'object' then ${col} - 'reason' - 'notes' else ${col} end`;
}

/**
 * Erases the contact's personal data (see the file comment). Runs in one transaction; called with the default `tx`
 * it then deletes the payment proof files. Inside a caller's transaction the commit is the caller's, so the files
 * are left to them: call deleteErasedProofFiles(result.proofKeys, ...) once that transaction has committed.
 */
export async function eraseContact(
  contactId: string,
  actor: Actor,
  reason: string,
  opts: { now?: Date } = {},
  tx: Tx = db,
): Promise<EraseResult> {
  if (!can(actor, "contacts.erase")) throw new ContactForbiddenError("Only an admin can erase a contact's data");
  const why = (reason ?? "").trim();
  if (!why) throw new ContactValidationError("Say why (for example: the person asked by email on 12 Oct)", "reason");
  if (why.length > 500) throw new ContactValidationError("Keep the reason under 500 characters", "reason");
  const now = opts.now ?? new Date();

  const done = await withTx(tx, async (t) => {
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

    // ---- money: kept for the accounts, without its free text and its proofs
    const buys = await t.select({ id: purchases.id, proofUrl: purchases.proofUrl }).from(purchases).where(inArray(purchases.contactId, ids));
    const buyIds = buys.map((b) => b.id);
    // a payment carries its contact too (kept in sync on merge): look both ways so none of these purchases' is missed
    const payWhere = buyIds.length ? or(inArray(payments.contactId, ids), inArray(payments.purchaseId, buyIds))! : inArray(payments.contactId, ids);
    const pays = await t.select({ id: payments.id, proofUrl: payments.proofUrl }).from(payments).where(payWhere);
    const payIds = pays.map((p) => p.id);
    const proofUrls = [...new Set([...buys, ...pays].map((r) => r.proofUrl).filter((u): u is string => !!u))];
    if (buyIds.length) {
      await t.update(purchases).set({ rawPayload: null, notes: null, proofUrl: null }).where(inArray(purchases.id, buyIds));
    }
    if (payIds.length) {
      await t.update(payments).set({ proofUrl: null, reason: null }).where(inArray(payments.id, payIds));
    }
    const moneyRowIds = [...buyIds, ...payIds];
    if (moneyRowIds.length) {
      // the same notes in their audit trail: refund and rejection reasons, cancellation reasons
      await t
        .update(auditLog)
        .set({ oldValue: withoutFreeText(auditLog.oldValue), newValue: withoutFreeText(auditLog.newValue) })
        .where(and(inArray(auditLog.tableName, ["purchases", "payments"]), inArray(auditLog.rowId, moneyRowIds)));
    }
    // a proof is served only while a purchase or payment points at it: only files no row holds any more are deleted
    const stillHeld = new Set<string>();
    if (proofUrls.length) {
      const held = [
        ...(await t.select({ url: purchases.proofUrl }).from(purchases).where(inArray(purchases.proofUrl, proofUrls))),
        ...(await t.select({ url: payments.proofUrl }).from(payments).where(inArray(payments.proofUrl, proofUrls))),
      ];
      for (const r of held) if (r.url) stillHeld.add(r.url);
    }
    const proofKeys = proofUrls
      .filter((u) => !stillHeld.has(u))
      .map((u) => storedKeyFromUrl(u))
      .filter((k): k is string => !!k && storedKeyFolder(k) === PROOF_FOLDER);

    await t
      .update(tasks)
      .set({ reason: ERASED_NAME, payload: null })
      .where(inArray(tasks.contactId, ids));
    await t
      .update(tasks)
      .set({ status: "dismissed", completedAt: now, completedById: actor.id })
      .where(and(inArray(tasks.contactId, ids), eq(tasks.status, "open")));
    await t.delete(notifications).where(inArray(notifications.contactId, ids));
    // reasons typed for owner changes (shown on /activity); the two the dashboard tells apart are fixed texts and stay
    await t
      .update(ownershipLog)
      .set({ reason: ERASED_REASON })
      .where(
        and(
          inArray(ownershipLog.contactId, ids),
          ne(ownershipLog.reason, HANDOVER_REASON),
          notLike(ownershipLog.reason, `${IMPORT_REASON_PREFIX}%`),
        ),
      );
    await t
      .update(importRows)
      .set({
        raw: {},
        mapped: null,
        cleaned: null,
        issues: [],
        // what an import undo would put back on the contact (its old and new values); the row ids it needs stay
        applied: sql`case when jsonb_typeof(${importRows.applied}) = 'object' then ${importRows.applied} - 'before' - 'after' else ${importRows.applied} end`,
      })
      .where(or(inArray(importRows.contactId, ids), inArray(importRows.matchContactId, ids)));
    await t.update(webhookEvents).set({ payload: {} }).where(inArray(webhookEvents.contactId, ids));
    await t
      .update(auditLog)
      .set({ oldValue: null, newValue: null })
      .where(and(eq(auditLog.tableName, "contacts"), inArray(auditLog.rowId, ids)));
    await t
      .update(contactMerges)
      .set({ winnerBefore: {}, reason: null })
      .where(or(inArray(contactMerges.winnerId, ids), inArray(contactMerges.loserId, ids)));
    await t
      .update(duplicateReviews)
      .set({ status: "dismissed", resolvedAt: now, resolvedById: actor.id })
      .where(and(eq(duplicateReviews.status, "open"), or(inArray(duplicateReviews.contactAId, ids), inArray(duplicateReviews.contactBId, ids))));

    await audit(
      {
        table: "contacts",
        rowId: c.id,
        action: "erase",
        field: "personal_data",
        oldValue: null,
        newValue: { reason: why, rows: ids.length, proofs: proofKeys.length },
        userId: actor.id,
      },
      t,
    );
    await recomputeContact(c.id, t);
    return { erasedIds: ids, proofKeys, contactId: c.id };
  });

  // The transaction was ours, so it has committed: the proofs are unreachable, now delete the files themselves.
  if (tx !== db) return { erasedIds: done.erasedIds, proofKeys: done.proofKeys, filesDeleted: 0, fileErrors: 0 };
  const files = await deleteErasedProofFiles(done.proofKeys, { contactId: done.contactId, userId: actor.id });
  return { erasedIds: done.erasedIds, proofKeys: done.proofKeys, filesDeleted: files.deleted, fileErrors: files.failed };
}

/**
 * Deletes the stored proof files of an erasure, AFTER the erasure committed (no row points at them, so nobody can
 * open them already). A file that cannot be deleted is written to the error log (Settings > Error log) and the rest
 * go on: the erasure stands either way. The log names the file by its folder and id only, never by its file name,
 * which can hold the person's name.
 */
export async function deleteErasedProofFiles(
  keys: string[],
  ctx: { contactId: string; userId: string | null },
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      if (await deleteStoredFile(key)) deleted += 1;
    } catch (e) {
      failed += 1;
      const shown = redactStoredKey(key);
      const hide = (text: string | null | undefined) => (text ? text.split(key).join(shown) : null);
      const err = e instanceof Error ? e : new Error(String(e));
      await recordAppError({
        kind: "server",
        message: `Could not delete a payment proof of an erased contact (${shown}). Nobody can open it any more; delete it from file storage by hand. ${hide(err.message) ?? ""}`.trim(),
        stack: hide(err.stack),
        path: `/contacts/${ctx.contactId}`,
        source: "erasure",
        userId: ctx.userId,
      });
    }
  }
  return { deleted, failed };
}

/**
 * Records or withdraws marketing consent in one tap (through the profile service, so the rights, consent date,
 * audit and recompute are the same as the Edit form).
 */
export async function setConsent(contactId: string, consent: boolean | null, actor: Actor, tx: Tx = db) {
  const c = await getLiveContact(contactId, tx);
  assertNotErased(c, "consent");
  return updateContactProfile(contactId, { consent }, actor, tx);
}
