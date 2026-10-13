import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { contacts, enquiries, interactions, notifications, payments, products, purchases, ratings, tasks, webhookEvents } from "@/db/schema";
import { GET as libromiGET, POST as libromiPOST } from "@/app/api/webhooks/libromi/route";
import { POST as metaLeadPOST } from "@/app/api/webhooks/pabbly/meta-lead/route";
import { POST as websiteFormPOST } from "@/app/api/webhooks/pabbly/website-form/route";
import { POST as pabblyWhatsAppPOST } from "@/app/api/webhooks/pabbly/whatsapp/route";
import { POST as tagmangoPOST } from "@/app/api/webhooks/tagmango/route";
import { abandonedCheckouts } from "@/lib/alerts/rules";
import { captureEnquiry } from "@/lib/contacts/capture";
import { applyRating } from "@/lib/contacts/profile";
import { setSetting } from "@/lib/settings";
import { reprocessWebhookEvent } from "@/lib/webhooks/handlers";
import { makeUser, resetDb } from "../support/db";

// alert emails are only logged in tests
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true, id: "test" })) }));

const SECRETS = { TAGMANGO_WEBHOOK_SECRET: "tm-test-secret", LIBROMI_WEBHOOK_SECRET: "lb-test-secret", PABBLY_WEBHOOK_SECRET: "pb-test-secret" };
const saved: Record<string, string | undefined> = {};

type Route = (req: Request) => Promise<Response>;
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(__dirname, "../fixtures/webhooks", `${name}.json`), "utf8"));

