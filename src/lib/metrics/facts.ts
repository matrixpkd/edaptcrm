import "server-only";
/**
 * Aggregations behind the calculated columns. Each fact has a bulk form (Map by contact id, used by the
 * nightly recompute in batches) and a single-contact form. Missing contacts get the empty facts.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, queryRows, type Tx } from "@/db";
import { payments, purchases } from "@/db/schema";
import { getSetting, type ProductFamily } from "@/lib/settings";
import {
  EMPTY_ACTIVITY_FACTS,
  EMPTY_MONEY_FACTS,
  EMPTY_REFERRAL_FACTS,
  maxDate,
  rungFor,
  type ActivityFacts,
  type MoneyFacts,
  type ReferralFacts,
} from "./compute";

export type { ActivityFacts, MoneyFacts, ReferralFacts } from "./compute";

/** Purchase statuses that count as bought (money verified, in full or in part). */
export const COUNTED_PURCHASE_STATUSES = ["paid", "partial"] as const;

/**
 * A uuid[] built from one text parameter, so a batch of any size is a single bind value. (Drizzle's inArray binds
 * one parameter per id and fails past Postgres' 65,535-parameter limit.)
 */
function uuidArray(ids: string[]): SQL {
  return sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;
}

/** Raw timestamps come back as strings (Drizzle turns off the driver's date parsing). */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

const uniq = (ids: string[]) => [...new Set(ids)];

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export async function computeMoneyFactsBulk(
  contactIds: string[],
  tx: Tx = db,
  families?: ProductFamily[],
): Promise<Map<string, MoneyFacts>> {
  const ids = uniq(contactIds);
  const out = new Map<string, MoneyFacts>();
  if (!ids.length) return out;
  const ladder = families ?? (await getSetting("ladder.families", tx));

  const bought = await tx
    .select({ contactId: purchases.contactId, purchasedAt: purchases.purchasedAt, family: purchases.family })
    .from(purchases)
    .where(and(sql`${purchases.contactId} = any(${uuidArray(ids)})`, inArray(purchases.status, [...COUNTED_PURCHASE_STATUSES])))
    .orderBy(asc(purchases.contactId), asc(purchases.purchasedAt), asc(purchases.createdAt), asc(purchases.id));

  const money = await tx
    .select({
      contactId: payments.contactId,
      ltv: sql<number>`coalesce(sum(case when ${payments.kind} = 'refund' then -${payments.amountInr} else ${payments.amountInr} end), 0)`.mapWith(Number),
      lastPaidAt: sql<Date | null>`max(case when ${payments.kind} = 'payment' then coalesce(${payments.paidAt}, ${payments.verifiedAt}, ${payments.createdAt}) end)`.mapWith(
        (v: unknown) => toDate(v),
      ),
    })
    .from(payments)
    .where(and(sql`${payments.contactId} = any(${uuidArray(ids)})`, eq(payments.status, "verified")))
    .groupBy(payments.contactId);
  const moneyBy = new Map(money.map((m) => [m.contactId, m]));

  const byContact = new Map<string, { purchasedAt: Date; family: string }[]>();
  for (const b of bought) {
    const list = byContact.get(b.contactId) ?? [];
    list.push({ purchasedAt: b.purchasedAt, family: b.family });
    byContact.set(b.contactId, list);
  }

  for (const id of ids) {
    const list = byContact.get(id) ?? [];
    const fams: string[] = [];
    for (const p of list) if (!fams.includes(p.family)) fams.push(p.family);
    const m = moneyBy.get(id);
    out.set(id, {
      ...EMPTY_MONEY_FACTS,
      ltvInr: Math.round((m?.ltv ?? 0) * 100) / 100,
      purchaseCount: list.length,
      families: fams,
      familyCount: fams.length,
      currentRung: rungFor(fams, ladder),
      firstPurchaseAt: list[0]?.purchasedAt ?? null,
      lastPurchaseAt: list.length ? list[list.length - 1].purchasedAt : null,
      firstFamily: list[0]?.family ?? null,
      purchaseDates: list.map((p) => p.purchasedAt),
      lastVerifiedPaymentAt: m?.lastPaidAt ?? null,
    });
  }
  return out;
}

/**
 * LTV (verified payments - verified refunds, INR; amount_inr as stored, so AED keeps its rate of the month),
 * paid/part-paid purchases, families, current rung, first/last purchase, first family, purchase dates and the
 * latest verified payment. `families` defaults to settings ladder.families.
 */
export async function computeMoneyFacts(contactId: string, tx: Tx = db, families?: ProductFamily[]): Promise<MoneyFacts> {
  return (await computeMoneyFactsBulk([contactId], tx, families)).get(contactId) ?? { ...EMPTY_MONEY_FACTS };
}

// ---------------------------------------------------------------------------
// Referrals and network value
// ---------------------------------------------------------------------------

