/**
 * End-to-end domain flows: contacts + money + metrics working together through their public services only.
 * Direct inserts are limited to users (makeUser) and settings (setSetting); every contact, enquiry, rating,
 * interaction, purchase, payment, refund, referral and merge goes through the services the screens will call.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { contacts, enquiries, notifications, ownershipLog, payments, tasks, type Contact, type User } from "@/db/schema";
import { releaseStaleLeads } from "@/lib/contacts/assignment";
import { captureEnquiry, type CaptureInput } from "@/lib/contacts/capture";
import { checkQuickAddDuplicate } from "@/lib/contacts/identity";
import { logInteraction } from "@/lib/contacts/interactions";
import { setManualStage } from "@/lib/contacts/lifecycle";
import { mergeContacts, undoMerge } from "@/lib/contacts/merge";
import { applyRating, updateContactProfile } from "@/lib/contacts/profile";
import { adjustCredit } from "@/lib/money/credit";
import { DuplicateReferenceError, NotFoundError } from "@/lib/money/errors";
import {
  addPayment,
  getContactPurchases,
  recordInstalmentPayment,
  recordPurchase,
  recordRefund,
  verifyPayment,
  type RecordPurchaseInput,
} from "@/lib/money/purchases";
import { recomputeAll, recomputeContact, recomputeContacts } from "@/lib/metrics/recompute";
import { getSetting, setSetting } from "@/lib/settings";
import { makeUser, resetDb } from "../support/db";

const DAY = 86_400_000;
let seq = 0;
/** a fresh valid Kerala mobile, written the way a salesperson types it */
const inPhone = () => `98471 ${String(10000 + seq++).padStart(5, "0")}`;
/** a fresh valid UAE mobile in international format */
const aePhone = () => `+971 50 ${String(1000000 + seq++).padStart(7, "0")}`;

async function count(table: PgTable, where?: SQL): Promise<number> {
  const q = db.select({ n: sql<number>`count(*)::int` }).from(table);
  const rows = where ? await q.where(where) : await q;
  return rows[0].n;
}
async function contact(id: string): Promise<Contact> {
  const [c] = await db.select().from(contacts).where(eq(contacts.id, id));
  return c;
}
const actor = (u: User) => ({ id: u.id, role: u.role });

/** A TagMango order as the webhook would record it: verified, order id as reference, by the system. */
function tagmangoOrder(contactId: string, over: Partial<RecordPurchaseInput> = {}): RecordPurchaseInput {
  return {
    contactId,
    productName: "Prompting workshop",
    family: "workshop",
    amount: 999,
    currency: "INR",
    mode: "tagmango",
    source: "tagmango",
    reference: `TM-${seq++}`,
    ...over,
  };
}

/** A new lead arriving from a webhook (no user), alerts off unless asked. */
function inbound(over: Partial<CaptureInput> = {}): CaptureInput {
  return { phone: inPhone(), name: "Lead", channel: "whatsapp_api", skipAlerts: true, ...over };
}

