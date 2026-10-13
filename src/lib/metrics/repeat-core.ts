/**
 * Repeat purchase metrics (spec "Repeat purchase and revenue forecast"). PURE.
 * The nightly cohort builder (buildCohorts, server) lives in ./repeat.ts, which re-exports everything here.
 *
 * | Average gap               | Mean days between consecutive purchases, for customers with 2 or more            |
 * | Expected next purchase    | Last purchase + average gap; one-time buyers use the median first-to-second gap   |
 * | At risk                   | Today is more than `atRiskDays` past the expected next purchase                  |
 * | Repeat probability (90d)  | Cohort (first family : purchases so far) rate; cohorts under `cohortMinSize`     |
 * |                           | fall back to the company-wide rate                                               |
 */
import type { Settings, Thresholds } from "@/lib/settings/defaults";

export type CohortTable = Settings["metrics.cohorts"];

const DAY_MS = 24 * 3600 * 1000;

export type RepeatFacts = {
  /** purchased_at of every paid / part-paid purchase (any order) */
  purchaseDates: Date[];
  /** family of the earliest paid purchase */
  firstFamily: string | null;
  purchaseCount: number;
};

export type RepeatMetrics = {
  /** mean days between consecutive purchases (2 decimals); null with fewer than 2 */
  avgGapDays: number | null;
  nextExpectedAt: Date | null;
  atRisk: boolean;
  /** 0..1 (4 decimals); null for non-customers or when no rate is known */
  repeatProb90d: number | null;
};

/** Cohort key: first product family and number of purchases so far, e.g. "workshop:1". */
export function cohortKey(firstFamily: string, purchaseCount: number): string {
  return `${firstFamily}:${purchaseCount}`;
}

/** Round half away from zero to `digits` decimals, without float drift (1.005 -> 1.01). */
export function round(n: number, digits: number): number {
  const f = 10 ** digits;
  const scaled = Number((Math.abs(n) * f).toPrecision(12));
  return (Math.sign(n) * Math.round(scaled)) / f || 0;
}

/** Median of a list of numbers; null when empty. */
export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Repeat metrics for one contact. `ctx.cohorts` is the nightly table from settings `metrics.cohorts`;
 * `ctx.thresholds` supplies atRiskDays and cohortMinSize.
 */
export function computeRepeatMetrics(
  facts: RepeatFacts,
  ctx: { cohorts: CohortTable; thresholds: Pick<Thresholds, "atRiskDays" | "cohortMinSize"> },
  now: Date,
): RepeatMetrics {
  const dates = facts.purchaseDates.map((d) => d.getTime()).sort((a, b) => a - b);
  const last = dates.length ? dates[dates.length - 1] : null;

  const avgGapDays = dates.length >= 2 ? round((dates[dates.length - 1] - dates[0]) / (dates.length - 1) / DAY_MS, 2) : null;

  let nextExpectedAt: Date | null = null;
  if (last !== null) {
    const gap = avgGapDays ?? (dates.length === 1 ? ctx.cohorts.medianFirstGapDays : null);
    if (gap !== null && gap !== undefined && Number.isFinite(gap)) nextExpectedAt = new Date(last + gap * DAY_MS);
  }

  const atRisk = nextExpectedAt !== null && now.getTime() > nextExpectedAt.getTime() + ctx.thresholds.atRiskDays * DAY_MS;

  let repeatProb90d: number | null = null;
  if (facts.purchaseCount >= 1) {
    const cohort = facts.firstFamily ? ctx.cohorts.cohorts?.[cohortKey(facts.firstFamily, facts.purchaseCount)] : undefined;
    const rate = cohort && cohort.n >= ctx.thresholds.cohortMinSize ? cohort.rate : ctx.cohorts.companyRate;
    repeatProb90d = rate === null || rate === undefined || !Number.isFinite(rate) ? null : round(rate, 4);
  }

  return { avgGapDays, nextExpectedAt, atRisk, repeatProb90d };
}

export type CohortObservation = { cohort: string; repeated: boolean };

/**
 * Reference definition of the observations one customer contributes to the cohort table (buildCohorts runs the
 * same rule in SQL): for each purchase k (1-based, by date) up to now, cohort "<firstFamily>:<k>", repeated when
 * purchase k+1 came within `windowDays` of purchase k. The last purchase only counts once it is at least
 * `windowDays` old (before that the outcome is unknown).
 */
export function cohortObservations(
  purchaseDates: Date[],
  firstFamily: string,
  now: Date,
  windowDays: number,
): CohortObservation[] {
  const dates = purchaseDates
    .map((d) => d.getTime())
    .filter((t) => t <= now.getTime())
    .sort((a, b) => a - b);
  const window = windowDays * DAY_MS;
  const out: CohortObservation[] = [];
  dates.forEach((t, i) => {
    const next = dates[i + 1];
    if (next === undefined && now.getTime() - t < window) return;
    out.push({ cohort: cohortKey(firstFamily, i + 1), repeated: next !== undefined && next - t <= window });
  });
  return out;
}

/** Folds observations into the stored cohort table shape. */
export function summarizeCohorts(
  observations: CohortObservation[],
  firstGapsDays: number[],
  builtAt: Date,
): CohortTable {
  const cohorts: CohortTable["cohorts"] = {};
  let total = 0;
  let repeated = 0;
  for (const o of observations) {
    const c = (cohorts[o.cohort] ??= { n: 0, repeated: 0, rate: 0 });
    c.n += 1;
    total += 1;
    if (o.repeated) {
      c.repeated += 1;
      repeated += 1;
    }
  }
  for (const c of Object.values(cohorts)) c.rate = c.n ? c.repeated / c.n : 0;
  const med = median(firstGapsDays);
  return {
    builtAt: builtAt.toISOString(),
    companyRate: total ? repeated / total : null,
    medianFirstGapDays: med === null ? null : round(med, 2),
    cohorts,
  };
}
