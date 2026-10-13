/**
 * Metrics module against a real database. Rows are inserted directly (no money/contacts services), so these
 * tests depend only on the schema and src/lib/metrics.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  auditLog,
  contacts,
  enquiries,
  interactions,
  payments,
  products,
  purchases,
  type NewContact,
  type PaymentKind,
  type PaymentStatus,
  type PurchaseStatus,
} from "@/db/schema";
import { computeActivityFacts, computeMoneyFacts, computeReferralFacts } from "@/lib/metrics/facts";
import { recomputeAll, recomputeContact, recomputeContacts, recomputeReferrerChain } from "@/lib/metrics/recompute";
import { buildCohorts } from "@/lib/metrics/repeat";
import { DEFAULT_SETTINGS, getSetting, setSetting } from "@/lib/settings";
import { makeUser, resetDb } from "../support/db";

// ---------------------------------------------------------------------------
// raw-row helpers
// ---------------------------------------------------------------------------

const DAY = 24 * 3600 * 1000;
const NOW = new Date();
const ago = (days: number, from: Date = NOW) => new Date(from.getTime() - days * DAY);

let phoneN = 0;
async function makeContact(over: Partial<NewContact> = {}) {
  phoneN += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+91940${String(phoneN).padStart(7, "0")}`, phoneCountry: "IN", name: `Contact ${phoneN}`, firstDoor: "youtube", ...over })
    .returning();
  return c;
}

let refN = 0;
type PurchaseOver = {
  family?: string;
  amount?: number;
  currency?: string;
  amountInr?: number;
  fxRate?: number;
  at?: Date;
  status?: PurchaseStatus;
  productId?: string | null;
};
async function addPurchase(contactId: string, over: PurchaseOver = {}) {
  refN += 1;
  const amount = over.amount ?? 999;
  const [p] = await db
    .insert(purchases)
    .values({
      contactId,
      productId: over.productId ?? null,
      productName: over.family ?? "Workshop",
      family: over.family ?? "workshop",
      amount,
      currency: over.currency ?? "INR",
      fxRate: over.fxRate ?? 1,
      amountInr: over.amountInr ?? amount * (over.fxRate ?? 1),
      purchasedAt: over.at ?? NOW,
      mode: "tagmango",
      reference: `M-${refN}`,
      status: over.status ?? "paid",
      source: "tagmango",
    })
    .returning();
  return p;
}

type PaymentOver = { kind?: PaymentKind; status?: PaymentStatus; amount?: number; amountInr?: number; currency?: string; fxRate?: number; paidAt?: Date | null };
async function addPayment(purchase: { id: string; contactId: string }, over: PaymentOver = {}) {
  refN += 1;
  const amount = over.amount ?? 999;
  const [p] = await db
    .insert(payments)
    .values({
      purchaseId: purchase.id,
      contactId: purchase.contactId,
      kind: over.kind ?? "payment",
      amount,
      currency: over.currency ?? "INR",
      fxRate: over.fxRate ?? 1,
      amountInr: over.amountInr ?? amount * (over.fxRate ?? 1),
      paidAt: over.paidAt === undefined ? NOW : over.paidAt,
      status: over.status ?? "verified",
      reference: `P-${refN}`,
    })
    .returning();
  return p;
}

/** A paid purchase with one verified payment of the full amount, paid on the purchase date. */
async function buy(contactId: string, over: PurchaseOver = {}) {
  const p = await addPurchase(contactId, { status: "paid", ...over });
  await addPayment(p, { amount: p.amount, amountInr: p.amountInr, currency: p.currency, fxRate: p.fxRate, paidAt: p.purchasedAt });
  return p;
}

let enqN = 0;
async function addEnquiry(contactId: string, at: Date = NOW) {
  enqN += 1;
  await db.insert(enquiries).values({ contactId, channel: "whatsapp_api", receivedAt: at, sourceRef: `enq-${enqN}` });
}

async function addInteraction(contactId: string, userId: string | null, at: Date = NOW) {
  await db.insert(interactions).values({ contactId, userId, type: userId ? "call" : "whatsapp", occurredAt: at, direction: userId ? "out" : "in" });
}

