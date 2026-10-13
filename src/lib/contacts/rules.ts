/**
 * Pure contact rules shared by the services and the UI (safe in client components: no server-only
 * imports). Everything here is deterministic and unit tested in tests/unit/contacts-rules.test.ts.
 */
import type { FieldSource, InteractionType, RatingSource } from "@/db/schema";
import { properCase } from "@/lib/utils";

// ---------------------------------------------------------------------------
// First door
// ---------------------------------------------------------------------------

/**
 * First door assumed for a NEW contact from the channel of its first enquiry, when nobody chose one.
 * A referrer always means "referral". Anything not listed falls back to "other".
 */
export const DEFAULT_FIRST_DOOR_BY_CHANNEL: Readonly<Record<string, string>> = {
  meta_lead_form: "meta_ad",
  website_form: "search_website",
  tagmango_checkout: "other",
  whatsapp_api: "other",
  whatsapp_app: "other",
  phone_call: "other",
  walk_in_event: "other",
  import: "other",
};

/** The label of "no rating of any kind" (unratedCondition in ./unrated.ts): Contacts filter, export, dashboard tile. */
export const UNRATED_LABEL = "Unrated (no rating at all)";

/**
 * Channels only the system records: TagMango checkouts arrive by webhook and "import" is the import wizard's.
 * Quick Add never offers them, and its action refuses them.
 */
export const SYSTEM_ONLY_CHANNELS: readonly string[] = ["import", "tagmango_checkout"];

/** True when a person may pick this channel for a manual entry (Quick Add). */
export function isManualChannel(key: string | null | undefined): boolean {
  return !!key && !SYSTEM_ONLY_CHANNELS.includes(key);
}

