import { randomInt } from "node:crypto";
import { eq, ilike } from "drizzle-orm";
import { payments, purchases, webhookEvents } from "@/db/schema";
import { test, expect, db, findContactByPhone, makeContact, uniqueName, uniquePhone } from "./support/fixtures";
import { E2E_SECRETS } from "./support/env";

// laptop project only (playwright.config.ts)

const URL_OK = `/api/webhooks/tagmango?token=${E2E_SECRETS.tagmango}`;

test("a completed TagMango order with an affiliate makes a first-purchase customer, linked to the referrer, once", async ({ request, pageAs }) => {
  const buyerPhone = await uniquePhone();
  const referrer = await makeContact({ owner: "sales2" });
  const orderId = `TM-E2E-${Date.now()}-${randomInt(1000, 9999)}`;
  const name = uniqueName("Buyer");
  const order = {
    orderId,
    orderStatus: "completed",
    name,
    email: `${name.split(" ")[1].toLowerCase()}@example.com`,
    phone: buyerPhone.e164.slice(3),
    dialCode: "+91",
    amountPaid: 999,
    currency: "INR",
    mangoName: "Claude Mastery Workshop",
    mangoId: "mango_cm_01",
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    affiliate: { name: referrer.name, phone: referrer.phoneE164.slice(3), dialCode: "91" },
    customFields: [{ question: "How well do you know Umer?", answer: "I watch his videos regularly" }],
  };

  const first = await request.post(URL_OK, { data: order });
  expect(first.status()).toBe(200);
  expect(await first.json()).toMatchObject({ ok: true, duplicate: false });

  const buyer = await findContactByPhone(buyerPhone.e164);
  expect(buyer).not.toBeNull();
  expect(buyer!).toMatchObject({ name, stage: "first_purchase", referredById: referrer.id, ltvInr: 999, purchaseCount: 1 });
  const bought = await db.select().from(purchases).where(eq(purchases.contactId, buyer!.id));
  expect(bought).toHaveLength(1);
  expect(bought[0]).toMatchObject({ reference: orderId, source: "tagmango", mode: "tagmango", amountInr: 999 });
  const paid = await db.select().from(payments).where(eq(payments.purchaseId, bought[0].id));
  expect(paid.map((p) => p.status)).toEqual(["verified"]);

  // the same delivery again changes nothing
  const again = await request.post(URL_OK, { data: order });
  expect(again.status()).toBe(200);
  expect(await again.json()).toMatchObject({ ok: true, duplicate: true });
  expect(await db.select().from(purchases).where(eq(purchases.reference, orderId))).toHaveLength(1);
  expect(await db.select().from(payments).where(eq(payments.contactId, buyer!.id))).toHaveLength(1);
  expect((await findContactByPhone(buyerPhone.e164))!.ltvInr).toBe(999);

  // and the contact page shows it
  const page = await pageAs("manager");
  await page.goto(`/contacts/${buyer!.id}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.locator("main").getByText("First purchase", { exact: true }).first()).toBeVisible();
  await page.goto(`/contacts/${buyer!.id}?tab=referrals`);
  await expect(page.getByRole("link", { name: referrer.name }).first()).toBeVisible();
});

test("a webhook with a wrong or missing secret is refused", async ({ request }) => {
  const order = { orderId: `TM-E2E-BAD-${Date.now()}`, orderStatus: "completed", name: "Nobody", phone: "9847000000", dialCode: "91", amountPaid: 1 };
  for (const url of ["/api/webhooks/tagmango?token=wrong", "/api/webhooks/tagmango"]) {
    const res = await request.post(url, { data: order });
    expect(res.status(), url).toBe(401);
  }
  expect(await db.select().from(purchases).where(eq(purchases.reference, order.orderId))).toHaveLength(0);
  expect(await db.select().from(webhookEvents).where(ilike(webhookEvents.eventKey, `%${order.orderId}%`))).toHaveLength(0);
});
