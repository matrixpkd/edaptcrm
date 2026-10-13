/**
 * Calibration report folding (spec "Scoring formulas": "After 90 days, a calibration report shows conversion and
 * repeat rates by score band and by each input"). PURE: the SQL in ./calibration.ts returns one row per
 * (dimension, raw key); this file turns those rows into labelled, ordered tables with the points each bucket
 * scores today, and flags cells with too few people to trust.
 */
import { classifyLocation, type LocationClass } from "@/lib/metrics/scoring";
import type { ListItem, LocationConfig, MinRow, ScoringConfig, WithinDaysRow } from "@/lib/settings/defaults";
import { AI_KNOWLEDGE_SCALE, SPENDING_POWER_SCALE, UMER_FAMILIARITY_SCALE } from "@/lib/today/rating-scales";

export const CALIBRATION_DIMENSIONS = [
  "grade",
  "score_band",
  "spending_band",
  "industry",
  "age_band",
  "location",
  "umer_level",
  "ai_level",
  "recent_interest",
  "gut_stars",
  "first_door",
  "value_money",
  "value_frequency",
  "value_breadth",
  "value_referrals",
  "value_recency",
] as const;

/**
 * The Value inputs are judged at each purchase, not on today's totals (a customer who already repeated has a
 * higher frequency today, so grouping by today's value would only measure itself). For every paid purchase at
 * least `windowDays` old, the customer's money, purchases, product families and paying referrals AT THAT
 * PURCHASE are one row in "customers", and "repeated" means they bought again within `windowDays` of it.
 */
export const VALUE_DIMENSIONS = ["value_money", "value_frequency", "value_breadth", "value_referrals"] as const;

/**
 * The two time inputs are judged at a snapshot `windowDays` ago (they are always "now" at the moment of a purchase
 * or an enquiry): Readiness "recent interest" for the people who were leads then (days since their last enquiry or
 * chat -> paid within `windowDays` after the snapshot?) and Value "recency" for the people who were customers then
 * (days since their last purchase -> bought again within `windowDays` after it?). The raw key is the number of days
 * ("" when nothing was ever recorded), bucketed here with today's windows.
 */
export const SNAPSHOT_DIMENSIONS = ["recent_interest", "value_recency"] as const;
export type CalibrationDimension = (typeof CALIBRATION_DIMENSIONS)[number];

/** One grouped row from SQL. `key` is "" for unknown; for location it is "country|state|city|phoneCountry". */
export type CalibrationRawRow = {
  dim: string;
  key: string;
  /** matured leads: created at least `windowDays` ago and not already a customer before they were created */
  leads: number;
  /** of those, paid within `windowDays` of being created */
  converted: number;
  /** matured customers: first paid purchase at least `windowDays` ago */
  customers: number;
  /** of those, bought again within `windowDays` of the first purchase */
  repeated: number;
};

export type CalibrationCell = {
  key: string;
  label: string;
  /** points this bucket scores under today's weights (null when the dimension is not a scoring input) */
  points: number | null;
  leads: number;
  converted: number;
  conversion: number | null;
  customers: number;
  repeated: number;
  repeatRate: number | null;
  /** fewer than `minN` matured leads: the conversion rate is noise */
  lowLeads: boolean;
  /** fewer than `minN` matured customers: the repeat rate is noise */
  lowCustomers: boolean;
};

export type CalibrationTable = {
  dim: CalibrationDimension;
  title: string;
  /** what the rows are and how they score today */
  note: string;
  /** "Points now" column header, or null when the dimension is not a scoring input */
  pointsLabel: string | null;
  rows: CalibrationCell[];
};

export type CalibrationTotals = {
  leads: number;
  converted: number;
  conversion: number | null;
  customers: number;
  repeated: number;
  repeatRate: number | null;
};

export type CalibrationContext = {
  scoring: ScoringConfig;
  industries: ListItem[];
  ageBands: ListItem[];
  firstDoors: ListItem[];
  locations: LocationConfig;
  gccCountries: string[];
  /** cells below this many people are flagged (settings thresholds.cohortMinSize, default 30) */
  minN: number;
};

export const LOCATION_LABELS: Record<LocationClass, string> = {
  gcc: "GCC",
  rest_of_world: "Rest of world",
  kerala_city_or_metro: "Kerala cities and Indian metros",
  rest_of_kerala: "Rest of Kerala",
  rest_of_india: "Rest of India",
  unknown: "Not known",
};
const LOCATION_ORDER: LocationClass[] = ["gcc", "rest_of_world", "kerala_city_or_metro", "rest_of_kerala", "rest_of_india", "unknown"];

