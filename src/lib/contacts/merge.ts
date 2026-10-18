import "server-only";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, queryRows, type Tx } from "@/db";
import { contactMerges, contacts, duplicateReviews, users, type Contact, type FieldSource } from "@/db/schema";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { recomputeContact } from "@/lib/metrics/recompute";
import { formatPhone } from "@/lib/phone";
import { ContactForbiddenError, ContactMergedError, ContactNotFoundError, ContactValidationError } from "./errors";
import { setOwner } from "./assignment";
import { withTx, wouldCreateReferralCycle, type Actor } from "./internal";
import { RATED_FIELDS, RATED_FIELD_KEYS, addUnique, earlierOf, isPhoneFallbackName, isUuid, laterOf, removeAdded } from "./rules";

/**
 * Merging two records of one person (spec "One person, one record", rule 4): the oldest First Door and the
 * first owner are kept, with every purchase, payment, enquiry, interaction, rating, task, notification and
 * ownership log row. Nothing is deleted (the loser row stays, marked merged_into_id), every merge is logged
 * in contact_merges with the exact rows moved and the winner's previous values, and any merge can be undone.
 */

/** Tables whose contact_id is re-pointed from the loser to the winner. */
const CHILD_TABLES = [
  "enquiries",
  "interactions",
  "ratings",
  "tasks",
  "notifications",
  "ownership_log",
  "purchases",
  "payments",
] as const;
/** Keys in contact_merges.moved for the non-child moves. */
const MOVED_REFERRALS = "contacts.referred_by_id";
const MOVED_REVIEWS = "duplicate_reviews";
/** Reserved key in contact_merges.winner_before holding the values the merge wrote (for a precise undo). */
const AFTER_KEY = "$after";

const ARRAY_COLUMNS = new Set(["altPhones", "altEmails", "tags"]);
const DATE_COLUMNS = new Set(["consentAt", "lastEnquiryAt", "lastInteractionAt", "lastActivityAt", "createdAt", "ownerAssignedAt"]);
/** Profile fields filled from the loser when empty on the winner. */
const FILL_EMPTY = ["organisationId", "city", "state", "country", "language", "designation", "companyName"] as const;

type Snapshot = Record<string, unknown>;

function assertCanMerge(actor: Actor) {
  if (!can(actor, "contacts.merge")) throw new ContactForbiddenError("Only a manager or admin can merge contacts");
}

/** JSON-comparable form of a column value (Dates as ISO strings). */
function norm(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined) return null;
  return v;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
function fromJson(col: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (DATE_COLUMNS.has(col)) return new Date(String(v));
  return v;
}

/**
 * Merges `loserId` into `winnerId`. Manager/admin only. Returns the contact_merges id.
 * Refuses to merge a contact into itself, into a merged row, or a row that is already merged.
 */