/** first_door = chosen door, else "referral" when a referrer came with the enquiry, else the channel default, else "other". */
export function decideFirstDoor(input: {
  firstDoor?: string | null;
  channel: string;
  hasReferrer: boolean;
}): string {
  const chosen = input.firstDoor?.trim();
  if (chosen) return chosen;
  if (input.hasReferrer) return "referral";
  return DEFAULT_FIRST_DOOR_BY_CHANNEL[input.channel] ?? "other";
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Case- and space-insensitive key used to compare names and cities: " Mohammed  ALI " -> "mohammed ali". */
export function looseKey(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when the stored name is only the phone number (what capture uses when no name is known). */
export function isPhoneFallbackName(name: string | null | undefined, phone: { e164: string; international?: string | null }): boolean {
  const n = (name ?? "").replace(/[\s\-()]/g, "");
  if (!n) return true;
  if (n === phone.e164) return true;
  if (phone.international && n === phone.international.replace(/[\s\-()]/g, "")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

export type RatingInput = {
  aiLevel?: number | null;
  umerLevel?: number | null;
  spendingBand?: number | null;
  gutStars?: number | null;
  ageBand?: string | null;
  industry?: string | null;
  notes?: string | null;
};

/** The six rated fields: input key -> contacts column (camelCase) and its key in contacts.field_sources. */
export const RATED_FIELDS = {
  aiLevel: { sourceKey: "ai_level", kind: "int", min: 0, max: 5, label: "AI knowledge" },
  umerLevel: { sourceKey: "umer_level", kind: "int", min: 0, max: 5, label: "Umer familiarity" },
  spendingBand: { sourceKey: "spending_band", kind: "int", min: 1, max: 5, label: "Spending power" },
  gutStars: { sourceKey: "gut_stars", kind: "int", min: 1, max: 5, label: "Gut rating" },
  ageBand: { sourceKey: "age_band", kind: "key", list: "ageBands", label: "Age band" },
  industry: { sourceKey: "industry", kind: "key", list: "industries", label: "Industry or role" },
} as const;

export type RatedField = keyof typeof RATED_FIELDS;
export const RATED_FIELD_KEYS = Object.keys(RATED_FIELDS) as RatedField[];

/**
 * Validates one rated value. Returns an error message, or null when valid.
 * Integer scales must be whole numbers in range; age band and industry must be keys of their settings list.
 */
export function ratingValueError(
  field: RatedField,
  value: unknown,
  lists: { ageBands: string[]; industries: string[] },
): string | null {
  const def = RATED_FIELDS[field];
  if (def.kind === "int") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < def.min || value > def.max) {
      return `${def.label} must be a whole number from ${def.min} to ${def.max}`;
    }
    return null;
  }
  const allowed = def.list === "ageBands" ? lists.ageBands : lists.industries;
  if (typeof value !== "string" || !allowed.includes(value)) return `${def.label} is not in the list`;
  return null;
}

/** Keeps only the rated values that are present and valid (used for self-ratings arriving with an enquiry). */
export function sanitizeRatings(
  input: RatingInput | null | undefined,
  lists: { ageBands: string[]; industries: string[] },
): RatingInput {
  const out: RatingInput = {};
  if (!input) return out;
  for (const f of RATED_FIELD_KEYS) {
    const v = input[f];
    if (v === null || v === undefined) continue;
    if (ratingValueError(f, v, lists) === null) (out as Record<string, unknown>)[f] = v;
  }
  if (input.notes?.trim()) out.notes = input.notes.trim();
  return out;
}

/**
 * The self-rating rule: a salesperson's rating overrides anything; a self or import rating only fills a
 * field whose current value did not come from sales.
 */
export function ratingMayOverwrite(current: FieldSource | undefined | null, incoming: RatingSource | FieldSource): boolean {
  if (incoming === "sales") return true;
  return current !== "sales";
}

// ---------------------------------------------------------------------------
// Arrays, dates, text
// ---------------------------------------------------------------------------

/** `base` plus every value of `add` not already in it (order kept), minus anything in `exclude`. */
export function addUnique(base: readonly string[], add: readonly (string | null | undefined)[], exclude: readonly (string | null | undefined)[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const skip = new Set(exclude.filter((x): x is string => !!x));
  for (const v of [...base, ...add]) {
    if (!v || seen.has(v) || skip.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Undo helper: removes from `current` exactly the values an operation added (`after` minus `before`). */
export function removeAdded(current: readonly string[], before: readonly string[], after: readonly string[]): string[] {
  const beforeSet = new Set(before);
  const added = new Set(after.filter((v) => !beforeSet.has(v)));
  return current.filter((v) => !added.has(v));
}

/** The later of two dates (null-safe). */
export function laterOf(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** The earlier of two dates (null-safe). */
export function earlierOf(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/** First `max` characters of a text on one line, with an ellipsis when cut. */
export function excerpt(text: string | null | undefined, max = 80): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

const INTERACTION_PHRASE: Record<InteractionType, string> = {
  call: "a call",
  whatsapp: "a WhatsApp chat",
  meeting: "a meeting",
  email: "an email",
  note: "a note",
  support_issue: "a support issue",
};

/**
 * The "why it is here" line of a follow-up task created from a logged interaction.
 * "Follow-up you set after a call: asked for the brochure"
 */
export function followUpReason(input: {
  type: InteractionType;
  summary?: string | null;
  outcomeLabel?: string | null;
  /** null when the person who set it is the task's assignee */
  setByName?: string | null;
}): string {
  const who = input.setByName ? `Follow-up set by ${input.setByName}` : "Follow-up you set";
  const detail = excerpt(input.summary) || input.outcomeLabel || "";
  return `${who} after ${INTERACTION_PHRASE[input.type] ?? "an interaction"}${detail ? `: ${detail}` : ""}`;
}

/** Two contact ids in a stable order, so a duplicate review pair is stored once whichever side is found first. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// ---------------------------------------------------------------------------
// Settings list values
// ---------------------------------------------------------------------------

/**
 * Maps a value to the key of a settings list, accepting the key itself or its label (case-insensitive),
 * e.g. "Malayalam" -> "ml". Returns null when nothing matches. Used for values arriving from webhooks/imports.
 */
export function listKeyFor(list: readonly { key: string; label: string }[], value: string | null | undefined): string | null {
  const v = looseKey(value);
  if (!v) return null;
  const hit = list.find((i) => looseKey(i.key) === v) ?? list.find((i) => looseKey(i.label) === v);
  return hit?.key ?? null;
}

/** ISO 3166-1 alpha-2 country code ("in" -> "IN"), or null when it is not two letters. */
export function countryCode(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

/** True for a canonical uuid (any version); shared with the money module, see @/lib/utils. */
export { isUuid } from "@/lib/utils";

/** Trimmed text with single spaces, or null when empty. */
export function cleanText(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().replace(/\s+/g, " ");
  return v ? v : null;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** The team a new lead goes to, from the phone's country and settings `assignment`. Pure. */
export function teamForCountry(
  phoneCountry: string | null | undefined,
  cfg: { gccCountries: string[]; gccTeam: string; defaultTeam: string },
): string {
  const cc = phoneCountry?.toUpperCase();
  if (cc && cfg.gccCountries.some((c) => c.toUpperCase() === cc)) return cfg.gccTeam;
  return cfg.defaultTeam;
}

// ---------------------------------------------------------------------------
// Places (city / state search dropdowns)
// ---------------------------------------------------------------------------

/**
 * Suggestions for a city or state search dropdown: the built-in names (settings lists are stored lower-case, so
 * they are shown in proper case) first in spelling priority, then what people already typed. Case, spacing and
 * punctuation differences count as the same place ("Kochi", " kochi ", "KOCHI"); sorted alphabetically.
 */
export function placeSuggestionList(builtIn: readonly string[], used: readonly string[], max = 500): string[] {
  const key = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const out = new Map<string, string>();
  for (const raw of builtIn) {
    const v = properCase(raw);
    if (v && !out.has(key(v))) out.set(key(v), v);
  }
  for (const raw of used) {
    const v = raw.trim().replace(/\s+/g, " ");
    if (v && key(v) && !out.has(key(v))) out.set(key(v), v);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b)).slice(0, max);
}
