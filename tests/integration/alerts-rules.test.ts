import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
  contacts,
  enquiries,
  interactions,
  notifications,
  payments,
  tasks,
  type NewContact,
  type TaskType,
} from "@/db/schema";
import { createTask } from "@/lib/alerts/core";
import { runAllAlerts } from "@/lib/alerts/jobs";
import {
  abandonedCheckouts,
  atRisk,
  closeRepurchasedTasks,
  dueForNextRung,
  followUpsDue,
  instalmentsDue,
  PRIORITY_HIGH,
  unverifiedPayments,
  untouchedLeads,
  vipGoneQuiet,
} from "@/lib/alerts/rules";
import { setOwner } from "@/lib/contacts/assignment";
import { logInteraction } from "@/lib/contacts/interactions";
import { recordInstalmentPayment, recordPurchase } from "@/lib/money/purchases";
import { DEFAULT_SETTINGS, setSetting } from "@/lib/settings";
import { makeUser, resetDb } from "../support/db";

// alert emails are only logged in tests
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true, id: "test" })) }));

// Thu 1 Oct 2026, 15:00 in India. In the past, so money can be recorded as paid before it.
const NOW = new Date("2026-10-01T09:30:00Z");
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const at = (ms: number) => new Date(NOW.getTime() + ms);

let seq = 0;
async function contact(over: Partial<NewContact> = {}) {
  seq += 1;
  const [c] = await db
    .insert(contacts)
    .values({
      phoneE164: `+9197450${String(10000 + seq).padStart(5, "0")}`,
      phoneCountry: "IN",
      name: `Contact ${seq}`,
      firstDoor: "youtube",
      ...over,
    })
    .returning();
  return c;
}
async function checkout(contactId: string, receivedAt: Date, over: Partial<typeof enquiries.$inferInsert> = {}) {
  const [e] = await db
    .insert(enquiries)
    .values({ contactId, channel: "tagmango_checkout", status: "checkout_started", receivedAt, productInterest: "Claude Mastery", ...over })
    .returning();
  return e;
}
const tasksOf = (type: TaskType) => db.select().from(tasks).where(eq(tasks.type, type));
const notesOf = (type: string) => db.select().from(notifications).where(eq(notifications.type, type));
const enquiryStatus = async (id: string) => (await db.select().from(enquiries).where(eq(enquiries.id, id)))[0].status;
let ref = 0;
const nextRef = () => `REF-${++ref}`;

beforeEach(async () => {
  await resetDb();
});

