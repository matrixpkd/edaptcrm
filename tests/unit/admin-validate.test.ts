import { describe, expect, it } from "vitest";
import { csvCell, csvDateTime, csvRow, exportFileName } from "@/lib/admin/csv";
import { jsonChanges, showValue } from "@/lib/admin/diff";
import { blankCondition, NBO_CONDITION_TYPES, slugKey } from "@/lib/admin/meta";
import { previewNbo } from "@/lib/admin/nbo-preview";
import { scoreExamples } from "@/lib/admin/scoring-examples";
import {
  scoringMaxTotals,
  validateAssignment,
  validateCurrency,
  validateDigest,
  validateFamilies,
  validateList,
  validateLocations,
  validateNboRules,
  validateRungs,
  validateScoring,
  validateTeams,
  validateThresholds,
} from "@/lib/admin/validate";
import type { NboFacts } from "@/lib/metrics/nbo";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

const D = DEFAULT_SETTINGS;
const lists = { industries: D["lists.industries"].map((i) => i.key), ageBands: D["lists.ageBands"].map((i) => i.key) };
const NOW = new Date("2026-10-13T06:00:00Z");

describe("scoring validation and preview", () => {
  it("the spec defaults validate cleanly and add up to exactly 100 per score", () => {
    const v = validateScoring(D.scoring, lists);
    expect(v).toEqual({ ok: true, value: expect.any(Object), warnings: [] });
    expect(scoringMaxTotals(D.scoring)).toEqual({ fit: 100, readiness: 100, value: 100 });
  });

  it("the live preview reproduces the four worked examples with the default weights", () => {
    const out = scoreExamples(D.scoring, { locations: D.locations, gccCountries: D.assignment.gccCountries }, NOW);
    for (const { example, score } of out) {
      expect([score.fit, score.readiness, score.value, score.edaptScore, score.grade]).toEqual([
        example.spec.fit,
        example.spec.readiness,
        example.spec.value,
        example.spec.edapt,
        example.spec.grade,
      ]);
    }
  });

  it("an edited weight changes the preview", () => {
    const cfg = structuredClone(D.scoring);
    cfg.grades.A = 95;
    const [first] = scoreExamples(cfg, { locations: D.locations, gccCountries: D.assignment.gccCountries }, NOW);
    expect(first.score.grade).toBe("B");
  });

  it("rejects negative points, broken grades and bad rows; allows a negative gut adjustment", () => {
    const neg = structuredClone(D.scoring);
    neg.value.frequency[0].points = -2;
    expect(validateScoring(neg, lists)).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be negative/) });

    const grades = structuredClone(D.scoring);
    grades.grades.B = 80;
    expect(validateScoring(grades, lists)).toMatchObject({ ok: false, error: expect.stringMatching(/step down/) });

    const dupe = structuredClone(D.scoring);
    dupe.readiness.recentInterest[1].withinDays = 7;
    expect(validateScoring(dupe, lists)).toMatchObject({ ok: false, error: expect.stringMatching(/each window must be different/) });

    const text = structuredClone(D.scoring) as unknown as { fit: { location: Record<string, unknown> } };
    text.fit.location.gcc = "lots";
    expect(validateScoring(text, lists)).toMatchObject({ ok: false, error: expect.stringMatching(/enter a number/) });

    const gut = structuredClone(D.scoring);
    gut.gut["1"] = -20;
    expect(validateScoring(gut, lists).ok).toBe(true);
  });

  it("warns when blends do not add up to 1 or a score cannot reach 100, and sorts rows", () => {
    const cfg = structuredClone(D.scoring);
    cfg.blend.lead.fit = 0.6;
    cfg.fit.location.gcc = 40;
    cfg.value.frequency = [...cfg.value.frequency].reverse();
    cfg.readiness.umerPointsPerLevel = 6;
    const v = validateScoring(cfg, lists);
    if (!v.ok) throw new Error(v.error);
    expect(v.warnings).toEqual([
      "Lead weights add up to 1.1, not 1, so lead scores are scaled by 1.1.",
      "Fit can add up to 115; it is capped at 100, so the top of the scale loses detail.",
      "Readiness tops out at 90, so nobody can reach 100.",
    ]);
    expect(v.value.value.frequency.map((r) => r.min)).toEqual([6, 4, 3, 2, 1]);
  });

  it("keeps points for list keys and needs an unknown value", () => {
    const cfg = structuredClone(D.scoring);
    cfg.fit.industry = { ...cfg.fit.industry, farmer: 9 };
    const v = validateScoring(cfg, { ...lists, industries: [...lists.industries, "farmer"] });
    expect(v.ok && v.value.fit.industry.farmer).toBe(9);
    const noUnknown = structuredClone(D.scoring) as unknown as { fit: { ageBand: Record<string, number> } };
    delete noUnknown.fit.ageBand.unknown;
    expect(validateScoring(noUnknown, lists)).toMatchObject({ ok: false, error: expect.stringMatching(/"unknown" is required/) });
  });
});

