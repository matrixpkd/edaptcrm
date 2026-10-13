import "server-only";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  CONTACT_TYPES,
  RATING_SOURCES,
  contacts,
  organisations,
  ratings,
  users,
  type Contact,
  type ContactType,
  type FieldSource,
  type NewContact,
  type RatingSource,
} from "@/db/schema";
import { auditDiff } from "@/lib/audit";
import { can, canEditContact } from "@/lib/auth/permissions";
import { recomputeContact } from "@/lib/metrics/recompute";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import {
  ContactConflictError,
  ContactForbiddenError,
  ContactValidationError,
  InvalidPhoneError,
} from "./errors";
import { getContact, getLiveContact, resolveSurvivor, withTx, wouldCreateReferralCycle, type Actor } from "./internal";
import {
  RATED_FIELDS,
  RATED_FIELD_KEYS,
  addUnique,
  cleanText,
  countryCode,
  isUuid,
  ratingMayOverwrite,
  ratingValueError,
  type RatedField,
  type RatingInput,
} from "./rules";

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

export type ApplyRatingResult = {
  ratingId: string;
  /** fields written to the contact */
  applied: RatedField[];
  /** fields kept as they were because a salesperson already rated them (self/import only) */
  skipped: RatedField[];
};

/**
 * Records a rating and updates the contact's latest values.
 * - Validates ranges: AI knowledge 0-5, Umer familiarity 0-5, spending band 1-5, gut stars 1-5; age band and
 *   industry must be keys of their settings lists. Missing (null/undefined) values are simply not rated.
 * - Always inserts a ratings history row (who + when + source), even when nothing on the contact changes.
 * - A "sales" rating overrides anything. A "self" or "import" rating only fills a field whose current
 *   field_sources value is not "sales". field_sources records where each value came from.
 * - Then recomputes the contact (pass opts.recompute=false when the caller recomputes itself).
 * Permission checks (can(user,"ratings.edit") + canEditContact) belong to the caller; support can never give a
 * sales rating.
 */
export async function applyRating(
  contactId: string,
  rating: RatingInput,
  source: RatingSource,
  actorId: string | null,
  tx: Tx = db,
  opts: { recompute?: boolean } = {},
): Promise<ApplyRatingResult> {
  if (!RATING_SOURCES.includes(source)) throw new ContactValidationError("Unknown rating source");
  const lists = await getSettings(["lists.ageBands", "lists.industries"], tx);
  const keys = { ageBands: lists["lists.ageBands"].map((i) => i.key), industries: lists["lists.industries"].map((i) => i.key) };
  const values: Partial<Record<RatedField, number | string>> = {};
  for (const f of RATED_FIELD_KEYS) {
    const v = rating[f];
    if (v === null || v === undefined) continue;
    const err = ratingValueError(f, v, keys);
    if (err) throw new ContactValidationError(err, f);
    values[f] = v;
  }
  const notes = rating.notes?.trim() || null;
  if (!Object.keys(values).length && !notes) throw new ContactValidationError("Nothing to rate");

  if (source === "sales" && actorId) {
    const u = await tx.select({ role: users.role }).from(users).where(eq(users.id, actorId)).limit(1);
    if (u[0]?.role === "support") throw new ContactForbiddenError("Support cannot rate customers");
  }

  return withTx(tx, async (t) => {
    const c = await getLiveContact(contactId, t, { forUpdate: true });
    const [row] = await t
      .insert(ratings)
      .values({
        contactId,
        ratedByUserId: actorId,
        source,
        aiLevel: (values.aiLevel as number | undefined) ?? null,
        umerLevel: (values.umerLevel as number | undefined) ?? null,
        spendingBand: (values.spendingBand as number | undefined) ?? null,
        gutStars: (values.gutStars as number | undefined) ?? null,
        ageBand: (values.ageBand as string | undefined) ?? null,
        industry: (values.industry as string | undefined) ?? null,
        notes,
      })
      .returning({ id: ratings.id });

    const applied: RatedField[] = [];
    const skipped: RatedField[] = [];
    const sources: Record<string, FieldSource> = { ...(c.fieldSources ?? {}) };
    const patch: Record<string, unknown> = {};
    for (const f of Object.keys(values) as RatedField[]) {
      const key = RATED_FIELDS[f].sourceKey;
      if (!ratingMayOverwrite(sources[key], source)) {
        skipped.push(f);
        continue;
      }
      patch[f] = values[f];
      sources[key] = source;
      applied.push(f);
    }
    if (applied.length) {
      await t
        .update(contacts)
        .set({ ...(patch as Partial<NewContact>), fieldSources: sources, updatedAt: new Date() })
        .where(eq(contacts.id, contactId));
      await auditDiff("contacts", contactId, c as unknown as Record<string, unknown>, patch, actorId, t);
    }
    if (opts.recompute !== false) await recomputeContact(contactId, t);
    return { ratingId: row.id, applied, skipped };
  });
}

