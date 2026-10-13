import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, interactions, ownershipLog, tasks } from "@/db/schema";
import { createTask } from "@/lib/alerts/core";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactForbiddenError, ContactValidationError } from "@/lib/contacts/errors";
import { logInteraction } from "@/lib/contacts/interactions";
import { mergeContacts } from "@/lib/contacts/merge";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const inPhone = () => `98470${String(70000 + seq++).padStart(5, "0")}`;

async function lead(ownerId: string | null) {
  return (
    await captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId, skipAssignment: true, skipAlerts: true })
  ).contact;
}
async function contactRow(id: string) {
  return (await db.select().from(contacts).where(eq(contacts.id, id)))[0];
}

describe("logInteraction", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("support logs on any contact without changing the owner", async () => {
    const owner = await makeUser({ role: "sales" });
    const support = await makeUser({ role: "support" });
    const c = await lead(owner.id);
    const id = await logInteraction(c.id, { type: "support_issue", summary: "Cannot log in to TagMango", direction: "in" }, support);
    const [i] = await db.select().from(interactions).where(eq(interactions.id, id));
    expect(i).toMatchObject({ contactId: c.id, userId: support.id, type: "support_issue", direction: "in", summary: "Cannot log in to TagMango" });
    const row = await contactRow(c.id);
    expect(row.ownerId).toBe(owner.id);
    expect(row.lastInteractionAt?.getTime()).toBe(i.occurredAt.getTime());
    expect(row.lastActivityAt?.getTime()).toBe(i.occurredAt.getTime());
    expect(await db.select().from(ownershipLog).where(eq(ownershipLog.contactId, c.id))).toHaveLength(1);
  });

  it("sales log on their own contacts and the pool, never on a colleague's; logging never takes ownership", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const c = await lead(s1.id);
    await expect(logInteraction(c.id, { type: "call" }, s2)).rejects.toBeInstanceOf(ContactForbiddenError);
    const pool = await lead(null);
    await logInteraction(pool.id, { type: "call", outcome: "connected" }, s2);
    expect((await contactRow(pool.id)).ownerId).toBeNull();
  });

  it("validates type and outcome", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead(s.id);
    await expect(logInteraction(c.id, { type: "telegram" as "call" }, s)).rejects.toBeInstanceOf(ContactValidationError);
    await expect(logInteraction(c.id, { type: "call", outcome: "maybe" }, s)).rejects.toThrow(/outcome/);
    await expect(logInteraction(c.id, { type: "call", direction: "up" as "in" }, s)).rejects.toBeInstanceOf(ContactValidationError);
  });

  describe("follow-ups", () => {
    it("the owner's next follow-up becomes a task for them, with the reason", async () => {
      const s = await makeUser({ role: "sales" });
      const c = await lead(s.id);
      const due = new Date(Date.now() + 3 * 86_400_000);
      const id = await logInteraction(
        c.id,
        { type: "call", outcome: "interested", summary: "Wants the AI Office brochure, call after payday", nextFollowUpAt: due },
        s,
      );
      const [t] = await db.select().from(tasks).where(eq(tasks.type, "follow_up"));
      expect(t).toMatchObject({ contactId: c.id, userId: s.id, status: "open", createdById: s.id, dedupeKey: `follow_up:${id}` });
      expect(t.dueAt.getTime()).toBe(due.getTime());
      expect(t.reason).toBe("Follow-up you set after a call: Wants the AI Office brochure, call after payday");
      expect(t.payload).toEqual({ interactionId: id });
      const [i] = await db.select().from(interactions).where(eq(interactions.id, id));
      expect(i.nextFollowUpAt?.getTime()).toBe(due.getTime());
    });

    it("someone else's follow-up goes to the owner and says who set it", async () => {
      const s = await makeUser({ role: "sales" });
      const support = await makeUser({ role: "support", name: "Sam" });
      const c = await lead(s.id);
      await logInteraction(c.id, { type: "support_issue", outcome: "resolved", nextFollowUpAt: new Date() }, support);
      const [t] = await db.select().from(tasks).where(eq(tasks.type, "follow_up"));
      expect(t.userId).toBe(s.id);
      expect(t.reason).toBe("Follow-up set by Sam after a support issue: Resolved");
    });

    it("in the pool, a salesperson's follow-up is theirs; anyone else's goes to the pool", async () => {
      const s = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager", name: "Mona" });
      const c = await lead(null);
      await logInteraction(c.id, { type: "whatsapp", nextFollowUpAt: new Date() }, s);
      await logInteraction(c.id, { type: "meeting", nextFollowUpAt: new Date(Date.now() + 1000) }, m);
      const ts = await db.select().from(tasks).where(eq(tasks.type, "follow_up")).orderBy(tasks.dueAt);
      expect(ts.map((t) => t.userId)).toEqual([s.id, null]);
      expect(ts[1].reason).toBe("Follow-up set by Mona after a meeting");
    });

    it("completes the actor's open follow-up, new lead and untouched lead tasks before raising the next one", async () => {
      const s = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const c = await lead(s.id);
      const other = await lead(s.id);
      const f = await createTask({ contactId: c.id, userId: s.id, type: "follow_up", reason: "old follow-up" });
      const nl = await createTask({ contactId: c.id, userId: s.id, type: "new_lead", reason: "new lead" });
      const ut = await createTask({ contactId: c.id, userId: s.id, type: "untouched_lead", reason: "untouched" });
      const keepType = await createTask({ contactId: c.id, userId: s.id, type: "at_risk", reason: "at risk" });
      const keepUser = await createTask({ contactId: c.id, userId: m.id, type: "untouched_lead", reason: "escalation" });
      const keepContact = await createTask({ contactId: other.id, userId: s.id, type: "follow_up", reason: "other contact" });
      await logInteraction(c.id, { type: "call", outcome: "connected", nextFollowUpAt: new Date(Date.now() + 86_400_000) }, s);
      const byId = new Map((await db.select().from(tasks)).map((t) => [t.id, t]));
      for (const id of [f, nl, ut]) {
        expect(byId.get(id!)).toMatchObject({ status: "done", completedById: s.id });
      }
      for (const id of [keepType, keepUser, keepContact]) expect(byId.get(id!)?.status).toBe("open");
      const open = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.contactId, c.id), eq(tasks.type, "follow_up"), eq(tasks.status, "open")));
      expect(open).toHaveLength(1);
      expect(open[0].reason).toBe("Follow-up you set after a call: Connected");
    });
  });

  it("is idempotent on externalRef (webhooks), and works without a user", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead(s.id);
    const a = await logInteraction(c.id, { type: "whatsapp", direction: "in", summary: "Hi", externalRef: "libromi:msg:9", nextFollowUpAt: new Date() }, null);
    const b = await logInteraction(c.id, { type: "whatsapp", direction: "in", summary: "Hi again", externalRef: "libromi:msg:9", nextFollowUpAt: new Date() }, null);
    expect(b).toBe(a);
    expect(await db.select().from(interactions)).toHaveLength(1);
    const ts = await db.select().from(tasks).where(eq(tasks.type, "follow_up"));
    expect(ts).toHaveLength(1);
    expect(ts[0].userId).toBe(s.id);
    expect(ts[0].reason).toBe("Follow-up set by the system after a WhatsApp chat: Hi");
  });

  it("an id of a merged contact is logged on the surviving record", async () => {
    const m = await makeUser({ role: "manager" });
    const w = await lead(null);
    const l = await lead(null);
    await mergeContacts(w.id, l.id, m);
    const id = await logInteraction(l.id, { type: "note", summary: "late webhook" }, null);
    const [i] = await db.select().from(interactions).where(eq(interactions.id, id));
    expect(i.contactId).toBe(w.id);
  });

  it("last interaction never moves backwards", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead(s.id);
    const recent = new Date();
    await logInteraction(c.id, { type: "call", occurredAt: recent }, s);
    await logInteraction(c.id, { type: "note", occurredAt: new Date("2025-01-01T00:00:00Z") }, s);
    expect((await contactRow(c.id)).lastInteractionAt?.getTime()).toBe(recent.getTime());
  });
});