describe("abandonedCheckouts", () => {
  it("fires at thresholds.abandonedCheckoutMinutes, not before, once, as a high-priority task for the owner", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await contact({ ownerId: sales.id, ownerAssignedAt: at(-2 * D) });
    const e = await checkout(c.id, at(-59 * MIN));

    expect(await abandonedCheckouts(NOW)).toMatchObject({ abandoned: 0, tasks: 0 });
    expect(await tasksOf("abandoned_checkout")).toHaveLength(0);
    expect(await enquiryStatus(e.id)).toBe("checkout_started");

    const later = at(2 * MIN);
    expect(await abandonedCheckouts(later)).toMatchObject({ abandoned: 1, tasks: 1 });
    const [t] = await tasksOf("abandoned_checkout");
    expect(t).toMatchObject({ userId: sales.id, contactId: c.id, priority: PRIORITY_HIGH, status: "open", dedupeKey: `abandoned_checkout:${e.id}` });
    // NOW is 3:00 pm IST: the checkout started at 2:01 pm
    expect(t.reason).toBe("Started paying for Claude Mastery at 2:01 pm on 1 Oct — no completed order");
    expect(t.dueAt.toISOString()).toBe(new Date(e.receivedAt.getTime() + 60 * MIN).toISOString());
    expect(await enquiryStatus(e.id)).toBe("abandoned");

    // re-runs never duplicate
    expect(await abandonedCheckouts(at(15 * MIN))).toMatchObject({ abandoned: 0, tasks: 0 });
    expect(await tasksOf("abandoned_checkout")).toHaveLength(1);
  });

  it("follows the threshold from settings", async () => {
    await setSetting("thresholds", { ...DEFAULT_SETTINGS.thresholds, abandonedCheckoutMinutes: 30 }, null);
    const c = await contact();
    await checkout(c.id, at(-31 * MIN));
    expect(await abandonedCheckouts(NOW)).toMatchObject({ tasks: 1 });
  });

  it("goes to the pool when there is no active owner, and says when the payment failed", async () => {
    const gone = await makeUser({ role: "sales", active: false });
    const pool = await contact();
    const orphan = await contact({ ownerId: gone.id, phoneE164: "+971501234567", phoneCountry: "AE" });
    await checkout(pool.id, at(-2 * H), { status: "checkout_failed", productInterest: null });
    await checkout(orphan.id, at(-2 * H));
    expect(await abandonedCheckouts(NOW)).toMatchObject({ abandoned: 2, tasks: 2 });
    const rows = await tasksOf("abandoned_checkout");
    expect(rows.every((r) => r.userId === null)).toBe(true);
    const byContact = new Map(rows.map((r) => [r.contactId, r.reason]));
    expect(byContact.get(pool.id)).toBe("Payment failed for an order at 1:00 pm on 1 Oct — no completed order");
    // a GCC number in the pool is worded in Dubai time (11:30 am GST)
    expect(byContact.get(orphan.id)).toBe("Started paying for Claude Mastery at 11:30 am on 1 Oct — no completed order");
  });

  it("no alert when verified money came for the checkout; the enquiry is marked handled or recovered", async () => {
    const quick = await contact();
    const late = await contact();
    // the order webhook arrived before the checkout event (the money module had nothing to resolve then)
    await recordPurchase(
      { contactId: quick.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: nextRef(), purchasedAt: at(-110 * MIN), paidNow: { amount: 999, paidAt: at(-110 * MIN) } },
      null,
    );
    await recordPurchase(
      { contactId: late.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: nextRef(), purchasedAt: at(-30 * MIN), paidNow: { amount: 999, paidAt: at(-30 * MIN) } },
      null,
    );
    const e1 = await checkout(quick.id, at(-2 * H));
    const e2 = await checkout(late.id, at(-2 * H));
    expect(await abandonedCheckouts(NOW)).toMatchObject({ abandoned: 0, tasks: 0, resolved: 2 });
    expect(await enquiryStatus(e1.id)).toBe("handled");
    expect(await enquiryStatus(e2.id)).toBe("recovered");
    expect(await tasksOf("abandoned_checkout")).toHaveLength(0);
  });

  it("waits while a manual payment for it is unverified, and alerts once that claim is rejected", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await contact({ ownerId: sales.id });
    const e = await checkout(c.id, at(-3 * H));
    await recordPurchase(
      { contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "upi_qr", source: "manual", reference: nextRef(), paidNow: { amount: 999, reference: nextRef(), paidAt: at(-2 * H) } },
      sales,
    );
    expect(await abandonedCheckouts(NOW)).toMatchObject({ waiting: 1, tasks: 0 });
    expect(await enquiryStatus(e.id)).toBe("checkout_started");
    await db.update(payments).set({ status: "rejected" }).where(eq(payments.contactId, c.id));
    expect(await abandonedCheckouts(NOW)).toMatchObject({ abandoned: 1, tasks: 1 });
  });

  it("one task per contact; an open task absorbs later checkouts; week-old checkouts are ignored", async () => {
    const c = await contact();
    const a = await checkout(c.id, at(-3 * H));
    const b = await checkout(c.id, at(-2 * H), { status: "checkout_failed" });
    const old = await contact();
    const stale = await checkout(old.id, at(-8 * D));
    expect(await abandonedCheckouts(NOW)).toMatchObject({ abandoned: 2, tasks: 1 });
    const [t] = await tasksOf("abandoned_checkout");
    expect(t.dedupeKey).toBe(`abandoned_checkout:${b.id}`);
    expect(t.payload).toMatchObject({ enquiryIds: [a.id, b.id] });
    const again = await checkout(c.id, at(-90 * MIN));
    expect(await abandonedCheckouts(NOW)).toMatchObject({ abandoned: 1, tasks: 0 });
    expect(await enquiryStatus(again.id)).toBe("abandoned");
    expect(await tasksOf("abandoned_checkout")).toHaveLength(1);
    expect(await enquiryStatus(stale.id)).toBe("checkout_started");
  });

  it("ignores other channels and statuses", async () => {
    const c = await contact();
    await checkout(c.id, at(-3 * H), { channel: "whatsapp_api", status: "open" });
    await checkout(c.id, at(-3 * H), { status: "recovered" });
    expect(await abandonedCheckouts(NOW)).toMatchObject({ abandoned: 0, tasks: 0 });
  });
});

