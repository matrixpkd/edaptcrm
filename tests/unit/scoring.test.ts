import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ScoringConfig } from "@/lib/settings/defaults";
import {
  belowPoints,
  clampScore,
  classifyLocation,
  computeEdapt,
  computeFit,
  computeReadiness,
  computeValue,
  daysSince,
  gradeFor,
  gutPoints,
  minPoints,
  normalizeCountry,
  scoreContact,
  withinDaysPoints,
  type ScoreContactInput,
} from "@/lib/metrics/scoring";

const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-10-13T06:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const cfg: ScoringConfig = structuredClone(DEFAULT_SETTINGS.scoring);
const ctx = { locations: DEFAULT_SETTINGS.locations, gccCountries: DEFAULT_SETTINGS.assignment.gccCountries };
const loc = (l: Parameters<typeof classifyLocation>[0]) => classifyLocation(l, ctx.locations, ctx.gccCountries);

describe("scoring: the four worked examples in the spec", () => {
  it("1. GCC business owner, 35-44, band 5, Umer 4, AI 3, chatted this week; ₹1.2 lakh over 4 purchases in 3 lines, last 2 months ago, 2 referrals -> 100/92/92/94/A", () => {
    const s = scoreContact(
      {
        country: "AE",
        industry: "business_owner",
        ageBand: "35-44",
        spendingBand: 5,
        umerLevel: 4,
        aiLevel: 3,
        lastInterestAt: ago(2),
        ltvInr: 120000,
        purchaseCount: 4,
        familyCount: 3,
        referralCount: 2,
        lastPurchaseAt: ago(61),
      },
      cfg,
      ctx,
      NOW,
    );
    expect([s.fit, s.readiness, s.value, s.edaptScore, s.grade]).toEqual([100, 92, 92, 94, "A"]);
    expect(s.isCustomer).toBe(true);
    expect(s.location).toBe("gcc");
    expect(s.breakdown).toEqual({
      fit: { spendingBand: 25, industry: 25, ageBand: 25, location: 25 },
      readiness: { umer: 32, ai: 30, recentInterest: 30 },
      value: { ltv: 25, frequency: 17, breadth: 20, referrals: 15, recency: 15 },
      gut: 0,
    });
  });

  it("2. New lead: Kerala-city business owner, 35-44, band 4, Umer 3, AI 2, enquired today -> 88/84/-/86/A", () => {
    const s = scoreContact(
      { country: "IN", city: "Kochi", state: "Kerala", industry: "business_owner", ageBand: "35-44", spendingBand: 4, umerLevel: 3, aiLevel: 2, lastInterestAt: NOW },
      cfg,
      ctx,
      NOW,
    );
    expect([s.fit, s.readiness, s.value, s.edaptScore, s.grade]).toEqual([88, 84, null, 86, "A"]);
    expect(s.isCustomer).toBe(false);
    expect(s.breakdown.value).toBeUndefined();
    expect(s.breakdown.fit).toEqual({ spendingBand: 20, industry: 25, ageBand: 25, location: 18 });
    expect(s.breakdown.readiness).toEqual({ umer: 24, ai: 30, recentInterest: 30 });
  });

  it("3. Workshop buyer, nothing rated, rest of Kerala, one ₹699 purchase 5 days ago -> 47/53/30/40/C", () => {
    const s = scoreContact(
      {
        country: "IN",
        state: "Kerala",
        city: "Malappuram",
        lastInterestAt: ago(5),
        ltvInr: 699,
        purchaseCount: 1,
        familyCount: 1,
        referralCount: 0,
        lastPurchaseAt: ago(5),
      },
      cfg,
      ctx,
      NOW,
    );
    expect([s.fit, s.readiness, s.value, s.edaptScore, s.grade]).toEqual([47, 53, 30, 40, "C"]);
    expect(s.breakdown).toEqual({
      fit: { spendingBand: 10, industry: 10, ageBand: 12, location: 15 },
      readiness: { umer: 8, ai: 15, recentInterest: 30 },
      value: { ltv: 5, frequency: 5, breadth: 5, referrals: 0, recency: 15 },
      gut: 0,
    });
  });

  it("4. New lead: student, 18-24, band 1, rest of India, Umer 0, AI 1, enquired 2 months ago -> 30/30/-/30/D", () => {
    const s = scoreContact(
      { country: "IN", state: "Maharashtra", city: "Nagpur", industry: "student", ageBand: "18-24", spendingBand: 1, umerLevel: 0, aiLevel: 1, lastInterestAt: ago(61) },
      cfg,
      ctx,
      NOW,
    );
    expect([s.fit, s.readiness, s.value, s.edaptScore, s.grade]).toEqual([30, 30, null, 30, "D"]);
    expect(s.location).toBe("rest_of_india");
  });
});

