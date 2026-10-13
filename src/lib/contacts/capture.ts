import "server-only";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { CONTACT_TYPES, contacts, enquiries, organisations, users, type Contact, type ContactType, type FieldSource, type NewContact } from "@/db/schema";
import { managerIds, notify } from "@/lib/alerts/core";
import { audit, auditDiff } from "@/lib/audit";
import { recomputeContact } from "@/lib/metrics/recompute";
import { formatPhone, normalizeEmail, normalizePhone, type NormalisedPhone } from "@/lib/phone";
import { getSettings, labelFor, type ListItem } from "@/lib/settings";
import { properCase } from "@/lib/utils";
import { pickAutoOwner, setOwner } from "./assignment";
import { ContactValidationError, InvalidPhoneError } from "./errors";
import { flagPossibleDuplicates, lookupByEmail, lookupByPhone, matchContact } from "./identity";
import { assertAssignableOwner, getContact, resolveSurvivor, withTx, wouldCreateReferralCycle } from "./internal";
import { applyRating } from "./profile";
import {
  RATED_FIELDS,
  addUnique,
  cleanText,
  countryCode,
  decideFirstDoor,
  isPhoneFallbackName,
  isUuid,
  laterOf,
  listKeyFor,
  sanitizeRatings,
} from "./rules";

export { InvalidPhoneError } from "./errors";
export { DEFAULT_FIRST_DOOR_BY_CHANNEL } from "./rules";

/**
 * THE single entry point for every inbound touch: Quick Add, webhooks (TagMango, Libromi, Pabbly), imports,
 * walk-ins. One person, one record: the touch is attached to the contact matched by phone, then email;
 * otherwise a new contact is created. See the spec sections "Capture", "One person, one record",
 * "Labels", "Ownership and handover rules" and "Alerts".
 */

export type CaptureProfile = Partial<{
  city: string | null;
  state: string | null;
  /** ISO 3166-1 alpha-2; defaults to the phone's country for a new contact */
  country: string | null;
  /** key (or label) from lists.languages */
  language: string | null;
  /** key (or label) from lists.ageBands */
  ageBand: string | null;
  /** key (or label) from lists.industries */
  industry: string | null;
  designation: string | null;
  companyName: string | null;
  type: ContactType;
  organisationId: string | null;
  consent: boolean;
}>;

export type CaptureInput = {
  phone: string | number;
  /** a separate dial code, e.g. TagMango's "91" */
  dialCode?: string | null;
  /** country assumed when no code is written (default IN) */
  defaultCountry?: string;
  name?: string | null;
  email?: string | null;
  /** channel key (lists.channels) */
  channel: string;
  /** first door key (lists.firstDoors); only used for a NEW contact */
  firstDoor?: string | null;
  /** campaign key (lists.campaigns) */
  campaign?: string | null;
  productInterest?: string | null;
  /** idempotency key from the source system; the same key twice changes nothing */
  sourceRef?: string | null;
  rawPayload?: unknown;
  receivedAt?: Date;
  /** the user doing a manual entry */
  createdById?: string | null;
  /** explicit owner, e.g. a salesperson's own Quick Add (active sales/manager/admin only) */
  ownerId?: string | null;
  /** enquiries.status, default "open" (e.g. "checkout_started") */
  enquiryStatus?: string;
  referrer?: { phone?: string | null; name?: string | null; contactId?: string | null } | null;
  profile?: CaptureProfile;
  /** self-ratings (WhatsApp welcome answers, TagMango custom fields): never override a sales rating */
  selfRatings?: Partial<{ aiLevel: number; umerLevel: number; ageBand: string; spendingBand: number }>;
  tags?: string[];
  notes?: string | null;
  importBatchId?: string | null;
  skipAlerts?: boolean;
  skipAssignment?: boolean;
  /**
   * Bulk imports only: skip the per-touch recompute because the caller recomputes every affected contact (and
   * its referrer) once at the end (recomputeContacts). Honoured only together with skipAlerts, since the hot-lead
   * alert reads the freshly computed grade.
   */
  skipRecompute?: boolean;
};

