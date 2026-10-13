/**
 * Step 3 of the import wizard: turning a mapped row into clean values. Pure and deterministic (pass `now`),
 * unit tested in tests/unit/import-clean.test.ts.
 *
 * Phones are normalised (with a separate dial code and the default country), names put in proper case, emails
 * in lower case, dates and amounts parsed, currency detected. Missing fields stay empty and are never guessed.
 * A row with no valid phone and no email is invalid, with its problems listed.
 */
import { TZDate } from "@date-fns/tz";
import { getCountries } from "libphonenumber-js/max";
import type { PaymentMode } from "@/db/schema";
import { cleanText, listKeyFor, looseKey } from "@/lib/contacts/rules";
import { normalizeReference } from "@/lib/money/rules";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { properCase } from "@/lib/utils";
import {
  MULTI_FIELDS,
  type CleanPurchase,
  type CleanRow,
  type ColumnMapping,
  type ImportDefaults,
  type MappedRow,
  type TargetField,
} from "./types";

type ListLike = readonly { key: string; label: string }[];

export type CleanContext = {
  defaults: ImportDefaults;
  now: Date;
  /** time zone for dates written without one (the importer's), default Asia/Kolkata */
  timeZone?: string;
  lists: {
    firstDoors: ListLike;
    campaigns: ListLike;
    languages: ListLike;
    ageBands: ListLike;
    industries: ListLike;
    families: ListLike;
  };
  /** currencies that have a rate in Settings, plus INR */
  currencies: string[];
  /** team members who may be matched as owners */
  users: { id: string; name: string; email: string; role: string; active: boolean }[];
  /** the product catalogue */
  products: { id: string; name: string; family: string; externalIds: string[] }[];
};

const DEFAULT_TZ = "Asia/Kolkata";

// ---------------------------------------------------------------------------
// Mapping raw -> mapped
// ---------------------------------------------------------------------------

/** A raw cell as text ("" for empty). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  return String(v).trim();
}

/**
 * Applies the confirmed column mapping to one raw row. Columns are read in file order. Several columns may feed
 * name (joined with a space: first + last name), notes ("Header: value" lines), tags, alt_phone, phone and email;
 * every other field takes the first non-empty value.
 */
