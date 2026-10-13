/**
 * Fit, Readiness, Value, Edapt Score and grade (spec "Scoring formulas").
 *
 * PURE: no server imports. Used by recomputeContact on the server and by the live score preview on the
 * Rate screen in the browser. Every weight and threshold comes from settings `scoring` (ScoringConfig),
 * the location lists from settings `locations` and the GCC country list from settings `assignment`.
 *
 *   Edapt(lead)     = 0.5 F + 0.5 R + G
 *   Edapt(customer) = 0.25 F + 0.25 R + 0.5 V + G
 *
 * A customer is anyone with at least one paid (or part-paid) purchase. Every score is held between 0 and 100
 * and rounded to a whole number. Grade: A >= 75, B >= 60, C >= 40, otherwise D (thresholds configurable).
 */
import type { BelowRow, LocationConfig, MinRow, ScoringConfig, WithinDaysRow } from "@/lib/settings/defaults";

export type Grade = "A" | "B" | "C" | "D";

export type LocationClass =
  | "gcc"
  | "rest_of_world"
  | "kerala_city_or_metro"
  | "rest_of_kerala"
  | "rest_of_india"
  | "unknown";

export type LocationInput = {
  /** ISO 3166-1 alpha-2 (country names such as "India" or "UAE" are also understood) */
  country?: string | null;
  state?: string | null;
  city?: string | null;
  /** ISO country of the phone number; used when country is empty */
  phoneCountry?: string | null;
};

const DAY_MS = 24 * 3600 * 1000;

/** Lower-case and drop everything that is not a letter or digit: " New  Delhi " -> "newdelhi". */
function squash(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A few common country names, for data typed by hand or imported from sheets. */
const COUNTRY_NAMES: Record<string, string> = {
  india: "IN",
  bharat: "IN",
  ind: "IN",
  uae: "AE",
  unitedarabemirates: "AE",
  emirates: "AE",
  dubai: "AE",
  abudhabi: "AE",
  sharjah: "AE",
  saudi: "SA",
  saudiarabia: "SA",
  ksa: "SA",
  qatar: "QA",
  kuwait: "KW",
  bahrain: "BH",
  oman: "OM",
};

/** "in", " IN ", "India" -> "IN"; "" -> null. Unknown names of 3+ letters are kept as-is (still a known country). */
export function normalizeCountry(country: string | null | undefined): string | null {
  const sq = squash(country);
  if (!sq) return null;
  if (COUNTRY_NAMES[sq]) return COUNTRY_NAMES[sq];
  return sq.toUpperCase();
}

/**
 * Location band for Fit:
 * - country (falling back to the phone's country) in the GCC list -> gcc;
 * - India: city in the Kerala cities or Indian metros lists -> kerala_city_or_metro; else state is Kerala ->
 *   rest_of_kerala; else rest_of_india (also when nothing but the country is known);
 * - any other known country -> rest_of_world;
 * - no country at all: a listed Kerala city / metro or a Kerala state still identifies India; otherwise unknown.
 * Comparison ignores case, spaces and punctuation.
 */
export function classifyLocation(
  loc: LocationInput,
  locations: LocationConfig,
  gccCountries: string[],
): LocationClass {
  const country = normalizeCountry(loc.country) ?? normalizeCountry(loc.phoneCountry);
  const city = squash(loc.city);
  const state = squash(loc.state);
  const gcc = new Set(gccCountries.map((c) => normalizeCountry(c)).filter(Boolean));
  const inList = (v: string, list: string[]) => !!v && list.some((x) => squash(x) === v);
  const keralaCityOrMetro = inList(city, locations.keralaCities) || inList(city, locations.indianMetros);
  const keralaState = inList(state, locations.keralaStateNames);

  if (country && gcc.has(country)) return "gcc";
  if (country === "IN") {
    if (keralaCityOrMetro) return "kerala_city_or_metro";
    if (keralaState) return "rest_of_kerala";
    return "rest_of_india";
  }
  if (country) return "rest_of_world";
  if (keralaCityOrMetro) return "kerala_city_or_metro";
  if (keralaState) return "rest_of_kerala";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Threshold tables
// ---------------------------------------------------------------------------

/** Whole days elapsed from `at` to `now` (floor). A date in the future counts as 0 days. */
export function daysSince(at: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY_MS));
}

/** First row (smallest window first) whose window contains `days`; otherwise `older`. */
export function withinDaysPoints(days: number, rows: WithinDaysRow[], older: number): number {
  const sorted = [...rows].sort((a, b) => a.withinDays - b.withinDays);
  for (const r of sorted) if (days <= r.withinDays) return r.points;
  return older;
}