export type CaptureResult = {
  /** the contact after every change (re-read after recompute) */
  contact: Contact;
  /** true when this touch created the contact */
  created: boolean;
  enquiryId: string | null;
  /** true when sourceRef was seen before: nothing was changed */
  duplicateEnquiry: boolean;
  /** contacts flagged in duplicate_reviews (same name + same city, or the same email on another contact) */
  possibleDuplicateIds: string[];
  /** the referrer linked to (or found for) this touch, if any */
  referrerId: string | null;
  /** true when the referrer did not exist and was created */
  referrerCreated: boolean;
  /** for an existing contact: every profile field this touch changed, for import undo and review */
  changes: Record<string, { before: unknown; after: unknown }>;
  /** the existing contact as it was before this touch (read under lock); null for a new contact or a duplicate */
  before: Contact | null;
};

class SourceRefTaken extends Error {}

/** field_sources key marking a country that was only guessed from the phone number ("system"). */
const COUNTRY_SOURCE_KEY = "country";

/** Profile fields an inbound touch may fill when empty (never overwrite). */
const FILLABLE = [
  "city",
  "state",
  "country",
  "language",
  "ageBand",
  "industry",
  "designation",
  "companyName",
  "organisationId",
] as const;

/**
 * Records one inbound touch. Normalises the phone (throws InvalidPhoneError), is idempotent on sourceRef,
 * matches the contact (phone, then email), creates or enriches it, assigns an owner, links the referrer,
 * applies self-ratings, flags possible duplicates, recomputes and raises the New lead / Hot lead alerts.
 * Runs in one transaction (a savepoint when `tx` is already a transaction).
 */
export async function captureEnquiry(input: CaptureInput, tx: Tx = db): Promise<CaptureResult> {
  const np = normalizePhone(input.phone, { dialCode: input.dialCode, defaultCountry: input.defaultCountry });
  if (!np) throw new InvalidPhoneError(input.phone);
  const channel = cleanText(input.channel);
  if (!channel) throw new ContactValidationError("Choose a channel", "channel");
  const sourceRef = cleanText(input.sourceRef);

  return withTx(tx, async (t) => {
    if (sourceRef) {
      const dup = await existingBySourceRef(sourceRef, t);
      if (dup) return dup;
    }
    try {
      return await withTx(t, (s) => captureInner({ ...input, channel, sourceRef }, np, s));
    } catch (e) {
      // a parallel delivery of the same event won the race: report it as the duplicate it is
      if (e instanceof SourceRefTaken && sourceRef) {
        const dup = await existingBySourceRef(sourceRef, t);
        if (dup) return dup;
      }
      throw e;
    }
  });
}

async function existingBySourceRef(sourceRef: string, t: Tx): Promise<CaptureResult | null> {
  const rows = await t
    .select({ id: enquiries.id, contactId: enquiries.contactId })
    .from(enquiries)
    .where(eq(enquiries.sourceRef, sourceRef))
    .limit(1);
  if (!rows[0]) return null;
  const contact = await resolveSurvivor(await getContact(rows[0].contactId, t), t);
  if (!contact) return null;
  return {
    contact,
    created: false,
    enquiryId: rows[0].id,
    duplicateEnquiry: true,
    possibleDuplicateIds: [],
    referrerId: null,
    referrerCreated: false,
    changes: {},
    before: null,
  };
}

type Lists = {
  "lists.languages": ListItem[];
  "lists.ageBands": ListItem[];
  "lists.industries": ListItem[];
  "lists.channels": ListItem[];
  "lists.campaigns": ListItem[];
  "lists.firstDoors": ListItem[];
};

type CleanProfile = {
  city: string | null;
  state: string | null;
  country: string | null;
  language: string | null;
  ageBand: string | null;
  industry: string | null;
  designation: string | null;
  companyName: string | null;
  organisationId: string | null;
  type: ContactType | null;
  consent: boolean | null;
};

/** Values from outside are cleaned, never trusted: unknown list values and bad codes are dropped, not guessed. */
function cleanProfile(p: CaptureProfile | undefined, lists: Lists): CleanProfile {
  const x = p ?? {};
  return {
    city: cleanText(x.city),
    state: cleanText(x.state),
    country: countryCode(x.country),
    language: listKeyFor(lists["lists.languages"], x.language),
    ageBand: listKeyFor(lists["lists.ageBands"], x.ageBand),
    industry: listKeyFor(lists["lists.industries"], x.industry),
    designation: cleanText(x.designation),
    companyName: cleanText(x.companyName),
    organisationId: cleanText(x.organisationId),
    type: x.type && CONTACT_TYPES.includes(x.type) ? x.type : null,
    consent: typeof x.consent === "boolean" ? x.consent : null,
  };
}