describe("scoring: Edapt blend, gut adjustment, clamping and grade", () => {
  const lead2: ScoreContactInput = {
    country: "IN",
    city: "Kochi",
    industry: "business_owner",
    ageBand: "35-44",
    spendingBand: 4,
    umerLevel: 3,
    aiLevel: 2,
    lastInterestAt: NOW,
  };

  it("gut stars: 1 -10, 2 -5, 3 0, 4 +5, 5 +10, unrated 0", () => {
    const by = (g: number | null) => scoreContact({ ...lead2, gutStars: g }, cfg, ctx, NOW);
    expect(by(1).edaptScore).toBe(76);
    expect(by(2).edaptScore).toBe(81);
    expect(by(3).edaptScore).toBe(86);
    expect(by(4).edaptScore).toBe(91);
    expect(by(5).edaptScore).toBe(96);
    expect(by(null).edaptScore).toBe(86);
    expect(by(1).breakdown.gut).toBe(-10);
    expect(by(5).breakdown.gut).toBe(10);
    // gut moves the grade: 76 is still A, 81 A; a 1-star C lead drops to D
    expect(by(1).grade).toBe("A");
  });

  it("invalid gut values count as unrated", () => {
    expect(gutPoints(0, cfg)).toBe(0);
    expect(gutPoints(6, cfg)).toBe(0);
    expect(gutPoints(2.5, cfg)).toBe(0);
    expect(gutPoints(undefined, cfg)).toBe(0);
    const custom = { ...cfg, gut: { ...cfg.gut, unrated: -2 } };
    expect(gutPoints(null, custom)).toBe(-2);
  });

  it("gut applies to customers too, with the customer blend", () => {
    expect(computeEdapt({ fit: 47, readiness: 53, value: 30, gutStars: 4, isCustomer: true }, cfg)).toBe(45);
    expect(computeEdapt({ fit: 47, readiness: 53, value: 30, gutStars: 1, isCustomer: true }, cfg)).toBe(30);
  });

  it("leads use 0.5F + 0.5R; customers use 0.25F + 0.25R + 0.5V", () => {
    expect(computeEdapt({ fit: 80, readiness: 40, value: null, gutStars: null, isCustomer: false }, cfg)).toBe(60);
    expect(computeEdapt({ fit: 80, readiness: 40, value: 100, gutStars: null, isCustomer: true }, cfg)).toBe(80);
    // a lead's value is ignored even if passed
    expect(computeEdapt({ fit: 80, readiness: 40, value: 100, gutStars: null, isCustomer: false }, cfg)).toBe(60);
    // a customer with no value yet counts V as 0
    expect(computeEdapt({ fit: 80, readiness: 40, value: null, gutStars: null, isCustomer: true }, cfg)).toBe(30);
  });

  it("rounds half up to a whole number", () => {
    expect(computeEdapt({ fit: 47, readiness: 52, value: null, gutStars: null, isCustomer: false }, cfg)).toBe(50); // 49.5
    expect(computeEdapt({ fit: 47, readiness: 51, value: null, gutStars: null, isCustomer: false }, cfg)).toBe(49);
    expect(computeEdapt({ fit: 47, readiness: 50, value: 31, gutStars: null, isCustomer: true }, cfg)).toBe(40); // 39.75
    expect(computeEdapt({ fit: 46, readiness: 50, value: 31, gutStars: null, isCustomer: true }, cfg)).toBe(40); // 11.5 + 12.5 + 15.5 = 39.5
    expect(computeEdapt({ fit: 46, readiness: 49, value: 31, gutStars: null, isCustomer: true }, cfg)).toBe(39); // 39.25
  });

  it("is held between 0 and 100", () => {
    expect(computeEdapt({ fit: 100, readiness: 100, value: null, gutStars: 5, isCustomer: false }, cfg)).toBe(100);
    expect(computeEdapt({ fit: 100, readiness: 100, value: 100, gutStars: 5, isCustomer: true }, cfg)).toBe(100);
    expect(computeEdapt({ fit: 5, readiness: 5, value: null, gutStars: 1, isCustomer: false }, cfg)).toBe(0);
    expect(computeEdapt({ fit: 0, readiness: 0, value: 0, gutStars: 1, isCustomer: true }, cfg)).toBe(0);
    expect(clampScore(-3)).toBe(0);
    expect(clampScore(140)).toBe(100);
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(59.5)).toBe(60);
    expect(clampScore(59.49)).toBe(59);
  });

  it("scores are clamped too when settings push a component past 100", () => {
    const big: ScoringConfig = structuredClone(cfg);
    big.fit.location.gcc = 90;
    const f = computeFit({ spendingBand: 5, industry: "business_owner", ageBand: "35-44", location: "gcc" }, big);
    expect(f.score).toBe(100);
    expect(f.breakdown.location).toBe(90);
  });

  it("grade: A >= 75, B 60-74, C 40-59, D under 40", () => {
    const g = (n: number) => gradeFor(n, cfg.grades);
    expect([g(100), g(75), g(74), g(60), g(59), g(40), g(39), g(0)]).toEqual(["A", "A", "B", "B", "C", "C", "D", "D"]);
    expect(gradeFor(70, { A: 70, B: 50, C: 30 })).toBe("A");
    expect(gradeFor(29, { A: 70, B: 50, C: 30 })).toBe("D");
  });

  it("a lead graded C drops to D with a one-star gut rating", () => {
    const s = scoreContact({ country: "IN", lastInterestAt: ago(10), gutStars: 1 }, cfg, ctx, NOW);
    // fit 10+10+12+12 = 44, readiness 8+15+20 = 43 -> 43.5 -> 44 - 10 = 34
    expect([s.fit, s.readiness, s.edaptScore, s.grade]).toEqual([44, 43, 34, "D"]);
  });
});