describe("untouchedLeads", () => {
  it("owner at 24 hours (task + in-app), managers at 48 hours, once each", async () => {
    const sales = await makeUser({ role: "sales", name: "Sana" });
    const m1 = await makeUser({ role: "manager" });
    const m2 = await makeUser({ role: "manager" });
    await makeUser({ role: "admin" });
    const assignedAt = at(-23 * H);
    const lead = await contact({ name: "Lena", ownerId: sales.id, ownerAssignedAt: assignedAt });

    expect(await untouchedLeads(NOW)).toMatchObject({ ownerAlerts: 0, managerAlerts: 0 });
    const t24 = at(1 * H + MIN);
    expect(await untouchedLeads(t24)).toMatchObject({ ownerAlerts: 1, managerAlerts: 0 });
    const [task] = await tasksOf("untouched_lead");
    expect(task).toMatchObject({ userId: sales.id, contactId: lead.id, status: "open", dedupeKey: `untouched_lead:${lead.id}:${assignedAt.toISOString()}` });
    expect(task.reason).toBe("No call or message logged since it was assigned at 4:00 pm on 30 Sept");
    let notes = await notesOf("untouched_lead");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: sales.id, title: "Untouched lead: Lena", taskId: task.id });

    expect(await untouchedLeads(at(5 * H))).toMatchObject({ ownerAlerts: 0, managerAlerts: 0 });
    const t48 = at(25 * H + MIN);
    expect(await untouchedLeads(t48)).toMatchObject({ ownerAlerts: 0, managerAlerts: 2 });
    notes = await notesOf("untouched_lead");
    expect(notes.map((n) => n.userId).sort()).toEqual([sales.id, m1.id, m2.id].sort());
    expect(notes.find((n) => n.userId === m1.id)?.body).toBe("Sana has logged no interaction in the 48 hours since the lead was assigned");
    expect(await untouchedLeads(at(26 * H))).toMatchObject({ ownerAlerts: 0, managerAlerts: 0 });
    expect(await tasksOf("untouched_lead")).toHaveLength(1);
  });

  it("an interaction by the owner after assignment counts; one by someone else does not", async () => {
    const sales = await makeUser({ role: "sales" });
    const support = await makeUser({ role: "support" });
    const touched = await contact({ ownerId: sales.id, ownerAssignedAt: at(-30 * H) });
    const other = await contact({ ownerId: sales.id, ownerAssignedAt: at(-30 * H) });
    const before = await contact({ ownerId: sales.id, ownerAssignedAt: at(-30 * H) });
    await db.insert(interactions).values([
      { contactId: touched.id, userId: sales.id, type: "call", occurredAt: at(-29 * H) },
      { contactId: other.id, userId: support.id, type: "note", occurredAt: at(-29 * H) },
      { contactId: before.id, userId: sales.id, type: "call", occurredAt: at(-31 * H) },
    ]);
    await untouchedLeads(NOW);
    expect((await tasksOf("untouched_lead")).map((t) => t.contactId).sort()).toEqual([other.id, before.id].sort());
  });

  it("customers, Lost leads and contacts without an owner never get it", async () => {
    const sales = await makeUser({ role: "sales" });
    const customer = await contact({ ownerId: sales.id, ownerAssignedAt: at(-30 * H) });
    await recordPurchase(
      { contactId: customer.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: nextRef(), purchasedAt: at(-40 * H) },
      null,
    );
    await contact({ ownerId: sales.id, ownerAssignedAt: at(-30 * H), stage: "lost" });
    await contact({ ownerAssignedAt: at(-30 * H) });
    expect(await untouchedLeads(NOW)).toMatchObject({ ownerAlerts: 0, managerAlerts: 0 });
  });

  it("closes the task when answered, and dismisses it when the lead changes hands (the clock restarts)", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    await makeUser({ role: "manager" });
    const a = await contact({ ownerId: s1.id, ownerAssignedAt: at(-30 * H) });
    const b = await contact({ ownerId: s1.id, ownerAssignedAt: at(-30 * H) });
    await untouchedLeads(NOW);
    expect(await tasksOf("untouched_lead")).toHaveLength(2);

    await logInteraction(a.id, { type: "call", outcome: "no_answer" }, s1);
    const reassignedAt = at(MIN);
    await setOwner(b.id, s2.id, { reason: "Manager moved it", changedById: null, now: reassignedAt });
    const r = await untouchedLeads(at(2 * MIN));
    expect(r.ownerAlerts).toBe(0);
    const rows = await tasksOf("untouched_lead");
    expect(rows.find((t) => t.contactId === a.id)?.status).toBe("done");
    expect(rows.find((t) => t.contactId === b.id)).toMatchObject({ status: "dismissed", userId: s2.id });
    // s2's own 24 hours start at the reassignment
    expect(await untouchedLeads(new Date(reassignedAt.getTime() + 23 * H))).toMatchObject({ ownerAlerts: 0 });
    expect(await untouchedLeads(new Date(reassignedAt.getTime() + 24 * H))).toMatchObject({ ownerAlerts: 1 });
    const fresh = (await tasksOf("untouched_lead")).find((t) => t.status === "open");
    expect(fresh).toMatchObject({ contactId: b.id, userId: s2.id });
  });
});