// ---------------------------------------------------------------------------
// Profile edits
// ---------------------------------------------------------------------------

export type ProfilePatch = {
  name?: string;
  /** a new primary number; normalised, rejected if it belongs to another contact */
  phone?: string;
  email?: string | null;
  type?: ContactType;
  organisationId?: string | null;
  city?: string | null;
  state?: string | null;
  /** ISO 3166-1 alpha-2 */
  country?: string | null;
  /** key from lists.languages */
  language?: string | null;
  /** key from lists.ageBands (a rated field: recorded as a sales rating) */
  ageBand?: string | null;
  /** key from lists.industries (a rated field: recorded as a sales rating) */
  industry?: string | null;
  designation?: string | null;
  companyName?: string | null;
  salesNotes?: string | null;
  consent?: boolean | null;
  /** the full new tag list */
  tags?: string[];
  altPhones?: { add?: string[]; remove?: string[] };
  altEmails?: { add?: string[]; remove?: string[] };
  referredById?: string | null;
  lastCampaign?: string | null;
  /** immutable: only an admin may correct it (audited) */
  firstDoor?: string;
};

/**
 * Edits a contact's profile. Only the fields of ProfilePatch are editable; calculated columns, owner and
 * stage have their own services. Requires canEditContact (support cannot edit). Every change is audited;
 * age band / industry changes are recorded as sales ratings (field_sources = "sales"); the contact is
 * recomputed (and the old/new referrer when the referrer changes). Returns the updated contact.
 */