export async function mergeContacts(
  winnerId: string,
  loserId: string,
  actor: Actor,
  reason?: string | null,
  tx: Tx = db,
): Promise<string> {
  assertCanMerge(actor);
  if (!isUuid(winnerId) || !isUuid(loserId)) throw new ContactNotFoundError();
  if (winnerId === loserId) throw new ContactValidationError("A contact cannot be merged into itself");
  return withTx(tx, async (t) => {
    const locked = await t
      .select()
      .from(contacts)
      .where(inArray(contacts.id, [winnerId, loserId]))
      .orderBy(contacts.id)
      .for("update");
    const winner = locked.find((c) => c.id === winnerId);
    const loser = locked.find((c) => c.id === loserId);
    if (!winner || !loser) throw new ContactNotFoundError();
    if (winner.mergedIntoId) throw new ContactMergedError(winner.mergedIntoId);
    if (loser.mergedIntoId) throw new ContactMergedError(loser.mergedIntoId);
    const now = new Date();
    const older = loser.createdAt < winner.createdAt ? loser : winner;
    const newer = older === winner ? loser : winner;

    // ---- the winner's new values (only columns that change are written and remembered)
    const target: Snapshot = {};
    target.altPhones = addUnique(winner.altPhones, [loser.phoneE164, ...loser.altPhones], [winner.phoneE164]);
    const winnerEmail = winner.email ?? loser.email;
    target.email = winnerEmail;
    target.altEmails = addUnique(winner.altEmails, [loser.email?.toLowerCase(), ...loser.altEmails], [winnerEmail?.toLowerCase()]);
    // a winner known only by its number takes the loser's real name
    const fallback = (c: Contact) => isPhoneFallbackName(c.name, { e164: c.phoneE164, international: formatPhone(c.phoneE164) });
    if (fallback(winner) && !fallback(loser)) target.name = loser.name;
    target.firstDoor = older.firstDoor;
    // the first labels travel together: a newer record's campaign is not how this person first came in
    target.firstCampaign = older.firstCampaign;
    target.firstChannel = older.firstChannel;
    target.createdAt = earlierOf(winner.createdAt, loser.createdAt);
    for (const f of FILL_EMPTY) if (winner[f] === null && loser[f] !== null) target[f] = loser[f];
    // a country the winner only guessed from its phone number gives way to one the loser actually has
    const sources: Record<string, FieldSource> = { ...(winner.fieldSources ?? {}) };
    if (sources.country === "system" && loser.country !== null && loser.fieldSources?.country !== "system") {
      target.country = loser.country;
      delete sources.country;
    }
    if (winner.consent === null && loser.consent !== null) {
      target.consent = loser.consent;
      target.consentAt = loser.consentAt;
    }
    if (winner.salesNotes && loser.salesNotes && winner.salesNotes.trim() !== loser.salesNotes.trim()) {
      target.salesNotes = `${winner.salesNotes}\n\n${loser.salesNotes}`;
    } else if (!winner.salesNotes && loser.salesNotes) {
      target.salesNotes = loser.salesNotes;
    }
    target.tags = addUnique(winner.tags, loser.tags);
    // ratings: fill what is empty; a sales rating on the loser beats a self/import value on the winner
    for (const f of RATED_FIELD_KEYS) {
      const key = RATED_FIELDS[f].sourceKey;
      const lv = loser[f];
      if (lv === null) continue;
      const take = winner[f] === null || (loser.fieldSources?.[key] === "sales" && sources[key] !== "sales");
      if (!take) continue;
      target[f] = lv;
      const ls = loser.fieldSources?.[key];
      if (ls) sources[key] = ls;
      else delete sources[key];
    }
    target.fieldSources = sources;
    // activity markers: the most recent of both
    if (laterOf(winner.lastEnquiryAt, loser.lastEnquiryAt) !== winner.lastEnquiryAt) {
      target.lastEnquiryAt = loser.lastEnquiryAt;
      target.lastChannel = loser.lastChannel;
      target.lastCampaign = loser.lastCampaign ?? winner.lastCampaign;
    }
    target.lastInteractionAt = laterOf(winner.lastInteractionAt, loser.lastInteractionAt);
    target.lastActivityAt = laterOf(winner.lastActivityAt, loser.lastActivityAt);

    // ---- owner: the winner keeps its owner; a winner in the pool takes the loser's owner (if they can own)
    let ownerTaken = false;
    if (!winner.ownerId && loser.ownerId) {
      const o = await t.select({ active: users.active, role: users.role }).from(users).where(eq(users.id, loser.ownerId)).limit(1);
      if (o[0]?.active && o[0].role !== "support") {
        await setOwner(winnerId, loser.ownerId, { reason: "Merged: kept the owner of the merged record", changedById: actor.id, moveTasks: false }, t);
        ownerTaken = true;
      }
    }
    // the first owner of the older contact survives
    target.firstOwnerId = older.firstOwnerId ?? newer.firstOwnerId ?? (ownerTaken ? loser.ownerId : winner.firstOwnerId);

    // ---- re-point every child row, remembering exactly which rows moved
    const moved: Record<string, string[]> = {};
    for (const table of CHILD_TABLES) {
      const rows = await queryRows<{ id: string }>(
        sql`update ${sql.identifier(table)} set contact_id = ${winnerId} where contact_id = ${loserId} returning id`,
        t,
      );
      moved[table] = rows.map((r) => r.id);
    }
    const refRows = await queryRows<{ id: string }>(
      sql`update contacts set referred_by_id = ${winnerId}, updated_at = now()
          where referred_by_id = ${loserId} and id <> ${winnerId} and id <> ${loserId} returning id`,
      t,
    );
    moved[MOVED_REFERRALS] = refRows.map((r) => r.id);

    // ---- the winner's own referrer: never the loser (now itself), fill from the loser when empty
    let referrer = winner.referredById;
    if (referrer === loserId) referrer = null;
    // the loser's referrals now point at the winner: if the winner's own referrer is among them (directly or up
    // the chain) keeping it would make a referral loop, so the loser's (older) referral relationship wins
    if (referrer && (await wouldCreateReferralCycle(winnerId, referrer, t))) referrer = null;
    if (!referrer && loser.referredById && loser.referredById !== winnerId) {
      referrer = (await wouldCreateReferralCycle(winnerId, loser.referredById, t)) ? null : loser.referredById;
    }
    target.referredById = referrer;

    // ---- write the winner, remembering previous values of what changed
    const before: Snapshot = {};
    const after: Snapshot = {};
    const set: Snapshot = {};
    for (const [col, v] of Object.entries(target)) {
      const prev = (winner as unknown as Snapshot)[col];
      if (same(prev, v)) continue;
      before[col] = norm(prev);
      after[col] = norm(v);
      set[col] = v;
    }
    if (ownerTaken) {
      // the owner itself was written by setOwner above; remember it for the undo
      before.ownerId = winner.ownerId;
      before.ownerAssignedAt = norm(winner.ownerAssignedAt);
      after.ownerId = loser.ownerId;
    }
    if (Object.keys(set).length) {
      await t
        .update(contacts)
        .set({ ...(set as Partial<Contact>), updatedAt: now })
        .where(eq(contacts.id, winnerId));
    }
    await t.update(contacts).set({ mergedIntoId: winnerId, mergedAt: now, updatedAt: now }).where(eq(contacts.id, loserId));

    const reviews = await t
      .update(duplicateReviews)
      .set({ status: "merged", resolvedById: actor.id, resolvedAt: now })
      .where(and(eq(duplicateReviews.status, "open"), pairCondition(winnerId, loserId)))
      .returning({ id: duplicateReviews.id });
    moved[MOVED_REVIEWS] = reviews.map((r) => r.id);

    const [m] = await t
      .insert(contactMerges)
      .values({
        winnerId,
        loserId,
        moved,
        winnerBefore: { ...before, [AFTER_KEY]: after },
        reason: reason?.trim() || null,
        mergedById: actor.id,
        mergedAt: now,
      })
      .returning({ id: contactMerges.id });

    await audit(
      {
        table: "contacts",
        rowId: winnerId,
        action: "merge",
        field: "merged_from",
        oldValue: { loserId, loserName: loser.name, loserPhone: loser.phoneE164 },
        newValue: { mergeId: m.id, moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length])) },
        userId: actor.id,
      },
      t,
    );

    await recomputeContact(winnerId, t);
    for (const r of new Set([winner.referredById, loser.referredById, referrer])) {
      if (r && r !== winnerId && r !== loserId) await recomputeContact(r, t);
    }
    return m.id;
  });
}