async function send(
  route: Route,
  body: unknown,
  opts: { secret?: string | null; contentType?: string; raw?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const secret = opts.secret === undefined ? defaultSecret(route) : opts.secret;
  const url = `http://localhost/api/webhooks/test${secret ? `?token=${encodeURIComponent(secret)}` : ""}`;
  const res = await route(
    new Request(url, {
      method: "POST",
      headers: { "content-type": opts.contentType ?? "application/json" },
      body: opts.raw ?? JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function defaultSecret(route: Route): string {
  if (route === tagmangoPOST) return SECRETS.TAGMANGO_WEBHOOK_SECRET;
  if (route === libromiPOST) return SECRETS.LIBROMI_WEBHOOK_SECRET;
  return SECRETS.PABBLY_WEBHOOK_SECRET;
}

async function count(table: PgTable, where?: SQL): Promise<number> {
  const q = db.select({ n: sql<number>`count(*)::int` }).from(table);
  const rows = where ? await q.where(where) : await q;
  return rows[0].n;
}

const contactByPhone = async (e164: string) => (await db.select().from(contacts).where(eq(contacts.phoneE164, e164)))[0];
const nowSeconds = (offsetMs = 0) => String(Math.floor((Date.now() + offsetMs) / 1000));
const H = 3600_000;

beforeAll(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let sales: Awaited<ReturnType<typeof makeUser>>;
beforeEach(async () => {
  await resetDb();
  sales = await makeUser({ role: "sales", team: "kerala" });
  await makeUser({ role: "sales", team: "dubai" });
  await db.insert(products).values([
    { name: "Claude Mastery Workshop", family: "workshop", rung: 1, listPrice: 999, externalIds: ["mango_cm_01"] },
    { name: "Applied AI Mastery", family: "applied_ai_mastery", rung: 2, listPrice: 14999 },
  ]);
});

describe("webhook auth and bodies", () => {
  it("refuses a wrong or missing secret with 401 and stores nothing", async () => {
    const order = fixture("tagmango-completed-flat");
    expect((await send(tagmangoPOST, order, { secret: "wrong" })).status).toBe(401);
    expect((await send(tagmangoPOST, order, { secret: null })).status).toBe(401);
    // each pipe has its own secret
    expect((await send(libromiPOST, fixture("libromi-flat"), { secret: SECRETS.PABBLY_WEBHOOK_SECRET })).status).toBe(401);
    expect(await count(webhookEvents)).toBe(0);
    expect(await count(contacts)).toBe(0);
  });

  it("accepts the secret as a header or a bearer token too", async () => {
    const res = await tagmangoPOST(
      new Request("http://localhost/api/webhooks/tagmango", {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": SECRETS.TAGMANGO_WEBHOOK_SECRET },
        body: JSON.stringify(fixture("tagmango-failed")),
      }),
    );
    expect(res.status).toBe(200);
    const bearer = await metaLeadPOST(
      new Request("http://localhost/api/webhooks/pabbly/meta-lead", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRETS.PABBLY_WEBHOOK_SECRET}` },
        body: JSON.stringify(fixture("pabbly-meta-lead")),
      }),
    );
    expect(bearer.status).toBe(200);
  });

  it("answers 400 for malformed JSON and an empty body, storing nothing", async () => {
    const bad = await send(tagmangoPOST, null, { raw: '{"orderId": "1", ' });
    expect(bad.status).toBe(400);
    expect(bad.json.ok).toBe(false);
    expect((await send(libromiPOST, null, { raw: "" })).status).toBe(400);
    expect(await count(webhookEvents)).toBe(0);
  });

  it("answers the Meta-style verification handshake on GET", async () => {
    const ok = await libromiGET(
      new Request(`http://localhost/api/webhooks/libromi?hub.mode=subscribe&hub.verify_token=${SECRETS.LIBROMI_WEBHOOK_SECRET}&hub.challenge=12345`),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    const no = await libromiGET(new Request("http://localhost/api/webhooks/libromi?hub.verify_token=nope&hub.challenge=1"));
    expect(no.status).toBe(401);
  });
});

describe("TagMango orders", () => {
  it("a completed order creates the contact, a verified purchase, the referral link and self-ratings", async () => {
    const r = await send(tagmangoPOST, fixture("tagmango-completed-flat"));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, duplicate: false });

    const buyer = await contactByPhone("+919847012345");
    expect(buyer).toMatchObject({
      name: "Ayesha Rahman",
      email: "ayesha.rahman@example.com",
      firstChannel: "tagmango_checkout",
      // the self-reported door beats the referral default
      firstDoor: "youtube",
      umerLevel: 3,
      ownerId: sales.id,
      purchaseCount: 1,
      ltvInr: 999,
      stage: "first_purchase",
    });
    expect(buyer.fieldSources).toMatchObject({ umer_level: "self" });

    const affiliate = await contactByPhone("+919846098460");
    expect(affiliate).toMatchObject({ name: "Rafeeq K" });
    expect(buyer.referredById).toBe(affiliate.id);

    const [p] = await db.select().from(purchases).where(eq(purchases.contactId, buyer.id));
    expect(p).toMatchObject({
      reference: "TM-ORD-1001",
      source: "tagmango",
      mode: "tagmango",
      status: "paid",
      amount: 999,
      currency: "INR",
      amountInr: 999,
      productName: "Claude Mastery Workshop",
      family: "workshop",
    });
    expect(p.productId).toBeTruthy();
    expect(p.purchasedAt.toISOString()).toBe("2026-10-12T09:30:00.000Z");
    const pays = await db.select().from(payments).where(eq(payments.purchaseId, p.id));
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ status: "verified", reference: "TM-ORD-1001", amount: 999 });

    const [e] = await db.select().from(enquiries).where(eq(enquiries.contactId, buyer.id));
    expect(e).toMatchObject({ channel: "tagmango_checkout", status: "handled", sourceRef: "tagmango:order:TM-ORD-1001:completed", productInterest: "Claude Mastery Workshop" });
    expect(e.notes).toContain("How did you first hear about Edapt?: YouTube");

    const selfRatings = await db.select().from(ratings).where(and(eq(ratings.contactId, buyer.id), eq(ratings.source, "self")));
    expect(selfRatings).toHaveLength(1);
    expect(selfRatings[0].umerLevel).toBe(3);

    const [ev] = await db.select().from(webhookEvents);
    expect(ev).toMatchObject({ source: "tagmango", eventKey: "tagmango:order:TM-ORD-1001:completed", error: null, contactId: buyer.id });
    expect(ev.processedAt).toBeTruthy();
    expect(ev.payload).toMatchObject({ orderId: "TM-ORD-1001" });
  });

  it("the same order delivered twice changes nothing", async () => {
    const order = fixture("tagmango-completed-flat");
    expect((await send(tagmangoPOST, order)).json).toMatchObject({ ok: true, duplicate: false });
    expect((await send(tagmangoPOST, order)).json).toMatchObject({ ok: true, duplicate: true });
    const buyer = await contactByPhone("+919847012345");
    expect(await count(purchases)).toBe(1);
    expect(await count(payments)).toBe(1);
    expect(await count(enquiries, eq(enquiries.contactId, buyer.id))).toBe(1);
    expect(await count(webhookEvents)).toBe(1);
    expect(await count(ratings)).toBe(1);

    // even when the event log is lost, the enquiry source ref and the purchase reference still dedupe
    await db.delete(webhookEvents);
    expect((await send(tagmangoPOST, order)).json).toMatchObject({ ok: true, duplicate: false, result: "Order TM-ORD-1001 was already recorded" });
    expect(await count(purchases)).toBe(1);
    expect(await count(enquiries, eq(enquiries.contactId, buyer.id))).toBe(1);
    expect((await contactByPhone("+919847012345")).ltvInr).toBe(999);
  });

  it("reads a nested AED order and matches self-ratings from an answers object", async () => {
    const r = await send(tagmangoPOST, fixture("tagmango-completed-nested"));
    expect(r.json).toMatchObject({ ok: true });
    const buyer = await contactByPhone("+971501234567");
    expect(buyer).toMatchObject({ name: "Shameer P", firstDoor: "meta_ad", umerLevel: 2, phoneCountry: "AE" });
    const [p] = await db.select().from(purchases).where(eq(purchases.contactId, buyer.id));
    // not in the catalogue: the default family from settings, with a note to map it
    expect(p).toMatchObject({ currency: "AED", amount: 249, productId: null, family: "workshop", reference: "65f0c0ffee1234567890abcd" });
    expect(p.notes).toContain("mango_office_dxb");
    expect(p.amountInr).toBeCloseTo(249 * 22.7, 2);
  });

  it("started then completed within the hour: handled, and no abandoned-checkout task when the rule runs", async () => {
    const started = fixture("tagmango-initiated");
    delete started.created_at;
    expect((await send(tagmangoPOST, started)).json).toMatchObject({ ok: true });
    const c = await contactByPhone("+919847022222");
    const [e1] = await db.select().from(enquiries).where(eq(enquiries.contactId, c.id));
    expect(e1).toMatchObject({ status: "checkout_started", productInterest: "Applied AI Mastery", sourceRef: "tagmango:order:TM-ORD-2002:started", campaign: "claude_mastery_meta" });

    const completed = { ...started, status: "completed" };
    expect((await send(tagmangoPOST, completed)).json).toMatchObject({ ok: true, duplicate: false });
    expect(await count(purchases, eq(purchases.contactId, c.id))).toBe(1);
    const [p] = await db.select().from(purchases).where(eq(purchases.contactId, c.id));
    expect(p).toMatchObject({ reference: "TM-ORD-2002", family: "applied_ai_mastery", amount: 14999, status: "paid" });
    const statuses = (await db.select().from(enquiries).where(eq(enquiries.contactId, c.id))).map((e) => e.status).sort();
    expect(statuses).toEqual(["handled", "handled"]);

    const res = await abandonedCheckouts(new Date(Date.now() + 2 * H));
    expect(res.tasks).toBe(0);
    expect(await count(tasks, eq(tasks.type, "abandoned_checkout"))).toBe(0);
  });

  it("started and not paid within the hour becomes a call task; paying later recovers it", async () => {
    const started = fixture("tagmango-initiated");
    delete started.created_at;
    await send(tagmangoPOST, started);
    const c = await contactByPhone("+919847022222");

    const res = await abandonedCheckouts(new Date(Date.now() + 61 * 60_000));
    expect(res.tasks).toBe(1);
    const [t] = await db.select().from(tasks).where(eq(tasks.type, "abandoned_checkout"));
    expect(t).toMatchObject({ contactId: c.id, userId: sales.id, status: "open" });

    await send(tagmangoPOST, { ...started, status: "paid" });
    const [after] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(after.status).toBe("done");
    const [e] = await db.select().from(enquiries).where(and(eq(enquiries.contactId, c.id), eq(enquiries.sourceRef, "tagmango:order:TM-ORD-2002:started")));
    expect(e.status).toBe("recovered");
  });

  it("a failed payment becomes a checkout_failed enquiry and no purchase", async () => {
    const r = await send(tagmangoPOST, fixture("tagmango-failed"));
    expect(r.json).toMatchObject({ ok: true, result: "Payment failed for Prompt Engineering Workshop (order TM-ORD-3003)" });
    const c = await contactByPhone("+919847033333");
    expect(c).toMatchObject({ name: "Lakshmi Nair", umerLevel: 0, firstDoor: "referral" });
    const [e] = await db.select().from(enquiries).where(eq(enquiries.contactId, c.id));
    expect(e).toMatchObject({ status: "checkout_failed", productInterest: "Prompt Engineering Workshop", sourceRef: "tagmango:order:TM-ORD-3003:failed" });
    expect(await count(purchases)).toBe(0);
  });

  it("an order we cannot fully process is stored, answered 200 with the error, and can be reprocessed after a fix", async () => {
    const admin = await makeUser({ role: "admin" });
    const order = { ...fixture("tagmango-completed-flat"), orderId: "TM-ORD-4004" } as Record<string, unknown>;
    delete order.amountPaid;
    order.charges = { net: "₹999" };
    const r = await send(tagmangoPOST, order);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: false, duplicate: false });
    expect(String(r.json.error)).toContain("No amount");
    const [ev] = await db.select().from(webhookEvents);
    expect(ev.processedAt).toBeNull();
    expect(ev.error).toContain("No amount");
    // the person is captured even though the purchase waits
    const buyer = await contactByPhone("+919847012345");
    expect(ev.contactId).toBe(buyer.id);
    expect(await count(purchases)).toBe(0);

    // a sales user cannot reprocess
    await expect(reprocessWebhookEvent(ev.id, sales)).rejects.toThrow(/admin/);

    await setSetting("integrations.fieldPaths", { tagmango: { amount: ["charges.net"] }, libromi: {}, pabbly: {} }, admin.id);
    const again = await reprocessWebhookEvent(ev.id, admin);
    expect(again).toMatchObject({ ok: true });
    const [fixed] = await db.select().from(webhookEvents);
    expect(fixed.error).toBeNull();
    expect(fixed.processedAt).toBeTruthy();
    expect(await count(purchases, eq(purchases.reference, "TM-ORD-4004"))).toBe(1);
    expect(await count(enquiries, eq(enquiries.contactId, buyer.id))).toBe(1);
  });

  it("a repeat delivery of a failed event processes it again", async () => {
    const order = { ...fixture("tagmango-completed-flat"), currency: "SGD" };
    const first = await send(tagmangoPOST, order);
    expect(first.json).toMatchObject({ ok: false });
    expect(String(first.json.error)).toContain("SGD");
    await setSetting("currency", { base: "INR", enabled: ["INR", "SGD"], rates: { SGD: { "2026-01": 64 } } }, null);
    const second = await send(tagmangoPOST, order);
    expect(second.json).toMatchObject({ ok: true, duplicate: true });
    expect(await count(purchases)).toBe(1);
    expect(await count(webhookEvents)).toBe(1);
  });

  it("an unknown status is stored and skipped with a note", async () => {
    const r = await send(tagmangoPOST, { orderId: "TM-9", status: "shipped", phone: "9847012345" });
    expect(r.json).toMatchObject({ ok: true });
    expect(String(r.json.note)).toMatch(/^Skipped:/);
    expect(await count(contacts)).toBe(0);
    const [ev] = await db.select().from(webhookEvents);
    expect(ev.eventKey).toBe("tagmango:order:TM-9:shipped");
  });

  it("a paid order without a phone is attached to the contact holding its email", async () => {
    const known = await captureEnquiry({ phone: "9847088888", name: "Known Buyer", email: "known@example.com", channel: "phone_call", skipAlerts: true });
    const r = await send(tagmangoPOST, { orderId: "TM-EMAIL-1", orderStatus: "completed", email: "KNOWN@example.com", amount: 699, mangoName: "Claude Mastery Workshop" });
    expect(r.json).toMatchObject({ ok: true, contactId: known.contact.id });
    expect(await count(purchases, eq(purchases.contactId, known.contact.id))).toBe(1);
    // an unusable phone falls back to the email too
    const bad = await send(tagmangoPOST, { orderId: "TM-EMAIL-2", orderStatus: "completed", phone: "12", email: "known@example.com", amount: 699, mangoName: "Claude Mastery Workshop" });
    expect(bad.json).toMatchObject({ ok: true, contactId: known.contact.id });
    expect(await count(purchases, eq(purchases.contactId, known.contact.id))).toBe(2);
    // without a known email the order fails with the reason
    const lost = await send(tagmangoPOST, { orderId: "TM-EMAIL-3", orderStatus: "completed", phone: "12", amount: 699 });
    expect(lost.json).toMatchObject({ ok: false });
    expect(String(lost.json.error)).toContain('"12" is not a valid phone number');
  });
});

describe("Libromi WhatsApp", () => {
  it("the first message is an enquiry, the next ones in the window are inbound interactions", async () => {
    const first = fixture("libromi-cloud-text");
    const msg = (first.entry as { changes: { value: { messages: Record<string, unknown>[] } }[] }[])[0].changes[0].value.messages[0];
    msg.timestamp = nowSeconds(-10 * 60_000);
    expect((await send(libromiPOST, first)).json).toMatchObject({ ok: true, result: "New chat: contact created" });

    const c = await contactByPhone("+919847055555");
    expect(c).toMatchObject({ name: "Nisha Menon", firstChannel: "whatsapp_api", firstDoor: "meta_ad", firstCampaign: "claude_mastery_meta" });
    const [e] = await db.select().from(enquiries).where(eq(enquiries.contactId, c.id));
    expect(e).toMatchObject({ channel: "whatsapp_api", sourceRef: "libromi:msg:wamid.HBgMOTE5ODQ3MDU1NTU1FQIAEhgUM0E", notes: "Hi, I want to know about the Claude workshop" });

    const reply = fixture("libromi-cloud-button");
    const replyMsg = (reply.entry as { changes: { value: { messages: Record<string, unknown>[] } }[] }[])[0].changes[0].value.messages[0];
    replyMsg.timestamp = nowSeconds(-5 * 60_000);
    expect((await send(libromiPOST, reply)).json).toMatchObject({ ok: true });

    expect(await count(enquiries, eq(enquiries.contactId, c.id))).toBe(1);
    const [i] = await db.select().from(interactions).where(eq(interactions.contactId, c.id));
    expect(i).toMatchObject({ type: "whatsapp", direction: "in", userId: null, externalRef: "libromi:msg:wamid.BUTTON0001", summary: 'Tapped "Watch him regularly"' });
    // the one-tap answer is a self-rating
    const after = await contactByPhone("+919847055555");
    expect(after.umerLevel).toBe(3);
    expect(after.fieldSources).toMatchObject({ umer_level: "self" });
    // a system-logged reply is not a salesperson's touch
    expect(after.stage).toBe("new");

    // the same message again changes nothing
    expect((await send(libromiPOST, reply)).json).toMatchObject({ duplicate: true });
    expect(await count(interactions)).toBe(1);
    expect(await count(ratings)).toBe(1);
  });

  it("a message after the conversation window is a new enquiry", async () => {
    const base = fixture("libromi-flat");
    await send(libromiPOST, { ...base, timestamp: new Date(Date.now() - 30 * H).toISOString() });
    await send(libromiPOST, { ...base, messageId: "lb_msg_9002", message: "Any update?", timestamp: new Date().toISOString() });
    const c = await contactByPhone("+919847044444");
    expect(await count(enquiries, eq(enquiries.contactId, c.id))).toBe(2);
    expect(await count(interactions)).toBe(0);
    // campaign named by its label is stored as its key
    expect(c.firstCampaign).toBe("koduvally_ai_literacy");
  });

  it("delivery statuses are stored and skipped", async () => {
    const r = await send(libromiPOST, fixture("libromi-status"));
    expect(r.json).toMatchObject({ ok: true });
    expect(String(r.json.note)).toMatch(/^Skipped: a delivery status/);
    expect(await count(contacts)).toBe(0);
    expect(await count(webhookEvents)).toBe(1);
  });

  it("a tapped first door fills a contact whose door is still unknown, once", async () => {
    await send(libromiPOST, { messageId: "m1", phone: "9847099999", name: "Basil", message: "Hi", timestamp: nowSeconds(-60_000) });
    const c = await contactByPhone("+919847099999");
    expect(c.firstDoor).toBe("other");
    await send(libromiPOST, { messageId: "m2", phone: "9847099999", buttonId: "door:youtube", buttonText: "YouTube", timestamp: nowSeconds(-30_000) });
    const after = await contactByPhone("+919847099999");
    expect(after.firstDoor).toBe("youtube");
    expect(after.fieldSources).toMatchObject({ first_door: "self" });
    await send(libromiPOST, { messageId: "m3", phone: "9847099999", buttonId: "door:meta_ad", timestamp: nowSeconds() });
    expect((await contactByPhone("+919847099999")).firstDoor).toBe("youtube");
  });

  it("the Pabbly-forwarded variant works, and the same message through both routes is recorded once", async () => {
    const fwd = fixture("pabbly-whatsapp-forward");
    fwd.timestamp = nowSeconds();
    expect((await send(pabblyWhatsAppPOST, fwd)).json).toMatchObject({ ok: true, result: "New chat: contact created" });
    const c = await contactByPhone("+971507654321");
    expect(c).toMatchObject({ name: "Fathima", firstDoor: "youtube", phoneCountry: "AE" });
    expect((await send(libromiPOST, fwd)).json).toMatchObject({ duplicate: true });
    expect(await count(enquiries)).toBe(1);
  });
});

describe("Pabbly leads", () => {
  it("a Meta lead with a campaign label is captured with its answers and self-ratings", async () => {
    const r = await send(metaLeadPOST, fixture("pabbly-meta-lead"));
    expect(r.json).toMatchObject({ ok: true, duplicate: false, result: "Meta lead: contact created" });
    const c = await contactByPhone("+919847066666");
    expect(c).toMatchObject({
      name: "Sreejith V",
      firstChannel: "meta_lead_form",
      firstDoor: "meta_ad",
      firstCampaign: "claude_mastery_meta",
      city: "Thrissur",
      consent: true,
      umerLevel: 2,
      aiLevel: 3,
    });
    const [e] = await db.select().from(enquiries).where(eq(enquiries.contactId, c.id));
    expect(e).toMatchObject({ channel: "meta_lead_form", campaign: "claude_mastery_meta", sourceRef: "meta:lead:1209876543210", productInterest: "Claude Mastery Workshop" });
    expect(e.notes).toContain("Form: Claude Mastery Oct · Ad: Claude carousel 3");
    expect(e.notes).toContain("What do you want to learn?: Automating reports");

    expect((await send(metaLeadPOST, fixture("pabbly-meta-lead"))).json).toMatchObject({ duplicate: true });
    expect(await count(enquiries)).toBe(1);
  });

  it("a campaign that is not in the list is stored as given", async () => {
    await send(metaLeadPOST, { ...fixture("pabbly-meta-lead"), lead_id: "L-2", phone: "9847011112", campaign: "Diwali push 2026" });
    const c = await contactByPhone("+919847011112");
    expect(c.firstCampaign).toBe("Diwali push 2026");
  });

  it("never lets a self-rating override a salesperson's rating", async () => {
    const known = await captureEnquiry({ phone: "9847066666", name: "Sreejith V", channel: "phone_call", skipAlerts: true });
    await applyRating(known.contact.id, { umerLevel: 5 }, "sales", sales.id);
    await send(metaLeadPOST, fixture("pabbly-meta-lead"));
    const c = await contactByPhone("+919847066666");
    expect(c.umerLevel).toBe(5);
    expect(c.aiLevel).toBe(3);
    // an existing contact keeps its first door
    expect(c.firstDoor).toBe("other");
  });

  it("accepts a form-encoded website form and keys it by a payload hash", async () => {
    const form = new URLSearchParams({
      name: "Meera Joseph",
      phone: "+971 55 123 4567",
      email: "meera@company.ae",
      form_name: "The AI Office call-back",
      "answers[How did you first hear about Edapt?]": "Google search",
      "answers[Best time to call]": "Evening",
    });
    const r = await send(websiteFormPOST, null, { raw: form.toString(), contentType: "application/x-www-form-urlencoded" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, result: "Website form: contact created" });
    const c = await contactByPhone("+971551234567");
    expect(c).toMatchObject({ name: "Meera Joseph", firstChannel: "website_form", firstDoor: "search_website", email: "meera@company.ae" });
    const [e] = await db.select().from(enquiries).where(eq(enquiries.contactId, c.id));
    expect(e.sourceRef).toMatch(/^website:form:h-[0-9a-f]{32}$/);
    expect(e.productInterest).toBe("The AI Office call-back");
    expect(e.notes).toContain("Best time to call: Evening");

    // the same submission again is a duplicate
    const again = await send(websiteFormPOST, null, { raw: form.toString(), contentType: "application/x-www-form-urlencoded" });
    expect(again.json).toMatchObject({ duplicate: true });
  });

  it("a lead without a phone is stored with an error", async () => {
    const r = await send(websiteFormPOST, { name: "No Phone", email: "nophone@example.com" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: false });
    expect(String(r.json.error)).toContain("No phone number");
    const [ev] = await db.select().from(webhookEvents);
    expect(ev.error).toContain("No phone number");
  });
});

describe("review fixes", () => {
  it("a TagMango refund records a refund payment on the order, once, and LTV drops", async () => {
    // a refund for an order we have not recorded fails, so it can be reprocessed later
    const refund = { orderId: "TM-ORD-1001", status: "refunded", refundAmount: 400, refundId: "rf_1", reason: "Could not attend" };
    const early = await send(tagmangoPOST, refund);
    expect(early.json).toMatchObject({ ok: false });
    expect(String(early.json.error)).toContain("not recorded");

    await send(tagmangoPOST, fixture("tagmango-completed-flat"));
    const buyer = await contactByPhone("+919847012345");
    expect(buyer.ltvInr).toBe(999);

    // the sender retries the failed refund: it now applies
    const again = await send(tagmangoPOST, refund);
    expect(again.json).toMatchObject({ ok: true, duplicate: true, contactId: buyer.id });
    const refunds = await db.select().from(payments).where(eq(payments.kind, "refund"));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amount: 400, reference: "TM-ORD-1001:refund:rf_1", status: "verified", mode: "tagmango" });
    expect(refunds[0].reason).toContain("Could not attend");
    expect((await contactByPhone("+919847012345")).ltvInr).toBe(599);

    // the same refund again changes nothing, even with the event log gone
    await db.delete(webhookEvents);
    expect((await send(tagmangoPOST, { orderId: "TM-ORD-1001", status: "refunded", refundAmount: 400, refundId: "rf_1" })).json).toMatchObject({ ok: true });
    expect(await count(payments, eq(payments.kind, "refund"))).toBe(1);
    expect((await contactByPhone("+919847012345")).ltvInr).toBe(599);
  });

  it("a status that says the payment did not go through never records a purchase", async () => {
    const notPaid = { ...fixture("tagmango-completed-flat"), orderId: "TM-NP-1", orderStatus: "payment_not_completed" };
    expect((await send(tagmangoPOST, notPaid)).json).toMatchObject({ ok: true });
    // an API envelope that says "success" around a failed payment
    const envelope = { status: "success", data: { orderId: "TM-NP-2", status: "failed", phone: "9847012399", amount: 999, mangoName: "Claude Mastery Workshop" } };
    expect((await send(tagmangoPOST, envelope)).json).toMatchObject({ ok: true });
    expect(await count(purchases)).toBe(0);
    const statuses = (await db.select().from(enquiries)).map((e) => e.status).sort();
    expect(statuses).toEqual(["checkout_failed", "checkout_started"]);
  });

  it("reads payload times written without a zone in the configured time zone (India by default)", async () => {
    const order = { ...fixture("tagmango-completed-flat"), createdAt: "2026-10-12 15:00:00" };
    await send(tagmangoPOST, order);
    const [p] = await db.select().from(purchases);
    expect(p.purchasedAt.toISOString()).toBe("2026-10-12T09:30:00.000Z");
  });

  it("a delivery carrying several events stores and processes each one", async () => {
    const a = { ...fixture("pabbly-meta-lead"), lead_id: "L-A", phone: "9847010001", email: "a@example.com" };
    const b = { ...fixture("pabbly-meta-lead"), lead_id: "L-B", phone: "9847010002", email: "b@example.com" };
    const r = await send(metaLeadPOST, [a, b]);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, duplicate: false });
    expect(r.json.events).toHaveLength(2);
    expect(await count(webhookEvents)).toBe(2);
    expect(await contactByPhone("+919847010001")).toBeTruthy();
    expect(await contactByPhone("+919847010002")).toBeTruthy();
    expect((await send(metaLeadPOST, [a, b])).json).toMatchObject({ duplicate: true });

    // a WhatsApp Cloud envelope with two messages from two people
    const env = fixture("libromi-cloud-text");
    const value = (env.entry as { changes: { value: Record<string, unknown> }[] }[])[0].changes[0].value;
    const m1 = (value.messages as Record<string, unknown>[])[0];
    m1.timestamp = nowSeconds(-60_000);
    value.messages = [m1, { from: "919847010003", id: "wamid.SECOND", timestamp: nowSeconds(), type: "text", text: { body: "Me too" } }];
    value.contacts = [...(value.contacts as unknown[]), { profile: { name: "Second Person" }, wa_id: "919847010003" }];
    const w = await send(libromiPOST, env);
    expect(w.json).toMatchObject({ ok: true });
    expect(await contactByPhone("+919847055555")).toMatchObject({ name: "Nisha Menon" });
    expect(await contactByPhone("+919847010003")).toMatchObject({ name: "Second Person" });
    expect(await count(webhookEvents, eq(webhookEvents.source, "libromi"))).toBe(2);
  });

  it("an event whose processing was interrupted runs again on redelivery; a fresh in-flight one is left alone", async () => {
    const admin = await makeUser({ role: "admin" });
    const lead = { ...fixture("pabbly-meta-lead"), lead_id: "L-STUCK", phone: "9847010009", email: "stuck@example.com" };
    const [fresh] = await db
      .insert(webhookEvents)
      .values({ source: "pabbly_meta", eventKey: "meta:lead:L-STUCK", payload: lead, receivedAt: new Date() })
      .returning();
    await expect(reprocessWebhookEvent(fresh.id, admin)).rejects.toThrow(/still being processed/);
    expect((await send(metaLeadPOST, lead)).json).toMatchObject({ duplicate: true, result: "Already received" });
    expect(await contactByPhone("+919847010009")).toBeUndefined();

    await db.update(webhookEvents).set({ receivedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(webhookEvents.id, fresh.id));
    expect((await send(metaLeadPOST, lead)).json).toMatchObject({ ok: true, duplicate: true, result: "Meta lead: contact created" });
    const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, fresh.id));
    expect(ev.processedAt).toBeTruthy();
  });

  it("a WhatsApp notice that is not a message is skipped, not failed", async () => {
    const r = await send(libromiPOST, { event: "template_status_update", template: "welcome_v2", status: "APPROVED" });
    expect(r.json).toMatchObject({ ok: true });
    expect(String(r.json.note)).toMatch(/^Skipped:/);
  });

  it("a completed order raises no new-lead or hot-lead alert; a started checkout still tells the owner", async () => {
    await makeUser({ role: "manager" });
    await send(tagmangoPOST, fixture("tagmango-completed-flat"));
    const buyer = await contactByPhone("+919847012345");
    expect(buyer.ownerId).toBe(sales.id);
    const leadAlerts = and(sql`${notifications.type} in ('new_lead', 'hot_lead', 'new_enquiry')`, eq(notifications.contactId, buyer.id));
    expect(await count(notifications, leadAlerts)).toBe(0);

    const started = fixture("tagmango-initiated");
    delete started.created_at;
    await send(tagmangoPOST, started);
    const c = await contactByPhone("+919847022222");
    const n = await db.select().from(notifications).where(eq(notifications.contactId, c.id));
    expect(n.map((x) => x.type)).toEqual(["new_lead"]);
  });
});
