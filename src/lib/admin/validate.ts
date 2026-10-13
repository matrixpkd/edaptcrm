/**
 * Validation for every setting the admin edits. PURE: the Settings editors run these in the browser for instant
 * feedback, and the server actions run them again before saving (never trust the client).
 *
 * Each validator takes unknown input (parsed JSON or form values) and returns the cleaned value, or the first
 * problem in plain words. Warnings never block a save; they explain a likely mistake (weights that don't add up).
 */
import type {
  AssignmentConfig,
  BelowRow,
  CurrencyConfig,
  DigestConfig,
  ListItem,
  LocationConfig,
  MinRow,
  NboCondition,
  NboRule,
  ProductFamily,
  Rung,
  ScoringConfig,
  Team,
  Thresholds,
  WithinDaysRow,
} from "@/lib/settings/defaults";
import { NBO_CONDITION_META, THRESHOLD_META } from "./meta";

export type Validated<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string; field?: string };

const okv = <T>(value: T, warnings: string[] = []): Validated<T> => ({ ok: true, value, warnings });
const bad = <T>(error: string, field?: string): Validated<T> => ({ ok: false, error, field });

class Invalid extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** Runs a validator body that throws Invalid for the first problem. */
function run<T>(fn: (warn: (w: string) => void) => T): Validated<T> {
  const warnings: string[] = [];
  try {
    return okv(fn((w) => warnings.push(w)), warnings);
  } catch (e) {
    if (e instanceof Invalid) return bad(e.message, e.field);
    throw e;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!isObj(v)) throw new Invalid(`${what} is missing`);
  return v;
}

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Invalid(`${what} must be a list`);
  return v;
}

/** A finite number within [min, max]; numeric strings are accepted. */
function numIn(v: unknown, what: string, min: number, max: number, opts: { integer?: boolean; field?: string } = {}): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Invalid(`${what}: enter a number`, opts.field);
  if (opts.integer && !Number.isInteger(n)) throw new Invalid(`${what}: use a whole number`, opts.field);
  if (n < min) throw new Invalid(min === 0 ? `${what} cannot be negative` : `${what} must be at least ${min}`, opts.field);
  if (n > max) throw new Invalid(`${what} must be at most ${max}`, opts.field);
  return n;
}

function text(v: unknown, what: string, max: number, opts: { field?: string; optional?: boolean } = {}): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s) {
    if (opts.optional) return "";
    throw new Invalid(`${what} is required`, opts.field);
  }
  if (s.length > max) throw new Invalid(`${what} is too long (at most ${max} characters)`, opts.field);
  return s;
}

const POINTS_MAX = 1000;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Highest points a table can give. */
const maxOf = (vals: number[]) => (vals.length ? Math.max(...vals) : 0);

/** The highest Fit, Readiness and Value a contact could reach with these weights (before the 0-100 cap). */
export function scoringMaxTotals(cfg: ScoringConfig): { fit: number; readiness: number; value: number } {
  const f = cfg.fit;
  const r = cfg.readiness;
  const v = cfg.value;
  return {
    fit:
      maxOf(Object.values(f.spendingBand)) +
      maxOf(Object.values(f.industry)) +
      maxOf(Object.values(f.ageBand)) +
      maxOf(Object.values(f.location)),
    readiness:
      5 * r.umerPointsPerLevel +
      maxOf(Object.values(r.aiLevel)) +
      maxOf([...r.recentInterest.map((x) => x.points), r.recentInterestOlder]),
    value:
      maxOf([...v.ltv.map((x) => x.points), v.ltvTop]) +
      maxOf(v.frequency.map((x) => x.points)) +
      maxOf(v.breadth.map((x) => x.points)) +
      maxOf(v.referrals.map((x) => x.points)) +
      maxOf([...v.recency.map((x) => x.points), v.recencyOlder]),
  };
}

function pointsTable<K extends string>(input: unknown, keys: readonly K[], what: string): Record<K, number> {
  const o = obj(input, what);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = numIn(o[k], `${what} "${k}"`, 0, POINTS_MAX);
  return out;
}

