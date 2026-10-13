import "server-only";
/**
 * Step 6: commit. Rows are processed in row order, in chunks, each chunk in one transaction (a savepoint per
 * row, so one bad row never stops the rest). For every row:
 * - captureEnquiry (channel "import", sourceRef "import:<batchId>:<row>", importBatchId, skipAlerts, owner from
 *   the file or the batch default) creates the contact or attaches the touch to the matched one;
 * - recordPurchase (source "import", verified, reference = order id) records the payment, when there is one;
 * - what changed is stored in import_rows.applied (created contact, or the matched contact's columns before and
 *   after, enquiry, purchase and payment ids) for review and for the one-click undo.
 * Calculated columns are recomputed once per transaction for every affected contact (and their referrers), not
 * per row. A chunk commits in short transactions (COMMIT_ROWS_PER_TRANSACTION rows); each one moves the cursor, so
 * a failure rolls back only that transaction and the next call starts again from its first row.
 */
import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db, type Database, type Tx } from "@/db";
import { contacts, importBatches, importRows, type Contact, type ImportRow } from "@/db/schema";
import { audit } from "@/lib/audit";
import { setOwner } from "@/lib/contacts/assignment";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactError } from "@/lib/contacts/errors";
import { lookupByEmail, lookupByPhone } from "@/lib/contacts/identity";
import { getContact, resolveSurvivor } from "@/lib/contacts/internal";
import { selectContacts } from "@/lib/contacts/rows";
import { updateContactProfile } from "@/lib/contacts/profile";
import { DuplicateReferenceError, isMoneyError } from "@/lib/money/errors";
import { recordPurchase } from "@/lib/money/purchases";
import type { MetricsContext } from "@/lib/metrics/compute";
import { loadMetricsContext, recomputeContacts } from "@/lib/metrics/recompute";
import { buildCohorts } from "@/lib/metrics/repeat";
import { withSettingsSnapshot } from "@/lib/settings";
import {
  addCounts,
  assertCanImport,
  bulkUpdateRows,
  ImportError,
  loadBatch,
  refreshCounts,
  setProgress,
  type Actor,
  type LoadedBatch,
} from "./internal";
import type { PhaseResult } from "./batches";
import type { AppliedRow, BatchCounts, StoredClean } from "./types";

/**
 * Contact columns an import row can change on an existing contact (captureEnquiry's enrichment, the owner when
 * the contact sat in the pool, and the alternates added here). Snapshotted before and after for the undo.
 */
export const SNAPSHOT_COLUMNS = [
  "name",
  "email",
  "altPhones",
  "altEmails",
  "city",
  "state",
  "country",
  "language",
  "ageBand",
  "industry",
  "designation",
  "companyName",
  "organisationId",
  "fieldSources",
  "consent",
  "consentAt",
  "tags",
  "referredById",
  "lastChannel",
  "lastCampaign",
  "ownerId",
  "ownerAssignedAt",
  "firstOwnerId",
] as const satisfies readonly (keyof Contact)[];

/** JSON form of a column value (dates as ISO strings). */
export function jsonValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined) return null;
  return v;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(jsonValue(a)) === JSON.stringify(jsonValue(b));
}

function snapshot(c: Contact): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SNAPSHOT_COLUMNS) out[k] = jsonValue(c[k]);
  return out;
}

/** Only the columns that changed: { before, after }. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of SNAPSHOT_COLUMNS) {
    if (sameValue(before[k], after[k])) continue;
    b[k] = before[k];
    a[k] = after[k];
  }
  return { before: b, after: a };
}

/** A message the admin can act on, for a row that could not be imported. */
function rowError(e: unknown): string {
  if (e instanceof ImportError || e instanceof ContactError || isMoneyError(e)) return e.message;
  console.error("[import] row failed", e);
  return "This row could not be imported (unexpected error).";
}

/**
 * Starts the commit: refuses while conflicts are undecided, then moves the batch to "committing".
 * Returns the number of rows that will be processed.
 */
