/**
 * Calibration report: conversion and repeat rates by grade, score band and each input, over matured populations
 * (window = thresholds.repeatWindowDays). NOW is 13 Oct 2026, so leads must be created by 15 Jul and customers
 * must have first paid by 15 Jul to count.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { contacts, purchases, type NewContact } from "@/db/schema";
import { calibration, type CalibrationReport } from "@/lib/dashboard/calibration";
import { getSetting, setSetting } from "@/lib/settings";
import { makeUser, resetDb } from "../support/db";

const NOW = new Date("2026-10-13T06:30:00Z");
const at = (iso: string) => new Date(`${iso}T06:30:00Z`);

let n = 0;
async function contact(over: Partial<NewContact>) {
  n += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9197450${String(n).padStart(5, "0")}`, name: `Cal ${n}`, firstDoor: "other", ...over })
    .returning();
  return c;
}
async function bought(contactId: string, day: string, status: "paid" | "partial" | "pending" = "paid") {
  await db.insert(purchases).values({
    contactId,
    productName: "Workshop",
    family: "workshop",
    amount: 999,
    amountInr: 999,
    purchasedAt: at(day),
    mode: "tagmango",
    status,
  });
}

const table = (r: CalibrationReport, dim: string) => r.tables.find((t) => t.dim === dim)!;
const row = (r: CalibrationReport, dim: string, label: string) => table(r, dim).rows.find((x) => x.label === label);

let report: CalibrationReport;

beforeAll(async () => {
  await resetDb();
  // L1: converted in 19 days, bought again 21 days later
  const l1 = await contact({
    createdAt: at("2026-05-01"),
    grade: "A",
    edaptScore: 82,
    spendingBand: 5,
    industry: "business_owner",
    ageBand: "35-44",
    city: "Kochi",
    country: "IN",
    umerLevel: 3,
    aiLevel: 2,
    gutStars: 5,
    firstDoor: "youtube",
  });
  await bought(l1.id, "2026-05-20");
  await bought(l1.id, "2026-06-10");
  // L2: GCC by phone, paid only after 90 days (not converted; as a customer not matured yet)
  const l2 = await contact({ createdAt: at("2026-05-01"), grade: "A", edaptScore: 78, spendingBand: 5, phoneCountry: "AE", firstDoor: "youtube" });
  await bought(l2.id, "2026-09-15");
  // L3: rest of Kerala, converted in 4 days, never again
  const l3 = await contact({
    createdAt: at("2026-06-01"),
    grade: "B",
    edaptScore: 65,
    spendingBand: 3,
    industry: "teacher",
    country: "IN",
    state: "Kerala",
    city: "Malappuram",
    firstDoor: "mla_program",
  });
  await bought(l3.id, "2026-06-05");
  // a pending (unverified) purchase is not a conversion
  const l4 = await contact({ createdAt: at("2026-06-01"), grade: "D", edaptScore: 30, firstDoor: "meta_ad" });
  await bought(l4.id, "2026-06-03", "pending");
  // L5: imported history, a customer long before the CRM saw them: not a lead, but a matured repeat customer
  const l5 = await contact({ createdAt: at("2026-06-01"), grade: "A", edaptScore: 95, firstDoor: "delegation" });
  await bought(l5.id, "2026-01-10");
  await bought(l5.id, "2026-02-01");
  // an old lead brought in by an import (never paid): a record, not an inbound lead, so it is not judged
  await contact({ createdAt: at("2026-05-01"), grade: "A", edaptScore: 80, firstDoor: "youtube", importBatchId: "00000000-0000-4000-8000-000000000001" });
  // too recent to judge, and a merged contact: both left out
  await contact({ createdAt: at("2026-10-01"), grade: "A", edaptScore: 90, firstDoor: "youtube" });
  await contact({ createdAt: at("2026-05-01"), grade: "A", edaptScore: 90, firstDoor: "youtube", mergedIntoId: l1.id });
  report = await calibration(NOW);
});

describe("calibration report", () => {
  it("counts matured leads and customers only", () => {
    expect(report.windowDays).toBe(90);
    expect(report.minN).toBe(30);
    expect(report.totals).toEqual({ leads: 4, converted: 2, conversion: 0.5, customers: 3, repeated: 2, repeatRate: 2 / 3 });
    expect(report.firstPurchaseAt?.toISOString()).toBe(at("2026-01-10").toISOString());
  });

  it("conversion and repeat by grade, A to D", () => {
    expect(table(report, "grade").rows.map((r) => r.key)).toEqual(["A", "B", "D"]);
    expect(row(report, "grade", "A · 75 and above")).toMatchObject({
      leads: 2,
      converted: 1,
      conversion: 0.5,
      customers: 2,
      repeated: 2,
      repeatRate: 1,
      lowLeads: true,
      lowCustomers: true,
      points: null,
    });
    expect(row(report, "grade", "B · 60 to 74")).toMatchObject({ leads: 1, converted: 1, customers: 1, repeated: 0, repeatRate: 0 });
    expect(row(report, "grade", "D · under 40")).toMatchObject({ leads: 1, converted: 0, customers: 0, repeatRate: null });
  });

  it("10-point score bands, highest first", () => {
    expect(table(report, "score_band").rows.map((r) => r.label)).toEqual(["90–100", "80–89", "70–79", "60–69", "30–39"]);
    expect(row(report, "score_band", "90–100")).toMatchObject({ leads: 0, customers: 1, repeated: 1 });
    expect(row(report, "score_band", "70–79")).toMatchObject({ leads: 1, converted: 0, customers: 0 });
  });

  it("each input with today's points; unknowns last", () => {
    expect(table(report, "spending_band").rows.map((r) => [r.label, r.points, r.leads])).toEqual([
      ["3 · Middle", 15, 1],
      ["5 · High", 25, 2],
      ["Not rated", 10, 1],
    ]);
    expect(row(report, "industry", "Business owner")).toMatchObject({ points: 25, leads: 1, converted: 1, customers: 1, repeated: 1 });
    expect(row(report, "umer_level", "Not rated (counts as 1)")).toMatchObject({ points: 8, leads: 3 });
    expect(row(report, "umer_level", "3 · Watches regularly and can recall his ideas")).toMatchObject({ points: 24, leads: 1 });
    expect(row(report, "ai_level", "2 · Uses AI now and then for simple tasks")).toMatchObject({ points: 30 });
    expect(row(report, "gut_stars", "5 stars")).toMatchObject({ points: 10, leads: 1 });
    expect(table(report, "first_door").rows.map((r) => r.label)).toEqual(["YouTube", "Meta ad", "MLA or constituency program", "Delegation"]);
    expect(table(report, "first_door").pointsLabel).toBeNull();
  });

  it("classes locations with the scoring rules (GCC by phone, Kerala cities, rest of Kerala)", () => {
    expect(table(report, "location").rows.map((r) => [r.key, r.leads, r.customers])).toEqual([
      ["gcc", 1, 0],
      ["kerala_city_or_metro", 1, 1],
      ["rest_of_kerala", 1, 1],
      ["unknown", 1, 1],
    ]);
    expect(row(report, "location", "GCC")?.points).toBe(25);
  });

  it("the small-sample flag and the window come from settings", async () => {
    const admin = await makeUser({ role: "admin" });
    const t = await getSetting("thresholds");
    await setSetting("thresholds", { ...t, cohortMinSize: 2 }, admin.id);
    const r = await calibration(NOW);
    expect(row(r, "grade", "A · 75 and above")).toMatchObject({ lowLeads: false, lowCustomers: false });
    expect(row(r, "grade", "B · 60 to 74")).toMatchObject({ lowLeads: true });

    // a 15-day window: L3 (4 days) still converts; L1 took 19 days, so it no longer does, and its repeat
    // (21 days after the first purchase) no longer counts either
    await setSetting("thresholds", { ...t, repeatWindowDays: 15 }, admin.id);
    const r15 = await calibration(NOW);
    expect(r15.windowDays).toBe(15);
    // L2's first purchase (15 Sep) is now old enough to judge as a customer
    expect(row(r15, "grade", "A · 75 and above")).toMatchObject({ leads: 2, converted: 0, customers: 3, repeated: 0 });
    expect(row(r15, "grade", "B · 60 to 74")).toMatchObject({ leads: 1, converted: 1 });
    await setSetting("thresholds", t, admin.id);
  });
});
