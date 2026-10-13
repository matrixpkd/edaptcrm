import { eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { auditLog, contacts, enquiries, notifications, purchases, type NewContact } from "@/db/schema";
import { createTask } from "@/lib/alerts/core";
import { buildDailyDigest, buildWeeklySummary, sendDailyDigests, sendWeeklySummary } from "@/lib/alerts/digest";
import { sendPendingNotificationEmails } from "@/lib/alerts/mailer";
import { recordPurchase, recordRefund } from "@/lib/money/purchases";
import { DEFAULT_SETTINGS, setSetting } from "@/lib/settings";
import { makeUser, resetDb } from "../support/db";

type SentEmail = { to: string | string[]; subject: string; html: string; text?: string };
const mail = vi.hoisted(() => ({ sent: [] as SentEmail[], failFor: new Set<string>() }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (e: SentEmail) => {
    const to = Array.isArray(e.to) ? e.to[0] : e.to;
    if (mail.failFor.has(to)) return { ok: false, error: "mailbox unavailable" };
    mail.sent.push(e);
    return { ok: true, id: `email-${mail.sent.length}` };
  }),
}));

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

let seq = 0;
async function contact(over: Partial<NewContact> = {}) {
  seq += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9198950${String(10000 + seq).padStart(5, "0")}`, phoneCountry: "IN", name: `Contact ${seq}`, firstDoor: "youtube", ...over })
    .returning();
  return c;
}
let refN = 0;
const ref = () => `DG-${++refN}`;
const sentTo = (email: string) => mail.sent.filter((m) => (Array.isArray(m.to) ? m.to.includes(email) : m.to === email));

beforeEach(async () => {
  await resetDb();
  mail.sent.length = 0;
  mail.failFor.clear();
});

describe("sendDailyDigests: 8:30 in each user's own time zone", () => {
  // Monday 12 Oct 2026
  const at = (iso: string) => new Date(iso);

  it("a Kerala user gets it at 08:30 IST, a Dubai user at 08:30 GST, each once per local day", async () => {
    const kerala = await makeUser({ role: "sales", name: "Kiran", email: "kiran@edapt.test", timezone: "Asia/Kolkata" });
    const dubai = await makeUser({ role: "sales", name: "Dana", email: "dana@edapt.test", team: "dubai", timezone: "Asia/Dubai" });
    for (const u of [kerala, dubai]) {
      const c = await contact({ ownerId: u.id });
      await createTask({ contactId: c.id, userId: u.id, type: "follow_up", reason: "Call back", dueAt: at("2026-10-11T06:00:00Z") });
    }

    expect(await sendDailyDigests(at("2026-10-12T02:59:00Z"))).toMatchObject({ sent: 0, waiting: 2 });

    // 08:30 IST = 07:00 GST
    expect(await sendDailyDigests(at("2026-10-12T03:00:00Z"))).toMatchObject({ sent: 1, waiting: 1 });
    expect(mail.sent.map((m) => m.to)).toEqual(["kiran@edapt.test"]);
    expect(mail.sent[0].subject).toBe("Your day: 1 on Today, 1 overdue");
    expect(mail.sent[0].html).toContain("Good morning, Kiran");

    expect(await sendDailyDigests(at("2026-10-12T03:15:00Z"))).toMatchObject({ sent: 0, skipped: 1, waiting: 1 });

    // 08:30 GST = 10:00 IST
    expect(await sendDailyDigests(at("2026-10-12T04:30:00Z"))).toMatchObject({ sent: 1, skipped: 1, waiting: 0 });
    expect(sentTo("dana@edapt.test")).toHaveLength(1);
    expect(sentTo("kiran@edapt.test")).toHaveLength(1);

    // late evening still the same local day: nothing more
    expect(await sendDailyDigests(at("2026-10-12T17:00:00Z"))).toMatchObject({ sent: 0, skipped: 2 });

    // Tuesday 08:30 IST: Kiran again, Dana waits for her own 08:30
    expect(await sendDailyDigests(at("2026-10-13T03:00:00Z"))).toMatchObject({ sent: 1, waiting: 1 });
    expect(sentTo("kiran@edapt.test")).toHaveLength(2);
    expect(sentTo("dana@edapt.test")).toHaveLength(1);
  });

  it("follows settings digest.dailyHour / dailyMinute", async () => {
    await setSetting("digest", { ...DEFAULT_SETTINGS.digest, dailyHour: 7, dailyMinute: 0 }, null);
    const u = await makeUser({ role: "sales", email: "early@edapt.test" });
    const c = await contact({ ownerId: u.id });
    await createTask({ contactId: c.id, userId: u.id, type: "new_lead", reason: "New lead", dueAt: at("2026-10-12T01:00:00Z") });
    // 07:00 IST = 01:30 UTC
    expect(await sendDailyDigests(at("2026-10-12T01:29:00Z"))).toMatchObject({ sent: 0 });
    expect(await sendDailyDigests(at("2026-10-12T01:30:00Z"))).toMatchObject({ sent: 1 });
    expect(mail.sent[0].html).toContain("every morning at 7:00 am");
  });

  it("an empty digest is not emailed (and not rebuilt every 15 minutes); inactive users get nothing", async () => {
    await makeUser({ role: "support", email: "support@edapt.test" });
    const gone = await makeUser({ role: "sales", email: "gone@edapt.test", active: false });
    const c = await contact({ ownerId: gone.id });
    await createTask({ contactId: c.id, userId: gone.id, type: "follow_up", reason: "x", dueAt: at("2026-10-11T06:00:00Z") });
    expect(await sendDailyDigests(at("2026-10-12T03:00:00Z"))).toMatchObject({ sent: 0, empty: 1 });
    expect(await sendDailyDigests(at("2026-10-12T03:15:00Z"))).toMatchObject({ sent: 0, empty: 0, skipped: 1 });
    expect(mail.sent).toHaveLength(0);
  });

  it("a failed send is reported and retried on the next run", async () => {
    const u = await makeUser({ role: "sales", email: "flaky@edapt.test" });
    const c = await contact({ ownerId: u.id });
    await createTask({ contactId: c.id, userId: u.id, type: "follow_up", reason: "x", dueAt: at("2026-10-11T06:00:00Z") });
    mail.failFor.add("flaky@edapt.test");
    const r = await sendDailyDigests(at("2026-10-12T03:00:00Z"));
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(r.errors[0]).toContain("mailbox unavailable");
    mail.failFor.clear();
    expect(await sendDailyDigests(at("2026-10-12T03:15:00Z"))).toMatchObject({ sent: 1, failed: 0 });
  });
});

describe("buildDailyDigest", () => {
  const NOW = new Date("2026-10-12T03:00:00Z"); // Monday 08:30 IST

  it("counts Today, new leads since the last digest, hot leads, VIPs and (for verifiers) payments", async () => {
    const manager = await makeUser({ role: "manager", name: "Meera" });
    const lead = await contact({ name: "Asha", ownerId: manager.id, ownerAssignedAt: new Date(NOW.getTime() - 2 * H), lastChannel: "whatsapp_api", grade: "A" });
    await contact({ ownerId: manager.id, ownerAssignedAt: new Date(NOW.getTime() - 30 * H) }); // before the window
    await createTask({ contactId: lead.id, userId: manager.id, type: "new_lead", reason: "New lead from WhatsApp", dueAt: new Date(NOW.getTime() - H) });
    await db.insert(notifications).values([
      { userId: manager.id, type: "hot_lead", title: "Hot lead: Asha", body: "Grade A lead enquired", contactId: lead.id, createdAt: new Date(NOW.getTime() - H) },
      { userId: manager.id, type: "hot_lead", title: "Hot lead: Old", contactId: null, createdAt: new Date(NOW.getTime() - 30 * H) },
      { userId: manager.id, type: "vip_quiet", title: "VIP gone quiet: Priya", body: "Grade A customer", contactId: null, createdAt: new Date(NOW.getTime() - 5 * H) },
    ]);
    const payer = await contact({ name: "Ravi" });
    await recordPurchase(
      { contactId: payer.id, productName: "Workshop", family: "workshop", amount: 1500, currency: "INR", mode: "upi_qr", source: "manual", reference: ref(), paidNow: { amount: 1500, reference: ref(), paidAt: new Date(NOW.getTime() - 3 * D) } },
      manager,
    );
    await recordPurchase(
      {
        contactId: payer.id,
        productName: "Consulting",
        family: "consulting",
        amount: 2000,
        currency: "INR",
        mode: "cash",
        source: "manual",
        purchasedAt: new Date(NOW.getTime() - 10 * D),
        instalments: [
          { amount: 1000, dueAt: new Date(NOW.getTime() - D) },
          { amount: 1000, dueAt: new Date(NOW.getTime() + 20 * D) },
        ],
        paidNow: null,
      },
      manager,
    );

    const d = await buildDailyDigest(manager, NOW);
    expect(d.today).toMatchObject({ total: 1, abandoned: 0, overdue: 0 });
    // the row's wording ("why it is here") belongs to the Today queue; the digest repeats it as given
    expect(d.today.top).toHaveLength(1);
    expect(d.today.top[0]).toMatchObject({ contactId: lead.id, name: "Asha" });
    expect(d.today.top[0].detail).toEqual(expect.any(String));
    expect(d.newLeads).toEqual({ count: 1, items: [{ contactId: lead.id, name: "Asha", detail: "WhatsApp API · Grade A" }] });
    expect(d.hotLeads).toEqual({ count: 1, items: [{ contactId: lead.id, name: "Asha", detail: "Grade A lead enquired" }] });
    expect(d.vipQuiet).toMatchObject({ count: 1, items: [{ contactId: null, name: "Priya" }] });
    expect(d.payments).toEqual({ unverified: 1, unverifiedInr: 1500, stale: 1, staleDays: 2, overdueInstalments: 1 });
    expect(d.sendTimeLabel).toBe("8:30 am");
  });

  it("salespeople get no payments block; 'since' is their previous digest", async () => {
    const sales = await makeUser({ role: "sales" });
    await db.insert(auditLog).values({
      tableName: "alerts",
      rowId: `daily:${sales.id}:2026-10-11`,
      action: "digest",
      field: "daily",
      changedAt: new Date(NOW.getTime() - 6 * H),
    });
    await contact({ ownerId: sales.id, ownerAssignedAt: new Date(NOW.getTime() - 8 * H) }); // before their last digest
    await contact({ ownerId: sales.id, ownerAssignedAt: new Date(NOW.getTime() - 4 * H) });
    const d = await buildDailyDigest(sales, NOW);
    expect(d.payments).toBeNull();
    expect(d.newLeads.count).toBe(1);
  });
});

describe("sendPendingNotificationEmails", () => {
  const NOW = new Date();

  it("sends one email per person listing their pending alerts, once", async () => {
    const umer = await makeUser({ role: "admin", name: "Umer A", email: "umer@edapt.test" });
    const gone = await makeUser({ role: "manager", email: "gone@edapt.test", active: false });
    const c = await contact({ name: "Asha" });
    await db.insert(notifications).values([
      { userId: umer.id, type: "hot_lead", title: "Hot lead: Asha", body: "Grade A lead enquired", contactId: c.id, email: true },
      { userId: umer.id, type: "unverified_payment", title: "Verify ₹999 from Ravi", body: "Workshop", email: true },
      { userId: umer.id, type: "new_lead", title: "New lead: Asha", email: false },
      { userId: gone.id, type: "hot_lead", title: "Hot lead: Asha", email: true },
    ]);
    const r = await sendPendingNotificationEmails(NOW);
    expect(r).toMatchObject({ emails: 1, notifications: 2, failed: 0 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "umer@edapt.test", subject: "2 alerts: Hot lead: Asha and 1 more" });
    expect(mail.sent[0].html).toContain(`/contacts/${c.id}`);
    expect(mail.sent[0].html).toContain("/payments?tab=unverified");
    const pending = await db.select().from(notifications).where(isNull(notifications.emailedAt));
    expect(pending.map((n) => n.type).sort()).toEqual(["hot_lead", "new_lead"]); // the inactive user's and the in-app-only one
    expect(await sendPendingNotificationEmails(NOW)).toMatchObject({ emails: 0, notifications: 0 });
  });

  it("a failed email leaves the alerts pending for the next run", async () => {
    const u = await makeUser({ role: "manager", email: "m@edapt.test" });
    await db.insert(notifications).values({ userId: u.id, type: "hot_lead", title: "Hot lead: X", email: true });
    mail.failFor.add("m@edapt.test");
    expect(await sendPendingNotificationEmails(NOW)).toMatchObject({ emails: 0, failed: 1 });
    expect((await db.select().from(notifications))[0].emailedAt).toBeNull();
    mail.failFor.clear();
    expect(await sendPendingNotificationEmails(NOW)).toMatchObject({ emails: 1, notifications: 1 });
  });

  it("alerts older than 48 hours are no longer emailed", async () => {
    const u = await makeUser({ role: "manager" });
    await db.insert(notifications).values({ userId: u.id, type: "hot_lead", title: "Old", email: true, createdAt: new Date(Date.now() - 49 * H) });
    expect(await sendPendingNotificationEmails(NOW)).toMatchObject({ emails: 0 });
  });
});

describe("weekly summary", () => {
  // Monday 12 Oct 2026, 09:00 IST: the week is Mon 5 Oct to Sun 11 Oct (IST)
  const NOW = new Date("2026-10-12T03:30:00Z");

  async function fixture() {
    const admin = await makeUser({ role: "admin", email: "umer@edapt.test" });
    const a = await contact({ name: "Anil", createdAt: new Date("2026-10-06T05:00:00Z"), firstChannel: "tagmango_checkout", umerLevel: 1 });
    const b = await contact({ name: "Bina", createdAt: new Date("2026-10-08T05:00:00Z"), firstChannel: "whatsapp_api", umerLevel: 4 });
    const c = await contact({ name: "Chris", createdAt: new Date("2026-09-20T05:00:00Z"), firstChannel: "meta_lead_form" });
    await contact({ name: "Lead", createdAt: new Date("2026-10-09T05:00:00Z"), firstChannel: "whatsapp_api" });
    await contact({ name: "Merged", createdAt: new Date("2026-10-09T06:00:00Z"), firstChannel: "whatsapp_api", mergedIntoId: a.id });
    const late = await contact({ name: "Late", createdAt: new Date("2026-10-11T19:00:00Z"), firstChannel: "phone_call" });

    const tm = (contactId: string, amount: number, iso: string) =>
      recordPurchase(
        { contactId, productName: "Workshop", family: "workshop", amount, currency: "INR", mode: "tagmango", source: "tagmango", reference: ref(), purchasedAt: new Date(iso) },
        null,
      );
    const pa = await tm(a.id, 10000, "2026-10-07T06:00:00Z");
    const pb = await tm(b.id, 5000, "2026-10-09T06:00:00Z");
    await tm(c.id, 3000, "2026-09-30T06:00:00Z"); // the week before
    await tm(late.id, 700, "2026-10-11T19:00:00Z"); // Monday 00:30 IST: this week's report does not include it
    await recordRefund(pa.purchaseId, { amount: 1000, reason: "Partial refund", refundedAt: new Date("2026-10-10T06:00:00Z") }, admin);
    // an unverified bank transfer never counts as revenue
    await recordPurchase(
      { contactId: b.id, productName: "Consulting", family: "consulting", amount: 2000, currency: "INR", mode: "upi_qr", source: "manual", reference: ref(), paidNow: { amount: 2000, reference: ref(), paidAt: new Date("2026-10-10T06:00:00Z") } },
      admin,
    );
    await db.update(purchases).set({ assisted: true }).where(eq(purchases.id, pb.purchaseId));
    await db.update(purchases).set({ assisted: false }).where(eq(purchases.id, pa.purchaseId));

    await db.insert(enquiries).values([
      { contactId: a.id, channel: "tagmango_checkout", status: "abandoned", receivedAt: new Date("2026-10-06T05:00:00Z") },
      { contactId: b.id, channel: "tagmango_checkout", status: "recovered", receivedAt: new Date("2026-10-08T05:00:00Z") },
      { contactId: b.id, channel: "whatsapp_api", status: "open", receivedAt: new Date("2026-10-08T06:00:00Z") },
      { contactId: c.id, channel: "whatsapp_api", status: "open", receivedAt: new Date("2026-09-29T06:00:00Z") },
    ]);
    // calculated columns set directly for the fixture (normally written by recompute)
    await db.update(contacts).set({ atRisk: true, expected90dInr: 999 }).where(eq(contacts.id, c.id));
    await db.update(contacts).set({ networkValueInr: 5000, referralCount: 2 }).where(eq(contacts.id, a.id));
    await contact({ name: "Quiet VIP", grade: "A", purchaseCount: 1, ltvInr: 50000, lastActivityAt: new Date("2026-05-01T00:00:00Z") });
    return { admin, a, b, c };
  }

  it("adds up last week against the week before", async () => {
    const { a } = await fixture();
    const s = await buildWeeklySummary(NOW);
    expect(s.weekKey).toBe("2026-10-12");
    expect(s.range.start.toISOString()).toBe("2026-10-04T18:30:00.000Z");
    expect(s.range.end.toISOString()).toBe("2026-10-11T18:30:00.000Z");
    expect(s.revenue).toEqual({ current: 14000, previous: 3000 });
    expect(s.newCustomers).toBe(2);
    expect(s.leads.total).toBe(3);
    expect(s.leads.enquiries).toBe(3);
    expect(s.leads.byChannel).toEqual([
      { key: "whatsapp_api", label: "WhatsApp API", count: 2 },
      { key: "tagmango_checkout", label: "TagMango checkout", count: 1 },
    ]);
    expect(s.assisted).toEqual({ assistedInr: 5000, selfServeInr: 9000 });
    expect(s.beyondUmer.inr).toBe(9000);
    expect(s.beyondUmer.share).toBeCloseTo(9000 / 14000, 6);
    expect(s.atRisk).toEqual({ count: 1, expectedInr: 999 });
    expect(s.unverified).toEqual({ count: 1, inr: 2000, stale: 0, staleDays: 2 });
    // as on the dashboard: every checkout that passed the window (abandoned + recovered), and how many paid later
    expect(s.checkouts).toEqual({ abandoned: 2, recovered: 1 });
    expect(s.topAdvocates).toEqual([{ contactId: a.id, name: "Anil", referrals: 2, networkInr: 5000 }]);
    expect(s.vipQuiet.count).toBe(1);
    expect(s.vipQuiet.items[0]).toMatchObject({ name: "Quiet VIP", ltvInr: 50000 });
  });

  it("goes to every admin and digest.weeklyRecipients, once per week", async () => {
    await fixture();
    const manager = await makeUser({ role: "manager", email: "ops@edapt.test" });
    await makeUser({ role: "sales", email: "sales@edapt.test" });
    await setSetting("digest", { ...DEFAULT_SETTINGS.digest, weeklyRecipients: [manager.id, "cfo@example.com", "not an email"] }, null);
    const r = await sendWeeklySummary(NOW);
    expect(r).toMatchObject({ sent: 3, recipients: 3, weekKey: "2026-10-12", failed: 0 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["cfo@example.com", "ops@edapt.test", "umer@edapt.test"]);
    expect(mail.sent[0].subject).toBe("Week of 5 Oct to 11 Oct: ₹14K revenue (+367%), 2 new customers");
    expect(mail.sent[0].html).toContain("Anil");
    // the same week again (a retry, or Wednesday): nothing new
    expect(await sendWeeklySummary(new Date("2026-10-14T05:00:00Z"))).toMatchObject({ sent: 0, skipped: 3 });
    // next Monday: a new summary
    expect(await sendWeeklySummary(new Date("2026-10-19T03:30:00Z"))).toMatchObject({ sent: 3 });
  });
});