export function applyMapping(raw: Record<string, unknown>, mapping: ColumnMapping, headers: string[]): MappedRow {
  const out: MappedRow = {};
  const notes: { header: string; value: string }[] = [];
  const phones: string[] = [];
  const multi: Partial<Record<TargetField, string[]>> = {};
  for (const header of headers) {
    const field = mapping[header];
    if (!field || field === "ignore") continue;
    const value = cellText(raw[header]);
    if (!value) continue;
    if (field === "notes") {
      notes.push({ header, value });
      continue;
    }
    if (field === "phone") {
      phones.push(value);
      continue;
    }
    if (MULTI_FIELDS.has(field)) {
      (multi[field] ??= []).push(value);
      continue;
    }
    if (out[field] === undefined) out[field] = value;
  }
  if (phones.length) {
    out.phones = phones;
    out.phone = phones[0];
  }
  if (multi.name) out.name = multi.name.join(" ");
  if (multi.email) out.email = multi.email.join(", ");
  if (multi.alt_phone) out.alt_phone = multi.alt_phone.join(" / ");
  if (multi.tags) out.tags = multi.tags.join(", ");
  if (notes.length) {
    out.notes = notes.length === 1 ? notes[0].value : notes.map((n) => `${n.header}: ${n.value}`).join("\n");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Names, emails, phones
// ---------------------------------------------------------------------------

/** "MOHAMMED ali k" -> "Mohammed Ali K". Null when the text has no letters or is really an email. */
export function cleanName(v: string | null | undefined): string | null {
  const t = cleanText((v ?? "").replace(/^["'\s]+|["'\s]+$/g, ""));
  if (!t) return null;
  if (!/\p{L}/u.test(t) || t.includes("@")) return null;
  return properCase(t);
}

/** Every email in a cell ("a@x.com; B@Y.com"), lower case; invalid pieces are returned separately. */
export function splitEmails(v: string | null | undefined): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const piece of (v ?? "").split(/[,;\s/|]+/)) {
    const p = piece.trim().replace(/^mailto:/i, "");
    if (!p) continue;
    const e = normalizeEmail(p);
    if (e) {
      if (!valid.includes(e)) valid.push(e);
    } else invalid.push(p);
  }
  return { valid, invalid };
}

/** Several numbers written in one cell: "98765 43210 / 98470 12345", "050-1234567, 055-7654321". */
export function splitPhones(v: string | null | undefined): string[] {
  return (v ?? "")
    .split(/[/,;|\n]|\bor\b|&/i)
    .map((s) => s.trim())
    .filter((s) => (s.match(/\d/g)?.length ?? 0) >= 6);
}

export type CleanPhones = {
  phone: string | null;
  country: string | null;
  alt: string[];
  invalid: string[];
};

/**
 * Normalises the main phone column(s) (with the separate dial code, if any) and the alternate phones.
 * The first valid main number is the identity; every other valid number becomes an alternate.
 */
export function cleanPhones(
  main: string[],
  alternates: string[],
  opts: { dialCode?: string | null; defaultCountry?: string },
): CleanPhones {
  const out: CleanPhones = { phone: null, country: null, alt: [], invalid: [] };
  const seen = new Set<string>();
  const push = (raw: string, withDial: boolean) => {
    const np = normalizePhone(raw, { dialCode: withDial ? opts.dialCode : null, defaultCountry: opts.defaultCountry });
    if (!np) {
      out.invalid.push(raw);
      return;
    }
    if (seen.has(np.e164)) return;
    seen.add(np.e164);
    if (!out.phone) {
      out.phone = np.e164;
      out.country = np.country;
    } else out.alt.push(np.e164);
  };
  const pieces = (cell: string) => {
    const parts = splitPhones(cell);
    return parts.length ? parts : [cell];
  };
  for (const cell of main) for (const p of pieces(cell)) push(p, true);
  for (const cell of alternates) for (const p of pieces(cell)) push(p, false);
  return out;
}

// ---------------------------------------------------------------------------
// Places and lists
// ---------------------------------------------------------------------------

const COUNTRY_ALIASES: Record<string, string> = {
  india: "IN",
  bharat: "IN",
  ind: "IN",
  uae: "AE",
  "u a e": "AE",
  emirates: "AE",
  "united arab emirates": "AE",
  are: "AE",
  ksa: "SA",
  saudi: "SA",
  "saudi arabia": "SA",
  "kingdom of saudi arabia": "SA",
  sau: "SA",
  qat: "QA",
  kwt: "KW",
  bhr: "BH",
  omn: "OM",
  usa: "US",
  "u s a": "US",
  "u s": "US",
  us: "US",
  america: "US",
  "united states": "US",
  "united states of america": "US",
  uk: "GB",
  "u k": "GB",
  gbr: "GB",
  england: "GB",
  britain: "GB",
  "great britain": "GB",
};

let countryNames: Map<string, string> | null = null;

function countryNameMap(): Map<string, string> {
  if (countryNames) return countryNames;
  const map = new Map<string, string>();
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  for (const code of getCountries()) {
    const name = dn.of(code);
    if (name && name !== code) map.set(looseKey(name.replace(/[^\p{L}\s]/gu, " ")), code);
  }
  countryNames = map;
  return map;
}

/** "India", "UAE", "u.a.e.", "ae", "Saudi Arabia" -> ISO code. Null when not recognised. */
export function countryFromText(v: string | null | undefined): string | null {
  const t = cleanText(v);
  if (!t) return null;
  const key = looseKey(t.replace(/[^\p{L}\s]/gu, " "));
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  if (/^[a-z]{2}$/i.test(t.trim())) {
    const code = t.trim().toUpperCase();
    return (getCountries() as string[]).includes(code) ? code : null;
  }
  return countryNameMap().get(key) ?? null;
}

/** An age band key from "35-44", "35 to 44", "35 – 44" or an age such as "38". Null when it fits no band. */
export function ageBandFrom(v: string | null | undefined, bands: ListLike): string | null {
  const t = cleanText(v);
  if (!t) return null;
  const direct = listKeyFor(bands, t);
  if (direct) return direct;
  const range = /^(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})(?:\s*(?:yrs?|years?))?$/i.exec(t);
  if (range) {
    const key = `${Number(range[1])}-${Number(range[2])}`;
    return bands.find((b) => b.key === key)?.key ?? null;
  }
  const plus = /^(\d{1,3})\s*\+$/.exec(t) ?? /^(\d{1,3})\s*(?:and above|or more|plus)$/i.exec(t);
  if (plus) return bands.find((b) => b.key === `${Number(plus[1])}+`)?.key ?? null;
  const age = /^(\d{1,3})(?:\s*(?:yrs?|years?))?$/i.exec(t);
  if (age) {
    const n = Number(age[1]);
    for (const b of bands) {
      const r = /^(\d+)-(\d+)$/.exec(b.key);
      if (r && n >= Number(r[1]) && n <= Number(r[2])) return b.key;
      const p = /^(\d+)\+$/.exec(b.key);
      if (p && n >= Number(p[1])) return b.key;
    }
  }
  return null;
}

/** yes / no style answers. Null when it is neither. */
export function parseBool(v: string | null | undefined): boolean | null {
  const t = looseKey(v);
  if (!t) return null;
  if (["yes", "y", "true", "1", "opted in", "opt in", "subscribed", "agreed", "consented", "ok"].includes(t)) return true;
  if (["no", "n", "false", "0", "opted out", "opt out", "unsubscribed", "declined"].includes(t)) return false;
  return null;
}

/** Payment mode from what the file says. Null when not recognised. */
export function paymentModeFrom(v: string | null | undefined): PaymentMode | null {
  const t = looseKey(v);
  if (!t) return null;
  if (/tag ?mango|razorpay|cashfree|stripe|payu|gateway|card|online|instamojo/.test(t)) return "tagmango";
  if (/upi|gpay|google pay|phonepe|phone pe|paytm|bhim|qr/.test(t)) return "upi_qr";
  if (/bank|neft|imps|rtgs|transfer|wire|cheque|check|swift/.test(t)) return "bank_transfer";
  if (/cash/.test(t)) return "cash";
  if (t === "other" || t === "others") return "other";
  return null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function fullYear(y: number): number {
  if (y >= 100) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

type Clock = { h: number; mi: number; s: number } | null;

/** "10:30", "10:30:15", "10:30 PM", "10 am" (null when empty, undefined when it is not a time). */
function parseClock(rest: string): Clock | undefined {
  const t = rest.trim().replace(/^(?:at|,)\s*/i, "").trim();
  if (!t) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\.\d+)?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(t);
  if (!m || (m[2] === undefined && !m[4])) return undefined;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  const ampm = m[4]?.toLowerCase().replace(/\./g, "");
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59 || s > 59) return undefined;
  return { h, mi, s };
}

function build(y: number, m: number, d: number, clock: Clock, tz: string): Date | null {
  if (m < 1 || m > 12 || d < 1 || d > daysIn(y, m) || y < 1900 || y > 2200) return null;
  // a date without a time is taken as noon local time, so it shows as the same day in every team time zone
  const c = clock ?? { h: 12, mi: 0, s: 0 };
  return new Date(new TZDate(y, m - 1, d, c.h, c.mi, c.s, tz).getTime());
}

/**
 * Parses the date formats found in Indian and Gulf sheets:
 * - dd/mm/yyyy (Indian default), dd-mm-yy, dd.mm.yyyy; mm/dd/yyyy when `dayFirst` is false
 *   (a first part above 12 is always the day)
 * - ISO: 2025-10-12, 2025-10-12 10:30, 2025-10-12T10:30:00Z
 * - Excel serial numbers (45942, 45942.5)
 * - "12 Oct 2025", "12-Oct-25", "12th October, 2025", "Oct 12, 2025", optionally with a time
 * Dates without a time are noon in `timeZone`; times without a zone are local to `timeZone`.
 * Returns null when the text is not a date.
 */
export function parseDate(
  input: unknown,
  opts: { dayFirst?: boolean; timeZone?: string } = {},
): Date | null {
  const tz = opts.timeZone || DEFAULT_TZ;
  const dayFirst = opts.dayFirst !== false;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === "number") return excelSerial(input, tz);
  let s = cleanText(String(input ?? ""));
  if (!s) return null;

  // Excel serial
  if (/^\d{5}(?:\.\d+)?$/.test(s)) return excelSerial(Number(s), tz);

  // ISO with an explicit zone
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // ISO date, optionally with a local time
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(.*))?$/.exec(s);
  if (m) {
    const clock = parseClock(m[4] ?? "");
    if (clock === undefined) return null;
    return build(Number(m[1]), Number(m[2]), Number(m[3]), clock, tz);
  }
  // numeric day/month/year
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[T\s,]+(.*))?$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let day = dayFirst ? a : b;
    let month = dayFirst ? b : a;
    if (month > 12 && day <= 12) [day, month] = [month, day];
    const clock = parseClock(m[4] ?? "");
    if (clock === undefined) return null;
    return build(fullYear(Number(m[3])), month, day, clock, tz);
  }
  // words: drop a leading weekday
  s = s.replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, "");
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]+([a-z]{3,9})\.?,?[\s\-/.,]+(\d{2}|\d{4})\b(.*)$/i.exec(s);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    const clock = parseClock(m[4] ?? "");
    if (clock === undefined) return null;
    return build(fullYear(Number(m[3])), month, Number(m[1]), clock, tz);
  }
  m = /^([a-z]{3,9})\.?[\s\-/.]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-/.,]+(\d{2}|\d{4})\b(.*)$/i.exec(s);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return null;
    const clock = parseClock(m[4] ?? "");
    if (clock === undefined) return null;
    return build(fullYear(Number(m[3])), month, Number(m[2]), clock, tz);
  }
  return null;
}