export async function updateContactProfile(
  contactId: string,
  patch: ProfilePatch,
  actor: Actor,
  tx: Tx = db,
): Promise<Contact> {
  return withTx(tx, async (t) => {
    const c = await getLiveContact(contactId, t, { forUpdate: true });
    if (!can(actor, "contacts.edit") || !canEditContact(actor, c)) {
      throw new ContactForbiddenError("You cannot edit this contact");
    }
    const lists = await getSettings(["lists.languages", "lists.ageBands", "lists.industries", "lists.firstDoors"], t);
    const next: Partial<NewContact> = {};
    let sources: Record<string, FieldSource> = { ...(c.fieldSources ?? {}) };
    let sourcesChanged = false;
    /** present in the patch (null means "clear it"; undefined means "leave it") */
    const has = (k: keyof ProfilePatch) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;

    // --- name
    if (has("name")) {
      const name = cleanText(patch.name);
      if (!name) throw new ContactValidationError("Name cannot be empty", "name");
      if (name.length > 200) throw new ContactValidationError("Name is too long", "name");
      if (name !== c.name) next.name = name;
    }

    // --- phones
    let primary = c.phoneE164;
    let altPhones = [...c.altPhones];
    const defaultCountry = c.phoneCountry ?? "IN";
    if (has("phone")) {
      const np = normalizePhone(patch.phone, { defaultCountry });
      if (!np) throw new InvalidPhoneError(patch.phone);
      if (np.e164 !== primary) {
        await assertPhoneFree(np.e164, c.id, t, "phone");
        if (altPhones.includes(np.e164)) {
          // promoting an alternate: the old primary stays as an alternate
          altPhones = addUnique(altPhones, [primary], [np.e164]);
        }
        primary = np.e164;
        next.phoneE164 = np.e164;
        next.phoneCountry = np.country;
      }
    }
    if (patch.altPhones) {
      for (const raw of patch.altPhones.remove ?? []) {
        const e = normalizePhone(raw, { defaultCountry })?.e164 ?? raw.trim();
        altPhones = altPhones.filter((p) => p !== e);
      }
      for (const raw of patch.altPhones.add ?? []) {
        const np = normalizePhone(raw, { defaultCountry });
        if (!np) throw new InvalidPhoneError(raw, "altPhones");
        if (np.e164 === primary || altPhones.includes(np.e164)) continue;
        await assertPhoneFree(np.e164, c.id, t, "altPhones");
        altPhones.push(np.e164);
      }
    }
    altPhones = addUnique([], altPhones, [primary]);
    if (!sameArray(altPhones, c.altPhones)) next.altPhones = altPhones;

    // --- emails (always lower-case)
    let email = c.email;
    let altEmails = [...c.altEmails];
    if (has("email")) {
      if (patch.email === null || !String(patch.email).trim()) {
        email = null;
      } else {
        const e = normalizeEmail(patch.email);
        if (!e) throw new ContactValidationError("Enter a valid email address", "email");
        if (e !== email?.toLowerCase() && altEmails.includes(e) && email) altEmails = addUnique(altEmails, [email.toLowerCase()]);
        email = e;
      }
      if (email !== c.email) next.email = email;
    }
    if (patch.altEmails) {
      for (const raw of patch.altEmails.remove ?? []) {
        const e = raw.trim().toLowerCase();
        altEmails = altEmails.filter((x) => x !== e);
      }
      for (const raw of patch.altEmails.add ?? []) {
        const e = normalizeEmail(raw);
        if (!e) throw new ContactValidationError(`"${raw}" is not a valid email address`, "altEmails");
        altEmails.push(e);
      }
    }
    altEmails = addUnique([], altEmails, [email?.toLowerCase()]);
    if (!sameArray(altEmails, c.altEmails)) next.altEmails = altEmails;

    // --- simple fields
    if (has("type")) {
      if (!CONTACT_TYPES.includes(patch.type!)) throw new ContactValidationError("Choose individual or business", "type");
      if (patch.type !== c.type) next.type = patch.type;
    }
    if (has("organisationId")) {
      const orgId = patch.organisationId ?? null;
      if (orgId) {
        if (!isUuid(orgId)) throw new ContactValidationError("That organisation does not exist", "organisationId");
        const o = await t.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
        if (!o[0]) throw new ContactValidationError("That organisation does not exist", "organisationId");
      }
      if (orgId !== c.organisationId) next.organisationId = orgId;
    }
    // spec "Customer profile": the organisation is required for a B2B (business) contact. Checked when this edit
    // makes the contact a business or unlinks its organisation, so older records can still be edited otherwise.
    if (next.type !== undefined || next.organisationId !== undefined) {
      const type = next.type ?? c.type;
      const orgId = next.organisationId !== undefined ? next.organisationId : c.organisationId;
      if (type === "business" && !orgId) {
        throw new ContactValidationError("Link the school, office or company for a business contact", "organisationId");
      }
    }
    for (const f of ["city", "state", "designation", "companyName", "lastCampaign"] as const) {
      if (!has(f)) continue;
      const v = cleanText(patch[f]);
      if (v !== c[f]) next[f] = v;
    }
    if (has("salesNotes")) {
      const v = patch.salesNotes?.trim() || null;
      if (v !== c.salesNotes) next.salesNotes = v;
    }
    if (has("country")) {
      const raw = cleanText(patch.country);
      const v = raw ? countryCode(raw) : null;
      if (raw && !v) throw new ContactValidationError("Use a two-letter country code, e.g. IN or AE", "country");
      if (v !== c.country) next.country = v;
      // a person chose it: no longer a guess from the phone number (see capture)
      if (c.fieldSources?.country === "system") {
        sources = { ...sources };
        delete sources.country;
        sourcesChanged = true;
      }
    }
    if (has("language")) {
      const v = cleanText(patch.language);
      if (v && !lists["lists.languages"].some((i) => i.key === v)) {
        throw new ContactValidationError("Choose a language from the list", "language");
      }
      if (v !== c.language) next.language = v;
    }
    if (has("consent")) {
      const v = patch.consent ?? null;
      if (v !== c.consent) {
        next.consent = v;
        next.consentAt = v === null ? null : new Date();
      }
    }
    if (has("tags")) {
      const tags = addUnique([], (patch.tags ?? []).map((x) => cleanText(x)));
      if (!sameArray(tags, c.tags)) next.tags = tags;
    }

    // --- referrer: never itself, never a loop
    if (has("referredById")) {
      let refId: string | null = null;
      if (patch.referredById) {
        const refRows = isUuid(patch.referredById)
          ? await t.select().from(contacts).where(eq(contacts.id, patch.referredById)).limit(1)
          : [];
        const ref = await resolveSurvivor(refRows[0], t);
        if (!ref) throw new ContactValidationError("That referrer does not exist", "referredById");
        if (ref.id === c.id) throw new ContactValidationError("A contact cannot refer itself", "referredById");
        if (await wouldCreateReferralCycle(c.id, ref.id, t)) {
          throw new ContactValidationError("That would make a referral loop", "referredById");
        }
        refId = ref.id;
      }
      if (refId !== c.referredById) next.referredById = refId;
    }

    // --- first door: immutable, only an admin may correct it
    if (has("firstDoor") && patch.firstDoor !== c.firstDoor) {
      if (actor.role !== "admin") throw new ContactForbiddenError("Only an admin can correct the first door");
      const door = cleanText(patch.firstDoor);
      if (!door || !lists["lists.firstDoors"].some((i) => i.key === door)) {
        throw new ContactValidationError("Choose a first door from the list", "firstDoor");
      }
      next.firstDoor = door;
    }

    // --- rated profile fields go through the ratings history
    const rated: RatingInput = {};
    const clearRated: RatedField[] = [];
    for (const f of ["ageBand", "industry"] as const) {
      if (!has(f)) continue;
      const v = cleanText(patch[f]);
      if (v === c[f]) continue;
      if (v === null) clearRated.push(f);
      else rated[f] = v;
    }
    if (clearRated.length) {
      for (const f of clearRated) {
        (next as Record<string, unknown>)[f] = null;
        delete sources[RATED_FIELDS[f].sourceKey];
      }
      sourcesChanged = true;
    }
    if (sourcesChanged) next.fieldSources = sources;

    if (Object.keys(next).length) {
      await t.update(contacts).set({ ...next, updatedAt: new Date() }).where(eq(contacts.id, c.id));
      const { fieldSources: _fs, ...auditable } = next;
      void _fs;
      await auditDiff("contacts", c.id, c as unknown as Record<string, unknown>, auditable, actor.id, t);
    }
    if (Object.keys(rated).length) {
      await applyRating(c.id, rated, "sales", actor.id, t, { recompute: false });
    }

    const changedAnything = Object.keys(next).length > 0 || Object.keys(rated).length > 0;
    if (changedAnything) {
      await recomputeContact(c.id, t);
      if (next.referredById !== undefined) {
        for (const r of new Set([c.referredById, next.referredById])) if (r) await recomputeContact(r, t);
      }
    }
    return getContact(c.id, t);
  });
}

/** Throws when another contact already holds this number (as primary — merged rows included — or as a live alternate). */
async function assertPhoneFree(e164: string, selfId: string, tx: Tx, field: string): Promise<void> {
  const rows = await tx
    .select({ id: contacts.id, name: contacts.name, mergedIntoId: contacts.mergedIntoId })
    .from(contacts)
    .where(
      and(
        ne(contacts.id, selfId),
        or(
          eq(contacts.phoneE164, e164),
          and(isNull(contacts.mergedIntoId), sql`${contacts.altPhones} @> array[${e164}]::text[]`),
        ),
      ),
    )
    .limit(1);
  const other = rows[0];
  if (!other) return;
  if (other.mergedIntoId === selfId) {
    throw new ContactConflictError("This number belongs to a record merged into this one; undo that merge first", other.id, field);
  }
  throw new ContactConflictError(`This number already belongs to ${other.name}`, other.id, field);
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