function pairCondition(a: string, b: string) {
  return or(
    and(eq(duplicateReviews.contactAId, a), eq(duplicateReviews.contactBId, b)),
    and(eq(duplicateReviews.contactAId, b), eq(duplicateReviews.contactBId, a)),
  )!;
}

/**
 * Undoes a merge exactly: the recorded rows move back to the loser, the loser is live again, the duplicate
 * reviews it closed reopen, and every winner column the merge changed returns to its previous value
 * (a column edited by someone after the merge keeps that later edit; arrays lose only what the merge added).
 * Refuses when already undone, or when a later merge into the same winner is still active (undo that first).
 */
export async function undoMerge(mergeId: string, actor: Actor, tx: Tx = db): Promise<void> {
  assertCanMerge(actor);
  if (!isUuid(mergeId)) throw new ContactNotFoundError("Merge");
  return withTx(tx, async (t) => {
    const rows = await t.select().from(contactMerges).where(eq(contactMerges.id, mergeId)).limit(1).for("update");
    const m = rows[0];
    if (!m) throw new ContactNotFoundError("Merge");
    if (m.undoneAt) throw new ContactValidationError("This merge was already undone");
    const locked = await t
      .select()
      .from(contacts)
      .where(inArray(contacts.id, [m.winnerId, m.loserId]))
      .orderBy(contacts.id)
      .for("update");
    const winner = locked.find((c) => c.id === m.winnerId);
    const loser = locked.find((c) => c.id === m.loserId);
    if (!winner || !loser) throw new ContactNotFoundError();
    if (loser.mergedIntoId !== winner.id) throw new ContactValidationError("The merged record has changed since; this merge cannot be undone");
    if (winner.mergedIntoId) throw new ContactValidationError("The surviving contact was merged again; undo that merge first");
    // erasure on request wiped the snapshot this undo needs (src/lib/contacts/privacy.ts)
    if (winner.erasedAt || loser.erasedAt) throw new ContactValidationError("This contact's data was erased, so the merge cannot be undone");
    const later = await t
      .select({ id: contactMerges.id })
      .from(contactMerges)
      .where(and(eq(contactMerges.winnerId, winner.id), isNull(contactMerges.undoneAt), gt(contactMerges.mergedAt, m.mergedAt)))
      .limit(1);
    if (later.length) throw new ContactValidationError("A later merge into this contact must be undone first");

    const now = new Date();
    const moved = m.moved ?? {};
    // ---- rows back to the loser
    for (const table of CHILD_TABLES) {
      const ids = moved[table] ?? [];
      if (!ids.length) continue;
      await t.execute(
        sql`update ${sql.identifier(table)} set contact_id = ${loser.id}
            where contact_id = ${winner.id} and id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`,
      );
    }
    const refIds = moved[MOVED_REFERRALS] ?? [];
    if (refIds.length) {
      await t
        .update(contacts)
        .set({ referredById: loser.id, updatedAt: now })
        .where(and(eq(contacts.referredById, winner.id), inArray(contacts.id, refIds)));
    }
    const reviewIds = moved[MOVED_REVIEWS] ?? [];
    if (reviewIds.length) {
      await t
        .update(duplicateReviews)
        .set({ status: "open", resolvedById: null, resolvedAt: null })
        .where(and(inArray(duplicateReviews.id, reviewIds), eq(duplicateReviews.status, "merged")));
    }

    // ---- the winner's previous values
    const { [AFTER_KEY]: afterRaw, ...before } = (m.winnerBefore ?? {}) as Snapshot;
    const after = (afterRaw ?? {}) as Snapshot;
    const current = winner as unknown as Snapshot;
    if ("ownerId" in before && same(current.ownerId, after.ownerId)) {
      await setOwner(
        winner.id,
        (before.ownerId as string | null) ?? null,
        { reason: "Merge undone", changedById: actor.id, moveTasks: false },
        t,
      );
    }
    const restore: Snapshot = {};
    for (const [col, prev] of Object.entries(before)) {
      if (col === "ownerId") continue;
      if (col === "ownerAssignedAt") {
        if ("ownerId" in before && same(current.ownerId, after.ownerId)) restore.ownerAssignedAt = fromJson(col, prev);
        continue;
      }
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
          if (cur[k] !== a[k]) continue; // changed again since the merge: keep
          if (b[k] === undefined) delete cur[k];
          else cur[k] = b[k];
        }
        restore[col] = cur;
        continue;
      }
      if (same(current[col], after[col])) restore[col] = fromJson(col, prev);
    }
    if (Object.keys(restore).length) {
      await t
        .update(contacts)
        .set({ ...(restore as Partial<Contact>), updatedAt: now })
        .where(eq(contacts.id, winner.id));
    }
    await t.update(contacts).set({ mergedIntoId: null, mergedAt: null, updatedAt: now }).where(eq(contacts.id, loser.id));
    await t.update(contactMerges).set({ undoneAt: now, undoneById: actor.id }).where(eq(contactMerges.id, m.id));
    await audit(
      {
        table: "contacts",
        rowId: winner.id,
        action: "unmerge",
        field: "merged_from",
        oldValue: { mergeId: m.id },
        newValue: { loserId: loser.id },
        userId: actor.id,
      },
      t,
    );

    const fresh = await t.select().from(contacts).where(inArray(contacts.id, [winner.id, loser.id]));
    await recomputeContact(winner.id, t);
    await recomputeContact(loser.id, t);
    const referrers = new Set<string>();
    for (const c of fresh) if (c.referredById) referrers.add(c.referredById);
    if (winner.referredById) referrers.add(winner.referredById);
    for (const r of referrers) if (r !== winner.id && r !== loser.id) await recomputeContact(r, t);
  });
}

