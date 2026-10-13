/**
 * Adversarial review of the contacts module: each test pins a defect that was found and fixed
 * (or a spec rule that had no test yet). See the describe titles.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { auditLog, contacts, duplicateReviews, enquiries, organisations, ownershipLog } from "@/db/schema";
import { handoverAllContacts, pickAutoOwner } from "@/lib/contacts/assignment";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactNotFoundError, ContactValidationError } from "@/lib/contacts/errors";
import { logInteraction } from "@/lib/contacts/interactions";
import { reopenContact, setManualStage } from "@/lib/contacts/lifecycle";
import { mergeContacts, undoMerge } from "@/lib/contacts/merge";
import { updateContactProfile } from "@/lib/contacts/profile";
import { DAY_MS } from "@/lib/utils";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const inPhone = () => `98471${String(10000 + seq++).padStart(5, "0")}`;

async function count(table: PgTable, where?: SQL): Promise<number> {
  const q = db.select({ n: sql<number>`count(*)::int` }).from(table);
  const rows = where ? await q.where(where) : await q;
  return rows[0].n;
}

async function contactRow(id: string) {
  return (await db.select().from(contacts).where(eq(contacts.id, id)))[0];
}

describe("contacts module review", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("capture never loses an enquiry over a bad reference from outside", () => {
    it("drops an organisation id that does not exist (or is not an id) instead of failing", async () => {
      await makeUser({ role: "sales" });
      const missing = "00000000-0000-4000-8000-000000000000";
      const r = await captureEnquiry({ phone: inPhone(), channel: "website_form", profile: { organisationId: missing }, skipAlerts: true });
      expect(r.created).toBe(true);
      expect(r.contact.organisationId).toBeNull();
      const r2 = await captureEnquiry({ phone: inPhone(), channel: "website_form", profile: { organisationId: "school-42" }, skipAlerts: true });
      expect(r2.contact.organisationId).toBeNull();
      // a real organisation is kept, and fills an empty one on a returning contact
      const [org] = await db.insert(organisations).values({ name: "GHSS Koduvally", kind: "school" }).returning();
      const again = await captureEnquiry({ phone: r.contact.phoneE164, channel: "website_form", profile: { organisationId: org.id }, skipAlerts: true });
      expect(again.contact.organisationId).toBe(org.id);
      expect(await count(enquiries)).toBe(3);
    });

    it("a referrer contact id that is not an id falls back to the referrer's phone", async () => {
      await makeUser({ role: "sales" });
      const ref = (await captureEnquiry({ phone: inPhone(), name: "Affiliate", channel: "phone_call", skipAlerts: true })).contact;
      const r = await captureEnquiry({
        phone: inPhone(),
        channel: "tagmango_checkout",
        referrer: { contactId: "affiliate-77", phone: ref.phoneE164 },
        skipAlerts: true,
      });
      expect(r.contact.referredById).toBe(ref.id);
    });
  });

  describe("labels are stored as settings keys", () => {
    it("a first door, channel or campaign given by its label is stored as its key", async () => {
      await makeUser({ role: "sales" });
      const r = await captureEnquiry({
        phone: inPhone(),
        channel: "Walk-in or event",
        firstDoor: "Delegation",
        campaign: "Koduvally AI Literacy Mission",
        skipAlerts: true,
      });
      expect(r.contact.firstDoor).toBe("delegation");
      expect(r.contact.firstChannel).toBe("walk_in_event");
      expect(r.contact.firstCampaign).toBe("koduvally_ai_literacy");
      const [e] = await db.select().from(enquiries).where(eq(enquiries.id, r.enquiryId!));
      expect(e).toMatchObject({ channel: "walk_in_event", campaign: "koduvally_ai_literacy" });
    });

    it("an unknown first door is refused (it is stored forever), and nothing is written", async () => {
      await makeUser({ role: "sales" });
      await expect(
        captureEnquiry({ phone: inPhone(), channel: "phone_call", firstDoor: "Instagrm", skipAlerts: true }),
      ).rejects.toBeInstanceOf(ContactValidationError);
      expect(await count(contacts)).toBe(0);
      expect(await count(enquiries)).toBe(0);
    });

    it("an unknown campaign from outside is kept as given (campaigns are per enquiry)", async () => {
      await makeUser({ role: "sales" });
      const r = await captureEnquiry({ phone: inPhone(), channel: "import", campaign: "Old Zoho Drive 2024", skipAlerts: true });
      expect(r.contact.firstCampaign).toBe("Old Zoho Drive 2024");
    });
  });

  describe("a country guessed from the phone number is not real data", () => {
    it("a real country arriving later replaces the guess; after that it is never overwritten", async () => {
      await makeUser({ role: "sales" });
      const c = (await captureEnquiry({ phone: inPhone(), channel: "whatsapp_api", skipAlerts: true })).contact;
      expect(c.country).toBe("IN");
      // TagMango says this Indian number lives in Dubai
      const r = await captureEnquiry({ phone: c.phoneE164, channel: "tagmango_checkout", profile: { country: "AE" }, skipAlerts: true });
      expect(r.contact.country).toBe("AE");
      expect(r.contact.fieldSources.country).toBeUndefined();
      expect(r.changes.country).toEqual({ before: "IN", after: "AE" });
      const again = await captureEnquiry({ phone: c.phoneE164, channel: "website_form", profile: { country: "IN" }, skipAlerts: true });
      expect(again.contact.country).toBe("AE");
    });

    it("a country given with the first touch, or chosen by a person, is never replaced", async () => {
      const s = await makeUser({ role: "sales" });
      const given = (await captureEnquiry({ phone: inPhone(), channel: "website_form", profile: { country: "QA" }, ownerId: s.id, skipAlerts: true })).contact;
      expect(given.fieldSources.country).toBeUndefined();
      expect((await captureEnquiry({ phone: given.phoneE164, channel: "website_form", profile: { country: "AE" }, skipAlerts: true })).contact.country).toBe("QA");
      const guessed = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId: s.id, skipAlerts: true })).contact;
      const edited = await updateContactProfile(guessed.id, { country: "IN" }, s);
      expect(edited.fieldSources.country).toBeUndefined();
      expect((await captureEnquiry({ phone: guessed.phoneE164, channel: "website_form", profile: { country: "AE" }, skipAlerts: true })).contact.country).toBe("IN");
    });

    it("a merge prefers the loser's real country over the winner's guess, and undo restores the guess", async () => {
      const m = await makeUser({ role: "manager" });
      const real = (await captureEnquiry({ phone: inPhone(), channel: "website_form", profile: { country: "AE" }, skipAlerts: true })).contact;
      const guess = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
      const mergeId = await mergeContacts(guess.id, real.id, m);
      const w = await contactRow(guess.id);
      expect(w.country).toBe("AE");
      expect(w.fieldSources.country).toBeUndefined();
      await undoMerge(mergeId, m);
      const u = await contactRow(guess.id);
      expect(u.country).toBe("IN");
      expect(u.fieldSources.country).toBe("system");
    });
  });

  describe("merge keeps the oldest record's first labels together", () => {
    it("first door, first campaign and first channel all come from the older contact, even when one is empty", async () => {
      const m = await makeUser({ role: "manager" });
      const older = (
        await captureEnquiry({ phone: inPhone(), name: "Old", channel: "phone_call", firstDoor: "youtube", receivedAt: new Date("2025-03-01T00:00:00Z"), skipAlerts: true })
      ).contact;
      const newer = (
        await captureEnquiry({ phone: inPhone(), name: "New", channel: "meta_lead_form", campaign: "claude_mastery_meta", skipAlerts: true })
      ).contact;
      expect(older.firstCampaign).toBeNull();
      const mergeId = await mergeContacts(newer.id, older.id, m);
      const w = await contactRow(newer.id);
      expect(w.firstDoor).toBe("youtube");
      expect(w.firstChannel).toBe("phone_call");
      // the newer record's Meta campaign is not how this person first came in
      expect(w.firstCampaign).toBeNull();
      await undoMerge(mergeId, m);
      expect((await contactRow(newer.id)).firstCampaign).toBe("claude_mastery_meta");
    });
  });

  describe("referrals never loop", () => {
    it("merging a person whose old record referred the new record's referrer drops the looping link", async () => {
      const m = await makeUser({ role: "manager" });
      // the old record L referred X; later X's affiliate link brought the same person in again as W
      const L = (await captureEnquiry({ phone: inPhone(), name: "Person", channel: "phone_call", receivedAt: new Date("2025-01-01T00:00:00Z"), skipAlerts: true })).contact;
      const X = (await captureEnquiry({ phone: inPhone(), name: "Friend", channel: "phone_call", referrer: { contactId: L.id }, skipAlerts: true })).contact;
      const W = (await captureEnquiry({ phone: inPhone(), name: "Person", channel: "tagmango_checkout", referrer: { contactId: X.id }, skipAlerts: true })).contact;
      expect(X.referredById).toBe(L.id);
      expect(W.referredById).toBe(X.id);
      const mergeId = await mergeContacts(W.id, L.id, m);
      const w = await contactRow(W.id);
      const x = await contactRow(X.id);
      expect(x.referredById).toBe(W.id);
      expect(w.referredById).toBeNull();
      await undoMerge(mergeId, m);
      expect((await contactRow(W.id)).referredById).toBe(X.id);
      expect((await contactRow(X.id)).referredById).toBe(L.id);
    });

    it("linking a referrer to an existing contact is audited", async () => {
      const ref = (await captureEnquiry({ phone: inPhone(), name: "Affiliate", channel: "phone_call", skipAlerts: true })).contact;
      const c = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true })).contact;
      await captureEnquiry({ phone: c.phoneE164, channel: "tagmango_checkout", referrer: { contactId: ref.id }, skipAlerts: true });
      const rows = await db.select().from(auditLog).where(and(eq(auditLog.rowId, c.id), eq(auditLog.field, "referredById")));
      expect(rows).toHaveLength(1);
      expect(rows[0].newValue).toBe(ref.id);
    });
  });

  describe("ids that are not ids", () => {
    it("a malformed contact id is reported as not found, not as a database error", async () => {
      const s = await makeUser({ role: "sales" });
      await expect(logInteraction("not-a-uuid", { type: "call" }, s)).rejects.toBeInstanceOf(ContactNotFoundError);
      await expect(setManualStage("123", "qualified", {}, s)).rejects.toBeInstanceOf(ContactNotFoundError);
      await expect(updateContactProfile("x", { city: "Kochi" }, s)).rejects.toBeInstanceOf(ContactNotFoundError);
      const c = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId: s.id, skipAlerts: true })).contact;
      await expect(updateContactProfile(c.id, { referredById: "nobody" }, s)).rejects.toMatchObject({
        message: "That referrer does not exist",
        field: "referredById",
      });
    });
  });

  describe("round robin outside a caller's transaction", () => {
    it("parallel picks on the root handle never give two leads to one person in a round", async () => {
      const people = [];
      for (let i = 0; i < 4; i++) people.push(await makeUser({ role: "sales", team: "kerala" }));
      for (let round = 0; round < 10; round++) {
        const picks = await Promise.all(Array.from({ length: 4 }, () => pickAutoOwner("IN")));
        expect(new Set(picks).size).toBe(4);
      }
      expect(people).toHaveLength(4);
    });
  });

  describe("handover at scale (rule 8)", () => {
    it("moves thousands of contacts in one action quickly, logging every change", async () => {
      const leaver = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const N = 3000;
      const rows = Array.from({ length: N }, (_, i) => ({
        phoneE164: `+9198472${String(i).padStart(5, "0")}`,
        name: `Lead ${i}`,
        firstDoor: "other",
        ownerId: leaver.id,
        firstOwnerId: leaver.id,
        ownerAssignedAt: new Date(),
      }));
      for (let i = 0; i < N; i += 1000) await db.insert(contacts).values(rows.slice(i, i + 1000));
      const started = Date.now();
      expect(await handoverAllContacts(leaver.id, m.id, m)).toBe(N);
      const ms = Date.now() - started;
      // the per-contact loop it replaced took ~16 s here for 3,000 contacts
      expect(ms).toBeLessThan(5000);
      expect(await count(contacts, eq(contacts.ownerId, m.id))).toBe(N);
      expect(await count(contacts, eq(contacts.firstOwnerId, leaver.id))).toBe(N);
      expect(await count(ownershipLog, and(eq(ownershipLog.reason, "Owner left the team"), eq(ownershipLog.toUserId, m.id), eq(ownershipLog.fromUserId, leaver.id), eq(ownershipLog.changedById, m.id)))).toBe(N);
      expect(await count(auditLog, and(eq(auditLog.action, "reassign"), eq(auditLog.field, "owner_id")))).toBe(N);
    }, 120_000);

    it("a contact without a first owner gets the new owner as first owner, and is audited", async () => {
      const leaver = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const [c] = await db.insert(contacts).values({ phoneE164: `+91${inPhone()}`, name: "Legacy", firstDoor: "other", ownerId: leaver.id }).returning();
      expect(await handoverAllContacts(leaver.id, m.id, m)).toBe(1);
      const row = await contactRow(c.id);
      expect(row.firstOwnerId).toBe(m.id);
      expect(row.ownerAssignedAt).toBeInstanceOf(Date);
      expect(await count(auditLog, and(eq(auditLog.rowId, c.id), eq(auditLog.field, "first_owner_id")))).toBe(1);
    });
  });

  describe("lifecycle with the real recompute", () => {
    it("a new enquiry pulls a Lost contact back into the right stage automatically", async () => {
      const s = await makeUser({ role: "sales" });
      const c = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId: s.id, skipAlerts: true })).contact;
      const lost = await setManualStage(c.id, "lost", { lostReason: "price" }, s);
      expect(lost.stage).toBe("lost");
      expect(lost.lostReason).toBe("price");
      const back = await captureEnquiry({ phone: c.phoneE164, channel: "website_form", skipAlerts: true });
      expect(back.contact.stage).toBe("new");
    });

    it("a history import older than the Lost mark does not pull it back", async () => {
      const s = await makeUser({ role: "sales" });
      const c = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId: s.id, skipAlerts: true })).contact;
      await setManualStage(c.id, "lost", { lostReason: "timing" }, s);
      const old = await captureEnquiry({ phone: c.phoneE164, channel: "import", receivedAt: new Date(Date.now() - 400 * DAY_MS), skipAlerts: true });
      expect(old.contact.stage).toBe("lost");
    });

    it("reopening a Lost contact the owner has called lands on Contacted", async () => {
      const s = await makeUser({ role: "sales" });
      const c = (await captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId: s.id, skipAlerts: true })).contact;
      await logInteraction(c.id, { type: "call", outcome: "connected" }, s);
      await setManualStage(c.id, "lost", { lostReason: "not_interested" }, s);
      const r = await reopenContact(c.id, s);
      expect(r.stage).toBe("contacted");
      expect(r.lostReason).toBeNull();
    });
  });

  describe("duplicate reviews", () => {
    it("dismissing writes the status and its audit row together", async () => {
      const m = await makeUser({ role: "manager" });
      const a = (await captureEnquiry({ phone: inPhone(), name: "Same Name", channel: "phone_call", profile: { city: "Kochi" }, skipAlerts: true })).contact;
      const b = await captureEnquiry({ phone: inPhone(), name: "same  name", channel: "phone_call", profile: { city: "kochi" }, skipAlerts: true });
      expect(b.possibleDuplicateIds).toEqual([a.id]);
      const [review] = await db.select().from(duplicateReviews);
      const { dismissDuplicateReview } = await import("@/lib/contacts/merge");
      await expect(
        db.transaction(async (t) => {
          await dismissDuplicateReview(review.id, m, t);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await db.select().from(duplicateReviews))[0].status).toBe("open");
      await dismissDuplicateReview(review.id, m);
      expect((await db.select().from(duplicateReviews))[0].status).toBe("dismissed");
    });
  });
});