describe("domain end to end", () => {
  let manager: User;
  let ravi: User; // Kerala sales
  let anu: User; // Kerala sales
  let dubai1: User;
  let dubai2: User;

  beforeEach(async () => {
    await resetDb();
    manager = await makeUser({ role: "manager", team: null, name: "Meera Manager" });
    ravi = await makeUser({ role: "sales", team: "kerala", name: "Ravi" });
    anu = await makeUser({ role: "sales", team: "kerala", name: "Anu" });
    dubai1 = await makeUser({ role: "sales", team: "dubai", name: "Fatima" });
    dubai2 = await makeUser({ role: "sales", team: "dubai", name: "Omar" });
  });

  it("Quick Add of a Kerala lead, then a Meta lead form for the same number with a new email", async () => {
    const phone = inPhone();
    // the live duplicate check while typing: nobody has this number yet
    const before = await checkQuickAddDuplicate(phone, actor(ravi));
    expect(before).toMatchObject({ valid: true, existing: null });

    const qa = await captureEnquiry({
      phone,
      name: "suresh nair",
      email: "suresh@example.com",
      channel: "whatsapp_app",
      firstDoor: "youtube",
      createdById: ravi.id,
      ownerId: ravi.id,
      profile: { city: "Kochi", state: "Kerala", industry: "business_owner", ageBand: "35-44" },
    });
    expect(qa.created).toBe(true);
    const c = qa.contact;
    expect(c).toMatchObject({
      name: "Suresh Nair",
      phoneE164: expect.stringMatching(/^\+9198471/),
      ownerId: ravi.id,
      firstOwnerId: ravi.id,
      stage: "new",
      firstDoor: "youtube",
      firstChannel: "whatsapp_app",
      country: "IN",
    });
    // Fit: band unknown 10 + business owner 25 + 35-44 25 + Kerala city 18 = 78
    // Readiness: Umer unknown (= level 1) 8 + AI unknown 15 + enquired today 30 = 53
    // Edapt (lead) = 0.5*78 + 0.5*53 = 65.5 -> 66, grade B
    expect(c).toMatchObject({ fit: 78, readiness: 53, value: null, edaptScore: 66, grade: "B" });
    expect(c.scoredAt).not.toBeNull();
    expect(c.ownerAssignedAt).not.toBeNull();
    expect(await count(ownershipLog, eq(ownershipLog.contactId, c.id))).toBe(1);
    // no "new lead" alert to yourself for your own Quick Add
    expect(await count(notifications, eq(notifications.contactId, c.id))).toBe(0);

    // a colleague typing the same number sees the existing contact and its owner before saving
    const dup = await checkQuickAddDuplicate(`+91${phone.replace(/\s/g, "")}`, actor(anu));
    expect(dup.existing).toMatchObject({ id: c.id, ownerId: ravi.id, ownerName: "Ravi", stage: "new", visible: false });

    // later the same person fills a Meta lead form with a different email
    const meta = await captureEnquiry({
      phone: `+91 ${phone}`,
      name: "Suresh N",
      email: "SURESH.WORK@example.com",
      channel: "meta_lead_form",
      firstDoor: "meta_ad",
      campaign: "Claude Mastery Meta ads",
      sourceRef: "meta-lead-1",
    });
    expect(meta.created).toBe(false);
    expect(meta.contact.id).toBe(c.id);
    expect(meta.contact).toMatchObject({
      name: "Suresh Nair",
      email: "suresh@example.com",
      altEmails: ["suresh.work@example.com"],
      firstDoor: "youtube",
      firstChannel: "whatsapp_app",
      lastChannel: "meta_lead_form",
      lastCampaign: "claude_mastery_meta",
      ownerId: ravi.id,
      firstOwnerId: ravi.id,
    });
    expect(await count(enquiries, eq(enquiries.contactId, c.id))).toBe(2);
    // the owner hears about the returning enquiry
    const [n] = await db.select().from(notifications).where(eq(notifications.contactId, c.id));
    expect(n).toMatchObject({ userId: ravi.id, type: "new_enquiry" });
    // the alternate email matches too
    const byAlt = await captureEnquiry({ phone: aePhone(), email: "suresh.work@example.com", channel: "website_form", skipAlerts: true });
    expect(byAlt.contact.id).toBe(c.id);
  });

  it("GCC numbers with no owner go round robin to the Dubai team only", async () => {
    const owners: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await captureEnquiry(inbound({ phone: aePhone(), channel: "whatsapp_api" }));
      expect(r.contact.phoneCountry).toBe("AE");
      owners.push(r.contact.ownerId);
      expect(r.contact.firstOwnerId).toBe(r.contact.ownerId);
    }
    expect(new Set(owners)).toEqual(new Set([dubai1.id, dubai2.id]));
    // strict alternation in a sequential flow
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners[2]).toBe(owners[0]);
    // and an Indian number still goes to Kerala
    const kerala = await captureEnquiry(inbound());
    expect([ravi.id, anu.id]).toContain(kerala.contact.ownerId);
  });

  it("a TagMango buyer jumps from New to First purchase, then Repeat with a second family", async () => {
    const checkout = await captureEnquiry(
      inbound({ channel: "tagmango_checkout", enquiryStatus: "checkout_started", profile: { city: "Thrissur" } }),
    );
    expect(checkout.contact).toMatchObject({ stage: "new", ltvInr: 0, value: null, purchaseCount: 0 });
    // First door defaults from the checkout channel
    expect(checkout.contact.firstDoor).toBeTruthy();

    const first = await recordPurchase(tagmangoOrder(checkout.contact.id, { amount: 999 }), null);
    expect(first.status).toBe("paid");
    let c = await contact(checkout.contact.id);
    expect(c).toMatchObject({ stage: "first_purchase", ltvInr: 999, purchaseCount: 1, familyCount: 1, currentRung: 1 });
    expect(c.value).not.toBeNull();
    // customer blend: 0.25 F + 0.25 R + 0.5 V (no gut rating)
    expect(c.edaptScore).toBe(Math.round(0.25 * c.fit! + 0.25 * c.readiness! + 0.5 * c.value!));
    expect(c.edaptScore).not.toBe(Math.round(0.5 * c.fit! + 0.5 * c.readiness!));
    // the checkout became a completed purchase (handled within the hour)
    const [enq] = await db.select().from(enquiries).where(eq(enquiries.contactId, c.id));
    expect(enq.status).toBe("handled");

    await recordPurchase(
      tagmangoOrder(c.id, { productName: "Applied AI Mastery", family: "applied_ai_mastery", amount: 24999 }),
      null,
    );
    c = await contact(c.id);
    expect(c).toMatchObject({
      stage: "repeat",
      ltvInr: 25998,
      purchaseCount: 2,
      familyCount: 2,
      families: ["workshop", "applied_ai_mastery"],
      currentRung: 2,
    });
    expect(c.avgGapDays).not.toBeNull();
    expect(c.nextOffer).toBe("The AI Office or advanced workshops");
  });

  it("a bank transfer counts toward LTV only once verified, and its UTR can never be used twice", async () => {
    const r = await captureEnquiry(inbound({ ownerId: ravi.id }));
    const res = await recordPurchase(
      {
        contactId: r.contact.id,
        productName: "Applied AI Mastery",
        family: "applied_ai_mastery",
        amount: 30000,
        currency: "INR",
        mode: "bank_transfer",
        source: "manual",
        reference: "utr 4455 6677",
        proofUrl: "uploads/proof.png",
      },
      actor(ravi),
    );
    expect(res.status).toBe("pending");
    let c = await contact(r.contact.id);
    expect(c).toMatchObject({ ltvInr: 0, purchaseCount: 0, stage: "new" });

    await verifyPayment(res.paymentIds[0], actor(manager));
    c = await contact(r.contact.id);
    expect(c).toMatchObject({ ltvInr: 30000, purchaseCount: 1, stage: "first_purchase" });

    // the same UTR again, even typed differently and on another contact, is refused with a friendly message
    const other = await captureEnquiry(inbound());
    const again = recordPurchase(
      {
        contactId: other.contact.id,
        productName: "Workshop",
        family: "workshop",
        amount: 999,
        currency: "INR",
        mode: "upi_qr",
        source: "manual",
        reference: "UTR44556677",
      },
      actor(ravi),
    );
    await expect(again).rejects.toBeInstanceOf(DuplicateReferenceError);
    await expect(again).rejects.toThrow(/already recorded/);
    expect(await count(payments, eq(payments.contactId, other.contact.id))).toBe(0);
    expect((await contact(other.contact.id)).ltvInr).toBe(0);
  });

  it("an AED payment is stored in INR at that month's rate; changing the rate later never moves LTV", async () => {
    const r = await captureEnquiry(inbound({ phone: aePhone() }));
    const paidAt = new Date("2026-03-15T08:00:00Z"); // rate month 2026-03 -> latest rate at or before it: 2026-01 (22.6)
    const { purchaseId, paymentIds } = await recordPurchase(
      tagmangoOrder(r.contact.id, { productName: "The AI Office", family: "ai_office", amount: 1000, currency: "AED", purchasedAt: paidAt }),
      null,
    );
    const [p] = await db.select().from(payments).where(eq(payments.id, paymentIds[0]));
    expect(p).toMatchObject({ amount: 1000, currency: "AED", fxRate: 22.6, amountInr: 22600 });
    expect((await contact(r.contact.id)).ltvInr).toBe(22600);

    const cur = await getSetting("currency");
    await setSetting("currency", { ...cur, rates: { ...cur.rates, AED: { "2026-01": 30, "2026-03": 31 } } }, manager.id);
    await recomputeContact(r.contact.id);
    expect((await contact(r.contact.id)).ltvInr).toBe(22600);
    const [stored] = await getContactPurchases(r.contact.id);
    expect(stored.id).toBe(purchaseId);
    expect(stored.amountInr).toBe(22600);

    // a new AED payment after the change uses the new rate
    const later = await recordPurchase(
      tagmangoOrder(r.contact.id, { family: "workshop", amount: 100, currency: "AED", purchasedAt: new Date("2026-04-02T08:00:00Z") }),
      null,
    );
    const [p2] = await db.select().from(payments).where(eq(payments.id, later.paymentIds[0]));
    expect(p2).toMatchObject({ fxRate: 31, amountInr: 3100 });
    expect((await contact(r.contact.id)).ltvInr).toBe(25700);
  });

  it("a refund lowers LTV by its amount", async () => {
    const r = await captureEnquiry(inbound());
    const { purchaseId } = await recordPurchase(tagmangoOrder(r.contact.id, { family: "applied_ai_mastery", amount: 20000 }), null);
    expect((await contact(r.contact.id)).ltvInr).toBe(20000);
    await recordRefund(purchaseId, { amount: 5000, reason: "Missed two sessions", reference: "RF-1" }, actor(manager));
    let c = await contact(r.contact.id);
    expect(c.ltvInr).toBe(15000);
    expect(c.purchaseCount).toBe(1);
    // a full refund of the rest takes it to zero and the purchase no longer counts
    await recordRefund(purchaseId, { amount: 15000, reason: "Refund requested", reference: "RF-2" }, actor(manager));
    c = await contact(r.contact.id);
    expect(c).toMatchObject({ ltvInr: 0, purchaseCount: 0 });
  });

  it("a referral who pays makes the referrer an Advocate with a call-to-thank task and network value", async () => {
    const a = await captureEnquiry(inbound({ name: "Asha", ownerId: anu.id }));
    await recordPurchase(tagmangoOrder(a.contact.id, { amount: 999 }), null);
    expect((await contact(a.contact.id)).stage).toBe("first_purchase");

    // B arrives through A's affiliate link (TagMango sends the affiliate's phone)
    const b = await captureEnquiry(
      inbound({ name: "Bindu", channel: "tagmango_checkout", referrer: { phone: a.contact.phoneE164, name: "Asha" } }),
    );
    expect(b.referrerId).toBe(a.contact.id);
    expect(b.contact).toMatchObject({ referredById: a.contact.id, firstDoor: "referral" });
    // a referral who has not paid is not counted yet
    expect(await contact(a.contact.id)).toMatchObject({ referralCount: 0, networkValueInr: 0, stage: "first_purchase" });

    await recordPurchase(tagmangoOrder(b.contact.id, { family: "applied_ai_mastery", amount: 24999 }), null);
    const bAfter = await contact(b.contact.id);
    const aAfter = await contact(a.contact.id);
    expect(bAfter.ltvInr).toBe(24999);
    expect(aAfter).toMatchObject({ referralCount: 1, networkValueInr: bAfter.ltvInr, stage: "advocate" });
    const thank = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.contactId, a.contact.id), eq(tasks.type, "new_advocate")));
    expect(thank).toHaveLength(1);
    expect(thank[0]).toMatchObject({ userId: anu.id, status: "open" });
    expect(thank[0].reason).toContain("Bindu");

    // a second payment by B raises no second task; a lead (no purchase) referrer does not become Advocate
    await recordPurchase(tagmangoOrder(b.contact.id, { amount: 999 }), null);
    expect(await count(tasks, and(eq(tasks.contactId, a.contact.id), eq(tasks.type, "new_advocate")))).toBe(1);
    const leadReferrer = await captureEnquiry(inbound({ name: "Lead Referrer" }));
    const d = await captureEnquiry(inbound({ name: "Deepa", referrer: { contactId: leadReferrer.contact.id } }));
    await recordPurchase(tagmangoOrder(d.contact.id, { amount: 999 }), null);
    expect(await contact(leadReferrer.contact.id)).toMatchObject({ referralCount: 1, networkValueInr: 999, stage: "new" });
  });

  it("sales credit: assisted when the owner called 10 days before the purchase, otherwise self-serve", async () => {
    const now = Date.now();
    const called = await captureEnquiry(inbound({ ownerId: ravi.id, receivedAt: new Date(now - 20 * DAY) }));
    await logInteraction(
      called.contact.id,
      { type: "call", outcome: "interested", summary: "Wants the weekend batch", occurredAt: new Date(now - 11 * DAY) },
      actor(ravi),
    );
    const p1 = await recordPurchase(tagmangoOrder(called.contact.id, { purchasedAt: new Date(now - DAY) }), null);
    const [row1] = await getContactPurchases(called.contact.id);
    expect(row1.id).toBe(p1.purchaseId);
    expect(row1).toMatchObject({ creditedUserId: ravi.id, assisted: true, creditedUserName: "Ravi" });

    const untouched = await captureEnquiry(inbound({ ownerId: ravi.id, receivedAt: new Date(now - 20 * DAY) }));
    await recordPurchase(tagmangoOrder(untouched.contact.id, { purchasedAt: new Date(now - DAY) }), null);
    const [row2] = await getContactPurchases(untouched.contact.id);
    expect(row2).toMatchObject({ creditedUserId: null, assisted: false });

    // a call by someone else (support) does not earn the owner credit
    const support = await makeUser({ role: "support", team: null });
    const supported = await captureEnquiry(inbound({ ownerId: ravi.id, receivedAt: new Date(now - 20 * DAY) }));
    await logInteraction(supported.contact.id, { type: "support_issue", summary: "Login help", occurredAt: new Date(now - 5 * DAY) }, actor(support));
    expect((await contact(supported.contact.id)).ownerId).toBe(ravi.id);
    await recordPurchase(tagmangoOrder(supported.contact.id, { purchasedAt: new Date(now - DAY) }), null);
    const [row3] = await getContactPurchases(supported.contact.id);
    expect(row3.assisted).toBe(false);
  });

  it("worked example 1, built through the services, scores Fit 100, Readiness 92, Value 92, Edapt 94, grade A", async () => {
    const NOW = new Date("2026-10-01T06:30:00Z");
    const at = (days: number) => new Date(NOW.getTime() - days * DAY);

    // GCC business owner, first seen almost a year ago
    const a = await captureEnquiry(
      inbound({ phone: aePhone(), name: "Khalid Rahman", channel: "whatsapp_api", firstDoor: "youtube", receivedAt: at(330) }),
    );
    expect(a.contact.phoneCountry).toBe("AE");
    const id = a.contact.id;
    await applyRating(id, { industry: "business_owner", ageBand: "35-44", spendingBand: 5, umerLevel: 4, aiLevel: 3 }, "sales", dubai1.id);

    // ₹1.2 lakh over 4 purchases in 3 lines, the last one 2 months ago
    await recordPurchase(tagmangoOrder(id, { family: "workshop", amount: 999, purchasedAt: at(320) }), null);
    await recordPurchase(tagmangoOrder(id, { productName: "Applied AI Mastery", family: "applied_ai_mastery", amount: 40000, purchasedAt: at(220) }), null);
    await recordPurchase(tagmangoOrder(id, { productName: "The AI Office", family: "ai_office", amount: 60000, purchasedAt: at(130) }), null);
    await recordPurchase(tagmangoOrder(id, { productName: "Agents workshop", family: "workshop", amount: 19001, purchasedAt: at(60) }), null);

    // 2 referrals who paid, linked at capture through the affiliate referrer
    for (const [name, days] of [["Ref One", 100], ["Ref Two", 40]] as const) {
      const r = await captureEnquiry(inbound({ name, referrer: { contactId: id }, receivedAt: at(days + 1) }));
      expect(r.contact.referredById).toBe(id);
      await recordPurchase(tagmangoOrder(r.contact.id, { amount: 999, purchasedAt: at(days) }), null);
    }

    // chatted this week
    await logInteraction(id, { type: "whatsapp", direction: "in", summary: "Asked about the AI Office renewal", occurredAt: at(3) }, null);

    await recomputeContact(id, db, { now: NOW });
    const c = await contact(id);
    expect(c).toMatchObject({
      ltvInr: 120000,
      purchaseCount: 4,
      familyCount: 3,
      referralCount: 2,
      networkValueInr: 1998,
      fit: 100,
      readiness: 92,
      value: 92,
      edaptScore: 94,
      grade: "A",
      stage: "advocate",
      currentRung: 3,
    });
    expect(c.lastPurchaseAt?.toISOString()).toBe(at(60).toISOString());
    expect(c.nextOffer).toBe("The AI Office renewal, and ask for referrals");
  });

  it("merging two customers sums their LTV in the winner; undo restores both exactly", async () => {
    const x = await captureEnquiry(inbound({ name: "Joseph", email: "joseph@example.com", ownerId: ravi.id }));
    const y = await captureEnquiry(inbound({ name: "Joseph K", ownerId: anu.id }));
    await recordPurchase(tagmangoOrder(x.contact.id, { amount: 999 }), null);
    await recordPurchase(tagmangoOrder(y.contact.id, { family: "applied_ai_mastery", amount: 24999 }), null);
    const before = { x: await contact(x.contact.id), y: await contact(y.contact.id) };
    expect(before.x).toMatchObject({ ltvInr: 999, purchaseCount: 1, stage: "first_purchase" });
    expect(before.y).toMatchObject({ ltvInr: 24999, purchaseCount: 1 });

    const mergeId = await mergeContacts(x.contact.id, y.contact.id, actor(manager), "Same person, second number");
    const winner = await contact(x.contact.id);
    const loser = await contact(y.contact.id);
    expect(winner).toMatchObject({
      ltvInr: 25998,
      purchaseCount: 2,
      familyCount: 2,
      stage: "repeat",
      altPhones: [y.contact.phoneE164],
      firstOwnerId: ravi.id,
    });
    expect(loser.mergedIntoId).toBe(x.contact.id);
    expect((await getContactPurchases(x.contact.id)).length).toBe(2);
    // a new touch on the loser's number lands on the winner
    const touch = await captureEnquiry(inbound({ phone: y.contact.phoneE164 }));
    expect(touch.contact.id).toBe(x.contact.id);

    // undo: the touch made after the merge stays with the winner; both records' money is back exactly
    await undoMerge(mergeId, actor(manager));
    const x2 = await contact(x.contact.id);
    const y2 = await contact(y.contact.id);
    expect(y2.mergedIntoId).toBeNull();
    for (const [now, was] of [[x2, before.x], [y2, before.y]] as const) {
      expect(now).toMatchObject({
        ltvInr: was.ltvInr,
        purchaseCount: was.purchaseCount,
        familyCount: was.familyCount,
        families: was.families,
        stage: was.stage,
        ownerId: was.ownerId,
        firstOwnerId: was.firstOwnerId,
        phoneE164: was.phoneE164,
      });
    }
    expect(x2.altPhones).toEqual([]);
    expect((await getContactPurchases(y.contact.id)).map((p) => p.amount)).toEqual([24999]);
  });

  it("Lost with a reason is pulled back by a new enquiry; stale leads are released after 7 days, customers never", async () => {
    // Lost -> new enquiry
    const lead = await captureEnquiry(inbound({ ownerId: ravi.id }));
    await logInteraction(lead.contact.id, { type: "call", outcome: "not_interested" }, actor(ravi));
    expect((await contact(lead.contact.id)).stage).toBe("contacted");
    await expect(setManualStage(lead.contact.id, "lost", {}, actor(ravi))).rejects.toThrow(/why/);
    const lost = await setManualStage(lead.contact.id, "lost", { lostReason: "price" }, actor(ravi));
    expect(lost).toMatchObject({ stage: "lost", lostReason: "price" });
    // the nightly recompute keeps Lost
    await recomputeContact(lead.contact.id);
    expect((await contact(lead.contact.id)).stage).toBe("lost");
    const back = await captureEnquiry(inbound({ phone: lead.contact.phoneE164, channel: "meta_lead_form", sourceRef: "meta-2" }));
    expect(back.contact).toMatchObject({ id: lead.contact.id, stage: "contacted", lostReason: null, ownerId: ravi.id });

    // a Lost customer is pulled back to their purchase stage by a payment
    const cust = await captureEnquiry(inbound({ ownerId: anu.id }));
    await recordPurchase(tagmangoOrder(cust.contact.id), null);
    await setManualStage(cust.contact.id, "lost", { lostReason: "timing" }, actor(manager));
    expect((await contact(cust.contact.id)).stage).toBe("lost");
    await recordPurchase(tagmangoOrder(cust.contact.id, { family: "applied_ai_mastery", amount: 24999 }), null);
    expect(await contact(cust.contact.id)).toMatchObject({ stage: "repeat", lostReason: null });

    // use it or lose it
    const stale = await captureEnquiry(inbound({ ownerId: ravi.id }));
    const customer = await captureEnquiry(inbound({ ownerId: ravi.id }));
    await recordPurchase(tagmangoOrder(customer.contact.id), null);
    const in6 = await releaseStaleLeads(new Date(Date.now() + 6 * DAY));
    expect(in6).not.toContain(stale.contact.id);
    const released = await releaseStaleLeads(new Date(Date.now() + 8 * DAY));
    expect(released).toContain(stale.contact.id);
    expect(released).not.toContain(customer.contact.id);
    // Ravi's last call on the pulled-back lead is now 8 days old too: it goes back to the pool
    expect(released).toContain(lead.contact.id);
    expect(released).not.toContain(cust.contact.id);
    expect(await contact(stale.contact.id)).toMatchObject({ ownerId: null, firstOwnerId: ravi.id });
    expect((await contact(customer.contact.id)).ownerId).toBe(ravi.id);
    const [log] = await db
      .select()
      .from(ownershipLog)
      .where(and(eq(ownershipLog.contactId, stale.contact.id), eq(ownershipLog.fromUserId, ravi.id)));
    expect(log.toUserId).toBeNull();
    expect(await count(tasks, and(eq(tasks.contactId, stale.contact.id), eq(tasks.type, "lead_released"), eq(tasks.userId, manager.id)))).toBe(1);
    // running the job again releases nothing new
    expect(await releaseStaleLeads(new Date(Date.now() + 8 * DAY))).toEqual([]);
  });

  it("a grade A lead enquiry alerts the owner and every manager in-app and by email", async () => {
    const manager2 = await makeUser({ role: "manager", team: null });
    // worked example 2: Kerala-city business owner, 35 to 44, band 4, Umer 3, AI 2, enquired today
    const r = await captureEnquiry({
      phone: inPhone(),
      name: "Hot Lead",
      channel: "website_form",
      profile: { city: "Kozhikode", industry: "business_owner" },
      selfRatings: { ageBand: "35-44", spendingBand: 4, umerLevel: 3, aiLevel: 2 },
    });
    expect(r.contact).toMatchObject({ fit: 88, readiness: 84, value: null, edaptScore: 86, grade: "A", purchaseCount: 0 });
    const owner = r.contact.ownerId!;
    expect([ravi.id, anu.id]).toContain(owner);
    const hot = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.contactId, r.contact.id), eq(notifications.type, "hot_lead")));
    expect(hot.map((h) => h.userId).sort()).toEqual([owner, manager.id, manager2.id].sort());
    expect(hot.every((h) => h.email)).toBe(true);
    // the owner also gets the plain new-lead alert
    expect(await count(notifications, and(eq(notifications.userId, owner), eq(notifications.type, "new_lead")))).toBe(1);

    // the same webhook delivered twice raises nothing new
    const again = await captureEnquiry({ phone: r.contact.phoneE164, channel: "website_form", sourceRef: "web-1" });
    const hotAfter = await count(notifications, eq(notifications.type, "hot_lead"));
    expect(hotAfter).toBe(6); // a new real enquiry from a grade A lead is a new alert
    await captureEnquiry({ phone: r.contact.phoneE164, channel: "website_form", sourceRef: "web-1" });
    expect(await count(notifications, eq(notifications.type, "hot_lead"))).toBe(6);
    expect(again.contact.grade).toBe("A");

    // once they buy, a new enquiry is no longer a hot lead
    await recordPurchase(tagmangoOrder(r.contact.id, { family: "applied_ai_mastery", amount: 60000 }), null);
    const cust = await captureEnquiry({ phone: r.contact.phoneE164, channel: "whatsapp_api" });
    expect(cust.contact.purchaseCount).toBe(1);
    expect(await count(notifications, eq(notifications.type, "hot_lead"))).toBe(6);
  });

  describe("seams between the modules", () => {
    it("a merge moves referrals and money; payments recorded on the merged id land on the survivor; undo splits them back", async () => {
      const winner = await captureEnquiry(inbound({ name: "Winner" }));
      const loser = await captureEnquiry(inbound({ name: "Loser" }));
      const referred = await captureEnquiry(inbound({ name: "Referred", referrer: { contactId: loser.contact.id } }));
      await recordPurchase(tagmangoOrder(referred.contact.id, { amount: 999 }), null);
      expect(await contact(loser.contact.id)).toMatchObject({ referralCount: 1, networkValueInr: 999 });

      const mergeId = await mergeContacts(winner.contact.id, loser.contact.id, actor(manager));
      expect(await contact(winner.contact.id)).toMatchObject({ referralCount: 1, networkValueInr: 999 });
      expect((await contact(referred.contact.id)).referredById).toBe(winner.contact.id);
      expect(await contact(loser.contact.id)).toMatchObject({ mergedIntoId: winner.contact.id });

      // a stale form or webhook still carrying the loser's id
      await recordPurchase(tagmangoOrder(loser.contact.id, { amount: 500 }), null);
      expect(await contact(winner.contact.id)).toMatchObject({ ltvInr: 500, purchaseCount: 1, stage: "advocate" });
      await logInteraction(loser.contact.id, { type: "note", summary: "Logged on the old link" }, actor(manager));
      expect((await contact(winner.contact.id)).lastInteractionAt).not.toBeNull();

      await undoMerge(mergeId, actor(manager));
      // what happened after the merge stays with the survivor; the referral goes back to the loser
      expect(await contact(winner.contact.id)).toMatchObject({ ltvInr: 500, referralCount: 0, networkValueInr: 0, stage: "first_purchase" });
      expect(await contact(loser.contact.id)).toMatchObject({ mergedIntoId: null, referralCount: 1, networkValueInr: 999, ltvInr: 0 });
      expect((await contact(referred.contact.id)).referredById).toBe(loser.contact.id);
    });

    it("profile edits and ratings rescore at once; credit adjustments keep LTV", async () => {
      const r = await captureEnquiry(inbound({ ownerId: ravi.id }));
      const before = r.contact;
      expect(before.fit).toBe(44); // 10 + 10 + 12 + rest of India 12
      const moved = await updateContactProfile(r.contact.id, { city: "Dubai", country: "AE" }, actor(ravi));
      expect(moved.fit).toBe(57); // GCC 25
      const rated = await updateContactProfile(r.contact.id, { industry: "senior_manager", ageBand: "45-54" }, actor(ravi));
      expect(rated.fit).toBe(10 + 22 + 22 + 25);
      expect(rated.fieldSources).toMatchObject({ industry: "sales", age_band: "sales" });
      // a self-rating arriving later never overrides the salesperson
      await captureEnquiry({ phone: r.contact.phoneE164, channel: "whatsapp_api", selfRatings: { ageBand: "18-24", umerLevel: 5 }, skipAlerts: true });
      const after = await contact(r.contact.id);
      expect(after).toMatchObject({ ageBand: "45-54", umerLevel: 5 });

      const { purchaseId } = await recordPurchase(tagmangoOrder(r.contact.id, { amount: 2500 }), null);
      await adjustCredit(purchaseId, anu.id, actor(manager));
      const [p] = await getContactPurchases(r.contact.id);
      expect(p).toMatchObject({ creditedUserId: anu.id, assisted: true, creditAdjustedById: manager.id });
      expect((await contact(r.contact.id)).ltvInr).toBe(2500);
    });

    it("an EMI purchase counts each verified instalment, and the nightly recompute agrees with the live one", async () => {
      const r = await captureEnquiry(inbound({ ownerId: ravi.id }));
      const now = Date.now();
      const res = await recordPurchase(
        {
          contactId: r.contact.id,
          productName: "Applied AI Mastery",
          family: "applied_ai_mastery",
          amount: 30000,
          currency: "INR",
          mode: "upi_qr",
          source: "manual",
          instalments: [
            { amount: 10000, dueAt: new Date(now - DAY) },
            { amount: 10000, dueAt: new Date(now + 30 * DAY) },
            { amount: 10000, dueAt: new Date(now + 60 * DAY) },
          ],
          paidNow: { amount: 10000, reference: "UPI-EMI-1", paidAt: new Date(now - DAY) },
        },
        actor(ravi),
      );
      expect(res.paymentIds).toHaveLength(3);
      expect(await contact(r.contact.id)).toMatchObject({ ltvInr: 0, purchaseCount: 0, stage: "new" });
      await verifyPayment(res.paymentIds[0], actor(manager));
      expect(await contact(r.contact.id)).toMatchObject({ ltvInr: 10000, purchaseCount: 1, stage: "first_purchase" });
      await recordInstalmentPayment(res.paymentIds[1], { reference: "UPI-EMI-2", mode: "upi_qr", verify: true }, actor(manager));
      expect((await contact(r.contact.id)).ltvInr).toBe(20000);
      await addPayment(res.purchaseId, { amount: 10000, reference: "UPI-EMI-3", mode: "upi_qr", verify: true }, actor(manager));
      const [p] = await getContactPurchases(r.contact.id);
      expect(p.status).toBe("paid");
      expect((await contact(r.contact.id)).ltvInr).toBe(30000);

      const live = await db.select().from(contacts);
      await recomputeAll();
      const nightly = await db.select().from(contacts);
      const cols = ["stage", "ltvInr", "purchaseCount", "fit", "readiness", "value", "edaptScore", "grade", "referralCount", "networkValueInr", "nextOffer"] as const;
      for (const a of live) {
        const b = nightly.find((x) => x.id === a.id)!;
        for (const k of cols) expect([a.id, k, b[k]]).toEqual([a.id, k, a[k]]);
      }
    });

    it("malformed ids from forms or URLs are 'not found', never raw database errors", async () => {
      const bad = "not-a-uuid";
      await expect(recordPurchase(tagmangoOrder(bad), null)).rejects.toBeInstanceOf(NotFoundError);
      await expect(verifyPayment(bad, actor(manager))).rejects.toBeInstanceOf(NotFoundError);
      await expect(addPayment(bad, { amount: 1, reference: null, mode: "cash" }, actor(manager))).rejects.toBeInstanceOf(NotFoundError);
      await expect(recordInstalmentPayment(bad, { reference: null, mode: "cash" }, actor(manager))).rejects.toBeInstanceOf(NotFoundError);
      await expect(recordRefund(bad, { amount: 1, reason: "x" }, actor(manager))).rejects.toBeInstanceOf(NotFoundError);
      await expect(adjustCredit(bad, null, actor(manager))).rejects.toBeInstanceOf(NotFoundError);
      expect(await getContactPurchases(bad)).toEqual([]);
      const r = await captureEnquiry(inbound());
      await expect(recordPurchase(tagmangoOrder(r.contact.id, { productId: bad }), null)).rejects.toThrow("Product not found.");
      await expect(recordPurchase(tagmangoOrder(r.contact.id, { organisationId: bad }), null)).rejects.toThrow("Organisation not found.");
      await expect(adjustCredit((await recordPurchase(tagmangoOrder(r.contact.id), null)).purchaseId, bad, actor(manager))).rejects.toThrow(
        "User not found.",
      );
      expect(await recomputeContacts([bad, r.contact.id])).toBe(1);
      await expect(recomputeContact(bad)).resolves.toBeUndefined();
    });
  });
});
