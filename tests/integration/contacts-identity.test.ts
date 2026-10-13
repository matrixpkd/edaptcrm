import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { captureEnquiry } from "@/lib/contacts/capture";
import {
  checkQuickAddDuplicate,
  findContactByEmail,
  findContactByPhone,
  matchContact,
} from "@/lib/contacts/identity";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const inPhone = () => `98470${String(10000 + seq++).padStart(5, "0")}`;
const e164 = (local: string) => `+91${local}`;

async function newContact(over: Partial<Parameters<typeof captureEnquiry>[0]> = {}) {
  const r = await captureEnquiry({ phone: inPhone(), channel: "phone_call", skipAlerts: true, skipAssignment: true, ...over });
  return r.contact;
}

describe("contacts identity", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("matches the exact primary phone first, from any written form", async () => {
    const local = inPhone();
    const c = await newContact({ phone: local, name: "Asha" });
    for (const written of [local, `+91 ${local}`, `0091${local}`, `91${local}`]) {
      const m = await matchContact({ phone: written });
      expect(m.contact?.id).toBe(c.id);
      if (m.contact) expect(m.matchedBy).toBe("phone");
    }
  });

  it("matches alternate phones and emails", async () => {
    const alt = inPhone();
    const c = await newContact({ name: "Biju" });
    await db.update(contacts).set({ altPhones: [e164(alt)], altEmails: ["biju.work@example.com"] }).where(eq(contacts.id, c.id));
    const byAltPhone = await matchContact({ phone: alt });
    expect(byAltPhone.contact?.id).toBe(c.id);
    expect(byAltPhone.contact && byAltPhone.matchedBy).toBe("alt_phone");
    const byAltEmail = await matchContact({ phone: inPhone(), email: "Biju.Work@Example.com" });
    expect(byAltEmail.contact?.id).toBe(c.id);
    expect(byAltEmail.contact && byAltEmail.matchedBy).toBe("alt_email");
    expect((await findContactByEmail("BIJU.WORK@example.com"))?.id).toBe(c.id);
  });

  it("matches email (case-insensitive) when the phone is unknown, and phone wins over email", async () => {
    const a = await newContact({ name: "Chitra", email: "chitra@example.com" });
    const b = await newContact({ name: "Deepa" });
    const byEmail = await matchContact({ phone: inPhone(), email: "  CHITRA@example.com " });
    expect(byEmail.contact?.id).toBe(a.id);
    expect(byEmail.contact && byEmail.matchedBy).toBe("email");
    // b's phone + a's email: phone is checked first
    const both = await matchContact({ phone: b.phoneE164, email: "chitra@example.com" });
    expect(both.contact?.id).toBe(b.id);
    expect(both.contact && both.matchedBy).toBe("phone");
  });

  it("follows merged rows to the surviving contact and never returns a merged row", async () => {
    const winner = await newContact({ name: "Eby", email: "eby@example.com" });
    const loser = await newContact({ name: "Eby K", email: "eby.k@example.com" });
    // the loser's number is NOT on the winner: only merged_into_id leads there
    await db.update(contacts).set({ mergedIntoId: winner.id, mergedAt: new Date() }).where(eq(contacts.id, loser.id));
    expect((await findContactByPhone(loser.phoneE164))?.id).toBe(winner.id);
    expect((await findContactByEmail("eby.k@example.com"))?.id).toBe(winner.id);
    const m = await matchContact({ phone: loser.phoneE164 });
    expect(m.contact?.id).toBe(winner.id);
    expect(m.contact?.mergedIntoId).toBeNull();
    // the surviving contact holding the number as an alternate wins over the merged primary row
    await db.update(contacts).set({ altPhones: [loser.phoneE164] }).where(eq(contacts.id, winner.id));
    const m2 = await matchContact({ phone: loser.phoneE164 });
    expect(m2.contact?.id).toBe(winner.id);
    expect(m2.contact && m2.matchedBy).toBe("alt_phone");
  });

  it("follows a chain of merges", async () => {
    const a = await newContact({ name: "A" });
    const b = await newContact({ name: "B" });
    const c = await newContact({ name: "C" });
    await db.update(contacts).set({ mergedIntoId: b.id }).where(eq(contacts.id, a.id));
    await db.update(contacts).set({ mergedIntoId: c.id }).where(eq(contacts.id, b.id));
    expect((await findContactByPhone(a.phoneE164))?.id).toBe(c.id);
  });

  it("same name in the same city is never a match, only a possible duplicate", async () => {
    const a = await newContact({ name: "Fathima Rasheed", profile: { city: "Kozhikode" } });
    await newContact({ name: "Fathima Rasheed", profile: { city: "Kochi" } });
    const m = await matchContact({ phone: inPhone(), name: "  fathima   RASHEED ", city: "kozhikode " });
    expect(m.contact).toBeNull();
    if (m.contact === null) expect(m.possibleDuplicates.map((c) => c.id)).toEqual([a.id]);
    const none = await matchContact({ phone: inPhone(), name: "Fathima Rasheed" });
    expect(none.contact).toBeNull();
    if (none.contact === null) expect(none.possibleDuplicates).toEqual([]);
  });

  it("returns nothing for unknown phones and emails", async () => {
    expect(await findContactByPhone("+919999999999")).toBeNull();
    expect(await findContactByEmail("nobody@example.com")).toBeNull();
    const m = await matchContact({ phone: "not a phone", email: null });
    expect(m.contact).toBeNull();
  });

  describe("checkQuickAddDuplicate", () => {
    it("reports invalid and unknown numbers", async () => {
      const sales = await makeUser({ role: "sales" });
      expect(await checkQuickAddDuplicate("123", sales)).toEqual({ valid: false, e164: null, international: null, existing: null });
      const local = inPhone();
      const r = await checkQuickAddDuplicate(local, sales);
      expect(r.valid).toBe(true);
      expect(r.e164).toBe(e164(local));
      expect(r.international).toMatch(/^\+91 /);
      expect(r.existing).toBeNull();
    });

    it("shows the existing contact and its owner before saving, even when the salesperson cannot open it", async () => {
      const owner = await makeUser({ role: "sales", name: "Rahul" });
      const other = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const support = await makeUser({ role: "support" });
      const local = inPhone();
      const c = await newContact({ phone: local, name: "Gopika", ownerId: owner.id });

      const forOther = await checkQuickAddDuplicate(`+91 ${local}`, other);
      expect(forOther.existing).toMatchObject({ id: c.id, name: "Gopika", ownerId: owner.id, ownerName: "Rahul", stage: "new", visible: false });
      expect((await checkQuickAddDuplicate(local, owner)).existing?.visible).toBe(true);
      expect((await checkQuickAddDuplicate(local, manager)).existing?.visible).toBe(true);
      expect((await checkQuickAddDuplicate(local, support)).existing?.visible).toBe(true);
    });

    it("pool contacts are visible to sales; UAE numbers typed locally are found with the dial code", async () => {
      const sales = await makeUser({ role: "sales" });
      const c = await newContact({ phone: "501234567", dialCode: "971", name: "Hamdan" });
      const r = await checkQuickAddDuplicate("050 123 4567", sales);
      expect(r.e164).toBe("+971501234567");
      expect(r.existing).toMatchObject({ id: c.id, ownerId: null, ownerName: null, visible: true });
    });
  });
});
