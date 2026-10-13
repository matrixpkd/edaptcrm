/**
 * Phone numbers are the identity key. Everything that enters the CRM is normalised to E.164
 * here, defaulting to India. A UAE number typed as 05X XXX XXXX becomes +971 5X XXX XXXX.
 */
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

export type NormalisedPhone = {
  /** +919876543210 */
  e164: string;
  /** ISO country, e.g. "IN" */
  country: string | null;
  /** +91 98765 43210 */
  international: string;
};

/** Countries tried, in order, when a number without a country code is not valid for the default. */
const FALLBACK_COUNTRIES: CountryCode[] = ["AE", "SA", "QA", "KW", "BH", "OM", "IN"];

function clean(raw: string): string {
  let s = raw.trim();
  // Excel sometimes exports numbers as 9.19876543210E+11 or with a trailing ".0"
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  if (/^[\d.]+e\+\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = BigInt(Math.round(n)).toString();
  }
  // keep the first number when several are written in one cell ("98765 43210 / 98470 12345")
  const firstChunk = s.split(/[\/,;|]|\bor\b/i)[0] ?? s;
  s = firstChunk.replace(/(ext|x)\.?\s*\d+$/i, "");
  const plus = s.trim().startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (plus) return "+" + digits;
  if (digits.startsWith("00")) return "+" + digits.slice(2);
  return digits;
}

function attempt(value: string, country?: CountryCode): NormalisedPhone | null {
  const p = parsePhoneNumberFromString(value, country);
  if (!p || !p.isValid()) return null;
  return { e164: p.number, country: p.country ?? null, international: p.formatInternational() };
}

/**
 * Normalise any written phone number to E.164.
 * @param raw what was typed or imported
 * @param opts.defaultCountry country assumed when no code is written (default IN)
 * @param opts.dialCode a separate dial code such as "91" or "+971" (TagMango sends it separately)
 * @returns null when the number cannot be made valid
 */
export function normalizePhone(
  raw: string | number | null | undefined,
  opts: { defaultCountry?: string; dialCode?: string | number | null } = {},
): NormalisedPhone | null {
  if (raw === null || raw === undefined) return null;
  const s = clean(String(raw));
  if (!s) return null;
  const defaultCountry = (opts.defaultCountry?.toUpperCase() || "IN") as CountryCode;

  if (s.startsWith("+")) return attempt(s);

  const dial = opts.dialCode ? String(opts.dialCode).replace(/\D/g, "") : "";
  if (dial) {
    const national = s.replace(/^0+/, "");
    const joined = national.startsWith(dial) && national.length > dial.length + 7 ? national : dial + national;
    const r = attempt("+" + joined);
    if (r) return r;
  }

  const direct = attempt(s, defaultCountry);
  if (direct) return direct;

  // Written with a country code but no plus, e.g. 971501234567 or 919876543210
  if (s.length >= 11) {
    const r = attempt("+" + s.replace(/^0+/, ""));
    if (r) return r;
  }

  for (const c of FALLBACK_COUNTRIES) {
    if (c === defaultCountry) continue;
    const r = attempt(s, c);
    if (r) return r;
  }
  return null;
}

/** "+91 98765 43210" for display; returns the input when it cannot be parsed. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const p = parsePhoneNumberFromString(e164);
  return p ? p.formatInternational() : e164;
}

/** Digits only, for wa.me links. */
export function whatsappLink(e164: string, text?: string): string {
  const digits = e164.replace(/\D/g, "");
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function telLink(e164: string): string {
  return `tel:${e164}`;
}

/** Country of an E.164 number, e.g. "AE". */
export function phoneCountry(e164: string): string | null {
  return parsePhoneNumberFromString(e164)?.country ?? null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}
