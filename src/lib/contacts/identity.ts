import "server-only";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, duplicateReviews, users, type Contact, type Role, type Stage } from "@/db/schema";
import { canViewContact } from "@/lib/auth/permissions";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { resolveSurvivor } from "./internal";
import { selectContacts } from "./rows";
import { looseKey, orderedPair } from "./rules";

/**
 * One person, one record. The phone number is the identity key: match order is exact phone
 * (primary, then alternates), then exact email (primary, then alternates, case-insensitive).
 * Same name in the same city is NEVER a match; it is only flagged for a human in duplicate_reviews.
 * Merged rows are followed to the surviving contact and never returned.
 */

export type MatchedBy = "phone" | "alt_phone" | "email" | "alt_email";

export type MatchResult =
  | { contact: Contact; matchedBy: MatchedBy }
  | { contact: null; possibleDuplicates: Contact[] };

export type MatchInput = {
  /** raw as typed, or already E.164 */
  phone?: string | number | null;
  email?: string | null;
  name?: string | null;
  city?: string | null;
  dialCode?: string | null;
  defaultCountry?: string;
};

/** Contact holding this E.164 number as primary or alternate, with which one matched. */
export async function lookupByPhone(
  e164: string,
  tx: Tx = db,
): Promise<{ contact: Contact; matchedBy: "phone" | "alt_phone" } | null> {
  if (!e164) return null;
  const rows = await selectContacts(or(eq(contacts.phoneE164, e164), sql`${contacts.altPhones} @> array[${e164}]::text[]`)!, tx, {
    orderBy: sql`(${contacts.mergedIntoId} is null) desc, (${contacts.phoneE164} = ${e164}) desc, ${contacts.createdAt}`,
    limit: 5,
  });
  const survivor = await resolveSurvivor(rows[0], tx);
  if (!survivor) return null;
  return { contact: survivor, matchedBy: survivor.phoneE164 === e164 ? "phone" : "alt_phone" };
}

/** Contact holding this email as primary or alternate (case-insensitive), with which one matched. */
export async function lookupByEmail(
  rawEmail: string,
  tx: Tx = db,
): Promise<{ contact: Contact; matchedBy: "email" | "alt_email" } | null> {
  const email = normalizeEmail(rawEmail) ?? rawEmail?.trim().toLowerCase();
  if (!email) return null;
  const rows = await selectContacts(
    or(
      sql`lower(${contacts.email}) = ${email}`,
      // alternates are always stored lower-case by this module
      sql`${contacts.altEmails} @> array[${email}]::text[]`,
    )!,
    tx,
    {
      orderBy: sql`(${contacts.mergedIntoId} is null) desc, (lower(${contacts.email}) = ${email}) desc nulls last, ${contacts.createdAt}`,
      limit: 5,
    },
  );
  const survivor = await resolveSurvivor(rows[0], tx);
  if (!survivor) return null;
  return {
    contact: survivor,
    matchedBy: survivor.email && survivor.email.toLowerCase() === email ? "email" : "alt_email",
  };
}

/** The live contact for an E.164 number (primary or alternate). Follows merges; never returns a merged row. */
export async function findContactByPhone(e164: string, tx: Tx = db): Promise<Contact | null> {
  return (await lookupByPhone(e164, tx))?.contact ?? null;
}

/** The live contact for an email (primary or alternate, case-insensitive). Follows merges. */
export async function findContactByEmail(email: string, tx: Tx = db): Promise<Contact | null> {
  return (await lookupByEmail(email, tx))?.contact ?? null;
}