describe("releaseStaleLeads through runAllAlerts", () => {
  it("returns stale open leads to the pool with a manager alert; customers never expire", async () => {
    const sales = await makeUser({ role: "sales" });
    const manager = await makeUser({ role: "manager" });
    const lead = await contact({ ownerId: sales.id, ownerAssignedAt: at(-8 * D) });
    const customer = await contact({ ownerId: sales.id, ownerAssignedAt: at(-8 * D) });
    await recordPurchase(
      { contactId: customer.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: nextRef(), purchasedAt: at(-9 * D) },
      null,
    );
    // an untouched alert from earlier in the week
    await untouchedLeads(at(-6 * D));
    expect(await tasksOf("untouched_lead")).toHaveLength(1);

    const r = await runAllAlerts(NOW);
    expect(r.releaseStaleLeads.released).toBe(1);
    const rows = await db.select().from(contacts);
    expect(rows.find((c) => c.id === lead.id)?.ownerId).toBeNull();
    expect(rows.find((c) => c.id === customer.id)?.ownerId).toBe(sales.id);
    expect(await tasksOf("lead_released")).toEqual([expect.objectContaining({ userId: manager.id, contactId: lead.id })]);
    // the untouched alert no longer applies once the lead is back in the pool
    expect((await tasksOf("untouched_lead"))[0].status).toBe("dismissed");

    const again = await runAllAlerts(at(15 * MIN));
    expect(again.releaseStaleLeads.released).toBe(0);
    expect(await tasksOf("lead_released")).toHaveLength(1);
  });
});

describe("followUpsDue", () => {
  it("pings the assignee once when the follow-up time arrives", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await contact({ name: "Fathima", ownerId: sales.id });
    const due = await createTask({ contactId: c.id, userId: sales.id, type: "follow_up", reason: "Call back about the workshop", dueAt: at(-10 * MIN) });
    await createTask({ contactId: c.id, userId: sales.id, type: "follow_up", reason: "Later", dueAt: at(D) });
    await createTask({ contactId: c.id, userId: sales.id, type: "follow_up", reason: "Long overdue", dueAt: at(-3 * D) });
    await createTask({ contactId: c.id, userId: null, type: "follow_up", reason: "Pool", dueAt: at(-10 * MIN) });

    expect(await followUpsDue(NOW)).toEqual({ notified: 1 });
    const [n] = await notesOf("follow_up_due");
    expect(n).toMatchObject({ userId: sales.id, taskId: due, title: "Follow-up due: Fathima", body: "Call back about the workshop" });
    expect(await followUpsDue(at(15 * MIN))).toEqual({ notified: 0 });
  });
});

