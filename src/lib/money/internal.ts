import "server-only";
/**
 * Shared plumbing for the money services: transactions, permission checks, reference uniqueness,
 * and what happens after money moves (recompute, new advocate, abandoned-checkout recovery, alert cleanup).
 * Not part of the public API: import from ./purchases, ./credit or ./index instead.
 */
import { and, asc, eq, inArray, like, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { queryRows, type Database, type Tx } from "@/db";
import { contacts, enquiries, payments, purchases, tasks, type Contact, type Purchase, type TaskType } from "@/db/schema";
import { createTask } from "@/lib/alerts/core";
import { audit } from "@/lib/audit";
import { can, type Permission } from "@/lib/auth/permissions";
import { selectContacts } from "@/lib/contacts/rows";
import { recomputeContact } from "@/lib/metrics/recompute";
import { getSetting } from "@/lib/settings";
import { DAY_MS, isUuid } from "@/lib/utils";
import { DuplicateReferenceError, NotFoundError, PermissionError } from "./errors";
import { roundMoney, toInr } from "./fx";
import { checkoutResolution, CHECKOUT_ENQUIRY_STATUSES, inPurchaseCurrency, MONEY_EPSILON, type Actor } from "./rules";

/** Run `fn` in a transaction (a savepoint when `tx` is already a transaction). */
export function inTx<T>(tx: Tx, fn: (t: Tx) => Promise<T>): Promise<T> {
  return (tx as Database).transaction((t) => fn(t));
}

/** `null` is the system (webhooks, imports, cron) and is always allowed. */
export function assertCan(actor: Actor | null, permission: Permission, message?: string): void {
  if (actor !== null && !can(actor, permission)) throw new PermissionError(permission, message);
}

/** A person must be acting (no system calls) and must hold the permission. */
export function assertActorCan(actor: Actor | null | undefined, permission: Permission, message?: string): asserts actor is Actor {
  if (!actor || !can(actor, permission)) throw new PermissionError(permission, message);
}

/** Follows merged_into_id to the surviving contact. */
export async function resolveContact(contactId: string, t: Tx): Promise<Contact | null> {
  // a malformed id from a form or URL is simply "not found", never a raw database error
  if (!isUuid(contactId)) return null;
  let id: string | null = contactId;
  for (let hop = 0; id && hop < 10; hop++) {
    const [c]: Contact[] = await selectContacts(eq(contacts.id, id), t, { limit: 1 });
    if (!c) return null;
    if (!c.mergedIntoId) return c;
    id = c.mergedIntoId;
  }
  return null;
}

/** Load and lock a purchase row for the rest of the transaction (serialises concurrent payments/refunds). */
export async function lockPurchase(purchaseId: string, t: Tx) {
  if (!isUuid(purchaseId)) throw new NotFoundError("Purchase");
  const [p] = await t.select().from(purchases).where(eq(purchases.id, purchaseId)).for("update").limit(1);
  if (!p) throw new NotFoundError("Purchase");
  return p;
}

export async function loadPayment(paymentId: string, t: Tx) {
  if (!isUuid(paymentId)) throw new NotFoundError("Payment");
  const [p] = await t.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p) throw new NotFoundError("Payment");
  return p;
}

export async function paymentMoneyRows(purchaseId: string, t: Tx) {
  return t
    .select({
      id: payments.id,
      kind: payments.kind,
      status: payments.status,
      amount: payments.amount,
      currency: payments.currency,
      amountInr: payments.amountInr,
      seq: payments.seq,
      dueAt: payments.dueAt,
    })
    .from(payments)
    .where(eq(payments.purchaseId, purchaseId))
    .orderBy(asc(payments.seq), asc(payments.createdAt));
}

// ---------------------------------------------------------------------------
// Reference uniqueness
// ---------------------------------------------------------------------------

type RefHolder = { contactId: string; contactName: string; existingIn: "purchase" | "payment" };

/**
 * Who already holds this reference? A reference is one money movement, so it is unique across purchases and
 * payments together — except that a purchase and its own payments may share it (a TagMango order id or the
 * UTR of a one-off payment). `ownPurchaseId` is the purchase the new row belongs to; `excludePaymentId` is the
 * payment row being updated.
 */
