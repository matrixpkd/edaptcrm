/**
 * Regression tests from the adversarial review of the money module. Each block names the defect it pins down.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLog, contacts, enquiries, payments, purchases, tasks, type NewContact } from "@/db/schema";
import { createTask } from "@/lib/alerts/core";
import { DuplicateReferenceError, ValidationError } from "@/lib/money/errors";
import {
  addPayment,
  cancelPurchase,
  listPaymentsQueue,
  recordInstalmentPayment,
  recordPurchase,
  recordRefund,
  rejectPayment,
  verifyPayment,
  type RecordPurchaseInput,
} from "@/lib/money/purchases";
import { makeUser, resetDb } from "../support/db";

let phoneN = 0;
async function makeContact(over: Partial<NewContact> = {}) {
  phoneN += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9192000${String(phoneN).padStart(5, "0")}`, name: `Contact ${phoneN}`, firstDoor: "youtube", ...over })
    .returning();
  return c;
}
const paymentsOf = (purchaseId: string) =>
  db.select().from(payments).where(eq(payments.purchaseId, purchaseId)).orderBy(payments.kind, payments.seq, payments.createdAt);
const purchaseRow = async (id: string) => (await db.select().from(purchases).where(eq(purchases.id, id)))[0];

const base = (contactId: string, over: Partial<RecordPurchaseInput> = {}): RecordPurchaseInput => ({
  contactId,
  productName: "Applied AI Mastery",
  family: "applied_ai_mastery",
  amount: 3000,
  currency: "INR",
  mode: "upi_qr",
  source: "manual",
  ...over,
});
const DAY = 86400_000;
const emi3 = (start = Date.now() - 40 * DAY) => [
  { amount: 1000, dueAt: new Date(start) },
  { amount: 1000, dueAt: new Date(start + 30 * DAY) },
  { amount: 1000, dueAt: new Date(start + 60 * DAY) },
];

describe("money review: regressions", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("a cancelled purchase does not hold its UTR / order id hostage", () => {
    it("a UTR recorded on the wrong contact can be recorded on the right one once that purchase is cancelled", async () => {
      const sales = await makeUser({ role: "sales" });
      const wrong = await makeContact({ name: "Wrong Person" });
      const right = await makeContact({ name: "Right Person" });
      const r = await recordPurchase(base(wrong.id, { reference: "utr777" }), sales);
      await cancelPurchase(r.purchaseId, sales, "Recorded on the wrong contact");

      const ok = await recordPurchase(base(right.id, { reference: "UTR777" }), sales);
      expect((await purchaseRow(ok.purchaseId)).reference).toBe("UTR777");
      expect((await paymentsOf(ok.purchaseId))[0].reference).toBe("UTR777");
      // the cancelled rows gave the reference up, and that is audited
      expect((await purchaseRow(r.purchaseId)).reference).toBeNull();
      expect((await paymentsOf(r.purchaseId))[0].reference).toBeNull();
      const released = await db.select().from(auditLog).where(and(eq(auditLog.rowId, r.purchaseId), eq(auditLog.field, "reference")));
      expect(released).toHaveLength(1);
      expect(released[0].oldValue).toBe("UTR777");
    });

    it("an instalment UTR on a cancelled EMI purchase is free again; a live rejected claim still blocks it", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const a = await makeContact();
      const b = await makeContact({ name: "Holder" });
      const emi = await recordPurchase(base(a.id, { instalments: emi3(), paidNow: { amount: 1000, reference: "EMI-UTR-1" } }), sales);
      await cancelPurchase(emi.purchaseId, sales, "Duplicate entry");
      const again = await recordPurchase(base(a.id, { amount: 1000, reference: "EMI-UTR-1" }), sales);
      expect(again.paymentIds).toHaveLength(1);

      // a rejected claim on a live purchase keeps its reference (the manager may still verify it)
      const live = await recordPurchase(base(b.id, { amount: 500, reference: "LIVE-1" }), sales);
      await rejectPayment(live.paymentIds[0], manager, "Not in the account yet");
      await expect(recordPurchase(base(a.id, { amount: 500, reference: "LIVE-1" }), sales)).rejects.toThrow(
        /already recorded on Holder/,
      );
    });

    it("a TagMango order entered by hand and cancelled does not block the real webhook order", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact();
      const typed = await recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "TM-42" }), sales);
      await cancelPurchase(typed.purchaseId, sales, "Typed in by mistake, webhook will bring it");
      const hook = await recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "TM-42" }), null);
      expect(hook.status).toBe("paid");
      // and the webhook arriving again is still refused
      await expect(recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "TM-42" }), null)).rejects.toBeInstanceOf(
        DuplicateReferenceError,
      );
    });
  });

  describe("the instalment schedule always adds up to what is still owed", () => {
    it("an underpaid instalment leaves its balance scheduled on the same due date, so it is still chased", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { instalments: emi3() }), sales);
      const [first] = await paymentsOf(r.purchaseId);
      await recordInstalmentPayment(first.id, { mode: "cash", reference: null, amount: 600 }, sales);
      let rows = await paymentsOf(r.purchaseId);
      expect(rows.map((x) => [x.seq, x.status, x.amount])).toEqual([
        [1, "unverified", 600],
        [1, "scheduled", 400],
        [2, "scheduled", 1000],
        [3, "scheduled", 1000],
      ]);
      const balance = rows[1];
      expect(balance.dueAt?.toISOString()).toBe(first.dueAt?.toISOString());
      expect((await listPaymentsQueue("overdue")).map((x) => x.paymentId)).toContain(balance.id);

      await verifyPayment(first.id, manager);
      await recordInstalmentPayment(balance.id, { mode: "cash", reference: null, verify: true }, manager);
      for (const x of rows.slice(2)) await recordInstalmentPayment(x.id, { mode: "cash", reference: null, verify: true }, manager);
      expect((await purchaseRow(r.purchaseId)).status).toBe("paid");
      rows = await paymentsOf(r.purchaseId);
      expect(rows.every((x) => x.status === "verified")).toBe(true);
    });

    it("paying ahead with an extra payment shortens the schedule from the end; nothing is chased once covered", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { instalments: emi3(Date.now() - 70 * DAY) }), sales);
      const sched = await paymentsOf(r.purchaseId);
      await createTask({ contactId: c.id, userId: sales.id, type: "instalment_due", reason: "Due", dedupeKey: `instalment_due:${sched[2].id}` });

      const extra = await addPayment(r.purchaseId, { amount: 2000, mode: "upi_qr", reference: "AHEAD-1" }, sales);
      let rows = await paymentsOf(r.purchaseId);
      expect(rows.filter((x) => x.status === "scheduled").map((x) => [x.seq, x.amount])).toEqual([[1, 1000]]);
      // the alert on the instalment that is no longer owed is closed
      expect((await db.select().from(tasks).where(eq(tasks.type, "instalment_due")))[0].status).toBe("done");

      await verifyPayment(extra.paymentId, manager);
      await recordInstalmentPayment(sched[0].id, { mode: "cash", reference: null, verify: true }, manager);
      expect((await purchaseRow(r.purchaseId)).status).toBe("paid");
      expect(await listPaymentsQueue("overdue")).toHaveLength(0);
      expect(await listPaymentsQueue("due", db, new Date(), { withinDays: 365 })).toHaveLength(0);
      rows = await paymentsOf(r.purchaseId);
      expect(rows.map((x) => x.status).sort()).toEqual(["verified", "verified"]);
    });

    it("an instalment paid with more than its amount takes the excess off the last instalments", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { instalments: emi3() }), sales);
      const [first] = await paymentsOf(r.purchaseId);
      await recordInstalmentPayment(first.id, { mode: "cash", reference: null, amount: 1500 }, sales);
      const rows = await paymentsOf(r.purchaseId);
      expect(rows.map((x) => [x.seq, x.status, x.amount, x.amountInr])).toEqual([
        [1, "unverified", 1500, 1500],
        [2, "scheduled", 1000, 1000],
        [3, "scheduled", 500, 500],
      ]);
    });

    it("rejecting a pay-ahead claim on an EMI puts the money back on the schedule", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { instalments: emi3() }), sales);
      const extra = await addPayment(r.purchaseId, { amount: 1000, mode: "upi_qr", reference: "AHEAD-2" }, sales);
      expect((await paymentsOf(r.purchaseId)).filter((x) => x.status === "scheduled")).toHaveLength(2);
      const res = await rejectPayment(extra.paymentId, manager, "No such UTR in the statement");
      expect(res.rescheduledPaymentId).toBeTruthy();
      const scheduled = (await paymentsOf(r.purchaseId)).filter((x) => x.status === "scheduled");
      expect(scheduled.reduce((s, x) => s + x.amount, 0)).toBe(3000);
    });
  });

  describe("a refunded purchase is never chased", () => {
    it("rejecting a leftover claim on a fully refunded EMI purchase does not re-open an instalment", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { instalments: emi3(), paidNow: { amount: 1000, reference: "RF-1" }, verified: true }), manager);
      const rows = await paymentsOf(r.purchaseId);
      const claim = await recordInstalmentPayment(rows[1].id, { mode: "upi_qr", reference: "RF-2" }, sales);
      expect((await recordRefund(r.purchaseId, { amount: 1000, reason: "Left the course" }, manager)).purchaseStatus).toBe("refunded");
      const res = await rejectPayment(claim.paymentId, manager, "Not in the account");
      expect(res.rescheduledPaymentId).toBeNull();
      expect((await paymentsOf(r.purchaseId)).filter((x) => x.status === "scheduled")).toHaveLength(0);
      expect(await listPaymentsQueue("overdue")).toHaveLength(0);
    });
  });

  describe("abandoned checkouts are only closed by the money that resolves them", () => {
    it("verifying an old claim does not close the alert for a checkout started after that payment", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact({ ownerId: sales.id });
      const paidAt = new Date(Date.now() - 10 * DAY);
      const claim = await recordPurchase(base(c.id, { amount: 999, reference: "OLD-CLAIM", purchasedAt: paidAt }), sales);
      // today the customer starts a checkout for something else and it fails: the hottest lead Edapt has
      const [enq] = await db
        .insert(enquiries)
        .values({ contactId: c.id, channel: "tagmango_checkout", status: "checkout_failed", receivedAt: new Date(Date.now() - 2 * 3600_000) })
        .returning();
      await createTask({ contactId: c.id, userId: sales.id, type: "abandoned_checkout", reason: "Payment failed", dedupeKey: `abandoned:${enq.id}` });

      await verifyPayment(claim.paymentIds[0], manager);
      expect((await db.select().from(tasks).where(eq(tasks.type, "abandoned_checkout")))[0].status).toBe("open");
      expect((await db.select().from(enquiries).where(eq(enquiries.id, enq.id)))[0].status).toBe("checkout_failed");
    });

    it("imported payment history does not close today's abandoned checkout", async () => {
      const admin = await makeUser({ role: "admin" });
      const c = await makeContact();
      await createTask({ contactId: c.id, userId: null, type: "abandoned_checkout", reason: "Started paying, no order" });
      await recordPurchase(base(c.id, { amount: 999, mode: "bank_transfer", source: "import", purchasedAt: new Date("2025-03-01T06:00:00Z") }), admin);
      expect((await db.select().from(tasks).where(eq(tasks.type, "abandoned_checkout")))[0].status).toBe("open");
    });
  });

  describe("messages", () => {
    it("paying an instalment of a cancelled or refunded purchase says so (not 'already paid')", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { instalments: emi3() }), sales);
      await cancelPurchase(r.purchaseId, sales, "Changed mind");
      const rows = await paymentsOf(r.purchaseId);
      await expect(recordInstalmentPayment(rows[1].id, { mode: "cash", reference: null }, sales)).rejects.toThrow(/cancelled/);

      const r2 = await recordPurchase(base(c.id, { instalments: emi3(), paidNow: { amount: 1000, reference: "R2-UTR" }, verified: true }), manager);
      await recordRefund(r2.purchaseId, { amount: 1000, reason: "Left the course" }, manager);
      const rows2 = await paymentsOf(r2.purchaseId);
      await expect(recordInstalmentPayment(rows2[1].id, { mode: "cash", reference: null }, sales)).rejects.toThrow(/refunded/);
    });
  });

  describe("money cannot arrive in the future", () => {
    it("rejects paid, refund and purchase-with-payment dates more than a day ahead", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const nextWeek = new Date(Date.now() + 7 * DAY);
      await expect(recordPurchase(base(c.id, { reference: "F-1", purchasedAt: nextWeek }), sales)).rejects.toThrow(/future/);
      await expect(
        recordPurchase(base(c.id, { reference: "F-2", paidNow: { amount: 3000, paidAt: nextWeek } }), sales),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await db.select().from(purchases)).toHaveLength(0);

      // an agreed purchase with nothing paid yet may carry a future date; a due date may be in the future
      const r = await recordPurchase(base(c.id, { instalments: emi3(Date.now() + DAY) }), sales);
      const [first] = await paymentsOf(r.purchaseId);
      await expect(recordInstalmentPayment(first.id, { mode: "cash", reference: null, paidAt: nextWeek }, sales)).rejects.toThrow(/future/);
      await expect(addPayment(r.purchaseId, { amount: 10, mode: "cash", reference: null, paidAt: nextWeek }, sales)).rejects.toThrow(/future/);

      const paid = await recordPurchase(base(c.id, { reference: "F-3", verified: true }), manager);
      await expect(recordRefund(paid.purchaseId, { amount: 10, reason: "x", refundedAt: nextWeek }, manager)).rejects.toThrow(/future/);

      // a date-only value for "today" entered from a time zone ahead of UTC is fine
      const today = await recordPurchase(base(c.id, { reference: "F-4", purchasedAt: new Date(Date.now() + 10 * 3600_000) }), sales);
      expect(today.paymentIds).toHaveLength(1);
    });
  });

  describe("amounts that do not fit the books", () => {
    it("an absurd amount is a friendly validation error, not a database overflow", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact();
      await expect(recordPurchase(base(c.id, { amount: 99_999_999_999_999, mode: "cash" }), sales)).rejects.toBeInstanceOf(ValidationError);
      // fits in AED but not once converted to INR
      await expect(
        recordPurchase(base(c.id, { amount: 99_999_999_999, currency: "AED", mode: "cash" }), sales),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