describe("scoring: Fit table", () => {
  const fit = (over: Partial<Parameters<typeof computeFit>[0]>) =>
    computeFit({ spendingBand: null, industry: null, ageBand: null, location: "unknown", ...over }, cfg).breakdown;

  it("spending power: band 1..5 = 5/10/15/20/25, unknown 10", () => {
    expect([1, 2, 3, 4, 5].map((b) => fit({ spendingBand: b }).spendingBand)).toEqual([5, 10, 15, 20, 25]);
    for (const v of [null, undefined, 0, 6, 2.5, -1]) expect(fit({ spendingBand: v as number | null }).spendingBand).toBe(10);
  });

  it("industry or role", () => {
    const expected: Record<string, number> = {
      business_owner: 25,
      senior_manager: 22,
      it_professional: 18,
      healthcare_professional: 18,
      government: 15,
      freelancer: 15,
      other_professional: 12,
      retired: 10,
      teacher: 8,
      homemaker: 8,
      student: 5,
    };
    for (const [k, v] of Object.entries(expected)) expect(fit({ industry: k }).industry).toBe(v);
    expect(fit({ industry: null }).industry).toBe(10);
    expect(fit({ industry: "" }).industry).toBe(10);
    expect(fit({ industry: "astronaut" }).industry).toBe(10);
    // every industry in the dropdown has points
    for (const i of DEFAULT_SETTINGS["lists.industries"]) expect(cfg.fit.industry[i.key]).toBeTypeOf("number");
  });

  it("age band", () => {
    const expected: Record<string, number> = { "35-44": 25, "45-54": 22, "25-34": 18, "55-64": 15, "65+": 10, "18-24": 8 };
    for (const [k, v] of Object.entries(expected)) expect(fit({ ageBand: k }).ageBand).toBe(v);
    expect(fit({ ageBand: null }).ageBand).toBe(12);
    expect(fit({ ageBand: "12-17" }).ageBand).toBe(12);
    for (const a of DEFAULT_SETTINGS["lists.ageBands"]) expect(cfg.fit.ageBand[a.key]).toBeTypeOf("number");
  });

  it("location points", () => {
    expect(fit({ location: "gcc" }).location).toBe(25);
    expect(fit({ location: "rest_of_world" }).location).toBe(20);
    expect(fit({ location: "kerala_city_or_metro" }).location).toBe(18);
    expect(fit({ location: "rest_of_kerala" }).location).toBe(15);
    expect(fit({ location: "rest_of_india" }).location).toBe(12);
    expect(fit({ location: "unknown" }).location).toBe(12);
  });

  it("all unknown = 10 + 10 + 12 + 12 = 44", () => {
    expect(computeFit({ location: "unknown" }, cfg).score).toBe(44);
  });
});

