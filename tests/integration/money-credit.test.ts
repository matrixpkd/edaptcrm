import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLog, contacts, interactions, purchases, type NewContact } from "@/db/schema";
import { adjustCredit, computeSalesCredit } from "@/lib/money/credit";
import { NotFoundError, PermissionError, ValidationError } from "@/lib/money/errors";
import { recordPurchase, type RecordPurchaseInput } from "@/lib/money/purchases";
import { getSetting, setSetting } from "@/lib/settings";
import { makeUser, resetDb } from "../support/db";

const DAY = 86400_000;
let phoneN = 0;
async function makeContact(over: Partial<NewContact> = {}) {
  phoneN += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9192000${String(phoneN).padStart(5, "0")}`, name: `Contact ${phoneN}`, firstDoor: "meta_ad", ...over })
    .returning();
  return c;
}
async function logInteraction(contactId: string, userId: string | null, occurredAt: Date) {
  await db.insert(interactions).values({ contactId, userId, type: "call", outcome: "connected", occurredAt });
}
const purchaseRow = async (id: string) => (await db.select().from(purchases).where(eq(purchases.id, id)))[0];
const base = (contactId: string, over: Partial<RecordPurchaseInput> = {}): RecordPurchaseInput => ({
  contactId,
  productName: "Prompting workshop",
  family: "workshop",
  amount: 999,
  currency: "INR",
  mode: "tagmango",
  source: "tagmango",
  ...over,
});

describe("money: sales credit", () => {
  beforeEach(async () => {
    await resetDb();
  });

  const purchasedAt = new Date("2026-10-10T06:00:00Z");

  it("credits the current owner who logged an interaction in the 30 days before the purchase", async () => {
    const owner = await makeUser({ role: "sales" });
    const c = await makeContact({ ownerId: owner.id });
    await logInteraction(c.id, owner.id, new Date(purchasedAt.getTime() - 12 * DAY));
    expect(await computeSalesCredit(c.id, purchasedAt)).toMatchObject({ creditedUserId: owner.id, assisted: true });

    const { purchaseId } = await recordPurchase(base(c.id, { reference: "TM-1", purchasedAt }), null);
    expect(await purchaseRow(purchaseId)).toMatchObject({ creditedUserId: owner.id, assisted: true, creditAdjustedById: null });
  });

  it("the window is inclusive at 30 days and excludes day 31 and anything after the purchase", async () => {
    const owner = await makeUser({ role: "sales" });
    const edge = await makeContact({ ownerId: owner.id });
    await logInteraction(edge.id, owner.id, new Date(purchasedAt.getTime() - 30 * DAY));
    expect((await computeSalesCredit(edge.id, purchasedAt)).assisted).toBe(true);

    const old = await makeContact({ ownerId: owner.id });
    await logInteraction(old.id, owner.id, new Date(purchasedAt.getTime() - 31 * DAY));
    await logInteraction(old.id, owner.id, new Date(purchasedAt.getTime() + 1 * DAY));
    expect(await computeSalesCredit(old.id, purchasedAt)).toEqual({ creditedUserId: null, assisted: false, interactionId: null });

    const { purchaseId } = await recordPurchase(base(old.id, { reference: "TM-OLD", purchasedAt }), null);
    expect(await purchaseRow(purchaseId)).toMatchObject({ creditedUserId: null, assisted: false });
  });

  it("only the owner's own interactions count (not support, a previous owner or the system)", async () => {
    const owner = await makeUser({ role: "sales" });
    const previous = await makeUser({ role: "sales" });
    const support = await makeUser({ role: "support" });
    const c = await makeContact({ ownerId: owner.id });
    await logInteraction(c.id, support.id, new Date(purchasedAt.getTime() - 2 * DAY));
    await logInteraction(c.id, previous.id, new Date(purchasedAt.getTime() - 3 * DAY));
    await logInteraction(c.id, null, new Date(purchasedAt.getTime() - 1 * DAY));
    // the owner talked to someone else in the window: does not count for this contact
    const someoneElse = await makeContact({ ownerId: owner.id });
    await logInteraction(someoneElse.id, owner.id, new Date(purchasedAt.getTime() - 1 * DAY));
    expect((await computeSalesCredit(c.id, purchasedAt)).assisted).toBe(false);
  });

  it("an unowned contact is self-serve", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await makeContact();
    await logInteraction(c.id, sales.id, new Date(purchasedAt.getTime() - DAY));
    expect(await computeSalesCredit(c.id, purchasedAt)).toMatchObject({ creditedUserId: null, assisted: false });
  });

  it("the window comes from Settings (thresholds.salesCreditDays)", async () => {
    const admin = await makeUser({ role: "admin" });
    const owner = await makeUser({ role: "sales" });
    const c = await makeContact({ ownerId: owner.id });
    await logInteraction(c.id, owner.id, new Date(purchasedAt.getTime() - 40 * DAY));
    expect((await computeSalesCredit(c.id, purchasedAt)).assisted).toBe(false);
    const t = await getSetting("thresholds");
    await setSetting("thresholds", { ...t, salesCreditDays: 45 }, admin.id);
    expect((await computeSalesCredit(c.id, purchasedAt)).assisted).toBe(true);
  });

  describe("adjustCredit", () => {
    it("managers and admins adjust credit (audited); sales and support cannot", async () => {
      const owner = await makeUser({ role: "sales" });
      const other = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const support = await makeUser({ role: "support" });
      const c = await makeContact({ ownerId: owner.id });
      const { purchaseId } = await recordPurchase(base(c.id, { reference: "TM-ADJ", purchasedAt }), null);
      expect((await purchaseRow(purchaseId)).assisted).toBe(false);

      await expect(adjustCredit(purchaseId, owner.id, owner)).rejects.toBeInstanceOf(PermissionError);
      await expect(adjustCredit(purchaseId, owner.id, support)).rejects.toBeInstanceOf(PermissionError);
      expect((await purchaseRow(purchaseId)).creditedUserId).toBeNull();

      await adjustCredit(purchaseId, other.id, manager);
      expect(await purchaseRow(purchaseId)).toMatchObject({ creditedUserId: other.id, assisted: true, creditAdjustedById: manager.id });
      const log = await db.select().from(auditLog).where(and(eq(auditLog.rowId, purchaseId), eq(auditLog.field, "creditedUserId")));
      expect(log).toEqual([expect.objectContaining({ oldValue: null, newValue: other.id, userId: manager.id })]);

      const admin = await makeUser({ role: "admin" });
      await adjustCredit(purchaseId, null, admin);
      expect(await purchaseRow(purchaseId)).toMatchObject({ creditedUserId: null, assisted: false, creditAdjustedById: admin.id });
    });

    it("credit cannot go to support or a missing user; a missing purchase is reported", async () => {
      const manager = await makeUser({ role: "manager" });
      const support = await makeUser({ role: "support" });
      const c = await makeContact();
      const { purchaseId } = await recordPurchase(base(c.id, { reference: "TM-X" }), null);
      await expect(adjustCredit(purchaseId, support.id, manager)).rejects.toBeInstanceOf(ValidationError);
      await expect(adjustCredit(purchaseId, "00000000-0000-0000-0000-000000000000", manager)).rejects.toBeInstanceOf(NotFoundError);
      await expect(adjustCredit("00000000-0000-0000-0000-000000000000", manager.id, manager)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("an explicit credit on recordPurchase is honoured only for managers/admins", async () => {
      const owner = await makeUser({ role: "sales" });
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const c = await makeContact({ ownerId: owner.id });
      await logInteraction(c.id, owner.id, new Date(purchasedAt.getTime() - DAY));

      // sales trying to claim credit: ignored, the rule decides
      const bySales = await recordPurchase(base(c.id, { mode: "cash", source: "manual", purchasedAt, creditedUserId: sales.id }), sales);
      expect(await purchaseRow(bySales.purchaseId)).toMatchObject({ creditedUserId: owner.id, assisted: true, creditAdjustedById: null });

      // manager override, including "self-serve"
      const byManager = await recordPurchase(base(c.id, { mode: "cash", source: "manual", purchasedAt, creditedUserId: sales.id }), manager);
      expect(await purchaseRow(byManager.purchaseId)).toMatchObject({ creditedUserId: sales.id, assisted: true, creditAdjustedById: manager.id });
      const selfServe = await recordPurchase(base(c.id, { mode: "cash", source: "manual", purchasedAt, creditedUserId: null }), manager);
      expect(await purchaseRow(selfServe.purchaseId)).toMatchObject({ creditedUserId: null, assisted: false, creditAdjustedById: manager.id });
    });
  });
});