async function captureInner(
  input: CaptureInput & { channel: string; sourceRef: string | null },
  np: NormalisedPhone,
  t: Tx,
): Promise<CaptureResult> {
  const now = new Date();
  const receivedAt = input.receivedAt ?? now;
  const lists = (await getSettings(
    ["lists.languages", "lists.ageBands", "lists.industries", "lists.channels", "lists.campaigns", "lists.firstDoors"],
    t,
  )) as Lists;
  // labels are stored as settings keys: a channel or campaign given by its label is stored as its key
  // (an unknown channel or campaign from outside is kept as given: it is per enquiry, never guessed)
  input = { ...input, channel: listKeyFor(lists["lists.channels"], input.channel) ?? input.channel };
  const profile = cleanProfile(input.profile, lists);
  if (profile.organisationId) {
    // a reference from outside that does not exist is dropped, never allowed to fail the whole touch
    const org = isUuid(profile.organisationId)
      ? await t.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, profile.organisationId)).limit(1)
      : [];
    if (!org[0]) profile.organisationId = null;
  }
  const email = normalizeEmail(input.email);
  const typedName = cleanText(input.name);
  const name = typedName ? properCase(typedName) : null;
  const rawCampaign = cleanText(input.campaign);
  const campaign = rawCampaign ? (listKeyFor(lists["lists.campaigns"], rawCampaign) ?? rawCampaign) : null;
  const createdById = input.createdById ?? null;
  const explicitOwner = input.ownerId ? (await assertAssignableOwner(input.ownerId, t)).id : null;
  const r = input.referrer;
  const hasReferrer = !!(r && (cleanText(r.contactId) || cleanText(r.phone) || cleanText(r.name)));
  const ratedSource: FieldSource = input.importBatchId || input.channel === "import" ? "import" : "system";

  const flagged = new Set<string>();
  const changes: CaptureResult["changes"] = {};
  let created = false;
  let contact: Contact;
  let before: Contact | null = null;

  // ---- 1. find or create the one record
  const match = await matchContact({ phone: np.e164, email, name, city: profile.city }, t);
  let matchedBy = match.contact ? match.matchedBy : null;
  if (match.contact) {
    contact = match.contact;
  } else {
    // the first door is stored forever: it must be a key of the list (a label is accepted and stored as its key)
    const chosenDoor = cleanText(input.firstDoor);
    const doorKey = chosenDoor ? listKeyFor(lists["lists.firstDoors"], chosenDoor) : null;
    if (chosenDoor && !doorKey) throw new ContactValidationError(`"${chosenDoor}" is not in the first door list`, "firstDoor");
    const firstDoor = decideFirstDoor({ firstDoor: doorKey, channel: input.channel, hasReferrer });
    const fieldSources: Record<string, FieldSource> = {};
    if (profile.ageBand) fieldSources[RATED_FIELDS.ageBand.sourceKey] = ratedSource;
    if (profile.industry) fieldSources[RATED_FIELDS.industry.sourceKey] = ratedSource;
    // a country taken from the phone number is a guess: marked, so a real country arriving later replaces it
    if (!profile.country && np.country) fieldSources[COUNTRY_SOURCE_KEY] = "system";
    const values: NewContact = {
      phoneE164: np.e164,
      phoneCountry: np.country,
      name: name ?? np.international,
      email,
      type: profile.type ?? "individual",
      organisationId: profile.organisationId,
      city: profile.city,
      state: profile.state,
      country: profile.country ?? np.country,
      language: profile.language,
      ageBand: profile.ageBand,
      industry: profile.industry,
      designation: profile.designation,
      companyName: profile.companyName,
      fieldSources,
      firstDoor,
      firstCampaign: campaign,
      firstChannel: input.channel,
      lastChannel: input.channel,
      lastCampaign: campaign,
      consent: profile.consent,
      consentAt: profile.consent === null ? null : receivedAt,
      stage: "new",
      stageChangedAt: now,
      tags: addUnique([], (input.tags ?? []).map((x) => cleanText(x))),
      createdById,
      importBatchId: input.importBatchId ?? null,
      lastEnquiryAt: receivedAt,
      lastActivityAt: receivedAt,
      // a historic touch (import) dates the record from when the person first appeared
      ...(input.receivedAt && input.receivedAt < now ? { createdAt: input.receivedAt } : {}),
    };
    const inserted = await t.insert(contacts).values(values).onConflictDoNothing({ target: contacts.phoneE164 }).returning();
    if (inserted[0]) {
      contact = inserted[0];
      created = true;
      for (const d of match.possibleDuplicates) flagged.add(d.id);
      if (flagged.size) await flagPossibleDuplicates(contact.id, [...flagged], "Same name in the same city", t);
    } else {
      // created by a parallel touch a moment ago: treat this one as a returning contact
      const again = await lookupByPhone(np.e164, t);
      if (!again) throw new Error(`Could not create or find the contact for ${np.e164}`);
      contact = again.contact;
      matchedBy = again.matchedBy;
    }
  }

  // ---- 2. a returning contact: enrich, never overwrite
  if (!created) {
    contact = await getContact(contact.id, t, { forUpdate: true });
    const c = contact;
    before = c;
    const patch: Partial<NewContact> = {};
    if (np.e164 !== c.phoneE164 && !c.altPhones.includes(np.e164)) {
      patch.altPhones = addUnique(c.altPhones, [np.e164], [c.phoneE164]);
    }
    if (email && email !== c.email?.toLowerCase() && !c.altEmails.includes(email)) {
      const other = matchedBy === "email" || matchedBy === "alt_email" ? null : await lookupByEmail(email, t);
      if (other && other.contact.id !== c.id) {
        // the same email on two people: a human decides, nothing is merged or copied
        await flagPossibleDuplicates(c.id, [other.contact.id], "Same email on two contacts", t);
        flagged.add(other.contact.id);
      } else if (!c.email) {
        patch.email = email;
      } else {
        patch.altEmails = addUnique(c.altEmails, [email], [c.email.toLowerCase()]);
      }
    }
    if (name && isPhoneFallbackName(c.name, { e164: c.phoneE164, international: formatPhone(c.phoneE164) })) {
      patch.name = name;
    }
    const sources: Record<string, FieldSource> = { ...(c.fieldSources ?? {}) };
    for (const f of FILLABLE) {
      const v = profile[f];
      const guessedCountry = f === "country" && sources[COUNTRY_SOURCE_KEY] === "system";
      if (v === null || (c[f] !== null && !guessedCountry)) continue;
      if (guessedCountry) {
        delete sources[COUNTRY_SOURCE_KEY];
        patch.fieldSources = sources;
        if (v === c.country) continue;
      }
      (patch as Record<string, unknown>)[f] = v;
      if (f === "ageBand" || f === "industry") sources[RATED_FIELDS[f].sourceKey] = ratedSource;
    }
    if (patch.ageBand !== undefined || patch.industry !== undefined) patch.fieldSources = sources;
    if (profile.consent !== null && c.consent === null) {
      patch.consent = profile.consent;
      patch.consentAt = receivedAt;
    }
    const tags = addUnique(c.tags, (input.tags ?? []).map((x) => cleanText(x)));
    if (tags.length !== c.tags.length) patch.tags = tags;

    for (const [k, v] of Object.entries(patch)) {
      if (k === "fieldSources") continue;
      changes[k] = { before: (c as Record<string, unknown>)[k] ?? null, after: v };
    }
    // activity markers: an older touch (e.g. an import of history) never moves "last" backwards
    const markers: Partial<NewContact> = {};
    if (!c.lastEnquiryAt || receivedAt >= c.lastEnquiryAt) {
      markers.lastEnquiryAt = receivedAt;
      markers.lastChannel = input.channel;
      if (campaign) markers.lastCampaign = campaign;
    }
    const activity = laterOf(c.lastActivityAt, receivedAt);
    if (activity !== c.lastActivityAt) markers.lastActivityAt = activity;

    if (Object.keys(patch).length || Object.keys(markers).length) {
      await t
        .update(contacts)
        .set({ ...patch, ...markers, updatedAt: now })
        .where(eq(contacts.id, c.id));
      // the row as it now stands (the values written are the values stored)
      contact = { ...c, ...patch, ...markers, updatedAt: now } as Contact;
    }
    if (Object.keys(changes).length) {
      const { fieldSources: _fs, ...auditable } = patch;
      void _fs;
      await auditDiff("contacts", c.id, c as unknown as Record<string, unknown>, auditable, createdById, t);
    }
  }

  // ---- 3. the referrer (resolved, or created when only a phone is known)
  let referrerId: string | null = null;
  let referrerCreated = false;
  let referrerNote: string | null = null;
  let referrerLinked = false;
  if (r && hasReferrer) {
    const res = await resolveReferrer(r, contact, input, t);
    if (res) {
      referrerId = res.id;
      referrerCreated = res.created;
      const current = await getContact(contact.id, t);
      if (!current.referredById && !(await wouldCreateReferralCycle(contact.id, res.id, t))) {
        await t.update(contacts).set({ referredById: res.id, updatedAt: now }).where(eq(contacts.id, contact.id));
        referrerLinked = true;
        if (!created) {
          changes.referredById = { before: null, after: res.id };
          await audit(
            { table: "contacts", rowId: contact.id, action: "update", field: "referredById", oldValue: null, newValue: res.id, userId: input.createdById ?? null },
            t,
          );
        }
      }
    } else if (cleanText(r.name)) {
      referrerNote = `Referred by ${cleanText(r.name)}${cleanText(r.phone) ? ` (${cleanText(r.phone)})` : ""}`;
    }
  }

  // ---- 4. owner: new leads are assigned; returning contacts stay with their owner (rule 2)
  // (`contact` is the row as written above; it is read again only when the referrer link changed it)
  const current = referrerLinked ? await getContact(contact.id, t) : contact;
  let ownerChanged = false;
  let ownerIsActive = true;
  if (current.ownerId) {
    // an owner who left without a handover cannot answer: treat the contact as being in the pool
    const o = await t
      .select({ active: users.active, role: users.role })
      .from(users)
      .where(eq(users.id, current.ownerId))
      .limit(1);
    ownerIsActive = !!o[0] && o[0].active && o[0].role !== "support";
  }
  if (!current.ownerId || !ownerIsActive) {
    const to = explicitOwner ?? (input.skipAssignment ? null : await pickAutoOwner(current.phoneCountry, t));
    if (to) {
      const reason = explicitOwner
        ? "Added by hand"
        : created
          ? "New lead: round robin"
          : current.ownerId
            ? "Owner inactive: new enquiry reassigned by round robin"
            : "New enquiry from the pool: round robin";
      // a contact created by this touch has no tasks to move yet
      const res = await setOwner(current.id, to, { reason, changedById: createdById, moveTasks: !created }, t);
      ownerChanged = res.changed;
    }
  }

  // ---- 5. the enquiry itself (idempotent on source_ref)
  const notes = [input.notes?.trim() || null, referrerNote].filter(Boolean).join("\n") || null;
  const inserted = await t
    .insert(enquiries)
    .values({
      contactId: contact.id,
      channel: input.channel,
      campaign,
      productInterest: cleanText(input.productInterest),
      sourceRef: input.sourceRef,
      rawPayload: (input.rawPayload ?? null) as unknown,
      receivedAt,
      status: cleanText(input.enquiryStatus) ?? "open",
      createdById,
      notes,
    })
    .onConflictDoNothing({ target: enquiries.sourceRef })
    .returning({ id: enquiries.id });
  if (!inserted[0]) throw new SourceRefTaken();
  const enquiryId = inserted[0].id;

  // ---- 6. self-ratings fill only what sales has not rated
  const self = sanitizeRatings(input.selfRatings, {
    ageBands: lists["lists.ageBands"].map((i) => i.key),
    industries: lists["lists.industries"].map((i) => i.key),
  });
  delete self.notes;
  const selfRated = Object.keys(self).length > 0;
  if (selfRated) await applyRating(contact.id, self, "self", null, t, { recompute: false });

  // ---- 7. calculated columns (a bulk import recomputes once at the end of its chunk instead)
  const recompute = !(input.skipRecompute && input.skipAlerts);
  if (recompute) {
    await recomputeContact(contact.id, t);
    if (referrerId) await recomputeContact(referrerId, t);
  }

  // ---- 8. alerts (the row is read again only when something above changed it since `current`)
  const fresh = recompute || ownerChanged || selfRated ? await getContact(contact.id, t) : current;
  if (!input.skipAlerts) {
    const channelLabel = labelFor(lists["lists.channels"], input.channel);
    const campaignLabel = campaign ? labelFor(lists["lists.campaigns"], campaign) : null;
    const body = [channelLabel, campaignLabel].filter(Boolean).join(" · ");
    const owner = fresh.ownerId;
    if (owner && owner !== createdById) {
      if (created) {
        await notify(
          { userId: owner, type: "new_lead", title: `New lead: ${fresh.name}`, body, contactId: fresh.id, dedupeKey: `new_lead:${fresh.id}:${owner}` },
          t,
        );
      } else {
        await notify(
          {
            userId: owner,
            type: ownerChanged ? "new_lead" : "new_enquiry",
            title: ownerChanged ? `New lead: ${fresh.name}` : `${fresh.name} enquired again`,
            body,
            contactId: fresh.id,
            dedupeKey: `enquiry:${enquiryId}`,
          },
          t,
        );
      }
    }
    if (fresh.purchaseCount === 0 && fresh.grade === "A") {
      const recipients = new Set<string>(await managerIds(t));
      if (owner) recipients.add(owner);
      // whoever entered the lead already knows about it, even when they are a manager
      if (createdById) recipients.delete(createdById);
      await notify(
        [...recipients].map((userId) => ({
          userId,
          type: "hot_lead",
          title: `Hot lead: ${fresh.name}`,
          body: `Grade A lead enquired${body ? ` via ${body}` : ""}`,
          contactId: fresh.id,
          email: true,
          dedupeKey: `hot_lead:${enquiryId}`,
        })),
        t,
      );
    }
  }

  return {
    contact: fresh,
    created,
    enquiryId,
    duplicateEnquiry: false,
    possibleDuplicateIds: [...flagged],
    referrerId,
    referrerCreated,
    changes,
    before,
  };
}

