/**
 * Review fixes of the alert engine: rules must not starve on a backlog bigger than one batch, lead release is
 * spread over several runs, and the weekly summary's numbers match the dashboard's definitions.
 */
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { contacts, enquiries, notifications, payments, purchases, tasks, type NewContact } from "@/db/schema";
import { buildWeeklySummary } from "@/lib/alerts/digest";
import { releaseStaleLeads as releaseRule, unverifiedPayments, untouchedLeads, vipGoneQuiet } from "@/lib/alerts/rules";
import { releaseStaleLeads } from "@/lib/contacts/assignment";
import { recordPurchase } from "@/lib/money/purchases";
import { makeUser, resetDb } from "../support/db";

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true, id: "test" })) }));

const NOW = new Date("2026-10-01T09:30:00Z");
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const at = (ms: number) => new Date(NOW.getTime() + ms);

let seq = 0;
function contactRow(over: Partial<NewContact> = {}): NewContact {
  seq += 1;
  return {
    phoneE164: `+9196450${String(10000 + seq).padStart(5, "0")}`,
    phoneCountry: "IN",
    name: `Contact ${seq}`,
    firstDoor: "youtube",
    ...over,
  };
}
async function insertContacts(rows: NewContact[]) {
  const out: (typeof contacts.$inferSelect)[] = [];
  for (let i = 0; i < rows.length; i += 500) out.push(...(await db.insert(contacts).values(rows.slice(i, i + 500)).returning()));
  return out;
}
let refN = 0;
const ref = () => `RV-${++refN}`;

beforeEach(async () => {
  await resetDb();
});

describe("untouchedLeads with a backlog bigger than one batch", () => {
  it("leads whose alerts are all out are skipped, so a new untouched lead still gets its alert", async () => {
    const owner = await makeUser({ role: "sales" });
    const manager = await makeUser({ role: "manager" });
    // 1000 leads (one full batch) untouched for 60 hours: both stages are due
    await insertContacts(
      Array.from({ length: 1000 }, (_, i) => contactRow({ ownerId: owner.id, ownerAssignedAt: at(-60 * H - i * MIN) })),
    );
    const first = await untouchedLeads(NOW);
    expect(first.ownerAlerts).toBe(1000);
    expect(first.managerAlerts).toBe(1000);

    const [fresh] = await insertContacts([contactRow({ name: "Fresh", ownerId: owner.id, ownerAssignedAt: at(-25 * H) })]);
    const second = await untouchedLeads(NOW);
    expect(second).toMatchObject({ ownerAlerts: 1, managerAlerts: 0 });
    const [task] = await db.select().from(tasks).where(eq(tasks.contactId, fresh.id));
    expect(task).toMatchObject({ type: "untouched_lead", userId: owner.id });

    // at 48 hours the manager stage of the fresh lead is still raised
    const third = await untouchedLeads(at(24 * H));
    expect(third.managerAlerts).toBe(1);
    const mgr = await db.select().from(notifications).where(eq(notifications.contactId, fresh.id));
    expect(mgr.map((n) => n.userId).sort()).toEqual([manager.id, owner.id].sort());
  }, 120_000);
});

describe("unverifiedPayments with a backlog bigger than one batch", () => {
  it("payments already alerted are skipped, so a newer one is still alerted", async () => {
    const manager = await makeUser({ role: "manager" });
    const [c] = await insertContacts([contactRow()]);
    const old = at(-10 * D);
    const pus = await db
      .insert(purchases)
      .values(
        Array.from({ length: 500 }, () => ({
          contactId: c.id,
          productName: "Workshop",
          family: "workshop",
          amount: 999,
          amountInr: 999,
          mode: "upi_qr" as const,
          status: "pending" as const,
          purchasedAt: old,
        })),
      )
      .returning({ id: purchases.id });
    await db.insert(payments).values(
      pus.map((p, i) => ({ purchaseId: p.id, contactId: c.id, amount: 999, amountInr: 999, mode: "upi_qr" as const, status: "unverified" as const, paidAt: new Date(old.getTime() + i * MIN), reference: ref() })),
    );
    expect(await unverifiedPayments(NOW)).toEqual({ payments: 500, notified: 500 });

    await recordPurchase(
      { contactId: c.id, productName: "Consulting", family: "consulting", amount: 2000, currency: "INR", mode: "bank_transfer", source: "manual", reference: ref(), paidNow: { amount: 2000, reference: ref(), paidAt: at(-3 * D) } },
      null,
    );
    expect(await unverifiedPayments(NOW)).toEqual({ payments: 1, notified: 1 });
    const notes = await db.select().from(notifications).where(eq(notifications.userId, manager.id));
    expect(notes).toHaveLength(501);
  }, 120_000);
});

