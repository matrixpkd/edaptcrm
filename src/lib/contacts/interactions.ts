import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { INTERACTION_TYPES, contacts, interactions, tasks, type InteractionType, type TaskType } from "@/db/schema";
import { createTask } from "@/lib/alerts/core";
import { can, canViewContact } from "@/lib/auth/permissions";
import { recomputeContact } from "@/lib/metrics/recompute";
import { getSetting, labelFor } from "@/lib/settings";
import { ContactForbiddenError, ContactNotFoundError, ContactValidationError } from "./errors";
import { getContact, resolveSurvivor, userName, withTx, type Actor } from "./internal";
import { cleanText, followUpReason, isUuid, laterOf } from "./rules";

export { FOLLOW_UP_PRESETS, followUpPresets } from "./follow-up";

/**
 * Calls, chats, meetings, emails, notes and support issues (spec "Screens: Log interaction",
 * "Ownership and handover rules" rule 7). Logging never changes the owner: support logs on any contact,
 * sales on contacts they can see; a salesperson calling a pool contact does not become its owner
 * (only a manager reassigns; a salesperson's own Quick Add makes them owner, see capture).
 */

export type LogInteractionInput = {
  type: InteractionType;
  /** key from lists.outcomes */
  outcome?: string | null;
  summary?: string | null;
  direction?: "in" | "out";
  nextFollowUpAt?: Date | null;
  occurredAt?: Date;
  /** idempotency key for interactions created by webhooks */
  externalRef?: string | null;
};

/** Open Today rows that a logged touch answers. */
const ANSWERED_TASK_TYPES: TaskType[] = ["follow_up", "new_lead", "untouched_lead"];

/**
 * Logs one interaction and returns its id (the existing id when externalRef was seen before: nothing changes).
 * - actor null = the system (e.g. an inbound WhatsApp reply from a webhook).
 * - Updates last_interaction_at / last_activity_at (never backwards).
 * - Completes the actor's open follow-up / new lead / untouched lead tasks for this contact (a note leaves
 *   follow-ups open: writing down "call back Friday" is not the call).
 * - nextFollowUpAt creates a "follow_up" task for the owner (the actor when they own it, or when the contact is
 *   in the pool and the actor is a salesperson; otherwise the pool), due then, with the reason shown on Today.
 * - Recomputes the contact.
 */
export async function logInteraction(
  contactId: string,
  input: LogInteractionInput,
  actor: Actor | null,
  tx: Tx = db,
): Promise<string> {
  if (!INTERACTION_TYPES.includes(input.type)) throw new ContactValidationError("Choose an interaction type", "type");
  const direction = input.direction ?? "out";
  if (direction !== "in" && direction !== "out") throw new ContactValidationError("Direction must be in or out", "direction");
  if (actor && !can(actor, "interactions.log")) throw new ContactForbiddenError("You cannot log interactions");
  const outcome = cleanText(input.outcome);
  const outcomes = outcome ? await getSetting("lists.outcomes", tx) : [];
  if (outcome && !outcomes.some((o) => o.key === outcome)) {
    throw new ContactValidationError("Choose an outcome from the list", "outcome");
  }
  const externalRef = cleanText(input.externalRef);
  const occurredAt = input.occurredAt ?? new Date();
  if (input.nextFollowUpAt && Number.isNaN(input.nextFollowUpAt.getTime())) {
    throw new ContactValidationError("Choose a valid follow-up date", "nextFollowUpAt");
  }

  return withTx(tx, async (t) => {
    if (externalRef) {
      const seen = await t
        .select({ id: interactions.id })
        .from(interactions)
        .where(eq(interactions.externalRef, externalRef))
        .limit(1);
      if (seen[0]) return seen[0].id;
    }
    // a webhook may still hold a merged contact's id: log on the surviving record
    const rows = isUuid(contactId) ? await t.select().from(contacts).where(eq(contacts.id, contactId)).limit(1) : [];
    const found = await resolveSurvivor(rows[0], t);
    if (!found) throw new ContactNotFoundError();
    const c = await getContact(found.id, t, { forUpdate: true });
    if (actor && actor.role === "sales" && !canViewContact(actor, c)) {
      throw new ContactForbiddenError("You can only log on your own contacts and the pool");
    }

    const summary = input.summary?.trim() || null;
    const inserted = await t
      .insert(interactions)
      .values({
        contactId: c.id,
        userId: actor?.id ?? null,
        type: input.type,
        direction,
        outcome,
        summary,
        nextFollowUpAt: input.nextFollowUpAt ?? null,
        occurredAt,
        externalRef,
      })
      .onConflictDoNothing({ target: interactions.externalRef })
      .returning({ id: interactions.id });
    if (!inserted[0]) {
      // the same external event logged by a parallel request a moment ago
      const again = await t
        .select({ id: interactions.id })
        .from(interactions)
        .where(eq(interactions.externalRef, externalRef!))
        .limit(1);
      if (again[0]) return again[0].id;
      throw new Error("Could not log the interaction");
    }
    const interactionId = inserted[0].id;

    const lastInteractionAt = laterOf(c.lastInteractionAt, occurredAt);
    const lastActivityAt = laterOf(c.lastActivityAt, occurredAt);
    if (lastInteractionAt !== c.lastInteractionAt || lastActivityAt !== c.lastActivityAt) {
      await t
        .update(contacts)
        .set({ lastInteractionAt, lastActivityAt, updatedAt: new Date() })
        .where(eq(contacts.id, c.id));
    }

    // what this touch answers on the actor's Today list (done before a new follow-up is raised). A note is not a
    // touch with the person, so it never answers a follow-up ("call back on Friday" stays on Today).
    const answered = input.type === "note" ? ANSWERED_TASK_TYPES.filter((x) => x !== "follow_up") : ANSWERED_TASK_TYPES;
    if (actor) {
      await t
        .update(tasks)
        .set({ status: "done", completedAt: new Date(), completedById: actor.id })
        .where(
          and(
            eq(tasks.contactId, c.id),
            eq(tasks.userId, actor.id),
            eq(tasks.status, "open"),
            inArray(tasks.type, answered),
          ),
        );
    }

    if (input.nextFollowUpAt) {
      // A support person follows up their own support issue (Today is a support screen too, spec "Screens"); the
      // task is theirs, the contact's owner never changes (rule 7). Any other follow-up goes to the owner.
      const supportOwnsIt = actor?.role === "support" && input.type === "support_issue";
      const assignee = supportOwnsIt ? actor.id : (c.ownerId ?? (actor?.role === "sales" ? actor.id : null));
      const setByName = actor && actor.id !== assignee ? await userName(actor.id, t) : null;
      await createTask(
        {
          contactId: c.id,
          userId: assignee,
          type: "follow_up",
          reason: followUpReason({
            type: input.type,
            summary,
            outcomeLabel: outcome ? labelFor(outcomes, outcome) : null,
            setByName: actor ? setByName : "the system",
          }),
          dueAt: input.nextFollowUpAt,
          dedupeKey: `follow_up:${interactionId}`,
          payload: { interactionId },
          createdById: actor?.id ?? null,
        },
        t,
      );
    }

    await recomputeContact(c.id, t);
    return interactionId;
  });
}