/**
 * The referrer: by contact id, else by phone. A phone nobody has yet becomes a new contact (first door "other",
 * the touch's channel, auto-assigned). A contact never refers itself.
 */
async function resolveReferrer(
  r: NonNullable<CaptureInput["referrer"]>,
  contact: Contact,
  input: CaptureInput & { channel: string },
  t: Tx,
): Promise<{ id: string; created: boolean } | null> {
  const refContactId = cleanText(r.contactId);
  if (refContactId && isUuid(refContactId)) {
    const rows = await t.select().from(contacts).where(eq(contacts.id, refContactId)).limit(1);
    const ref = await resolveSurvivor(rows[0], t);
    if (ref && ref.id !== contact.id) return { id: ref.id, created: false };
    if (ref) return null;
  }
  const rawPhone = cleanText(r.phone);
  if (!rawPhone) return null;
  const rp = normalizePhone(rawPhone, { defaultCountry: input.defaultCountry });
  if (!rp) return null;
  if (rp.e164 === contact.phoneE164 || contact.altPhones.includes(rp.e164)) return null;
  const found = await lookupByPhone(rp.e164, t);
  if (found) return found.contact.id === contact.id ? null : { id: found.contact.id, created: false };

  const now = new Date();
  const typed = cleanText(r.name);
  const inserted = await t
    .insert(contacts)
    .values({
      phoneE164: rp.e164,
      phoneCountry: rp.country,
      name: typed ? properCase(typed) : rp.international,
      country: rp.country,
      firstDoor: "other",
      firstChannel: input.channel,
      lastChannel: input.channel,
      stage: "new",
      stageChangedAt: now,
      createdById: input.createdById ?? null,
      importBatchId: input.importBatchId ?? null,
    })
    .onConflictDoNothing({ target: contacts.phoneE164 })
    .returning();
  const ref = inserted[0];
  if (!ref) {
    const again = await lookupByPhone(rp.e164, t);
    return again && again.contact.id !== contact.id ? { id: again.contact.id, created: false } : null;
  }
  const owner = await pickAutoOwner(rp.country, t);
  if (owner) {
    await setOwner(ref.id, owner, { reason: "New referrer: round robin", changedById: input.createdById ?? null }, t);
    if (!input.skipAlerts && owner !== input.createdById) {
      await notify(
        {
          userId: owner,
          type: "new_lead",
          title: `New lead: ${ref.name}`,
          body: `Referred ${contact.name}`,
          contactId: ref.id,
          dedupeKey: `new_lead:${ref.id}:${owner}`,
        },
        t,
      );
    }
  }
  return { id: ref.id, created: true };
}
