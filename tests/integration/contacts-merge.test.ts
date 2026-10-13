import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  auditLog,
  contactMerges,
  contacts,
  duplicateReviews,
  enquiries,
  interactions,
  notifications,
  ownershipLog,
  payments,
  purchases,
  ratings,
  tasks,
  type Contact,
} from "@/db/schema";
import { createTask, notify } from "@/lib/alerts/core";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactForbiddenError, ContactMergedError, ContactValidationError } from "@/lib/contacts/errors";
import { findContactByPhone } from "@/lib/contacts/identity";
import { logInteraction } from "@/lib/contacts/interactions";
import { dismissDuplicateReview, listOpenDuplicateReviews, mergeContacts, mergeHistory, undoMerge } from "@/lib/contacts/merge";
import { applyRating, updateContactProfile } from "@/lib/contacts/profile";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const inPhone = () => `98470${String(40000 + seq++).padStart(5, "0")}`;

async function count(table: PgTable, where?: SQL): Promise<number> {
  const q = db.select({ n: sql<number>`count(*)::int` }).from(table);
  const rows = where ? await q.where(where) : await q;
  return rows[0].n;
}

async function contactRow(id: string): Promise<Contact> {
  return (await db.select().from(contacts).where(eq(contacts.id, id)))[0];
}

const CHILD = { enquiries, interactions, ratings, tasks, notifications, ownershipLog, purchases, payments } as const;

async function childCounts(contactId: string) {
  const out: Record<string, number> = {};
  for (const [name, table] of Object.entries(CHILD)) {
    out[name] = await count(table, eq(table.contactId, contactId));
  }
  return out;
}

/** Two records of one person, each with a full set of child rows. */
async function setup() {
  const s1 = await makeUser({ role: "sales", name: "First Owner" });
  const s2 = await makeUser({ role: "sales", name: "Second Owner" });
  const manager = await makeUser({ role: "manager" });
  const older = (
    await captureEnquiry({
      phone: inPhone(),
      name: "Lakshmi Nair",
      email: "lakshmi@example.com",
      channel: "walk_in_event",
      firstDoor: "mla_program",
      campaign: "koduvally_ai_literacy",
      ownerId: s1.id,
      profile: { city: "Kozhikode", language: "ml" },
      tags: ["VIP"],
      receivedAt: new Date("2025-01-10T10:00:00Z"),
      skipAlerts: true,
    })
  ).contact;
  const newer = (
    await captureEnquiry({
      phone: inPhone(),
      name: "Lakshmi N",
      email: "lakshmi.n@example.com",
      channel: "meta_lead_form",
      campaign: "claude_mastery_meta",
      ownerId: s2.id,
      profile: { state: "Kerala" },
      tags: ["B2B"],
      skipAlerts: true,
    })
  ).contact;
  // child rows on the older record (it will be merged INTO the newer one)
  await logInteraction(older.id, { type: "call", summary: "Interested in AAM", nextFollowUpAt: new Date(Date.now() + 86_400_000) }, s1);
  await applyRating(older.id, { aiLevel: 3, gutStars: 4 }, "sales", s1.id);
  await notify({ userId: s1.id, type: "test", title: "hello", contactId: older.id });
  const [p] = await db
    .insert(purchases)
    .values({ contactId: older.id, productName: "Workshop", family: "workshop", amount: 999, amountInr: 999, mode: "tagmango", status: "paid", reference: "TM-1" })
    .returning();
  await db.insert(payments).values({ purchaseId: p.id, contactId: older.id, amount: 999, amountInr: 999, status: "verified", reference: "TM-1-pay" });
  // someone the older record referred
  const referred = (await captureEnquiry({ phone: inPhone(), channel: "tagmango_checkout", referrer: { contactId: older.id }, skipAlerts: true })).contact;
  // flagged as possible duplicates
  const [a, b] = [older.id, newer.id].sort();
  await db.insert(duplicateReviews).values({ contactAId: a, contactBId: b, reason: "Same person?" });
  return { s1, s2, manager, older: await contactRow(older.id), newer: await contactRow(newer.id), referred };
}

