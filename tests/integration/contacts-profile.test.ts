import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, contacts, organisations, ratings } from "@/db/schema";
import { captureEnquiry } from "@/lib/contacts/capture";
import {
  ContactConflictError,
  ContactForbiddenError,
  ContactValidationError,
  InvalidPhoneError,
} from "@/lib/contacts/errors";
import { mergeContacts } from "@/lib/contacts/merge";
import { applyRating, updateContactProfile } from "@/lib/contacts/profile";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const inPhone = () => `98470${String(60000 + seq++).padStart(5, "0")}`;

async function lead(over: Partial<Parameters<typeof captureEnquiry>[0]> = {}) {
  return (await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAssignment: true, skipAlerts: true, ...over })).contact;
}

describe("updateContactProfile", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("saves whitelisted fields and audits every change", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead({ ownerId: s.id, name: "Old Name" });
    const r = await updateContactProfile(
      c.id,
      {
        name: "  New   Name ",
        city: "Kochi",
        state: "Kerala",
        country: "ae",
        language: "en",
        designation: "CEO",
        companyName: "Acme",
        salesNotes: "Runs three supermarkets,\nwants AI for stock",
        tags: ["VIP", "VIP", " B2B "],
        consent: true,
        type: "business",
        lastCampaign: "claude_mastery_meta",
      },
      s,
    );
    expect(r).toMatchObject({
      name: "New Name",
      city: "Kochi",
      state: "Kerala",
      country: "AE",
      language: "en",
      designation: "CEO",
      companyName: "Acme",
      salesNotes: "Runs three supermarkets,\nwants AI for stock",
      tags: ["VIP", "B2B"],
      consent: true,
      type: "business",
      lastCampaign: "claude_mastery_meta",
    });
    expect(r.consentAt).toBeInstanceOf(Date);
    const fields = (await db.select().from(auditLog).where(eq(auditLog.rowId, c.id))).map((a) => a.field).filter(Boolean);
    for (const f of ["name", "city", "state", "country", "language", "designation", "companyName", "salesNotes", "tags", "consent", "consentAt", "type", "lastCampaign"]) {
      expect(fields).toContain(f);
    }
    // clearing works and is audited too
    const cleared = await updateContactProfile(c.id, { city: null, consent: null, salesNotes: "  " }, s);
    expect(cleared).toMatchObject({ city: null, consent: null, consentAt: null, salesNotes: null });
  });

  it("support cannot edit; sales only their own contacts and the pool", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const support = await makeUser({ role: "support" });
    const m = await makeUser({ role: "manager" });
    const c = await lead({ ownerId: s1.id });
    await expect(updateContactProfile(c.id, { city: "X" }, support)).rejects.toBeInstanceOf(ContactForbiddenError);
    await expect(updateContactProfile(c.id, { city: "X" }, s2)).rejects.toBeInstanceOf(ContactForbiddenError);
    expect((await updateContactProfile(c.id, { city: "Y" }, m)).city).toBe("Y");
    const pool = await lead();
    expect((await updateContactProfile(pool.id, { city: "Z" }, s2)).city).toBe("Z");
  });

  it("validates values", async () => {
    const m = await makeUser({ role: "manager" });
    const c = await lead();
    await expect(updateContactProfile(c.id, { name: "  " }, m)).rejects.toBeInstanceOf(ContactValidationError);
    await expect(updateContactProfile(c.id, { language: "klingon" }, m)).rejects.toThrow(/language/);
    await expect(updateContactProfile(c.id, { country: "India" }, m)).rejects.toThrow(/two-letter/);
    await expect(updateContactProfile(c.id, { email: "not-an-email" }, m)).rejects.toThrow(/valid email/);
    await expect(updateContactProfile(c.id, { ageBand: "ancient" }, m)).rejects.toThrow(/Age band/);
    await expect(updateContactProfile(c.id, { organisationId: "00000000-0000-0000-0000-000000000000" }, m)).rejects.toThrow(/organisation/);
    const [org] = await db.insert(organisations).values({ name: "Govt School Koduvally", kind: "school" }).returning();
    expect((await updateContactProfile(c.id, { organisationId: org.id }, m)).organisationId).toBe(org.id);
  });

  it("first door is immutable except for an admin correction, which is audited", async () => {
    const s = await makeUser({ role: "sales" });
    const m = await makeUser({ role: "manager" });
    const admin = await makeUser({ role: "admin" });
    const c = await lead({ ownerId: s.id, channel: "meta_lead_form" });
    expect(c.firstDoor).toBe("meta_ad");
    await expect(updateContactProfile(c.id, { firstDoor: "youtube" }, s)).rejects.toBeInstanceOf(ContactForbiddenError);
    await expect(updateContactProfile(c.id, { firstDoor: "youtube" }, m)).rejects.toThrow(/Only an admin/);
    // sending the unchanged value is harmless
    expect((await updateContactProfile(c.id, { firstDoor: "meta_ad", city: "Kochi" }, s)).city).toBe("Kochi");
    await expect(updateContactProfile(c.id, { firstDoor: "nowhere" }, admin)).rejects.toBeInstanceOf(ContactValidationError);
    expect((await updateContactProfile(c.id, { firstDoor: "youtube" }, admin)).firstDoor).toBe("youtube");
    const a = await db.select().from(auditLog).where(and(eq(auditLog.rowId, c.id), eq(auditLog.field, "firstDoor")));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ oldValue: "meta_ad", newValue: "youtube", userId: admin.id });
  });

  describe("phones and emails", () => {
    it("a new primary phone is normalised and must not belong to anyone else", async () => {
      const m = await makeUser({ role: "manager" });
      const a = await lead();
      const b = await lead();
      const fresh = inPhone();
      const r = await updateContactProfile(a.id, { phone: `+91 ${fresh}` }, m);
      expect(r.phoneE164).toBe(`+91${fresh}`);
      expect(r.altPhones).toEqual([]); // a corrected typo is not kept as an alternate
      await expect(updateContactProfile(a.id, { phone: "123" }, m)).rejects.toBeInstanceOf(InvalidPhoneError);
      await expect(updateContactProfile(a.id, { phone: b.phoneE164 }, m)).rejects.toBeInstanceOf(ContactConflictError);
      const alt = inPhone();
      await updateContactProfile(b.id, { altPhones: { add: [alt] } }, m);
      await expect(updateContactProfile(a.id, { phone: alt }, m)).rejects.toThrow(/already belongs/);
      await expect(updateContactProfile(a.id, { altPhones: { add: [alt] } }, m)).rejects.toBeInstanceOf(ContactConflictError);
    });

    it("promoting an alternate to primary keeps the old primary as an alternate", async () => {
      const m = await makeUser({ role: "manager" });
      const c = await lead();
      const alt = inPhone();
      await updateContactProfile(c.id, { altPhones: { add: [`0${alt}`] } }, m);
      const r = await updateContactProfile(c.id, { phone: alt }, m);
      expect(r.phoneE164).toBe(`+91${alt}`);
      expect(r.altPhones).toEqual([c.phoneE164]);
    });

    it("adds and removes alternate phones and emails with normalisation", async () => {
      const m = await makeUser({ role: "manager" });
      const c = await lead({ email: "main@example.com" });
      const p1 = inPhone();
      const p2 = inPhone();
      let r = await updateContactProfile(
        c.id,
        { altPhones: { add: [p1, `+91 ${p2}`, c.phoneE164] }, altEmails: { add: ["Two@Example.com", "MAIN@example.com"] } },
        m,
      );
      expect(r.altPhones).toEqual([`+91${p1}`, `+91${p2}`]);
      expect(r.altEmails).toEqual(["two@example.com"]);
      await expect(updateContactProfile(c.id, { altPhones: { add: ["999"] } }, m)).rejects.toBeInstanceOf(InvalidPhoneError);
      await expect(updateContactProfile(c.id, { altEmails: { add: ["nope"] } }, m)).rejects.toBeInstanceOf(ContactValidationError);
      r = await updateContactProfile(c.id, { altPhones: { remove: [p1] }, altEmails: { remove: ["TWO@example.com"] } }, m);
      expect(r.altPhones).toEqual([`+91${p2}`]);
      expect(r.altEmails).toEqual([]);
      // making an alternate email the primary swaps them
      await updateContactProfile(c.id, { altEmails: { add: ["other@example.com"] } }, m);
      r = await updateContactProfile(c.id, { email: "Other@Example.com" }, m);
      expect(r.email).toBe("other@example.com");
      expect(r.altEmails).toEqual(["main@example.com"]);
    });

    it("a number belonging to a record merged into this one cannot become primary", async () => {
      const m = await makeUser({ role: "manager" });
      const w = await lead();
      const l = await lead();
      await mergeContacts(w.id, l.id, m);
      await expect(updateContactProfile(w.id, { phone: l.phoneE164 }, m)).rejects.toThrow(/undo that merge/);
    });
  });

  describe("referrer", () => {
    it("never itself, never a loop; merged referrers resolve to the surviving contact", async () => {
      const m = await makeUser({ role: "manager" });
      const a = await lead();
      const b = await lead();
      const c = await lead();
      await expect(updateContactProfile(a.id, { referredById: a.id }, m)).rejects.toThrow(/cannot refer itself/);
      await updateContactProfile(b.id, { referredById: a.id }, m);
      await updateContactProfile(c.id, { referredById: b.id }, m);
      await expect(updateContactProfile(a.id, { referredById: c.id }, m)).rejects.toThrow(/loop/);
      await expect(updateContactProfile(a.id, { referredById: b.id }, m)).rejects.toThrow(/loop/);
      const d = await lead();
      const e = await lead();
      await mergeContacts(e.id, d.id, m);
      expect((await updateContactProfile(a.id, { referredById: d.id }, m)).referredById).toBe(e.id);
      expect((await updateContactProfile(a.id, { referredById: null }, m)).referredById).toBeNull();
    });
  });

  it("age band and industry edits are recorded as sales ratings", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead({ ownerId: s.id, selfRatings: { ageBand: "25-34" } });
    expect(c.fieldSources).toMatchObject({ age_band: "self" });
    const r = await updateContactProfile(c.id, { ageBand: "35-44", industry: "teacher" }, s);
    expect(r).toMatchObject({ ageBand: "35-44", industry: "teacher" });
    expect(r.fieldSources).toMatchObject({ age_band: "sales", industry: "sales" });
    const rows = await db.select().from(ratings).where(and(eq(ratings.contactId, c.id), eq(ratings.source, "sales")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ageBand: "35-44", industry: "teacher", ratedByUserId: s.id });
    const cleared = await updateContactProfile(c.id, { industry: null }, s);
    expect(cleared.industry).toBeNull();
    expect(cleared.fieldSources.industry).toBeUndefined();
  });

  it("merged contacts cannot be edited", async () => {
    const m = await makeUser({ role: "manager" });
    const w = await lead();
    const l = await lead();
    await mergeContacts(w.id, l.id, m);
    await expect(updateContactProfile(l.id, { city: "X" }, m)).rejects.toThrow(/merged/);
  });
});