/** First row (lowest threshold first) the value is below; at or above every threshold -> `top`. */
export function belowPoints(value: number, rows: BelowRow[], top: number): number {
  const sorted = [...rows].sort((a, b) => a.below - b.below);
  for (const r of sorted) if (value < r.below) return r.points;
  return top;
}

/** First row (highest minimum first) the value reaches; below every minimum -> 0. */
export function minPoints(value: number, rows: MinRow[]): number {
  const sorted = [...rows].sort((a, b) => b.min - a.min);
  for (const r of sorted) if (value >= r.min) return r.points;
  return 0;
}

/** Hold between 0 and 100 and round to a whole number (half up, without float drift). */
export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(Math.round(n * 1e6) / 1e6);
  return Math.min(100, Math.max(0, r));
}

function lookup(table: Record<string, number>, key: string | number | null | undefined): number {
  if (key !== null && key !== undefined && key !== "") {
    const k = String(key);
    if (k !== "unknown" && Object.prototype.hasOwnProperty.call(table, k) && Number.isFinite(table[k])) return table[k];
  }
  return table.unknown ?? 0;
}

function isLevel(v: number | null | undefined, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

// ---------------------------------------------------------------------------
// Fit, Readiness, Value
// ---------------------------------------------------------------------------

export type FitInput = {
  /** 1..5 */
  spendingBand?: number | null;
  /** industry key from settings lists.industries */
  industry?: string | null;
  /** age band key, e.g. "35-44" */
  ageBand?: string | null;
  location: LocationClass;
};
export type FitBreakdown = { spendingBand: number; industry: number; ageBand: number; location: number };

/** Fit: who they are. Spending power + industry + age band + location; unknowns use the "unknown" points. */
export function computeFit(input: FitInput, cfg: ScoringConfig): { score: number; breakdown: FitBreakdown } {
  const f = cfg.fit;
  const breakdown: FitBreakdown = {
    spendingBand: lookup(f.spendingBand, isLevel(input.spendingBand, 1, 5) ? input.spendingBand : null),
    industry: lookup(f.industry, input.industry),
    ageBand: lookup(f.ageBand, input.ageBand),
    location: lookup(f.location, input.location),
  };
  return {
    score: clampScore(breakdown.spendingBand + breakdown.industry + breakdown.ageBand + breakdown.location),
    breakdown,
  };
}

export type ReadinessInput = {
  /** 0..5; unknown counts as level `umerUnknownLevel` */
  umerLevel?: number | null;
  /** 0..5 */
  aiLevel?: number | null;
  /** latest enquiry, chat/interaction or purchase */
  lastInterestAt?: Date | null;
};
export type ReadinessBreakdown = { umer: number; ai: number; recentInterest: number };

/** Readiness: what is in their head. Umer familiarity + AI knowledge (a curve) + recent interest. */
export function computeReadiness(
  input: ReadinessInput,
  cfg: ScoringConfig,
  now: Date,
): { score: number; breakdown: ReadinessBreakdown } {
  const r = cfg.readiness;
  const umerLevel = isLevel(input.umerLevel, 0, 5) ? input.umerLevel : r.umerUnknownLevel;
  const breakdown: ReadinessBreakdown = {
    umer: umerLevel * r.umerPointsPerLevel,
    ai: lookup(r.aiLevel, isLevel(input.aiLevel, 0, 5) ? input.aiLevel : null),
    recentInterest: input.lastInterestAt
      ? withinDaysPoints(daysSince(input.lastInterestAt, now), r.recentInterest, r.recentInterestOlder)
      : r.recentInterestOlder,
  };
  return { score: clampScore(breakdown.umer + breakdown.ai + breakdown.recentInterest), breakdown };
}

export type ValueInput = {
  /** verified payments - verified refunds, INR */
  ltvInr: number;
  /** paid or part-paid purchases */
  purchaseCount: number;
  /** distinct product families bought */
  familyCount: number;
  /** paying customers they brought in */
  referralCount: number;
  lastPurchaseAt: Date | null;
};
export type ValueBreakdown = { ltv: number; frequency: number; breadth: number; referrals: number; recency: number };

/** Value: what they have done. Money + frequency + breadth + referrals + recency of the last purchase. */
export function computeValue(
  input: ValueInput,
  cfg: ScoringConfig,
  now: Date,
): { score: number; breakdown: ValueBreakdown } {
  const v = cfg.value;
  const breakdown: ValueBreakdown = {
    ltv: belowPoints(Number(input.ltvInr) || 0, v.ltv, v.ltvTop),
    frequency: minPoints(input.purchaseCount, v.frequency),
    breadth: minPoints(input.familyCount, v.breadth),
    referrals: minPoints(input.referralCount, v.referrals),
    recency: input.lastPurchaseAt
      ? withinDaysPoints(daysSince(input.lastPurchaseAt, now), v.recency, v.recencyOlder)
      : v.recencyOlder,
  };
  return {
    score: clampScore(breakdown.ltv + breakdown.frequency + breakdown.breadth + breakdown.referrals + breakdown.recency),
    breakdown,
  };
}

/** Gut adjustment G from 1..5 stars; unrated (or anything else) uses `gut.unrated`. */
export function gutPoints(gutStars: number | null | undefined, cfg: ScoringConfig): number {
  const key = isLevel(gutStars, 1, 5) ? (String(gutStars) as "1" | "2" | "3" | "4" | "5") : "unrated";
  return cfg.gut[key] ?? 0;
}

/**
 * Edapt Score. Leads: blend.lead (0.5F + 0.5R) + G. Customers: blend.customer (0.25F + 0.25R + 0.5V) + G.
 * Held between 0 and 100, rounded. A customer with no value yet counts V as 0.
 */
export function computeEdapt(
  s: { fit: number; readiness: number; value: number | null; gutStars: number | null | undefined; isCustomer: boolean },
  cfg: ScoringConfig,
): number {
  const g = gutPoints(s.gutStars, cfg);
  if (s.isCustomer) {
    const b = cfg.blend.customer;
    return clampScore(b.fit * s.fit + b.readiness * s.readiness + b.value * (s.value ?? 0) + g);
  }
  const b = cfg.blend.lead;
  return clampScore(b.fit * s.fit + b.readiness * s.readiness + g);
}

/** A >= grades.A, B >= grades.B, C >= grades.C, otherwise D. */
export function gradeFor(score: number, grades: ScoringConfig["grades"]): Grade {
  if (score >= grades.A) return "A";
  if (score >= grades.B) return "B";
  if (score >= grades.C) return "C";
  return "D";
}

// ---------------------------------------------------------------------------
// Everything at once
// ---------------------------------------------------------------------------

export type ScoreContactInput = LocationInput &
  Omit<FitInput, "location"> &
  ReadinessInput &
  Partial<ValueInput> & {
    /** 1..5 stars, null when unrated */
    gutStars?: number | null;
    /** pre-classified location; computed from country/state/city/phoneCountry when omitted */
    location?: LocationClass;
  };

export type ScoreContext = {
  locations: LocationConfig;
  /** settings assignment.gccCountries */
  gccCountries: string[];
};

export type ScoreBreakdown = {
  fit: FitBreakdown;
  readiness: ReadinessBreakdown;
  /** only for customers */
  value?: ValueBreakdown;
  gut: number;
};

export type ContactScore = {
  fit: number;
  readiness: number;
  /** null for leads: Value is not used until someone pays */
  value: number | null;
  edaptScore: number;
  grade: Grade;
  /** at least one paid or part-paid purchase */
  isCustomer: boolean;
  location: LocationClass;
  breakdown: ScoreBreakdown;
};

/**
 * Scores one contact. Value fields default to a lead with nothing bought (purchaseCount 0), so the Rate screen
 * preview can pass just the rating fields plus whatever money facts it already shows.
 */
export function scoreContact(
  input: ScoreContactInput,
  cfg: ScoringConfig,
  ctx: ScoreContext,
  now: Date,
): ContactScore {
  const location = input.location ?? classifyLocation(input, ctx.locations, ctx.gccCountries);
  const fit = computeFit({ ...input, location }, cfg);
  const readiness = computeReadiness(input, cfg, now);
  const purchaseCount = input.purchaseCount ?? 0;
  const isCustomer = purchaseCount > 0;
  const value = isCustomer
    ? computeValue(
        {
          ltvInr: input.ltvInr ?? 0,
          purchaseCount,
          familyCount: input.familyCount ?? 0,
          referralCount: input.referralCount ?? 0,
          lastPurchaseAt: input.lastPurchaseAt ?? null,
        },
        cfg,
        now,
      )
    : null;
  const edaptScore = computeEdapt(
    { fit: fit.score, readiness: readiness.score, value: value?.score ?? null, gutStars: input.gutStars, isCustomer },
    cfg,
  );
  const breakdown: ScoreBreakdown = {
    fit: fit.breakdown,
    readiness: readiness.breakdown,
    gut: gutPoints(input.gutStars, cfg),
  };
  if (value) breakdown.value = value.breakdown;
  return {
    fit: fit.score,
    readiness: readiness.score,
    value: value?.score ?? null,
    edaptScore,
    grade: gradeFor(edaptScore, cfg.grades),
    isCustomer,
    location,
    breakdown,
  };
}
