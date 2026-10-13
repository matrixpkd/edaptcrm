/**
 * Dashboard metrics against a small hand-built history. Rows are inserted directly (fast and explicit), then the
 * calculated columns are filled by the real recomputeContacts, so the cockpit is checked against the same numbers
 * the contact pages show. NOW is Tue 13 Oct 2026, 12:00 India time; "this month" is 1-13 Oct (IST).
 */
import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  contacts,
  duplicateReviews,
  enquiries,
  interactions,
  ownershipLog,
  payments,
  purchases,
  ratings,
  type NewContact,
} from "@/db/schema";
import {
  abandonedCheckoutsRecovered,
  assistedVsSelfServe,
  atRiskPool,
  beyondUmerShare,
  dataHealth,
  forecast90d,
  languageMix,
  leadsAndConversionByChannel,
  lostReasons,
  ltvByFirstDoor,
  medianDaysFirstToSecond,
  newCustomers,
  referralLeaderboard,
  repeatRate,
  revenueByFamily,
  rungMoves,
  rungMovesThisMonth,
  teamView,
} from "@/lib/dashboard/metrics";
import { monthRange, rollingRange } from "@/lib/dashboard/period";
import { recomputeContacts } from "@/lib/metrics/recompute";
import { listContacts } from "@/lib/contacts/queries";
import { makeUser, resetDb } from "../support/db";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-13T06:30:00Z");
const at = (iso: string) => new Date(iso);
const month = monthRange(NOW, TZ);