/** Excel's day number (1900 system): 25569 is 1970-01-01. The fraction is the local time of day. */
function excelSerial(n: number, tz: string): Date | null {
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
  const ms = Math.round((n - 25569) * 86400) * 1000;
  const u = new Date(ms);
  const hasTime = n % 1 !== 0;
  return build(
    u.getUTCFullYear(),
    u.getUTCMonth() + 1,
    u.getUTCDate(),
    hasTime ? { h: u.getUTCHours(), mi: u.getUTCMinutes(), s: u.getUTCSeconds() } : null,
    tz,
  );
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** The currency written in a value or a currency cell: ₹/Rs/INR, AED/Dhs, USD/$, or another 3-letter code. */
export function detectCurrency(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  if (/₹|\brs\b\.?|\brs\.|\binr\b|rupee/i.test(t)) return "INR";
  if (/\baed\b|\bdhs?\b|dirham|د\.?\s?إ/i.test(t)) return "AED";
  if (/\busd\b|us\$|\$|dollar/i.test(t)) return "USD";
  const code = /^([a-z]{3})$/i.exec(t);
  return code ? code[1].toUpperCase() : null;
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  l: 1e5,
  lac: 1e5,
  lacs: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  lk: 1e5,
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
  mn: 1e6,
  million: 1e6,
};

/**
 * Parses "₹1,20,000", "AED 3,500", "1.2L", "45k", "Rs. 999/-", "1,200.50", "USD 99".
 * Returns the amount (2 decimals) and the currency written with it (null when none), or null when the text is
 * not an amount. "Free", "nil" and "-" are 0.
 */
export function parseAmount(input: unknown): { amount: number; currency: string | null } | null {
  if (typeof input === "number") return Number.isFinite(input) ? { amount: round2(input), currency: null } : null;
  const raw = cleanText(String(input ?? ""));
  if (!raw) return null;
  if (/^(?:free|nil|none|na|n\/a|-|—|–)$/i.test(raw)) return { amount: 0, currency: null };
  let currency = detectCurrency(raw);
  let s = raw
    .replace(/₹|\bINR\b|\bRs\b\.?|\bRs\.|rupees?|\bAED\b|\bDhs?\b\.?|dirhams?|د\.?\s?إ|\bUSD\b|US\$|\$|dollars?/gi, " ")
    .replace(/\/-\s*$/, "")
    .trim();
  // another currency written as a code: "EUR 10", "10 GBP"
  const code = /^([A-Z]{3})\s+(?=[\d(-])/.exec(s) ?? /(?<=\d)\s+([A-Z]{3})$/.exec(s);
  if (code && !MULTIPLIERS[code[1].toLowerCase()]) {
    currency ??= code[1];
    s = s.replace(code[0], "").trim();
  }
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }
  const m = /^(\d[\d,\s]*(?:\.\d+)?)\s*([a-z]+)?\.?$/i.exec(s);
  if (!m) return null;
  let mult = 1;
  if (m[2]) {
    const k = MULTIPLIERS[m[2].toLowerCase()];
    if (!k) return null;
    mult = k;
  }
  const digits = m[1].replace(/[,\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return null;
  const n = Number(digits) * mult;
  if (!Number.isFinite(n)) return null;
  return { amount: round2(negative ? -n : n), currency };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Owners and products
// ---------------------------------------------------------------------------

/**
 * A team member from the owner text: exact email, else exact name (case/space-insensitive). Returns the user
 * id, or a warning when no single active, non-support user matches.
 */
export function resolveOwner(
  v: string | null | undefined,
  users: CleanContext["users"],
): { id: string } | { warning: string } | null {
  const t = cleanText(v);
  if (!t) return null;
  const key = looseKey(t);
  let hits = users.filter((u) => u.email.toLowerCase() === key);
  if (!hits.length) hits = users.filter((u) => looseKey(u.name) === key);
  if (!hits.length) return { warning: `Owner "${t}" is not a team member` };
  const usable = hits.filter((u) => u.active && u.role !== "support");
  if (!usable.length) return { warning: `${hits[0].name} cannot own contacts (inactive or support)` };
  if (usable.length > 1) return { warning: `Owner "${t}" matches more than one team member` };
  return { id: usable[0].id };
}

/**
 * The product a row bought: the choice made in step 2 for that product text, else a catalogue product with the
 * same name (or a TagMango id/name pattern), else the row's family column, else the default family.
 */
export function resolveProduct(
  productText: string | null,
  familyText: string | null,
  ctx: Pick<CleanContext, "defaults" | "lists" | "products">,
): { productId: string | null; family: string; productName: string } | { error: string } {
  const text = cleanText(productText);
  const rowFamily = familyText ? listKeyFor(ctx.lists.families, familyText) : null;
  if (text) {
    const key = looseKey(text);
    const choice = ctx.defaults.productMap?.[key];
    if (choice?.productId) {
      const p = ctx.products.find((x) => x.id === choice.productId);
      if (p) return { productId: p.id, family: p.family, productName: text };
    }
    if (choice?.family && ctx.lists.families.some((f) => f.key === choice.family)) {
      return { productId: null, family: choice.family, productName: text };
    }
    const p =
      ctx.products.find((x) => looseKey(x.name) === key) ??
      ctx.products.find((x) => x.externalIds.some((e) => looseKey(e) === key));
    if (p) return { productId: p.id, family: p.family, productName: text };
    const family = rowFamily ?? ctx.defaults.productFamily;
    if (family) return { productId: null, family, productName: text };
    return { error: `No product family for "${text}": choose one in step 2` };
  }
  const family = rowFamily ?? ctx.defaults.productFamily;
  if (family) {
    const label = ctx.lists.families.find((f) => f.key === family)?.label ?? family;
    return { productId: null, family, productName: label };
  }
  return { error: "No product for this payment: map a product column or choose a default family in step 2" };
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** Cleans one mapped row. Never guesses: anything that cannot be read is left empty with a warning. */
export function cleanRow(mapped: MappedRow, ctx: CleanContext): CleanRow {
  const d = ctx.defaults;
  const errors: string[] = [];
  const warnings: string[] = [];
  const tz = ctx.timeZone || DEFAULT_TZ;

  // ---- identity
  const phones = cleanPhones(mapped.phones ?? (mapped.phone ? [mapped.phone] : []), mapped.alt_phone ? [mapped.alt_phone] : [], {
    dialCode: cleanText(mapped.dial_code),
    defaultCountry: d.defaultCountry || "IN",
  });
  for (const bad of phones.invalid) warnings.push(`"${bad}" is not a valid phone number`);
  const emails = splitEmails(mapped.email);
  for (const bad of emails.invalid) warnings.push(`"${bad}" is not a valid email`);
  const email = emails.valid[0] ?? null;
  const name = cleanName(mapped.name);
  if (mapped.name && !name) warnings.push(`"${mapped.name}" is not a name`);
  if (!phones.phone && !email) errors.push("No valid phone or email");

  // ---- profile
  let country: string | null = null;
  if (mapped.country) {
    country = countryFromText(mapped.country);
    if (!country) warnings.push(`Country "${mapped.country}" not recognised`);
  }
  const listed = (value: string | undefined, list: ListLike, what: string): string | null => {
    if (!value) return null;
    const key = listKeyFor(list, value);
    if (!key) warnings.push(`${what} "${value}" is not in the list`);
    return key;
  };
  const language = listed(mapped.language, ctx.lists.languages, "Language");
  let ageBand: string | null = null;
  if (mapped.age_band) {
    ageBand = ageBandFrom(mapped.age_band, ctx.lists.ageBands);
    if (!ageBand) warnings.push(`Age "${mapped.age_band}" fits no age band`);
  }
  const industry = listed(mapped.industry, ctx.lists.industries, "Industry");

  // ---- labels
  let firstDoor: string | null = null;
  if (mapped.first_door) {
    firstDoor = listKeyFor(ctx.lists.firstDoors, mapped.first_door);
    if (!firstDoor) warnings.push(`First door "${mapped.first_door}" is not in the list; the default is used`);
  }
  firstDoor ??= d.firstDoor;
  const campaignText = cleanText(mapped.campaign);
  const campaign = campaignText ? (listKeyFor(ctx.lists.campaigns, campaignText) ?? campaignText) : d.campaign;
  const tags = new Set<string>();
  for (const t of d.tags ?? []) if (cleanText(t)) tags.add(cleanText(t)!);
  for (const t of (mapped.tags ?? "").split(/[,;|]/)) if (cleanText(t)) tags.add(cleanText(t)!);
  if (d.tagWithCampaign && campaign) {
    tags.add(ctx.lists.campaigns.find((c) => c.key === campaign)?.label ?? campaign);
  }
  let ownerId: string | null = null;
  const owner = resolveOwner(mapped.owner, ctx.users);
  if (owner && "id" in owner) ownerId = owner.id;
  else if (owner) warnings.push(`${owner.warning}; the owner fallback is used`);
  let consent: boolean | null = null;
  if (mapped.consent) {
    consent = parseBool(mapped.consent);
    if (consent === null) warnings.push(`Consent "${mapped.consent}" is not yes or no`);
  }
  const refPhone = cleanText(mapped.referrer_phone);
  const refName = cleanName(mapped.referrer_name);
  const referrer = refPhone || refName ? { phone: refPhone, name: refName } : null;

  // ---- when the touch happened (old records must not look like fresh interest)
  let touchedAt: Date | null = null;
  if (mapped.enquired_at) {
    const at = parseDate(mapped.enquired_at, { dayFirst: d.dayFirst, timeZone: tz });
    if (!at) warnings.push(`Enquiry date "${mapped.enquired_at}" is not a date`);
    else if (at.getTime() > ctx.now.getTime() + 24 * 3600 * 1000) warnings.push(`Enquiry date ${mapped.enquired_at} is in the future`);
    else touchedAt = at;
  }
  if (!touchedAt && d.recordsDate) touchedAt = parseDate(d.recordsDate, { timeZone: tz });

  // ---- purchase
  let purchase: CleanPurchase | null = null;
  const amountText = cleanText(mapped.amount);
  if (amountText) {
    const parsed = parseAmount(amountText);
    if (!parsed) errors.push(`"${amountText}" is not an amount`);
    else if (parsed.amount < 0) errors.push(`Negative amount ${amountText}: refunds are not imported`);
    else if (parsed.amount > 0) {
      const currency =
        parsed.currency ?? (mapped.currency ? detectCurrency(mapped.currency) : null) ?? (d.currency || "INR").toUpperCase();
      if (mapped.currency && !parsed.currency && !detectCurrency(mapped.currency)) {
        warnings.push(`Currency "${mapped.currency}" not recognised; ${currency} is used`);
      }
      if (!ctx.currencies.includes(currency)) errors.push(`No exchange rate for ${currency} in Settings`);
      let purchasedAt: Date | null = null;
      if (mapped.purchased_at) {
        purchasedAt = parseDate(mapped.purchased_at, { dayFirst: d.dayFirst, timeZone: tz });
        if (!purchasedAt) errors.push(`"${mapped.purchased_at}" is not a date`);
        else if (purchasedAt.getTime() > ctx.now.getTime() + 24 * 3600 * 1000) {
          errors.push(`Purchase date ${mapped.purchased_at} is in the future`);
        }
      } else {
        errors.push("No purchase date for the payment: map a date column, or set the amount column to Ignore");
      }
      const product = resolveProduct(mapped.product ?? null, mapped.family ?? null, ctx);
      if ("error" in product) errors.push(product.error);
      const mode: PaymentMode =
        d.source === "tagmango" ? "tagmango" : (paymentModeFrom(mapped.payment_mode) ?? d.paymentMode ?? "other");
      if (mapped.payment_mode && d.source !== "tagmango" && !paymentModeFrom(mapped.payment_mode)) {
        warnings.push(`Payment mode "${mapped.payment_mode}" not recognised`);
      }
      purchase = {
        productName: "error" in product ? (cleanText(mapped.product) ?? "") : product.productName,
        productId: "error" in product ? null : product.productId,
        family: "error" in product ? null : product.family,
        amount: parsed.amount,
        currency,
        purchasedAt: purchasedAt ? purchasedAt.toISOString() : null,
        orderId: normalizeReference(cleanText(mapped.order_id), mode),
        paymentMode: mode,
      };
    }
  } else if (mapped.product || mapped.order_id) {
    warnings.push("No amount: no purchase is recorded");
  }

  return {
    phone: phones.phone,
    phoneCountry: phones.country,
    altPhones: phones.alt,
    name,
    email,
    altEmails: emails.valid.slice(1),
    city: cleanText(mapped.city),
    state: cleanText(mapped.state),
    country,
    language,
    ageBand,
    industry,
    designation: cleanText(mapped.designation),
    companyName: cleanText(mapped.company_name),
    firstDoor,
    campaign,
    tags: [...tags],
    ownerId,
    notes: mapped.notes ? mapped.notes.split("\n").map((l) => l.trim()).filter(Boolean).join("\n") || null : null,
    touchedAt: touchedAt ? touchedAt.toISOString() : null,
    consent,
    referrer,
    purchase,
    errors,
    warnings,
    valid: errors.length === 0,
  };
}
