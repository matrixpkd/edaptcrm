import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, notifications, payments } from "@/db/schema";
import { unverifiedPayments } from "@/lib/alerts/rules";
import { cancelPurchase, recordPurchase, type RecordPurchaseInput } from "@/lib/money/purchases";
import { paymentsDesk } from "@/lib/today/desk";
import { getNotification, notificationHref } from "@/lib/today/inbox";
import { makeUser, resetDb } from "../support/db";

const D = 86_400_000;
let n = 0;
async function contact(ownerId: string | null) {
  n += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9198471${String(n).padStart(5, "0")}`, name: `Desk ${n}`, firstDoor: "youtube", ownerId })
    .returning();
  return c;
}
const base = (contactId: string, over: Partial<RecordPurchaseInput> = {}): RecordPurchaseInput => ({
  contactId,
  productName: "Workshop",
  family: "workshop",
  amount: 1000,
  currency: "INR",
  mode: "upi_qr",
  source: "manual",
  ...over,
});

describe("paymentsDesk (manager's money work on Today and in the digest)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("is null for people who cannot verify, and counts unverified, stale and overdue money for managers", async () => {
    const sales = await makeUser({ role: "sales" });
    const manager = await makeUser({ role: "manager" });
    const c = await contact(sales.id);
    const now = new Date();
    expect(await paymentsDesk(sales, now)).toBeNull();
    expect(await paymentsDesk(manager, now)).toEqual({ unverified: 0, unverifiedInr: 0, stale: 0, staleDays: 2, overdueInstalments: 0 });

    // one fresh claim, one waiting 3 days, one on a cancelled purchase (not counted)
    await recordPurchase(base(c.id, { paidNow: { amount: 1000, reference: "DESK-1" } }), sales);
    await recordPurchase(
      base(c.id, { amount: 500, purchasedAt: new Date(now.getTime() - 3 * D), paidNow: { amount: 500, reference: "DESK-2" } }),
      sales,
    );
    const gone = await recordPurchase(base(c.id, { amount: 700, paidNow: { amount: 700, reference: "DESK-3" } }), sales);
    await cancelPurchase(gone.purchaseId, manager, "wrong contact");
    // an EMI with its first instalment overdue and the second in the future
    await recordPurchase(
      base(c.id, {
        amount: 2000,
        instalments: [
          { amount: 1000, dueAt: new Date(now.getTime() - 2 * D) },
          { amount: 1000, dueAt: new Date(now.getTime() + 20 * D) },
        ],
        paidNow: null,
      }),
      sales,
    );

    expect(await paymentsDesk(manager, now)).toEqual({
      unverified: 2,
      unverifiedInr: 1500,
      stale: 1,
      staleDays: 2,
      overdueInstalments: 1,
    });
  });
});

describe("opening a money alert", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("an unverified-payment alert opens its purchase (where Verify is); other alerts open the contact", async () => {
    const sales = await makeUser({ role: "sales" });
    const manager = await makeUser({ role: "manager" });
    const c = await contact(sales.id);
    const now = new Date();
    const r = await recordPurchase(
      base(c.id, { purchasedAt: new Date(now.getTime() - 3 * D), paidNow: { amount: 1000, reference: "ALERT-1" } }),
      sales,
    );
    expect((await unverifiedPayments(now)).notified).toBe(1);
    const [alert] = await db.select().from(notifications).where(eq(notifications.userId, manager.id));
    expect(alert.dedupeKey?.startsWith(`unverified_payment:${r.paymentIds[0]}`)).toBe(true);

    const opened = await getNotification(manager.id, alert.id);
    expect(opened?.purchaseId).toBe(r.purchaseId);
    expect(notificationHref(opened!)).toBe(`/payments/${r.purchaseId}`);

    // a contact alert, and a money alert whose key does not name a payment, still open the contact
    const [plain] = await db
      .insert(notifications)
      .values([
        { userId: manager.id, type: "hot_lead", title: "Hot lead", contactId: c.id, dedupeKey: `hot_lead:${r.paymentIds[0]}` },
        { userId: manager.id, type: "unverified_payment", title: "Old", contactId: c.id, dedupeKey: "unverified_payment:not-a-uuid" },
      ])
      .returning();
    const hot = await getNotification(manager.id, plain.id);
    expect(hot?.purchaseId).toBeNull();
    expect(notificationHref(hot!)).toBe(`/contacts/${c.id}`);
    const [odd] = await db.select().from(notifications).where(eq(notifications.dedupeKey, "unverified_payment:not-a-uuid"));
    expect(notificationHref((await getNotification(manager.id, odd.id))!)).toBe(`/contacts/${c.id}`);

    // someone else's notification is never returned
    expect(await getNotification(sales.id, alert.id)).toBeNull();
    expect(await db.select().from(payments).where(eq(payments.purchaseId, r.purchaseId))).toHaveLength(1);
  });
});