export async function findReferenceHolder(
  reference: string,
  t: Tx,
  opts: { ownPurchaseId?: string | null; excludePaymentId?: string | null } = {},
): Promise<RefHolder | null> {
  const pWhere = [eq(purchases.reference, reference)];
  if (opts.ownPurchaseId) pWhere.push(ne(purchases.id, opts.ownPurchaseId));
  const [p] = await t
    .select({ contactId: contacts.id, contactName: contacts.name })
    .from(purchases)
    .innerJoin(contacts, eq(contacts.id, purchases.contactId))
    .where(and(...pWhere))
    .limit(1);
  if (p) return { ...p, existingIn: "purchase" };
  const payWhere = [eq(payments.reference, reference)];
  if (opts.excludePaymentId) payWhere.push(ne(payments.id, opts.excludePaymentId));
  const [pay] = await t
    .select({ contactId: contacts.id, contactName: contacts.name })
    .from(payments)
    .innerJoin(contacts, eq(contacts.id, payments.contactId))
    .where(and(...payWhere))
    .limit(1);
  return pay ? { ...pay, existingIn: "payment" } : null;
}

export async function assertReferenceFree(
  reference: string | null,
  label: string,
  t: Tx,
  opts: { ownPurchaseId?: string | null; excludePaymentId?: string | null; actorId?: string | null } = {},
): Promise<void> {
  if (!reference) return;
  // the usual case, a reference nobody holds: one look at both unique indexes instead of four queries
  if (!(await referenceInUse(reference, t))) return;
  await releaseCancelledReference(reference, t, opts.actorId ?? null);
  const holder = await findReferenceHolder(reference, t, opts);
  if (holder) throw new DuplicateReferenceError({ reference, label, ...holder });
}

/** True when any purchase or payment (live or cancelled) carries this reference. */
async function referenceInUse(reference: string, t: Tx): Promise<boolean> {
  const [r] = await queryRows<{ used: number | string }>(sql`
    select (exists (select 1 from purchases where reference = ${reference})
        or exists (select 1 from payments where reference = ${reference}))::int as used
  `, t);
  return Number(r?.used) === 1;
}

/**
 * A cancelled purchase never counts and can never be revived, so it must not keep a reference (UTR / TagMango
 * order id) that belongs on another contact or purchase — the usual reason to cancel is "recorded on the wrong
 * contact". When `reference` is held by a cancelled purchase or by a payment of one, it is released (set to null;
 * the old value is kept in the audit log) so it can be recorded again. Live rows, rejected claims included, keep
 * their reference.
 */
export async function releaseCancelledReference(reference: string, t: Tx, actorId: string | null): Promise<void> {
  // both lookups go through the unique reference indexes (and the purchases primary key)
  const ps = await t
    .select({ id: purchases.id })
    .from(purchases)
    .where(and(eq(purchases.reference, reference), eq(purchases.status, "cancelled")));
  const pays = await t
    .select({ id: payments.id })
    .from(payments)
    .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
    .where(and(eq(payments.reference, reference), eq(purchases.status, "cancelled")));
  if (!ps.length && !pays.length) return;
  const now = new Date();
  if (ps.length) {
    await t.update(purchases).set({ reference: null, updatedAt: now }).where(inArray(purchases.id, ps.map((r) => r.id)));
  }
  if (pays.length) {
    await t.update(payments).set({ reference: null, updatedAt: now }).where(inArray(payments.id, pays.map((r) => r.id)));
  }
  await audit(
    [
      ...ps.map((r) => ({ table: "purchases", rowId: r.id })),
      ...pays.map((r) => ({ table: "payments", rowId: r.id })),
    ].map((r) => ({ ...r, action: "update", field: "reference", oldValue: reference, newValue: null, userId: actorId })),
    t,
  );
}

const UNIQUE_REFERENCE_CONSTRAINTS = ["purchases_reference_uq", "payments_reference_uq"];

/**
 * If `e` is a unique violation on a reference index (a race the pre-check could not see), turn it into a
 * DuplicateReferenceError naming the contact that holds it. Must be called OUTSIDE the failed (sub)transaction.
 */
export async function asDuplicateReferenceError(e: unknown, label: string, tx: Tx): Promise<DuplicateReferenceError | null> {
  const pgErr = findPgError(e);
  if (!pgErr || pgErr.code !== "23505") return null;
  const constraint = pgErr.constraint_name ?? pgErr.constraint ?? "";
  if (!UNIQUE_REFERENCE_CONSTRAINTS.includes(constraint)) return null;
  const reference = /\(reference\)=\((.*)\) already exists/.exec(pgErr.detail ?? "")?.[1] ?? null;
  if (!reference) return new DuplicateReferenceError({ reference: "", label });
  const holder = await findReferenceHolder(reference, tx).catch(() => null);
  return new DuplicateReferenceError({ reference, label, ...(holder ?? {}) });
}

type PgErrorLike = { code?: string; constraint_name?: string; constraint?: string; detail?: string };