export async function startCommit(batchId: string, actor: Actor): Promise<number> {
  assertCanImport(actor);
  return db.transaction(async (t) => {
    const b = await loadBatch(batchId, t, { lock: "wait" });
    if (!b) throw new ImportError("Import not found.");
    if (b.status === "committing") return b.countsT.toCommit ?? 0;
    if (b.status !== "matched") throw new ImportError("Finish the review before committing.");
    const counts = await refreshCounts(batchId, t);
    if (counts.unresolved) {
      throw new ImportError(
        `Decide the ${counts.unresolved.toLocaleString("en-IN")} conflict${counts.unresolved === 1 ? "" : "s"} first: treat as new, or merge.`,
      );
    }
    if (!counts.toCommit) throw new ImportError("Nothing to import: every row is skipped or invalid.");
    const reset: BatchCounts = { committed: 0, created: 0, updated: 0, purchases: 0, purchasesSkipped: 0, failed: 0 };
    await t
      .update(importBatches)
      .set({ status: "committing", counts: { ...counts, ...reset }, error: null })
      .where(eq(importBatches.id, batchId));
    await setProgress(batchId, { commitCursor: 0 }, t);
    await audit({ table: "import_batches", rowId: batchId, action: "import", field: "status", oldValue: "matched", newValue: "committing", userId: actor.id }, t);
    return counts.toCommit;
  });
}

type RowOutcome = {
  applied: AppliedRow;
  contactId: string | null;
  warnings: string[];
  /** contacts whose calculated columns must be recomputed */
  touched: string[];
  kind: "created" | "updated" | "failed";
  purchase: "recorded" | "skipped" | null;
};

/** The contact a "merge" row goes to: the matched contact, or the contact the earlier row of this file became. */
async function mergeTarget(
  batchId: string,
  row: ImportRow,
  clean: StoredClean,
  inChunk: Map<number, string>,
  t: Tx,
): Promise<Contact | null> {
  if (row.resolution !== "merge") return null;
  if (row.matchContactId) {
    const [c] = await selectContacts(eq(contacts.id, row.matchContactId), t, { limit: 1 });
    return resolveSurvivor(c, t);
  }
  const leaderRow = clean.match?.sameAsRow ?? clean.match?.conflictRow;
  if (!leaderRow) return null;
  // the earlier row may have been committed a moment ago in this same chunk (not written back yet)
  let leaderContact = inChunk.get(leaderRow) ?? null;
  if (!leaderContact) {
    const [l] = await t
      .select({ contactId: importRows.contactId })
      .from(importRows)
      .where(and(eq(importRows.batchId, batchId), eq(importRows.rowNumber, leaderRow)))
      .limit(1);
    leaderContact = l?.contactId ?? null;
  }
  if (!leaderContact) return null;
  const [c] = await selectContacts(eq(contacts.id, leaderContact), t, { limit: 1 });
  return resolveSurvivor(c, t);
}

/** Imports one row inside its own savepoint. Never throws: a failure is recorded on the row. */
async function commitRow(b: LoadedBatch, row: ImportRow, actor: Actor, inChunk: Map<number, string>, t: Tx): Promise<RowOutcome> {
  const clean = row.cleaned as StoredClean | null;
  if (!clean) {
    return { applied: { error: "The row was not cleaned" }, contactId: null, warnings: [], touched: [], kind: "failed", purchase: null };
  }
  try {
    return await (t as Database).transaction((s) => commitRowTx(b, row, clean, actor, inChunk, s));
  } catch (e) {
    return { applied: { error: rowError(e) }, contactId: null, warnings: [], touched: [], kind: "failed", purchase: null };
  }
}