describe("dueForNextRung and atRisk", () => {
  async function customer(over: Partial<NewContact> = {}) {
    return contact({ purchaseCount: 1, stage: "first_purchase", lastPurchaseAt: at(-40 * D), firstPurchaseAt: at(-40 * D), ...over });
  }

  it("raises next rung within nextRungDays of the expected date, with the offer, once per purchase cycle", async () => {
    const sales = await makeUser({ role: "sales" });
    const due = await customer({ ownerId: sales.id, nextExpectedAt: at(5 * D), nextOffer: "The AI Office" });
    const slightlyLate = await customer({ nextExpectedAt: at(-3 * D) });
    await customer({ ownerId: sales.id, nextExpectedAt: at(10 * D) });
    await customer({ ownerId: sales.id, nextExpectedAt: at(-3 * D), atRisk: true });
    await contact({ nextExpectedAt: at(2 * D) }); // a lead, never

    expect(await dueForNextRung(NOW)).toEqual({ created: 2 });
    const rows = await tasksOf("next_rung");
    const t = rows.find((r) => r.contactId === due.id)!;
    expect(t).toMatchObject({ userId: sales.id, reason: "Due for the next rung: offer The AI Office", status: "open" });
    expect(rows.find((r) => r.contactId === slightlyLate.id)).toMatchObject({ userId: null, reason: "Due to buy again: check what fits next" });

    // the nightly recompute nudges the expected date: still the same cycle, no second task
    await db.update(contacts).set({ nextExpectedAt: at(6 * D) }).where(eq(contacts.id, due.id));
    expect(await dueForNextRung(at(D))).toEqual({ created: 0 });

    // they buy again: the open task closes, and the next cycle gets its own task
    await db.update(contacts).set({ lastPurchaseAt: at(-1 * D), purchaseCount: 2, nextExpectedAt: at(3 * D) }).where(eq(contacts.id, due.id));
    expect(await closeRepurchasedTasks(NOW)).toEqual({ closed: 1 });
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].status).toBe("done");
    expect(await dueForNextRung(NOW)).toEqual({ created: 1 });
    expect(await tasksOf("next_rung")).toHaveLength(3);
  });

  it("raises at risk once a month at most, never while one is open, never for Lost or merged contacts", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await customer({ ownerId: sales.id, atRisk: true, nextExpectedAt: at(-45 * D), nextOffer: "Applied AI Mastery" });
    await customer({ atRisk: true, stage: "lost" });
    const winner = await customer();
    await customer({ atRisk: true, mergedIntoId: winner.id });

    expect(await atRisk(NOW)).toEqual({ created: 1 });
    const [t] = await tasksOf("at_risk");
    expect(t).toMatchObject({ userId: sales.id, contactId: c.id, reason: "At risk: 45 days past the expected next purchase — offer Applied AI Mastery" });
    expect(t.dedupeKey).toBe(`at_risk:${c.id}:2026-10`);
    expect(await atRisk(at(D))).toEqual({ created: 0 });
    // done this month: not again this month
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, t.id));
    expect(await atRisk(at(5 * D))).toEqual({ created: 0 });
    // next month: again
    expect(await atRisk(at(31 * D))).toEqual({ created: 1 });
    // still open next-next month: no pile-up
    expect(await atRisk(at(62 * D))).toEqual({ created: 0 });
  });
});