function findPgError(e: unknown): PgErrorLike | null {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const o = cur as PgErrorLike & { cause?: unknown };
    if (typeof o.code === "string" && /^[0-9A-Z]{5}$/.test(o.code)) return o;
    cur = o.cause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// After money moves
// ---------------------------------------------------------------------------

/** recomputeContact for the contact and, when it was referred, for the referrer (network value, referrals). */
export async function recomputeWithReferrer(contactId: string, t: Tx): Promise<void> {
  await recomputeContact(contactId, t);
  const [c] = await t.select({ referredById: contacts.referredById }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (c?.referredById && c.referredById !== contactId) {
    const referrer = await resolveContact(c.referredById, t);
    if (referrer && referrer.id !== contactId) await recomputeContact(referrer.id, t);
  }
}

/**
 * Run once verified money has arrived for a contact (`paymentIds` just became verified, paid at `paidAt`):
 * 1. New advocate: if this is the contact's FIRST verified money and someone referred them, a Today task for the
 *    referrer's owner (or the pool) to call and thank them. Deduped per referred contact. Skipped for imports.
 * 2. Abandoned checkouts: the contact's checkout enquiries become "recovered" (or "handled" when the checkout
 *    just completed normally within the abandoned-checkout window) and open abandoned-checkout tasks close.
 * 3. Open "unverified payment" alerts for these payments close.
 */
export async function onVerifiedMoney(
  opts: {
    contactId: string;
    paymentIds: string[];
    purchaseId: string;
    paidAt: Date;
    actorId: string | null;
    /** false for imported history: no "call to thank" for a payment made long ago */
    newAdvocate?: boolean;
    /** the payments were created in this transaction, so no alert task is about them yet */
    newPayments?: boolean;
  },
  t: Tx,
): Promise<void> {
  const { contactId, paymentIds, purchaseId, actorId } = opts;
  if (!paymentIds.length) return;

  // 1. New advocate (never for imported history, so the contact is not even read then)
  const [contact] =
    opts.newAdvocate === false
      ? [null]
      : await t
          .select({ id: contacts.id, name: contacts.name, referredById: contacts.referredById })
          .from(contacts)
          .where(eq(contacts.id, contactId))
          .limit(1);
  if (contact?.referredById) {
    const [earlier] = await t
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.contactId, contactId),
          eq(payments.kind, "payment"),
          eq(payments.status, "verified"),
          notInArray(payments.id, paymentIds),
        ),
      )
      .limit(1);
    if (!earlier) {
      const referrer = await resolveContact(contact.referredById, t);
      if (referrer && referrer.id !== contactId) {
        await createTask(
          {
            contactId: referrer.id,
            userId: referrer.ownerId ?? null,
            type: "new_advocate",
            reason: `Their referral ${contact.name} just paid — call to thank`,
            dedupeKey: `new_advocate:${contactId}`,
            payload: { referredContactId: contactId, referredName: contact.name, purchaseId, paymentIds },
            createdById: actorId,
          },
          t,
        );
      }
    }
  }

  // 2. Abandoned checkouts
  const thresholds = await getSetting("thresholds", t);
  // Only alerts this money can have resolved: raised no later than the alert for a checkout started up to a day
  // after the payment (the window checkoutResolution accepts). Verifying an old claim or importing history must
  // not close the alert for a checkout the customer started (and failed) after that payment.
  const latestResolvable = new Date(opts.paidAt.getTime() + DAY_MS + thresholds.abandonedCheckoutMinutes * 60_000);
  const openAbandoned = await t
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.contactId, contactId),
        eq(tasks.status, "open"),
        eq(tasks.type, "abandoned_checkout"),
        lte(tasks.createdAt, latestResolvable),
      ),
    );
  const checkouts = await t
    .select({ id: enquiries.id, status: enquiries.status, receivedAt: enquiries.receivedAt })
    .from(enquiries)
    .where(and(eq(enquiries.contactId, contactId), inArray(enquiries.status, [...CHECKOUT_ENQUIRY_STATUSES])));
  const recovered: string[] = [];
  const handled: string[] = [];
  for (const e of checkouts) {
    const r = checkoutResolution(e, opts.paidAt, thresholds.abandonedCheckoutMinutes, openAbandoned.length > 0);
    if (r === "recovered") recovered.push(e.id);
    else if (r === "handled") handled.push(e.id);
  }
  if (recovered.length) await t.update(enquiries).set({ status: "recovered" }).where(inArray(enquiries.id, recovered));
  if (handled.length) await t.update(enquiries).set({ status: "handled" }).where(inArray(enquiries.id, handled));
  if (openAbandoned.length) {
    await t
      .update(tasks)
      .set({
        status: "done",
        completedAt: new Date(),
        completedById: actorId,
        payload: sql`coalesce(${tasks.payload}, '{}'::jsonb) || ${JSON.stringify({ recoveredByPurchaseId: purchaseId })}::jsonb`,
      })
      .where(inArray(tasks.id, openAbandoned.map((x) => x.id)));
  }

  // 3. Alerts about these payments
  if (!opts.newPayments) await closePaymentTasks(contactId, paymentIds, ["unverified_payment", "instalment_due"], actorId, t);
}