async function commitRowTx(
  b: LoadedBatch,
  row: ImportRow,
  clean: StoredClean,
  actor: Actor,
  inChunk: Map<number, string>,
  s: Tx,
): Promise<RowOutcome> {
  const d = b.settings;
  const warnings: string[] = [];
  const target = await mergeTarget(b.id, row, clean, inChunk, s);

  // ---- 1. which number to capture with, and which existing contact it lands on (snapshotted for the undo)
  let phone = clean.phone;
  let existing: Contact | null = target;
  let attachPhone = false;
  if (target) {
    // the target's own main number needs no lookup: phone_e164 is unique and an exact match always wins
    if (clean.phone && clean.phone !== target.phoneE164) {
      const holder = await lookupByPhone(clean.phone, s);
      if (!holder) attachPhone = true;
      else if (holder.contact.id !== target.id) {
        phone = target.phoneE164;
        warnings.push(`${clean.phone} belongs to ${holder.contact.name}, so it was not added to ${target.name}`);
      }
    } else phone = target.phoneE164;
  } else if (!clean.phone) {
    const holder = clean.email ? await lookupByEmail(clean.email, s) : null;
    if (!holder) throw new ImportError("A new contact needs a phone number");
    existing = holder.contact;
    phone = holder.contact.phoneE164;
  }
  // capture finds the contact itself (phone, then email) and hands back how it was before the touch
  // (CaptureResult.before), so it is not read twice here; only a merge that first adds the row's number as an
  // alternate needs the state from before that change
  if (!phone) throw new ImportError("A new contact needs a phone number");
  let before = attachPhone && existing ? snapshot(await getContact(existing.id, s)) : null;

  // a conflict merged into a contact with another number: the number becomes its alternate, so capture finds it
  if (attachPhone && target && clean.phone) {
    await updateContactProfile(target.id, { altPhones: { add: [clean.phone] } }, actor, s);
  }

  // ---- 2. the touch
  const fallback = d.ownerFallback;
  const fallbackUser = fallback !== "pool" && fallback !== "round_robin" ? fallback : null;
  // the touch is dated by the payment, else the enquiry date column or the batch's records date (else today)
  const touchedAt = clean.purchase?.purchasedAt ?? clean.touchedAt ?? null;
  const receivedAt = touchedAt ? new Date(touchedAt) : undefined;
  const captured = await captureEnquiry(
    {
      phone,
      defaultCountry: d.defaultCountry,
      name: clean.name,
      email: clean.email,
      channel: "import",
      firstDoor: clean.firstDoor,
      campaign: clean.campaign,
      productInterest: clean.purchase?.productName ?? null,
      sourceRef: `import:${b.id}:${row.rowNumber}`,
      rawPayload: { importBatchId: b.id, row: row.rowNumber, source: b.source },
      receivedAt,
      createdById: actor.id,
      ownerId: clean.ownerId ?? fallbackUser,
      skipAssignment: !clean.ownerId && fallback === "pool",
      referrer: clean.referrer,
      profile: {
        city: clean.city,
        state: clean.state,
        country: clean.country,
        language: clean.language,
        ageBand: clean.ageBand,
        industry: clean.industry,
        designation: clean.designation,
        companyName: clean.companyName,
        ...(clean.consent === null ? {} : { consent: clean.consent }),
      },
      tags: clean.tags,
      notes: clean.notes,
      importBatchId: b.id,
      skipAlerts: true,
      skipRecompute: true,
    },
    s,
  );
  const contactId = captured.contact.id;
  if (captured.duplicateEnquiry) throw new ImportError("This row was already imported");
  if (!before && captured.before) {
    existing ??= captured.before;
    if (captured.before.id === existing.id) before = snapshot(captured.before);
  }

  // ---- 2b. the owner named in the file carries over onto a contact that already had one (Zoho), when asked
  let contactNow = captured.contact;
  let changedAfterCapture = false;
  if (d.ownerFromFile && clean.ownerId && !captured.created && contactNow.ownerId !== clean.ownerId) {
    const label = b.source === "zoho" ? "Zoho" : "the file";
    const res = await setOwner(contactId, clean.ownerId, { reason: `Import: owner in ${label}`, changedById: actor.id }, s);
    if (res.changed) {
      changedAfterCapture = true;
      contactNow = await getContact(contactId, s);
    }
  }

  // ---- 3. the row's other numbers and emails become alternates (a number held by someone else is left out)
  const addPhones: string[] = [];
  for (const p of clean.altPhones) {
    if (p === contactNow.phoneE164 || contactNow.altPhones.includes(p)) continue;
    const holder = await lookupByPhone(p, s);
    if (holder && holder.contact.id !== contactId) warnings.push(`${p} belongs to ${holder.contact.name}, so it was not added`);
    else if (!holder) addPhones.push(p);
  }
  const knownEmails = new Set([contactNow.email?.toLowerCase(), ...contactNow.altEmails]);
  const addEmails = clean.altEmails.filter((e) => !knownEmails.has(e));
  if (addPhones.length || addEmails.length) {
    await updateContactProfile(
      contactId,
      { ...(addPhones.length ? { altPhones: { add: addPhones } } : {}), ...(addEmails.length ? { altEmails: { add: addEmails } } : {}) },
      actor,
      s,
    );
    changedAfterCapture = true;
  }

  // ---- 4. the payment
  const applied: AppliedRow = {
    contactId,
    createdContact: captured.created,
    enquiryId: captured.enquiryId,
    referrerId: captured.referrerId,
    referrerCreated: captured.referrerCreated,
  };
  let purchase: RowOutcome["purchase"] = null;
  const p = clean.purchase;
  if (p && clean.match?.duplicatePurchase) {
    // the same payment without an order id is already in the CRM or on an earlier row: never counted twice
    applied.purchaseSkipped = clean.match.duplicatePurchase;
    purchase = "skipped";
  } else if (p && p.family && p.purchasedAt) {
    try {
      const res = await recordPurchase(
        {
          contactId,
          productId: p.productId,
          productName: p.productName,
          family: p.family,
          amount: p.amount,
          currency: p.currency,
          purchasedAt: new Date(p.purchasedAt),
          mode: p.paymentMode,
          reference: p.orderId,
          source: "import",
          verified: d.source === "tagmango" ? true : d.verified,
          campaign: clean.campaign,
          importBatchId: b.id,
          rawPayload: { importBatchId: b.id, row: row.rowNumber },
          skipRecompute: true,
        },
        null,
        s,
      );
      applied.purchaseId = res.purchaseId;
      applied.paymentIds = res.paymentIds;
      purchase = "recorded";
    } catch (e) {
      // the order is already in the CRM (a re-import, or the webhook got there first): never counted twice
      if (!(e instanceof DuplicateReferenceError)) throw e;
      applied.purchaseSkipped = e.message;
      purchase = "skipped";
    }
  }

  // ---- 5. what changed on an existing contact
  if (!captured.created) {
    if (before && existing?.id === contactId) {
      // a purchase never changes these columns (recompute runs once per chunk), so capture's copy is current
      const after = changedAfterCapture ? await getContact(contactId, s) : contactNow;
      const changed = diff(before, snapshot(after));
      applied.before = changed.before;
      applied.after = changed.after;
    } else {
      warnings.push("This row was attached to a contact found while committing; its profile changes are not undone automatically");
    }
  }
  const touched = [contactId];
  if (captured.referrerId) touched.push(captured.referrerId);
  return { applied, contactId, warnings, touched, kind: captured.created ? "created" : "updated", purchase };
}

