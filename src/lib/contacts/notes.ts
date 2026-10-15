import "server-only";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, interactions, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { can, canViewContact } from "@/lib/auth/permissions";
import { ContactForbiddenError, ContactNotFoundError, ContactValidationError } from "./errors";
import { getLiveContact, withTx, type Actor } from "./internal";
import { logInteraction } from "./interactions";
import { isUuid } from "./rules";

/**
 * Quick notes on the contact page (beyond the spec, docs/CRM_GAP_ANALYSIS.md). A note is an interaction of type
 * "note" logged through logInteraction (so the timeline, activity markers and recompute stay the same); one note per
 * contact can be pinned to the top of the contact page (interactions.pinned_at).
 */

export const NOTE_MAX = 4000;

export type PinnedNote = {
  id: string;
  summary: string;
  occurredAt: Date;
  pinnedAt: Date;
  authorName: string | null;
};

/** Adds a note (optionally pinned) and returns the interaction id. */
export async function addNote(
  contactId: string,
  text: string,
  actor: Actor,
  opts: { pin?: boolean } = {},
  tx: Tx = db,
): Promise<string> {
  const summary = (text ?? "").trim();
  if (!summary) throw new ContactValidationError("Write the note first", "note");
  if (summary.length > NOTE_MAX) throw new ContactValidationError(`Keep a note under ${NOTE_MAX} characters`, "note");
  return withTx(tx, async (t) => {
    const c = await getLiveContact(contactId, t);
    if (!canViewContact(actor, c)) throw new ContactNotFoundError();
    if (c.erasedAt) throw new ContactValidationError("This contact's data was erased", "note");
    const id = await logInteraction(c.id, { type: "note", summary, direction: "out" }, actor, t);
    if (opts.pin) await setPinned(id, true, actor, t);
    return id;
  });
}

/**
 * Pins a note to the top of its contact (unpinning any other) or unpins it. Anyone who can log on the contact may
 * pin. Only notes can be pinned. Audited.
 */
export async function setPinned(interactionId: string, pinned: boolean, actor: Actor, tx: Tx = db): Promise<void> {
  if (!can(actor, "interactions.log")) throw new ContactForbiddenError("You cannot change notes");
  if (!isUuid(interactionId)) throw new ContactNotFoundError("Note");
  await withTx(tx, async (t) => {
    const rows = await t
      .select({ id: interactions.id, contactId: interactions.contactId, type: interactions.type, pinnedAt: interactions.pinnedAt })
      .from(interactions)
      .where(eq(interactions.id, interactionId))
      .limit(1);
    const note = rows[0];
    if (!note) throw new ContactNotFoundError("Note");
    if (note.type !== "note") throw new ContactValidationError("Only notes can be pinned", "note");
    const c = await getLiveContact(note.contactId, t, { forUpdate: true });
    if (!canViewContact(actor, c)) throw new ContactNotFoundError();
    const now = new Date();
    if (pinned) {
      // one pinned note per contact
      const others = await t
        .update(interactions)
        .set({ pinnedAt: null })
        .where(and(eq(interactions.contactId, c.id), isNotNull(interactions.pinnedAt), ne(interactions.id, note.id)))
        .returning({ id: interactions.id });
      if (!note.pinnedAt) await t.update(interactions).set({ pinnedAt: now }).where(eq(interactions.id, note.id));
      await audit(
        [
          ...others.map((o) => ({ table: "interactions", rowId: o.id, field: "pinned_at", oldValue: "pinned", newValue: null, userId: actor.id })),
          ...(note.pinnedAt
            ? []
            : [{ table: "interactions", rowId: note.id, field: "pinned_at", oldValue: null, newValue: now.toISOString(), userId: actor.id }]),
        ],
        t,
      );
    } else {
      if (!note.pinnedAt) return;
      await t.update(interactions).set({ pinnedAt: null }).where(eq(interactions.id, note.id));
      await audit({ table: "interactions", rowId: note.id, field: "pinned_at", oldValue: note.pinnedAt.toISOString(), newValue: null, userId: actor.id }, t);
    }
  });
}

/** The pinned note of a contact (the latest pinned one if a merge brought two), or null. */
export async function getPinnedNote(contactId: string, tx: Tx = db): Promise<PinnedNote | null> {
  if (!isUuid(contactId)) return null;
  const rows = await tx
    .select({
      id: interactions.id,
      summary: interactions.summary,
      occurredAt: interactions.occurredAt,
      pinnedAt: interactions.pinnedAt,
      authorName: users.name,
    })
    .from(interactions)
    .leftJoin(users, eq(users.id, interactions.userId))
    .where(and(eq(interactions.contactId, contactId), isNotNull(interactions.pinnedAt), eq(interactions.type, "note")))
    .orderBy(desc(interactions.pinnedAt))
    .limit(1);
  const r = rows[0];
  if (!r || !r.pinnedAt) return null;
  return { id: r.id, summary: r.summary ?? "", occurredAt: r.occurredAt, pinnedAt: r.pinnedAt, authorName: r.authorName };
}

/** The latest few notes of a contact for the Notes card. */
export async function recentNotes(contactId: string, limit = 3, tx: Tx = db) {
  if (!isUuid(contactId)) return [];
  return tx
    .select({
      id: interactions.id,
      summary: interactions.summary,
      occurredAt: interactions.occurredAt,
      pinnedAt: interactions.pinnedAt,
      authorName: users.name,
    })
    .from(interactions)
    .leftJoin(users, eq(users.id, interactions.userId))
    .innerJoin(contacts, eq(contacts.id, interactions.contactId))
    .where(and(eq(interactions.contactId, contactId), eq(interactions.type, "note")))
    .orderBy(desc(interactions.occurredAt), desc(interactions.id))
    .limit(Math.min(limit, 20));
}