// ---------------------------------------------------------------------------
// Duplicate reviews
// ---------------------------------------------------------------------------

/** Manager/admin: "not the same person". The pair is never flagged again. */
export async function dismissDuplicateReview(reviewId: string, actor: Actor, tx: Tx = db): Promise<void> {
  assertCanMerge(actor);
  if (!isUuid(reviewId)) throw new ContactNotFoundError("Duplicate review");
  // the status change and its audit row are written together
  return withTx(tx, async (t) => {
    const rows = await t
      .update(duplicateReviews)
      .set({ status: "dismissed", resolvedById: actor.id, resolvedAt: new Date() })
      .where(and(eq(duplicateReviews.id, reviewId), eq(duplicateReviews.status, "open")))
      .returning({ id: duplicateReviews.id });
    if (!rows[0]) {
      const exists = await t.select({ id: duplicateReviews.id }).from(duplicateReviews).where(eq(duplicateReviews.id, reviewId)).limit(1);
      if (!exists[0]) throw new ContactNotFoundError("Duplicate review");
      throw new ContactValidationError("This review was already resolved");
    }
    await audit({ table: "duplicate_reviews", rowId: reviewId, action: "update", field: "status", oldValue: "open", newValue: "dismissed", userId: actor.id }, t);
  });
}

