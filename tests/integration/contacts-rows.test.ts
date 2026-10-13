import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { selectContacts } from "@/lib/contacts/rows";
import { makeUser, resetDb } from "../support/db";

describe("selectContacts (the precompiled whole-contact read)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns exactly what drizzle's select returns, for every column type", async () => {
    const u = await makeUser({ role: "sales" });
    const [ref] = await db.insert(contacts).values({ phoneE164: "+919800000001", name: "Referrer", firstDoor: "youtube" }).returning();
    const [full] = await db
      .insert(contacts)
      .values({
        phoneE164: "+919800000002",
        phoneCountry: "IN",
        name: "Every Field",
        email: "every@example.com",
        altPhones: ["+919800000003"],
        altEmails: ["alt@example.com"],
        city: "Kochi",
        country: "IN",
        language: "ml",
        ageBand: "35-44",
        industry: "business_owner",
        spendingBand: 4,
        aiLevel: 3,
        umerLevel: 2,
        gutStars: 5,
        fieldSources: { umer_level: "self" },
        firstDoor: "referral",
        referredById: ref.id,
        consent: true,
        consentAt: new Date("2026-01-02T03:04:05.678Z"),
        ownerId: u.id,
        firstOwnerId: u.id,
        ownerAssignedAt: new Date("2026-02-03T04:05:06.789Z"),
        tags: ["VIP", "Legacy: Delegation"],
        ltvInr: 12345.67,
        purchaseCount: 3,
        families: ["workshop", "delegation"],
        currentRung: 1,
        repeatProb90d: 0.4321,
        expected90dInr: 999.5,
        fit: 72,
        edaptScore: 81,
        grade: "A",
        atRisk: true,
      })
      .returning();
    const drizzleRows = await db.select().from(contacts).orderBy(contacts.createdAt, contacts.id);
    const fastRows = await selectContacts(sql`true`, db, { orderBy: sql`${contacts.createdAt}, ${contacts.id}` });
    expect(fastRows).toEqual(drizzleRows);
    const [one] = await selectContacts(eq(contacts.id, full.id), db, { limit: 1, forUpdate: true });
    expect(one).toEqual(full);
    expect(one.consentAt).toBeInstanceOf(Date);
    expect(typeof one.ltvInr).toBe("number");
    expect(await selectContacts(eq(contacts.phoneE164, "+910000000000"), db)).toEqual([]);
  });
});
