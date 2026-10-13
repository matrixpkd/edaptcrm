import "server-only";
/**
 * Read models for the payments desk (/payments), the purchase page (/payments/[id]) and Record payment.
 *
 * The queue definitions mirror listPaymentsQueue in src/lib/money/purchases.ts (the Unverified payment and
 * Instalment due alerts use that one): payment rows only, cancelled purchases and merged contacts left out;
 * "unverified" = claimed money waiting for a manager, oldest first; "overdue" = a scheduled instalment past its
 * due moment; "due soon" = a scheduled instalment due by the end of the local day N days from today.
 * On top of that every query here is limited to the contacts the viewer may see (contactScope): salespeople see
 * their own contacts and the unassigned pool. tests/integration/payments-desk.test.ts checks both.
 */
import { and, asc, count, desc, eq, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/db";
import {
  auditLog,
  contacts,
  organisations,
  payments,
  products,
  purchases,
  users,
  type Contact,
  type Payment,
  type PaymentMode,
  type Purchase,
  type PurchaseSource,
  type PurchaseStatus,
  type Role,
} from "@/db/schema";
import { contactScope } from "@/lib/auth/scope";
import { localTimeInDays } from "@/lib/contacts/follow-up";
import { purchaseTotals, type PurchaseTotals } from "@/lib/money/rules";
import { DAY_MS, isUuid } from "@/lib/utils";
import type { ProductOption } from "@/components/payments/rules";

export type Viewer = { id: string; role: Role };

/** Rows per page on the payments desk. */
export const DESK_PAGE_SIZE = 50;

/** The exclusive end of the "due soon" window: 00:00 local, `withinDays` + 1 calendar days after today. */
export function dueWindowEnd(now: Date, timeZone: string, withinDays: number): Date {
  return localTimeInDays(now, timeZone, Math.max(0, withinDays) + 1, 0, 0);
}

/** Rows that belong on the desk at all, for this viewer. */
function queueBase(viewer: Viewer): SQL {
  return and(eq(payments.kind, "payment"), ne(purchases.status, "cancelled"), contactScope(viewer))!;
}

const waitingSince = sql`coalesce(${payments.paidAt}, ${payments.createdAt})`;
const iso = (d: Date) => d.toISOString();

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export type DeskTotals = {
  unverifiedCount: number;
  unverifiedInr: number;
  /** waiting at least thresholds.unverifiedPaymentDays */
  staleCount: number;
  overdueCount: number;
  overdueInr: number;
  dueSoonCount: number;
  dueSoonInr: number;
};

export type DeskWindow = {
  now: Date;
  timeZone: string;
  /** thresholds.instalmentDueDays */
  withinDays: number;
  /** thresholds.unverifiedPaymentDays */
  staleDays: number;
};

/** The numbers at the top of the desk, in one scan of the open payment rows the viewer may see. */
export async function getDeskTotals(viewer: Viewer, w: DeskWindow, tx: Tx = db): Promise<DeskTotals> {
  const now = iso(w.now);
  const staleCutoff = iso(new Date(w.now.getTime() - w.staleDays * DAY_MS));
  const dueEnd = iso(dueWindowEnd(w.now, w.timeZone, w.withinDays));
  const unverified = sql`${payments.status} = 'unverified'`;
  const overdue = sql`${payments.status} = 'scheduled' and ${payments.dueAt} < ${now}::timestamptz`;
  const dueSoon = sql`${payments.status} = 'scheduled' and ${payments.dueAt} >= ${now}::timestamptz and ${payments.dueAt} < ${dueEnd}::timestamptz`;
  const [r] = await tx
    .select({
      unverifiedCount: sql<number>`count(*) filter (where ${unverified})`.mapWith(Number),
      unverifiedInr: sql<number>`coalesce(sum(${payments.amountInr}) filter (where ${unverified}), 0)`.mapWith(Number),
      staleCount: sql<number>`count(*) filter (where ${unverified} and ${waitingSince} <= ${staleCutoff}::timestamptz)`.mapWith(Number),
      overdueCount: sql<number>`count(*) filter (where ${overdue})`.mapWith(Number),
      overdueInr: sql<number>`coalesce(sum(${payments.amountInr}) filter (where ${overdue}), 0)`.mapWith(Number),
      dueSoonCount: sql<number>`count(*) filter (where ${dueSoon})`.mapWith(Number),
      dueSoonInr: sql<number>`coalesce(sum(${payments.amountInr}) filter (where ${dueSoon}), 0)`.mapWith(Number),
    })
    .from(payments)
    .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
    .innerJoin(contacts, eq(contacts.id, payments.contactId))
    .where(and(queueBase(viewer), inArray(payments.status, ["unverified", "scheduled"])));
  return {
    unverifiedCount: r?.unverifiedCount ?? 0,
    unverifiedInr: r?.unverifiedInr ?? 0,
    staleCount: r?.staleCount ?? 0,
    overdueCount: r?.overdueCount ?? 0,
    overdueInr: r?.overdueInr ?? 0,
    dueSoonCount: r?.dueSoonCount ?? 0,
    dueSoonInr: r?.dueSoonInr ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Unverified
// ---------------------------------------------------------------------------

export type DeskPaymentRow = {
  paymentId: string;
  purchaseId: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  ownerId: string | null;
  ownerName: string | null;
  productName: string;
  hasInstalments: boolean;
  seq: number;
  /** highest instalment number on the purchase ("2 of 3") */
  instalmentCount: number;
  amount: number;
  currency: string;
  amountInr: number;
  dueAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  mode: PaymentMode | null;
  reference: string | null;
  proofUrl: string | null;
  /** the purchase's own proof, shown when the payment row has none */
  purchaseProofUrl: string | null;
  recordedByName: string | null;
};

function deskSelect() {
  const owner = alias(users, "desk_owner");
  const recorder = alias(users, "desk_recorder");
  const fields = {
    paymentId: payments.id,
    purchaseId: purchases.id,
    contactId: contacts.id,
    contactName: contacts.name,
    contactPhone: contacts.phoneE164,
    ownerId: contacts.ownerId,
    ownerName: owner.name,
    productName: purchases.productName,
    hasInstalments: purchases.hasInstalments,
    seq: payments.seq,
    instalmentCount: sql<number>`(select coalesce(max(p2.seq), 1) from payments p2 where p2.purchase_id = ${purchases.id} and p2.kind = 'payment')`.mapWith(Number),
    amount: payments.amount,
    currency: payments.currency,
    amountInr: payments.amountInr,
    dueAt: payments.dueAt,
    paidAt: payments.paidAt,
    createdAt: payments.createdAt,
    mode: payments.mode,
    reference: payments.reference,
    proofUrl: payments.proofUrl,
    purchaseProofUrl: purchases.proofUrl,
    recordedByName: recorder.name,
  };
  return { owner, recorder, fields };
}

/** Claimed payments waiting for a manager, oldest claim first. */
export async function listUnverified(
  viewer: Viewer,
  opts: { limit?: number; offset?: number } = {},
  tx: Tx = db,
): Promise<DeskPaymentRow[]> {
  const { owner, recorder, fields } = deskSelect();
  return tx
    .select(fields)
    .from(payments)
    .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
    .innerJoin(contacts, eq(contacts.id, payments.contactId))
    .leftJoin(owner, eq(owner.id, contacts.ownerId))
    .leftJoin(recorder, eq(recorder.id, payments.createdById))
    .where(and(queueBase(viewer), eq(payments.status, "unverified")))
    .orderBy(asc(waitingSince), asc(payments.createdAt), asc(payments.id))
    .limit(opts.limit ?? DESK_PAGE_SIZE)
    .offset(opts.offset ?? 0);
}

// ---------------------------------------------------------------------------
// Instalments due and overdue
// ---------------------------------------------------------------------------

/** Scheduled instalments that are overdue or due by the end of the window, most overdue first. */
export async function listInstalmentsDue(
  viewer: Viewer,
  w: Pick<DeskWindow, "now" | "timeZone" | "withinDays">,
  opts: { limit?: number; offset?: number } = {},
  tx: Tx = db,
): Promise<DeskPaymentRow[]> {
  const { owner, recorder, fields } = deskSelect();
  return tx
    .select(fields)
    .from(payments)
    .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
    .innerJoin(contacts, eq(contacts.id, payments.contactId))
    .leftJoin(owner, eq(owner.id, contacts.ownerId))
    .leftJoin(recorder, eq(recorder.id, payments.createdById))
    .where(
      and(
        queueBase(viewer),
        eq(payments.status, "scheduled"),
        lt(payments.dueAt, dueWindowEnd(w.now, w.timeZone, w.withinDays)),
      ),
    )
    .orderBy(asc(payments.dueAt), asc(payments.seq), asc(payments.id))
    .limit(opts.limit ?? DESK_PAGE_SIZE)
    .offset(opts.offset ?? 0);
}

// ---------------------------------------------------------------------------
// Recent purchases
// ---------------------------------------------------------------------------

export type RecentPurchaseRow = {
  purchaseId: string;
  contactId: string;
  contactName: string;
  productName: string;
  family: string;
  amount: number;
  currency: string;
  amountInr: number;
  purchasedAt: Date;
  mode: PaymentMode;
  status: PurchaseStatus;
  source: PurchaseSource;
  hasInstalments: boolean;
  creditedUserName: string | null;
  assisted: boolean;
  /** verified payments - verified refunds, INR (this purchase's LTV contribution) */
  receivedInr: number;
  unverifiedCount: number;
};

function recentWhere(viewer: Viewer): SQL {
  return contactScope(viewer);
}

/** Latest purchases first (any status), with what has been received and what still waits for a manager. */
export async function listRecentPurchases(
  viewer: Viewer,
  opts: { limit?: number; offset?: number } = {},
  tx: Tx = db,
): Promise<RecentPurchaseRow[]> {
  const credited = alias(users, "recent_credited");
  return tx
    .select({
      purchaseId: purchases.id,
      contactId: contacts.id,
      contactName: contacts.name,
      productName: purchases.productName,
      family: purchases.family,
      amount: purchases.amount,
      currency: purchases.currency,
      amountInr: purchases.amountInr,
      purchasedAt: purchases.purchasedAt,
      mode: purchases.mode,
      status: purchases.status,
      source: purchases.source,
      hasInstalments: purchases.hasInstalments,
      creditedUserName: credited.name,
      assisted: purchases.assisted,
      receivedInr: sql<number>`(select coalesce(sum(case when p2.kind = 'refund' then -p2.amount_inr else p2.amount_inr end), 0) from payments p2 where p2.purchase_id = ${purchases.id} and p2.status = 'verified')`.mapWith(Number),
      unverifiedCount: sql<number>`(select count(*) from payments p2 where p2.purchase_id = ${purchases.id} and p2.kind = 'payment' and p2.status = 'unverified')`.mapWith(Number),
    })
    .from(purchases)
    .innerJoin(contacts, eq(contacts.id, purchases.contactId))
    .leftJoin(credited, eq(credited.id, purchases.creditedUserId))
    .where(recentWhere(viewer))
    .orderBy(desc(purchases.purchasedAt), desc(purchases.createdAt), desc(purchases.id))
    .limit(opts.limit ?? DESK_PAGE_SIZE)
    .offset(opts.offset ?? 0);
}

export async function countRecentPurchases(viewer: Viewer, tx: Tx = db): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(purchases)
    .innerJoin(contacts, eq(contacts.id, purchases.contactId))
    .where(recentWhere(viewer));
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------
// One purchase
// ---------------------------------------------------------------------------

export type PaymentLine = Payment & { recordedByName: string | null; verifiedByName: string | null };

export type PurchaseDetail = {
  purchase: Purchase;
  contact: {
    id: string;
    name: string;
    phoneE164: string;
    ownerId: string | null;
    ownerName: string | null;
    mergedIntoId: string | null;
  };
  organisation: { id: string; name: string } | null;
  creditedUserName: string | null;
  creditAdjustedByName: string | null;
  createdByName: string | null;
  /** instalments by number (then date), then refunds */
  payments: PaymentLine[];
  totals: PurchaseTotals;
};

/** A purchase with its contact, names and every payment, instalment and refund. Null when it does not exist. */
export async function getPurchaseDetail(purchaseId: string, tx: Tx = db): Promise<PurchaseDetail | null> {
  if (!isUuid(purchaseId)) return null;
  const owner = alias(users, "detail_owner");
  const credited = alias(users, "detail_credited");
  const adjuster = alias(users, "detail_adjuster");
  const creator = alias(users, "detail_creator");
  const [row] = await tx
    .select({
      purchase: purchases,
      contactId: contacts.id,
      contactName: contacts.name,
      contactPhone: contacts.phoneE164,
      ownerId: contacts.ownerId,
      ownerName: owner.name,
      mergedIntoId: contacts.mergedIntoId,
      orgId: organisations.id,
      orgName: organisations.name,
      creditedUserName: credited.name,
      creditAdjustedByName: adjuster.name,
      createdByName: creator.name,
    })
    .from(purchases)
    .innerJoin(contacts, eq(contacts.id, purchases.contactId))
    .leftJoin(owner, eq(owner.id, contacts.ownerId))
    .leftJoin(organisations, eq(organisations.id, purchases.organisationId))
    .leftJoin(credited, eq(credited.id, purchases.creditedUserId))
    .leftJoin(adjuster, eq(adjuster.id, purchases.creditAdjustedById))
    .leftJoin(creator, eq(creator.id, purchases.createdById))
    .where(eq(purchases.id, purchaseId))
    .limit(1);
  if (!row) return null;

  const recorder = alias(users, "line_recorder");
  const verifier = alias(users, "line_verifier");
  const lines = await tx
    .select({ payment: payments, recordedByName: recorder.name, verifiedByName: verifier.name })
    .from(payments)
    .leftJoin(recorder, eq(recorder.id, payments.createdById))
    .leftJoin(verifier, eq(verifier.id, payments.verifiedById))
    .where(eq(payments.purchaseId, purchaseId))
    .orderBy(
      asc(payments.kind),
      asc(payments.seq),
      asc(sql`coalesce(${payments.paidAt}, ${payments.dueAt}, ${payments.createdAt})`),
      asc(payments.createdAt),
    );
  const list: PaymentLine[] = lines.map((l) => ({ ...l.payment, recordedByName: l.recordedByName, verifiedByName: l.verifiedByName }));
  return {
    purchase: row.purchase,
    contact: {
      id: row.contactId,
      name: row.contactName,
      phoneE164: row.contactPhone,
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      mergedIntoId: row.mergedIntoId,
    },
    organisation: row.orgId && row.orgName ? { id: row.orgId, name: row.orgName } : null,
    creditedUserName: row.creditedUserName,
    creditAdjustedByName: row.creditAdjustedByName,
    createdByName: row.createdByName,
    payments: list,
    totals: purchaseTotals(row.purchase, list),
  };
}

export type AuditLine = {
  id: number;
  tableName: string;
  rowId: string | null;
  action: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  userName: string | null;
  changedAt: Date;
};

/** The audit trail of a purchase and its payment rows, newest first. */
export async function getPurchaseAudit(
  purchaseId: string,
  paymentIds: string[],
  tx: Tx = db,
  limit = 200,
): Promise<AuditLine[]> {
  if (!isUuid(purchaseId)) return [];
  const conds: SQL[] = [and(eq(auditLog.tableName, "purchases"), eq(auditLog.rowId, purchaseId))!];
  if (paymentIds.length) conds.push(and(eq(auditLog.tableName, "payments"), inArray(auditLog.rowId, paymentIds))!);
  return tx
    .select({
      id: auditLog.id,
      tableName: auditLog.tableName,
      rowId: auditLog.rowId,
      action: auditLog.action,
      field: auditLog.field,
      oldValue: auditLog.oldValue,
      newValue: auditLog.newValue,
      userName: users.name,
      changedAt: auditLog.changedAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(or(...conds))
    .orderBy(desc(auditLog.changedAt), desc(auditLog.id))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Access checks for actions
// ---------------------------------------------------------------------------

export type MoneyRowContext = {
  purchaseId: string;
  purchaseStatus: PurchaseStatus;
  purchaseCurrency: string;
  contactId: string;
  ownerId: string | null;
  mergedIntoId: string | null;
};

/** The purchase's contact, for permission checks in actions. Null when the purchase does not exist. */
export async function getPurchaseContext(purchaseId: string, tx: Tx = db): Promise<MoneyRowContext | null> {
  if (!isUuid(purchaseId)) return null;
  const [r] = await tx
    .select({
      purchaseId: purchases.id,
      purchaseStatus: purchases.status,
      purchaseCurrency: purchases.currency,
      contactId: contacts.id,
      ownerId: contacts.ownerId,
      mergedIntoId: contacts.mergedIntoId,
    })
    .from(purchases)
    .innerJoin(contacts, eq(contacts.id, purchases.contactId))
    .where(eq(purchases.id, purchaseId))
    .limit(1);
  return r ?? null;
}

/** The payment's purchase and contact, for permission checks in actions. */
export async function getPaymentContext(paymentId: string, tx: Tx = db): Promise<MoneyRowContext | null> {
  if (!isUuid(paymentId)) return null;
  const [r] = await tx
    .select({
      purchaseId: purchases.id,
      purchaseStatus: purchases.status,
      purchaseCurrency: purchases.currency,
      contactId: contacts.id,
      ownerId: contacts.ownerId,
      mergedIntoId: contacts.mergedIntoId,
    })
    .from(payments)
    .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
    .innerJoin(contacts, eq(contacts.id, payments.contactId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  return r ?? null;
}

// ---------------------------------------------------------------------------
// Record payment options
// ---------------------------------------------------------------------------

/** The contact a payment is recorded for (the full row; the page follows merges and checks access). */
export async function getPayableContact(contactId: string, tx: Tx = db): Promise<Contact | null> {
  if (!isUuid(contactId)) return null;
  const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  return c ?? null;
}

/** Active catalogue products for the product picker. */
export async function listProductOptions(tx: Tx = db): Promise<ProductOption[]> {
  const rows = await tx
    .select({
      id: products.id,
      name: products.name,
      family: products.family,
      rung: products.rung,
      listPrice: products.listPrice,
      currency: products.currency,
    })
    .from(products)
    .where(eq(products.active, true))
    .orderBy(asc(products.family), asc(products.listPrice), asc(products.name))
    .limit(500);
  return rows.map((r) => ({ ...r, listPrice: Number(r.listPrice) }));
}

export type CreditOption = { id: string; name: string; role: Role; active: boolean };

/** Who can receive sales credit: active admins, managers and salespeople (plus `includeId`, e.g. a past credit). */
export async function listCreditOptions(includeId: string | null, tx: Tx = db): Promise<CreditOption[]> {
  const live = and(eq(users.active, true), ne(users.role, "support"))!;
  return tx
    .select({ id: users.id, name: users.name, role: users.role, active: users.active })
    .from(users)
    .where(includeId && isUuid(includeId) ? or(live, eq(users.id, includeId)) : live)
    .orderBy(desc(users.active), asc(users.name));
}

/** Names for user ids (audit lines store ids). */
export async function userNames(ids: string[], tx: Tx = db): Promise<Map<string, string>> {
  const valid = [...new Set(ids.filter(isUuid))];
  if (!valid.length) return new Map();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, valid));
  return new Map(rows.map((r) => [r.id, r.name]));
}