describe("applyRating", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("validates the anchored scales", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead();
    await expect(applyRating(c.id, { aiLevel: 6 }, "sales", s.id)).rejects.toThrow(/0 to 5/);
    await expect(applyRating(c.id, { umerLevel: -1 }, "sales", s.id)).rejects.toThrow(/0 to 5/);
    await expect(applyRating(c.id, { spendingBand: 0 }, "sales", s.id)).rejects.toThrow(/1 to 5/);
    await expect(applyRating(c.id, { gutStars: 6 }, "sales", s.id)).rejects.toThrow(/1 to 5/);
    await expect(applyRating(c.id, { aiLevel: 2.5 }, "sales", s.id)).rejects.toBeInstanceOf(ContactValidationError);
    await expect(applyRating(c.id, { industry: "astronaut" }, "sales", s.id)).rejects.toThrow(/Industry/);
    await expect(applyRating(c.id, {}, "sales", s.id)).rejects.toThrow(/Nothing to rate/);
    expect(await db.select().from(ratings)).toHaveLength(0);
    const r = await applyRating(c.id, { aiLevel: 0, umerLevel: 5, spendingBand: 1, gutStars: 5 }, "sales", s.id);
    expect(r.applied.sort()).toEqual(["aiLevel", "gutStars", "spendingBand", "umerLevel"]);
  });

  it("self fills, sales overrides, self never overrides sales; every rating is kept with who and when", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead();
    const self1 = await applyRating(c.id, { aiLevel: 1, umerLevel: 2 }, "self", null);
    expect(self1.applied.sort()).toEqual(["aiLevel", "umerLevel"]);
    const sales = await applyRating(c.id, { aiLevel: 3, notes: "Uses ChatGPT weekly for invoices" }, "sales", s.id);
    expect(sales.applied).toEqual(["aiLevel"]);
    const self2 = await applyRating(c.id, { aiLevel: 5, umerLevel: 4 }, "self", null);
    expect(self2.applied).toEqual(["umerLevel"]);
    expect(self2.skipped).toEqual(["aiLevel"]);
    const imp = await applyRating(c.id, { aiLevel: 0, spendingBand: 3 }, "import", null);
    expect(imp.skipped).toEqual(["aiLevel"]);
    expect(imp.applied).toEqual(["spendingBand"]);

    const [row] = await db.select().from(contacts).where(eq(contacts.id, c.id));
    expect(row).toMatchObject({ aiLevel: 3, umerLevel: 4, spendingBand: 3 });
    expect(row.fieldSources).toMatchObject({ ai_level: "sales", umer_level: "self", spending_band: "import" });
    const history = await db.select().from(ratings).where(eq(ratings.contactId, c.id)).orderBy(ratings.createdAt);
    expect(history).toHaveLength(4);
    expect(history.map((h) => h.source)).toEqual(["self", "sales", "self", "import"]);
    expect(history[1]).toMatchObject({ ratedByUserId: s.id, aiLevel: 3, notes: "Uses ChatGPT weekly for invoices" });
    expect(history[2]).toMatchObject({ ratedByUserId: null, aiLevel: 5, umerLevel: 4 });
    // a later sales rating overrides again
    await applyRating(c.id, { umerLevel: 1 }, "sales", s.id);
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0].umerLevel).toBe(1);
  });

  it("support can never give a sales rating", async () => {
    const support = await makeUser({ role: "support" });
    const c = await lead();
    await expect(applyRating(c.id, { gutStars: 3 }, "sales", support.id)).rejects.toBeInstanceOf(ContactForbiddenError);
  });
});
