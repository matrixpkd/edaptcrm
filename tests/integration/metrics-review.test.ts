/**
 * Adversarial review of the metrics module: regressions for defects found in review, plus edge cases the
 * first test pass did not cover. Rows are inserted directly (no money/contacts services).
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { contacts, enquiries, interactions, payments, purchases, type NewContact } from "@/db/schema";
import { computeActivityFactsBulk, computeMoneyFactsBulk, computeReferralFactsBulk } from "@/lib/metrics/facts";
import { recomputeAll, recomputeContact, recomputeContacts } from "@/lib/metrics/recompute";
import { makeUser, resetDb } from "../support/db";

const DAY = 24 * 3600 * 1000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let n = 0;
async function makeContact(over: Partial<NewContact> = {}) {
  n += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+91950${String(n).padStart(7, "0")}`, phoneCountry: "IN", name: `Review ${n}`, firstDoor: "youtube", ...over })
    .returning();
  return c;
}

async function addPurchase(contactId: string, over: { at?: Date; status?: "pending" | "paid" | "partial"; amount?: number; family?: string } = {}) {
  n += 1;
  const amount = over.amount ?? 999;
  const [p] = await db
    .insert(purchases)
    .values({
      contactId,
      productName: "Workshop",
      family: over.family ?? "workshop",
      amount,
      amountInr: amount,
      purchasedAt: over.at ?? NOW,
      mode: "bank_transfer",
      reference: `R-${n}`,
      status: over.status ?? "paid",
      source: "manual",
    })
    .returning();
  return p;
}

async function addPayment(
  p: { id: string; contactId: string; amount: number },
  over: { status?: "verified" | "unverified"; paidAt?: Date; verifiedAt?: Date | null } = {},
) {
  n += 1;
  const [pay] = await db
    .insert(payments)
    .values({
      purchaseId: p.id,
      contactId: p.contactId,
      amount: p.amount,
      amountInr: p.amount,
      paidAt: over.paidAt ?? NOW,
      status: over.status ?? "verified",
      verifiedAt: over.verifiedAt === undefined ? null : over.verifiedAt,
      reference: `PAY-${n}`,
    })
    .returning();
  return pay;
}

const row = async (id: string) => (await db.select().from(contacts).where(eq(contacts.id, id)))[0];

beforeEach(async () => {
  await resetDb();
});

describe("review: bulk facts scale past the Postgres bind-parameter limit", () => {
  it("computeMoneyFactsBulk accepts more than 65,535 contact ids in one call", async () => {
    const c = await makeContact();
    const p = await addPurchase(c.id, { amount: 1500 });
    await addPayment(p);
    const ids = [c.id, ...Array.from({ length: 70_000 }, () => randomUUID())];
    const money = await computeMoneyFactsBulk(ids);
    expect(money.size).toBe(70_001);
    expect(money.get(c.id)).toMatchObject({ ltvInr: 1500, purchaseCount: 1 });
    // the other bulk facts already bind one array parameter; keep them honest too
    expect((await computeReferralFactsBulk(ids)).size).toBe(70_001);
    expect((await computeActivityFactsBulk(ids)).size).toBe(70_001);
  });
});

describe("review: the nightly recompute never silently skips a contact", () => {
  it("a contact locked by another transaction during recomputeAll is recomputed once the lock is released", async () => {
    const a = await makeContact();
    const locked = await makeContact();
    const p = await addPurchase(locked.id, { at: ago(3) });
    await addPayment(p, { paidAt: ago(3) });

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let lockedNow!: () => void;
    const isLocked = new Promise<void>((r) => (lockedNow = r));
    // e.g. an owner reassignment holding the row while the nightly job runs; it does not recompute
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select id from contacts where id = ${locked.id} for update`);
      lockedNow();
      await released;
    });
    await isLocked;
    const timer = setTimeout(() => release(), 500);

    const written = await recomputeAll({ now: NOW, batchSize: 10 });
    clearTimeout(timer);
    release();
    await holder;

    expect(written).toBe(2);
    const r = await row(locked.id);
    expect(r.scoredAt).not.toBeNull();
    expect(r).toMatchObject({ purchaseCount: 1, ltvInr: 999, stage: "first_purchase" });
    expect((await row(a.id)).scoredAt).not.toBeNull();
  });
});

describe("review: Lost pull-back by a payment verified after Lost was set", () => {
  it("a bank transfer made before Lost but verified after it pulls the contact back to First purchase", async () => {
    const c = await makeContact();
    // the customer paid (unverified UTR) 5 days ago ...
    const p = await addPurchase(c.id, { at: ago(5), status: "pending" });
    const pay = await addPayment(p, { status: "unverified", paidAt: ago(5) });
    // ... the salesperson marked them Lost 2 days ago ...
    await db.update(contacts).set({ stage: "lost", lostReason: "timing", stageChangedAt: ago(2) }).where(eq(contacts.id, c.id));
    await recomputeContact(c.id, db, { now: NOW });
    expect((await row(c.id)).stage).toBe("lost");
    // ... and today the manager verifies the payment: real money arrived after Lost
    await db.update(payments).set({ status: "verified", verifiedAt: NOW }).where(eq(payments.id, pay.id));
    await db.update(purchases).set({ status: "paid" }).where(eq(purchases.id, p.id));
    await recomputeContact(c.id, db, { now: NOW });
    expect(await row(c.id)).toMatchObject({ stage: "first_purchase", lostReason: null, ltvInr: 999 });
  });

  it("a payment verified BEFORE Lost was set does not reopen it", async () => {
    const c = await makeContact();
    const p = await addPurchase(c.id, { at: ago(30) });
    await addPayment(p, { paidAt: ago(30), verifiedAt: ago(29) });
    await db.update(contacts).set({ stage: "lost", lostReason: "price", stageChangedAt: ago(2) }).where(eq(contacts.id, c.id));
    await recomputeContact(c.id, db, { now: NOW });
    expect((await row(c.id)).stage).toBe("lost");
  });
});

describe("review: edge cases", () => {
  it("a verified payment alone counts as recent activity: readiness and dormancy", async () => {
    const c = await makeContact({ createdAt: ago(400), stageChangedAt: ago(400) });
    const p = await addPurchase(c.id, { at: ago(300) });
    await addPayment(p, { paidAt: ago(300) });
    await recomputeContact(c.id, db, { now: NOW });
    expect((await row(c.id)).stage).toBe("dormant");
    // an EMI instalment paid today on the old purchase
    await addPayment(p, { paidAt: ago(0) });
    await recomputeContact(c.id, db, { now: NOW });
    const r = await row(c.id);
    expect(r.stage).toBe("first_purchase");
    expect(r.lastActivityAt?.getTime()).toBe(ago(0).getTime());
    // unrated: umer 8 + ai 15 + recent 30
    expect(r.readiness).toBe(53);
  });

  it("a referred contact with only an unverified payment adds no network value and is not a referral", async () => {
    const referrer = await makeContact();
    const friend = await makeContact({ referredById: referrer.id });
    const p = await addPurchase(friend.id, { status: "pending", amount: 5000 });
    await addPayment(p, { status: "unverified" });
    await recomputeContact(referrer.id, db, { now: NOW });
    expect(await row(referrer.id)).toMatchObject({ referralCount: 0, networkValueInr: 0, stage: "new" });
  });

  it("two concurrent payments on one contact both land in LTV (the row lock serialises recomputes)", async () => {
    const c = await makeContact();
    const p1 = await addPurchase(c.id, { amount: 1000 });
    const p2 = await addPurchase(c.id, { amount: 2000 });
    let go!: () => void;
    const hold = new Promise<void>((r) => (go = r));
    let firstDone!: () => void;
    const firstRecomputed = new Promise<void>((r) => (firstDone = r));
    const t1 = db.transaction(async (tx) => {
      await tx.insert(payments).values({ purchaseId: p1.id, contactId: c.id, amount: 1000, amountInr: 1000, status: "verified", paidAt: NOW });
      await recomputeContact(c.id, tx, { now: NOW });
      firstDone();
      await hold;
    });
    await firstRecomputed;
    const t2 = db.transaction(async (tx) => {
      await tx.insert(payments).values({ purchaseId: p2.id, contactId: c.id, amount: 2000, amountInr: 2000, status: "verified", paidAt: NOW });
      await recomputeContact(c.id, tx, { now: NOW }); // waits for t1's lock, then sees t1's payment
    });
    setTimeout(() => go(), 200);
    await Promise.all([t1, t2]);
    expect((await row(c.id)).ltvInr).toBe(3000);
  });

  it("recomputeContacts with duplicate, merged and unknown ids writes each live contact once", async () => {
    const a = await makeContact();
    const b = await makeContact();
    const merged = await makeContact({ mergedIntoId: a.id });
    const sales = await makeUser();
    await db.insert(interactions).values({ contactId: b.id, userId: sales.id, type: "call", occurredAt: ago(1) });
    await db.insert(enquiries).values({ contactId: a.id, channel: "whatsapp_api", receivedAt: ago(1) });
    const written = await recomputeContacts([a.id, a.id, b.id, merged.id, randomUUID()], db, { now: NOW });
    expect(written).toBe(2);
    expect((await row(b.id)).stage).toBe("contacted");
    expect((await row(merged.id)).scoredAt).toBeNull();
  });
});
