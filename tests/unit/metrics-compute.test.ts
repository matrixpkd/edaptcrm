import { describe, expect, it } from "vitest";
import {
  computeCalculatedColumns,
  EMPTY_ACTIVITY_FACTS,
  EMPTY_MONEY_FACTS,
  EMPTY_REFERRAL_FACTS,
  maxDate,
  rungFor,
  type ContactInputs,
  type MetricsContext,
} from "@/lib/metrics/compute";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-10-13T06:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const ctx: MetricsContext = {
  scoring: DEFAULT_SETTINGS.scoring,
  thresholds: DEFAULT_SETTINGS.thresholds,
  locations: DEFAULT_SETTINGS.locations,
  gccCountries: DEFAULT_SETTINGS.assignment.gccCountries,
  families: DEFAULT_SETTINGS["ladder.families"],
  nboRules: DEFAULT_SETTINGS["nbo.rules"],
  cohorts: { builtAt: null, companyRate: 0.3, medianFirstGapDays: 40, cohorts: { "workshop:1": { n: 50, repeated: 10, rate: 0.2 } } },
  products: [{ id: "aam", name: "Applied AI Mastery", family: "applied_ai_mastery", rung: 2, listPrice: 25000, currency: "INR", active: true }],
  toInr: (a, c) => (c === "INR" ? a : Number.NaN),
};

const contact = (over: Partial<ContactInputs> = {}): ContactInputs => ({
  id: "c1",
  stage: "new",
  stageChangedAt: ago(30),
  lostReason: null,
  createdAt: ago(30),
  spendingBand: null,
  industry: null,
  ageBand: null,
  country: "IN",
  state: "Kerala",
  city: "Malappuram",
  phoneCountry: "IN",
  umerLevel: null,
  aiLevel: null,
  gutStars: null,
  tags: [],
  firstDoor: "youtube",
  ...over,
});

describe("computeCalculatedColumns", () => {
  it("a lead: no value, no repeat metrics, the free-only offer, no expected revenue", () => {
    const r = computeCalculatedColumns(
      contact(),
      { money: EMPTY_MONEY_FACTS, referral: EMPTY_REFERRAL_FACTS, activity: { ...EMPTY_ACTIVITY_FACTS, lastEnquiryAt: ago(1), lastActivityAt: ago(1), lastEnquiryOrPaymentAt: ago(1) } },
      ctx,
      NOW,
    );
    expect(r.columns).toMatchObject({
      stage: "new",
      fit: 47,
      readiness: 53,
      value: null,
      edaptScore: 50,
      grade: "C",
      avgGapDays: null,
      nextExpectedAt: null,
      atRisk: false,
      repeatProb90d: null,
      nextOffer: "Entry workshop (₹699 to ₹999)",
      nextOfferProductId: null,
      expected90dInr: null,
      ltvInr: 0,
      scoredAt: NOW,
    });
    expect(r.stageChange).toBeNull();
    expect(r.columns.stageChangedAt).toEqual(ago(30));
    expect(r.nboRuleId).toBe("free");
  });

  it("worked example 3 as a customer: 47/53/30/40/C, cohort probability x offer price", () => {
    const money = {
      ...EMPTY_MONEY_FACTS,
      ltvInr: 699,
      purchaseCount: 1,
      families: ["workshop"],
      familyCount: 1,
      currentRung: 1,
      firstPurchaseAt: ago(5),
      lastPurchaseAt: ago(5),
      firstFamily: "workshop",
      purchaseDates: [ago(5)],
      lastVerifiedPaymentAt: ago(5),
    };
    const r = computeCalculatedColumns(
      contact(),
      { money, referral: EMPTY_REFERRAL_FACTS, activity: { ...EMPTY_ACTIVITY_FACTS, lastActivityAt: ago(5), lastEnquiryOrPaymentAt: ago(5) } },
      ctx,
      NOW,
    );
    expect([r.columns.fit, r.columns.readiness, r.columns.value, r.columns.edaptScore, r.columns.grade]).toEqual([47, 53, 30, 40, "C"]);
    expect(r.columns.stage).toBe("first_purchase");
    expect(r.stageChange).toEqual({ from: "new", to: "first_purchase" });
    expect(r.columns.stageChangedAt).toEqual(NOW);
    expect(r.columns.nextExpectedAt).toEqual(new Date(ago(5).getTime() + 40 * DAY));
    expect(r.columns.repeatProb90d).toBe(0.2);
    expect(r.columns.nextOffer).toBe("A workshop on a different topic");
    expect(r.columns.expected90dInr).toBe(199.8); // 0.2 x 999
  });

  it("expected revenue is null when the offer has no price", () => {
    const money = { ...EMPTY_MONEY_FACTS, ltvInr: 50000, purchaseCount: 1, families: ["ai_office"], familyCount: 1, currentRung: 3, firstFamily: "ai_office", purchaseDates: [ago(5)], lastPurchaseAt: ago(5) };
    const r = computeCalculatedColumns(contact(), { money, referral: EMPTY_REFERRAL_FACTS, activity: { ...EMPTY_ACTIVITY_FACTS, lastActivityAt: ago(5) } }, ctx, NOW);
    expect(r.columns.nextOffer).toBe("The AI Office renewal, and ask for referrals");
    expect(r.columns.repeatProb90d).toBe(0.3);
    expect(r.columns.expected90dInr).toBeNull();
  });

  it("leaving Lost clears the lost reason and stamps the stage change", () => {
    const r = computeCalculatedColumns(
      contact({ stage: "lost", lostReason: "price", stageChangedAt: ago(10) }),
      { money: EMPTY_MONEY_FACTS, referral: EMPTY_REFERRAL_FACTS, activity: { ...EMPTY_ACTIVITY_FACTS, lastEnquiryAt: ago(1), lastActivityAt: ago(1), lastEnquiryOrPaymentAt: ago(1) } },
      ctx,
      NOW,
    );
    expect(r.columns.stage).toBe("new");
    expect(r.columns.lostReason).toBeNull();
    expect(r.columns.stageChangedAt).toEqual(NOW);
  });

  it("staying Lost keeps the reason and the date", () => {
    const r = computeCalculatedColumns(
      contact({ stage: "lost", lostReason: "price", stageChangedAt: ago(10) }),
      { money: EMPTY_MONEY_FACTS, referral: EMPTY_REFERRAL_FACTS, activity: { ...EMPTY_ACTIVITY_FACTS, lastActivityAt: ago(1), lastEnquiryOrPaymentAt: ago(20) } },
      ctx,
      NOW,
    );
    expect(r.columns).toMatchObject({ stage: "lost", lostReason: "price", stageChangedAt: ago(10) });
    expect(r.stageChange).toBeNull();
  });

  it("helpers", () => {
    expect(maxDate(null, ago(3), undefined, ago(1), ago(2))).toEqual(ago(1));
    expect(maxDate(null, undefined)).toBeNull();
    const ladder = DEFAULT_SETTINGS["ladder.families"];
    expect(rungFor([], ladder)).toBe(0);
    expect(rungFor(["delegation", "b2b_program"], ladder)).toBe(0);
    expect(rungFor(["workshop", "delegation"], ladder)).toBe(1);
    expect(rungFor(["ai_office", "workshop", "applied_ai_mastery"], ladder)).toBe(3);
    expect(rungFor(["unknown_family"], ladder)).toBe(0);
  });
});