const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** "90–100", "80–89", ... "0–9" for the 10-point band starting at `low`. */
export function scoreBandLabel(low: number): string {
  return low >= 90 ? "90–100" : `${low}–${low + 9}`;
}

/** The 10-point band an Edapt Score falls in (100 joins 90–100); null for no score. */
export function scoreBandOf(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return Math.min(90, Math.max(0, Math.floor(score / 10) * 10));
}

function lookup(table: Record<string, number>, key: string): number {
  if (key && key !== "unknown" && Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  return table.unknown ?? 0;
}

function signed(n: number): number {
  return Math.round(n * 100) / 100;
}

type Bucket = { key: string; label: string; points: number | null; order: number };

/** Describes one raw key of a dimension: its label, today's points and its sort position. */
function describe(dim: CalibrationDimension, key: string, ctx: CalibrationContext): Bucket {
  const s = ctx.scoring;
  const unknownLast = 1000;
  switch (dim) {
    case "grade": {
      const g = s.grades;
      const labels: Record<string, string> = {
        A: `A · ${g.A} and above`,
        B: `B · ${g.B} to ${g.A - 1}`,
        C: `C · ${g.C} to ${g.B - 1}`,
        D: `D · under ${g.C}`,
      };
      const order = ["A", "B", "C", "D"].indexOf(key);
      return { key, label: labels[key] ?? (key || "Not scored"), points: null, order: order === -1 ? unknownLast : order };
    }
    case "score_band": {
      const low = key === "" ? null : Number(key);
      return low === null || !Number.isFinite(low)
        ? { key, label: "Not scored", points: null, order: unknownLast }
        : { key, label: scoreBandLabel(low), points: null, order: 100 - low };
    }
    case "spending_band": {
      const band = SPENDING_POWER_SCALE.find((b) => String(b.value) === key);
      return band
        ? { key, label: `${band.value} · ${band.name}`, points: lookup(s.fit.spendingBand, key), order: band.value }
        : { key, label: "Not rated", points: lookup(s.fit.spendingBand, "unknown"), order: unknownLast };
    }
    case "industry":
    case "age_band":
    case "first_door": {
      const list = dim === "industry" ? ctx.industries : dim === "age_band" ? ctx.ageBands : ctx.firstDoors;
      const i = list.findIndex((x) => x.key === key);
      const table = dim === "industry" ? s.fit.industry : dim === "age_band" ? s.fit.ageBand : null;
      const label = key === "" ? "Not known" : i === -1 ? key : list[i].label;
      return {
        key,
        label,
        points: table ? lookup(table, key) : null,
        order: key === "" ? unknownLast : i === -1 ? unknownLast - 1 : i,
      };
    }
    case "location": {
      const cls = key as LocationClass;
      return { key, label: LOCATION_LABELS[cls] ?? key, points: lookup(s.fit.location, cls), order: LOCATION_ORDER.indexOf(cls) };
    }
    case "umer_level": {
      const a = UMER_FAMILIARITY_SCALE.find((x) => String(x.value) === key);
      const per = s.readiness.umerPointsPerLevel;
      return a
        ? { key, label: `${a.value} · ${a.text}`, points: a.value * per, order: a.value }
        : { key, label: `Not rated (counts as ${s.readiness.umerUnknownLevel})`, points: s.readiness.umerUnknownLevel * per, order: unknownLast };
    }
    case "ai_level": {
      const a = AI_KNOWLEDGE_SCALE.find((x) => String(x.value) === key);
      return a
        ? { key, label: `${a.value} · ${a.text}`, points: lookup(s.readiness.aiLevel, key), order: a.value }
        : { key, label: "Not rated", points: lookup(s.readiness.aiLevel, "unknown"), order: unknownLast };
    }
    case "value_money": {
      // key: index of the first `below` threshold the money stays under (sorted ascending), or "top"
      const rows = [...s.value.ltv].sort((a, b) => a.below - b.below);
      const i = key === "top" ? rows.length : Number(key);
      if (!Number.isInteger(i) || i < 0 || i > rows.length) return { key, label: key, points: null, order: unknownLast };
      const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
      const label =
        i === rows.length
          ? `${inr(rows[rows.length - 1]?.below ?? 0)} or more`
          : i === 0
            ? `Under ${inr(rows[0].below)}`
            : `${inr(rows[i - 1].below)} to ${inr(rows[i].below)}`;
      return { key, label, points: i === rows.length ? s.value.ltvTop : rows[i].points, order: i };
    }
    case "value_frequency":
    case "value_breadth":
    case "value_referrals": {
      const rows = [...minRowsFor(dim, s)].sort((a, b) => a.min - b.min);
      const min = Number(key);
      const i = rows.findIndex((r) => r.min === min);
      const noun = dim === "value_frequency" ? ["purchase", "purchases"] : dim === "value_breadth" ? ["family", "families"] : ["paying referral", "paying referrals"];
      const word = (n: number) => `${n} ${n === 1 ? noun[0] : noun[1]}`;
      if (i === -1) return { key, label: min === 0 ? `No ${noun[1]}` : word(min), points: 0, order: min };
      const next = rows[i + 1]?.min;
      const label = next === undefined ? `${word(min)} or more` : next === min + 1 ? word(min) : `${min} to ${next - 1} ${noun[1]}`;
      return { key, label, points: rows[i].points, order: min };
    }
    case "recent_interest":
    case "value_recency": {
      const rows = [...withinRowsFor(dim, s)].sort((a, b) => a.withinDays - b.withinDays);
      const older = dim === "recent_interest" ? s.readiness.recentInterestOlder : s.value.recencyOlder;
      if (key === "older") {
        const last = rows[rows.length - 1]?.withinDays;
        return { key, label: last === undefined ? "Any time" : `Older than ${last} days`, points: older, order: rows.length };
      }
      const days = Number(key);
      const i = rows.findIndex((r) => r.withinDays === days);
      if (i === -1) return { key, label: key, points: null, order: unknownLast };
      const label = i === 0 ? `Within ${days} days` : `${rows[i - 1].withinDays + 1} to ${days} days`;
      return { key, label, points: rows[i].points, order: i };
    }
    case "gut_stars": {
      const n = Number(key);
      const valid = key !== "" && Number.isInteger(n) && n >= 1 && n <= 5;
      return valid
        ? { key, label: `${n} ${n === 1 ? "star" : "stars"}`, points: signed(s.gut[key as "1"] ?? 0), order: 6 - n }
        : { key, label: "Not rated", points: signed(s.gut.unrated ?? 0), order: unknownLast };
    }
  }
}

const TITLES: Record<CalibrationDimension, { title: string; note: string; pointsLabel: string | null }> = {
  grade: { title: "Grade", note: "Today's grade.", pointsLabel: null },
  score_band: { title: "Edapt Score band", note: "Today's Edapt Score in 10-point bands.", pointsLabel: null },
  spending_band: { title: "Spending power", note: "Fit input, up to 25 points.", pointsLabel: "Fit points" },
  industry: { title: "Industry or role", note: "Fit input, up to 25 points.", pointsLabel: "Fit points" },
  age_band: { title: "Age band", note: "Fit input, up to 25 points.", pointsLabel: "Fit points" },
  location: { title: "Location", note: "Fit input, up to 25 points. Classed from country, state, city and phone.", pointsLabel: "Fit points" },
  umer_level: { title: "Umer familiarity", note: "Readiness input, up to 40 points.", pointsLabel: "Readiness points" },
  ai_level: { title: "AI knowledge", note: "Readiness input, up to 30 points. Scored as a curve.", pointsLabel: "Readiness points" },
  gut_stars: { title: "Gut rating", note: "Added to the Edapt Score as an adjustment.", pointsLabel: "Adjustment" },
  first_door: { title: "First Door", note: "Not a scoring input; shown to compare doors.", pointsLabel: null },
  recent_interest: {
    title: "Recent interest",
    note: "Readiness input, up to 30 points. Judged at a snapshot one window ago: people who were leads then, by days since their last enquiry or chat, and whether they paid in the window after it.",
    pointsLabel: "Readiness points",
  },
  value_recency: {
    title: "Recency",
    note: "Value input, up to 15 points. Judged at a snapshot one window ago: people who were customers then, by days since their last purchase, and whether they bought again in the window after it.",
    pointsLabel: "Value points",
  },
  value_money: {
    title: "Money so far",
    note: "Value input, up to 25 points. One row per purchase: what they had spent up to and including it (purchase amounts in INR), and whether they bought again.",
    pointsLabel: "Value points",
  },
  value_frequency: {
    title: "Purchases so far",
    note: "Value input, up to 20 points. One row per purchase: how many purchases they had made by then, and whether they bought again.",
    pointsLabel: "Value points",
  },
  value_breadth: {
    title: "Product families so far",
    note: "Value input, up to 20 points. One row per purchase: how many product families they had bought by then, and whether they bought again.",
    pointsLabel: "Value points",
  },
  value_referrals: {
    title: "Paying referrals so far",
    note: "Value input, up to 20 points. One row per purchase: how many people they had referred who had paid by then, and whether they bought again.",
    pointsLabel: "Value points",
  },
};

/** The min-row table of a Value input (frequency, breadth, referrals) from today's weights. */
function minRowsFor(dim: "value_frequency" | "value_breadth" | "value_referrals", s: ScoringConfig): MinRow[] {
  return dim === "value_frequency" ? s.value.frequency : dim === "value_breadth" ? s.value.breadth : s.value.referrals;
}

/** The within-days table of a time input from today's weights. */
function withinRowsFor(dim: "recent_interest" | "value_recency", s: ScoringConfig): WithinDaysRow[] {
  return dim === "recent_interest" ? s.readiness.recentInterest : s.value.recency;
}

/** The bucket of a number of days: the smallest window that holds it, as text, or "older" (also for no date). */
export function withinDaysKey(days: number | null, rows: WithinDaysRow[]): string {
  if (days === null || !Number.isFinite(days)) return "older";
  const sorted = [...rows].sort((a, b) => a.withinDays - b.withinDays);
  for (const r of sorted) if (days <= r.withinDays) return String(r.withinDays);
  return "older";
}

/** The bucket of a count: the highest `min` it reaches ("0" below every row), as text. */
export function minRowKey(value: number, rows: MinRow[]): string {
  if (!Number.isFinite(value)) return "0";
  let best: number | null = null;
  for (const r of rows) if (value >= r.min && (best === null || r.min > best)) best = r.min;
  return String(best ?? 0);
}

/** Labelled, ordered calibration tables from the grouped SQL rows. Location keys are classed here. */
export function buildCalibrationTables(raw: CalibrationRawRow[], ctx: CalibrationContext): CalibrationTable[] {
  const acc = new Map<string, Map<string, CalibrationRawRow>>();
  for (const r of raw) {
    if (!(CALIBRATION_DIMENSIONS as readonly string[]).includes(r.dim)) continue;
    let key = r.key ?? "";
    if (r.dim === "location") {
      const [country, state, city, phoneCountry] = key.split("|");
      key = classifyLocation({ country, state, city, phoneCountry }, ctx.locations, ctx.gccCountries);
    } else if (r.dim === "value_frequency" || r.dim === "value_breadth" || r.dim === "value_referrals") {
      key = minRowKey(Number(key), minRowsFor(r.dim, ctx.scoring));
    } else if (r.dim === "recent_interest" || r.dim === "value_recency") {
      key = withinDaysKey(key === "" ? null : Number(key), withinRowsFor(r.dim, ctx.scoring));
    }
    const byKey = acc.get(r.dim) ?? new Map<string, CalibrationRawRow>();
    const cur = byKey.get(key) ?? { dim: r.dim, key, leads: 0, converted: 0, customers: 0, repeated: 0 };
    cur.leads += r.leads;
    cur.converted += r.converted;
    cur.customers += r.customers;
    cur.repeated += r.repeated;
    byKey.set(key, cur);
    acc.set(r.dim, byKey);
  }
  return CALIBRATION_DIMENSIONS.map((dim) => {
    const byKey = acc.get(dim) ?? new Map<string, CalibrationRawRow>();
    const rows = [...byKey.values()]
      .filter((r) => r.leads > 0 || r.customers > 0)
      .map((r) => {
        const b = describe(dim, r.key, ctx);
        const cell: CalibrationCell = {
          key: r.key,
          label: b.label,
          points: b.points,
          leads: r.leads,
          converted: r.converted,
          conversion: rate(r.converted, r.leads),
          customers: r.customers,
          repeated: r.repeated,
          repeatRate: rate(r.repeated, r.customers),
          lowLeads: r.leads < ctx.minN,
          lowCustomers: r.customers < ctx.minN,
        };
        return { order: b.order, cell };
      })
      .sort((a, b) => a.order - b.order || a.cell.label.localeCompare(b.cell.label))
      .map((x) => x.cell);
    return { dim, ...TITLES[dim], rows };
  });
}

/** Overall matured totals from any one dimension (every contact appears exactly once per dimension). */
export function calibrationTotals(raw: CalibrationRawRow[]): CalibrationTotals {
  const t = raw
    .filter((r) => r.dim === "grade")
    .reduce((s, r) => ({ leads: s.leads + r.leads, converted: s.converted + r.converted, customers: s.customers + r.customers, repeated: s.repeated + r.repeated }), {
      leads: 0,
      converted: 0,
      customers: 0,
      repeated: 0,
    });
  return { ...t, conversion: rate(t.converted, t.leads), repeatRate: rate(t.repeated, t.customers) };
}
