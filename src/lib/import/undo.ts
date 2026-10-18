import "server-only";
/**
 * One-click undo of a committed import (spec: "Each import is a batch that can be undone in one click").
 * Rows are undone newest first, in chunks, each chunk in one transaction:
 * - the purchases (with their payments) and enquiries the import created are deleted;
 * - on contacts that already existed, every column the import changed returns to its previous value (unless
 *   someone changed it again since: that later edit is kept), alternates and tags lose only what it added, and
 *   an owner it set goes back to the pool;
 * - contacts the import created are deleted, except those with activity since (a logged interaction, another
 *   enquiry or purchase, a sales rating, a merge, someone they referred, an edit by a person): those are kept and
 *   reported on the row;
 * - affected contacts are recomputed; the batch ends "undone", with audit entries throughout.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, queryRows, type Tx } from "@/db";
import {
  contactMerges,
  contacts,
  enquiries,
  importBatches,
  importRows,
  interactions,
  payments,
  purchases,
  ratings,
  type Contact,
  type FieldSource,
} from "@/db/schema";
import { audit, auditDiff } from "@/lib/audit";
import { setOwner } from "@/lib/contacts/assignment";
import { addUnique, removeAdded } from "@/lib/contacts/rules";
import { loadMetricsContext, recomputeContacts } from "@/lib/metrics/recompute";
import { buildCohorts } from "@/lib/metrics/repeat";
import { sameValue } from "./commit";
import {
  addCounts,
  assertCanImport,
  bulkUpdateRows,
  ImportError,
  loadBatch,
  setProgress,
  textArray,
  uuidArray,
  type Actor,
  type LoadedBatch,
} from "./internal";
import type { PhaseResult } from "./batches";
import type { AppliedRow, BatchCounts } from "./types";

const ARRAY_COLUMNS = new Set(["altPhones", "altEmails", "tags"]);
const DATE_COLUMNS = new Set(["consentAt", "ownerAssignedAt"]);

/** Starts the undo of a committed import. Returns how many rows will be undone. */
export async function startUndo(batchId: string, actor: Actor): Promise<number> {
  assertCanImport(actor);
  return db.transaction(async (t) => {
    const b = await loadBatch(batchId, t, { lock: "wait" });
    if (!b) throw new ImportError("Import not found.");
    if (b.status === "undone") throw new ImportError("This import was already undone.");
    if (b.status !== "committed") throw new ImportError("Only a committed import can be undone.");
    const [{ n }] = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(importRows)
      .where(and(eq(importRows.batchId, batchId), isNotNull(importRows.applied)));
    if (!b.settings.progress?.undoStartedAt) {
      const [{ max }] = await t
        .select({ max: sql<number>`coalesce(max(${importRows.rowNumber}), 0)::int` })
        .from(importRows)
        .where(eq(importRows.batchId, batchId));
      await setProgress(batchId, { undoCursor: max + 1, undoStartedAt: new Date().toISOString(), undoById: actor.id }, t);
      await t
        .update(importBatches)
        .set({ counts: sql`${importBatches.counts} || ${JSON.stringify({ undone: 0, deletedContacts: 0, keptContacts: 0, revertedContacts: 0, deletedPurchases: 0, undoTotal: n })}::jsonb` })
        .where(eq(importBatches.id, batchId));
      await audit({ table: "import_batches", rowId: batchId, action: "undo", field: "status", oldValue: "committed", newValue: "undoing", userId: actor.id }, t);
    }
    return n;
  });
}

/**
 * Why a contact the import created must be kept: anything a person or another source did with it after the
 * import. Returns contact id -> reason, for the given ids.
 */
