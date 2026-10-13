import { describe, expect, it } from "vitest";
import {
  cohortKey,
  cohortObservations,
  computeRepeatMetrics,
  median,
  round,
  summarizeCohorts,
  type CohortTable,
} from "@/lib/metrics/repeat-core";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-10-13T06:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const thresholds = DEFAULT_SETTINGS.thresholds;

const table = (over: Partial<CohortTable> = {}): CohortTable => ({
  builtAt: NOW.toISOString(),
  companyRate: 0.2,
  medianFirstGapDays: 45,
  cohorts: {
    "workshop:1": { n: 120, repeated: 30, rate: 0.25 },
    "workshop:2": { n: 29, repeated: 20, rate: 20 / 29 },
    "applied_ai_mastery:1": { n: 30, repeated: 12, rate: 0.4 },
  },
  ...over,
});
const metrics = (facts: Parameters<typeof computeRepeatMetrics>[0], cohorts = table(), t = thresholds) =>
  computeRepeatMetrics(facts, { cohorts, thresholds: t }, NOW);

describe("repeat metrics: average gap and expected next purchase", () => {
  it("average gap = mean days between consecutive purchases (2 or more)", () => {
    const m = metrics({ purchaseDates: [ago(100), ago(70), ago(10)], firstFamily: "workshop", purchaseCount: 3 });
    expect(m.avgGapDays).toBe(45);
    expect(m.nextExpectedAt?.toISOString()).toBe(new Date(ago(10).getTime() + 45 * DAY).toISOString());
  });

  it("dates may arrive in any order; fractional gaps keep 2 decimals", () => {
    const m = metrics({ purchaseDates: [ago(0), ago(10), ago(3)], firstFamily: "workshop", purchaseCount: 3 });
    expect(m.avgGapDays).toBe(5);
    const m2 = metrics({ purchaseDates: [ago(10), ago(0), ago(3)].reverse(), firstFamily: "workshop", purchaseCount: 3 });
    expect(m2.avgGapDays).toBe(5);
    const m3 = metrics({ purchaseDates: [ago(10), ago(0)], firstFamily: "w", purchaseCount: 2 });
    expect(m3.avgGapDays).toBe(10);
    const m4 = metrics({ purchaseDates: [ago(10), ago(6.666), ago(0)], firstFamily: "w", purchaseCount: 3 });
    expect(m4.avgGapDays).toBe(5);
    const m5 = metrics({ purchaseDates: [new Date(NOW.getTime() - 10 * DAY), new Date(NOW.getTime() - 10 * DAY + 8 * 3600 * 1000)], firstFamily: "w", purchaseCount: 2 });
    expect(m5.avgGapDays).toBe(0.33);
  });

  it("one-time buyers use the median first-to-second gap", () => {
    const m = metrics({ purchaseDates: [ago(20)], firstFamily: "workshop", purchaseCount: 1 });
    expect(m.avgGapDays).toBeNull();
    expect(m.nextExpectedAt?.toISOString()).toBe(new Date(ago(20).getTime() + 45 * DAY).toISOString());
  });

  it("no expected date when neither an average nor a median gap is known", () => {
    const m = metrics({ purchaseDates: [ago(20)], firstFamily: "workshop", purchaseCount: 1 }, table({ medianFirstGapDays: null }));
    expect(m.nextExpectedAt).toBeNull();
    expect(m.atRisk).toBe(false);
  });

  it("leads have no repeat metrics", () => {
    expect(metrics({ purchaseDates: [], firstFamily: null, purchaseCount: 0 })).toEqual({
      avgGapDays: null,
      nextExpectedAt: null,
      atRisk: false,
      repeatProb90d: null,
    });
  });
});

describe("repeat metrics: at risk", () => {
  it("at risk when today is more than atRiskDays past the expected next purchase", () => {
    // expected = 100 days ago + 45 = 55 days ago -> 55 > 30
    expect(metrics({ purchaseDates: [ago(100)], firstFamily: "workshop", purchaseCount: 1 }).atRisk).toBe(true);
    // expected = 70 - 45 = 25 days ago -> not yet
    expect(metrics({ purchaseDates: [ago(70)], firstFamily: "workshop", purchaseCount: 1 }).atRisk).toBe(false);
  });

  it("exactly atRiskDays past is not yet at risk", () => {
    expect(metrics({ purchaseDates: [ago(75)], firstFamily: "workshop", purchaseCount: 1 }).atRisk).toBe(false);
    expect(metrics({ purchaseDates: [new Date(ago(75).getTime() - 60_000)], firstFamily: "workshop", purchaseCount: 1 }).atRisk).toBe(true);
  });

  it("uses the configured threshold", () => {
    expect(metrics({ purchaseDates: [ago(70)], firstFamily: "workshop", purchaseCount: 1 }, table(), { ...thresholds, atRiskDays: 10 }).atRisk).toBe(true);
  });
});

