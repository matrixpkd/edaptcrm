import "server-only";
import { and, eq, inArray, ne, notLike, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  auditLog,
  contactMerges,
  contacts,
  duplicateReviews,
  enquiries,
  interactions,
  notifications,
  ownershipLog,
  payments,
  purchases,
  ratings,
  tasks,
  webhookEvents,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { scrubErasedPersonFromImports } from "@/lib/import/erasure";
import { recomputeContact } from "@/lib/metrics/recompute";
import { newAdvocateReason } from "@/lib/money/rules";
import { PROOF_FOLDER, deleteStoredFilesOrLog, storedKeyFolder, storedKeyFromUrl } from "@/lib/storage";
import { HANDOVER_REASON } from "./assignment";
import { ContactForbiddenError, ContactValidationError, assertNotErased } from "./errors";
import { getLiveContact, withTx, type Actor } from "./internal";
import { updateContactProfile } from "./profile";
import { referredAlertBody } from "./rules";

/**
 * Data-privacy actions (DPDP in India, PDPL in the UAE; spec "Data hygiene"; docs/CRM_GAP_ANALYSIS.md).
 *
 * eraseContact: when a person asks to be forgotten, an admin erases their personal data. The contact row stays,
 * anonymised, because purchases and payments must be kept for accounting and LTV/revenue history must not shift:
 *   - contact: name "Erased contact", phone replaced by a placeholder no real number can match, email, alternates,
 *     city/state, designation, company, sales notes, tags and consent cleared; erased_at / erased_by_id set;
 *   - every free text that can hold personal data: interaction summaries, enquiry notes and raw payloads, rating
 *     notes, webhook payloads, task reasons and payloads, the reasons typed for its owner changes and merges;
 *   - its import rows (src/lib/import/erasure.ts): the rows it imported from or matched, and the rows linked to
 *     nobody that carry its number, email or order id (a row skipped because the order was already recorded on it,
 *     an invalid or failed row), are wiped (with their issues and the before/after values an import undo would put
 *     back; the ids an undo needs stay);
 *   - money rows keep what the accounts need (reference = TagMango order id / UTR, amounts, currency, fx, dates,
 *     product, status, credited user) and lose their free text: purchase notes and raw payloads, payment and refund
 *     reasons (rejection notes), the same reasons in their audit trail, and their payment proofs (below);
 *   - old values in the audit log for this contact, and the "before" snapshots of its merges (so a merge involving
 *     it can no longer be undone);
 *   - its alerts in the bell are deleted; open tasks are closed (closeErasedContactAlerts); open duplicate reviews
 *     are dismissed;
 *   - what other contacts' rows quote of it, which stay without the quote:
 *     - its referrer's "call to thank" task (without its name) and the referrer's "New lead" alert ("Referred
 *       <name>", without that line);
 *     - other contacts' import rows (src/lib/import/erasure.ts): issues with its number or name ("<number> belongs
 *       to <name>, so it was not added", "... already recorded on <name>"), its entry in a conflict's candidates,
 *       and the referrer columns of a row that named it as the referrer; the rows stay, so their undo still works;
 *     - a merge into another contact that was undone: the merge entry in that contact's history ("Merged <name>
 *       into this contact", with its number) keeps only its id, and that contact's own history of numbers and
 *       emails (audit values of phoneE164, email, altPhones, altEmails) loses its numbers and emails, which a touch or
 *       an edit could record there while the two were merged. Names stay there: a mistaken merge is usually of
 *       namesakes, and the other contact's own name must stay. When it was the winner of an undone merge, that
 *       merge's entry is in its own history, cleared with the rest.
 *     Owner changes, referrer changes, transfer requests and duplicate reviews name no one: they hold ids or fixed
 *     texts.
 * Contact rows merged INTO it are erased the same way. The erasure itself is audited (who, when, the reason) without
 * any personal data. Erased contacts leave every contacts list and search (contactScope), an organisation's people
 * (getOrganisationPeople), and every alert rule, the Today queue and the digests (src/lib/alerts/rules.ts).
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
 * Closes an erased contact's alerts: its tasks lose their reason and payload (free text), the open ones are
 * dismissed, and its alerts in the bell are deleted. The erasure runs it, and so do the alert rules for what they
 * raised while the contact's erasure was committing (src/lib/alerts/rules.ts). `closedById` is null for the rules.
 */
export async function closeErasedContactAlerts(ids: string[], closedById: string | null, now: Date, tx: Tx = db): Promise<void> {
  if (!ids.length) return;
  await tx.update(tasks).set({ reason: ERASED_NAME, payload: null }).where(inArray(tasks.contactId, ids));
  await tx
    .update(tasks)
    .set({ status: "dismissed", completedAt: now, completedById: closedById })
    .where(and(inArray(tasks.contactId, ids), eq(tasks.status, "open")));
  await tx.delete(notifications).where(inArray(notifications.contactId, ids));
}

/** Audit fields that hold a contact's numbers and emails (the column names auditDiff writes). */
const IDENTITY_FIELDS = ["phoneE164", "email", "altPhones", "altEmails"];

/**
 * Contacts the person was merged into by a merge since undone: another person now (a merge still in place made the
 * winner part of the erasure). Their history quotes the person: the merge entry ("Merged <name> into this contact",
 * with the number) keeps only the id, and their own entries of numbers and emails, which a touch through the
 * person's number or an edit could record while the two were merged, lose the person's. Names stay (see the file
 * comment). Found through contact_merges and the audit log's (table, row) index.
 */
async function scrubMergeWinnersHistory(ids: string[], person: { phones: Set<string>; emails: Set<string> }, t: Tx): Promise<void> {
  const merges = await t.selectDistinct({ winnerId: contactMerges.winnerId }).from(contactMerges).where(inArray(contactMerges.loserId, ids));
  const winners = merges.map((m) => m.winnerId).filter((id) => !ids.includes(id));
  if (!winners.length) return;
  await t
    .update(auditLog)
    .set({ oldValue: sql`${auditLog.oldValue} - 'loserName' - 'loserPhone'` })
    .where(
      and(
        eq(auditLog.tableName, "contacts"),
        inArray(auditLog.rowId, winners),
        eq(auditLog.action, "merge"),
        inArray(sql`${auditLog.oldValue} ->> 'loserId'`, ids),
      ),
    );
  if (!person.phones.size && !person.emails.size) return;
  const theirs = (v: unknown) => typeof v === "string" && (person.phones.has(v) || person.emails.has(v.toLowerCase()));
  const clean = (v: unknown): unknown => (theirs(v) ? null : Array.isArray(v) ? v.filter((x) => !theirs(x)) : v);
  const rows = await t
    .select({ id: auditLog.id, oldValue: auditLog.oldValue, newValue: auditLog.newValue })
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "contacts"), inArray(auditLog.rowId, winners), inArray(auditLog.field, IDENTITY_FIELDS)));
  for (const r of rows) {
    const oldValue = clean(r.oldValue);
    const newValue = clean(r.newValue);
    if (JSON.stringify([oldValue, newValue]) === JSON.stringify([r.oldValue, r.newValue])) continue;
    await t.update(auditLog).set({ oldValue, newValue }).where(eq(auditLog.id, r.id));
  }
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

    // every name the person went by (now, and before each rename in the edit history), for the rows that quote it
    const names = new Set((await t.select({ name: contacts.name }).from(contacts).where(inArray(contacts.id, ids))).map((r) => r.name));
    const renames = await t
      .select({ oldValue: auditLog.oldValue, newValue: auditLog.newValue })
      .from(auditLog)
      .where(and(eq(auditLog.tableName, "contacts"), inArray(auditLog.rowId, ids), eq(auditLog.field, "name")));
    for (const r of renames) for (const v of [r.oldValue, r.newValue]) if (typeof v === "string" && v) names.add(v);
    // and its numbers and emails, for the rows that carry them without being linked to it (import rows)
    const phones = new Set<string>();
    const emails = new Set<string>();
    for (const r of await t
      .select({ phone: contacts.phoneE164, altPhones: contacts.altPhones, email: contacts.email, altEmails: contacts.altEmails })
      .from(contacts)
      .where(inArray(contacts.id, ids))) {
      for (const p of [r.phone, ...(r.altPhones ?? [])]) if (p && !isErasedPhone(p)) phones.add(p);
      for (const e of [r.email, ...(r.altEmails ?? [])]) if (e) emails.add(e.toLowerCase());
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
    const buys = await t
      .select({ id: purchases.id, proofUrl: purchases.proofUrl, reference: purchases.reference })
      .from(purchases)
      .where(inArray(purchases.contactId, ids));
    const buyIds = buys.map((b) => b.id);
    // a payment carries its contact too (kept in sync on merge): look both ways so none of these purchases' is missed
    const payWhere = buyIds.length ? or(inArray(payments.contactId, ids), inArray(payments.purchaseId, buyIds))! : inArray(payments.contactId, ids);
    const pays = await t.select({ id: payments.id, proofUrl: payments.proofUrl, reference: payments.reference }).from(payments).where(payWhere);
    const payIds = pays.map((p) => p.id);
    // the references stay (the accounts need them); they find the import rows of its orders that name no contact
    const references = [...new Set([...buys, ...pays].map((r) => r.reference).filter((x): x is string => !!x))];
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

    // the referrer's "call to thank" task names the person (src/lib/money/internal.ts onVerifiedMoney): it stays with
    // the referrer, without the name. Done before the contact's own tasks, so a referrer erased too ends as those do.
    await t
      .update(tasks)
      .set({ reason: newAdvocateReason(null), payload: sql`${tasks.payload} - 'referredName'` })
      .where(and(eq(tasks.type, "new_advocate"), inArray(sql`${tasks.payload} ->> 'referredContactId'`, ids)));
    await closeErasedContactAlerts(ids, actor.id, now, t);
    // the "New lead" alert of a referrer this person brought in quotes them ("Referred <name>"): the line goes.
    // Matched on the text, so a namesake's identical line goes too, which only shortens that alert.
    await t
      .update(notifications)
      .set({ body: null })
      .where(and(eq(notifications.type, "new_lead"), inArray(notifications.body, [...names].map(referredAlertBody))));
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
    await scrubErasedPersonFromImports({ ids, names: [...names], phones: [...phones], emails: [...emails], references }, t);
    await t.update(webhookEvents).set({ payload: {} }).where(inArray(webhookEvents.contactId, ids));
    await t
      .update(auditLog)
      .set({ oldValue: null, newValue: null })
      .where(and(eq(auditLog.tableName, "contacts"), inArray(auditLog.rowId, ids)));
    await t
      .update(contactMerges)
      .set({ winnerBefore: {}, reason: null })
      .where(or(inArray(contactMerges.winnerId, ids), inArray(contactMerges.loserId, ids)));
    await scrubMergeWinnersHistory(ids, { phones, emails }, t);
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
  return deleteStoredFilesOrLog(keys, {
    what: "a payment proof of an erased contact",
    path: `/contacts/${ctx.contactId}`,
    source: "erasure",
    userId: ctx.userId,
  });
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