describe("instalmentsDue", () => {
  it("due within instalmentDueDays: task for the owner and in-app to owner and managers; overdue rewords it", async () => {
    const sales = await makeUser({ role: "sales", name: "Sana" });
    const manager = await makeUser({ role: "manager" });
    const c = await contact({ name: "Ravi", ownerId: sales.id });
    const { paymentIds } = await recordPurchase(
      {
        contactId: c.id,
        productName: "Applied AI Mastery",
        family: "applied_ai_mastery",
        amount: 30000,
        currency: "INR",
        mode: "bank_transfer",
        source: "manual",
        purchasedAt: at(-D),
        instalments: [
          { amount: 10000, dueAt: at(2 * D) },
          { amount: 10000, dueAt: at(32 * D) },
          { amount: 10000, dueAt: at(62 * D) },
        ],
        paidNow: null,
      },
      sales,
    );

    expect(await instalmentsDue(NOW)).toEqual({ dueTasks: 1, overdueTasks: 0, notified: 2 });
    let [t] = await tasksOf("instalment_due");
    expect(t).toMatchObject({ userId: sales.id, contactId: c.id, dedupeKey: `instalment_due:${paymentIds[0]}` });
    expect(t.reason).toBe("Instalment 1 of 3 (₹10,000) for Applied AI Mastery is due on 3 Oct");
    let notes = await notesOf("instalment_due");
    expect(notes.map((n) => n.userId).sort()).toEqual([sales.id, manager.id].sort());
    expect(notes[0].title).toBe("Instalment due: Ravi");
    expect(await instalmentsDue(at(H))).toEqual({ dueTasks: 0, overdueTasks: 0, notified: 0 });

    // a day after the due date: the same row is reworded, and owner and managers hear once more
    expect(await instalmentsDue(at(3 * D))).toEqual({ dueTasks: 0, overdueTasks: 1, notified: 2 });
    const all = await tasksOf("instalment_due");
    expect(all).toHaveLength(1);
    [t] = all;
    expect(t).toMatchObject({ status: "open", dedupeKey: `instalment_due:${paymentIds[0]}:overdue` });
    expect(t.reason).toBe("Instalment 1 of 3 (₹10,000) for Applied AI Mastery was due on 3 Oct and is unpaid");
    notes = await notesOf("instalment_due");
    expect(notes.filter((n) => n.title === "Instalment overdue: Ravi")).toHaveLength(2);
    expect(await instalmentsDue(at(4 * D))).toEqual({ dueTasks: 0, overdueTasks: 0, notified: 0 });

    // paid and verified: the money module closes the alert
    await recordInstalmentPayment(paymentIds[0], { reference: nextRef(), mode: "bank_transfer", paidAt: at(-H), verify: true }, manager);
    expect((await tasksOf("instalment_due"))[0].status).toBe("done");
  });

  it("an instalment that was already overdue when first seen gets one overdue task; the pool when unowned", async () => {
    const manager = await makeUser({ role: "manager" });
    const c = await contact();
    await recordPurchase(
      {
        contactId: c.id,
        productName: "Consulting",
        family: "consulting",
        amount: 2000,
        currency: "INR",
        mode: "cash",
        source: "manual",
        purchasedAt: at(-40 * D),
        instalments: [
          { amount: 1000, dueAt: at(-35 * D) },
          { amount: 1000, dueAt: at(-5 * D) },
        ],
        paidNow: null,
      },
      manager,
    );
    expect(await instalmentsDue(NOW)).toEqual({ dueTasks: 0, overdueTasks: 2, notified: 2 });
    const rows = await tasksOf("instalment_due");
    expect(rows.every((r) => r.userId === null && r.dedupeKey!.endsWith(":overdue"))).toBe(true);
  });
});

