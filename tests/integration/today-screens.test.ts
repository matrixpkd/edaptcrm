import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, interactions, tasks, type NewContact } from "@/db/schema";
import { applyRating } from "@/lib/contacts/profile";
import { ContactForbiddenError, ContactValidationError } from "@/lib/contacts/errors";
import { scoreContact } from "@/lib/metrics/scoring";
import { logFromSheet } from "@/lib/today/log";
import { loadLogScreen, loadRateScreen, rateAccess } from "@/lib/today/screens";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
async function contact(over: Partial<NewContact> = {}) {
  seq += 1;
  const [c] = await db
    .insert(contacts)
    .values({
      phoneE164: `+9198471${String(10000 + seq).padStart(5, "0")}`,
      phoneCountry: "IN",
      name: `Contact ${seq}`,
      firstDoor: "youtube",
      ...over,
    })
    .returning();
  return c;
}

describe("Log interaction screen", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("is hidden from a salesperson for a colleague's contact; open to support on any contact", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const support = await makeUser({ role: "support" });
    const c = await contact({ ownerId: s1.id });
    expect(await loadLogScreen(c.id, s2)).toBeNull();
    expect(await loadLogScreen("not-an-id", s1)).toBeNull();
    const own = await loadLogScreen(c.id, s1);
    expect(own?.canMarkLost).toBe(true);
    expect(own?.outcomes.map((o) => o.key)).toContain("not_interested");
    const sup = await loadLogScreen(c.id, support);
    expect(sup?.canMarkLost).toBe(false);
  });

  it("hides merged-away contacts", async () => {
    const s = await makeUser({ role: "sales" });
    const winner = await contact({ ownerId: s.id });
    const loser = await contact({ ownerId: s.id, mergedIntoId: winner.id });
    expect(await loadLogScreen(loser.id, s)).toBeNull();
  });

  it("logs and marks lost in one go, with a follow-up task when asked", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await contact({ ownerId: s.id });
    const due = new Date(Date.now() + 86_400_000);
    await logFromSheet(
      c.id,
      { type: "call", outcome: "interested", summary: "Wants the brochure", nextFollowUpAt: due },
      { markLost: false },
      s,
    );
    const [t] = await db.select().from(tasks).where(eq(tasks.contactId, c.id));
    expect(t).toMatchObject({ type: "follow_up", userId: s.id, status: "open" });

    const r = await logFromSheet(c.id, { type: "call", outcome: "not_interested" }, { markLost: true, lostReason: "not_interested" }, s);
    expect(r.contact).toMatchObject({ stage: "lost", lostReason: "not_interested" });
  });

  it("rolls the interaction back when the Lost change is refused", async () => {
    const s = await makeUser({ role: "sales" });
    const support = await makeUser({ role: "support" });
    const c = await contact({ ownerId: s.id });
    await expect(
      logFromSheet(c.id, { type: "call", outcome: "wrong_number" }, { markLost: true, lostReason: "made_up" }, s),
    ).rejects.toBeInstanceOf(ContactValidationError);
    await expect(
      logFromSheet(c.id, { type: "note", summary: "x" }, { markLost: true, lostReason: "wrong_number" }, support),
    ).rejects.toBeInstanceOf(ContactForbiddenError);
    expect(await db.select().from(interactions).where(eq(interactions.contactId, c.id))).toHaveLength(0);
    const [row] = await db.select().from(contacts).where(eq(contacts.id, c.id));
    expect(row.stage).toBe("new");
    expect(row.ownerId).toBe(s.id);
  });
});

describe("Rate customer screen", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("sales rate their own and pool contacts, managers any; support and colleagues cannot", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const manager = await makeUser({ role: "manager" });
    const support = await makeUser({ role: "support" });
    const mine = await contact({ ownerId: s1.id });
    const pool = await contact({ ownerId: null });
    expect((await rateAccess(mine.id, s1))?.canRate).toBe(true);
    expect((await rateAccess(pool.id, s1))?.canRate).toBe(true);
    expect(await rateAccess(mine.id, s2)).toBeNull();
    expect((await rateAccess(mine.id, manager))?.canRate).toBe(true);
    expect((await rateAccess(mine.id, support))?.canRate).toBe(false);
    expect((await loadRateScreen(mine.id, support))?.canRate).toBe(false);
  });

  it("shows who rated last and when, the GCC bands for GCC contacts, and what the preview needs", async () => {
    const s = await makeUser({ role: "sales", name: "Asha Nair" });
    const c = await contact({ ownerId: s.id, phoneE164: "+971501234567", phoneCountry: "AE", country: "AE" });
    let screen = await loadRateScreen(c.id, s);
    expect(screen?.lastRating).toBeNull();
    expect(screen?.gcc).toBe(true);

    await applyRating(c.id, { aiLevel: 3, umerLevel: 4, spendingBand: 5, industry: "business_owner", ageBand: "35-44" }, "sales", s.id);
    screen = await loadRateScreen(c.id, s);
    expect(screen?.lastRating).toMatchObject({ source: "sales", byName: "Asha Nair" });
    expect(screen?.contact).toMatchObject({ aiLevel: 3, umerLevel: 4, spendingBand: 5, industry: "business_owner" });
    expect(screen?.contact.fieldSources).toMatchObject({ ai_level: "sales" });

    // the browser preview, fed the same inputs, lands on the score the server stored
    const p = screen!.preview;
    const preview = scoreContact(
      {
        ...p.base,
        lastPurchaseAt: p.base.lastPurchaseAt ? new Date(p.base.lastPurchaseAt) : null,
        lastInterestAt: p.base.lastInterestAt ? new Date(p.base.lastInterestAt) : null,
        aiLevel: 3,
        umerLevel: 4,
        spendingBand: 5,
        industry: "business_owner",
        ageBand: "35-44",
        gutStars: null,
      },
      p.scoring,
      { locations: p.locations, gccCountries: p.gccCountries },
      new Date(p.now),
    );
    expect(preview.fit).toBe(100);
    expect(preview.fit).toBe(screen!.contact.fit);
    expect(preview.edaptScore).toBe(screen!.contact.edaptScore);
    expect(preview.grade).toBe(screen!.contact.grade);
  });
});
