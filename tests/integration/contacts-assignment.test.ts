import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { auditLog, contacts, notifications, ownershipLog, purchases, tasks, users } from "@/db/schema";
import { createTask } from "@/lib/alerts/core";
import {
  handoverAllContacts,
  ownershipHistory,
  pickAutoOwner,
  reassignContacts,
  releaseStaleLeads,
  requestTransfer,
  resolveTransferRequest,
  setOwner,
} from "@/lib/contacts/assignment";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactForbiddenError, ContactValidationError } from "@/lib/contacts/errors";
import { logInteraction } from "@/lib/contacts/interactions";
import { setManualStage } from "@/lib/contacts/lifecycle";
import { setSetting } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { DAY_MS } from "@/lib/utils";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const inPhone = () => `98470${String(30000 + seq++).padStart(5, "0")}`;
const aePhone = () => `0501${String(300000 + seq++).padStart(6, "0")}`;

async function count(table: PgTable, where?: SQL): Promise<number> {
  const q = db.select({ n: sql<number>`count(*)::int` }).from(table);
  const rows = where ? await q.where(where) : await q;
  return rows[0].n;
}

async function lead(over: Partial<Parameters<typeof captureEnquiry>[0]> = {}) {
  return (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true, ...over })).contact;
}

async function contactRow(id: string) {
  return (await db.select().from(contacts).where(eq(contacts.id, id)))[0];
}