let phone = 0;
async function contact(over: Partial<NewContact>) {
  phone += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9198470${String(phone).padStart(5, "0")}`, name: `Contact ${phone}`, firstDoor: "other", ...over })
    .returning();
  return c;
}

async function purchase(
  contactId: string,
  opts: { family: string; amount: number; at: Date; status?: "paid" | "partial" | "pending" | "refunded"; assisted?: boolean; creditedUserId?: string | null; paidAt?: Date; verifiedAt?: Date; verified?: boolean },
) {
  const [p] = await db
    .insert(purchases)
    .values({
      contactId,
      productName: opts.family,
      family: opts.family,
      amount: opts.amount,
      amountInr: opts.amount,
      purchasedAt: opts.at,
      mode: opts.verified === false ? "bank_transfer" : "tagmango",
      status: opts.status ?? "paid",
      assisted: opts.assisted ?? false,
      creditedUserId: opts.creditedUserId ?? null,
    })
    .returning();
  const verified = opts.verified !== false;
  await db.insert(payments).values({
    purchaseId: p.id,
    contactId,
    kind: "payment",
    amount: opts.amount,
    amountInr: opts.amount,
    paidAt: opts.paidAt ?? opts.at,
    status: verified ? "verified" : "unverified",
    verifiedAt: verified ? (opts.verifiedAt ?? opts.paidAt ?? opts.at) : null,
    createdAt: opts.paidAt ?? opts.at,
  });
  return p;
}

async function refund(purchaseId: string, contactId: string, amount: number, when: Date) {
  await db.insert(payments).values({
    purchaseId,
    contactId,
    kind: "refund",
    amount,
    amountInr: amount,
    paidAt: when,
    status: "verified",
    verifiedAt: when,
    createdAt: when,
  });
}

async function assign(contactId: string, toUserId: string, when: Date) {
  await db.update(contacts).set({ ownerId: toUserId, firstOwnerId: toUserId, ownerAssignedAt: when }).where(eq(contacts.id, contactId));
  await db.insert(ownershipLog).values({ contactId, toUserId, reason: "Round robin", changedAt: when });
}

async function talk(contactId: string, userId: string, when: Date) {
  await db.insert(interactions).values({ contactId, userId, type: "call", outcome: "connected", occurredAt: when, createdAt: when });
}

const ids: Record<string, string> = {};
let salesA: Awaited<ReturnType<typeof makeUser>>;
let salesB: Awaited<ReturnType<typeof makeUser>>;
let support: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  await resetDb();
  salesA = await makeUser({ role: "sales", name: "Asha" });
  salesB = await makeUser({ role: "sales", name: "Biju" });
  support = await makeUser({ role: "support", name: "Sana" });
  await makeUser({ role: "sales", name: "Idle Ikbal" });
  await makeUser({ role: "sales", name: "Gone Gopi", active: false });

  // C2: a returning customer. Workshop in April, Applied AI Mastery this month (assisted, credited to Asha).
  const c2 = await contact({
    name: "Meera Repeat",
    firstChannel: "meta_lead_form",
    firstDoor: "meta_ad",
    createdAt: at("2026-03-01T06:30:00Z"),
    language: "en",
    umerLevel: 4,
  });
  ids.c2 = c2.id;
  await purchase(c2.id, { family: "workshop", amount: 699, at: at("2026-04-01T06:30:00Z") });
  await talk(c2.id, salesA.id, at("2026-10-01T05:00:00Z"));
  await purchase(c2.id, { family: "applied_ai_mastery", amount: 30000, at: at("2026-10-05T06:30:00Z"), assisted: true, creditedUserId: salesA.id });

  // C1: new this month through a TagMango checkout that was abandoned, then recovered. Referred by C2.
  const c1 = await contact({
    name: "Arun New",
    firstChannel: "tagmango_checkout",
    firstDoor: "youtube",
    createdAt: at("2026-10-02T02:00:00Z"),
    language: "ml",
    umerLevel: 1,
    referredById: c2.id,
  });
  ids.c1 = c1.id;
  await assign(c1.id, salesA.id, at("2026-10-02T02:30:00Z"));
  await talk(c1.id, salesA.id, at("2026-10-02T04:30:00Z")); // 2 hours after assignment
  await db.insert(enquiries).values({ contactId: c1.id, channel: "tagmango_checkout", status: "recovered", receivedAt: at("2026-10-02T03:00:00Z") });
  await purchase(c1.id, { family: "workshop", amount: 999, at: at("2026-10-02T06:30:00Z") });

  // C3: September workshop, part refunded this month. Familiarity and language not recorded, never rated.
  const c3 = await contact({ name: "Unrated Customer", firstChannel: "walk_in_event", firstDoor: "mla_program", createdAt: at("2026-09-05T06:30:00Z") });
  ids.c3 = c3.id;
  const p4 = await purchase(c3.id, { family: "workshop", amount: 999, at: at("2026-09-10T06:30:00Z") });
  await refund(p4.id, c3.id, 500, at("2026-10-03T06:30:00Z"));

  // C4: The AI Office by bank transfer on 25 Sep, verified on 2 Oct: counts in September (the day the money moved).
  const c4 = await contact({ name: "Dubai Owner", firstChannel: "whatsapp_api", firstDoor: "youtube", createdAt: at("2026-09-20T06:30:00Z"), language: "ar", umerLevel: 2 });
  ids.c4 = c4.id;
  await purchase(c4.id, { family: "ai_office", amount: 50000, at: at("2026-09-25T06:30:00Z"), verifiedAt: at("2026-10-02T06:30:00Z") });

  // C5, C6: new leads this month. Asha calls C5 four hours after assignment; nobody calls C6.
  const c5 = await contact({ name: "Lead Five", firstChannel: "meta_lead_form", firstDoor: "meta_ad", createdAt: at("2026-10-08T04:00:00Z") });
  ids.c5 = c5.id;
  await assign(c5.id, salesA.id, at("2026-10-08T04:30:00Z"));
  await talk(c5.id, salesA.id, at("2026-10-08T08:30:00Z"));
  await db.insert(enquiries).values({ contactId: c5.id, channel: "meta_lead_form", receivedAt: at("2026-10-08T04:00:00Z") });
  // support talking to a lead is not sales handling
  await talk(c5.id, support.id, at("2026-10-09T08:30:00Z"));
  const c6 = await contact({ name: "Lead Six", firstChannel: "meta_lead_form", firstDoor: "meta_ad", createdAt: at("2026-10-09T03:00:00Z") });
  ids.c6 = c6.id;
  await assign(c6.id, salesB.id, at("2026-10-09T03:30:00Z"));

  // C11: Biju adds a lead by hand after a call: the call happened 10 minutes before the contact existed, but was
  // logged a minute after he was assigned. That is an immediate response, not "never contacted".
  const c11 = await contact({ name: "Called First", firstChannel: "phone_call", firstDoor: "other", createdAt: at("2026-10-10T03:30:00Z") });
  ids.c11 = c11.id;
  await assign(c11.id, salesB.id, at("2026-10-10T03:30:00Z"));
  await db.insert(interactions).values({
    contactId: c11.id,
    userId: salesB.id,
    type: "call",
    outcome: "interested",
    occurredAt: at("2026-10-10T03:20:00Z"),
    createdAt: at("2026-10-10T03:31:00Z"),
  });
  // an interaction made and logged before an assignment is not a response to it
  await talk(c6.id, salesB.id, at("2026-10-09T03:00:00Z"));

  // C7: a bank transfer claimed on 10 Oct, still unverified (stale after 2 days).
  const c7 = await contact({ name: "Pending Payer", firstChannel: "phone_call", firstDoor: "referral", createdAt: at("2026-10-10T03:00:00Z") });
  ids.c7 = c7.id;
  await purchase(c7.id, { family: "workshop", amount: 5000, at: at("2026-10-10T04:00:00Z"), status: "pending", verified: false });

  // C8: abandoned checkout this month, not recovered. C9: a recovered checkout in August (outside the period).
  const c8 = await contact({ name: "Cart Left", firstChannel: "tagmango_checkout", firstDoor: "meta_ad", createdAt: at("2026-10-05T03:00:00Z") });
  ids.c8 = c8.id;
  await db.insert(enquiries).values({ contactId: c8.id, channel: "tagmango_checkout", status: "abandoned", receivedAt: at("2026-10-05T03:00:00Z") });
  const c9 = await contact({ name: "Old Recovery", firstChannel: "tagmango_checkout", firstDoor: "youtube", createdAt: at("2026-08-01T03:00:00Z") });
  ids.c9 = c9.id;
  await db.insert(enquiries).values({ contactId: c9.id, channel: "tagmango_checkout", status: "recovered", receivedAt: at("2026-08-01T03:00:00Z") });
  await purchase(c9.id, { family: "workshop", amount: 799, at: at("2026-08-01T05:00:00Z") });
  await db.insert(ratings).values({ contactId: c9.id, source: "self", notes: "self-rated at the door" });

  // C10: merged into C1 (never counted anywhere); duplicate reviews: one open and live, one involving C10, one dismissed.
  const c10 = await contact({ name: "Merged Away", firstChannel: "import", firstDoor: "youtube", createdAt: at("2026-10-03T03:00:00Z"), mergedIntoId: c1.id });
  ids.c10 = c10.id;
  await db.insert(duplicateReviews).values([
    { contactAId: c5.id, contactBId: c6.id, reason: "Same name and city" },
    { contactAId: c1.id, contactBId: c10.id, reason: "Same name and city" },
    { contactAId: c3.id, contactBId: c4.id, reason: "Same name and city", status: "dismissed" },
  ]);

  await recomputeContacts(
    Object.entries(ids)
      .filter(([k]) => k !== "c10")
      .map(([, v]) => v),
    db,
    { now: NOW },
  );
  // cohorts are empty in this fixture, so set the forecast columns by hand
  await db.update(contacts).set({ expected90dInr: 300, atRisk: false }).where(eq(contacts.id, c1.id));
  await db.update(contacts).set({ expected90dInr: 1000, atRisk: true }).where(eq(contacts.id, c2.id));
  await db.update(contacts).set({ expected90dInr: 2000, atRisk: false }).where(eq(contacts.id, c4.id));
  await db.update(contacts).set({ expected90dInr: 0, atRisk: false }).where(inArray(contacts.id, [c3.id, c9.id]));
});

describe("dashboard metrics", () => {
  it("the fixture's calculated columns come from the real recompute", async () => {
    const [c2] = await db.select().from(contacts).where(eq(contacts.id, ids.c2));
    expect(c2).toMatchObject({ purchaseCount: 2, ltvInr: 30699, currentRung: 2, referralCount: 1, networkValueInr: 999 });
    const [c3] = await db.select().from(contacts).where(eq(contacts.id, ids.c3));
    expect(c3).toMatchObject({ purchaseCount: 1, ltvInr: 499 });
  });

  it("revenue by family: this month vs last month, net of refunds, dated by when the money moved", async () => {
    const r = await revenueByFamily(month);
    expect(r.rows).toEqual([
      expect.objectContaining({ family: "workshop", label: "Workshops", current: 499, previous: 999, previousToDate: 999 }),
      expect.objectContaining({ family: "applied_ai_mastery", current: 30000, previous: 0, previousToDate: 0 }),
      expect.objectContaining({ family: "ai_office", label: "The AI Office", current: 0, previous: 50000, previousToDate: 0 }),
    ]);
    expect(r.totals).toEqual({ current: 30499, previous: 50999, previousToDate: 999 });
    // the unverified bank transfer never counts
    expect(r.rows.some((x) => x.current === 5000 || x.current === 5499)).toBe(false);
  });

  it("new customers this month and last", async () => {
    expect(await newCustomers(month)).toEqual({ current: 1, previous: 2, previousToDate: 1 });
  });

  it("leads and conversion by first channel, plus enquiries by channel", async () => {
    const r = await leadsAndConversionByChannel(month);
    const byKey = Object.fromEntries(r.rows.map((x) => [x.channel, x]));
    expect(byKey.tagmango_checkout).toMatchObject({ label: "TagMango checkout", leads: 2, converted: 1, conversion: 0.5, enquiries: 2, enquiringContacts: 2 });
    expect(byKey.meta_lead_form).toMatchObject({ leads: 2, converted: 0, conversion: 0, enquiries: 1 });
    expect(byKey.phone_call).toMatchObject({ leads: 2, converted: 0 });
    // the merged contact (channel import) is not a lead
    expect(byKey.import).toBeUndefined();
    expect(r.totals).toMatchObject({ leads: 6, converted: 1, enquiries: 3 });
    expect(r.totals.conversion).toBeCloseTo(1 / 6, 6);
    expect(r.rows[0].leads).toBeGreaterThanOrEqual(r.rows[r.rows.length - 1].leads);
  });

  it("LTV by First Door (all time)", async () => {
    const r = await ltvByFirstDoor();
    const byDoor = Object.fromEntries(r.rows.map((x) => [x.door, x]));
    expect(byDoor.youtube).toMatchObject({ label: "YouTube", contacts: 3, customers: 3, totalLtvInr: 51798 });
    expect(byDoor.youtube.avgLtvInr).toBeCloseTo(17266, 0);
    expect(byDoor.meta_ad).toMatchObject({ contacts: 4, customers: 1, totalLtvInr: 30699, avgLtvInr: 30699, conversion: 0.25 });
    expect(byDoor.mla_program).toMatchObject({ customers: 1, totalLtvInr: 499 });
    expect(r.rows[0].door).toBe("youtube");
    expect(r.totals).toMatchObject({ customers: 5, totalLtvInr: 51798 + 30699 + 499 });
  });

  it("repeat rate and median days from first to second purchase", async () => {
    expect(await repeatRate()).toEqual({ customers: 5, repeaters: 1, rate: 0.2 });
    expect(await medianDaysFirstToSecond()).toEqual({ medianDays: 187, customers: 1 });
  });

  it("rung moves this month: one climbed 1 -> 2, one stepped onto rung 1", async () => {
    const r = await rungMoves(month);
    expect(r.moves).toEqual([
      { from: 0, to: 1, fromLabel: "Not on the ladder", toLabel: "Rung 1: Workshops", customers: 1 },
      { from: 1, to: 2, fromLabel: "Rung 1: Workshops", toLabel: "Rung 2: Applied AI Mastery", customers: 1 },
    ]);
    expect(r.climbed).toBe(1);
    expect(r.entered).toBe(1);
    expect(await rungMovesThisMonth(NOW, TZ)).toEqual(r);
    // September: C3 and C4 stepped on (C4 straight to rung 3)
    const sep = await rungMoves({ start: month.prevStart, end: month.prevEnd });
    expect(sep.moves).toEqual([
      expect.objectContaining({ from: 0, to: 1, customers: 1 }),
      expect.objectContaining({ from: 0, to: 3, customers: 1 }),
    ]);
    expect(sep.climbed).toBe(0);
  });

  it("90-day forecast and the at-risk pool", async () => {
    expect(await forecast90d()).toEqual({ totalInr: 3300, customers: 3 });
    expect(await atRiskPool()).toEqual({ count: 1, expectedInr: 1000, ltvInr: 30699 });
  });

  it("abandoned checkouts recovered and the revenue saved", async () => {
    expect(await abandonedCheckoutsRecovered(month)).toEqual({
      abandoned: 2,
      recovered: 1,
      stillOpen: 1,
      recoveryRate: 0.5,
      revenueSavedInr: 999,
      recoveringPurchases: 1,
    });
    const aug = await abandonedCheckoutsRecovered({ start: at("2026-07-31T18:30:00Z"), end: at("2026-08-31T18:30:00Z") });
    expect(aug).toMatchObject({ abandoned: 1, recovered: 1, revenueSavedInr: 799 });
  });

  it("assisted vs self-serve revenue", async () => {
    const r = await assistedVsSelfServe(month);
    expect(r.assisted).toEqual({ inr: 30000, purchases: 1, customers: 1, perCustomerInr: 30000 });
    // C1's 999 minus C3's 500 refund; the refund lowers revenue but is not a purchase
    expect(r.selfServe).toEqual({ inr: 499, purchases: 1, customers: 1, perCustomerInr: 499 });
    expect(r.totalInr).toBe(30499);
    expect(r.assistedShare).toBeCloseTo(30000 / 30499, 6);
  });

  it("team view: first response, contacts handled, conversion and assisted revenue per person", async () => {
    const rows = await teamView(month);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.Asha).toMatchObject({
      assigned: 2,
      responded: 2,
      medianResponseHours: 3,
      handled: 3,
      interactions: 3,
      leads: 2,
      converted: 1,
      conversion: 0.5,
      assistedInr: 30000,
    });
    // C6 never answered (the 9 Oct call was before the assignment); C11 answered at once
    expect(by.Biju).toMatchObject({ assigned: 2, responded: 1, medianResponseHours: 0, leads: 2, converted: 0, handled: 2, assistedInr: 0 });
    // an idle active salesperson shows as zeros; inactive people with no numbers and support are left out
    expect(by["Idle Ikbal"]).toMatchObject({ assigned: 0, handled: 0, assistedInr: 0 });
    expect(by["Gone Gopi"]).toBeUndefined();
    expect(by.Sana).toBeUndefined();
    expect(rows[0].name).toBe("Asha");
  });

  it("Beyond-Umer share: familiarity 0-2 over rated revenue; unrated shown separately", async () => {
    const r = await beyondUmerShare(month);
    expect(r.current).toEqual({ beyondInr: 999, circleInr: 30000, unratedInr: -500, share: 999 / 30999 });
    expect(r.previous).toEqual({ beyondInr: 50000, circleInr: 0, unratedInr: 999, share: 1 });
    expect(r.trend.map((t) => t.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    const aug = r.trend.find((t) => t.month === "2026-08")!;
    // C9 has a ratings row (notes only) but no familiarity: unrated
    expect(aug).toMatchObject({ beyondInr: 0, circleInr: 0, unratedInr: 799, share: null });
    expect(r.trend.find((t) => t.month === "2026-10")).toMatchObject({ share: 999 / 30999 });
  });

  it("language mix: share of customers who don't speak Malayalam; unknown separately", async () => {
    const r = await languageMix(month);
    expect(r).toMatchObject({ known: 3, nonMalayalam: 2, unknown: 2, newKnown: 1, newShare: 0 });
    expect(r.share).toBeCloseTo(2 / 3, 6);
    expect(r.rows[r.rows.length - 1]).toMatchObject({ language: "", label: "Not recorded", customers: 2 });
    expect(r.rows.find((x) => x.language === "ar")).toMatchObject({ label: "Arabic", customers: 1 });
  });

  it("referral leaderboard", async () => {
    const r = await referralLeaderboard(5);
    expect(r.rows).toEqual([
      { contactId: ids.c2, name: "Meera Repeat", referralCount: 1, networkValueInr: 999, ltvInr: 30699, ownerName: null },
    ]);
    expect(r).toMatchObject({ advocates: 1, totalNetworkInr: 999 });
  });

  it("data health: unrated contacts, unverified payments, possible duplicates", async () => {
    const r = await dataHealth(NOW);
    // live contacts: C1..C9 and C11 = 10. Rated: C1, C2, C4 (familiarity) and C9 (has a ratings row).
    // Unrated: C3, C5, C6, C7, C8, C11.
    expect(r).toMatchObject({ contacts: 10, unrated: 6, unratedCustomers: 1 });
    // the tile links to the Contacts list filter, which uses the same definition: same count for an admin
    const admin = await makeUser({ role: "admin" });
    const listed = await listContacts(admin, { unrated: true }, { pageSize: 200 });
    expect(listed.total).toBe(6);
    expect(await listContacts(admin, { unrated: false }, { pageSize: 1 })).toMatchObject({ total: 10 });
    // a self-rating or an imported rating counts as a rating, as does any scale set on the contact
    const selfRated = listed.rows[0].id;
    await db.insert(ratings).values({ contactId: selfRated, source: "self", umerLevel: 2 });
    expect((await listContacts(admin, { unrated: true })).total).toBe(5);
    expect((await dataHealth(NOW)).unrated).toBe(5);
    await db.delete(ratings).where(eq(ratings.contactId, selfRated));
    expect((await dataHealth(NOW)).unrated).toBe(6);
    expect(r.unverified).toEqual({ count: 1, inr: 5000, stale: 1, staleDays: 2 });
    expect(r.duplicates).toBe(1);
  });

  it("rolling periods use the same definitions", async () => {
    const r30 = rollingRange(NOW, 30, TZ);
    const rev = await revenueByFamily(r30);
    // 13 Sep - 13 Oct: C4's 50,000 (25 Sep) is now inside the period
    expect(rev.totals.current).toBe(80499);
    // 14 Aug - 13 Sep: only C3's September workshop (C9's 1 Aug workshop is older)
    expect(rev.totals.previous).toBe(999);
  });
});

/** Runs `fn` in a transaction that is always rolled back, so extra rows never disturb the shared fixture. */
class Rollback extends Error {}
async function inRollback(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
  await expect(
    db.transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

describe("dashboard metrics: review fixes", () => {
  it("imported records and people who had already paid are not new leads", async () => {
    await inRollback(async (tx) => {
      phone += 1;
      await tx.insert(contacts).values({
        phoneE164: `+9198470${String(phone).padStart(5, "0")}`,
        name: "Imported Old Lead",
        firstDoor: "other",
        firstChannel: "import",
        createdAt: at("2026-10-06T03:00:00Z"),
        importBatchId: "00000000-0000-4000-8000-000000000001",
      });
      phone += 1;
      // added by hand this month, but a customer since January: history, not a converted lead
      await tx.insert(contacts).values({
        phoneE164: `+9198470${String(phone).padStart(5, "0")}`,
        name: "Old Customer Added Now",
        firstDoor: "other",
        firstChannel: "walk_in_event",
        createdAt: at("2026-10-06T03:00:00Z"),
        purchaseCount: 1,
        firstPurchaseAt: at("2026-01-10T06:30:00Z"),
      });
      const r = await leadsAndConversionByChannel(month, tx);
      expect(r.totals).toMatchObject({ leads: 6, converted: 1 });
      expect(r.rows.find((x) => x.channel === "import")).toBeUndefined();
      expect(r.rows.find((x) => x.channel === "walk_in_event")).toBeUndefined();
      expect(r.notLeads).toEqual({ imported: 1, alreadyCustomers: 1 });
    });
    expect((await leadsAndConversionByChannel(month)).notLeads).toEqual({ imported: 0, alreadyCustomers: 0 });
  });

  it("team view leaves out bulk moves: a leaver's handover and owners given by an import", async () => {
    await inRollback(async (tx) => {
      // Biju's lead C6 moves to Asha when Biju leaves: not a lead given to Asha
      await tx.insert(ownershipLog).values({ contactId: ids.c6, fromUserId: salesB.id, toUserId: salesA.id, reason: "Owner left the team", changedAt: at("2026-10-11T03:00:00Z") });
      // an imported old lead: its first owner comes with the import
      phone += 1;
      const [imp] = await tx
        .insert(contacts)
        .values({
          phoneE164: `+9198470${String(phone).padStart(5, "0")}`,
          name: "Imported Lead",
          firstDoor: "other",
          firstChannel: "import",
          createdAt: at("2026-10-06T03:00:00Z"),
          importBatchId: "00000000-0000-4000-8000-000000000001",
        })
        .returning();
      await tx.insert(ownershipLog).values({ contactId: imp.id, toUserId: salesA.id, reason: "Added by hand", changedAt: at("2026-10-06T03:00:01Z") });
      let by = Object.fromEntries((await teamView(month, tx)).map((r) => [r.name, r]));
      expect(by.Asha).toMatchObject({ assigned: 2, leads: 2 });
      // a manager later hands that imported lead to Biju on purpose: that one counts
      await tx.insert(ownershipLog).values({ contactId: imp.id, fromUserId: salesA.id, toUserId: salesB.id, reason: "Better fit", changedAt: at("2026-10-07T03:00:00Z") });
      by = Object.fromEntries((await teamView(month, tx)).map((r) => [r.name, r]));
      expect(by.Biju).toMatchObject({ assigned: 3, leads: 3 });
      expect(by.Asha).toMatchObject({ assigned: 2, leads: 2 });
    });
  });

  it("lost reasons in the period, as product feedback", async () => {
    expect(await lostReasons(month)).toEqual({ rows: [], total: 0 });
    await inRollback(async (tx) => {
      const lost = (id: string, reason: string | null, when: string) =>
        tx.update(contacts).set({ stage: "lost", lostReason: reason, stageChangedAt: at(when) }).where(eq(contacts.id, id));
      await lost(ids.c5, "price", "2026-10-10T06:30:00Z");
      await lost(ids.c6, "price", "2026-10-11T06:30:00Z");
      await lost(ids.c11, "timing", "2026-10-12T06:30:00Z");
      // marked lost last month: outside the period
      await lost(ids.c8, "not_interested", "2026-09-20T06:30:00Z");
      const r = await lostReasons(month, tx);
      expect(r).toEqual({
        rows: [
          { reason: "price", label: "Price", contacts: 2 },
          { reason: "timing", label: "Timing", contacts: 1 },
        ],
        total: 3,
      });
      expect((await lostReasons({ start: month.prevStart, end: month.prevEnd }, tx)).rows).toEqual([
        { reason: "not_interested", label: "Not interested", contacts: 1 },
      ]);
    });
  });
});