export type DuplicateReviewSide = {
  id: string;
  name: string;
  phoneE164: string;
  email: string | null;
  city: string | null;
  country: string | null;
  firstDoor: string;
  stage: Contact["stage"];
  grade: Contact["grade"];
  purchaseCount: number;
  ltvInr: number;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: Date;
};

export type OpenDuplicateReview = {
  id: string;
  reason: string;
  createdAt: Date;
  a: DuplicateReviewSide;
  b: DuplicateReviewSide;
};

/** Open duplicate reviews with both contacts' basic fields, newest first. Pairs with a merged side are hidden. */
export async function listOpenDuplicateReviews(tx: Tx = db, opts: { limit?: number } = {}): Promise<OpenDuplicateReview[]> {
  const ca = alias(contacts, "ca");
  const cb = alias(contacts, "cb");
  const ua = alias(users, "ua");
  const ub = alias(users, "ub");
  const side = (c: typeof ca | typeof cb, u: typeof ua | typeof ub) => ({
    id: c.id,
    name: c.name,
    phoneE164: c.phoneE164,
    email: c.email,
    city: c.city,
    country: c.country,
    firstDoor: c.firstDoor,
    stage: c.stage,
    grade: c.grade,
    purchaseCount: c.purchaseCount,
    ltvInr: c.ltvInr,
    ownerId: c.ownerId,
    ownerName: u.name,
    createdAt: c.createdAt,
  });
  const rows = await tx
    .select({
      id: duplicateReviews.id,
      reason: duplicateReviews.reason,
      createdAt: duplicateReviews.createdAt,
      a: side(ca, ua),
      b: side(cb, ub),
    })
    .from(duplicateReviews)
    .innerJoin(ca, eq(ca.id, duplicateReviews.contactAId))
    .innerJoin(cb, eq(cb.id, duplicateReviews.contactBId))
    .leftJoin(ua, eq(ua.id, ca.ownerId))
    .leftJoin(ub, eq(ub.id, cb.ownerId))
    .where(and(eq(duplicateReviews.status, "open"), isNull(ca.mergedIntoId), isNull(cb.mergedIntoId)))
    .orderBy(desc(duplicateReviews.createdAt))
    .limit(opts.limit ?? 200);
  return rows as OpenDuplicateReview[];
}

/** Merge history of a contact (as winner or loser), newest first. */
export async function mergeHistory(contactId: string, tx: Tx = db) {
  return tx
    .select()
    .from(contactMerges)
    .where(or(eq(contactMerges.winnerId, contactId), eq(contactMerges.loserId, contactId)))
    .orderBy(desc(contactMerges.mergedAt));
}