async function activitySince(ids: string[], b: LoadedBatch, t: Tx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const note = (rows: { id: string }[], reason: string) => {
    for (const r of rows) if (!out.has(r.id)) out.set(r.id, reason);
  };
  note(
    await t.selectDistinct({ id: interactions.contactId }).from(interactions).where(inArray(interactions.contactId, ids)),
    "a call, chat or note was logged",
  );
  note(
    await t
      .selectDistinct({ id: enquiries.contactId })
      .from(enquiries)
      .where(
        and(
          inArray(enquiries.contactId, ids),
          or(isNull(enquiries.sourceRef), sql`${enquiries.sourceRef} not like ${`import:${b.id}:%`}`),
        ),
      ),
    "another enquiry arrived",
  );
  note(
    await t
      .selectDistinct({ id: purchases.contactId })
      .from(purchases)
      .where(and(inArray(purchases.contactId, ids), sql`${purchases.importBatchId} is distinct from ${b.id}::uuid`)),
    "a purchase was recorded",
  );
  note(
    await t.selectDistinct({ id: ratings.contactId }).from(ratings).where(and(inArray(ratings.contactId, ids), eq(ratings.source, "sales"))),
    "a salesperson rated them",
  );
  // any merge, even an undone one, keeps its contact_merges row pointing at both records
  note(
    await t.selectDistinct({ id: contactMerges.winnerId }).from(contactMerges).where(inArray(contactMerges.winnerId, ids)),
    "another record was merged into them",
  );
  note(
    await t.selectDistinct({ id: contactMerges.loserId }).from(contactMerges).where(inArray(contactMerges.loserId, ids)),
    "they were merged into another contact",
  );
  note(
    await t.select({ id: contacts.id }).from(contacts).where(and(inArray(contacts.id, ids), isNotNull(contacts.mergedIntoId))),
    "they were merged into another contact",
  );
  note(
    await t
      .selectDistinct({ id: sql<string>`${contacts.referredById}` })
      .from(contacts)
      .where(and(inArray(contacts.referredById, ids), sql`${contacts.importBatchId} is distinct from ${b.id}::uuid`)),
    "they referred someone",
  );
  note(
    await queryRows<{ id: string }>(sql`
      select distinct r.contact_id as id from import_rows r join import_batches ib on ib.id = r.batch_id
      where r.contact_id = any(${uuidArray(ids)}) and r.batch_id <> ${b.id} and ib.status <> 'undone'
    `, t),
    "a later import added to them",
  );
  if (b.committedAt) {
    // edits by a person between the commit and the start of this undo (the undo's own audit rows come later)
    const until = b.settings.progress?.undoStartedAt ?? new Date().toISOString();
    note(
      await queryRows<{ id: string }>(sql`
        select distinct row_id::uuid as id from audit_log
        where table_name = 'contacts' and row_id = any(${textArray(ids)})
          and user_id is not null
          and changed_at > ${b.committedAt.toISOString()}::timestamptz and changed_at < ${until}::timestamptz
      `, t),
      "someone edited them",
    );
  }
  return out;
}

/** Puts back the columns an import row changed on an existing contact (see the file comment). */
async function revertContact(contactId: string, applied: AppliedRow, actor: Actor, t: Tx): Promise<boolean> {
  const before = applied.before ?? {};
  const after = applied.after ?? {};
  if (!Object.keys(before).length && !Object.keys(after).length) return false;
  const [c] = await t.select().from(contacts).where(eq(contacts.id, contactId)).for("update").limit(1);
  if (!c || c.mergedIntoId) return false;
  const current = c as unknown as Record<string, unknown>;
  const restore: Record<string, unknown> = {};

  // the owner first, through the ownership service (logged), when nobody changed it since
  const ownerUntouched = "ownerId" in before && sameValue(current.ownerId, after.ownerId);
  if (ownerUntouched) {
    try {
      await setOwner(contactId, (before.ownerId as string | null) ?? null, { reason: "Import undone", changedById: actor.id }, t);
    } catch {
      // the previous owner can no longer own contacts: the contact goes back to the pool instead
      await setOwner(contactId, null, { reason: "Import undone", changedById: actor.id }, t);
    }
  }
  for (const [col, prev] of Object.entries(before)) {
    if (col === "ownerId") continue;
    if ((col === "ownerAssignedAt" || col === "firstOwnerId") && !ownerUntouched) continue;
    if (ARRAY_COLUMNS.has(col)) {
      const b = (prev as string[] | null) ?? [];
      const a = (after[col] as string[] | null) ?? [];
      const kept = removeAdded((current[col] as string[]) ?? [], b, a);
      restore[col] = addUnique(kept, b.filter((v) => !a.includes(v)));
      continue;
    }
    if (col === "fieldSources") {
      const b = (prev ?? {}) as Record<string, FieldSource>;
      const a = (after[col] ?? {}) as Record<string, FieldSource>;
      const cur = { ...((current[col] ?? {}) as Record<string, FieldSource>) };
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (cur[k] !== a[k]) continue;
        if (b[k] === undefined) delete cur[k];
        else cur[k] = b[k];
      }
      restore[col] = cur;
      continue;
    }
    if (col === "ownerAssignedAt" || col === "firstOwnerId") {
      // setOwner stamped these; put back exactly what was there
      restore[col] = DATE_COLUMNS.has(col) && prev ? new Date(String(prev)) : prev;
      continue;
    }
    if (sameValue(current[col], after[col])) restore[col] = DATE_COLUMNS.has(col) && prev ? new Date(String(prev)) : prev;
  }
  const changed = Object.fromEntries(Object.entries(restore).filter(([k, v]) => !sameValue(current[k], v)));
  if (Object.keys(changed).length) {
    await t
      .update(contacts)
      .set({ ...(changed as Partial<Contact>), updatedAt: new Date() })
      .where(eq(contacts.id, contactId));
    await auditDiff("contacts", contactId, current, changed, actor.id, t);
  }
  return true;
}