/** Industry / age band tables: every listed key plus "unknown"; extra saved keys are kept. */
function openPointsTable(input: unknown, keys: string[], what: string): Record<string, number> {
  const o = obj(input, what);
  const out: Record<string, number> = {};
  const all = [...new Set([...keys, ...Object.keys(o), "unknown"])];
  for (const k of all) {
    if (o[k] === undefined || o[k] === null || o[k] === "") {
      if (k === "unknown") throw new Invalid(`${what} "unknown" is required`);
      continue; // a listed key without points falls back to "unknown"
    }
    out[k] = numIn(o[k], `${what} "${k}"`, 0, POINTS_MAX);
  }
  return out;
}

function withinRows(input: unknown, what: string): WithinDaysRow[] {
  const rows = arr(input, what).map((r, i) => {
    const o = obj(r, `${what} row ${i + 1}`);
    return {
      withinDays: numIn(o.withinDays, `${what}: days in row ${i + 1}`, 0, 36500, { integer: true }),
      points: numIn(o.points, `${what}: points in row ${i + 1}`, 0, POINTS_MAX),
    };
  });
  if (new Set(rows.map((r) => r.withinDays)).size !== rows.length) throw new Invalid(`${what}: each window must be different`);
  return rows.sort((a, b) => a.withinDays - b.withinDays);
}

function belowRows(input: unknown, what: string): BelowRow[] {
  const rows = arr(input, what).map((r, i) => {
    const o = obj(r, `${what} row ${i + 1}`);
    return {
      below: numIn(o.below, `${what}: amount in row ${i + 1}`, 1, 1e12),
      points: numIn(o.points, `${what}: points in row ${i + 1}`, 0, POINTS_MAX),
    };
  });
  if (new Set(rows.map((r) => r.below)).size !== rows.length) throw new Invalid(`${what}: each amount must be different`);
  return rows.sort((a, b) => a.below - b.below);
}

function minRows(input: unknown, what: string): MinRow[] {
  const rows = arr(input, what).map((r, i) => {
    const o = obj(r, `${what} row ${i + 1}`);
    return {
      min: numIn(o.min, `${what}: count in row ${i + 1}`, 1, 100000, { integer: true }),
      points: numIn(o.points, `${what}: points in row ${i + 1}`, 0, POINTS_MAX),
    };
  });
  if (new Set(rows.map((r) => r.min)).size !== rows.length) throw new Invalid(`${what}: each count must be different`);
  return rows.sort((a, b) => b.min - a.min);
}

const BAND_KEYS = ["1", "2", "3", "4", "5", "unknown"] as const;
const AI_KEYS = ["0", "1", "2", "3", "4", "5", "unknown"] as const;
const GUT_KEYS = ["1", "2", "3", "4", "5", "unrated"] as const;
const LOCATION_KEYS = ["gcc", "rest_of_world", "kerala_city_or_metro", "rest_of_kerala", "rest_of_india", "unknown"] as const;

/**
 * Every number in the scoring config. Points are never negative (the gut adjustment may be: 1 star is -10).
 * Grade cut-offs must step down A > B > C. Warns when a blend does not add up to 1 or a score cannot reach,
 * or overshoots, 100.
 */