describe("scoring: location classification", () => {
  it("GCC countries (by country, else phone country)", () => {
    for (const c of ["AE", "SA", "QA", "KW", "BH", "OM", "ae", " AE "]) expect(loc({ country: c })).toBe("gcc");
    expect(loc({ phoneCountry: "AE" })).toBe("gcc");
    expect(loc({ country: "UAE" })).toBe("gcc");
    expect(loc({ country: "United Arab Emirates" })).toBe("gcc");
    expect(loc({ country: "Saudi Arabia", city: "Riyadh" })).toBe("gcc");
    // country beats the phone's country
    expect(loc({ country: "IN", phoneCountry: "AE" })).toBe("rest_of_india");
    expect(loc({ country: "AE", phoneCountry: "IN", city: "Kochi" })).toBe("gcc");
  });

  it("Kerala cities and Indian metros", () => {
    expect(loc({ country: "IN", city: "Kochi" })).toBe("kerala_city_or_metro");
    expect(loc({ country: "IN", city: "  KOZHIKODE " })).toBe("kerala_city_or_metro");
    expect(loc({ country: "IN", city: "Trivandrum", state: "Kerala" })).toBe("kerala_city_or_metro");
    expect(loc({ country: "IN", city: "Bengaluru" })).toBe("kerala_city_or_metro");
    expect(loc({ country: "IN", city: "New  Delhi" })).toBe("kerala_city_or_metro");
    expect(loc({ country: "IN", city: "newdelhi" })).toBe("kerala_city_or_metro");
    expect(loc({ phoneCountry: "IN", city: "Mumbai" })).toBe("kerala_city_or_metro");
    expect(loc({ country: "India", city: "Chennai" })).toBe("kerala_city_or_metro");
  });

  it("rest of Kerala", () => {
    expect(loc({ country: "IN", state: "Kerala", city: "Malappuram" })).toBe("rest_of_kerala");
    expect(loc({ country: "IN", state: "KERALA" })).toBe("rest_of_kerala");
    expect(loc({ country: "IN", state: "KL", city: "Koduvally" })).toBe("rest_of_kerala");
    expect(loc({ phoneCountry: "IN", state: " kerala " })).toBe("rest_of_kerala");
  });

  it("rest of India, including India with nothing else known", () => {
    expect(loc({ country: "IN", state: "Maharashtra", city: "Nagpur" })).toBe("rest_of_india");
    expect(loc({ country: "IN", city: "Coimbatore" })).toBe("rest_of_india");
    expect(loc({ country: "IN", state: "Tamil Nadu" })).toBe("rest_of_india");
    expect(loc({ country: "IN" })).toBe("rest_of_india");
    expect(loc({ phoneCountry: "IN" })).toBe("rest_of_india");
  });

  it("rest of world", () => {
    expect(loc({ country: "US" })).toBe("rest_of_world");
    expect(loc({ country: "GB", city: "London" })).toBe("rest_of_world");
    expect(loc({ phoneCountry: "SG" })).toBe("rest_of_world");
    // a metro name in another country is not an Indian metro
    expect(loc({ country: "US", city: "Delhi" })).toBe("rest_of_world");
  });

  it("unknown when nothing is known; a Kerala city or state alone still places them", () => {
    expect(loc({})).toBe("unknown");
    expect(loc({ country: "", state: "  ", city: null, phoneCountry: null })).toBe("unknown");
    expect(loc({ city: "Atlantis" })).toBe("unknown");
    expect(loc({ city: "Kochi" })).toBe("kerala_city_or_metro");
    expect(loc({ state: "Kerala" })).toBe("rest_of_kerala");
  });

  it("uses the configured lists", () => {
    const locations = { ...ctx.locations, keralaCities: [...ctx.locations.keralaCities, "malappuram"] };
    expect(classifyLocation({ country: "IN", city: "Malappuram" }, locations, ctx.gccCountries)).toBe("kerala_city_or_metro");
    expect(classifyLocation({ country: "AE" }, ctx.locations, ["SA"])).toBe("rest_of_world");
  });

  it("normalizeCountry", () => {
    expect(normalizeCountry(" in ")).toBe("IN");
    expect(normalizeCountry("India")).toBe("IN");
    expect(normalizeCountry("U.A.E.")).toBe("AE");
    expect(normalizeCountry("")).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });
});