describe("thresholds, digest, lists, teams", () => {
  it("thresholds: whole numbers in range, manager after owner", () => {
    expect(validateThresholds(D.thresholds).ok).toBe(true);
    expect(validateThresholds({ ...D.thresholds, todayCap: 0 })).toMatchObject({ ok: false, field: "todayCap" });
    expect(validateThresholds({ ...D.thresholds, atRiskDays: 2.5 })).toMatchObject({ ok: false, error: expect.stringMatching(/whole number/) });
    expect(validateThresholds({ ...D.thresholds, untouchedManagerHours: 12 })).toMatchObject({ ok: false, field: "untouchedManagerHours" });
    expect(validateThresholds({ ...D.thresholds, leadReleaseDays: "9" })).toMatchObject({ ok: true, value: { leadReleaseDays: 9 } });
  });

  it("digest: time and recipients (emails or user ids)", () => {
    const id = "7b0c6c8e-9a43-4b4f-9a59-0c2b3c1d2e3f";
    expect(validateDigest({ dailyHour: 8, dailyMinute: 30, weeklyRecipients: [" CEO@Edapt.in ", id, "ceo@edapt.in"] })).toEqual({
      ok: true,
      value: { dailyHour: 8, dailyMinute: 30, weeklyRecipients: ["ceo@edapt.in", id] },
      warnings: [],
    });
    expect(validateDigest({ dailyHour: 24, dailyMinute: 0, weeklyRecipients: [] }).ok).toBe(false);
    expect(validateDigest({ dailyHour: 8, dailyMinute: 0, weeklyRecipients: ["nope"] })).toMatchObject({ ok: false, field: "weeklyRecipients" });
  });

  it("lists: unique keys and labels, active flag kept only when off", () => {
    expect(validateList([{ key: "a", label: "A", active: true }, { key: "b", label: "B", active: false }])).toEqual({
      ok: true,
      value: [{ key: "a", label: "A" }, { key: "b", label: "B", active: false }],
      warnings: [],
    });
    expect(validateList([{ key: "a", label: "A" }, { key: "A", label: "B" }]).ok).toBe(false);
    expect(validateList([{ key: "a", label: "Same" }, { key: "b", label: "same" }]).ok).toBe(false);
    expect(validateList([{ key: "a", label: "  " }]).ok).toBe(false);
  });

  it("teams need a key, a name and a real time zone; assignment points at teams", () => {
    expect(validateTeams(D.teams)).toMatchObject({ ok: true, value: D.teams });
    expect(validateTeams([{ key: "x", label: "X", timezone: "Nowhere/City" }]).ok).toBe(false);
    expect(validateTeams([]).ok).toBe(false);
    expect(validateAssignment({ gccCountries: "ae sa,QA", gccTeam: "dubai", defaultTeam: "kerala", autoAssign: false }, D.teams)).toMatchObject({
      ok: true,
      value: { gccCountries: ["AE", "SA", "QA"], autoAssign: false },
    });
    expect(validateAssignment({ gccCountries: "UAE", gccTeam: "dubai", defaultTeam: "kerala" }, D.teams)).toMatchObject({ ok: false, field: "gccCountries" });
    expect(validateAssignment({ gccCountries: "AE", gccTeam: "mars", defaultTeam: "kerala" }, D.teams)).toMatchObject({ ok: false, field: "gccTeam" });
  });
});