export function validateScoring(
  input: unknown,
  lists: { industries: string[]; ageBands: string[] },
): Validated<ScoringConfig> {
  return run((warn) => {
    const o = obj(input, "Scoring");
    const blend = obj(o.blend, "Blend weights");
    const lead = obj(blend.lead, "Lead blend");
    const customer = obj(blend.customer, "Customer blend");
    const gut = obj(o.gut, "Gut points");
    const grades = obj(o.grades, "Grade cut-offs");
    const fit = obj(o.fit, "Fit");
    const readiness = obj(o.readiness, "Readiness");
    const value = obj(o.value, "Value");

    const out: ScoringConfig = {
      blend: {
        lead: {
          fit: numIn(lead.fit, "Lead weight for Fit", 0, 10),
          readiness: numIn(lead.readiness, "Lead weight for Readiness", 0, 10),
        },
        customer: {
          fit: numIn(customer.fit, "Customer weight for Fit", 0, 10),
          readiness: numIn(customer.readiness, "Customer weight for Readiness", 0, 10),
          value: numIn(customer.value, "Customer weight for Value", 0, 10),
        },
      },
      gut: Object.fromEntries(GUT_KEYS.map((k) => [k, numIn(gut[k], `Gut points for ${k === "unrated" ? "unrated" : `${k} stars`}`, -100, 100)])) as ScoringConfig["gut"],
      grades: {
        A: numIn(grades.A, "Grade A from", 0, 100),
        B: numIn(grades.B, "Grade B from", 0, 100),
        C: numIn(grades.C, "Grade C from", 0, 100),
      },
      fit: {
        spendingBand: pointsTable(fit.spendingBand, BAND_KEYS, "Spending power points"),
        industry: openPointsTable(fit.industry, lists.industries, "Industry points"),
        ageBand: openPointsTable(fit.ageBand, lists.ageBands, "Age band points"),
        location: pointsTable(fit.location, LOCATION_KEYS, "Location points"),
      },
      readiness: {
        umerPointsPerLevel: numIn(readiness.umerPointsPerLevel, "Points per Umer familiarity level", 0, 200),
        umerUnknownLevel: numIn(readiness.umerUnknownLevel, "Unknown Umer familiarity counts as level", 0, 5, { integer: true }),
        aiLevel: pointsTable(readiness.aiLevel, AI_KEYS, "AI knowledge points"),
        recentInterest: withinRows(readiness.recentInterest, "Recent interest"),
        recentInterestOlder: numIn(readiness.recentInterestOlder, "Recent interest, older", 0, POINTS_MAX),
      },
      value: {
        ltv: belowRows(value.ltv, "Money (LTV)"),
        ltvTop: numIn(value.ltvTop, "Money (LTV), top band", 0, POINTS_MAX),
        frequency: minRows(value.frequency, "Frequency"),
        breadth: minRows(value.breadth, "Breadth"),
        referrals: minRows(value.referrals, "Referrals"),
        recency: withinRows(value.recency, "Recency"),
        recencyOlder: numIn(value.recencyOlder, "Recency, older", 0, POINTS_MAX),
      },
    };

    if (!(out.grades.A > out.grades.B && out.grades.B > out.grades.C)) {
      throw new Invalid("Grade cut-offs must step down: A above B, B above C");
    }
    const near = (a: number, b: number) => Math.abs(a - b) < 0.001;
    const leadSum = out.blend.lead.fit + out.blend.lead.readiness;
    const custSum = out.blend.customer.fit + out.blend.customer.readiness + out.blend.customer.value;
    if (!near(leadSum, 1)) warn(`Lead weights add up to ${round(leadSum)}, not 1, so lead scores are scaled by ${round(leadSum)}.`);
    if (!near(custSum, 1)) warn(`Customer weights add up to ${round(custSum)}, not 1, so customer scores are scaled by ${round(custSum)}.`);
    const max = scoringMaxTotals(out);
    for (const [name, total] of [["Fit", max.fit], ["Readiness", max.readiness], ["Value", max.value]] as const) {
      if (total > 100) warn(`${name} can add up to ${round(total)}; it is capped at 100, so the top of the scale loses detail.`);
      else if (total < 100) warn(`${name} tops out at ${round(total)}, so nobody can reach 100.`);
    }
    return out;
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// Thresholds, digest
// ---------------------------------------------------------------------------

export function validateThresholds(input: unknown): Validated<Thresholds> {
  return run((warn) => {
    const o = obj(input, "Thresholds");
    const out = {} as Thresholds;
    for (const m of THRESHOLD_META) {
      out[m.key] = numIn(o[m.key], m.label, m.min, m.max, { integer: true, field: m.key });
    }
    if (out.untouchedManagerHours < out.untouchedOwnerHours) {
      throw new Invalid("The manager should hear about an untouched lead after the owner, not before", "untouchedManagerHours");
    }
    if (out.leadReleaseDays * 24 < out.untouchedManagerHours) {
      warn("Leads return to the pool before the manager's untouched-lead alert fires.");
    }
    return out;
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateDigest(input: unknown): Validated<DigestConfig> {
  return run(() => {
    const o = obj(input, "Digest");
    const recipients = arr(o.weeklyRecipients ?? [], "Weekly recipients")
      .map((r) => String(r ?? "").trim())
      .filter(Boolean);
    const cleaned: string[] = [];
    for (const r of recipients) {
      const v = r.toLowerCase();
      if (!UUID_RE.test(v) && !EMAIL_RE.test(v)) throw new Invalid(`"${r}" is not an email address`, "weeklyRecipients");
      if (!cleaned.includes(v)) cleaned.push(v);
    }
    return {
      dailyHour: numIn(o.dailyHour, "Digest hour", 0, 23, { integer: true, field: "dailyTime" }),
      dailyMinute: numIn(o.dailyMinute, "Digest minute", 0, 59, { integer: true, field: "dailyTime" }),
      weeklyRecipients: cleaned,
    };
  });
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Keys unique (ignoring case), labels present. `active: false` is kept; `active: true` is dropped (the default). */
export function validateList(input: unknown, what = "List"): Validated<ListItem[]> {
  return run(() => {
    const rows = arr(input, what);
    const seen = new Set<string>();
    const labels = new Set<string>();
    return rows.map((r, i) => {
      const o = obj(r, `${what} item ${i + 1}`);
      const key = text(o.key, `Key of item ${i + 1}`, 60);
      const label = text(o.label, `Label of "${key}"`, 80);
      const lk = key.toLowerCase();
      if (seen.has(lk)) throw new Invalid(`The key "${key}" is used twice`);
      seen.add(lk);
      const ll = label.toLowerCase();
      if (labels.has(ll)) throw new Invalid(`The label "${label}" is used twice`);
      labels.add(ll);
      const item: ListItem = { key, label };
      if (o.active === false) item.active = false;
      return item;
    });
  });
}

// ---------------------------------------------------------------------------
// Teams and assignment
// ---------------------------------------------------------------------------

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function validateTeams(input: unknown): Validated<Team[]> {
  return run(() => {
    const rows = arr(input, "Teams");
    if (!rows.length) throw new Invalid("Keep at least one team");
    const seen = new Set<string>();
    return rows.map((r, i) => {
      const o = obj(r, `Team ${i + 1}`);
      const key = text(o.key, `Key of team ${i + 1}`, 40).toLowerCase();
      if (!KEY_RE.test(key)) throw new Invalid(`Team key "${key}": use lower-case letters, digits and underscores`);
      if (seen.has(key)) throw new Invalid(`The team key "${key}" is used twice`);
      seen.add(key);
      const label = text(o.label, `Name of team "${key}"`, 60);
      const timezone = typeof o.timezone === "string" ? o.timezone.trim() : "";
      if (!isTimeZone(timezone)) throw new Invalid(`Team "${label}": choose a time zone`);
      return { key, label, timezone };
    });
  });
}

export function validateAssignment(input: unknown, teams: Team[]): Validated<AssignmentConfig> {
  return run((warn) => {
    const o = obj(input, "Assignment");
    const raw = Array.isArray(o.gccCountries) ? o.gccCountries : String(o.gccCountries ?? "").split(/[\s,;]+/);
    const gccCountries: string[] = [];
    for (const c of raw.map((x) => String(x ?? "").trim().toUpperCase()).filter(Boolean)) {
      if (!/^[A-Z]{2}$/.test(c)) throw new Invalid(`"${c}" is not a two-letter country code (such as AE)`, "gccCountries");
      if (!gccCountries.includes(c)) gccCountries.push(c);
    }
    const keys = teams.map((t) => t.key);
    const gccTeam = String(o.gccTeam ?? "");
    const defaultTeam = String(o.defaultTeam ?? "");
    if (!keys.includes(gccTeam)) throw new Invalid("Choose the team that gets GCC leads", "gccTeam");
    if (!keys.includes(defaultTeam)) throw new Invalid("Choose the team that gets all other leads", "defaultTeam");
    if (!gccCountries.length) warn("No GCC countries: every new lead goes to the default team.");
    return { gccCountries, gccTeam, defaultTeam, autoAssign: o.autoAssign === true || o.autoAssign === "on" || o.autoAssign === "true" };
  });
}

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

export function validateRungs(input: unknown): Validated<Rung[]> {
  return run(() => {
    const rows = arr(input, "Rungs");
    if (!rows.length) throw new Invalid("Keep at least one rung");
    const out = rows.map((r, i) => {
      const o = obj(r, `Rung ${i + 1}`);
      const rung = numIn(o.rung, `Rung number ${i + 1}`, 1, 20, { integer: true });
      const label = text(o.label, `Name of rung ${rung}`, 60);
      const description = text(o.description, `Description of rung ${rung}`, 200, { optional: true });
      return description ? { rung, label, description } : { rung, label };
    });
    out.sort((a, b) => a.rung - b.rung);
    out.forEach((r, i) => {
      if (r.rung !== i + 1) throw new Invalid("Rungs must be numbered 1, 2, 3 ... without gaps");
    });
    return out;
  });
}

export function validateFamilies(input: unknown, rungs: Rung[]): Validated<ProductFamily[]> {
  return run(() => {
    const rows = arr(input, "Product families");
    if (!rows.length) throw new Invalid("Keep at least one product family");
    const seen = new Set<string>();
    const rungNos = new Set(rungs.map((r) => r.rung));
    return rows.map((r, i) => {
      const o = obj(r, `Family ${i + 1}`);
      const key = text(o.key, `Key of family ${i + 1}`, 40).toLowerCase();
      if (!KEY_RE.test(key)) throw new Invalid(`Family key "${key}": use lower-case letters, digits and underscores`);
      if (seen.has(key)) throw new Invalid(`The family key "${key}" is used twice`);
      seen.add(key);
      const label = text(o.label, `Name of family "${key}"`, 60);
      const rawRung = o.rung === "" || o.rung === undefined ? null : o.rung;
      if (rawRung === null) {
        const group = text(o.group, `Side group of "${label}"`, 60);
        return { key, label, rung: null, group };
      }
      const rung = numIn(rawRung, `Rung of "${label}"`, 1, 20, { integer: true });
      if (!rungNos.has(rung)) throw new Invalid(`"${label}" is on rung ${rung}, which does not exist`);
      return { key, label, rung };
    });
  });
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * INR is the base, always enabled and first. Every other enabled currency needs at least one monthly rate
 * (INR per 1 unit), otherwise payments in it could not be converted.
 */
export function validateCurrency(input: unknown): Validated<CurrencyConfig> {
  return run((warn) => {
    const o = obj(input, "Currency");
    const ratesIn = isObj(o.rates) ? o.rates : {};
    const rates: CurrencyConfig["rates"] = {};
    for (const [rawCur, table] of Object.entries(ratesIn)) {
      const cur = rawCur.trim().toUpperCase();
      if (cur === "INR") continue;
      if (!CURRENCY_RE.test(cur)) throw new Invalid(`"${rawCur}" is not a three-letter currency code`);
      const t = isObj(table) ? table : {};
      const months: Record<string, number> = {};
      for (const [m, v] of Object.entries(t).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (!MONTH_RE.test(m)) throw new Invalid(`${cur}: "${m}" is not a month (YYYY-MM)`);
        months[m] = numIn(v, `${cur} rate for ${m}`, 0.000001, 1_000_000);
      }
      if (Object.keys(months).length) rates[cur] = months;
    }
    const enabledIn = arr(o.enabled ?? [], "Enabled currencies").map((c) => String(c ?? "").trim().toUpperCase()).filter(Boolean);
    const enabled = ["INR"];
    for (const c of enabledIn) {
      if (!CURRENCY_RE.test(c)) throw new Invalid(`"${c}" is not a three-letter currency code`);
      if (enabled.includes(c)) continue;
      if (!rates[c]) throw new Invalid(`Add a monthly rate for ${c} before switching it on`);
      enabled.push(c);
    }
    for (const cur of Object.keys(rates)) {
      if (!enabled.includes(cur)) warn(`${cur} has rates but is switched off, so it is not offered on payment forms.`);
    }
    return { base: "INR", enabled, rates };
  });
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

function nameList(input: unknown, what: string): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(/\r?\n|,/);
  const out: string[] = [];
  for (const s of raw.map((x) => String(x ?? "").trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean)) {
    if (s.length > 60) throw new Invalid(`${what}: "${s.slice(0, 20)}…" is too long`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function validateLocations(input: unknown): Validated<LocationConfig> {
  return run((warn) => {
    const o = obj(input, "Locations");
    const out = {
      keralaCities: nameList(o.keralaCities, "Kerala cities"),
      indianMetros: nameList(o.indianMetros, "Indian metros"),
      keralaStateNames: nameList(o.keralaStateNames, "Kerala state spellings"),
    };
    if (!out.keralaStateNames.length) warn("No spellings of Kerala: nobody will count as rest of Kerala.");
    return out;
  });
}

// ---------------------------------------------------------------------------
// Next best offer rules
// ---------------------------------------------------------------------------

function condition(input: unknown, where: string): NboCondition {
  const o = obj(input, where);
  const type = String(o.type ?? "") as NboCondition["type"];
  const meta = NBO_CONDITION_META[type];
  if (!meta) throw new Invalid(`${where}: choose a condition`);
  switch (meta.input.kind) {
    case "none":
      return { type } as NboCondition;
    case "number":
      return { type, value: numIn(o.value, `${where} (${meta.label})`, meta.input.min, meta.input.max, { integer: true }) } as NboCondition;
    case "rung":
      return { type, value: numIn(o.value, `${where} (${meta.label})`, 0, 20, { integer: true }) } as NboCondition;
    case "region": {
      const v = String(o.value ?? "");
      if (v !== "gcc" && v !== "india" && v !== "rest_of_world") throw new Invalid(`${where}: choose a region`);
      return { type: "region_is", value: v };
    }
    case "values": {
      const vals = arr(o.values ?? [], where)
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .map((v) => (meta.input.kind === "values" && meta.input.source === "countries" ? v.toUpperCase() : v));
      const unique = [...new Set(vals)];
      if (!unique.length) throw new Invalid(`${where} (${meta.label}): pick at least one value`);
      return { type, values: unique } as NboCondition;
    }
  }
}

/** Ordered rules (first match wins). Ids are unique and kept; a rule needs a label and an offer. */
export function validateNboRules(
  input: unknown,
  ctx: { productIds: string[]; activeProductNames?: string[]; families?: string[] },
): Validated<NboRule[]> {
  return run((warn) => {
    const rows = arr(input, "Rules");
    const ids = new Set<string>();
    const out = rows.map((r, i) => {
      const o = obj(r, `Rule ${i + 1}`);
      const label = text(o.label, `Name of rule ${i + 1}`, 120);
      const id = text(o.id, `Id of "${label}"`, 60);
      if (ids.has(id)) throw new Invalid(`Two rules share the id "${id}"`);
      ids.add(id);
      const offer = text(o.offer, `Offer of "${label}"`, 200);
      const when = arr(o.when ?? [], `Conditions of "${label}"`).map((c, j) => condition(c, `"${label}", condition ${j + 1}`));
      const productId = typeof o.productId === "string" && o.productId ? o.productId : null;
      if (productId && !ctx.productIds.includes(productId)) throw new Invalid(`"${label}": that product no longer exists`);
      const price = o.price === null || o.price === undefined || o.price === "" ? null : numIn(o.price, `Price of "${label}"`, 0, 1e9);
      const productName = text(o.productName, `Product name of "${label}"`, 200, { optional: true });
      const family = text(o.family, `Family of "${label}"`, 60, { optional: true });
      if (family && ctx.families && !ctx.families.includes(family)) throw new Invalid(`"${label}": "${family}" is not a product family`);
      if (productName && ctx.activeProductNames && !ctx.activeProductNames.some((n) => n.trim().toLowerCase() === productName.toLowerCase())) {
        warn(`"${label}": no active product is named "${productName}", so its price comes from the next step.`);
      }
      const rule: NboRule = { id, label, when, offer, productId, price };
      if (productName) rule.productName = productName;
      if (family) rule.family = family;
      if (o.active === false) rule.active = false;
      return rule;
    });
    const catchAll = out.findIndex((r) => r.active !== false && r.when.length === 0);
    if (catchAll >= 0 && catchAll < out.length - 1) {
      warn(`"${out[catchAll].label}" has no conditions, so every rule below it never fires.`);
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function normalizeUserEmail(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return EMAIL_RE.test(s) && s.length <= 200 ? s : null;
}
