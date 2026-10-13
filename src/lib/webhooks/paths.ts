/**
 * Reading values out of payloads whose exact shape we do not control. PURE (no server-only imports).
 *
 * A path is dot notation with optional indexes: "data.customer.phone", "items[0].name", "items.0.name".
 * Lookups are forgiving: a literal key "a.b" wins over nesting, keys match case- and punctuation-insensitively
 * ("Phone Number" finds phone_number), a step into an array without an index takes its first element, and a
 * string holding JSON is parsed when the path goes into it.
 */

export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** "Phone Number", "phone_number", "phoneNumber" -> "phonenumber" */
export function looseKeyOf(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** "a.b[0].c" -> ["a", "b", "0", "c"] */
export function splitPath(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\[["']?([^\]"']+)["']?\]/g, ".$1")
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonish(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!(s.startsWith("{") && s.endsWith("}")) && !(s.startsWith("[") && s.endsWith("]"))) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

function step(cur: unknown, seg: string): unknown {
  cur = parseJsonish(cur);
  if (UNSAFE_KEYS.has(seg)) return undefined;
  if (Array.isArray(cur)) {
    if (/^\d+$/.test(seg)) return cur[Number(seg)];
    // no index: look inside the first element
    return cur.length ? step(cur[0], seg) : undefined;
  }
  if (!isObject(cur)) return undefined;
  if (Object.prototype.hasOwnProperty.call(cur, seg)) return cur[seg];
  const want = looseKeyOf(seg);
  if (!want) return undefined;
  for (const k of Object.keys(cur)) {
    if (looseKeyOf(k) === want) return cur[k];
  }
  return undefined;
}

/** The value at `path`, or undefined. */
export function getPath(root: unknown, path: string): unknown {
  const p = path.trim();
  if (!p) return undefined;
  if (isObject(root) && Object.prototype.hasOwnProperty.call(root, p) && !UNSAFE_KEYS.has(p)) return root[p];
  let cur: unknown = root;
  for (const seg of splitPath(p)) {
    cur = step(cur, seg);
    if (cur === undefined || cur === null) return cur;
  }
  return cur;
}

/** Not null/undefined, not an empty or blank string, not an empty array or object. */
export function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return true;
}

export type Found<T> = { value: T; path: string };

/** The first path whose value converts (convert returns null to reject it), with the path that supplied it. */
export function findFirst<T>(root: unknown, paths: readonly string[], convert: (v: unknown) => T | null): Found<T> | null {
  for (const path of paths) {
    const raw = getPath(root, path);
    if (!isPresent(raw)) continue;
    const value = convert(raw);
    if (value !== null && value !== undefined) return { value, path };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

/** Trimmed text from a string, number or boolean; null for objects, arrays and blanks. */
export function asText(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    return s ? s : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return v.toString();
  return null;
}

/** A phone-ish value: text, a number written without exponent, or the first of an array of numbers. */
export function asPhoneText(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.round(v)).toString() : null;
  if (Array.isArray(v)) return v.length ? asPhoneText(v[0]) : null;
  return asText(v);
}

/**
 * 1499, "1499", "₹1,499.00", "Rs.1499", "INR 1499". Exactly one number may be written ("2 x 499" is rejected);
 * commas are grouping separators (Indian and English style).
 */
export function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,\s]/g, "");
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  if (!m) return null;
  const rest = s.slice(0, m.index) + s.slice(m.index + m[0].length);
  if (/\d/.test(rest)) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** A naive date-time: "2026-10-13 10:00", "2026-10-13T10:00:00.5" (no Z, no offset). */
const NAIVE_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/** The instant a wall-clock time in `timeZone` stands for (falls back to UTC for an unknown zone). */
function zonedInstant(parts: number[], timeZone: string): Date {
  const [y, mo, d, h, mi, s, ms] = parts;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return new Date(asUtc);
  }
  // the zone's offset at that moment (applied twice to settle across a DST change)
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return wall - Math.floor(t / 1000) * 1000;
  };
  let t = asUtc - offsetAt(asUtc);
  t = asUtc - offsetAt(t);
  return new Date(t);
}

/**
 * ISO strings, "2026-10-13 10:00:00", epoch seconds or milliseconds (number or numeric string). A date-time written
 * without a zone is read in `timeZone` (default UTC), never in the server's own zone.
 */
export function asDate(v: unknown, timeZone = "UTC"): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\d{9,13}(\.\d+)?$/.test(v.trim())) n = Number(v.trim());
  if (n !== null) {
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(s)) return null;
  const naive = NAIVE_DATE_TIME.exec(s);
  if (naive) {
    const parts = naive.slice(1).map((x, i) => (x === undefined ? 0 : i === 6 ? Number(x.padEnd(3, "0")) : Number(x)));
    const [, mo, day, h, mi, sec] = parts;
    if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || mi > 59 || sec > 59) return null;
    const d = zonedInstant(parts, timeZone);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "on", "agree", "agreed", "accepted", "checked", "opted in", "opt in", "subscribed"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off", "disagree", "declined", "unchecked", "opted out", "opt out", "unsubscribed"]);

export function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : null;
  const s = asText(v)?.toLowerCase().replace(/[_-]+/g, " ");
  if (!s) return null;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

const CURRENCY_SYMBOLS: Record<string, string> = { "₹": "INR", RS: "INR", "RS.": "INR", "$": "USD", "US$": "USD", "د.إ": "AED", DHS: "AED", DH: "AED" };

/** "inr" -> "INR", "₹" -> "INR"; null when it is not a three-letter code or a known symbol. */
export function asCurrency(v: unknown): string | null {
  const s = asText(v)?.toUpperCase();
  if (!s) return null;
  if (CURRENCY_SYMBOLS[s]) return CURRENCY_SYMBOLS[s];
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

/** JSON.stringify with sorted keys, so the same payload always hashes the same. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(",")}]`;
  const o = v as JsonObject;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** Lower-case words only: "Don't know him!" -> "dont know him". Used for whole-word phrase matching. */
export function phraseKey(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when `pattern` appears in `text` as whole words ("ad" matches "saw an ad", not "already"). */
export function containsPhrase(text: string | null | undefined, pattern: string | null | undefined): boolean {
  const p = phraseKey(pattern);
  if (!p) return false;
  return ` ${phraseKey(text)} `.includes(` ${p} `);
}

/** Case/space/punctuation-insensitive equality. */
export function looseEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = phraseKey(a);
  return x !== "" && x === phraseKey(b);
}