/** Deletes the contacts the import created, keeping (and reporting) those with activity since. */
async function deleteCreatedContacts(
  ids: string[],
  b: LoadedBatch,
  actor: Actor,
  t: Tx,
): Promise<{ deleted: string[]; kept: Map<string, string>; referrers: string[] }> {
  if (!ids.length) return { deleted: [], kept: new Map(), referrers: [] };
  const kept = await activitySince(ids, b, t);
  const doomed = ids.filter((id) => !kept.has(id));
  const referrers: string[] = [];
  if (doomed.length) {
    const rows = await t
      .select({ id: contacts.id, name: contacts.name, phone: contacts.phoneE164, referredById: contacts.referredById })
      .from(contacts)
      .where(inArray(contacts.id, doomed));
    for (const r of rows) if (r.referredById && !doomed.includes(r.referredById)) referrers.push(r.referredById);
    // contacts that pointed at a deleted referrer (none outside this import, or it would have been kept)
    await t.update(contacts).set({ referredById: null }).where(and(inArray(contacts.referredById, doomed), notInArray(contacts.id, doomed)));
    await t.delete(contacts).where(inArray(contacts.id, doomed));
    await audit(
      rows.map((r) => ({
        table: "contacts",
        rowId: r.id,
        action: "delete",
        oldValue: { name: r.name, phone: r.phone, importBatchId: b.id },
        newValue: { reason: "Import undone" },
        userId: actor.id,
      })),
      t,
    );
  }
  return { deleted: doomed, kept, referrers };
}

/**
 * One chunk of the undo (newest rows first). The last call also removes contacts the import created that no
 * row points at (referrers created on the way), marks the batch undone and rebuilds the cohorts.
 */
