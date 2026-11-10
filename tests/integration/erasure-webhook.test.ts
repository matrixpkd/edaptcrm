import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, enquiries, purchases, webhookEvents } from "@/db/schema";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ERASED_NAME, eraseContact } from "@/lib/contacts/privacy";
import { ingestWebhook } from "@/lib/webhooks/handlers";
import { makeUser, resetDb } from "../support/db";

/**
 * A TagMango order for a contact whose erasure commits between the order's capture and its purchase (the webhook
 * handler runs them one after the other, each in its own transaction). The hook below runs once, just before the
 * purchase is recorded, to land the erasure exactly there.
 */
const hook = vi.hoisted(() => ({ beforePurchase: null as null | ((contactId: string) => Promise<void>) }));
vi.mock("@/lib/money/purchases", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/money/purchases")>();
  return {
    ...orig,
    recordPurchase: async (...args: Parameters<typeof orig.recordPurchase>) => {
      const run = hook.beforePurchase;
      hook.beforePurchase = null;
      if (run) await run(args[0].contactId);
      return orig.recordPurchase(...args);
    },
  };
});

describe("a webhook racing an erasure", () => {
  beforeEach(resetDb);

  it("an order whose contact is erased mid-way goes to a new contact, as one arriving after the erasure does", async () => {
    const admin = await makeUser({ role: "admin" });
    const c = (await captureEnquiry({ phone: "9847012345", name: "Priya Nair", channel: "phone_call", skipAlerts: true, skipAssignment: true })).contact;
    hook.beforePurchase = async (contactId) => {
      await eraseContact(contactId, admin, "Asked by email");
    };
    const order = "TM-RACE-1";
    const payload = { orderId: order, orderStatus: "completed", name: "Priya Nair", phone: c.phoneE164, email: "priya@example.com", amountPaid: 499, currency: "INR", mangoName: "Prompt Workshop" };

    const out = await ingestWebhook("tagmango", payload);
    // the erasure landed between the capture and the purchase
    expect(hook.beforePurchase).toBeNull();
    expect(out).toMatchObject({ ok: true });
    expect(out.contactId).not.toBe(c.id);

    // the order is on a new contact with the number
    const [p] = await db.select().from(purchases).where(eq(purchases.reference, order));
    expect(p).toMatchObject({ contactId: out.contactId, amount: 499 });
    const fresh = (await db.select().from(contacts).where(eq(contacts.id, out.contactId!)))[0];
    expect(fresh).toMatchObject({ phoneE164: c.phoneE164, name: "Priya Nair", erasedAt: null, ltvInr: 499 });
    const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, out.eventId!));
    expect(ev).toMatchObject({ contactId: out.contactId, error: null });
    expect(await db.select().from(enquiries).where(eq(enquiries.sourceRef, `tagmango:order:${order}:completed`))).toMatchObject([{ contactId: out.contactId }]);

    // nothing of it is on the erased contact: no purchase, and the enquiry the capture wrote first was cleared
    expect(await db.select().from(purchases).where(eq(purchases.contactId, c.id))).toHaveLength(0);
    const leftOn = await db.select().from(enquiries).where(eq(enquiries.contactId, c.id));
    expect(leftOn.every((e) => e.rawPayload === null && e.notes === null && e.sourceRef !== `tagmango:order:${order}:completed`)).toBe(true);
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0]).toMatchObject({ name: ERASED_NAME, email: null, ltvInr: 0 });
    expect(JSON.stringify(await db.select().from(contacts).where(eq(contacts.id, c.id)))).not.toMatch(/Priya|priya@/);
  });
});