describe("contacts assignment", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("auto-assignment (rule 1)", () => {
    it("GCC numbers go to the Dubai team, round robin, fairly across 4 leads", async () => {
      const d1 = await makeUser({ role: "sales", team: "dubai" });
      const d2 = await makeUser({ role: "sales", team: "dubai" });
      await makeUser({ role: "sales", team: "dubai", active: false });
      await makeUser({ role: "manager", team: "dubai" });
      await makeUser({ role: "support", team: "dubai" });
      const k1 = await makeUser({ role: "sales", team: "kerala" });

      const owners: (string | null)[] = [];
      for (let i = 0; i < 4; i++) {
        const c = await lead({ phone: aePhone(), defaultCountry: "AE", channel: "meta_lead_form" });
        expect(c.phoneCountry).toBe("AE");
        owners.push(c.ownerId);
      }
      expect(owners).toEqual([d1.id, d2.id, d1.id, d2.id]);
      const india = await lead();
      expect(india.ownerId).toBe(k1.id);
    });

    it("rotates even when several leads are assigned inside one transaction", async () => {
      const a = await makeUser({ role: "sales", team: "kerala" });
      const b = await makeUser({ role: "sales", team: "kerala" });
      const c = await makeUser({ role: "sales", team: "kerala" });
      const picks = await db.transaction(async (tx) => {
        const out: (string | null)[] = [];
        for (let i = 0; i < 6; i++) out.push(await pickAutoOwner("IN", tx));
        return out;
      });
      expect(picks).toEqual([a.id, b.id, c.id, a.id, b.id, c.id]);
    });

    it("parallel captures never drop a lead to the pool while salespeople exist", async () => {
      const d1 = await makeUser({ role: "sales", team: "dubai" });
      const d2 = await makeUser({ role: "sales", team: "dubai" });
      const leads = await Promise.all([1, 2, 3, 4].map(() => lead({ phone: aePhone(), defaultCountry: "AE" })));
      const owners = leads.map((c) => c.ownerId);
      expect(owners.every((o) => o === d1.id || o === d2.id)).toBe(true);
      expect(new Set(owners).size).toBe(2);
    });

    it("the least recently assigned salesperson gets the next lead", async () => {
      const a = await makeUser({ role: "sales", team: "kerala" });
      const b = await makeUser({ role: "sales", team: "kerala" });
      await db.update(users).set({ lastAssignedAt: new Date("2026-01-02") }).where(eq(users.id, a.id));
      await db.update(users).set({ lastAssignedAt: new Date("2026-01-01") }).where(eq(users.id, b.id));
      expect(await pickAutoOwner("IN")).toBe(b.id);
      const [stamped] = await db.select().from(users).where(eq(users.id, b.id));
      expect(stamped.lastAssignedAt!.getTime()).toBeGreaterThan(new Date("2026-01-02").getTime());
    });

    it("no active salesperson in the team -> the pool", async () => {
      await makeUser({ role: "sales", team: "kerala" });
      await makeUser({ role: "sales", team: "dubai", active: false });
      const c = await lead({ phone: aePhone(), defaultCountry: "AE" });
      expect(c.ownerId).toBeNull();
      expect(await pickAutoOwner("SA")).toBeNull();
    });

    it("auto-assign off -> the pool; team routing follows settings", async () => {
      const k = await makeUser({ role: "sales", team: "kerala" });
      const d = await makeUser({ role: "sales", team: "dubai" });
      await setSetting("assignment", { ...DEFAULT_SETTINGS.assignment, gccCountries: ["AE", "US"] }, null);
      expect(await pickAutoOwner("US")).toBe(d.id);
      expect(await pickAutoOwner("SA")).toBe(k.id);
      await setSetting("assignment", { ...DEFAULT_SETTINGS.assignment, autoAssign: false }, null);
      expect(await pickAutoOwner("AE")).toBeNull();
    });
  });

  describe("setOwner", () => {
    it("logs every change with a reason and keeps the first owner forever (rule 3)", async () => {
      const s1 = await makeUser({ role: "sales" });
      const s2 = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const c = await lead({ ownerId: s1.id });
      expect(c.firstOwnerId).toBe(s1.id);

      await reassignContacts([c.id], s2.id, m, "Speaks Arabic");
      let row = await contactRow(c.id);
      expect(row.ownerId).toBe(s2.id);
      expect(row.firstOwnerId).toBe(s1.id);

      await setOwner(c.id, null, { reason: "Back to pool", changedById: m.id });
      row = await contactRow(c.id);
      expect(row.ownerId).toBeNull();
      expect(row.ownerAssignedAt).toBeNull();
      expect(row.firstOwnerId).toBe(s1.id);

      await setOwner(c.id, m.id, { reason: "Manager takes it", changedById: m.id });
      expect((await contactRow(c.id)).firstOwnerId).toBe(s1.id);

      const history = await ownershipHistory(c.id);
      expect(history.map((h) => h.reason)).toEqual(["Manager takes it", "Back to pool", "Speaks Arabic", "Added by hand"]);
      expect(history[2]).toMatchObject({ fromUserId: s1.id, toUserId: s2.id, changedById: m.id, fromName: s1.name, toName: s2.name });
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.rowId, c.id), eq(auditLog.field, "owner_id")));
      expect(audits).toHaveLength(4);
      expect(audits.every((a) => a.action === "reassign")).toBe(true);
    });

    it("is a no-op when unchanged; rejects support, inactive owners and a missing reason", async () => {
      const s1 = await makeUser({ role: "sales" });
      const support = await makeUser({ role: "support" });
      const gone = await makeUser({ role: "sales", active: false });
      const c = await lead({ ownerId: s1.id });
      const r = await setOwner(c.id, s1.id, { reason: "same", changedById: null });
      expect(r.changed).toBe(false);
      expect(await count(ownershipLog)).toBe(1);
      await expect(setOwner(c.id, support.id, { reason: "x", changedById: null })).rejects.toThrow(/Support never owns/);
      await expect(setOwner(c.id, gone.id, { reason: "x", changedById: null })).rejects.toThrow(/not active/);
      await expect(setOwner(c.id, null, { reason: " ", changedById: null })).rejects.toBeInstanceOf(ContactValidationError);
      expect((await contactRow(c.id)).ownerId).toBe(s1.id);
    });

    it("moves the previous owner's open tasks for the contact, but not manager tasks or done tasks", async () => {
      const s1 = await makeUser({ role: "sales" });
      const s2 = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const c = await lead({ ownerId: s1.id });
      const open = await createTask({ contactId: c.id, userId: s1.id, type: "follow_up", reason: "call back" });
      const done = await createTask({ contactId: c.id, userId: s1.id, type: "follow_up", reason: "old" });
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, done!));
      const mgr = await createTask({ contactId: c.id, userId: m.id, type: "transfer_request", reason: "x" });
      await reassignContacts([c.id], s2.id, m, "Rebalance");
      const all = await db.select().from(tasks);
      expect(all.find((t) => t.id === open)?.userId).toBe(s2.id);
      expect(all.find((t) => t.id === done)?.userId).toBe(s1.id);
      expect(all.find((t) => t.id === mgr)?.userId).toBe(m.id);
    });
  });

  describe("reassign and handover (rules 5 and 8)", () => {
    it("only managers and admins reassign; the new owner is told", async () => {
      const s1 = await makeUser({ role: "sales" });
      const s2 = await makeUser({ role: "sales" });
      const support = await makeUser({ role: "support" });
      const admin = await makeUser({ role: "admin" });
      const a = await lead({ ownerId: s1.id });
      const b = await lead({ ownerId: s1.id });
      await expect(reassignContacts([a.id], s2.id, s2, "I want it")).rejects.toBeInstanceOf(ContactForbiddenError);
      await expect(reassignContacts([a.id], s2.id, support, "x")).rejects.toBeInstanceOf(ContactForbiddenError);
      await expect(reassignContacts([a.id], s2.id, admin, "")).rejects.toBeInstanceOf(ContactValidationError);
      await expect(reassignContacts([a.id], support.id, admin, "x")).rejects.toThrow(/Support never owns/);
      expect(await reassignContacts([a.id, b.id, a.id], s2.id, admin, "Rebalance")).toBe(2);
      expect(await reassignContacts([a.id], s2.id, admin, "Again")).toBe(0);
      const n = await db.select().from(notifications).where(eq(notifications.userId, s2.id));
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ type: "contacts_assigned", title: "2 contacts were assigned to you" });
    });

    it("moves every contact and open task of someone who leaves, in one action", async () => {
      const leaver = await makeUser({ role: "sales" });
      const other = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const mine = [await lead({ ownerId: leaver.id }), await lead({ ownerId: leaver.id }), await lead({ ownerId: leaver.id })];
      const notMine = await lead({ ownerId: other.id });
      const pool = await lead({ skipAssignment: true });
      const t1 = await createTask({ contactId: mine[0].id, userId: leaver.id, type: "follow_up", reason: "a" });
      const t2 = await createTask({ contactId: pool.id, userId: leaver.id, type: "follow_up", reason: "pool follow-up" });
      const t3 = await createTask({ contactId: mine[1].id, userId: leaver.id, type: "follow_up", reason: "done" });
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, t3!));

      await expect(handoverAllContacts(leaver.id, m.id, other)).rejects.toBeInstanceOf(ContactForbiddenError);
      await expect(handoverAllContacts(leaver.id, leaver.id, m)).rejects.toBeInstanceOf(ContactValidationError);
      expect(await handoverAllContacts(leaver.id, m.id, m)).toBe(3);

      for (const c of mine) {
        const row = await contactRow(c.id);
        expect(row.ownerId).toBe(m.id);
        expect(row.firstOwnerId).toBe(leaver.id);
      }
      expect((await contactRow(notMine.id)).ownerId).toBe(other.id);
      const logs = await db.select().from(ownershipLog).where(eq(ownershipLog.reason, "Owner left the team"));
      expect(logs).toHaveLength(3);
      const all = await db.select().from(tasks);
      expect(all.find((t) => t.id === t1)?.userId).toBe(m.id);
      expect(all.find((t) => t.id === t2)?.userId).toBe(m.id);
      expect(all.find((t) => t.id === t3)?.userId).toBe(leaver.id);
      expect(await count(tasks, and(eq(tasks.userId, leaver.id), eq(tasks.status, "open")))).toBe(0);
    });
  });

  describe("release stale leads (rule 4)", () => {
    it("returns an open lead with no owner interaction for 7 days to the pool and alerts managers", async () => {
      const s = await makeUser({ role: "sales", name: "Nikhil" });
      const m1 = await makeUser({ role: "manager" });
      const m2 = await makeUser({ role: "manager" });
      const c = await lead({ ownerId: s.id, name: "Stale Lead" });
      const now = new Date(Date.now() + 7 * DAY_MS + 60_000);

      const released = await releaseStaleLeads(now);
      expect(released).toEqual([c.id]);
      const row = await contactRow(c.id);
      expect(row.ownerId).toBeNull();
      expect(row.firstOwnerId).toBe(s.id);
      const log = await db.select().from(ownershipLog).where(eq(ownershipLog.contactId, c.id));
      expect(log.map((l) => l.reason)).toContain("No interaction for 7 days");
      const released_ = await db.select().from(tasks).where(eq(tasks.type, "lead_released"));
      expect(released_.map((t) => t.userId).sort()).toEqual([m1.id, m2.id].sort());
      expect(released_[0].reason).toBe("Back in the pool: Nikhil logged no interaction for 7 days");
      const n = await db.select().from(notifications).where(eq(notifications.type, "lead_released"));
      expect(n.map((x) => x.userId).sort()).toEqual([m1.id, m2.id].sort());
      expect(n[0].title).toBe("Stale Lead returned to the pool");

      // running again changes nothing
      expect(await releaseStaleLeads(new Date(now.getTime() + DAY_MS))).toEqual([]);
      expect(await count(tasks, eq(tasks.type, "lead_released"))).toBe(2);
    });

    it("keeps leads with a recent owner interaction, younger leads, customers and Lost contacts", async () => {
      const s = await makeUser({ role: "sales" });
      const support = await makeUser({ role: "support" });
      await makeUser({ role: "manager" });
      const now = new Date(Date.now() + 10 * DAY_MS);

      const touched = await lead({ ownerId: s.id });
      await logInteraction(touched.id, { type: "call", occurredAt: new Date(now.getTime() - 2 * DAY_MS) }, s);
      const touchedLongAgo = await lead({ ownerId: s.id });
      await logInteraction(touchedLongAgo.id, { type: "call", occurredAt: new Date(now.getTime() - 8 * DAY_MS) }, s);
      const supportOnly = await lead({ ownerId: s.id });
      await logInteraction(supportOnly.id, { type: "support_issue", occurredAt: new Date(now.getTime() - DAY_MS) }, support);
      const young = await lead({ ownerId: s.id });
      await db.update(contacts).set({ ownerAssignedAt: new Date(now.getTime() - 6 * DAY_MS) }).where(eq(contacts.id, young.id));
      const customer = await lead({ ownerId: s.id });
      await db.update(contacts).set({ purchaseCount: 1 }).where(eq(contacts.id, customer.id));
      const paying = await lead({ ownerId: s.id });
      await db.insert(purchases).values({
        contactId: paying.id,
        productName: "Workshop",
        family: "workshop",
        amount: 999,
        amountInr: 999,
        mode: "bank_transfer",
        status: "pending",
      });
      const lost = await lead({ ownerId: s.id });
      await setManualStage(lost.id, "lost", { lostReason: "price" }, s);

      const released = await releaseStaleLeads(now);
      expect(released.sort()).toEqual([touchedLongAgo.id, supportOnly.id].sort());
      for (const keep of [touched, young, customer, paying, lost]) expect((await contactRow(keep.id)).ownerId).toBe(s.id);
    });

    it("never releases Dormant contacts (old imported leads go Dormant on recompute)", async () => {
      const s = await makeUser({ role: "sales" });
      await makeUser({ role: "manager" });
      const now = new Date(Date.now() + 10 * DAY_MS);
      const dormant = await lead({ ownerId: s.id });
      await db.update(contacts).set({ stage: "dormant" }).where(eq(contacts.id, dormant.id));
      const open = await lead({ ownerId: s.id });

      expect(await releaseStaleLeads(now)).toEqual([open.id]);
      expect((await contactRow(dormant.id)).ownerId).toBe(s.id);
      expect(await count(tasks, and(eq(tasks.type, "lead_released"), eq(tasks.contactId, dormant.id)))).toBe(0);
    });

    it("uses the configured number of days", async () => {
      const s = await makeUser({ role: "sales" });
      await makeUser({ role: "admin" });
      const c = await lead({ ownerId: s.id });
      await setSetting("thresholds", { ...DEFAULT_SETTINGS.thresholds, leadReleaseDays: 3 }, null);
      expect(await releaseStaleLeads(new Date(Date.now() + 2 * DAY_MS))).toEqual([]);
      expect(await releaseStaleLeads(new Date(Date.now() + 3 * DAY_MS + 60_000))).toEqual([c.id]);
      const log = await db.select().from(ownershipLog).where(and(eq(ownershipLog.contactId, c.id), eq(ownershipLog.reason, "No interaction for 3 days")));
      expect(log).toHaveLength(1);
      // no manager exists: the admin is told
      expect(await count(notifications, eq(notifications.type, "lead_released"))).toBe(1);
    });

    it("a lead re-assigned after release gets a fresh window and a fresh alert", async () => {
      const s = await makeUser({ role: "sales" });
      const s2 = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const c = await lead({ ownerId: s.id });
      const t1 = new Date(Date.now() + 8 * DAY_MS);
      expect(await releaseStaleLeads(t1)).toEqual([c.id]);
      await setOwner(c.id, s2.id, { reason: "Picked from pool", changedById: m.id, now: t1 });
      expect(await releaseStaleLeads(new Date(t1.getTime() + 3 * DAY_MS))).toEqual([]);
      expect(await releaseStaleLeads(new Date(t1.getTime() + 8 * DAY_MS))).toEqual([c.id]);
      expect(await count(tasks, eq(tasks.type, "lead_released"))).toBe(2);
    });
  });

  describe("transfer requests (rule 5)", () => {
    it("a salesperson asks, every manager gets one task, repeats do not spam", async () => {
      const owner = await makeUser({ role: "sales", name: "Owner" });
      const asker = await makeUser({ role: "sales", name: "Asker" });
      const m1 = await makeUser({ role: "manager" });
      const m2 = await makeUser({ role: "manager" });
      const c = await lead({ ownerId: owner.id, name: "Wanted" });

      const r = await requestTransfer(c.id, asker, "Already talking to him on WhatsApp");
      expect(r.created).toBe(true);
      expect(r.taskIds).toHaveLength(2);
      const ts = await db.select().from(tasks).where(eq(tasks.type, "transfer_request"));
      expect(ts.map((t) => t.userId).sort()).toEqual([m1.id, m2.id].sort());
      expect(ts[0].payload).toMatchObject({ contactId: c.id, requestedBy: asker.id, toUserId: asker.id, fromUserId: owner.id });
      expect(ts[0].reason).toBe("Asker asks for Wanted (owned by Owner): Already talking to him on WhatsApp");
      expect(await count(notifications, eq(notifications.type, "transfer_request"))).toBe(2);
      expect((await contactRow(c.id)).ownerId).toBe(owner.id);

      const again = await requestTransfer(c.id, asker, "Please!");
      expect(again.created).toBe(false);
      expect(await count(tasks, eq(tasks.type, "transfer_request"))).toBe(2);
      expect(await count(notifications, eq(notifications.type, "transfer_request"))).toBe(2);
    });

    it("managers and support cannot request; reasons are required; no request for what you already own", async () => {
      const s = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const support = await makeUser({ role: "support" });
      const c = await lead({ ownerId: s.id });
      await expect(requestTransfer(c.id, m, "x")).rejects.toThrow(/Managers reassign directly/);
      await expect(requestTransfer(c.id, support, "x")).rejects.toBeInstanceOf(ContactForbiddenError);
      await expect(requestTransfer(c.id, s, "  ")).rejects.toBeInstanceOf(ContactValidationError);
      await expect(requestTransfer(c.id, s, "mine")).rejects.toThrow(/already belongs/);
    });

    it("an owner can ask to hand a contact to a colleague; nobody else can", async () => {
      const s1 = await makeUser({ role: "sales" });
      const s2 = await makeUser({ role: "sales" });
      const s3 = await makeUser({ role: "sales" });
      await makeUser({ role: "manager" });
      const c = await lead({ ownerId: s1.id });
      await expect(requestTransfer(c.id, s3, "give it to s2", s2.id)).rejects.toBeInstanceOf(ContactForbiddenError);
      const r = await requestTransfer(c.id, s1, "Speaks Tamil", s2.id);
      expect(r.created).toBe(true);
    });

    it("approving moves the contact, closes every manager's copy and tells the requester", async () => {
      const owner = await makeUser({ role: "sales" });
      const asker = await makeUser({ role: "sales" });
      const m1 = await makeUser({ role: "manager" });
      await makeUser({ role: "manager" });
      const c = await lead({ ownerId: owner.id });
      const { taskIds } = await requestTransfer(c.id, asker, "Met at the event");
      await expect(resolveTransferRequest(taskIds[0], "approve", asker)).rejects.toBeInstanceOf(ContactForbiddenError);
      const r = await resolveTransferRequest(taskIds[0], "approve", m1);
      expect(r.moved).toBe(true);
      const row = await contactRow(c.id);
      expect(row.ownerId).toBe(asker.id);
      expect(row.firstOwnerId).toBe(owner.id);
      expect(await count(tasks, and(eq(tasks.type, "transfer_request"), eq(tasks.status, "open")))).toBe(0);
      const n = await db.select().from(notifications).where(eq(notifications.userId, asker.id));
      expect(n.map((x) => x.title)).toContain(`Transfer approved: ${c.name}`);
      await expect(resolveTransferRequest(taskIds[1], "decline", m1)).rejects.toThrow(/already answered/);
    });

    it("declining keeps the owner; a new request can be made later", async () => {
      const owner = await makeUser({ role: "sales" });
      const asker = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const c = await lead({ ownerId: owner.id });
      const first = await requestTransfer(c.id, asker, "first");
      await resolveTransferRequest(first.taskIds[0], "decline", m);
      expect((await contactRow(c.id)).ownerId).toBe(owner.id);
      const second = await requestTransfer(c.id, asker, "second");
      expect(second.created).toBe(true);
      expect(await count(tasks, and(eq(tasks.type, "transfer_request"), eq(tasks.status, "open")))).toBe(1);
    });
  });
});