/**
 * Rows per database transaction inside a chunk. Every row runs in a savepoint and the services it calls open a few
 * more; past 64 subtransactions in one transaction Postgres overflows its subtransaction cache and every
 * visibility check slows down (a 500-row transaction ran about half as fast). So a chunk commits in short
 * transactions of this many rows, each with its own recompute and progress cursor: still resumable at any point.
 */
export const COMMIT_ROWS_PER_TRANSACTION = 15;

/**
 * Step 6, one chunk: imports up to `limit` rows (stopping early after `timeBudgetMs`) in short transactions of
 * COMMIT_ROWS_PER_TRANSACTION rows, recomputes the contacts each one touched, and records the progress. The last
 * call marks the batch committed, stores the unique-contact count and rebuilds the repeat-purchase cohorts.
 */
export async function runCommitChunk(
  batchId: string,
  actor: Actor,
  opts: { limit?: number; timeBudgetMs?: number } = {},
): Promise<PhaseResult> {
  assertCanImport(actor);
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const deadline = Date.now() + (opts.timeBudgetMs ?? 20_000);
  // settings (lists, thresholds, currency, teams...) and the scoring context are read once per chunk, not per row
  return withSettingsSnapshot(async () => {
    let ctx: MetricsContext | null = null;
    let processed = 0;
    for (;;) {
      const step = await commitStep(batchId, actor, Math.min(COMMIT_ROWS_PER_TRANSACTION, limit - processed), deadline, async (t) => {
        ctx ??= await loadMetricsContext(t);
        return ctx;
      });
      processed += step.processed;
      if (step.finished || step.busy || !step.processed || processed >= limit || Date.now() > deadline) {
        return { ...step, processed };
      }
    }
  });
}