describe("scoring: Readiness table", () => {
  const r = (over: Parameters<typeof computeReadiness>[0]) => computeReadiness(over, cfg, NOW).breakdown;

  it("Umer familiarity: 8 points per level; unknown counts as level 1", () => {
    expect([0, 1, 2, 3, 4, 5].map((l) => r({ umerLevel: l }).umer)).toEqual([0, 8, 16, 24, 32, 40]);
    expect(r({ umerLevel: null }).umer).toBe(8);
    expect(r({}).umer).toBe(8);
    expect(r({ umerLevel: 9 }).umer).toBe(8);
    const custom = { ...cfg, readiness: { ...cfg.readiness, umerUnknownLevel: 2, umerPointsPerLevel: 6 } };
    expect(computeReadiness({ umerLevel: null }, custom, NOW).breakdown.umer).toBe(12);
    expect(computeReadiness({ umerLevel: 5 }, custom, NOW).breakdown.umer).toBe(30);
  });

  it("AI knowledge is a curve: 0:10 1:20 2:30 3:30 4:24 5:14, unknown 15", () => {
    expect([0, 1, 2, 3, 4, 5].map((l) => r({ aiLevel: l }).ai)).toEqual([10, 20, 30, 30, 24, 14]);
    expect(r({ aiLevel: null }).ai).toBe(15);
    expect(r({ aiLevel: 7 }).ai).toBe(15);
  });

  it("recent interest: 7 days 30, 30 days 20, 90 days 10, older 0", () => {
    const at = (d: Date | null) => r({ lastInterestAt: d }).recentInterest;
    expect(at(NOW)).toBe(30);
    expect(at(ago(7))).toBe(30);
    expect(at(new Date(ago(7).getTime() - 23 * 3600 * 1000))).toBe(30); // 7 whole days
    expect(at(ago(8))).toBe(20);
    expect(at(ago(30))).toBe(20);
    expect(at(ago(31))).toBe(10);
    expect(at(ago(90))).toBe(10);
    expect(at(ago(91))).toBe(0);
    expect(at(ago(1000))).toBe(0);
    expect(at(null)).toBe(0);
    expect(at(new Date(NOW.getTime() + DAY))).toBe(30); // future-dated counts as now
  });

  it("readiness maximum is 100 and all unknown is 8 + 15 + 0 = 23", () => {
    expect(computeReadiness({ umerLevel: 5, aiLevel: 2, lastInterestAt: NOW }, cfg, NOW).score).toBe(100);
    expect(computeReadiness({}, cfg, NOW).score).toBe(23);
  });
});