/**
 * Close open alert tasks about specific payments. Matches tasks whose payload.paymentId is one of the ids or whose
 * dedupe key contains one (e.g. "instalment_due:<paymentId>", "unverified_payment:<paymentId>").
 */
export async function closePaymentTasks(
  contactId: string,
  paymentIds: string[],
  types: TaskType[],
  actorId: string | null,
  t: Tx,
): Promise<void> {
  if (!paymentIds.length || !types.length) return;
  // scoped to the payment's contact so the lookup uses tasks_contact_idx instead of scanning every task
  await t
    .update(tasks)
    .set({ status: "done", completedAt: new Date(), completedById: actorId })
    .where(
      and(
        eq(tasks.contactId, contactId),
        eq(tasks.status, "open"),
        inArray(tasks.type, types),
        or(
          inArray(sql<string>`${tasks.payload}->>'paymentId'`, paymentIds),
          ...paymentIds.map((id) => like(tasks.dedupeKey, `%${id}%`)),
        ),
      ),
    );
}

// ---------------------------------------------------------------------------
// Instalment schedule
// ---------------------------------------------------------------------------

/**
 * Keep an instalment schedule honest after money is claimed or verified: verified + unverified + scheduled payments
 * never exceed the purchase amount, so no instalment is chased for money that has already come in (a customer
 * paying ahead, an instalment paid with more than its amount, a rejected claim verified after all).
 * The excess comes off the scheduled instalments — rows numbered `preferSeq` first, then the latest due date
 * first. A row reduced to zero is deleted (a scheduled row holds no money) and its open instalment alerts close.
 * Audited on the purchase. Returns the ids of the deleted rows.
 */
export async function trimSchedule(
  purchase: Pick<Purchase, "id" | "contactId" | "amount" | "currency" | "fxRate">,
  actorId: string | null,
  t: Tx,
  opts: { preferSeq?: number } = {},
): Promise<string[]> {
  const rows = await t
    .select({
      id: payments.id,
      kind: payments.kind,
      status: payments.status,
      seq: payments.seq,
      amount: payments.amount,
      currency: payments.currency,
      fxRate: payments.fxRate,
      amountInr: payments.amountInr,
      dueAt: payments.dueAt,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(eq(payments.purchaseId, purchase.id), eq(payments.kind, "payment"), ne(payments.status, "rejected")));
  const committed = roundMoney(rows.reduce((s, r) => s + inPurchaseCurrency(r, purchase), 0));
  let excess = roundMoney(committed - Number(purchase.amount));
  if (excess <= MONEY_EPSILON) return [];

  const rank = (r: (typeof rows)[number]) => (opts.preferSeq !== undefined && r.seq === opts.preferSeq ? 0 : 1);
  const scheduled = rows
    .filter((r) => r.status === "scheduled")
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.dueAt?.getTime() ?? 0) - (a.dueAt?.getTime() ?? 0) ||
        b.seq - a.seq ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  const removed: string[] = [];
  const before: { id: string; seq: number; amount: number }[] = [];
  const after: { id: string; seq: number; amount: number }[] = [];
  for (const r of scheduled) {
    if (excess <= MONEY_EPSILON) break;
    const value = inPurchaseCurrency(r, purchase);
    before.push({ id: r.id, seq: r.seq, amount: Number(r.amount) });
    if (value <= excess + MONEY_EPSILON) {
      await t.delete(payments).where(eq(payments.id, r.id));
      removed.push(r.id);
      after.push({ id: r.id, seq: r.seq, amount: 0 });
      excess = roundMoney(excess - value);
    } else {
      const amount = roundMoney((Number(r.amount) * (value - excess)) / value);
      await t
        .update(payments)
        .set({ amount, amountInr: toInr(amount, Number(r.fxRate)), updatedAt: new Date() })
        .where(eq(payments.id, r.id));
      after.push({ id: r.id, seq: r.seq, amount });
      excess = 0;
    }
  }
  if (!before.length) return removed;
  await audit(
    { table: "purchases", rowId: purchase.id, action: "update", field: "schedule", oldValue: before, newValue: after, userId: actorId },
    t,
  );
  await closePaymentTasks(purchase.contactId, removed, ["instalment_due"], actorId, t);
  return removed;
}