describe("vipGoneQuiet", () => {
  it("a VIP already alerted this quarter is not picked up again", async () => {
    await makeUser({ role: "admin" });
    await insertContacts([contactRow({ grade: "A", purchaseCount: 2, ltvInr: 90000, lastActivityAt: at(-200 * D) })]);
    expect(await vipGoneQuiet(NOW)).toEqual({ contacts: 1, notified: 1 });
    expect(await vipGoneQuiet(at(D))).toEqual({ contacts: 0, notified: 0 });
    // next quarter: alerted again
    expect(await vipGoneQuiet(at(95 * D))).toEqual({ contacts: 1, notified: 1 });
  });
});

describe("lead release", () => {
  it("releases at most `limit` leads per run and continues on the next run; customers never expire", async () => {
    const owner = await makeUser({ role: "sales" });
    await makeUser({ role: "manager" });
    const leads = await insertContacts(
      Array.from({ length: 3 }, () => contactRow({ ownerId: owner.id, ownerAssignedAt: at(-10 * D) })),
    );
    const [customer] = await insertContacts([contactRow({ ownerId: owner.id, ownerAssignedAt: at(-10 * D), purchaseCount: 1 })]);
    const first = await releaseStaleLeads(NOW, db, { limit: 2 });
    expect(first).toHaveLength(2);
    const second = await releaseStaleLeads(NOW, db, { limit: 2 });
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second])).toEqual(new Set(leads.map((l) => l.id)));
    expect(await releaseStaleLeads(NOW, db, { limit: 2 })).toEqual([]);
    const [still] = await db.select().from(contacts).where(eq(contacts.id, customer.id));
    expect(still.ownerId).toBe(owner.id);
  });

  it("the cron rule releases in batches", async () => {
    const owner = await makeUser({ role: "sales" });
    await makeUser({ role: "manager" });
    const leads = await insertContacts(Array.from({ length: 2 }, () => contactRow({ ownerId: owner.id, ownerAssignedAt: at(-10 * D) })));
    expect(await releaseRule(NOW)).toEqual({ released: 2 });
    const rows = await db.select().from(contacts).where(inArray(contacts.id, leads.map((l) => l.id)));
    expect(rows.every((r) => r.ownerId === null)).toBe(true);
  });
});

describe("weekly summary matches the dashboard's definitions", () => {
  // Monday 12 Oct 2026, 09:00 IST: the week is Mon 5 Oct to Sun 11 Oct (IST)
  const MONDAY = new Date("2026-10-12T03:30:00Z");

  it("Beyond-Umer share leaves unrated customers out; abandoned checkouts include the recovered ones", async () => {
    const [beyond, circle, unrated] = await insertContacts([
      contactRow({ umerLevel: 1 }),
      contactRow({ umerLevel: 4 }),
      contactRow({ umerLevel: null }),
    ]);
    const tm = (contactId: string, amount: number) =>
      recordPurchase(
        { contactId, productName: "Workshop", family: "workshop", amount, currency: "INR", mode: "tagmango", source: "tagmango", reference: ref(), purchasedAt: new Date("2026-10-07T06:00:00Z") },
        null,
      );
    await tm(beyond.id, 3000);
    await tm(circle.id, 1000);
    await tm(unrated.id, 6000);
    await db.insert(enquiries).values([
      { contactId: beyond.id, channel: "tagmango_checkout", status: "abandoned", receivedAt: new Date("2026-10-06T05:00:00Z") },
      { contactId: circle.id, channel: "tagmango_checkout", status: "recovered", receivedAt: new Date("2026-10-06T05:00:00Z") },
      { contactId: unrated.id, channel: "tagmango_checkout", status: "handled", receivedAt: new Date("2026-10-06T05:00:00Z") },
    ]);

    const s = await buildWeeklySummary(MONDAY);
    expect(s.revenue.current).toBe(10000);
    expect(s.beyondUmer).toEqual({ share: 0.75, inr: 3000, unratedInr: 6000 });
    expect(s.checkouts).toEqual({ abandoned: 2, recovered: 1 });
  });
});