describe("ladder, currency, locations, offers", () => {
  it("rungs are numbered without gaps; families sit on a rung or in a side group", () => {
    expect(validateRungs(D["ladder.rungs"]).ok).toBe(true);
    expect(validateRungs([{ rung: 1, label: "A" }, { rung: 3, label: "C" }]).ok).toBe(false);
    expect(validateFamilies(D["ladder.families"], D["ladder.rungs"]).ok).toBe(true);
    expect(validateFamilies([{ key: "x", label: "X", rung: 9 }], D["ladder.rungs"]).ok).toBe(false);
    expect(validateFamilies([{ key: "x", label: "X", rung: null }], D["ladder.rungs"])).toMatchObject({ ok: false, error: expect.stringMatching(/Side group/) });
  });

  it("currency: INR always first; an enabled currency needs a rate", () => {
    expect(validateCurrency(D.currency)).toMatchObject({ ok: true, value: D.currency, warnings: [] });
    const v = validateCurrency({ enabled: ["usd", "INR"], rates: { usd: { "2026-10": "83.4" }, AED: { "2026-01": 22.6 } } });
    expect(v).toMatchObject({ ok: true, value: { base: "INR", enabled: ["INR", "USD"], rates: { USD: { "2026-10": 83.4 }, AED: { "2026-01": 22.6 } } } });
    expect(v.ok && v.warnings[0]).toMatch(/AED has rates but is switched off/);
    expect(validateCurrency({ enabled: ["INR", "GBP"], rates: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/rate for GBP/) });
    expect(validateCurrency({ enabled: ["INR"], rates: { USD: { "2026-13": 80 } } }).ok).toBe(false);
    expect(validateCurrency({ enabled: ["INR"], rates: { USD: { "2026-10": 0 } } }).ok).toBe(false);
  });

  it("locations: one per line, lower case, no duplicates", () => {
    expect(validateLocations({ keralaCities: "Kochi\n kochi \nThrissur", indianMetros: [], keralaStateNames: ["Kerala"] })).toMatchObject({
      ok: true,
      value: { keralaCities: ["kochi", "thrissur"], indianMetros: [], keralaStateNames: ["kerala"] },
    });
  });

  it("offer rules: the spec defaults validate; conditions need values; a catch-all warns", () => {
    expect(validateNboRules(D["nbo.rules"], { productIds: [] })).toMatchObject({ ok: true, warnings: [] });
    const rules = [
      { id: "a", label: "All", when: [], offer: "Anything" },
      { id: "b", label: "Never", when: [{ type: "tag_in", values: ["VIP"] }], offer: "VIP" },
    ];
    const v = validateNboRules(rules, { productIds: [] });
    expect(v.ok && v.warnings[0]).toMatch(/every rule below it never fires/);
    expect(validateNboRules([{ id: "a", label: "A", when: [{ type: "tag_in", values: [] }], offer: "X" }], { productIds: [] }).ok).toBe(false);
    expect(validateNboRules([{ id: "a", label: "A", when: [{ type: "fit_gte", value: 120 }], offer: "X" }], { productIds: [] }).ok).toBe(false);
    expect(validateNboRules([{ id: "a", label: "A", when: [], offer: "X", productId: "gone" }], { productIds: [] }).ok).toBe(false);
    expect(validateNboRules([rules[1], rules[1]], { productIds: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/share the id/) });
    for (const type of NBO_CONDITION_TYPES) {
      const c = blankCondition(type);
      const ok = validateNboRules([{ id: "x", label: "X", when: [c], offer: "Y" }], { productIds: [] }).ok;
      // value-list conditions start empty and must be filled in
      expect(ok).toBe(!("values" in c));
    }
  });

  it("the tester shows which rule fires with unsaved rules", () => {
    const facts: NboFacts = {
      purchaseCount: 1,
      families: ["workshop"],
      currentRung: 1,
      industry: "business_owner",
      aiLevel: 2,
      fit: 70,
      country: "AE",
      phoneCountry: "AE",
      tags: [],
      firstDoor: "youtube",
    };
    const ctx = { products: [], currency: D.currency, gccCountries: D.assignment.gccCountries, now: NOW };
    const p = previewNbo(facts, D["nbo.rules"], ctx);
    expect(D["nbo.rules"][p.winner].id).toBe("owner_gcc");
    expect(p.offer?.offer).toBe("AI Agents for Business, then The AI Office");
    // switching the winner off hands it to the next matching rule
    const edited = D["nbo.rules"].map((r) => (r.id === "owner_gcc" ? { ...r, active: false } : r));
    expect(previewNbo(facts, edited, ctx).offer?.ruleId).toBe("owner");
  });
});

describe("csv, diff, keys", () => {
  it("quotes and neutralises formulas but keeps phones and negative numbers", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("+919876543210")).toBe("+919876543210");
    expect(csvCell("-12.5")).toBe("-12.5");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell(null)).toBe("");
    expect(csvCell(true)).toBe("yes");
    expect(csvRow(["a", 1, "x\ny"])).toBe('a,1,"x\ny"\r\n');
    expect(csvDateTime(new Date("2026-10-12T19:00:00Z"), "Asia/Kolkata")).toBe("2026-10-13 00:30");
    expect(exportFileName("contacts", new Date("2026-10-12T19:00:00Z"), "Asia/Kolkata")).toBe("edapt-contacts-2026-10-13.csv");
  });

  it("diffs settings by path, matching list items by key", () => {
    const before = { a: 1, list: [{ key: "x", label: "X" }, { key: "y", label: "Y" }], tags: ["p"] };
    const after = { a: 2, list: [{ key: "y", label: "Y" }, { key: "x", label: "Ex" }], tags: ["p", "q"] };
    expect(jsonChanges(before, after)).toEqual([
      { path: "a", before: 1, after: 2 },
      { path: "list[key=x].label", before: "X", after: "Ex" },
      { path: "list (order)", before: ["key=x", "key=y"], after: ["key=y", "key=x"] },
      { path: "tags", before: ["p"], after: ["p", "q"] },
    ]);
    expect(jsonChanges({ a: 1 }, { a: 1 })).toEqual([]);
    expect(jsonChanges(null, "reset")).toEqual([{ path: "(value)", before: null, after: "reset" }]);
    expect(showValue("x".repeat(500), 10)).toHaveLength(10);
  });

  it("makes keys from labels", () => {
    expect(slugKey("Walk-in or Event!")).toBe("walk-in_or_event");
    expect(slugKey("  AI Office Dubai, Oct 2026 ")).toBe("ai_office_dubai_oct_2026");
    expect(slugKey("മലയാളം")).not.toBe("");
  });
});
