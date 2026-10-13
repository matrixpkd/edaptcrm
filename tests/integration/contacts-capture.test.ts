import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  auditLog,
  contacts,
  duplicateReviews,
  enquiries,
  notifications,
  ownershipLog,
  payments,
  purchases,
  ratings,
  users,
} from "@/db/schema";
import { captureEnquiry, DEFAULT_FIRST_DOOR_BY_CHANNEL, InvalidPhoneError } from "@/lib/contacts/capture";
import { ContactValidationError } from "@/lib/contacts/errors";
import { applyRating } from "@/lib/contacts/profile";
import { setSetting } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const inPhone = () => `98470${String(20000 + seq++).padStart(5, "0")}`;
const aePhone = () => `0501${String(200000 + seq++).padStart(6, "0")}`;

async function count(table: PgTable, where?: SQL): Promise<number> {
  const q = db.select({ n: sql<number>`count(*)::int` }).from(table);
  const rows = where ? await q.where(where) : await q;
  return rows[0].n;
}

describe("captureEnquiry", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("a new contact", () => {
    it("creates the contact and its enquiry with the labels, normalised identity and defaults", async () => {
      const kerala = await makeUser({ role: "sales", team: "kerala" });
      const local = inPhone();
      const receivedAt = new Date();
      const r = await captureEnquiry({
        phone: `+91 ${local.slice(0, 5)} ${local.slice(5)}`,
        name: "  MOHAMMED   ali k ",
        email: " Ali.K@Example.COM ",
        channel: "meta_lead_form",
        campaign: "claude_mastery_meta",
        productInterest: "Workshop",
        rawPayload: { form: "lead" },
        receivedAt,
        tags: ["VIP", " VIP ", "B2B"],
        profile: { city: " Kochi ", consent: true, language: "Malayalam", industry: "business_owner" },
        skipAlerts: true,
      });
      expect(r.created).toBe(true);
      expect(r.duplicateEnquiry).toBe(false);
      expect(r.enquiryId).toBeTruthy();
      const c = r.contact;
      expect(c.phoneE164).toBe(`+91${local}`);
      expect(c.phoneCountry).toBe("IN");
      expect(c.country).toBe("IN");
      expect(c.name).toBe("Mohammed Ali K");
      expect(c.email).toBe("ali.k@example.com");
      expect(c.firstDoor).toBe("meta_ad");
      expect(c.firstChannel).toBe("meta_lead_form");
      expect(c.firstCampaign).toBe("claude_mastery_meta");
      expect(c.lastChannel).toBe("meta_lead_form");
      expect(c.lastCampaign).toBe("claude_mastery_meta");
      expect(c.lastEnquiryAt?.getTime()).toBe(receivedAt.getTime());
      expect(c.tags).toEqual(["VIP", "B2B"]);
      expect(c.city).toBe("Kochi");
      expect(c.language).toBe("ml");
      expect(c.industry).toBe("business_owner");
      // the country was only guessed from the phone number, so it is marked as such
      expect(c.fieldSources).toEqual({ industry: "system", country: "system" });
      expect(c.consent).toBe(true);
      expect(c.consentAt).toBeInstanceOf(Date);
      expect(c.stage).toBe("new");
      expect(c.ownerId).toBe(kerala.id);
      expect(c.firstOwnerId).toBe(kerala.id);
      expect(c.ownerAssignedAt).toBeInstanceOf(Date);
      const [e] = await db.select().from(enquiries).where(eq(enquiries.contactId, c.id));
      expect(e).toMatchObject({ channel: "meta_lead_form", campaign: "claude_mastery_meta", productInterest: "Workshop", status: "open" });
      expect(e.rawPayload).toEqual({ form: "lead" });
      const log = await db.select().from(ownershipLog).where(eq(ownershipLog.contactId, c.id));
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ fromUserId: null, toUserId: kerala.id });
    });

    it("uses the international number when no name is given, and the default door per channel", async () => {
      for (const [channel, door] of Object.entries(DEFAULT_FIRST_DOOR_BY_CHANNEL)) {
        const r = await captureEnquiry({ phone: inPhone(), channel, skipAlerts: true });
        expect(r.contact.firstDoor).toBe(door);
        expect(r.contact.name).toMatch(/^\+91 \d{5} \d{5}$/);
      }
      const unknown = await captureEnquiry({ phone: inPhone(), channel: "fax", skipAlerts: true });
      expect(unknown.contact.firstDoor).toBe("other");
      const chosen = await captureEnquiry({ phone: inPhone(), channel: "meta_lead_form", firstDoor: "youtube", skipAlerts: true });
      expect(chosen.contact.firstDoor).toBe("youtube");
    });

    it("joins a separate dial code and takes the country from the number", async () => {
      const r = await captureEnquiry({ phone: "501234567", dialCode: "+971", channel: "tagmango_checkout", skipAlerts: true });
      expect(r.contact.phoneE164).toBe("+971501234567");
      expect(r.contact.phoneCountry).toBe("AE");
      expect(r.contact.country).toBe("AE");
      const withCountry = await captureEnquiry({
        phone: aePhone(),
        defaultCountry: "AE",
        channel: "website_form",
        profile: { country: "in" },
        skipAlerts: true,
      });
      expect(withCountry.contact.phoneCountry).toBe("AE");
      expect(withCountry.contact.country).toBe("IN");
    });

    it("rejects an invalid phone and writes nothing", async () => {
      await expect(captureEnquiry({ phone: "12345", channel: "phone_call" })).rejects.toBeInstanceOf(InvalidPhoneError);
      await expect(captureEnquiry({ phone: "", channel: "phone_call" })).rejects.toBeInstanceOf(InvalidPhoneError);
      await expect(captureEnquiry({ phone: inPhone(), channel: " " })).rejects.toBeInstanceOf(ContactValidationError);
      expect(await count(contacts)).toBe(0);
      expect(await count(enquiries)).toBe(0);
    });

    it("drops unknown list values and bad country codes instead of guessing", async () => {
      const r = await captureEnquiry({
        phone: inPhone(),
        channel: "import",
        profile: { language: "Klingon", ageBand: "ancient", industry: "wizard", country: "India" },
        skipAlerts: true,
      });
      expect(r.contact.language).toBeNull();
      expect(r.contact.ageBand).toBeNull();
      expect(r.contact.industry).toBeNull();
      expect(r.contact.country).toBe("IN"); // from the phone
    });
  });

  describe("idempotency", () => {
    it("the same sourceRef twice returns the existing contact and changes nothing", async () => {
      const local = inPhone();
      const first = await captureEnquiry({ phone: local, name: "Anil", channel: "whatsapp_api", sourceRef: "libromi:msg:1", skipAlerts: true });
      const before = (await db.select().from(contacts).where(eq(contacts.id, first.contact.id)))[0];
      const again = await captureEnquiry({
        phone: local,
        name: "Someone Else",
        email: "new@example.com",
        channel: "meta_lead_form",
        campaign: "claude_mastery_meta",
        sourceRef: "libromi:msg:1",
        profile: { city: "Dubai" },
        tags: ["VIP"],
        skipAlerts: true,
      });
      expect(again.duplicateEnquiry).toBe(true);
      expect(again.created).toBe(false);
      expect(again.enquiryId).toBe(first.enquiryId);
      expect(again.contact.id).toBe(first.contact.id);
      expect(await count(enquiries)).toBe(1);
      const after = (await db.select().from(contacts).where(eq(contacts.id, first.contact.id)))[0];
      expect(after).toEqual(before);
    });

    it("a duplicate sourceRef for a different number still changes nothing", async () => {
      await captureEnquiry({ phone: inPhone(), channel: "website_form", sourceRef: "pabbly:1", skipAlerts: true });
      const r = await captureEnquiry({ phone: inPhone(), channel: "website_form", sourceRef: "pabbly:1", skipAlerts: true });
      expect(r.duplicateEnquiry).toBe(true);
      expect(await count(contacts)).toBe(1);
    });

    it("parallel deliveries of the same event create one contact and one enquiry", async () => {
      await makeUser({ role: "sales", team: "kerala" });
      const local = inPhone();
      const results = await Promise.all(
        [1, 2, 3].map(() => captureEnquiry({ phone: local, channel: "whatsapp_api", sourceRef: "libromi:race", skipAlerts: true })),
      );
      expect(await count(contacts)).toBe(1);
      expect(await count(enquiries)).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(results.filter((r) => r.duplicateEnquiry)).toHaveLength(2);
      expect(new Set(results.map((r) => r.contact.id)).size).toBe(1);
    });

    it("parallel first touches of one new number create one contact with every enquiry", async () => {
      const local = inPhone();
      const results = await Promise.all(
        ["a", "b", "c"].map((k) => captureEnquiry({ phone: local, channel: "website_form", sourceRef: `web:${k}`, skipAlerts: true })),
      );
      expect(await count(contacts)).toBe(1);
      expect(await count(enquiries)).toBe(3);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    });

    it("is atomic inside the caller's transaction", async () => {
      await expect(
        db.transaction(async (tx) => {
          await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true }, tx);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await count(contacts)).toBe(0);
      expect(await count(enquiries)).toBe(0);
    });
  });

  describe("a returning contact", () => {
    it("never changes the first door, first campaign or first channel; updates the last labels", async () => {
      const local = inPhone();
      const first = await captureEnquiry({ phone: local, channel: "meta_lead_form", campaign: "claude_mastery_meta", skipAlerts: true });
      const later = new Date(Date.now() + 60_000);
      const r = await captureEnquiry({
        phone: local,
        channel: "website_form",
        campaign: "ai_office_dubai_oct_2026",
        firstDoor: "youtube",
        referrer: { phone: inPhone(), name: "Ref" },
        receivedAt: later,
        skipAlerts: true,
      });
      expect(r.created).toBe(false);
      expect(r.contact.id).toBe(first.contact.id);
      expect(r.contact.firstDoor).toBe("meta_ad");
      expect(r.contact.firstChannel).toBe("meta_lead_form");
      expect(r.contact.firstCampaign).toBe("claude_mastery_meta");
      expect(r.contact.lastChannel).toBe("website_form");
      expect(r.contact.lastCampaign).toBe("ai_office_dubai_oct_2026");
      expect(r.contact.lastEnquiryAt?.getTime()).toBe(later.getTime());
      expect(await count(enquiries, eq(enquiries.contactId, first.contact.id))).toBe(2);
    });

    it("an older touch (history import) does not move the last labels backwards", async () => {
      const local = inPhone();
      await captureEnquiry({ phone: local, channel: "website_form", campaign: "ai_office_dubai_oct_2026", skipAlerts: true });
      const r = await captureEnquiry({
        phone: local,
        channel: "import",
        campaign: "koduvally_ai_literacy",
        receivedAt: new Date("2024-01-01T00:00:00Z"),
        skipAlerts: true,
      });
      expect(r.contact.lastChannel).toBe("website_form");
      expect(r.contact.lastCampaign).toBe("ai_office_dubai_oct_2026");
      expect(await count(enquiries)).toBe(2);
    });

    it("fills empty profile fields only, never overwrites filled ones", async () => {
      const local = inPhone();
      await captureEnquiry({ phone: local, name: "Bindu", channel: "phone_call", profile: { city: "Kochi", consent: false }, skipAlerts: true });
      const r = await captureEnquiry({
        phone: local,
        name: "Somebody Else",
        channel: "website_form",
        profile: { city: "Dubai", state: "Kerala", designation: "Owner", companyName: "Bindu Stores", consent: true, ageBand: "35-44" },
        tags: ["VIP"],
        skipAlerts: true,
      });
      expect(r.contact.name).toBe("Bindu");
      expect(r.contact.city).toBe("Kochi");
      expect(r.contact.state).toBe("Kerala");
      expect(r.contact.designation).toBe("Owner");
      expect(r.contact.companyName).toBe("Bindu Stores");
      expect(r.contact.consent).toBe(false);
      expect(r.contact.ageBand).toBe("35-44");
      expect(r.contact.fieldSources).toMatchObject({ age_band: "system" });
      expect(r.contact.tags).toEqual(["VIP"]);
      expect(Object.keys(r.changes).sort()).toEqual(["ageBand", "companyName", "designation", "state", "tags"]);
      expect(r.changes.state).toEqual({ before: null, after: "Kerala" });
    });

    it("replaces a phone-number placeholder name with a real one", async () => {
      const local = inPhone();
      const first = await captureEnquiry({ phone: local, channel: "whatsapp_api", skipAlerts: true });
      expect(first.contact.name).toMatch(/^\+91/);
      const r = await captureEnquiry({ phone: local, name: "jaya menon", channel: "website_form", skipAlerts: true });
      expect(r.contact.name).toBe("Jaya Menon");
    });

    it("adds a new email and a second phone as alternates, never over the primary", async () => {
      const local = inPhone();
      const second = inPhone();
      await captureEnquiry({ phone: local, email: "a@example.com", channel: "phone_call", skipAlerts: true });
      const r1 = await captureEnquiry({ phone: local, email: "A.Two@example.com", channel: "website_form", skipAlerts: true });
      expect(r1.contact.email).toBe("a@example.com");
      expect(r1.contact.altEmails).toEqual(["a.two@example.com"]);
      // matched by email, from a second number: the number becomes an alternate
      const r2 = await captureEnquiry({ phone: second, email: "a@example.com", channel: "website_form", skipAlerts: true });
      expect(r2.created).toBe(false);
      expect(r2.contact.id).toBe(r1.contact.id);
      expect(r2.contact.phoneE164).toBe(`+91${local}`);
      expect(r2.contact.altPhones).toEqual([`+91${second}`]);
      // and the alternate now matches too
      const r3 = await captureEnquiry({ phone: second, channel: "whatsapp_app", skipAlerts: true });
      expect(r3.contact.id).toBe(r1.contact.id);
      expect(await count(contacts)).toBe(1);
      expect(await count(enquiries)).toBe(4);
    });

    it("fills an empty primary email", async () => {
      const local = inPhone();
      await captureEnquiry({ phone: local, channel: "phone_call", skipAlerts: true });
      const r = await captureEnquiry({ phone: local, email: "Late@Example.com", channel: "website_form", skipAlerts: true });
      expect(r.contact.email).toBe("late@example.com");
      expect(r.contact.altEmails).toEqual([]);
    });

    it("an email that belongs to another contact is flagged for review, never copied", async () => {
      const a = await captureEnquiry({ phone: inPhone(), email: "shared@example.com", channel: "phone_call", skipAlerts: true });
      const localB = inPhone();
      const b = await captureEnquiry({ phone: localB, channel: "phone_call", skipAlerts: true });
      const r = await captureEnquiry({ phone: localB, email: "shared@example.com", channel: "website_form", skipAlerts: true });
      expect(r.contact.id).toBe(b.contact.id);
      expect(r.contact.email).toBeNull();
      expect(r.contact.altEmails).toEqual([]);
      expect(r.possibleDuplicateIds).toEqual([a.contact.id]);
      const reviews = await db.select().from(duplicateReviews);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].status).toBe("open");
      expect([reviews[0].contactAId, reviews[0].contactBId].sort()).toEqual([a.contact.id, b.contact.id].sort());
    });

    it("stays with its current owner (rule 2), even when someone else enters it", async () => {
      const owner = await makeUser({ role: "sales" });
      const other = await makeUser({ role: "sales" });
      const local = inPhone();
      await captureEnquiry({ phone: local, channel: "phone_call", ownerId: owner.id, createdById: owner.id, skipAlerts: true });
      const r = await captureEnquiry({ phone: local, channel: "whatsapp_app", ownerId: other.id, createdById: other.id, skipAlerts: true });
      expect(r.contact.ownerId).toBe(owner.id);
      expect(await count(ownershipLog)).toBe(1);
    });

    it("a contact in the pool is assigned on its next enquiry", async () => {
      const local = inPhone();
      const first = await captureEnquiry({ phone: local, channel: "phone_call", skipAssignment: true, skipAlerts: true });
      expect(first.contact.ownerId).toBeNull();
      const s = await makeUser({ role: "sales", team: "kerala" });
      const r = await captureEnquiry({ phone: local, channel: "website_form", skipAlerts: true });
      expect(r.contact.ownerId).toBe(s.id);
      expect(r.contact.firstOwnerId).toBe(s.id);
      const log = await db.select().from(ownershipLog).where(eq(ownershipLog.contactId, r.contact.id));
      expect(log.map((l) => l.reason)).toEqual(["New enquiry from the pool: round robin"]);
    });

    it("a contact whose owner left (inactive) is re-assigned on its next enquiry", async () => {
      const gone = await makeUser({ role: "sales", team: "kerala" });
      const local = inPhone();
      await captureEnquiry({ phone: local, channel: "phone_call", ownerId: gone.id, skipAlerts: true });
      await db.update(users).set({ active: false }).where(eq(users.id, gone.id));
      const s = await makeUser({ role: "sales", team: "kerala" });
      const r = await captureEnquiry({ phone: local, channel: "website_form", skipAlerts: true });
      expect(r.contact.ownerId).toBe(s.id);
      expect(r.contact.firstOwnerId).toBe(gone.id);
    });

    it("writes an audit trail of what the touch filled in", async () => {
      const local = inPhone();
      await captureEnquiry({ phone: local, channel: "phone_call", skipAlerts: true });
      const u = await makeUser({ role: "support" });
      const r = await captureEnquiry({ phone: local, channel: "phone_call", profile: { city: "Thrissur" }, createdById: u.id, skipAlerts: true });
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.rowId, r.contact.id), eq(auditLog.field, "city")));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ oldValue: null, newValue: "Thrissur", userId: u.id });
    });
  });

  describe("owners", () => {
    it("a salesperson's own Quick Add makes them owner and first owner", async () => {
      await makeUser({ role: "sales", team: "kerala" });
      const me = await makeUser({ role: "sales", team: "dubai" });
      const r = await captureEnquiry({ phone: inPhone(), channel: "whatsapp_app", ownerId: me.id, createdById: me.id, skipAlerts: true });
      expect(r.contact.ownerId).toBe(me.id);
      expect(r.contact.firstOwnerId).toBe(me.id);
      expect(r.contact.createdById).toBe(me.id);
      const log = await db.select().from(ownershipLog);
      expect(log[0]).toMatchObject({ toUserId: me.id, reason: "Added by hand", changedById: me.id });
    });

    it("support and inactive users can never be explicit owners; nothing is written", async () => {
      const support = await makeUser({ role: "support" });
      const inactive = await makeUser({ role: "sales", active: false });
      await expect(captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId: support.id })).rejects.toBeInstanceOf(
        ContactValidationError,
      );
      await expect(captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId: inactive.id })).rejects.toThrow(/not active/);
      expect(await count(contacts)).toBe(0);
    });

    it("skipAssignment leaves a new lead in the pool", async () => {
      await makeUser({ role: "sales", team: "kerala" });
      const r = await captureEnquiry({ phone: inPhone(), channel: "import", skipAssignment: true, skipAlerts: true });
      expect(r.contact.ownerId).toBeNull();
      expect(r.contact.firstOwnerId).toBeNull();
      expect(await count(ownershipLog)).toBe(0);
    });
  });

  describe("referrers", () => {
    it("creates an unknown referrer from its phone and links the new contact (first door referral)", async () => {
      const refLocal = inPhone();
      const r = await captureEnquiry({
        phone: inPhone(),
        channel: "tagmango_checkout",
        referrer: { phone: refLocal, name: "rajesh nair" },
        skipAlerts: true,
      });
      expect(r.referrerCreated).toBe(true);
      expect(r.contact.firstDoor).toBe("referral");
      expect(r.contact.referredById).toBe(r.referrerId);
      const [ref] = await db.select().from(contacts).where(eq(contacts.id, r.referrerId!));
      expect(ref).toMatchObject({ phoneE164: `+91${refLocal}`, name: "Rajesh Nair", firstDoor: "other", firstChannel: "tagmango_checkout" });
      // the referrer did not enquire: no enquiry row for them
      expect(await count(enquiries, eq(enquiries.contactId, ref.id))).toBe(0);
    });

    it("links an existing referrer found by phone (or alternate) or by contact id", async () => {
      const ref = await captureEnquiry({ phone: inPhone(), name: "Existing Ref", channel: "phone_call", skipAlerts: true });
      const r = await captureEnquiry({ phone: inPhone(), channel: "tagmango_checkout", referrer: { phone: ref.contact.phoneE164 }, skipAlerts: true });
      expect(r.referrerCreated).toBe(false);
      expect(r.contact.referredById).toBe(ref.contact.id);
      const r2 = await captureEnquiry({ phone: inPhone(), channel: "phone_call", referrer: { contactId: ref.contact.id }, skipAlerts: true });
      expect(r2.contact.referredById).toBe(ref.contact.id);
      expect(await count(contacts)).toBe(3);
    });

    it("never overwrites an existing referrer and never lets a contact refer itself", async () => {
      const refA = await captureEnquiry({ phone: inPhone(), name: "Ref A", channel: "phone_call", skipAlerts: true });
      const refB = await captureEnquiry({ phone: inPhone(), name: "Ref B", channel: "phone_call", skipAlerts: true });
      const local = inPhone();
      await captureEnquiry({ phone: local, channel: "tagmango_checkout", referrer: { contactId: refA.contact.id }, skipAlerts: true });
      const r = await captureEnquiry({ phone: local, channel: "tagmango_checkout", referrer: { contactId: refB.contact.id }, skipAlerts: true });
      expect(r.contact.referredById).toBe(refA.contact.id);

      const selfLocal = inPhone();
      const self = await captureEnquiry({ phone: selfLocal, channel: "tagmango_checkout", referrer: { phone: selfLocal }, skipAlerts: true });
      expect(self.contact.referredById).toBeNull();
      expect(self.referrerId).toBeNull();
      const self2 = await captureEnquiry({ phone: selfLocal, channel: "phone_call", referrer: { contactId: self.contact.id }, skipAlerts: true });
      expect(self2.contact.referredById).toBeNull();
    });

    it("an existing contact without a referrer gets one, but never a referral loop", async () => {
      const a = await captureEnquiry({ phone: inPhone(), name: "A", channel: "phone_call", skipAlerts: true });
      const b = await captureEnquiry({ phone: inPhone(), name: "B", channel: "phone_call", referrer: { contactId: a.contact.id }, skipAlerts: true });
      expect(b.contact.referredById).toBe(a.contact.id);
      // A arrives again "referred by" B: that would be a loop
      const again = await captureEnquiry({ phone: a.contact.phoneE164, channel: "phone_call", referrer: { contactId: b.contact.id }, skipAlerts: true });
      expect(again.contact.referredById).toBeNull();
    });

    it("an unresolvable referrer (name only) is kept in the enquiry notes", async () => {
      const r = await captureEnquiry({ phone: inPhone(), channel: "walk_in_event", referrer: { name: "Uncle Joseph" }, notes: "Met at Kochi", skipAlerts: true });
      expect(r.contact.firstDoor).toBe("referral");
      expect(r.contact.referredById).toBeNull();
      const [e] = await db.select().from(enquiries).where(eq(enquiries.id, r.enquiryId!));
      expect(e.notes).toBe("Met at Kochi\nReferred by Uncle Joseph");
    });
  });

  describe("self-ratings", () => {
    it("fill fields, never override a salesperson's rating", async () => {
      const sales = await makeUser({ role: "sales" });
      const local = inPhone();
      const r = await captureEnquiry({ phone: local, channel: "whatsapp_api", selfRatings: { aiLevel: 2, umerLevel: 3 }, skipAlerts: true });
      expect(r.contact.aiLevel).toBe(2);
      expect(r.contact.umerLevel).toBe(3);
      expect(r.contact.fieldSources).toMatchObject({ ai_level: "self", umer_level: "self" });
      await applyRating(r.contact.id, { aiLevel: 4 }, "sales", sales.id);
      const r2 = await captureEnquiry({ phone: local, channel: "whatsapp_api", selfRatings: { aiLevel: 1, umerLevel: 5, spendingBand: 9 }, skipAlerts: true });
      expect(r2.contact.aiLevel).toBe(4);
      expect(r2.contact.umerLevel).toBe(5);
      expect(r2.contact.spendingBand).toBeNull(); // out of range: dropped, the lead is still captured
      expect(r2.contact.fieldSources).toMatchObject({ ai_level: "sales", umer_level: "self" });
      const history = await db.select().from(ratings).where(eq(ratings.contactId, r.contact.id));
      expect(history.map((h) => h.source).sort()).toEqual(["sales", "self", "self"]);
    });
  });

  describe("possible duplicates", () => {
    it("same name and same city is flagged for review, never merged", async () => {
      const a = await captureEnquiry({ phone: inPhone(), name: "Sreeja P", channel: "phone_call", profile: { city: "Kannur" }, skipAlerts: true });
      const b = await captureEnquiry({ phone: inPhone(), name: "sreeja  p", channel: "website_form", profile: { city: "kannur" }, skipAlerts: true });
      expect(b.created).toBe(true);
      expect(b.contact.id).not.toBe(a.contact.id);
      expect(b.possibleDuplicateIds).toEqual([a.contact.id]);
      const reviews = await db.select().from(duplicateReviews);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ status: "open", reason: "Same name in the same city" });
      expect(await count(contacts)).toBe(2);
      const c = await captureEnquiry({ phone: inPhone(), name: "Sreeja P", channel: "website_form", profile: { city: "Kochi" }, skipAlerts: true });
      expect(c.possibleDuplicateIds).toEqual([]);
    });
  });

  describe("alerts", () => {
    it("New lead: the auto-assigned owner is told in-app; not the person who entered it", async () => {
      const s = await makeUser({ role: "sales", team: "kerala" });
      const r = await captureEnquiry({ phone: inPhone(), name: "Lead One", channel: "meta_lead_form", campaign: "claude_mastery_meta" });
      const n = await db.select().from(notifications).where(eq(notifications.userId, s.id));
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ type: "new_lead", contactId: r.contact.id, title: "New lead: Lead One", email: false });
      expect(n[0].body).toBe("Meta lead form · Claude Mastery Meta ads");

      await captureEnquiry({ phone: inPhone(), channel: "whatsapp_app", ownerId: s.id, createdById: s.id });
      expect(await count(notifications, eq(notifications.userId, s.id))).toBe(1);
    });

    it("a returning contact's owner is told about the new enquiry, once per enquiry", async () => {
      const s = await makeUser({ role: "sales", team: "kerala" });
      const local = inPhone();
      await captureEnquiry({ phone: local, channel: "phone_call", skipAlerts: true });
      await captureEnquiry({ phone: local, channel: "website_form", sourceRef: "web:1" });
      await captureEnquiry({ phone: local, channel: "website_form", sourceRef: "web:1" });
      const n = await db.select().from(notifications).where(eq(notifications.userId, s.id));
      expect(n.map((x) => x.type)).toEqual(["new_enquiry"]);
    });

    it("Hot lead: a grade A lead enquiring alerts owner and managers by email, deduped per enquiry", async () => {
      const s = await makeUser({ role: "sales", team: "kerala" });
      const m = await makeUser({ role: "manager" });
      const local = inPhone();
      const first = await captureEnquiry({ phone: local, channel: "phone_call", profile: { city: "Kochi" }, skipAlerts: true });
      // the spec's worked example: a Kerala-city business owner, 35 to 44, band 4, Umer 3, AI 2 -> grade A
      await applyRating(first.contact.id, { spendingBand: 4, industry: "business_owner", ageBand: "35-44", umerLevel: 3, aiLevel: 2 }, "sales", s.id);
      expect((await db.select().from(contacts).where(eq(contacts.id, first.contact.id)))[0].grade).toBe("A");
      await captureEnquiry({ phone: local, channel: "website_form", sourceRef: "hot:1" });
      await captureEnquiry({ phone: local, channel: "website_form", sourceRef: "hot:1" });
      const hot = await db.select().from(notifications).where(eq(notifications.type, "hot_lead"));
      expect(hot.map((h) => h.userId).sort()).toEqual([s.id, m.id].sort());
      expect(hot.every((h) => h.email)).toBe(true);
      await captureEnquiry({ phone: local, channel: "website_form", sourceRef: "hot:2" });
      expect(await count(notifications, eq(notifications.type, "hot_lead"))).toBe(4);
    });

    it("no hot lead alert below grade A, for customers, and none at all with skipAlerts", async () => {
      const s = await makeUser({ role: "sales", team: "kerala" });
      await makeUser({ role: "manager" });
      const local = inPhone();
      const first = await captureEnquiry({ phone: local, channel: "phone_call", profile: { city: "Kochi" }, skipAlerts: true });
      // an unrated lead is not grade A
      await captureEnquiry({ phone: local, channel: "website_form" });
      expect(await count(notifications, eq(notifications.type, "hot_lead"))).toBe(0);
      // a grade A customer (one ₹60,000 purchase this week, top ratings) is not a lead
      await applyRating(
        first.contact.id,
        { spendingBand: 5, industry: "business_owner", ageBand: "35-44", umerLevel: 4, aiLevel: 3, gutStars: 5 },
        "sales",
        s.id,
      );
      const [p] = await db
        .insert(purchases)
        .values({ contactId: first.contact.id, productName: "The AI Office", family: "ai_office", amount: 60000, amountInr: 60000, mode: "bank_transfer", status: "paid", reference: "UTR-HOT-1" })
        .returning();
      await db.insert(payments).values({ purchaseId: p.id, contactId: first.contact.id, amount: 60000, amountInr: 60000, status: "verified", paidAt: new Date() });
      const r = await captureEnquiry({ phone: local, channel: "website_form" });
      expect(r.contact.purchaseCount).toBe(1);
      expect(r.contact.grade).toBe("A");
      expect(await count(notifications, eq(notifications.type, "hot_lead"))).toBe(0);
      // a grade A lead with skipAlerts raises nothing
      const other = await captureEnquiry({ phone: inPhone(), channel: "phone_call", profile: { city: "Kochi" }, skipAlerts: true });
      await applyRating(other.contact.id, { spendingBand: 5, industry: "business_owner", ageBand: "35-44", umerLevel: 4, aiLevel: 3 }, "sales", s.id);
      const again = await captureEnquiry({ phone: other.contact.phoneE164, channel: "website_form", skipAlerts: true });
      expect(again.contact.grade).toBe("A");
      expect(again.contact.purchaseCount).toBe(0);
      expect(await count(notifications, eq(notifications.type, "hot_lead"))).toBe(0);
    });
  });

  it("respects settings: auto-assign off sends new leads to the pool", async () => {
    await makeUser({ role: "sales", team: "kerala" });
    await setSetting("assignment", { ...DEFAULT_SETTINGS.assignment, autoAssign: false }, null);
    const r = await captureEnquiry({ phone: inPhone(), channel: "website_form", skipAlerts: true });
    expect(r.contact.ownerId).toBeNull();
  });
});
