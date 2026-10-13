import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { contacts, payments, purchases, type NewContact } from "@/db/schema";
import {
  cancelPurchase,
  listPaymentsQueue,
  recordPurchase,
  rejectPayment,
  verifyPayment,
  type RecordPurchaseInput,
} from "@/lib/money/purchases";
import { localIsoDate } from "@/lib/today/time";
import {
  countRecentPurchases,
  dueWindowEnd,
  getDeskTotals,
  getPaymentContext,
  getPurchaseAudit,
  getPurchaseContext,
  getPurchaseDetail,
  listCreditOptions,
  listInstalmentsDue,
  listProductOptions,
  listRecentPurchases,
  listUnverified,
  userNames,
} from "@/app/(app)/payments/_lib/queries";
import { dueDateFromInput, moneyDateFromInput, moneyFailureFor } from "@/app/(app)/payments/_lib/forms";
import { DuplicateReferenceError } from "@/lib/money/errors";
import { makeUser, resetDb } from "../support/db";

const TZ = "Asia/Kolkata";
const DAY = 86_400_000;

let phoneN = 0;
async function makeContact(over: Partial<NewContact> = {}) {
  phoneN += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9192000${String(phoneN).padStart(5, "0")}`, name: `Contact ${phoneN}`, firstDoor: "youtube", ...over })
    .returning();
  return c;
}
let utrN = 0;
const utr = () => `DESKUTR${++utrN}`;
const base = (contactId: string, over: Partial<RecordPurchaseInput> = {}): RecordPurchaseInput => ({
  contactId,
  productName: "Prompting workshop",
  family: "workshop",
  amount: 999,
  currency: "INR",
  mode: "upi_qr",
  source: "manual",
  ...over,
});
/** the due moment the Record payment form stores for "N local days from today" */
const dueIn = (now: Date, days: number) => dueDateFromInput(localIsoDate(new Date(now.getTime() + days * DAY), TZ), TZ)!;

describe("payments desk queries", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function world() {
    const now = new Date();
    const admin = await makeUser({ role: "admin", name: "Umer" });
    const manager = await makeUser({ role: "manager", name: "Mira" });
    const salesA = await makeUser({ role: "sales", name: "Anu" });
    const salesB = await makeUser({ role: "sales", name: "Basil" });
    const support = await makeUser({ role: "support", name: "Sam" });
    const cA = await makeContact({ name: "Asha", ownerId: salesA.id });
    const cB = await makeContact({ name: "Bilal", ownerId: salesB.id });
    const cPool = await makeContact({ name: "Pooja", ownerId: null });

    // unverified claims: Asha 3 days ago (stale), Pooja 1 day ago, Bilal today (AED)
    const claimA = await recordPurchase(base(cA.id, { reference: utr(), purchasedAt: new Date(now.getTime() - 3 * DAY), proofUrl: "/api/files/proofs/a.png" }), salesA);
    const claimPool = await recordPurchase(base(cPool.id, { mode: "cash", amount: 1500, purchasedAt: new Date(now.getTime() - 1 * DAY) }), salesA);
    const claimB = await recordPurchase(base(cB.id, { reference: utr(), amount: 100, currency: "AED", mode: "bank_transfer" }), salesB);

    // a verified one (not on the queue) and a cancelled claim (never on the queue)
    const verified = await recordPurchase(base(cA.id, { reference: utr(), amount: 24999, productName: "Applied AI Mastery", family: "applied_ai_mastery" }), manager);
    await verifyPayment(verified.paymentIds[0], manager);
    const cancelled = await recordPurchase(base(cA.id, { reference: utr() }), salesA);
    await cancelPurchase(cancelled.purchaseId, salesA, "Wrong contact");

    // EMI on Bilal: overdue (2 days ago), due tomorrow, due at the end of the window (3 days), later (4 and 20 days)
    const emiB = await recordPurchase(
      base(cB.id, {
        amount: 50000,
        productName: "Premium program",
        family: "premium",
        mode: "bank_transfer",
        purchasedAt: new Date(now.getTime() - 10 * DAY),
        instalments: [
          { amount: 10000, dueAt: dueIn(now, -2) },
          { amount: 10000, dueAt: dueIn(now, 1) },
          { amount: 10000, dueAt: dueIn(now, 3) },
          { amount: 10000, dueAt: dueIn(now, 4) },
          { amount: 10000, dueAt: dueIn(now, 20) },
        ],
        paidNow: null,
      }),
      salesB,
    );
    // EMI on Asha: one overdue instalment
    const emiA = await recordPurchase(
      base(cA.id, {
        amount: 2000,
        mode: "upi_qr",
        purchasedAt: new Date(now.getTime() - 40 * DAY),
        instalments: [
          { amount: 1000, dueAt: dueIn(now, -30) },
          { amount: 1000, dueAt: dueIn(now, -5) },
        ],
        paidNow: { amount: 1000, reference: utr(), paidAt: new Date(now.getTime() - 30 * DAY) },
      }),
      salesA,
    );

    // a merged-away contact keeps old rows that must never show
    const cMerged = await makeContact({ name: "Ghost", ownerId: salesA.id, mergedIntoId: cA.id, mergedAt: now });
    const [ghost] = await db
      .insert(purchases)
      .values({ contactId: cMerged.id, productName: "Ghost", family: "workshop", amount: 999, amountInr: 999, mode: "cash" })
      .returning();
    await db.insert(payments).values({ purchaseId: ghost.id, contactId: cMerged.id, amount: 999, amountInr: 999, status: "unverified", paidAt: now });

    return { now, admin, manager, salesA, salesB, support, cA, cB, cPool, claimA, claimPool, claimB, verified, cancelled, emiA, emiB };
  }

  it("lists unverified claims oldest first, with names and the purchase proof, and nothing cancelled or merged", async () => {
    const w = await world();
    const rows = await listUnverified(w.manager);
    // Asha's first EMI instalment (claimed 30 days ago), Asha's one-off (3 days), Pooja (1 day), Bilal (today)
    expect(rows.map((r) => r.contactName)).toEqual(["Asha", "Asha", "Pooja", "Bilal"]);
    expect(rows[0]).toMatchObject({ purchaseId: w.emiA.purchaseId, hasInstalments: true, seq: 1, instalmentCount: 2 });
    expect(rows[1]).toMatchObject({
      paymentId: w.claimA.paymentIds[0],
      purchaseId: w.claimA.purchaseId,
      ownerName: "Anu",
      recordedByName: "Anu",
      reference: "DESKUTR1",
      purchaseProofUrl: "/api/files/proofs/a.png",
      hasInstalments: false,
      instalmentCount: 1,
    });
    expect(rows[3]).toMatchObject({ currency: "AED", amount: 100, amountInr: 2270 });
    expect(rows[2].ownerName).toBeNull();

    // the desk agrees with the alert's queue
    const queue = await listPaymentsQueue("unverified", db, w.now);
    expect(rows.map((r) => r.paymentId)).toEqual(queue.map((r) => r.paymentId));

    // pagination
    expect((await listUnverified(w.manager, { limit: 3 })).map((r) => r.contactName)).toEqual(["Asha", "Asha", "Pooja"]);
    expect((await listUnverified(w.manager, { limit: 3, offset: 3 })).map((r) => r.contactName)).toEqual(["Bilal"]);

    // verified and rejected claims leave the queue
    await verifyPayment(w.claimPool.paymentIds[0], w.manager);
    await rejectPayment(w.claimB.paymentIds[0], w.manager, "Not in the bank statement");
    expect((await listUnverified(w.admin)).map((r) => r.contactName)).toEqual(["Asha", "Asha"]);
  });

  it("limits salespeople to their own contacts and the pool", async () => {
    const w = await world();
    expect((await listUnverified(w.salesA)).map((r) => r.contactName)).toEqual(["Asha", "Asha", "Pooja"]);
    expect((await listUnverified(w.salesB)).map((r) => r.contactName)).toEqual(["Pooja", "Bilal"]);
    expect((await listUnverified(w.support)).length).toBe(4);

    const dueA = await listInstalmentsDue(w.salesA, { now: w.now, timeZone: TZ, withinDays: 3 });
    expect(dueA.map((r) => r.contactName)).toEqual(["Asha"]);
    const dueB = await listInstalmentsDue(w.salesB, { now: w.now, timeZone: TZ, withinDays: 3 });
    expect(dueB.every((r) => r.contactName === "Bilal")).toBe(true);

    const recentA = await listRecentPurchases(w.salesA);
    expect(new Set(recentA.map((r) => r.contactName))).toEqual(new Set(["Asha", "Pooja"]));
    expect(await countRecentPurchases(w.salesA)).toBe(recentA.length);
    expect(await countRecentPurchases(w.manager)).toBe(7);

    const totalsA = await getDeskTotals(w.salesA, { now: w.now, timeZone: TZ, withinDays: 3, staleDays: 2 });
    expect(totalsA).toMatchObject({ unverifiedCount: 3, unverifiedInr: 1000 + 999 + 1500, staleCount: 2, overdueCount: 1, dueSoonCount: 0 });
  });

  it("lists overdue and due-soon instalments by local calendar day, most overdue first", async () => {
    const w = await world();
    const rows = await listInstalmentsDue(w.manager, { now: w.now, timeZone: TZ, withinDays: 3 });
    // Asha's #2 (5 days overdue), Bilal's #1 (2 days overdue), Bilal's #2 (tomorrow), Bilal's #3 (end of day 3)
    expect(rows.map((r) => [r.contactName, r.seq])).toEqual([
      ["Asha", 2],
      ["Bilal", 1],
      ["Bilal", 2],
      ["Bilal", 3],
    ]);
    expect(rows[1]).toMatchObject({ hasInstalments: true, instalmentCount: 5, amount: 10000, purchaseId: w.emiB.purchaseId });

    // a 1-day window keeps only the overdue ones and tomorrow's
    expect((await listInstalmentsDue(w.manager, { now: w.now, timeZone: TZ, withinDays: 1 })).length).toBe(3);
    // a 0-day window: overdue only
    expect((await listInstalmentsDue(w.manager, { now: w.now, timeZone: TZ, withinDays: 0 })).length).toBe(2);

    // overdue matches the alert's queue
    const overdue = await listPaymentsQueue("overdue", db, w.now);
    expect(rows.filter((r) => r.dueAt! < w.now).map((r) => r.paymentId)).toEqual(overdue.map((r) => r.paymentId));

    const totals = await getDeskTotals(w.manager, { now: w.now, timeZone: TZ, withinDays: 3, staleDays: 2 });
    expect(totals).toEqual({
      unverifiedCount: 4,
      unverifiedInr: 1000 + 999 + 1500 + 2270,
      staleCount: 2,
      overdueCount: 2,
      overdueInr: 11000,
      dueSoonCount: 2,
      dueSoonInr: 20000,
    });
    // the threshold is a setting: a 5-day rule only finds the claim from 30 days ago
    expect((await getDeskTotals(w.manager, { now: w.now, timeZone: TZ, withinDays: 3, staleDays: 5 })).staleCount).toBe(1);
  });

  it("ends the due window at local midnight after the last day", () => {
    const now = new Date("2026-10-13T04:30:00Z"); // 10:00 IST
    expect(dueWindowEnd(now, TZ, 3).toISOString()).toBe("2026-10-16T18:30:00.000Z"); // 17 Oct 00:00 IST
    expect(dueWindowEnd(now, "Asia/Dubai", 0).toISOString()).toBe("2026-10-13T20:00:00.000Z"); // 14 Oct 00:00 GST
  });

  it("shows recent purchases newest first with money received and claims waiting", async () => {
    const w = await world();
    const rows = await listRecentPurchases(w.manager);
    expect(rows[0].purchasedAt.getTime()).toBeGreaterThanOrEqual(rows[rows.length - 1].purchasedAt.getTime());
    const aam = rows.find((r) => r.purchaseId === w.verified.purchaseId)!;
    expect(aam).toMatchObject({ status: "paid", receivedInr: 24999, unverifiedCount: 0, productName: "Applied AI Mastery" });
    const claim = rows.find((r) => r.purchaseId === w.claimA.purchaseId)!;
    expect(claim).toMatchObject({ status: "pending", receivedInr: 0, unverifiedCount: 1 });
    expect(rows.find((r) => r.purchaseId === w.cancelled.purchaseId)?.status).toBe("cancelled");
    expect(rows.some((r) => r.productName === "Ghost")).toBe(false);
    expect(await listRecentPurchases(w.manager, { limit: 2, offset: 6 })).toHaveLength(1);
  });

  it("loads one purchase with its payments, totals, names and audit trail", async () => {
    const w = await world();
    const d = (await getPurchaseDetail(w.emiA.purchaseId))!;
    expect(d.contact).toMatchObject({ id: w.cA.id, name: "Asha", ownerName: "Anu" });
    expect(d.createdByName).toBe("Anu");
    expect(d.payments.map((p) => [p.seq, p.status])).toEqual([
      [1, "unverified"],
      [2, "scheduled"],
    ]);
    expect(d.payments[0].recordedByName).toBe("Anu");
    expect(d.totals).toMatchObject({ paid: 0, unverified: 1000, scheduled: 1000, outstanding: 2000 });

    await verifyPayment(d.payments[0].id, w.manager);
    const after = (await getPurchaseDetail(w.emiA.purchaseId))!;
    expect(after.payments[0]).toMatchObject({ status: "verified", verifiedByName: "Mira" });
    expect(after.totals).toMatchObject({ paid: 1000, netInr: 1000, outstanding: 1000 });

    const audit = await getPurchaseAudit(w.emiA.purchaseId, after.payments.map((p) => p.id));
    expect(audit.map((a) => [a.tableName, a.action])).toEqual([
      ["payments", "verify"],
      ["purchases", "insert"],
    ]);
    expect(audit[0].userName).toBe("Mira");

    expect(await getPurchaseDetail("not-a-uuid")).toBeNull();
    expect(await getPurchaseDetail("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("finds the contact behind a payment or purchase for permission checks", async () => {
    const w = await world();
    expect(await getPaymentContext(w.claimB.paymentIds[0])).toMatchObject({
      purchaseId: w.claimB.purchaseId,
      contactId: w.cB.id,
      ownerId: w.salesB.id,
      mergedIntoId: null,
      purchaseStatus: "pending",
    });
    expect(await getPurchaseContext(w.cancelled.purchaseId)).toMatchObject({ contactId: w.cA.id, purchaseStatus: "cancelled", purchaseCurrency: "INR" });
    expect(await getPaymentContext("nope")).toBeNull();
    expect(await getPurchaseContext("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("lists credit options without support, keeping a past credit's user", async () => {
    const w = await world();
    const names = (await listCreditOptions(null)).map((o) => o.name);
    expect(names).toEqual(["Anu", "Basil", "Mira", "Umer"]);
    expect((await listCreditOptions(w.support.id)).map((o) => o.name)).toContain("Sam");
    expect((await userNames([w.salesA.id, "junk"])).get(w.salesA.id)).toBe("Anu");
    expect(await listProductOptions()).toEqual([]);
  });

  it("turns form dates into money moments in the user's time zone", () => {
    const now = new Date("2026-10-13T04:30:00Z");
    expect(moneyDateFromInput("2026-10-13", TZ, now)).toBe(now);
    expect(moneyDateFromInput("2026-10-01", TZ, now)?.toISOString()).toBe("2026-10-01T06:30:00.000Z");
    expect(moneyDateFromInput("2026-02-30", TZ, now)).toBeNull();
    expect(moneyDateFromInput(null, TZ, now)).toBeNull();
    expect(dueDateFromInput("2026-11-13", TZ)?.toISOString()).toBe("2026-11-13T18:29:00.000Z");
  });

  it("keeps the recorded EMI schedule intact when nothing is paid now", async () => {
    const w = await world();
    const rows = await db.select().from(payments).where(eq(payments.purchaseId, w.emiB.purchaseId));
    expect(rows.every((r) => r.status === "scheduled")).toBe(true);
    expect(rows).toHaveLength(5);
  });
  it("names the contact holding a duplicate UTR only to users who may see that contact", async () => {
    const w = await world();
    // Bilal's AED claim belongs to Basil; Pooja is in the pool
    const bilalRef = (await db.select().from(payments).where(eq(payments.id, w.claimB.paymentIds[0])))[0].reference!;
    let dupe: unknown;
    try {
      await recordPurchase(base(w.cA.id, { reference: bilalRef }), w.salesA);
    } catch (e) {
      dupe = e;
    }
    expect(dupe).toBeInstanceOf(DuplicateReferenceError);
    expect((dupe as DuplicateReferenceError).contactName).toBe("Bilal");

    const forSales = await moneyFailureFor(w.salesA, dupe);
    expect(forSales).toMatchObject({ ok: false });
    const salesMsg = forSales && !forSales.ok ? forSales.error : "";
    expect(salesMsg).not.toContain("Bilal");
    expect(salesMsg).toContain(bilalRef);
    expect(salesMsg).toContain("another customer");
    expect(forSales && !forSales.ok ? forSales.fieldErrors?.reference : null).toBe(salesMsg);

    const forOwner = await moneyFailureFor(w.salesB, dupe);
    expect(forOwner && !forOwner.ok ? forOwner.error : "").toContain("Bilal");
    const forManager = await moneyFailureFor(w.manager, dupe, { reference: "ref" });
    expect(forManager && !forManager.ok ? forManager.fieldErrors?.ref : "").toContain("Bilal");

    // a pool contact is visible to every salesperson
    const poolDupe = new DuplicateReferenceError({ reference: "X1", label: "UTR", contactId: w.cPool.id, contactName: "Pooja" });
    const pool = await moneyFailureFor(w.salesB, poolDupe);
    expect(pool && !pool.ok ? pool.error : "").toContain("Pooja");
    // unknown holder: nothing to hide
    const anon = await moneyFailureFor(w.salesB, new DuplicateReferenceError({ reference: "X2", label: "UTR" }));
    expect(anon && !anon.ok ? anon.error : "").toBe("This UTR (X2) is already recorded.");
  });
});