export async function computeReferralFactsBulk(contactIds: string[], tx: Tx = db): Promise<Map<string, ReferralFacts>> {
  const ids = uniq(contactIds);
  const out = new Map<string, ReferralFacts>();
  if (!ids.length) return out;
  // LTV is computed from the payments themselves, not the stored ltv_inr, so the result never depends on the
  // order contacts are recomputed in.
  const rows = await queryRows<{ id: string; referral_count: number; network_value: string | number | null }>(sql`
    select r.referred_by_id as id,
      count(*) filter (where exists (
        select 1 from purchases p where p.contact_id = r.id and p.status in ('paid', 'partial')
      ))::int as referral_count,
      coalesce(sum((
        select sum(case when pm.kind = 'refund' then -pm.amount_inr else pm.amount_inr end)
        from payments pm where pm.contact_id = r.id and pm.status = 'verified'
      )), 0) as network_value
    from contacts r
    where r.referred_by_id = any(${uuidArray(ids)})
      and r.merged_into_id is null
      and r.id <> r.referred_by_id
    group by r.referred_by_id
  `, tx);
  const by = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const r = by.get(id);
    out.set(id, r ? { referralCount: Number(r.referral_count), networkValueInr: Math.round(Number(r.network_value ?? 0) * 100) / 100 } : { ...EMPTY_REFERRAL_FACTS });
  }
  return out;
}

/** Referral count (referred, non-merged contacts who have paid) and network value (sum of their LTV). */
export async function computeReferralFacts(contactId: string, tx: Tx = db): Promise<ReferralFacts> {
  return (await computeReferralFactsBulk([contactId], tx)).get(contactId) ?? { ...EMPTY_REFERRAL_FACTS };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export async function computeActivityFactsBulk(contactIds: string[], tx: Tx = db): Promise<Map<string, ActivityFacts>> {
  const ids = uniq(contactIds);
  const out = new Map<string, ActivityFacts>();
  if (!ids.length) return out;
  const rows = await queryRows<{
    id: string;
    last_enquiry_at: string | null;
    last_interaction_at: string | null;
    has_outbound: boolean;
    last_purchase_at: string | null;
    last_verified_payment_at: string | null;
    last_payment_counted_at: string | null;
    last_chat_at: string | null;
  }>(sql`
    select c.id,
      (select max(e.received_at) from enquiries e where e.contact_id = c.id) as last_enquiry_at,
      (select max(i.occurred_at) from interactions i where i.contact_id = c.id) as last_interaction_at,
      -- Contacted: a team member reached out; an internal note (the contact page's quick notes) is not contact
      exists (select 1 from interactions i where i.contact_id = c.id and i.user_id is not null and i.type <> 'note') as has_outbound,
      (select max(i.occurred_at) from interactions i where i.contact_id = c.id
        and i.type in ('call', 'whatsapp', 'meeting', 'email')
        and (i.direction = 'in' or coalesce(i.outcome, '') not in ('no_answer', 'busy', 'wrong_number'))) as last_chat_at,
      (select max(p.purchased_at) from purchases p where p.contact_id = c.id and p.status <> 'cancelled') as last_purchase_at,
      (select max(coalesce(pm.paid_at, pm.verified_at, pm.created_at)) from payments pm
        where pm.contact_id = c.id and pm.kind = 'payment' and pm.status = 'verified') as last_verified_payment_at,
      (select max(greatest(coalesce(pm.paid_at, pm.created_at), pm.verified_at)) from payments pm
        where pm.contact_id = c.id and pm.kind = 'payment' and pm.status = 'verified') as last_payment_counted_at
    from contacts c
    where c.id = any(${uuidArray(ids)})
  `, tx);
  const by = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const r = by.get(id);
    if (!r) {
      out.set(id, { ...EMPTY_ACTIVITY_FACTS });
      continue;
    }
    const lastEnquiryAt = toDate(r.last_enquiry_at);
    const lastInteractionAt = toDate(r.last_interaction_at);
    const lastPurchaseAt = toDate(r.last_purchase_at);
    const lastPaymentAt = toDate(r.last_verified_payment_at);
    // A payment counts from when it was made or, if later, when it was verified: money verified after a contact
    // was marked Lost is a new payment for the pull-back rule even when the transfer itself was dated earlier.
    const lastPaymentCountedAt = toDate(r.last_payment_counted_at);
    out.set(id, {
      lastEnquiryAt,
      lastInteractionAt,
      lastActivityAt: maxDate(lastEnquiryAt, lastInteractionAt, lastPurchaseAt, lastPaymentAt),
      hasOutboundInteraction: r.has_outbound === true || String(r.has_outbound) === "true",
      lastEnquiryOrPaymentAt: maxDate(lastEnquiryAt, lastPurchaseAt, lastPaymentAt, lastPaymentCountedAt),
      lastInterestAt: maxDate(lastEnquiryAt, toDate(r.last_chat_at), lastPurchaseAt, lastPaymentAt),
    });
  }
  return out;
}

/**
 * Last enquiry, last interaction, last activity (max of enquiry, interaction, purchase and verified payment),
 * whether a team member ever logged an interaction, and the latest enquiry or payment (pulls Lost back; a verified
 * payment counts from the later of its payment and verification dates).
 */
export async function computeActivityFacts(contactId: string, tx: Tx = db): Promise<ActivityFacts> {
  return (await computeActivityFactsBulk([contactId], tx)).get(contactId) ?? { ...EMPTY_ACTIVITY_FACTS };
}