describe("repeat metrics: 90-day repeat probability", () => {
  it("uses the cohort (first family : purchases so far) when it has at least cohortMinSize customers", () => {
    expect(metrics({ purchaseDates: [ago(5)], firstFamily: "workshop", purchaseCount: 1 }).repeatProb90d).toBe(0.25);
    expect(metrics({ purchaseDates: [ago(5)], firstFamily: "applied_ai_mastery", purchaseCount: 1 }).repeatProb90d).toBe(0.4); // n = 30 exactly
  });

  it("falls back to the company rate for small or missing cohorts", () => {
    expect(metrics({ purchaseDates: [ago(50), ago(5)], firstFamily: "workshop", purchaseCount: 2 }).repeatProb90d).toBe(0.2); // n = 29
    expect(metrics({ purchaseDates: [ago(5)], firstFamily: "consulting", purchaseCount: 1 }).repeatProb90d).toBe(0.2);
    expect(metrics({ purchaseDates: [ago(5)], firstFamily: null, purchaseCount: 1 }).repeatProb90d).toBe(0.2);
  });

  it("the minimum size is configurable", () => {
    expect(metrics({ purchaseDates: [ago(50), ago(5)], firstFamily: "workshop", purchaseCount: 2 }, table(), { ...thresholds, cohortMinSize: 20 }).repeatProb90d).toBe(0.6897);
  });

  it("null when there is no history at all", () => {
    expect(metrics({ purchaseDates: [ago(5)], firstFamily: "workshop", purchaseCount: 1 }, table({ cohorts: {}, companyRate: null })).repeatProb90d).toBeNull();
  });
});

describe("cohort observations (the rule buildCohorts runs in SQL)", () => {
  it("every purchase but the last is an observation; the last only once its window has passed", () => {
    const obs = cohortObservations([ago(400), ago(380), ago(200), ago(10)], "workshop", NOW, 90);
    expect(obs).toEqual([
      { cohort: "workshop:1", repeated: true }, // 20 days later
      { cohort: "workshop:2", repeated: false }, // 180 days later
      { cohort: "workshop:3", repeated: false }, // 190 days later
    ]);
    const old = cohortObservations([ago(400), ago(300)], "workshop", NOW, 90);
    expect(old).toEqual([
      { cohort: "workshop:1", repeated: false },
      { cohort: "workshop:2", repeated: false },
    ]);
  });

  it("exactly the window counts as repeated; purchases after now are ignored", () => {
    expect(cohortObservations([ago(200), ago(110)], "w", NOW, 90)[0]).toEqual({ cohort: "w:1", repeated: true });
    expect(cohortObservations([ago(200), new Date(NOW.getTime() + DAY)], "w", NOW, 90)).toEqual([{ cohort: "w:1", repeated: false }]);
  });

  it("summarizeCohorts folds observations into rates, company rate and median first gap", () => {
    const t = summarizeCohorts(
      [
        { cohort: "workshop:1", repeated: true },
        { cohort: "workshop:1", repeated: false },
        { cohort: "workshop:1", repeated: false },
        { cohort: "workshop:2", repeated: true },
      ],
      [10, 30, 20, 50],
      NOW,
    );
    expect(t.cohorts["workshop:1"]).toEqual({ n: 3, repeated: 1, rate: 1 / 3 });
    expect(t.cohorts["workshop:2"]).toEqual({ n: 1, repeated: 1, rate: 1 });
    expect(t.companyRate).toBe(0.5);
    expect(t.medianFirstGapDays).toBe(25);
    expect(t.builtAt).toBe(NOW.toISOString());
    expect(summarizeCohorts([], [], NOW)).toEqual({ builtAt: NOW.toISOString(), companyRate: null, medianFirstGapDays: null, cohorts: {} });
  });
});

describe("helpers", () => {
  it("cohortKey", () => {
    expect(cohortKey("workshop", 2)).toBe("workshop:2");
  });
  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("round", () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(-1.005, 2)).toBe(-1.01);
    expect(round(0.68965517, 4)).toBe(0.6897);
    expect(round(0, 2)).toBe(0);
  });
});
