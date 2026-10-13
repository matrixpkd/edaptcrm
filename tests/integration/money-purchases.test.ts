import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLog, contacts, payments, products, purchases, type NewContact } from "@/db/schema";
import {
  DuplicateReferenceError,
  PermissionError,
  UnknownCurrencyError,
  ValidationError,
  NotFoundError,
} from "@/lib/money/errors";
import { getFxRate } from "@/lib/money/fx-server";
import { asDuplicateReferenceError } from "@/lib/money/internal";
import {
  addPayment,
  getContactPurchases,
  recordInstalmentPayment,
  recordPurchase,
  refreshPurchaseStatus,
  verifyPayment,
  type RecordPurchaseInput,
} from "@/lib/money/purchases";
import { DEFAULT_SETTINGS, getSetting, setSetting } from "@/lib/settings";
import { makeUser, resetDb } from "../support/db";

let phoneN = 0;
async function makeContact(over: Partial<NewContact> = {}) {
  phoneN += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9190000${String(phoneN).padStart(5, "0")}`, name: `Contact ${phoneN}`, firstDoor: "youtube", ...over })
    .returning();
  return c;
}

async function paymentsOf(purchaseId: string) {
  return db.select().from(payments).where(eq(payments.purchaseId, purchaseId)).orderBy(payments.seq, payments.createdAt);
}

async function purchaseRow(id: string) {
  const [p] = await db.select().from(purchases).where(eq(purchases.id, id));
  return p;
}

const base = (contactId: string, over: Partial<RecordPurchaseInput> = {}): RecordPurchaseInput => ({
  contactId,
  productName: "Prompting workshop",
  family: "workshop",
  amount: 999,
  currency: "INR",
  mode: "cash",
  source: "manual",
  ...over,
});

describe("money: recording purchases", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("currency", () => {
    it("an AED purchase stores the month's rate and INR value; a later rate change does not touch it", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact({ name: "Ayesha Rahman" });
      const at = new Date("2026-10-05T06:00:00Z");
      const { purchaseId, paymentIds } = await recordPurchase(
        base(c.id, { amount: 1500, currency: "aed", mode: "bank_transfer", reference: "aeutr001", purchasedAt: at, verified: true }),
        manager,
      );
      const p = await purchaseRow(purchaseId);
      expect(p).toMatchObject({ currency: "AED", fxRate: 22.7, amountInr: 34050, amount: 1500, status: "paid", reference: "AEUTR001" });
      const [pay] = await paymentsOf(purchaseId);
      expect(pay.id).toBe(paymentIds[0]);
      expect(pay).toMatchObject({ currency: "AED", fxRate: 22.7, amountInr: 34050, status: "verified", verifiedById: manager.id });

      const cfg = await getSetting("currency");
      await setSetting("currency", { ...cfg, rates: { ...cfg.rates, AED: { "2026-01": 22.6, "2026-10": 25 } } }, manager.id);
      expect(await getFxRate("AED", at)).toBe(25);

      const after = await purchaseRow(purchaseId);
      expect(after.fxRate).toBe(22.7);
      expect(after.amountInr).toBe(34050);
      expect((await paymentsOf(purchaseId))[0].amountInr).toBe(34050);

      // a new purchase picks up the new rate
      const second = await recordPurchase(base(c.id, { amount: 100, currency: "AED", purchasedAt: at }), manager);
      expect((await purchaseRow(second.purchaseId)).amountInr).toBe(2500);
    });

    it("uses the earlier month's rate for a payment before the latest rate", async () => {
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(
        base(c.id, { amount: 100, currency: "AED", purchasedAt: new Date("2026-06-10T06:00:00Z") }),
        null,
      );
      expect(await purchaseRow(purchaseId)).toMatchObject({ fxRate: 22.6, amountInr: 2260 });
    });

    it("USD (The AI Office pricing) works from settings", async () => {
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(
        base(c.id, { family: "ai_office", productName: "The AI Office", amount: 499, currency: "USD", purchasedAt: new Date("2026-10-02T06:00:00Z"), mode: "tagmango", source: "tagmango", reference: "TM-USD-1" }),
        null,
      );
      const p = await purchaseRow(purchaseId);
      expect(p).toMatchObject({ currency: "USD", fxRate: 83.4, amountInr: 41616.6, status: "paid" });
    });

    it("a currency added in Settings works with no code change; an unknown one is rejected and nothing is written", async () => {
      const admin = await makeUser({ role: "admin" });
      const c = await makeContact();
      await expect(recordPurchase(base(c.id, { currency: "SAR" }), admin)).rejects.toBeInstanceOf(UnknownCurrencyError);
      expect(await db.select().from(purchases)).toHaveLength(0);

      const cfg = await getSetting("currency");
      await setSetting("currency", { ...cfg, enabled: [...cfg.enabled, "SAR"], rates: { ...cfg.rates, SAR: { "2026-01": 22.2 } } }, admin.id);
      const { purchaseId } = await recordPurchase(base(c.id, { currency: "SAR", amount: 10, purchasedAt: new Date("2026-10-01T06:00:00Z") }), admin);
      expect(await purchaseRow(purchaseId)).toMatchObject({ currency: "SAR", fxRate: 22.2, amountInr: 222 });
    });

    it("INR is stored at rate 1", async () => {
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(base(c.id, { amount: 999 }), null);
      expect(await purchaseRow(purchaseId)).toMatchObject({ currency: "INR", fxRate: 1, amountInr: 999 });
    });
  });

  describe("sources and verification", () => {
    it("a TagMango order is verified by default (system), with the order id on purchase and payment", async () => {
      const c = await makeContact();
      const { purchaseId, paymentIds, status } = await recordPurchase(
        base(c.id, { mode: "tagmango", source: "tagmango", reference: "64f0ab12cd", campaign: "claude_mastery_meta", rawPayload: { order: 1 } }),
        null,
      );
      expect(status).toBe("paid");
      const p = await purchaseRow(purchaseId);
      expect(p).toMatchObject({ status: "paid", reference: "64f0ab12cd", source: "tagmango", campaign: "claude_mastery_meta", rawPayload: { order: 1 }, createdById: null });
      const [pay] = await paymentsOf(purchaseId);
      expect(paymentIds).toEqual([pay.id]);
      expect(pay).toMatchObject({ kind: "payment", seq: 1, status: "verified", verifiedById: null, reference: "64f0ab12cd", amount: 999, mode: "tagmango" });
      expect(pay.verifiedAt).toBeInstanceOf(Date);
      expect(pay.paidAt).toEqual(p.purchasedAt);
    });

    it("a TagMango order needs its order id", async () => {
      const c = await makeContact();
      await expect(recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango" }), null)).rejects.toBeInstanceOf(ValidationError);
    });

    it("imports are verified by default and do not need a UTR", async () => {
      const admin = await makeUser({ role: "admin" });
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(
        base(c.id, { source: "import", mode: "bank_transfer", importBatchId: "00000000-0000-0000-0000-000000000001" }),
        admin,
      );
      const [pay] = await paymentsOf(purchaseId);
      expect(pay).toMatchObject({ status: "verified", reference: null, verifiedById: admin.id });
      expect((await purchaseRow(purchaseId)).importBatchId).toBe("00000000-0000-0000-0000-000000000001");
    });

    it("a manual bank transfer is recorded unverified with UTR and proof; it never counts until verified", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact({ ownerId: sales.id });
      const { purchaseId, status } = await recordPurchase(
        base(c.id, { amount: 25000, mode: "bank_transfer", reference: " sbin 0000 1111 ", proofUrl: "uploads/proof.png", notes: "Paid from father's account" }),
        sales,
      );
      expect(status).toBe("pending");
      const [pay] = await paymentsOf(purchaseId);
      expect(pay).toMatchObject({ status: "unverified", reference: "SBIN00001111", proofUrl: "uploads/proof.png", verifiedAt: null, verifiedById: null, createdById: sales.id });
      expect(await purchaseRow(purchaseId)).toMatchObject({ reference: "SBIN00001111", notes: "Paid from father's account", createdById: sales.id });
    });

    it("bank transfer and UPI need a UTR; cash does not", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact();
      await expect(recordPurchase(base(c.id, { mode: "bank_transfer" }), sales)).rejects.toThrow(/UTR/);
      await expect(recordPurchase(base(c.id, { mode: "upi_qr", reference: "   " }), sales)).rejects.toBeInstanceOf(ValidationError);
      await expect(recordPurchase(base(c.id, { mode: "cash" }), sales)).resolves.toBeTruthy();
      // nothing paid yet: no UTR needed
      await expect(recordPurchase(base(c.id, { mode: "upi_qr", paidNow: null }), sales)).resolves.toMatchObject({ paymentIds: [], status: "pending" });
    });

    it("sales cannot mark a payment verified; a TagMango-sourced entry by sales stays unverified", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact();
      await expect(recordPurchase(base(c.id, { verified: true }), sales)).rejects.toBeInstanceOf(PermissionError);
      const { purchaseId } = await recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "TM-BY-HAND" }), sales);
      expect((await paymentsOf(purchaseId))[0].status).toBe("unverified");
    });

    it("support cannot record payments", async () => {
      const support = await makeUser({ role: "support" });
      const c = await makeContact();
      await expect(recordPurchase(base(c.id), support)).rejects.toBeInstanceOf(PermissionError);
    });

    it("a manager recording a manual payment can verify it on the spot", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const { purchaseId, status } = await recordPurchase(base(c.id, { mode: "upi_qr", reference: "upi1", verified: true }), manager);
      expect(status).toBe("paid");
      expect((await paymentsOf(purchaseId))[0]).toMatchObject({ status: "verified", verifiedById: manager.id });
    });

    it("paidNow null records a pending purchase with no payment row; a part payment makes it partial once verified", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r1 = await recordPurchase(base(c.id, { amount: 5000, paidNow: null }), manager);
      expect(r1).toMatchObject({ status: "pending", paymentIds: [] });
      const r2 = await recordPurchase(base(c.id, { amount: 5000, paidNow: { amount: 2000 }, verified: true }), manager);
      expect(r2.status).toBe("partial");
      await expect(recordPurchase(base(c.id, { amount: 5000, paidNow: { amount: 6000 } }), manager)).rejects.toBeInstanceOf(ValidationError);
    });

    it("validates amount, mode, source and contact", async () => {
      const c = await makeContact();
      await expect(recordPurchase(base(c.id, { amount: 0 }), null)).rejects.toBeInstanceOf(ValidationError);
      await expect(recordPurchase(base(c.id, { amount: -5 }), null)).rejects.toBeInstanceOf(ValidationError);
      await expect(recordPurchase(base(c.id, { mode: "bitcoin" as never }), null)).rejects.toBeInstanceOf(ValidationError);
      await expect(recordPurchase(base(c.id, { source: "zoho" as never }), null)).rejects.toBeInstanceOf(ValidationError);
      await expect(recordPurchase(base("00000000-0000-0000-0000-000000000000"), null)).rejects.toBeInstanceOf(NotFoundError);
      await expect(recordPurchase(base(c.id, { purchasedAt: new Date("x") }), null)).rejects.toBeInstanceOf(ValidationError);
    });

    it("a purchase for a merged contact lands on the surviving contact", async () => {
      const winner = await makeContact({ name: "Winner" });
      const loser = await makeContact({ name: "Loser", mergedIntoId: winner.id, mergedAt: new Date() });
      const { purchaseId, paymentIds } = await recordPurchase(base(loser.id), null);
      expect((await purchaseRow(purchaseId)).contactId).toBe(winner.id);
      const [pay] = await db.select().from(payments).where(eq(payments.id, paymentIds[0]));
      expect(pay.contactId).toBe(winner.id);
    });

    it("writes an audit row", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(base(c.id), sales);
      const rows = await db.select().from(auditLog).where(and(eq(auditLog.tableName, "purchases"), eq(auditLog.rowId, purchaseId)));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "insert", userId: sales.id });
      expect(rows[0].newValue).toMatchObject({ amount: 999, family: "workshop" });
    });
  });

  describe("products", () => {
    it("a catalogue product gives name, family and list price; the discount is derived", async () => {
      const [prod] = await db.insert(products).values({ name: "Applied AI Mastery", family: "applied_ai_mastery", rung: 2, listPrice: 30000 }).returning();
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(
        { contactId: c.id, productId: prod.id, amount: 25000, currency: "INR", mode: "cash", source: "manual" },
        null,
      );
      expect(await purchaseRow(purchaseId)).toMatchObject({
        productId: prod.id,
        productName: "Applied AI Mastery",
        family: "applied_ai_mastery",
        listPrice: 30000,
        discount: 5000,
        amount: 25000,
      });
    });

    it("an explicit discount and list price win; a product priced in USD is converted for an INR sale", async () => {
      const [prod] = await db.insert(products).values({ name: "The AI Office", family: "ai_office", rung: 3, listPrice: 100, currency: "USD" }).returning();
      const c = await makeContact();
      const r = await recordPurchase(
        { contactId: c.id, productId: prod.id, amount: 8000, currency: "INR", mode: "cash", source: "manual", purchasedAt: new Date("2026-10-02T06:00:00Z") },
        null,
      );
      expect(await purchaseRow(r.purchaseId)).toMatchObject({ listPrice: 8340, discount: 340 });
      const r2 = await recordPurchase(
        { contactId: c.id, productId: prod.id, amount: 8000, currency: "INR", mode: "cash", source: "manual", listPrice: 9000, discount: 500 },
        null,
      );
      expect(await purchaseRow(r2.purchaseId)).toMatchObject({ listPrice: 9000, discount: 500 });
    });

    it("needs a product, or a name plus a family that exists in Settings", async () => {
      const c = await makeContact();
      await expect(recordPurchase(base(c.id, { productName: null }), null)).rejects.toThrow(/product/i);
      await expect(recordPurchase(base(c.id, { family: null }), null)).rejects.toThrow(/family/);
      await expect(recordPurchase(base(c.id, { family: "astrology" }), null)).rejects.toBeInstanceOf(ValidationError);
      await expect(
        recordPurchase(base(c.id, { productId: "00000000-0000-0000-0000-000000000000" }), null),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("links a B2B deal to the organisation and the person who signed", async () => {
      const { organisations } = await import("@/db/schema");
      const [org] = await db.insert(organisations).values({ name: "Koduvally School", kind: "school" }).returning();
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(base(c.id, { family: "b2b_program", productName: "AI literacy for teachers", amount: 150000, organisationId: org.id }), null);
      expect(await purchaseRow(purchaseId)).toMatchObject({ organisationId: org.id, contactId: c.id });
      await expect(
        recordPurchase(base(c.id, { organisationId: "00000000-0000-0000-0000-000000000000" }), null),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("duplicate references", () => {
    it("rejects a UTR already recorded on a purchase, naming the contact, however it is typed", async () => {
      const sales = await makeUser({ role: "sales" });
      const ravi = await makeContact({ name: "Ravi Kumar" });
      const other = await makeContact();
      await recordPurchase(base(ravi.id, { mode: "upi_qr", reference: "UTR123456" }), sales);
      const err = await recordPurchase(base(other.id, { mode: "upi_qr", reference: "utr 123 456" }), sales).catch((e) => e);
      expect(err).toBeInstanceOf(DuplicateReferenceError);
      expect(err.message).toBe("This UTR (UTR123456) is already recorded on Ravi Kumar.");
      expect(err.contactId).toBe(ravi.id);
      expect(await db.select().from(purchases)).toHaveLength(1);
    });

    it("rejects a TagMango order id twice (the webhook arriving again changes nothing)", async () => {
      const c = await makeContact({ name: "Fathima" });
      await recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "ORD-1" }), null);
      await expect(recordPurchase(base(c.id, { mode: "tagmango", source: "tagmango", reference: "ORD-1" }), null)).rejects.toThrow(
        "This TagMango order (ORD-1) is already recorded on Fathima.",
      );
      expect(await db.select().from(payments)).toHaveLength(1);
    });

    it("rejects a UTR already used by a payment (instalment or extra payment) on another purchase", async () => {
      const manager = await makeUser({ role: "manager" });
      const a = await makeContact({ name: "Anil" });
      const b = await makeContact({ name: "Beena" });
      const emi = await recordPurchase(
        base(a.id, {
          amount: 3000,
          mode: "upi_qr",
          instalments: [
            { amount: 1000, dueAt: new Date("2026-10-01T00:00:00Z") },
            { amount: 2000, dueAt: new Date("2026-11-01T00:00:00Z") },
          ],
          paidNow: { amount: 1000, reference: "INST-UTR-1" },
        }),
        manager,
      );
      // purchase-level reference colliding with a payment reference
      await expect(recordPurchase(base(b.id, { mode: "upi_qr", reference: "inst-utr-1" }), manager)).rejects.toThrow(/Anil/);
      // payment-level reference on addPayment
      const other = await recordPurchase(base(b.id, { amount: 5000, paidNow: null }), manager);
      await expect(addPayment(other.purchaseId, { amount: 100, mode: "bank_transfer", reference: "INST-UTR-1" }, manager)).rejects.toBeInstanceOf(
        DuplicateReferenceError,
      );
      // payment-level reference on an instalment
      await recordPurchase(base(b.id, { mode: "upi_qr", reference: "B-UTR" }), manager);
      await expect(
        recordInstalmentPayment(emi.paymentIds[1], { mode: "upi_qr", reference: "b-utr" }, manager),
      ).rejects.toThrow("This UTR (B-UTR) is already recorded on Beena.");
      expect((await paymentsOf(emi.purchaseId))[1].status).toBe("scheduled");
    });

    it("a purchase and its own payment may share the reference", async () => {
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(base(c.id, { mode: "upi_qr", reference: "SAME1", paidNow: { amount: 999, reference: "SAME1" } }), null);
      const [pay] = await paymentsOf(purchaseId);
      expect(pay.reference).toBe("SAME1");
      expect((await purchaseRow(purchaseId)).reference).toBe("SAME1");
    });

    it("turns a unique-index violation (a race past the check) into DuplicateReferenceError", async () => {
      const c = await makeContact({ name: "Race Winner" });
      const { purchaseId } = await recordPurchase(base(c.id, { mode: "upi_qr", reference: "RACE1" }), null);
      const err = await db
        .insert(payments)
        .values({ purchaseId, contactId: c.id, amount: 1, amountInr: 1, reference: "RACE1" })
        .catch((e) => e);
      const dup = await asDuplicateReferenceError(err, "UTR", db);
      expect(dup).toBeInstanceOf(DuplicateReferenceError);
      expect(dup?.message).toBe("This UTR (RACE1) is already recorded on Race Winner.");
      expect(await asDuplicateReferenceError(new Error("other"), "UTR", db)).toBeNull();
    });

    it("a failed record inside a caller's transaction leaves the transaction usable", async () => {
      const c = await makeContact({ name: "Tx" });
      await db.transaction(async (tx) => {
        await recordPurchase(base(c.id, { mode: "upi_qr", reference: "TX-1" }), null, tx);
        await expect(recordPurchase(base(c.id, { mode: "upi_qr", reference: "TX-1" }), null, tx)).rejects.toBeInstanceOf(DuplicateReferenceError);
        await expect(recordPurchase(base(c.id, { currency: "XYZ" }), null, tx)).rejects.toBeInstanceOf(UnknownCurrencyError);
        await recordPurchase(base(c.id, { mode: "upi_qr", reference: "TX-2" }), null, tx);
      });
      expect(await db.select().from(purchases)).toHaveLength(2);
    });
  });

  describe("instalments (EMI)", () => {
    const schedule = [
      { amount: 10000, dueAt: new Date("2026-10-10T00:00:00Z") },
      { amount: 10000, dueAt: new Date("2026-11-10T00:00:00Z") },
      { amount: 10000, dueAt: new Date("2026-12-10T00:00:00Z") },
    ];

    it("creates one scheduled row per instalment; pending -> partial -> paid as instalments are verified", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact({ ownerId: sales.id });
      const r = await recordPurchase(
        base(c.id, {
          family: "applied_ai_mastery",
          productName: "Applied AI Mastery",
          amount: 30000,
          mode: "upi_qr",
          purchasedAt: new Date("2026-10-10T06:00:00Z"),
          instalments: [schedule[2], schedule[0], schedule[1]],
          paidNow: { amount: 10000, reference: "emi-1", proofUrl: "uploads/emi1.png" },
        }),
        sales,
      );
      expect(r.status).toBe("pending");
      expect(r.paymentIds).toHaveLength(3);
      expect((await purchaseRow(r.purchaseId)).hasInstalments).toBe(true);
      let rows = await paymentsOf(r.purchaseId);
      expect(rows.map((x) => [x.seq, x.status, x.dueAt?.toISOString().slice(0, 10), x.reference])).toEqual([
        [1, "unverified", "2026-10-10", "EMI-1"],
        [2, "scheduled", "2026-11-10", null],
        [3, "scheduled", "2026-12-10", null],
      ]);
      expect(rows[0].proofUrl).toBe("uploads/emi1.png");
      expect(rows[0].paidAt).toBeInstanceOf(Date);
      expect(rows[1].paidAt).toBeNull();
      expect(r.paymentIds).toEqual(rows.map((x) => x.id));
      // the purchase itself has no reference: the UTR belongs to the first instalment
      expect((await purchaseRow(r.purchaseId)).reference).toBeNull();

      expect((await verifyPayment(rows[0].id, manager)).purchaseStatus).toBe("partial");

      // sales pays instalment 2: unverified, purchase still partial
      const p2 = await recordInstalmentPayment(rows[1].id, { mode: "upi_qr", reference: "EMI-2", paidAt: new Date("2026-10-09T06:00:00Z") }, sales);
      expect(p2).toMatchObject({ status: "unverified", purchaseStatus: "partial" });
      // a manager can pay and verify in one step
      const p3 = await recordInstalmentPayment(rows[2].id, { mode: "bank_transfer", reference: "EMI-3", verify: true }, manager);
      expect(p3).toMatchObject({ status: "verified", purchaseStatus: "partial" });
      expect((await verifyPayment(rows[1].id, manager)).purchaseStatus).toBe("paid");

      rows = await paymentsOf(r.purchaseId);
      expect(rows.map((x) => x.status)).toEqual(["verified", "verified", "verified"]);
      expect(await refreshPurchaseStatus(r.purchaseId)).toBe("paid");
    });

    it("omitting paidNow with instalments means nothing is paid yet", async () => {
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { amount: 30000, instalments: schedule }), null);
      expect(r.status).toBe("pending");
      expect((await paymentsOf(r.purchaseId)).every((x) => x.status === "scheduled")).toBe(true);
    });

    it("a TagMango EMI order pays and verifies the first instalment", async () => {
      const c = await makeContact();
      const r = await recordPurchase(
        base(c.id, { amount: 30000, mode: "tagmango", source: "tagmango", reference: "TM-EMI", instalments: schedule, paidNow: { amount: 10000 } }),
        null,
      );
      expect(r.status).toBe("partial");
      const rows = await paymentsOf(r.purchaseId);
      expect(rows[0]).toMatchObject({ status: "verified", reference: "TM-EMI" });
      expect((await purchaseRow(r.purchaseId)).reference).toBe("TM-EMI");
    });

    it("each instalment stores the fx of its own paid date", async () => {
      const admin = await makeUser({ role: "admin" });
      const c = await makeContact();
      const r = await recordPurchase(
        base(c.id, {
          amount: 2000,
          currency: "AED",
          // (dates in the past: money cannot be recorded as paid in the future)
          purchasedAt: new Date("2026-06-05T06:00:00Z"),
          instalments: [
            { amount: 1000, dueAt: new Date("2026-06-05T06:00:00Z") },
            { amount: 1000, dueAt: new Date("2026-09-05T06:00:00Z") },
          ],
          paidNow: { amount: 1000 },
          verified: true,
        }),
        admin,
      );
      let rows = await paymentsOf(r.purchaseId);
      expect(rows[0]).toMatchObject({ fxRate: 22.6, amountInr: 22600 });
      // scheduled row is estimated at its due date
      expect(rows[1]).toMatchObject({ fxRate: 22.6, amountInr: 22600, status: "scheduled" });

      const cfg = await getSetting("currency");
      await setSetting("currency", { ...cfg, rates: { ...cfg.rates, AED: { ...cfg.rates.AED, "2026-09": 23 } } }, admin.id);
      await recordInstalmentPayment(rows[1].id, { mode: "cash", reference: null, paidAt: new Date("2026-09-06T06:00:00Z"), verify: true }, admin);
      rows = await paymentsOf(r.purchaseId);
      expect(rows[0]).toMatchObject({ fxRate: 22.6, amountInr: 22600 });
      expect(rows[1]).toMatchObject({ fxRate: 23, amountInr: 23000, status: "verified" });
      expect((await purchaseRow(r.purchaseId)).status).toBe("paid");
    });

    it("rejects a schedule that does not add up, or a first payment that does not match", async () => {
      const c = await makeContact();
      await expect(
        recordPurchase(base(c.id, { amount: 30000, instalments: schedule.slice(0, 2) }), null),
      ).rejects.toThrow(/add up/);
      await expect(
        recordPurchase(base(c.id, { amount: 30000, instalments: schedule, paidNow: { amount: 5000 } }), null),
      ).rejects.toThrow(/first instalment/);
      expect(await db.select().from(purchases)).toHaveLength(0);
    });

    it("an instalment can be paid only once, with a UTR for bank/UPI, and not beyond what is left", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { amount: 30000, instalments: schedule }), sales);
      const rows = await paymentsOf(r.purchaseId);
      await expect(recordInstalmentPayment(rows[0].id, { mode: "upi_qr", reference: null }, sales)).rejects.toThrow(/UTR/);
      await expect(recordInstalmentPayment(rows[0].id, { mode: "cash", reference: null, amount: 30001 }, sales)).rejects.toThrow(/left to collect/);
      await recordInstalmentPayment(rows[0].id, { mode: "cash", reference: null }, sales);
      await expect(recordInstalmentPayment(rows[0].id, { mode: "cash", reference: null }, sales)).rejects.toThrow(/already been paid/);
      // sales cannot self-verify
      await expect(recordInstalmentPayment(rows[1].id, { mode: "cash", reference: null, verify: true }, sales)).rejects.toBeInstanceOf(PermissionError);
      expect((await paymentsOf(r.purchaseId))[1].status).toBe("scheduled");
    });
  });

  describe("extra payments", () => {
    it("adds part payments until the purchase is paid, never beyond the amount", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const r = await recordPurchase(base(c.id, { amount: 10000, paidNow: { amount: 4000 }, verified: true }), manager);
      expect(r.status).toBe("partial");
      await expect(addPayment(r.purchaseId, { amount: 6001, mode: "cash", reference: null }, sales)).rejects.toThrow(/left to collect/);
      await expect(addPayment(r.purchaseId, { amount: 100, mode: "upi_qr", reference: null }, sales)).rejects.toThrow(/UTR/);
      const p2 = await addPayment(r.purchaseId, { amount: 6000, mode: "upi_qr", reference: "bal-1", proofUrl: "uploads/b.png" }, sales);
      expect(p2).toMatchObject({ status: "unverified", purchaseStatus: "partial" });
      // an unverified claim also blocks over-collection
      await expect(addPayment(r.purchaseId, { amount: 1, mode: "cash", reference: null }, sales)).rejects.toThrow(/left to collect/);
      expect((await verifyPayment(p2.paymentId, manager)).purchaseStatus).toBe("paid");
      const rows = await paymentsOf(r.purchaseId);
      expect(rows.map((x) => [x.seq, x.amount, x.reference])).toEqual([
        [1, 4000, null],
        [2, 6000, "BAL-1"],
      ]);
    });

    it("an extra payment in another currency is valued via INR", async () => {
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact();
      const at = new Date("2026-10-05T06:00:00Z");
      const r = await recordPurchase(base(c.id, { amount: 1000, currency: "AED", purchasedAt: at, paidNow: { amount: 500 }, verified: true }), manager);
      const p = await addPayment(r.purchaseId, { amount: 11350, currency: "INR", mode: "cash", reference: null, paidAt: at, verify: true }, manager);
      expect(p.purchaseStatus).toBe("paid");
      const [, inrRow] = await paymentsOf(r.purchaseId);
      expect(inrRow).toMatchObject({ currency: "INR", fxRate: 1, amountInr: 11350 });
    });
  });

  describe("contact page", () => {
    it("lists purchases newest first with ordered payments, credit name and totals", async () => {
      const manager = await makeUser({ role: "manager", name: "Manu" });
      const c = await makeContact();
      const older = await recordPurchase(base(c.id, { amount: 999, purchasedAt: new Date("2026-01-05T06:00:00Z"), verified: true, creditedUserId: manager.id }), manager);
      const newer = await recordPurchase(
        base(c.id, {
          amount: 3000,
          purchasedAt: new Date("2026-10-05T06:00:00Z"),
          instalments: [
            { amount: 2000, dueAt: new Date("2026-11-05T00:00:00Z") },
            { amount: 1000, dueAt: new Date("2026-10-05T00:00:00Z") },
          ],
          paidNow: { amount: 1000 },
          verified: true,
        }),
        manager,
      );
      const list = await getContactPurchases(c.id);
      expect(list.map((p) => p.id)).toEqual([newer.purchaseId, older.purchaseId]);
      expect(list[0].payments.map((p) => [p.seq, p.status])).toEqual([
        [1, "verified"],
        [2, "scheduled"],
      ]);
      expect(list[0].totals).toMatchObject({ paid: 1000, scheduled: 2000, outstanding: 2000, netInr: 1000 });
      expect(list[1].creditedUserName).toBe("Manu");
      expect(list[1].totals.netInr).toBe(999);
      expect(await getContactPurchases((await makeContact()).id)).toEqual([]);
    });
  });

  it("defaults are the spec's", () => {
    expect(DEFAULT_SETTINGS.thresholds.salesCreditDays).toBe(30);
  });
});