describe("unverifiedPayments", () => {
  it("emails managers once a manual payment has waited unverifiedPaymentDays", async () => {
    const sales = await makeUser({ role: "sales", name: "Sana" });
    const m1 = await makeUser({ role: "manager" });
    const m2 = await makeUser({ role: "manager" });
    await makeUser({ role: "admin" });
    const c = await contact({ name: "Ravi", ownerId: sales.id });
    const utr = nextRef();
    await recordPurchase(
      { contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "upi_qr", source: "manual", reference: nextRef(), paidNow: { amount: 999, reference: utr, paidAt: at(-D) } },
      sales,
    );
    expect(await unverifiedPayments(NOW)).toEqual({ payments: 0, notified: 0 });
    expect(await unverifiedPayments(at(D + MIN))).toEqual({ payments: 1, notified: 2 });
    const notes = await notesOf("unverified_payment");
    expect(notes.map((n) => n.userId).sort()).toEqual([m1.id, m2.id].sort());
    expect(notes[0]).toMatchObject({ email: true, title: "Verify ₹999 from Ravi", contactId: c.id });
    expect(notes[0].body).toBe(`Workshop · UPI QR ref ${utr} · recorded by Sana · waiting 2 days for verification`);
    // already alerted: not picked up again
    expect(await unverifiedPayments(at(3 * D))).toEqual({ payments: 0, notified: 0 });
  });

  it("falls back to admins when there is no manager (the spec's default manager is Umer)", async () => {
    const admin = await makeUser({ role: "admin" });
    const c = await contact();
    await recordPurchase(
      { contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "bank_transfer", source: "manual", reference: nextRef(), paidNow: { amount: 999, reference: nextRef(), paidAt: at(-5 * D) } },
      null,
    );
    await unverifiedPayments(NOW);
    expect((await notesOf("unverified_payment")).map((n) => n.userId)).toEqual([admin.id]);
  });
});

describe("vipGoneQuiet", () => {
  it("alerts the owner and Umer (admins + weekly recipients) once a quarter, for grade A customers only", async () => {
    const sales = await makeUser({ role: "sales" });
    const admin = await makeUser({ role: "admin" });
    const cfo = await makeUser({ role: "manager", email: "cfo@edapt.test" });
    await makeUser({ role: "manager" });
    await setSetting("digest", { ...DEFAULT_SETTINGS.digest, weeklyRecipients: ["CFO@edapt.test", "outside@example.com"] }, null);
    const vip = await contact({
      name: "Priya",
      ownerId: sales.id,
      grade: "A",
      purchaseCount: 3,
      ltvInr: 120000,
      lastActivityAt: at(-121 * D),
      lastPurchaseAt: at(-130 * D),
      nextOffer: "The AI Office",
    });
    await contact({ grade: "A", purchaseCount: 2, lastActivityAt: at(-100 * D) }); // not quiet long enough
    await contact({ grade: "B", purchaseCount: 2, lastActivityAt: at(-200 * D) }); // not a VIP
    await contact({ grade: "A", purchaseCount: 0, lastActivityAt: at(-200 * D) }); // a lead

    expect(await vipGoneQuiet(NOW)).toEqual({ contacts: 1, notified: 3 });
    const notes = await notesOf("vip_quiet");
    expect(notes.map((n) => n.userId).sort()).toEqual([sales.id, admin.id, cfo.id].sort());
    expect(notes[0]).toMatchObject({ contactId: vip.id, title: "VIP gone quiet: Priya", email: false });
    expect(notes[0].body).toBe("Grade A customer · LTV ₹1,20,000 · no activity for 121 days · offer The AI Office");
    expect(await vipGoneQuiet(at(10 * D))).toEqual({ contacts: 0, notified: 0 });
    // next quarter (January): Priya again, and the customer who has since been quiet 196 days too (no owner: Umer only)
    expect(await vipGoneQuiet(new Date("2027-01-05T09:30:00Z"))).toEqual({ contacts: 2, notified: 5 });
  });
});

describe("runAllAlerts", () => {
  it("runs every rule, is idempotent, and never raises new-lead or hot-lead alerts itself", async () => {
    const sales = await makeUser({ role: "sales" });
    await makeUser({ role: "manager" });
    const c = await contact({ ownerId: sales.id, ownerAssignedAt: at(-30 * H) });
    await checkout(c.id, at(-2 * H));
    const first = await runAllAlerts(NOW);
    expect(first.abandonedCheckouts.tasks).toBe(1);
    expect(first.untouchedLeads.ownerAlerts).toBe(1);
    const counts = async () => ({
      tasks: (await db.select().from(tasks)).length,
      notes: (await db.select().from(notifications)).length,
    });
    const before = await counts();
    await runAllAlerts(at(MIN));
    expect(await counts()).toEqual(before);
    expect(await db.select().from(notifications).where(and(eq(notifications.type, "new_lead")))).toHaveLength(0);
    expect(await notesOf("hot_lead")).toHaveLength(0);
  });
});