/** Live contacts with the same name (case/space-insensitive) in the same city. Never a match on its own. */
export async function findSameNameSameCity(
  name: string | null | undefined,
  city: string | null | undefined,
  tx: Tx = db,
  excludeId?: string,
): Promise<Contact[]> {
  const n = looseKey(name);
  const c = looseKey(city);
  if (!n || !c) return [];
  return selectContacts(
    and(
      isNull(contacts.mergedIntoId),
      // names are stored trimmed with single spaces, so the lower(name) index applies
      sql`lower(${contacts.name}) = ${n}`,
      sql`lower(regexp_replace(trim(${contacts.city}), '\\s+', ' ', 'g')) = ${c}`,
      excludeId ? ne(contacts.id, excludeId) : undefined,
    )!,
    tx,
    { orderBy: sql`${contacts.createdAt}`, limit: 20 },
  );
}

/**
 * Finds the one contact an inbound touch belongs to: exact phone, then exact email.
 * When nothing matches, returns same-name-same-city contacts as possible duplicates (never a match).
 */
export async function matchContact(input: MatchInput, tx: Tx = db): Promise<MatchResult> {
  if (input.phone !== null && input.phone !== undefined && String(input.phone).trim() !== "") {
    const np = normalizePhone(input.phone, { dialCode: input.dialCode, defaultCountry: input.defaultCountry });
    if (np) {
      const hit = await lookupByPhone(np.e164, tx);
      if (hit) return hit;
    }
  }
  if (input.email) {
    const hit = await lookupByEmail(input.email, tx);
    if (hit) return hit;
  }
  return { contact: null, possibleDuplicates: await findSameNameSameCity(input.name, input.city, tx) };
}

/**
 * Opens a duplicate review for each pair (contact, other). Pairs are stored in a stable order, so the same
 * pair is never flagged twice. Returns the ids of the other contacts that were flagged (new or already open).
 */
export async function flagPossibleDuplicates(
  contactId: string,
  otherIds: string[],
  reason: string,
  tx: Tx = db,
): Promise<string[]> {
  const flagged: string[] = [];
  for (const other of new Set(otherIds)) {
    if (other === contactId) continue;
    const [a, b] = orderedPair(contactId, other);
    await tx
      .insert(duplicateReviews)
      .values({ contactAId: a, contactBId: b, reason, status: "open" })
      .onConflictDoNothing({ target: [duplicateReviews.contactAId, duplicateReviews.contactBId] });
    flagged.push(other);
  }
  return flagged;
}

export type QuickAddDuplicate = {
  valid: boolean;
  e164: string | null;
  international: string | null;
  existing: null | {
    id: string;
    name: string;
    ownerId: string | null;
    ownerName: string | null;
    stage: Stage;
    grade: "A" | "B" | "C" | "D" | null;
    /** false when this user cannot open the contact (a salesperson looking at a colleague's contact) */
    visible: boolean;
  };
};

/**
 * The live duplicate check while typing in Quick Add: shows the existing contact and its owner before
 * anything is saved. A salesperson who cannot open the contact still sees its name and owner (visible=false)
 * so they can ask for a transfer instead of creating a clash.
 */
export async function checkQuickAddDuplicate(
  rawPhone: string,
  user: { id: string; role: Role },
  opts: { dialCode?: string | null; defaultCountry?: string; tx?: Tx } = {},
): Promise<QuickAddDuplicate> {
  const tx = opts.tx ?? db;
  const np = normalizePhone(rawPhone, { dialCode: opts.dialCode, defaultCountry: opts.defaultCountry });
  if (!np) return { valid: false, e164: null, international: null, existing: null };
  const contact = await findContactByPhone(np.e164, tx);
  if (!contact) return { valid: true, e164: np.e164, international: np.international, existing: null };
  let ownerName: string | null = null;
  if (contact.ownerId) {
    const rows = await tx.select({ name: users.name }).from(users).where(eq(users.id, contact.ownerId)).limit(1);
    ownerName = rows[0]?.name ?? null;
  }
  return {
    valid: true,
    e164: np.e164,
    international: np.international,
    existing: {
      id: contact.id,
      name: contact.name,
      ownerId: contact.ownerId,
      ownerName,
      stage: contact.stage,
      grade: contact.grade,
      visible: canViewContact(user, contact),
    },
  };
}