/** One short transaction of the commit: up to `limit` rows from the cursor (or the finish when none are left). */
async function commitStep(
  batchId: string,
  actor: Actor,
  limit: number,
  deadline: number,
  metricsContext: (t: Tx) => Promise<MetricsContext>,
): Promise<PhaseResult> {
  return db.transaction(async (t) => {
    const b = await loadBatch(batchId, t, { lock: "skip" });
    if (!b) return { processed: 0, done: 0, total: 0, finished: false, busy: true };
    const total = b.countsT.toCommit ?? 0;
    if (b.status === "committed") return { processed: 0, done: total, total, finished: true };
    if (b.status !== "committing") throw new ImportError("Start the commit from the review step.");
    const cursor = b.settings.progress?.commitCursor ?? 0;
    const rows = await t
      .select()
      .from(importRows)
      .where(
        and(
          eq(importRows.batchId, batchId),
          gt(importRows.rowNumber, cursor),
          inArray(importRows.resolution, ["create", "merge"]),
        ),
      )
      .orderBy(asc(importRows.rowNumber))
      .limit(limit);
    if (!rows.length) {
      await finishCommit(b, actor, t);
      return { processed: 0, done: total, total, finished: true };
    }

    const patches: { id: string; contactId: string | null; applied: AppliedRow; issues: string[] }[] = [];
    const touched = new Set<string>();
    const add: BatchCounts = { committed: 0, created: 0, updated: 0, purchases: 0, purchasesSkipped: 0, failed: 0 };
    let last = cursor;
    const inChunk = new Map<number, string>();
    for (const row of rows) {
      if (patches.length && Date.now() > deadline) break;
      const o = await commitRow(b, row, actor, inChunk, t);
      if (o.contactId) inChunk.set(row.rowNumber, o.contactId);
      patches.push({
        id: row.id,
        contactId: o.contactId,
        applied: o.applied,
        issues: [
          ...new Set([
            ...(row.issues ?? []),
            ...(o.applied.error ? [o.applied.error] : []),
            ...o.warnings,
            ...(o.applied.purchaseSkipped ? [o.applied.purchaseSkipped] : []),
          ]),
        ],
      });
      for (const id of o.touched) touched.add(id);
      add.committed! += 1;
      if (o.kind === "created") add.created! += 1;
      else if (o.kind === "updated") add.updated! += 1;
      else add.failed! += 1;
      if (o.purchase === "recorded") add.purchases! += 1;
      if (o.purchase === "skipped") add.purchasesSkipped! += 1;
      last = row.rowNumber;
    }
    await bulkUpdateRows(batchId, patches, ["contactId", "applied", "issues"], t);

    // calculated columns: once per transaction for every touched contact and the people who referred them
    if (touched.size) {
      const ids = [...touched];
      const refs = await t
        .select({ referredById: contacts.referredById })
        .from(contacts)
        .where(and(inArray(contacts.id, ids), isNotNull(contacts.referredById)));
      for (const r of refs) if (r.referredById) touched.add(r.referredById);
      const ctx = await metricsContext(t);
      const all = [...touched];
      for (let i = 0; i < all.length; i += 500) await recomputeContacts(all.slice(i, i + 500), t, { ctx });
    }
    await setProgress(batchId, { commitCursor: last }, t);
    await addCounts(batchId, add, t);
    return { processed: patches.length, done: (b.countsT.committed ?? 0) + patches.length, total, finished: false };
  });
}

async function finishCommit(b: LoadedBatch, actor: Actor, t: Tx): Promise<void> {
  const [u] = await t
    .select({ n: sql<number>`count(distinct ${importRows.contactId})::int` })
    .from(importRows)
    .where(and(eq(importRows.batchId, b.id), isNotNull(importRows.contactId)));
  const [fresh] = await t.select({ counts: importBatches.counts }).from(importBatches).where(eq(importBatches.id, b.id));
  const counts = { ...(fresh.counts as BatchCounts), uniqueContacts: u?.n ?? 0 };
  await t
    .update(importBatches)
    .set({ status: "committed", committedAt: new Date(), counts })
    .where(eq(importBatches.id, b.id));
  await audit({ table: "import_batches", rowId: b.id, action: "import", field: "status", oldValue: "committing", newValue: counts, userId: actor.id }, t);
  // the repeat-purchase cohorts are rebuilt from Edapt's own history, which the import just brought in
  await buildCohorts(t);
}