describe("scoring: Value table", () => {
  const base: Parameters<typeof computeValue>[0] = { ltvInr: 0, purchaseCount: 1, familyCount: 1, referralCount: 0, lastPurchaseAt: NOW };
  const v = (over: Partial<Parameters<typeof computeValue>[0]>) => computeValue({ ...base, ...over }, cfg, NOW).breakdown;

  it("money (LTV): <1000:5, 1000-4999.99:10, 5000-19999.99:15, 20000-49999.99:20, >=50000:25", () => {
    const pts = (ltv: number) => v({ ltvInr: ltv }).ltv;
    expect(pts(-500)).toBe(5);
    expect(pts(0)).toBe(5);
    expect(pts(699)).toBe(5);
    expect(pts(999.99)).toBe(5);
    expect(pts(1000)).toBe(10);
    expect(pts(4999.99)).toBe(10);
    expect(pts(5000)).toBe(15);
    expect(pts(19999.99)).toBe(15);
    expect(pts(20000)).toBe(20);
    expect(pts(49999.99)).toBe(20);
    expect(pts(50000)).toBe(25);
    expect(pts(120000)).toBe(25);
  });

  it("frequency: 1:5, 2:10, 3:14, 4-5:17, 6+:20", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 12].map((n) => v({ purchaseCount: n }).frequency)).toEqual([0, 5, 10, 14, 17, 17, 20, 20]);
  });

  it("breadth: 1:5, 2:13, 3+:20", () => {
    expect([0, 1, 2, 3, 5].map((n) => v({ familyCount: n }).breadth)).toEqual([0, 5, 13, 20, 20]);
  });

  it("referrals (paying customers brought): 1:10, 2:15, 3+:20", () => {
    expect([0, 1, 2, 3, 9].map((n) => v({ referralCount: n }).referrals)).toEqual([0, 10, 15, 20, 20]);
  });

  it("recency of the last purchase: <=90:15, 91-180:10, 181-365:5, older 0", () => {
    const at = (d: Date | null) => v({ lastPurchaseAt: d }).recency;
    expect(at(NOW)).toBe(15);
    expect(at(ago(90))).toBe(15);
    expect(at(ago(91))).toBe(10);
    expect(at(ago(180))).toBe(10);
    expect(at(ago(181))).toBe(5);
    expect(at(ago(365))).toBe(5);
    expect(at(ago(366))).toBe(0);
    expect(at(null)).toBe(0);
  });

  it("maximum value is 100", () => {
    expect(computeValue({ ltvInr: 100000, purchaseCount: 6, familyCount: 3, referralCount: 3, lastPurchaseAt: NOW }, cfg, NOW).score).toBe(100);
  });
});

describe("scoring: threshold helpers follow the configured tables", () => {
  it("rows may be stored in any order", () => {
    expect(withinDaysPoints(10, [{ withinDays: 90, points: 10 }, { withinDays: 7, points: 30 }, { withinDays: 30, points: 20 }], 0)).toBe(20);
    expect(belowPoints(3000, [{ below: 50000, points: 20 }, { below: 1000, points: 5 }, { below: 5000, points: 10 }], 25)).toBe(10);
    expect(minPoints(4, [{ min: 1, points: 5 }, { min: 6, points: 20 }, { min: 4, points: 17 }])).toBe(17);
  });

  it("edited weights change the score with no code change", () => {
    const custom: ScoringConfig = structuredClone(cfg);
    custom.value.ltv = [{ below: 500, points: 1 }];
    custom.value.ltvTop = 7;
    expect(computeValue({ ltvInr: 699, purchaseCount: 1, familyCount: 1, referralCount: 0, lastPurchaseAt: null }, custom, NOW).breakdown.ltv).toBe(7);
    custom.blend.lead = { fit: 0.7, readiness: 0.3 };
    expect(computeEdapt({ fit: 50, readiness: 100, value: null, gutStars: null, isCustomer: false }, custom)).toBe(65);
  });

  it("daysSince counts whole days and never goes negative", () => {
    expect(daysSince(ago(3), NOW)).toBe(3);
    expect(daysSince(new Date(NOW.getTime() - 3.9 * DAY), NOW)).toBe(3);
    expect(daysSince(new Date(NOW.getTime() + 5 * DAY), NOW)).toBe(0);
  });
});
