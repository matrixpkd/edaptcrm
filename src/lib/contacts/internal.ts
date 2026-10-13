import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, type Database, type Tx } from "@/db";
import { contacts, users, type Contact, type Role, type User } from "@/db/schema";
import { ContactMergedError, ContactNotFoundError, ContactValidationError } from "./errors";
import { isUuid } from "./rules";

/** The signed-in user acting on a contact (SessionUser satisfies this). */
export type Actor = { id: string; role: Role };

/**
 * Runs `fn` atomically. On the root handle it opens a transaction; inside an open transaction it opens a
 * savepoint, so the caller's transaction is used and a thrown error only rolls back this unit of work.
 */
export function withTx<T>(tx: Tx, fn: (t: Tx) => Promise<T>): Promise<T> {
  return (tx as Database).transaction((t) => fn(t));
}

/** Loads a contact (optionally locking the row). Throws when it does not exist (or the id is not an id). */
export async function getContact(id: string, tx: Tx = db, opts: { forUpdate?: boolean } = {}): Promise<Contact> {
  if (!isUuid(id)) throw new ContactNotFoundError();
  const q = tx.select().from(contacts).where(eq(contacts.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  if (!rows[0]) throw new ContactNotFoundError();
  return rows[0];
}

/** Loads a contact that must still be live (not merged away). */
export async function getLiveContact(id: string, tx: Tx = db, opts: { forUpdate?: boolean } = {}): Promise<Contact> {
  const c = await getContact(id, tx, opts);
  if (c.mergedIntoId) throw new ContactMergedError(c.mergedIntoId);
  return c;
}

/** Follows merged_into_id to the surviving contact. Never returns a merged row (null if the chain is broken). */
export async function resolveSurvivor(contact: Contact | null | undefined, tx: Tx = db): Promise<Contact | null> {
  let c = contact ?? null;
  const seen = new Set<string>();
  while (c && c.mergedIntoId) {
    if (seen.has(c.id) || seen.size > 20) return null;
    seen.add(c.id);
    const next = await tx.select().from(contacts).where(eq(contacts.id, c.mergedIntoId)).limit(1);
    c = next[0] ?? null;
  }
  return c;
}

/** Owners must be active and never support (rule 7). Returns the user. */
export async function assertAssignableOwner(userId: string, tx: Tx = db): Promise<User> {
  if (!isUuid(userId)) throw new ContactValidationError("That team member does not exist", "ownerId");
  const rows = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  const u = rows[0];
  if (!u) throw new ContactValidationError("That team member does not exist", "ownerId");
  if (!u.active) throw new ContactValidationError(`${u.name} is not active and cannot own contacts`, "ownerId");
  if (u.role === "support") throw new ContactValidationError("Support never owns contacts", "ownerId");
  return u;
}

export async function userName(userId: string | null | undefined, tx: Tx = db): Promise<string | null> {
  if (!userId || !isUuid(userId)) return null;
  const rows = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.name ?? null;
}

/**
 * True when making `referrerId` the referrer of `contactId` would create a loop
 * (the contact itself, or a contact somewhere up the referrer's own referral chain).
 */
export async function wouldCreateReferralCycle(contactId: string, referrerId: string, tx: Tx = db): Promise<boolean> {
  if (contactId === referrerId) return true;
  const rows = await tx.execute<{ found: boolean }>(sql`
    with recursive chain(id, referred_by_id, depth) as (
      select id, referred_by_id, 0 from contacts where id = ${referrerId}
      union all
      select c.id, c.referred_by_id, chain.depth + 1
      from contacts c join chain on c.id = chain.referred_by_id
      where chain.depth < 100
    )
    select exists(select 1 from chain where id = ${contactId}) as found
  `);
  return Boolean(rows[0]?.found);
}
