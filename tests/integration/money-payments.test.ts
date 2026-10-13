import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLog, contacts, enquiries, payments, purchases, tasks, type NewContact } from "@/db/schema";
import { createTask } from "@/lib/alerts/core";
import { NotFoundError, PermissionError, ValidationError } from "@/lib/money/errors";
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
import { ltvInr } from "@/lib/money/rules";
import { makeUser, resetDb } from "../support/db";

let phoneN = 0;
async function makeContact(over: Partial<NewContact> = {}) {
  phoneN += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9191000${String(phoneN).padStart(5, "0")}`, name: `Contact ${phoneN}`, firstDoor: "youtube", ...over })
    .returning();
  return c;
}
const paymentsOf = (purchaseId: string) =>
  db.select().from(payments).where(eq(payments.purchaseId, purchaseId)).orderBy(payments.kind, payments.seq, payments.createdAt);
const purchaseRow = async (id: string) => (await db.select().from(purchases).where(eq(purchases.id, id)))[0];
const paymentRow = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0];
const contactLtv = async (contactId: string) => ltvInr(await db.select().from(payments).where(eq(payments.contactId, contactId)));
const tasksOf = (type: string) => db.select().from(tasks).where(eq(tasks.type, type as never));

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
let utrN = 0;
const utr = () => `UTR${++utrN}`;

describe("money: verification, refunds and cancellation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("verifyPayment", () => {
    it("only a manager or admin can verify; verifying sets who/when, audits and settles the purchase", async () => {
      const sales = await makeUser({ role: "sales" });
      const support = await makeUser({ role: "support" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact({ ownerId: sales.id });
      const { purchaseId, paymentIds } = await recordPurchase(base(c.id, { reference: utr() }), sales);
      expect(await contactLtv(c.id)).toBe(0);

      await expect(verifyPayment(paymentIds[0], sales)).rejects.toBeInstanceOf(PermissionError);
      await expect(verifyPayment(paymentIds[0], support)).rejects.toBeInstanceOf(PermissionError);
      await expect(verifyPayment(paymentIds[0], null as never)).rejects.toBeInstanceOf(PermissionError);
      expect((await paymentRow(paymentIds[0])).status).toBe("unverified");

      const res = await verifyPayment(paymentIds[0], manager);
      expect(res).toEqual({ paymentId: paymentIds[0], status: "verified", purchaseStatus: "paid" });
      const pay = await paymentRow(paymentIds[0]);
      expect(pay).toMatchObject({ status: "verified", verifiedById: manager.id });
      expect(pay.verifiedAt).toBeInstanceOf(Date);
      expect((await purchaseRow(purchaseId)).status).toBe("paid");
      expect(await contactLtv(c.id)).toBe(999);

      const log = await db.select().from(auditLog).where(and(eq(auditLog.tableName, "payments"), eq(auditLog.rowId, paymentIds[0])));
      expect(log).toEqual([expect.objectContaining({ action: "verify", field: "status", oldValue: "unverified", newValue: "verified", userId: manager.id })]);

      // verifying twice is a no-op
      const admin = await makeUser({ role: "admin" });
      expect(await verifyPayment(paymentIds[0], admin)).toMatchObject({ status: "verified" });
      expect((await paymentRow(paymentIds[0])).verifiedById).toBe(manager.id);
    });

    it("cannot verify a scheduled instalment or a missing payment", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r = await recordPurchase(
        base(c.id, { amount: 2000, instalments: [{ amount: 1000, dueAt: new Date("2026-10-01") }, { amount: 1000, dueAt: new Date("2026-11-01") }] }),
        manager,
      );
      await expect(verifyPayment(r.paymentIds[0], manager)).rejects.toThrow(/hasn't been paid/);
      await expect(verifyPayment("00000000-0000-0000-0000-000000000000", manager)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("closes the open unverified-payment alert for that payment", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const { paymentIds } = await recordPurchase(base(c.id, { reference: utr() }), null);
      await createTask({ contactId: c.id, userId: manager.id, type: "unverified_payment", reason: "Unverified for 2 days", dedupeKey: `unverified_payment:${paymentIds[0]}` });
      await createTask({ contactId: c.id, userId: manager.id, type: "unverified_payment", reason: "other", payload: { paymentId: "00000000-0000-0000-0000-000000000000" } });
      await verifyPayment(paymentIds[0], manager);
      const rows = await tasksOf("unverified_payment");
      expect(rows.map((t) => t.status).sort()).toEqual(["done", "open"]);
    });
  });

  describe("rejectPayment", () => {
    it("manager rejects a claim with a reason; it never counts and the purchase stays pending", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const { purchaseId, paymentIds } = await recordPurchase(base(c.id, { reference: utr() }), sales);
      await expect(rejectPayment(paymentIds[0], sales, "no money")).rejects.toBeInstanceOf(PermissionError);
      await expect(rejectPayment(paymentIds[0], manager, "  ")).rejects.toBeInstanceOf(ValidationError);
      const res = await rejectPayment(paymentIds[0], manager, "UTR not in the bank statement");
      expect(res).toMatchObject({ status: "rejected", purchaseStatus: "pending", rescheduledPaymentId: null });
      expect(await paymentRow(paymentIds[0])).toMatchObject({ status: "rejected", reason: "UTR not in the bank statement" });
      expect((await purchaseRow(purchaseId)).status).toBe("pending");
      // the salesperson can record the real payment
      const again = await addPayment(purchaseId, { amount: 999, mode: "upi_qr", reference: utr() }, sales);
      expect(again.status).toBe("unverified");
    });

    it("a verified payment cannot be rejected (refund it instead)", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const { paymentIds } = await recordPurchase(base(c.id, { reference: utr(), verified: true }), manager);
      await expect(rejectPayment(paymentIds[0], manager, "oops")).rejects.toThrow(/refund/);
    });

    it("rejecting an instalment re-opens it; verifying the rejected claim later drops the re-opened row", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r = await recordPurchase(
        base(c.id, {
          amount: 3000,
          instalments: [
            { amount: 1000, dueAt: new Date("2026-10-01T00:00:00Z") },
            { amount: 2000, dueAt: new Date("2026-11-01T00:00:00Z") },
          ],
          paidNow: { amount: 1000, reference: utr() },
        }),
        null,
      );
      const res = await rejectPayment(r.paymentIds[0], manager, "Screenshot was of another payment");
      expect(res.rescheduledPaymentId).toBeTruthy();
      let rows = await paymentsOf(r.purchaseId);
      expect(rows.map((x) => [x.seq, x.status, x.amount])).toEqual([
        [1, "rejected", 1000],
        [1, "scheduled", 1000],
        [2, "scheduled", 2000],
      ]);
      expect(rows.find((x) => x.id === res.rescheduledPaymentId)?.dueAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");

      // the manager changes their mind: the claim stands and the re-opened instalment goes away
      expect((await verifyPayment(r.paymentIds[0], manager)).purchaseStatus).toBe("partial");
      rows = await paymentsOf(r.purchaseId);
      expect(rows.map((x) => [x.seq, x.status])).toEqual([
        [1, "verified"],
        [2, "scheduled"],
      ]);
    });
  });

  describe("recordRefund", () => {
    it("only managers/admins refund; a refund cannot exceed verified money net of earlier refunds", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(base(c.id, { amount: 10000, reference: utr(), verified: true }), manager);
      await expect(recordRefund(purchaseId, { amount: 100, reason: "x" }, sales)).rejects.toBeInstanceOf(PermissionError);
      await expect(recordRefund(purchaseId, { amount: 100, reason: " " }, manager)).rejects.toBeInstanceOf(ValidationError);
      await expect(recordRefund(purchaseId, { amount: 10000.01, reason: "Too much" }, manager)).rejects.toThrow(/at most/);
      await expect(recordRefund(purchaseId, { amount: 0, reason: "Zero" }, manager)).rejects.toBeInstanceOf(ValidationError);

      const part = await recordRefund(purchaseId, { amount: 4000, reason: "Missed two sessions", reference: "rf-1" }, manager);
      expect(part).toMatchObject({ status: "verified", purchaseStatus: "paid" });
      expect(await paymentRow(part.paymentId)).toMatchObject({
        kind: "refund",
        status: "verified",
        amount: 4000,
        amountInr: 4000,
        reason: "Missed two sessions",
        reference: "rf-1",
        verifiedById: manager.id,
        createdById: manager.id,
      });
      expect(await contactLtv(c.id)).toBe(6000);

      await expect(recordRefund(purchaseId, { amount: 6000.5, reason: "Rest" }, manager)).rejects.toThrow(/at most ₹6,000/);
      const rest = await recordRefund(purchaseId, { amount: 6000, reason: "Rest" }, manager);
      expect(rest.purchaseStatus).toBe("refunded");
      expect((await purchaseRow(purchaseId)).status).toBe("refunded");
      expect(await contactLtv(c.id)).toBe(0);
      await expect(recordRefund(purchaseId, { amount: 1, reason: "More" }, manager)).rejects.toBeInstanceOf(ValidationError);
      // a refunded purchase takes no more payments
      await expect(addPayment(purchaseId, { amount: 1, mode: "cash", reference: null }, manager)).rejects.toThrow(/refunded/);
    });

    it("unverified money cannot be refunded", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(base(c.id, { reference: utr() }), null);
      await expect(recordRefund(purchaseId, { amount: 1, reason: "x" }, manager)).rejects.toThrow(/nothing to refund/);
    });

    it("an AED refund goes back at the rate the money came in at, so a full refund nets LTV to zero", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(
        base(c.id, { amount: 1000, currency: "AED", mode: "tagmango", source: "tagmango", reference: "TM-AED", purchasedAt: new Date("2026-06-01T06:00:00Z") }),
        null,
      );
      expect(await contactLtv(c.id)).toBe(22600);
      // refunded in October, when the setting says 22.7
      const r = await recordRefund(purchaseId, { amount: 250, reason: "Partial", refundedAt: new Date("2026-10-05T06:00:00Z") }, manager);
      expect(await paymentRow(r.paymentId)).toMatchObject({ currency: "AED", fxRate: 22.6, amountInr: 5650 });
      await recordRefund(purchaseId, { amount: 750, reason: "Rest", refundedAt: new Date("2026-10-06T06:00:00Z") }, manager);
      expect(await contactLtv(c.id)).toBe(0);
      expect((await purchaseRow(purchaseId)).status).toBe("refunded");
    });

    it("a refund in another currency is converted and capped by what was received", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(base(c.id, { amount: 1000, currency: "AED", reference: utr(), purchasedAt: new Date("2026-10-02T06:00:00Z"), verified: true }), manager);
      await expect(recordRefund(purchaseId, { amount: 22701, currency: "INR", reason: "Too much", refundedAt: new Date("2026-10-03T06:00:00Z") }, manager)).rejects.toThrow(/at most/);
      const r = await recordRefund(purchaseId, { amount: 2270, currency: "INR", reason: "Part", refundedAt: new Date("2026-10-03T06:00:00Z") }, manager);
      expect(await paymentRow(r.paymentId)).toMatchObject({ currency: "INR", fxRate: 1, amountInr: 2270 });
      expect(await contactLtv(c.id)).toBe(20430);
    });

    it("a full refund of an EMI purchase stops the remaining instalments", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r = await recordPurchase(
        base(c.id, {
          amount: 3000,
          instalments: [
            { amount: 1000, dueAt: new Date("2026-10-01T00:00:00Z") },
            { amount: 2000, dueAt: new Date("2026-11-01T00:00:00Z") },
          ],
          paidNow: { amount: 1000, reference: utr() },
          verified: true,
        }),
        manager,
      );
      await createTask({ contactId: c.id, userId: manager.id, type: "instalment_due", reason: "Due", dedupeKey: `instalment_due:${r.paymentIds[1]}` });
      // a part refund leaves the schedule alone
      await recordRefund(r.purchaseId, { amount: 400, reason: "Goodwill" }, manager);
      expect((await paymentRow(r.paymentIds[1])).status).toBe("scheduled");
      const res = await recordRefund(r.purchaseId, { amount: 600, reason: "Dropped out" }, manager);
      expect(res.purchaseStatus).toBe("refunded");
      expect(await paymentRow(r.paymentIds[1])).toMatchObject({ status: "rejected", reason: "Purchase refunded: Dropped out" });
      expect((await tasksOf("instalment_due"))[0].status).toBe("done");
      expect(await listPaymentsQueue("overdue", db, new Date("2027-01-01T00:00:00Z"))).toHaveLength(0);
      await expect(recordInstalmentPayment(r.paymentIds[1], { mode: "cash", reference: null }, manager)).rejects.toBeInstanceOf(ValidationError);
    });

    it("a refund reference must be unique too", async () => {
      const manager = await makeUser({ role: "manager" });
      const a = await makeContact({ name: "Alpha" });
      const p1 = await recordPurchase(base(a.id, { reference: utr(), verified: true }), manager);
      const p2 = await recordPurchase(base(a.id, { reference: utr(), verified: true }), manager);
      await recordRefund(p1.purchaseId, { amount: 100, reason: "x", reference: "REF-9" }, manager);
      await expect(recordRefund(p2.purchaseId, { amount: 100, reason: "x", reference: "REF-9" }, manager)).rejects.toThrow(
        "This refund reference (REF-9) is already recorded on Alpha.",
      );
    });
  });

  describe("cancelPurchase", () => {
    it("cancels a purchase with no verified money; its instalments and claims are rejected", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact();
      const r = await recordPurchase(
        base(c.id, {
          amount: 3000,
          instalments: [
            { amount: 1000, dueAt: new Date("2026-10-01") },
            { amount: 1000, dueAt: new Date("2026-11-01") },
            { amount: 1000, dueAt: new Date("2026-12-01") },
          ],
          paidNow: { amount: 1000, reference: utr() },
          notes: "Batch 7",
        }),
        sales,
      );
      await createTask({ contactId: c.id, userId: sales.id, type: "instalment_due", reason: "Due", payload: { paymentId: r.paymentIds[1] } });
      await expect(cancelPurchase(r.purchaseId, sales, "")).rejects.toBeInstanceOf(ValidationError);
      expect(await cancelPurchase(r.purchaseId, sales, "Customer changed their mind")).toBe("cancelled");
      const p = await purchaseRow(r.purchaseId);
      expect(p.status).toBe("cancelled");
      expect(p.notes).toBe("Batch 7\nCancelled: Customer changed their mind");
      const rows = await paymentsOf(r.purchaseId);
      expect(rows.every((x) => x.status === "rejected" && x.reason === "Purchase cancelled: Customer changed their mind")).toBe(true);
      expect((await tasksOf("instalment_due"))[0].status).toBe("done");
      // cancelling twice is a no-op; nothing more can be paid or refunded
      expect(await cancelPurchase(r.purchaseId, sales, "again")).toBe("cancelled");
      await expect(addPayment(r.purchaseId, { amount: 1, mode: "cash", reference: null }, sales)).rejects.toThrow(/cancelled/);
      await expect(recordInstalmentPayment(r.paymentIds[2], { mode: "cash", reference: null }, sales)).rejects.toBeInstanceOf(ValidationError);
      const manager = await makeUser({ role: "manager" });
      await expect(recordRefund(r.purchaseId, { amount: 1, reason: "x" }, manager)).rejects.toThrow(/cancelled/);
      await expect(verifyPayment(r.paymentIds[0], manager)).rejects.toBeInstanceOf(ValidationError);
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.rowId, r.purchaseId), eq(auditLog.field, "status")));
      expect(audits).toHaveLength(1);
    });

    it("cannot cancel once money is verified; support cannot cancel", async () => {
      const manager = await makeUser({ role: "manager" });
      const support = await makeUser({ role: "support" });
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { reference: utr(), verified: true }), manager);
      await expect(cancelPurchase(r.purchaseId, manager, "mistake")).rejects.toThrow(/refund/);
      const r2 = await recordPurchase(base(c.id, { reference: utr() }), manager);
      await expect(cancelPurchase(r2.purchaseId, support, "mistake")).rejects.toBeInstanceOf(PermissionError);
    });
  });

  describe("new advocate", () => {
    it("the referrer's owner gets one 'call to thank' task when the referral's first verified money arrives", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const referrer = await makeContact({ name: "Rahul", ownerId: sales.id });
      const friend = await makeContact({ name: "Nisha", referredById: referrer.id });

      // unverified money: no task yet
      const { purchaseId, paymentIds } = await recordPurchase(base(friend.id, { reference: utr() }), sales);
      expect(await tasksOf("new_advocate")).toHaveLength(0);

      await verifyPayment(paymentIds[0], manager);
      let rows = await tasksOf("new_advocate");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        contactId: referrer.id,
        userId: sales.id,
        status: "open",
        reason: "Their referral Nisha just paid — call to thank",
        dedupeKey: `new_advocate:${friend.id}`,
        createdById: manager.id,
      });
      expect(rows[0].payload).toMatchObject({ referredContactId: friend.id, purchaseId });

      // later money from the same referral raises nothing new, even after the task is done
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, rows[0].id));
      await recordPurchase(base(friend.id, { mode: "tagmango", source: "tagmango", reference: "TM-2" }), null);
      rows = await tasksOf("new_advocate");
      expect(rows).toHaveLength(1);
    });

    it("a referrer with no owner gets the task in the pool; a TagMango first payment triggers it directly", async () => {
      const referrer = await makeContact({ name: "Pool Referrer" });
      const friend = await makeContact({ name: "Zara", referredById: referrer.id });
      await recordPurchase(base(friend.id, { mode: "tagmango", source: "tagmango", reference: "TM-Z" }), null);
      const [t] = await tasksOf("new_advocate");
      expect(t).toMatchObject({ contactId: referrer.id, userId: null });
    });

    it("no task when the contact had verified money before, or nobody referred them", async () => {
      const referrer = await makeContact({ name: "R" });
      const c = await makeContact({ name: "Old customer" });
      await recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "TM-OLD" }), null);
      await db.update(contacts).set({ referredById: referrer.id }).where(eq(contacts.id, c.id));
      await recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "TM-NEW" }), null);
      expect(await tasksOf("new_advocate")).toHaveLength(0);
      const solo = await makeContact();
      await recordPurchase(base(solo.id, { mode: "tagmango", source: "tagmango", reference: "TM-SOLO" }), null);
      expect(await tasksOf("new_advocate")).toHaveLength(0);
    });

    it("imported history does not raise 'call to thank' tasks", async () => {
      const admin = await makeUser({ role: "admin" });
      const referrer = await makeContact({ name: "R2" });
      const friend = await makeContact({ name: "Old friend", referredById: referrer.id });
      const { paymentIds } = await recordPurchase(base(friend.id, { source: "import", mode: "tagmango", reference: "TM-HIST", purchasedAt: new Date("2024-03-01T06:00:00Z") }), admin);
      expect((await paymentRow(paymentIds[0])).status).toBe("verified");
      expect(await tasksOf("new_advocate")).toHaveLength(0);
    });

    it("follows a merged referrer to the surviving contact", async () => {
      const owner = await makeUser({ role: "sales" });
      const survivor = await makeContact({ name: "Survivor", ownerId: owner.id });
      const merged = await makeContact({ name: "Merged", mergedIntoId: survivor.id, mergedAt: new Date() });
      const friend = await makeContact({ name: "F", referredById: merged.id });
      await recordPurchase(base(friend.id, { mode: "tagmango", source: "tagmango", reference: "TM-F" }), null);
      expect((await tasksOf("new_advocate"))[0]).toMatchObject({ contactId: survivor.id, userId: owner.id });
    });
  });

  describe("abandoned checkout recovery", () => {
    it("verified money recovers an abandoned checkout and closes its task", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact({ ownerId: sales.id });
      const startedAt = new Date(Date.now() - 3 * 3600_000);
      const [enq] = await db
        .insert(enquiries)
        .values({ contactId: c.id, channel: "tagmango_checkout", status: "checkout_started", receivedAt: startedAt })
        .returning();
      const [other] = await db.insert(enquiries).values({ contactId: c.id, channel: "whatsapp_api", status: "open" }).returning();
      await createTask({ contactId: c.id, userId: sales.id, type: "abandoned_checkout", reason: "Started paying, no order", dedupeKey: `abandoned:${enq.id}` });
      const { purchaseId } = await recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "TM-REC" }), null);
      const e = await db.select().from(enquiries).where(eq(enquiries.id, enq.id));
      expect(e[0].status).toBe("recovered");
      expect((await db.select().from(enquiries).where(eq(enquiries.id, other.id)))[0].status).toBe("open");
      const [t] = await tasksOf("abandoned_checkout");
      expect(t.status).toBe("done");
      expect(t.completedAt).toBeInstanceOf(Date);
      expect(t.payload).toMatchObject({ recoveredByPurchaseId: purchaseId });
    });

    it("a checkout that completes within the hour is a normal sale (handled), not a recovery", async () => {
      const c = await makeContact();
      const [enq] = await db
        .insert(enquiries)
        .values({ contactId: c.id, channel: "tagmango_checkout", status: "checkout_started", receivedAt: new Date(Date.now() - 5 * 60_000) })
        .returning();
      await recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "TM-FAST" }), null);
      expect((await db.select().from(enquiries).where(eq(enquiries.id, enq.id)))[0].status).toBe("handled");
    });

    it("an unverified bank/UPI payment changes nothing until the manager verifies it", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact({ ownerId: sales.id });
      const [enq] = await db
        .insert(enquiries)
        .values({ contactId: c.id, channel: "tagmango_checkout", status: "abandoned", receivedAt: new Date(Date.now() - 86400_000) })
        .returning();
      await createTask({ contactId: c.id, userId: sales.id, type: "abandoned_checkout", reason: "Abandoned" });
      const { paymentIds } = await recordPurchase(base(c.id, { reference: utr() }), sales);
      expect((await db.select().from(enquiries).where(eq(enquiries.id, enq.id)))[0].status).toBe("abandoned");
      expect((await tasksOf("abandoned_checkout"))[0].status).toBe("open");
      await verifyPayment(paymentIds[0], manager);
      expect((await db.select().from(enquiries).where(eq(enquiries.id, enq.id)))[0].status).toBe("recovered");
      expect((await tasksOf("abandoned_checkout"))[0]).toMatchObject({ status: "done", completedById: manager.id });
    });
  });

  describe("listPaymentsQueue", () => {
    it("lists unverified claims, due and overdue instalments with contact and owner names", async () => {
      const owner = await makeUser({ role: "sales", name: "Shafi" });
      const recorder = await makeUser({ role: "sales", name: "Recorder" });
      const now = new Date("2026-10-13T06:00:00Z");
      const day = 86400_000;
      const a = await makeContact({ name: "Asha", ownerId: owner.id });
      const b = await makeContact({ name: "Basil" });

      const claimOld = await recordPurchase(base(a.id, { reference: utr(), purchasedAt: new Date(now.getTime() - 3 * day) }), recorder);
      const claimNew = await recordPurchase(base(b.id, { reference: utr(), purchasedAt: new Date(now.getTime() - 1 * day) }), recorder);
      const emi = await recordPurchase(
        base(a.id, {
          amount: 4000,
          instalments: [
            { amount: 1000, dueAt: new Date(now.getTime() - 5 * day) },
            { amount: 1000, dueAt: new Date(now.getTime() + 2 * day) },
            { amount: 1000, dueAt: new Date(now.getTime() + 10 * day) },
            { amount: 1000, dueAt: new Date(now.getTime() - 1 * day) },
          ],
        }),
        recorder,
      );
      const cancelled = await recordPurchase(base(b.id, { amount: 1000, instalments: [{ amount: 1000, dueAt: new Date(now.getTime() - 2 * day) }] }), recorder);
      await cancelPurchase(cancelled.purchaseId, recorder, "test");

      const unverified = await listPaymentsQueue("unverified", db, now);
      expect(unverified.map((r) => r.paymentId)).toEqual([claimOld.paymentIds[0], claimNew.paymentIds[0]]);
      expect(unverified[0]).toMatchObject({
        contactName: "Asha",
        ownerName: "Shafi",
        recordedByName: "Recorder",
        productName: "Prompting workshop",
        purchaseStatus: "pending",
        status: "unverified",
        days: 3,
      });
      expect(unverified[1]).toMatchObject({ contactName: "Basil", ownerId: null, ownerName: null, days: 1 });

      const stale = await listPaymentsQueue("unverified", db, now, { olderThanDays: 2 });
      expect(stale.map((r) => r.paymentId)).toEqual([claimOld.paymentIds[0]]);

      const due = await listPaymentsQueue("due", db, now);
      expect(due.map((r) => [r.seq, r.days])).toEqual([[3, 2]]);
      expect(due[0]).toMatchObject({ purchaseId: emi.purchaseId, hasInstalments: true, status: "scheduled" });
      expect((await listPaymentsQueue("due", db, now, { withinDays: 14 })).map((r) => r.seq)).toEqual([3, 4]);

      const overdue = await listPaymentsQueue("overdue", db, now);
      expect(overdue.map((r) => [r.seq, r.days])).toEqual([
        [1, 5],
        [2, 1],
      ]);

      expect(await listPaymentsQueue("unverified", db, now, { ownerId: owner.id })).toHaveLength(1);
      expect((await listPaymentsQueue("unverified", db, now, { ownerId: null }))[0].contactName).toBe("Basil");
      await expect(listPaymentsQueue("bogus" as never, db, now)).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