export async function runUndoChunk(batchId: string, actor: Actor, opts: { limit?: number } = {}): Promise<PhaseResult> {
  assertCanImport(actor);
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  return db.transaction(async (t) => {
    const b = await loadBatch(batchId, t, { lock: "skip" });
    if (!b) return { processed: 0, done: 0, total: 0, finished: false, busy: true };
    const counts = b.countsT as BatchCounts & { undoTotal?: number };
    const total = counts.undoTotal ?? 0;
    if (b.status === "undone") return { processed: 0, done: total, total, finished: true };
    if (b.status !== "committed" || !b.settings.progress?.undoStartedAt) throw new ImportError("Start the undo first.");
    const cursor = b.settings.progress.undoCursor ?? Number.MAX_SAFE_INTEGER;
    const rows = await t
      .select({ id: importRows.id, rowNumber: importRows.rowNumber, applied: importRows.applied, contactId: importRows.contactId })
      .from(importRows)
      .where(and(eq(importRows.batchId, batchId), lt(importRows.rowNumber, cursor), isNotNull(importRows.applied)))
      .orderBy(desc(importRows.rowNumber))
      .limit(limit);

    const recompute = new Set<string>();
    const add: BatchCounts = { undone: 0, deletedContacts: 0, keptContacts: 0, revertedContacts: 0, deletedPurchases: 0 };

    if (!rows.length) {
      // contacts the import created that no row points at (referrers it created)
      const leftovers = await queryRows<{ id: string }>(sql`
        select c.id from contacts c
        where c.import_batch_id = ${batchId} and c.merged_into_id is null
          and not exists (select 1 from import_rows r where r.batch_id = ${batchId} and r.contact_id = c.id)
      `, t);
      const res = await deleteCreatedContacts(leftovers.map((l) => l.id), b, actor, t);
      add.deletedContacts = res.deleted.length;
      add.keptContacts = res.kept.size;
      for (const id of [...res.kept.keys(), ...res.referrers]) recompute.add(id);
      await recomputeAll(recompute, t);
      await addCounts(batchId, add, t);
      const now = new Date();
      await t.update(importBatches).set({ status: "undone", undoneAt: now, undoneById: actor.id }).where(eq(importBatches.id, batchId));
      const [fresh] = await t.select({ counts: importBatches.counts }).from(importBatches).where(eq(importBatches.id, batchId));
      await audit({ table: "import_batches", rowId: batchId, action: "undo", field: "status", oldValue: "committed", newValue: fresh.counts, userId: actor.id }, t);
      await buildCohorts(t);
      return { processed: 0, done: total, total, finished: true };
    }

    const patches: { id: string; applied: AppliedRow }[] = [];
    const created: { rowId: string; contactId: string }[] = [];
    for (const r of rows) {
      const applied = { ...((r.applied ?? {}) as AppliedRow) };
      if (applied.undone) continue;
      if (!applied.error && applied.contactId) {
        // the purchase and its payments, unless money was added to it by hand since
        if (applied.purchaseId) {
          const extra = await t
            .select({ id: payments.id })
            .from(payments)
            .where(and(eq(payments.purchaseId, applied.purchaseId), applied.paymentIds?.length ? notInArray(payments.id, applied.paymentIds) : undefined))
            .limit(1);
          if (extra.length) {
            applied.undoNote = "The purchase was kept: payments or refunds were added to it after the import";
          } else {
            const del = await t.delete(purchases).where(and(eq(purchases.id, applied.purchaseId), eq(purchases.importBatchId, batchId))).returning({ id: purchases.id });
            if (del.length) {
              add.deletedPurchases! += 1;
              await audit({ table: "purchases", rowId: applied.purchaseId, action: "delete", newValue: { reason: "Import undone", importBatchId: batchId }, userId: actor.id }, t);
            }
          }
        }
        if (applied.enquiryId) await t.delete(enquiries).where(eq(enquiries.id, applied.enquiryId));
        if (applied.createdContact) {
          created.push({ rowId: r.id, contactId: applied.contactId });
        } else {
          const [c] = await t
            .select({ referredById: contacts.referredById, importBatchId: contacts.importBatchId })
            .from(contacts)
            .where(eq(contacts.id, applied.contactId))
            .limit(1);
          // a later row of the file for a person an earlier row created: undone with that contact, not "put back"
          const ownContact = c?.importBatchId === batchId;
          if (ownContact) applied.withCreatedContact = true;
          if ((await revertContact(applied.contactId, applied, actor, t)) && !ownContact) add.revertedContacts! += 1;
          recompute.add(applied.contactId);
          for (const id of [c?.referredById, applied.before?.referredById, applied.after?.referredById]) if (typeof id === "string") recompute.add(id);
        }
        if (applied.referrerId) recompute.add(applied.referrerId);
      }
      applied.undone = true;
      patches.push({ id: r.id, applied });
      add.undone! += 1;
    }

    // contacts this chunk's rows created (rows are newest first, so later rows of the file are already undone)
    const createdIds = [...new Set(created.map((c) => c.contactId))];
    const res = await deleteCreatedContacts(createdIds, b, actor, t);
    add.deletedContacts = res.deleted.length;
    add.keptContacts = res.kept.size;
    for (const id of res.referrers) recompute.add(id);
    for (const c of created) {
      const reason = res.kept.get(c.contactId);
      if (reason) {
        recompute.add(c.contactId);
        const p = patches.find((x) => x.id === c.rowId);
        if (p) p.applied.undoNote = `The contact was kept: ${reason} after the import`;
      }
    }
    for (const id of res.deleted) recompute.delete(id);

    await bulkUpdateRows(batchId, patches, ["applied"], t);
    await recomputeAll(recompute, t);
    await setProgress(batchId, { undoCursor: rows[rows.length - 1].rowNumber }, t);
    await addCounts(batchId, add, t);
    return { processed: rows.length, done: (counts.undone ?? 0) + (add.undone ?? 0), total, finished: false };
  });
}

async function recomputeAll(ids: Set<string>, t: Tx): Promise<void> {
  const list = [...ids];
  if (!list.length) return;
  const live = await t.select({ id: contacts.id }).from(contacts).where(and(inArray(contacts.id, list), isNull(contacts.mergedIntoId)));
  if (!live.length) return;
  const ctx = await loadMetricsContext(t);
  const all = live.map((l) => l.id);
  for (let i = 0; i < all.length; i += 500) await recomputeContacts(all.slice(i, i + 500), t, { ctx });
}