async function row(id: string) {
  const [c] = await db.select().from(contacts).where(eq(contacts.id, id));
  return c;
}
const stageAudits = (contactId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "contacts"), eq(auditLog.rowId, contactId), eq(auditLog.field, "stage")))
    .orderBy(auditLog.id);

beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// money facts
// ---------------------------------------------------------------------------

describe("metrics: money facts and LTV", () => {
  it("LTV counts verified payments only and subtracts verified refunds", async () => {
    const c = await makeContact();
    const p = await addPurchase(c.id, { amount: 10000, status: "partial" });
    await addPayment(p, { amount: 4000, status: "verified" });
    await addPayment(p, { amount: 3000, status: "unverified" });
    await addPayment(p, { amount: 3000, status: "scheduled", paidAt: null });
    await addPayment(p, { amount: 2000, status: "rejected" });
    await addPayment(p, { kind: "refund", amount: 500, status: "verified" });
    await addPayment(p, { kind: "refund", amount: 100, status: "unverified" });

    expect((await computeMoneyFacts(c.id)).ltvInr).toBe(3500);
    await recomputeContact(c.id);
    expect((await row(c.id)).ltvInr).toBe(3500);
  });

  it("AED payments use the stored amount_inr as-is (the month's rate never shifts later)", async () => {
    const c = await makeContact({ country: "AE", phoneCountry: "AE" });
    const p = await addPurchase(c.id, { amount: 100, currency: "AED", fxRate: 22.6, amountInr: 2260, at: ago(200) });
    await addPayment(p, { amount: 100, currency: "AED", fxRate: 22.6, amountInr: 2260, paidAt: ago(200) });
    const inr = await addPurchase(c.id, { amount: 999, at: ago(10) });
    await addPayment(inr, { amount: 999 });
    await recomputeContact(c.id);
    expect((await row(c.id)).ltvInr).toBe(3259);
    // a later rate change in settings does not move it
    await setSetting("currency", { ...DEFAULT_SETTINGS.currency, rates: { AED: { "2026-01": 30 } } }, null);
    await recomputeContact(c.id);
    expect((await row(c.id)).ltvInr).toBe(3259);
  });

  it("a full refund takes LTV to 0; an unverified-only purchase never inflates LTV", async () => {
    const c = await makeContact();
    const p = await buy(c.id, { amount: 2000, status: "refunded" });
    await addPayment(p, { kind: "refund", amount: 2000 });
    const pending = await addPurchase(c.id, { amount: 5000, status: "pending" });
    await addPayment(pending, { amount: 5000, status: "unverified" });
    await recomputeContact(c.id);
    const r = await row(c.id);
    expect(r.ltvInr).toBe(0);
    expect(r.purchaseCount).toBe(0);
    expect(r.value).toBeNull();
  });

  it("purchase count, families, rung, first/last purchase and first family use paid or part-paid purchases only", async () => {
    const c = await makeContact();
    await buy(c.id, { family: "delegation", amount: 150000, at: ago(700) });
    await buy(c.id, { family: "workshop", amount: 999, at: ago(300) });
    const part = await addPurchase(c.id, { family: "applied_ai_mastery", amount: 25000, at: ago(100), status: "partial" });
    await addPayment(part, { amount: 10000 });
    await buy(c.id, { family: "workshop", amount: 699, at: ago(20) });
    await addPurchase(c.id, { family: "ai_office", amount: 90000, at: ago(5), status: "pending" });
    await addPurchase(c.id, { family: "premium", amount: 90000, at: ago(4), status: "cancelled" });
    const refunded = await buy(c.id, { family: "consulting", amount: 5000, at: ago(3), status: "refunded" });
    await addPayment(refunded, { kind: "refund", amount: 5000 });

    const f = await computeMoneyFacts(c.id);
    expect(f.purchaseCount).toBe(4);
    expect(f.families).toEqual(["delegation", "workshop", "applied_ai_mastery"]);
    expect(f.familyCount).toBe(3);
    expect(f.currentRung).toBe(2); // delegation is a side group with no rung
    expect(f.firstFamily).toBe("delegation");
    expect(f.firstPurchaseAt?.getTime()).toBe(ago(700).getTime());
    expect(f.lastPurchaseAt?.getTime()).toBe(ago(20).getTime());
    expect(f.purchaseDates.map((d) => d.getTime())).toEqual([ago(700), ago(300), ago(100), ago(20)].map((d) => d.getTime()));
    expect(f.ltvInr).toBe(150000 + 999 + 10000 + 699);

    await recomputeContact(c.id);
    const r = await row(c.id);
    expect(r).toMatchObject({ purchaseCount: 4, familyCount: 3, currentRung: 2, firstFamily: "delegation", ltvInr: 161698 });
    expect(r.families).toEqual(["delegation", "workshop", "applied_ai_mastery"]);
    expect(r.firstPurchaseAt?.getTime()).toBe(ago(700).getTime());
    expect(r.lastPurchaseAt?.getTime()).toBe(ago(20).getTime());
    expect(r.avgGapDays).toBe(226.67); // 680 days over 3 gaps
  });

  it("a contact with nothing bought gets empty facts", async () => {
    const c = await makeContact();
    expect(await computeMoneyFacts(c.id)).toMatchObject({ ltvInr: 0, purchaseCount: 0, families: [], currentRung: 0, firstFamily: null, lastVerifiedPaymentAt: null });
    expect(await computeReferralFacts(c.id)).toEqual({ referralCount: 0, networkValueInr: 0 });
    expect(await computeActivityFacts(c.id)).toEqual({
      lastEnquiryAt: null,
      lastInteractionAt: null,
      lastActivityAt: null,
      hasOutboundInteraction: false,
      lastEnquiryOrPaymentAt: null,
      lastInterestAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// activity and stage
// ---------------------------------------------------------------------------

describe("metrics: activity markers and stage", () => {
  it("writes last enquiry / interaction / activity", async () => {
    const sales = await makeUser();
    const c = await makeContact();
    await addEnquiry(c.id, ago(10));
    await addEnquiry(c.id, ago(4));
    await addInteraction(c.id, sales.id, ago(6));
    await addInteraction(c.id, null, ago(2)); // inbound chat logged by the system
    await recomputeContact(c.id);
    const r = await row(c.id);
    expect(r.lastEnquiryAt?.getTime()).toBe(ago(4).getTime());
    expect(r.lastInteractionAt?.getTime()).toBe(ago(2).getTime());
    expect(r.lastActivityAt?.getTime()).toBe(ago(2).getTime());
    const a = await computeActivityFacts(c.id);
    expect(a.hasOutboundInteraction).toBe(true);
    expect(a.lastEnquiryOrPaymentAt?.getTime()).toBe(ago(4).getTime());
  });

  it("system-logged interactions do not make a contact Contacted", async () => {
    const c = await makeContact();
    await addInteraction(c.id, null, ago(1));
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("new");
  });

  it("moves new -> contacted -> first_purchase -> repeat -> advocate, auditing each change with no user", async () => {
    const sales = await makeUser();
    const c = await makeContact();
    await addEnquiry(c.id, ago(3));
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("new");

    await addInteraction(c.id, sales.id, ago(2));
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("contacted");

    await buy(c.id, { at: ago(1) });
    await recomputeContact(c.id);
    const fp = await row(c.id);
    expect(fp.stage).toBe("first_purchase");
    expect(Math.abs(fp.stageChangedAt.getTime() - Date.now())).toBeLessThan(60_000);

    await buy(c.id, { family: "applied_ai_mastery", amount: 25000, at: ago(0) });
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("repeat");

    const friend = await makeContact({ referredById: c.id });
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("repeat"); // a referred lead who has not paid does not count
    await buy(friend.id, { at: ago(0) });
    await recomputeReferrerChain(friend.id);
    expect((await row(c.id)).stage).toBe("advocate");
    expect((await row(friend.id)).stage).toBe("first_purchase");

    const audits = await stageAudits(c.id);
    expect(audits.map((a) => [a.oldValue, a.newValue])).toEqual([
      ["new", "contacted"],
      ["contacted", "first_purchase"],
      ["first_purchase", "repeat"],
      ["repeat", "advocate"],
    ]);
    expect(audits.every((a) => a.userId === null && a.action === "update")).toBe(true);
  });

  it("a checkout buyer jumps from New straight to First purchase", async () => {
    const c = await makeContact();
    await buy(c.id, { at: ago(0) });
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("first_purchase");
    expect((await stageAudits(c.id)).map((a) => a.newValue)).toEqual(["first_purchase"]);
  });

  it("goes Dormant after dormantDays with no activity, and a new enquiry pulls it back", async () => {
    const c = await makeContact({ createdAt: ago(400), stageChangedAt: ago(400) });
    await buy(c.id, { at: ago(300) });
    await recomputeContact(c.id);
    const d = await row(c.id);
    expect(d.stage).toBe("dormant");

    await addEnquiry(c.id, ago(0));
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("first_purchase");
    expect((await stageAudits(c.id)).map((a) => [a.oldValue, a.newValue])).toEqual([
      ["new", "dormant"],
      ["dormant", "first_purchase"],
    ]);
  });

  it("a lead with no activity since creation goes Dormant; the threshold comes from settings", async () => {
    const c = await makeContact({ createdAt: ago(40) });
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("new");
    await setSetting("thresholds", { ...DEFAULT_SETTINGS.thresholds, dormantDays: 30 }, null);
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("dormant");
  });

  it("Lost stays Lost until a new enquiry or payment arrives, then is pulled back and the reason cleared", async () => {
    const sales = await makeUser();
    const c = await makeContact();
    await addEnquiry(c.id, ago(20));
    await addInteraction(c.id, sales.id, ago(19));
    await db.update(contacts).set({ stage: "lost", lostReason: "price", stageChangedAt: ago(10) }).where(eq(contacts.id, c.id));

    await recomputeContact(c.id);
    expect(await row(c.id)).toMatchObject({ stage: "lost", lostReason: "price" });

    await addInteraction(c.id, sales.id, ago(1)); // a sales call does not reopen it
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("lost");

    await addEnquiry(c.id, ago(0));
    await recomputeContact(c.id);
    expect(await row(c.id)).toMatchObject({ stage: "contacted", lostReason: null });
    const reasons = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.rowId, c.id), eq(auditLog.field, "lost_reason")));
    expect(reasons.map((a) => [a.oldValue, a.newValue, a.userId])).toEqual([["price", null, null]]);
  });

  it("a payment pulls a Lost contact back to the right customer stage", async () => {
    const c = await makeContact();
    await buy(c.id, { at: ago(100) });
    await db.update(contacts).set({ stage: "lost", lostReason: "timing", stageChangedAt: ago(50) }).where(eq(contacts.id, c.id));
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("lost");
    await buy(c.id, { at: ago(0), family: "applied_ai_mastery", amount: 25000 });
    await recomputeContact(c.id);
    expect(await row(c.id)).toMatchObject({ stage: "repeat", lostReason: null });
  });

  it("Qualified stays Qualified until they pay", async () => {
    const c = await makeContact();
    await addEnquiry(c.id, ago(1));
    await db.update(contacts).set({ stage: "qualified" }).where(eq(contacts.id, c.id));
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("qualified");
    await buy(c.id);
    await recomputeContact(c.id);
    expect((await row(c.id)).stage).toBe("first_purchase");
  });

  it("recomputing twice changes nothing and writes no extra audit rows", async () => {
    const c = await makeContact();
    await buy(c.id, { at: ago(3) });
    await recomputeContact(c.id, db, { now: NOW });
    const first = await row(c.id);
    await recomputeContact(c.id, db, { now: NOW });
    const second = await row(c.id);
    expect(second).toEqual(first);
    expect(await stageAudits(c.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// scores end to end
// ---------------------------------------------------------------------------

describe("metrics: scores end to end from raw rows", () => {
  it("worked example 1: GCC business owner -> 100/92/92/94/A", async () => {
    const sales = await makeUser({ team: "dubai" });
    const c = await makeContact({
      phoneE164: "+971501234567",
      phoneCountry: "AE",
      country: "AE",
      city: "Dubai",
      industry: "business_owner",
      ageBand: "35-44",
      spendingBand: 5,
      umerLevel: 4,
      aiLevel: 3,
    });
    // ₹1.2 lakh over 4 purchases in 3 lines, the last one 2 months ago
    await buy(c.id, { family: "workshop", amount: 1000, at: ago(300) });
    await buy(c.id, { family: "applied_ai_mastery", amount: 25000, at: ago(200) });
    await buy(c.id, { family: "workshop", amount: 1000, at: ago(150) });
    await buy(c.id, { family: "ai_office", amount: 93000, at: ago(61) });
    // chatted this week
    await addInteraction(c.id, sales.id, ago(2));
    // 2 referrals who paid
    for (let i = 0; i < 2; i++) {
      const r = await makeContact({ referredById: c.id });
      await buy(r.id, { amount: 999, at: ago(30) });
    }

    await recomputeContact(c.id);
    const r = await row(c.id);
    expect([r.fit, r.readiness, r.value, r.edaptScore, r.grade]).toEqual([100, 92, 92, 94, "A"]);
    expect(r).toMatchObject({
      ltvInr: 120000,
      purchaseCount: 4,
      familyCount: 3,
      currentRung: 3,
      referralCount: 2,
      networkValueInr: 1998,
      stage: "advocate",
      nextOffer: "The AI Office renewal, and ask for referrals",
    });
    expect(r.scoredAt).not.toBeNull();
  });

  it("worked example 3: workshop buyer, nothing rated, rest of Kerala, ₹699 five days ago -> 47/53/30/40/C", async () => {
    const c = await makeContact({ country: "IN", state: "Kerala", city: "Malappuram" });
    await buy(c.id, { family: "workshop", amount: 699, at: ago(5) });
    await recomputeContact(c.id);
    const r = await row(c.id);
    expect([r.fit, r.readiness, r.value, r.edaptScore, r.grade]).toEqual([47, 53, 30, 40, "C"]);
    expect(r).toMatchObject({ stage: "first_purchase", ltvInr: 699, nextOffer: "A workshop on a different topic" });
  });

  it("worked examples 2 and 4 as leads: value stays null", async () => {
    const two = await makeContact({ country: "IN", city: "Kochi", industry: "business_owner", ageBand: "35-44", spendingBand: 4, umerLevel: 3, aiLevel: 2 });
    await addEnquiry(two.id, ago(0));
    const four = await makeContact({ country: "IN", state: "Maharashtra", city: "Pune ", industry: "student", ageBand: "18-24", spendingBand: 1, umerLevel: 0, aiLevel: 1 });
    await addEnquiry(four.id, ago(61));
    await db.update(contacts).set({ city: "Nagpur" }).where(eq(contacts.id, four.id));
    await recomputeContacts([two.id, four.id]);
    const r2 = await row(two.id);
    const r4 = await row(four.id);
    expect([r2.fit, r2.readiness, r2.value, r2.edaptScore, r2.grade]).toEqual([88, 84, null, 86, "A"]);
    expect([r4.fit, r4.readiness, r4.value, r4.edaptScore, r4.grade]).toEqual([30, 30, null, 30, "D"]);
    expect(r2.expected90dInr).toBeNull();
    expect(r2.repeatProb90d).toBeNull();
    expect(r2.nextOffer).toBe("Entry workshop (₹699 to ₹999)");
  });

  it("gut stars and edited scoring weights apply on the next recompute", async () => {
    const c = await makeContact({ country: "IN", state: "Kerala", city: "Malappuram", gutStars: 5 });
    await buy(c.id, { amount: 699, at: ago(5) });
    await recomputeContact(c.id);
    expect((await row(c.id)).edaptScore).toBe(50);
    const scoring = structuredClone(DEFAULT_SETTINGS.scoring);
    scoring.grades = { A: 90, B: 80, C: 60 };
    await setSetting("scoring", scoring, null);
    await recomputeContact(c.id);
    expect((await row(c.id)).grade).toBe("D");
  });

  it("skips merged contacts and unknown ids", async () => {
    const winner = await makeContact();
    const loser = await makeContact({ mergedIntoId: winner.id, mergedAt: NOW });
    await buy(loser.id, { at: ago(1) });
    await recomputeContact(loser.id);
    const l = await row(loser.id);
    expect(l.purchaseCount).toBe(0);
    expect(l.scoredAt).toBeNull();
    await expect(recomputeContact("00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
  });

  it("composes inside a caller's transaction", async () => {
    const c = await makeContact();
    await db.transaction(async (tx) => {
      const p = await tx
        .insert(purchases)
        .values({ contactId: c.id, productName: "W", family: "workshop", amount: 999, amountInr: 999, mode: "tagmango", status: "paid", reference: "TX-1" })
        .returning();
      await tx.insert(payments).values({ purchaseId: p[0].id, contactId: c.id, amount: 999, amountInr: 999, status: "verified", paidAt: NOW });
      await recomputeContact(c.id, tx);
      const [inside] = await tx.select().from(contacts).where(eq(contacts.id, c.id));
      expect(inside.ltvInr).toBe(999);
    });
    expect((await row(c.id)).ltvInr).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// referrals and network value
// ---------------------------------------------------------------------------

describe("metrics: referrals and network value", () => {
  it("network value = sum of the LTV of the contacts they referred; referral count = those who paid", async () => {
    const referrer = await makeContact();
    const a = await makeContact({ referredById: referrer.id });
    const b = await makeContact({ referredById: referrer.id });
    const unpaid = await makeContact({ referredById: referrer.id });
    const merged = await makeContact({ referredById: referrer.id, mergedIntoId: a.id });
    const stranger = await makeContact();
    await buy(a.id, { amount: 5000 });
    const pb = await buy(b.id, { amount: 3000 });
    await addPayment(pb, { kind: "refund", amount: 1000 });
    const pu = await addPurchase(unpaid.id, { amount: 4000, status: "pending" });
    await addPayment(pu, { amount: 4000, status: "unverified" });
    await buy(merged.id, { amount: 7000 });
    await buy(stranger.id, { amount: 9000 });

    expect(await computeReferralFacts(referrer.id)).toEqual({ referralCount: 2, networkValueInr: 7000 });
    await recomputeContact(referrer.id);
    expect(await row(referrer.id)).toMatchObject({ referralCount: 2, networkValueInr: 7000, purchaseCount: 0, stage: "new" });
  });

  it("recomputeReferrerChain refreshes the referrer after the referred contact pays (following merges)", async () => {
    const old = await makeContact();
    const referrer = await makeContact();
    await db.update(contacts).set({ mergedIntoId: referrer.id }).where(eq(contacts.id, old.id));
    const c = await makeContact({ referredById: old.id });
    await buy(referrer.id, { at: ago(30) });
    await recomputeContact(referrer.id);
    expect((await row(referrer.id)).stage).toBe("first_purchase");

    // the referred_by link still points at the merged-away record; nothing counts it for the survivor
    await buy(c.id, { amount: 2500 });
    await recomputeReferrerChain(c.id);
    expect((await row(c.id)).ltvInr).toBe(2500);
    // the referrer was recomputed (scored now), but network value counts referred_by_id = referrer only
    expect((await row(referrer.id)).networkValueInr).toBe(0);

    await db.update(contacts).set({ referredById: referrer.id }).where(eq(contacts.id, c.id));
    await recomputeReferrerChain(c.id);
    expect(await row(referrer.id)).toMatchObject({ networkValueInr: 2500, referralCount: 1, stage: "advocate" });
  });
});

// ---------------------------------------------------------------------------
// cohorts, repeat probability, next best offer, forecast
// ---------------------------------------------------------------------------

describe("metrics: cohorts and the 90-day forecast", () => {
  /**
   * 30 workshop-first customers: 12 bought again 20 days later, 6 bought again 200 days later, 12 bought once.
   * 3 Applied-AI-Mastery-first customers: one repeated within 50 days (second purchase still too recent to
   * judge), one bought 10 days ago (too recent), one bought once 300 days ago.
   */
  async function history() {
    const w: string[] = [];
    for (let i = 0; i < 30; i++) {
      const c = await makeContact();
      w.push(c.id);
      await buy(c.id, { family: "workshop", amount: 999, at: ago(400) });
      if (i < 12) await buy(c.id, { family: "applied_ai_mastery", amount: 25000, at: ago(380) });
      else if (i < 18) await buy(c.id, { family: "workshop", amount: 699, at: ago(200) });
    }
    const a1 = await makeContact();
    await buy(a1.id, { family: "applied_ai_mastery", amount: 25000, at: ago(100) });
    await buy(a1.id, { family: "workshop", amount: 999, at: ago(50) });
    const a2 = await makeContact();
    await buy(a2.id, { family: "applied_ai_mastery", amount: 25000, at: ago(10) });
    const a3 = await makeContact();
    await buy(a3.id, { family: "applied_ai_mastery", amount: 25000, at: ago(300) });
    // never counted: merged customers, pending and cancelled purchases
    const winner = await makeContact();
    const merged = await makeContact({ mergedIntoId: winner.id });
    await buy(merged.id, { family: "workshop", at: ago(400) });
    await buy(merged.id, { family: "workshop", at: ago(390) });
    const pendingOnly = await makeContact();
    await addPurchase(pendingOnly.id, { family: "workshop", at: ago(400), status: "pending" });
    await addPurchase(pendingOnly.id, { family: "workshop", at: ago(395), status: "cancelled" });
    return { w, a1, a2, a3 };
  }

  it("buildCohorts: per-cohort rates, company rate, median first gap; saved to settings", async () => {
    await history();
    const t = await buildCohorts(db, NOW);
    expect(t.cohorts["workshop:1"]).toEqual({ n: 30, repeated: 12, rate: 0.4 });
    expect(t.cohorts["workshop:2"]).toEqual({ n: 18, repeated: 0, rate: 0 });
    expect(t.cohorts["applied_ai_mastery:1"]).toEqual({ n: 2, repeated: 1, rate: 0.5 });
    expect(t.cohorts["applied_ai_mastery:2"]).toBeUndefined();
    expect(Object.keys(t.cohorts).sort()).toEqual(["applied_ai_mastery:1", "workshop:1", "workshop:2"]);
    expect(t.companyRate).toBe(13 / 50);
    expect(t.medianFirstGapDays).toBe(20); // 12 x 20, 1 x 50, 6 x 200
    expect(t.builtAt).toBe(NOW.toISOString());
    expect(await getSetting("metrics.cohorts")).toEqual(t);
  });

  it("buildCohorts: the median interpolates; nothing bought -> nulls; exactly-the-window gaps count as repeated", async () => {
    expect(await buildCohorts(db, NOW)).toMatchObject({ companyRate: null, medianFirstGapDays: null, cohorts: {} });
    const a = await makeContact();
    await buy(a.id, { at: ago(300) });
    await buy(a.id, { at: ago(210) }); // exactly 90 days later
    const b = await makeContact();
    await buy(b.id, { at: ago(300) });
    await buy(b.id, { at: ago(285) });
    const t = await buildCohorts(db, NOW);
    expect(t.medianFirstGapDays).toBe(52.5); // (90 + 15) / 2
    expect(t.cohorts["workshop:1"]).toEqual({ n: 2, repeated: 2, rate: 1 });
    expect(t.cohorts["workshop:2"]).toEqual({ n: 2, repeated: 0, rate: 0 });
  });

  it("buildCohorts ignores purchases after `now` (rebuilds history as of a date)", async () => {
    const a = await makeContact();
    await buy(a.id, { at: ago(300) });
    await buy(a.id, { at: ago(280) });
    const asOf = ago(290);
    const t = await buildCohorts(db, asOf);
    // as of 290 days ago only the first purchase existed, and it was 10 days old: outcome unknown
    expect(t.cohorts).toEqual({});
    expect(t.medianFirstGapDays).toBeNull();
  });

  it("recomputeAll: rebuilds cohorts first, then writes repeat probability, expected date, at risk, offer and forecast", async () => {
    const aam = await db
      .insert(products)
      .values({ name: "Applied AI Mastery", family: "applied_ai_mastery", rung: 2, listPrice: 25000, currency: "INR" })
      .returning();
    const { w, a1, a2, a3 } = await history();
    const lead = await makeContact();
    const keen = await makeContact({ country: "IN", city: "Kochi", industry: "senior_manager", ageBand: "35-44", spendingBand: 5 });
    await buy(keen.id, { family: "workshop", amount: 999, at: ago(10) });

    const progress: [number, number][] = [];
    const n = await recomputeAll({ now: NOW, batchSize: 7, onProgress: (d, t) => progress.push([d, t]) });
    // every non-merged contact is written (merged ones are skipped)
    const live = (await db.select({ id: contacts.id, merged: contacts.mergedIntoId }).from(contacts)).filter((c) => !c.merged);
    expect(n).toBe(live.length);
    expect(progress[progress.length - 1]).toEqual([live.length, live.length]);
    expect(progress.length).toBe(Math.ceil(live.length / 7));

    // a one-time workshop buyer: cohort workshop:1 (n = 30) -> 0.4; expected = 400 days ago + median 20 -> at risk
    const once = await row(w[20]);
    expect(once.repeatProb90d).toBe(0.4);
    expect(once.avgGapDays).toBeNull();
    expect(once.nextExpectedAt?.getTime()).toBe(ago(380).getTime());
    expect(once.atRisk).toBe(true);
    expect(once.nextOffer).toBe("A workshop on a different topic");
    expect(once.expected90dInr).toBe(399.6); // 0.4 x ₹999

    // a two-time workshop buyer: cohort workshop:2 has 18 < 30 -> company rate 0.26
    const twice = await row(w[15]);
    expect(twice.repeatProb90d).toBe(0.26);
    expect(twice.avgGapDays).toBe(200);
    expect(twice.stage).toBe("dormant"); // last purchase 200 days ago

    // an AAM graduate with a workshop: avg gap 50, next expected 0 days ago, not at risk
    const grad = await row(a1.id);
    expect(grad.avgGapDays).toBe(50);
    expect(grad.nextExpectedAt?.getTime()).toBe(NOW.getTime());
    expect(grad.atRisk).toBe(false);
    expect(grad.repeatProb90d).toBe(0.26); // cohort applied_ai_mastery:2 does not exist
    expect(grad.nextOffer).toBe("The AI Office or advanced workshops");
    expect(grad.expected90dInr).toBeNull(); // no rung-3 product in the catalogue

    expect((await row(a2.id)).repeatProb90d).toBe(0.26); // applied_ai_mastery:1 has n = 2 -> company rate
    expect((await row(a3.id)).atRisk).toBe(true);

    // a workshop buyer with Fit >= 60: Applied AI Mastery, priced from the catalogue's rung-2 product
    const w2 = await row(keen.id);
    expect(w2.fit).toBe(90);
    expect(w2.nextOffer).toBe("Applied AI Mastery");
    expect(w2.nextOfferProductId).toBe(aam[0].id);
    expect(w2.expected90dInr).toBe(10000); // 0.4 x 25000

    // a lead: an offer but no forecast
    const l = await row(lead.id);
    expect(l).toMatchObject({ nextOffer: "Entry workshop (₹699 to ₹999)", repeatProb90d: null, expected90dInr: null, value: null });
  });

  it("an explicit product on a rule prices the offer", async () => {
    const office = await db
      .insert(products)
      .values({ name: "The AI Office", family: "ai_office", rung: 3, listPrice: 1000, currency: "AED" })
      .returning();
    const rules = DEFAULT_SETTINGS["nbo.rules"].map((r) => (r.id === "aam_graduate" ? { ...r, productId: office[0].id } : r));
    await setSetting("nbo.rules", rules, null);
    await setSetting("metrics.cohorts", { builtAt: null, companyRate: 0.5, medianFirstGapDays: null, cohorts: {} }, null);
    const c = await makeContact();
    await buy(c.id, { family: "applied_ai_mastery", amount: 25000, at: ago(10) });
    await recomputeContact(c.id);
    const r = await row(c.id);
    expect(r.nextOfferProductId).toBe(office[0].id);
    // 1000 AED at this month's rate from settings
    const rate = Object.entries(DEFAULT_SETTINGS.currency.rates.AED).sort()[Object.keys(DEFAULT_SETTINGS.currency.rates.AED).length - 1][1];
    expect(r.expected90dInr).toBe(Math.round(0.5 * 1000 * rate * 100) / 100);
  });
});