describe("merge contacts", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("keeps the oldest first door, the first owner, every child row; nothing is deleted", async () => {
    const { s1, s2, manager, older, newer, referred } = await setup();
    const loserCounts = await childCounts(older.id);
    const winnerCounts = await childCounts(newer.id);
    expect(loserCounts.purchases).toBe(1);
    expect(loserCounts.interactions).toBe(1);

    const mergeId = await mergeContacts(newer.id, older.id, manager, "Same person, two numbers");

    const w = await contactRow(newer.id);
    const l = await contactRow(older.id);
    // the older record's labels survive on the winner
    expect(w.firstDoor).toBe("mla_program");
    expect(w.firstCampaign).toBe("koduvally_ai_literacy");
    expect(w.firstChannel).toBe("walk_in_event");
    expect(w.firstOwnerId).toBe(s1.id);
    expect(w.createdAt.getTime()).toBe(older.createdAt.getTime());
    // the winner keeps its owner, phone and email; the loser's become alternates
    expect(w.ownerId).toBe(s2.id);
    expect(w.phoneE164).toBe(newer.phoneE164);
    expect(w.altPhones).toEqual([older.phoneE164]);
    expect(w.email).toBe("lakshmi.n@example.com");
    expect(w.altEmails).toEqual(["lakshmi@example.com"]);
    // empty profile fields filled from the loser, filled ones kept
    expect(w.name).toBe("Lakshmi N");
    expect(w.city).toBe("Kozhikode");
    expect(w.language).toBe("ml");
    expect(w.state).toBe("Kerala");
    expect(w.aiLevel).toBe(3);
    expect(w.gutStars).toBe(4);
    expect(w.fieldSources).toMatchObject({ ai_level: "sales", gut_stars: "sales" });
    expect(w.tags).toEqual(["B2B", "VIP"]);
    // every child row moved
    const after = await childCounts(newer.id);
    for (const k of Object.keys(CHILD)) expect(after[k]).toBe(winnerCounts[k] + loserCounts[k]);
    expect(Object.values(await childCounts(older.id)).every((n) => n === 0)).toBe(true);
    expect((await contactRow(referred.id)).referredById).toBe(newer.id);
    // the loser row is kept, marked merged
    expect(l.mergedIntoId).toBe(newer.id);
    expect(l.mergedAt).toBeInstanceOf(Date);
    expect(await findContactByPhone(older.phoneE164)).toMatchObject({ id: newer.id });
    // logged, with the exact rows moved
    const [m] = await db.select().from(contactMerges).where(eq(contactMerges.id, mergeId));
    expect(m).toMatchObject({ winnerId: newer.id, loserId: older.id, reason: "Same person, two numbers", mergedById: manager.id });
    expect(m.moved.purchases).toHaveLength(1);
    expect(m.moved["contacts.referred_by_id"]).toEqual([referred.id]);
    expect(m.winnerBefore.firstDoor).toBe("meta_ad");
    expect(await count(auditLog, and(eq(auditLog.rowId, newer.id), eq(auditLog.action, "merge")))).toBe(1);
    // the duplicate review for the pair is closed
    const [review] = await db.select().from(duplicateReviews);
    expect(review).toMatchObject({ status: "merged", resolvedById: manager.id });
    expect(await mergeHistory(older.id)).toHaveLength(1);
  });

  it("undo restores exactly: row counts, the winner's values, the loser, the review", async () => {
    const { manager, older, newer, referred } = await setup();
    const loserCounts = await childCounts(older.id);
    const winnerCounts = await childCounts(newer.id);
    const mergeId = await mergeContacts(newer.id, older.id, manager);
    await undoMerge(mergeId, manager);

    expect(await childCounts(older.id)).toEqual(loserCounts);
    expect(await childCounts(newer.id)).toEqual(winnerCounts);
    const w = await contactRow(newer.id);
    const l = await contactRow(older.id);
    // updatedAt, and the time stamps recompute writes (scoredAt; stageChangedAt, since the merge moved the
    // winner through a purchase stage and the undo moved it back), are not restorable values
    const strip = (c: Contact) => {
      const { updatedAt: _u, scoredAt: _s, stageChangedAt: _sc, ...rest } = c;
      void _u;
      void _s;
      void _sc;
      return rest;
    };
    expect(strip(w)).toEqual(strip(newer));
    expect(w.stage).toBe(newer.stage);
    expect(strip(l)).toEqual(strip(older));
    expect(l.mergedIntoId).toBeNull();
    expect((await contactRow(referred.id)).referredById).toBe(older.id);
    expect((await findContactByPhone(older.phoneE164))?.id).toBe(older.id);
    const [review] = await db.select().from(duplicateReviews);
    expect(review).toMatchObject({ status: "open", resolvedById: null, resolvedAt: null });
    const [m] = await db.select().from(contactMerges).where(eq(contactMerges.id, mergeId));
    expect(m.undoneAt).toBeInstanceOf(Date);
    expect(m.undoneById).toBe(manager.id);
    expect(await count(auditLog, and(eq(auditLog.rowId, newer.id), eq(auditLog.action, "unmerge")))).toBe(1);
    await expect(undoMerge(mergeId, manager)).rejects.toThrow(/already undone/);
  });

  it("undo keeps edits made after the merge and removes only what the merge added", async () => {
    const { manager, older, newer } = await setup();
    const mergeId = await mergeContacts(newer.id, older.id, manager);
    const extra = inPhone();
    await updateContactProfile(newer.id, { city: "Kochi", altPhones: { add: [extra] } }, manager);
    await undoMerge(mergeId, manager);
    const w = await contactRow(newer.id);
    expect(w.city).toBe("Kochi");
    expect(w.altPhones).toEqual([`+91${extra}`]);
    expect(w.firstDoor).toBe("meta_ad");
  });

  it("a winner in the pool takes the loser's owner, and gives it back on undo", async () => {
    const s = await makeUser({ role: "sales" });
    const m = await makeUser({ role: "manager" });
    const winner = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAssignment: true, skipAlerts: true })).contact;
    const loser = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId: s.id, skipAlerts: true })).contact;
    const id = await mergeContacts(winner.id, loser.id, m);
    let w = await contactRow(winner.id);
    expect(w.ownerId).toBe(s.id);
    expect(w.firstOwnerId).toBe(s.id);
    await undoMerge(id, m);
    w = await contactRow(winner.id);
    expect(w.ownerId).toBeNull();
    expect(w.firstOwnerId).toBeNull();
    expect(w.ownerAssignedAt).toBeNull();
    expect((await contactRow(loser.id)).ownerId).toBe(s.id);
  });

  it("refuses self merges, merged rows and non-managers", async () => {
    const s = await makeUser({ role: "sales" });
    const m = await makeUser({ role: "manager" });
    const a = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
    const b = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
    const c = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
    await expect(mergeContacts(a.id, a.id, m)).rejects.toBeInstanceOf(ContactValidationError);
    await expect(mergeContacts(a.id, b.id, s)).rejects.toBeInstanceOf(ContactForbiddenError);
    const id = await mergeContacts(a.id, b.id, m);
    await expect(mergeContacts(b.id, c.id, m)).rejects.toBeInstanceOf(ContactMergedError);
    await expect(mergeContacts(c.id, b.id, m)).rejects.toBeInstanceOf(ContactMergedError);
    await expect(undoMerge(id, s)).rejects.toBeInstanceOf(ContactForbiddenError);
  });

  it("a later merge into the same winner must be undone first", async () => {
    const m = await makeUser({ role: "admin" });
    const a = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
    const b = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
    const c = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
    const first = await mergeContacts(a.id, b.id, m);
    const second = await mergeContacts(a.id, c.id, m);
    await expect(undoMerge(first, m)).rejects.toThrow(/later merge/);
    await undoMerge(second, m);
    await undoMerge(first, m);
    expect((await contactRow(a.id)).altPhones).toEqual([]);
    expect((await contactRow(b.id)).mergedIntoId).toBeNull();
    expect((await contactRow(c.id)).mergedIntoId).toBeNull();
  });

  it("the winner never ends up referring itself", async () => {
    const m = await makeUser({ role: "manager" });
    const loser = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
    const winner = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", referrer: { contactId: loser.id }, skipAlerts: true })).contact;
    const top = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
    await db.update(contacts).set({ referredById: top.id }).where(eq(contacts.id, loser.id));
    const id = await mergeContacts(winner.id, loser.id, m);
    expect((await contactRow(winner.id)).referredById).toBe(top.id);
    await undoMerge(id, m);
    expect((await contactRow(winner.id)).referredById).toBe(loser.id);
  });

  it("re-points tasks and payments to the winner (payments follow their purchase)", async () => {
    const { manager, older, newer } = await setup();
    const t = await createTask({ contactId: older.id, userId: null, type: "abandoned_checkout", reason: "x" });
    await mergeContacts(newer.id, older.id, manager);
    expect((await db.select().from(tasks).where(eq(tasks.id, t!)))[0].contactId).toBe(newer.id);
    const pays = await db.select().from(payments);
    expect(pays.every((p) => p.contactId === newer.id)).toBe(true);
  });

  describe("duplicate reviews", () => {
    it("lists open reviews with both contacts, hides merged ones, and can be dismissed", async () => {
      const s = await makeUser({ role: "sales", name: "Owner A" });
      const m = await makeUser({ role: "manager" });
      const a = await captureEnquiry({ phone: inPhone(), name: "Same Name", channel: "phone_call", ownerId: s.id, profile: { city: "Kochi" }, skipAlerts: true });
      await captureEnquiry({ phone: inPhone(), name: "Same Name", channel: "phone_call", profile: { city: "Kochi" }, skipAssignment: true, skipAlerts: true });
      await captureEnquiry({ phone: inPhone(), name: "Other Pair", channel: "phone_call", profile: { city: "Kollam" }, skipAlerts: true });
      const d = await captureEnquiry({ phone: inPhone(), name: "Other Pair", channel: "phone_call", profile: { city: "Kollam" }, skipAlerts: true });

      const list = await listOpenDuplicateReviews();
      expect(list).toHaveLength(2);
      const ab = list.find((r) => [r.a.id, r.b.id].includes(a.contact.id))!;
      const sideA = ab.a.id === a.contact.id ? ab.a : ab.b;
      expect(sideA).toMatchObject({ name: "Same Name", city: "Kochi", ownerId: s.id, ownerName: "Owner A", phoneE164: a.contact.phoneE164 });
      expect(ab.reason).toBe("Same name in the same city");

      await expect(dismissDuplicateReview(ab.id, s)).rejects.toBeInstanceOf(ContactForbiddenError);
      await dismissDuplicateReview(ab.id, m);
      await expect(dismissDuplicateReview(ab.id, m)).rejects.toThrow(/already resolved/);
      expect((await listOpenDuplicateReviews()).map((r) => r.id)).not.toContain(ab.id);

      // a pair whose side was merged elsewhere is hidden
      const e = await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true });
      await mergeContacts(e.contact.id, d.contact.id, m);
      expect(await listOpenDuplicateReviews()).toHaveLength(0);
    });
  });

  it("the loser's ownership history moves to the winner", async () => {
    const { manager, older, newer, s1 } = await setup();
    await mergeContacts(newer.id, older.id, manager);
    const log = await db.select().from(ownershipLog).where(eq(ownershipLog.contactId, newer.id));
    expect(log.some((l) => l.toUserId === s1.id)).toBe(true);
  });
});
