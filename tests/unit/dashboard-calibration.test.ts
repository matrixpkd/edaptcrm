import { describe, expect, it } from "vitest";
import {
  buildCalibrationTables,
  calibrationTotals,
  scoreBandLabel,
  scoreBandOf,
  type CalibrationContext,
  type CalibrationRawRow,
} from "@/lib/dashboard/calibration-core";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

const ctx: CalibrationContext = {
  scoring: structuredClone(DEFAULT_SETTINGS.scoring),
  industries: DEFAULT_SETTINGS["lists.industries"],
  ageBands: DEFAULT_SETTINGS["lists.ageBands"],
  firstDoors: DEFAULT_SETTINGS["lists.firstDoors"],
  locations: DEFAULT_SETTINGS.locations,
  gccCountries: DEFAULT_SETTINGS.assignment.gccCountries,
  minN: 30,
};

const raw = (dim: string, key: string, leads: number, converted: number, customers = 0, repeated = 0): CalibrationRawRow => ({
  dim,
  key,
  leads,
  converted,
  customers,
  repeated,
});
const tableOf = (rows: CalibrationRawRow[], dim: string, c = ctx) => buildCalibrationTables(rows, c).find((t) => t.dim === dim)!;

describe("calibration tables", () => {
  it("score bands: 10 points each, 100 joins 90-100", () => {
    expect(scoreBandOf(100)).toBe(90);
    expect(scoreBandOf(89)).toBe(80);
    expect(scoreBandOf(0)).toBe(0);
    expect(scoreBandOf(null)).toBeNull();
    expect(scoreBandLabel(90)).toBe("90–100");
    expect(scoreBandLabel(40)).toBe("40–49");
  });

  it("every dimension is present, in a fixed order, even with no rows", () => {
    expect(buildCalibrationTables([], ctx).map((t) => t.dim)).toEqual([
      "grade",
      "score_band",
      "spending_band",
      "industry",
      "age_band",
      "location",
      "umer_level",
      "ai_level",
      "gut_stars",
      "first_door",
    ]);
  });

  it("grades A to D with thresholds from settings, unknown last", () => {
    const t = tableOf([raw("grade", "", 5, 1), raw("grade", "C", 40, 10), raw("grade", "A", 50, 30)], "grade");
    expect(t.rows.map((r) => r.label)).toEqual(["A · 75 and above", "C · 40 to 59", "Not scored"]);
    expect(t.rows[0]).toMatchObject({ conversion: 0.6, lowLeads: false, lowCustomers: true, repeatRate: null });
    const custom = { ...ctx, scoring: { ...ctx.scoring, grades: { A: 80, B: 65, C: 45 } } };
    expect(tableOf([raw("grade", "B", 1, 0)], "grade", custom).rows[0].label).toBe("B · 65 to 79");
  });

  it("points come from today's weights, so a weight change shows up next to the rates", () => {
    const t = tableOf([raw("ai_level", "5", 10, 1), raw("ai_level", "2", 10, 5), raw("ai_level", "", 10, 2)], "ai_level");
    expect(t.rows.map((r) => [r.key, r.points])).toEqual([
      ["2", 30],
      ["5", 14],
      ["", 15],
    ]);
    const tuned = { ...ctx, scoring: { ...ctx.scoring, readiness: { ...ctx.scoring.readiness, aiLevel: { ...ctx.scoring.readiness.aiLevel, "5": 4 } } } };
    expect(tableOf([raw("ai_level", "5", 1, 0)], "ai_level", tuned).rows[0].points).toBe(4);
    expect(tableOf([raw("gut_stars", "1", 1, 0), raw("gut_stars", "5", 1, 1)], "gut_stars").rows.map((r) => [r.label, r.points])).toEqual([
      ["5 stars", 10],
      ["1 star", -10],
    ]);
    expect(tableOf([raw("umer_level", "", 3, 0)], "umer_level").rows[0]).toMatchObject({ label: "Not rated (counts as 1)", points: 8 });
  });

  it("folds raw location keys into the scoring location classes", () => {
    const t = tableOf(
      [
        raw("location", "in||kochi|in", 10, 5),
        raw("location", "in|kerala|tirur|in", 4, 1),
        raw("location", "||cochin|", 6, 1),
        raw("location", "|||ae", 3, 3),
        raw("location", "us|||us", 2, 0),
        raw("location", "in||jaipur|in", 1, 0),
        raw("location", "|||", 7, 0),
      ],
      "location",
    );
    expect(t.rows.map((r) => [r.key, r.leads, r.converted, r.points])).toEqual([
      ["gcc", 3, 3, 25],
      ["rest_of_world", 2, 0, 20],
      ["kerala_city_or_metro", 16, 6, 18],
      ["rest_of_kerala", 4, 1, 15],
      ["rest_of_india", 1, 0, 12],
      ["unknown", 7, 0, 12],
    ]);
  });

  it("lists use their settings labels and order; first door has no points column", () => {
    const t = tableOf([raw("first_door", "referral", 2, 1), raw("first_door", "youtube", 3, 1), raw("first_door", "gone_door", 1, 0)], "first_door");
    expect(t.rows.map((r) => r.label)).toEqual(["YouTube", "Referral", "gone_door"]);
    expect(t.pointsLabel).toBeNull();
    expect(t.rows.every((r) => r.points === null)).toBe(true);
    const ind = tableOf([raw("industry", "student", 2, 0), raw("industry", "business_owner", 2, 2)], "industry");
    expect(ind.rows.map((r) => [r.label, r.points])).toEqual([
      ["Business owner", 25],
      ["Student", 5],
    ]);
  });

  it("drops buckets nobody is in and flags small cells", () => {
    const t = tableOf([raw("spending_band", "3", 0, 0, 0, 0), raw("spending_band", "4", 30, 3, 29, 9)], "spending_band");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ label: "4 · Upper-middle", lowLeads: false, lowCustomers: true, conversion: 0.1 });
  });

  it("totals come from one dimension so nobody is counted twice", () => {
    const rows = [raw("grade", "A", 10, 5, 4, 2), raw("grade", "B", 10, 1, 0, 0), raw("industry", "", 20, 6, 4, 2)];
    expect(calibrationTotals(rows)).toEqual({ leads: 20, converted: 6, conversion: 0.3, customers: 4, repeated: 2, repeatRate: 0.5 });
    expect(calibrationTotals([])).toMatchObject({ leads: 0, conversion: null, repeatRate: null });
  });
});
