/**
 * The offline fallbacks of the import wizard (pure, unit tested in tests/unit/import-heuristic.test.ts):
 * - a column mapper from header synonyms, helped by what the sample values look like;
 * - a row extractor for free-text docs: every line with a phone number (or an email) becomes a row.
 * Used whenever ANTHROPIC_API_KEY is missing or the Claude call fails, so imports always work.
 */
import { looseKey } from "@/lib/contacts/rules";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { parseAmount, parseDate } from "./clean";
import { FIELD_INFO, MULTI_FIELDS, TARGET_FIELDS, type ColumnMapping, type TargetField } from "./types";

/** "Contact No." -> "contact no", "customer_name" -> "customer name" */
export function normalizeHeader(h: string): string {
  // camelCase is split only in one-word headers ("orderID", "customerName"), never in "WhatsApp Number"
  const camel = /\s|_/.test(h.trim()) ? h : h.replace(/([a-z])([A-Z])/g, "$1 $2");
  return looseKey(camel.replace(/[_\-./#:()[\]*?]+/g, " ").replace(/\s+/g, " "))
    .replace(/\bwhats app\b/g, "whatsapp")
    .replace(/\btag mango\b/g, "tagmango");
}

/** Whole-header synonyms (after normalizeHeader). Checked before the keyword rules. */
const EXACT: Partial<Record<TargetField, string[]>> = {
  dial_code: ["dial code", "country code", "isd", "isd code", "calling code", "phone code", "dialcode", "country dial code", "phone country code", "dial"],
  alt_phone: [
    "alternate phone", "alternate number", "alternate mobile", "alternative number", "alt phone", "alt mobile", "alt number",
    "secondary phone", "secondary number", "other phone", "phone 2", "mobile 2", "phone2", "mobile2", "landline", "home phone",
    "work phone", "office phone", "second number", "alternate contact", "alt phones",
  ],
  phone: [
    "phone", "mobile", "whatsapp", "contact no", "contact number", "phone number", "mobile number", "whatsapp number",
    "whatsapp no", "mobile no", "phone no", "contact", "cell", "cell phone", "telephone", "tel", "ph", "mob", "mob no",
    "contact phone", "customer phone", "customer mobile", "buyer phone", "phone e164", "msisdn", "number", "phone numbers",
  ],
  email: ["email", "e mail", "email id", "email address", "mail", "mail id", "customer email", "buyer email", "emailid"],
  name: [
    "name", "full name", "customer name", "first name", "last name", "contact name", "lead name", "buyer name",
    "participant name", "attendee name", "student name", "member name", "given name", "surname", "family name",
    "customer", "participant", "attendee", "student", "fname", "lname",
  ],
  city: ["city", "town", "place", "location", "district", "city town", "home city", "mailing city"],
  state: ["state", "province", "emirate", "region", "mailing state"],
  country: ["country", "country name", "mailing country", "country region"],
  language: ["language", "preferred language", "lang", "mother tongue"],
  age_band: ["age", "age band", "age group", "age range", "age bracket"],
  industry: ["industry", "profession", "occupation", "sector", "industry role", "work"],
  designation: ["designation", "job title", "title", "position", "role", "job role"],
  company_name: ["company", "company name", "organisation", "organization", "business", "business name", "employer", "firm", "account name", "institution", "school"],
  first_door: ["first door", "lead source", "source", "how did you hear", "how did you hear about us", "heard from", "referral source"],
  campaign: ["campaign", "campaign name", "program", "programme", "program name", "event", "event name", "batch", "cohort"],
  tags: ["tags", "tag", "labels", "label"],
  owner: ["owner", "lead owner", "contact owner", "account owner", "salesperson", "sales person", "sales rep", "assigned to", "handled by", "counsellor", "counselor", "executive", "sales owner"],
  notes: ["notes", "note", "description", "remarks", "remark", "comments", "comment", "details", "feedback", "additional info", "other details"],
  product: ["product", "product name", "mango", "mango name", "course", "course name", "item", "item name", "package", "plan", "plan name", "workshop", "offering"],
  family: ["family", "product family", "category", "product category", "product type"],
  amount: ["amount", "price", "paid", "amount paid", "total", "total amount", "order amount", "net amount", "payment amount", "fee", "fees", "paid amount", "order value", "value", "grand total", "amount inr", "amount aed"],
  currency: ["currency", "curr", "currency code"],
  purchased_at: ["date", "order date", "purchase date", "payment date", "paid on", "paid at", "transaction date", "date of payment", "order time", "purchase time", "payment time", "date of purchase", "enrolled on", "enrollment date"],
  order_id: ["order id", "transaction id", "txn id", "utr", "utr no", "order no", "order number", "payment id", "invoice", "invoice no", "invoice number", "receipt no", "reference", "reference no", "ref no", "orderid"],
  payment_mode: ["payment mode", "payment method", "mode", "method", "gateway", "payment type", "payment gateway", "mode of payment"],
  referrer_phone: ["referrer phone", "referred by phone", "affiliate phone", "affiliate mobile", "affiliate number", "referrer mobile", "referrer number"],
  referrer_name: ["referrer", "referrer name", "referred by", "affiliate", "affiliate name", "reference by", "referral", "referred by name"],
  enquired_at: [
    "date added", "added on", "lead created",
    "lead created time", "enquiry date", "enquired on", "inquiry date", "enquiry time", "registration date", "registered on",
    "registered at", "attended on", "attendance date", "event date", "visit date", "date of visit", "signup date",
    "sign up date", "submitted at", "submission date", "submitted on", "timestamp", "lead date",
  ],
  consent: ["consent", "marketing consent", "opt in", "optin", "opted in", "subscribed", "whatsapp consent", "email opt in"],
};

const EXACT_INDEX: Map<string, TargetField> = (() => {
  const m = new Map<string, TargetField>();
  for (const f of TARGET_FIELDS) {
    if (f === "ignore") continue;
    m.set(normalizeHeader(f), f);
    m.set(normalizeHeader(FIELD_INFO[f].label), f);
  }
  for (const [f, list] of Object.entries(EXACT) as [TargetField, string[]][]) for (const h of list) m.set(h, f);
  return m;
})();

/** Keyword rules for headers that are not an exact synonym, in priority order. */
const RULES: { test: (h: string) => boolean; field: TargetField }[] = [
  { test: (h) => /\b(affiliate|referr|referred)/.test(h) && /\b(phone|mobile|number|no|contact|whatsapp)\b/.test(h), field: "referrer_phone" },
  { test: (h) => /\b(affiliate|referr|referred by)/.test(h), field: "referrer_name" },
  { test: (h) => /\b(order|transaction|txn|payment|invoice|receipt)\b.*\b(id|no|number|ref)\b|\butr\b/.test(h), field: "order_id" },
  { test: (h) => /\be ?mail\b/.test(h), field: "email" },
  { test: (h) => /\b(alternate|alternative|alt|secondary|other|second|office|home|work)\b/.test(h) && /\b(phone|mobile|number|no|contact|whatsapp)\b/.test(h), field: "alt_phone" },
  { test: (h) => /\b(dial|isd)\b|\bcountry code\b/.test(h), field: "dial_code" },
  { test: (h) => /\b(phone|mobile|whatsapp|cell|contact no|contact number|telephone)\b/.test(h), field: "phone" },
  { test: (h) => /\b(owner|salesperson|sales person|sales rep|assigned|handled by|counsell?or)\b/.test(h), field: "owner" },
  { test: (h) => /\b(company|business|organi[sz]ation|employer|firm|institution)\b/.test(h), field: "company_name" },
  { test: (h) => /\b(product|course|mango|item|package)\b/.test(h), field: "product" },
  { test: (h) => /\b(campaign|program|programme|event)\b/.test(h), field: "campaign" },
  { test: (h) => /\bname\b/.test(h), field: "name" },
  { test: (h) => /\b(currency)\b/.test(h), field: "currency" },
  { test: (h) => /\b(amount|price|paid|total|fee|fees)\b/.test(h) && !/\b(date|on|at|revenue|annual)\b/.test(h), field: "amount" },
  { test: (h) => /\b(order|purchase|payment|paid|transaction|enrol+ment|enrol+ed)\b.*\b(date|on|at|time)\b|\bdate\b/.test(h), field: "purchased_at" },
  { test: (h) => /\b(mode|method|gateway)\b/.test(h), field: "payment_mode" },
  { test: (h) => /\b(family|category)\b/.test(h), field: "family" },
  { test: (h) => /\b(lead source|first door|hear)\b/.test(h), field: "first_door" },
  { test: (h) => /\b(tags?|labels?)\b/.test(h), field: "tags" },
  { test: (h) => /\b(notes?|description|remarks?|comments?)\b/.test(h), field: "notes" },
  { test: (h) => /\b(city|town|district)\b/.test(h), field: "city" },
  { test: (h) => /\b(state|province|emirate)\b/.test(h), field: "state" },
  { test: (h) => /\bcountry\b/.test(h) && !/\bcode\b/.test(h), field: "country" },
  { test: (h) => /\b(language|lang)\b/.test(h), field: "language" },
  { test: (h) => /\bage\b/.test(h), field: "age_band" },
  { test: (h) => /\b(industry|profession|occupation|sector)\b/.test(h), field: "industry" },
  { test: (h) => /\b(designation|job title|position)\b/.test(h), field: "designation" },
  { test: (h) => /\b(consent|opt ?in|subscribed)\b/.test(h), field: "consent" },
];

/** Headers that look like data but are not this person's facts. */
const NEVER = /\b(nationality|annual revenue|revenue|no of employees|employees|created by|modified by|last activity|record id|s no|sl no|sr no|serial|birth|dob|anniversary|joining|modified time|last modified)\b/;

/** What a column's sample values look like (most non-empty values must agree). */
export function sniffValues(samples: string[]): TargetField | null {
  const vals = samples.map((s) => s.trim()).filter(Boolean);
  if (vals.length < 2) return null;
  const share = (fn: (v: string) => boolean) => vals.filter(fn).length / vals.length;
  if (share((v) => !!normalizeEmail(v)) >= 0.6) return "email";
  if (share((v) => /^[+\d][\d\s\-().]{6,}$/.test(v) && !!normalizePhone(v)) >= 0.6) return "phone";
  if (share((v) => /[a-z]/i.test(v) || /[/\-.]/.test(v)) >= 0.6 && share((v) => !!parseDate(v)) >= 0.6) return "purchased_at";
  if (share((v) => /₹|rs\.?|inr|aed|usd|\$/i.test(v) && !!parseAmount(v)) >= 0.6) return "amount";
  return null;
}

/** The field one header suggests on its own (null when unknown). */
export function fieldForHeader(header: string, opts: { hasAmount?: boolean } = {}): TargetField | null {
  const h = normalizeHeader(header);
  if (!h) return null;
  const exact = EXACT_INDEX.get(h);
  if (exact) return exact;
  if (NEVER.test(h)) return "ignore";
  // a record's created time is the order time in a file of orders, otherwise when the person first got in touch
  if (/\bcreated\b.*\b(at|on|time|date)\b|\bdate created\b/.test(h)) return opts.hasAmount ? "purchased_at" : "enquired_at";
  if (/\b(registered|registration|enquir\w*|inquir\w*|attended|attendance|visit|submitted|submission|sign ?up)\b.*\b(date|on|at|time)\b/.test(h)) {
    return "enquired_at";
  }
  for (const r of RULES) if (r.test(h)) return r.field;
  return null;
}

/**
 * Proposes a mapping for every column from its header, then its sample values. Each single-value field is used
 * once (a second phone column becomes the alternate phone); unknown columns are ignored.
 */
export function heuristicMapping(columns: { header: string; samples: string[] }[]): ColumnMapping {
  const hasAmount = columns.some((c) => fieldForHeader(c.header) === "amount");
  const used = new Set<TargetField>();
  const out: ColumnMapping = {};
  for (const col of columns) {
    let f: TargetField | null = fieldForHeader(col.header, { hasAmount }) ?? sniffValues(col.samples);
    // a date column is a purchase date only in a file with amounts (an attendance date is not)
    if (f === "purchased_at" && !hasAmount && !fieldForHeader(col.header)) f = "ignore";
    if (!f) f = "ignore";
    if (f !== "ignore" && used.has(f) && !MULTI_FIELDS.has(f)) f = "ignore";
    if (f === "phone" && used.has("phone")) f = "alt_phone";
    if (f === "email" && used.has("email")) f = "ignore";
    if (f !== "ignore") used.add(f);
    out[col.header] = f;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Free text (docs)
// ---------------------------------------------------------------------------

const PHONE_CANDIDATE = /(?:\+|00)?\d[\d\s\-().]{6,}\d/g;
const EMAIL = /[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[a-z]{2,}/i;

/** The headers of rows pulled out of free text by extractRowsFromText. */
export const TEXT_ROW_HEADERS = ["Name", "Phone", "Email", "Details"];

/**
 * Heuristic doc extraction: every line that contains a valid phone number (or, failing that, an email) becomes
 * one row. The phone and email are lifted out; the first remaining piece with letters is the name and the rest
 * is kept as details. Nothing else is guessed.
 */
export function extractRowsFromText(text: string, defaultCountry = "IN"): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    let phone: string | null = null;
    let rest = line;
    for (const m of line.match(PHONE_CANDIDATE) ?? []) {
      const np = normalizePhone(m, { defaultCountry });
      if (np) {
        phone = np.e164;
        rest = rest.replace(m, " ");
        break;
      }
    }
    const em = EMAIL.exec(rest);
    const email = em ? normalizeEmail(em[0]) : null;
    if (em) rest = rest.replace(em[0], " ");
    if (!phone && !email) continue;
    rest = rest
      .replace(/\s+/g, " ")
      .replace(/^\s*(?:\d{1,4}\s*[.)\]:-]|[-*•●▪◦·])\s*/, "")
      .trim();
    const pieces = rest
      .split(/\s*[|,;\t:–—]\s*|\s+-\s+/)
      .map((p) =>
        p
          .replace(/\b(?:ph|phone|mob|mobile|tel|whatsapp|email|e-mail|name)\s*[:.-]?\s*$/i, "")
          .replace(/^[\s\-–—:,.;]+|[\s\-–—:,.;]+$/g, "")
          .trim(),
      )
      .filter((p) => p && /\p{L}/u.test(p));
    const name = pieces.shift() ?? "";
    rows.push({ Name: name, Phone: phone ?? "", Email: email ?? "", Details: pieces.join(", ") });
  }
  return rows;
}
