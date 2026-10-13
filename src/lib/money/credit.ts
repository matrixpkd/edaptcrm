import "server-only";
/**
 * Sales credit (ownership rule 6): a purchase is credited to the contact's owner if that owner logged an
 * interaction in the N days before it (Settings > thresholds.salesCreditDays, default 30); otherwise it is
 * self-serve. A manager or admin can adjust credit. Drives "assisted vs self-serve revenue".
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, interactions, purchases, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import { DAY_MS, isUuid } from "@/lib/utils";
import { NotFoundError, ValidationError } from "./errors";
import { assertActorCan, inTx, lockPurchase, recomputeWithReferrer } from "./internal";
import type { Actor } from "./rules";

export type SalesCredit = {
  /** null = self-serve */
  creditedUserId: string | null;
  assisted: boolean;
  /** the owner's latest interaction inside the window, when credited */
  interactionId?: string | null;
};

/**
 * Who gets credit for a purchase made at `purchasedAt`: the contact's CURRENT owner, if they logged an interaction
 * (interactions.user_id = owner) within thresholds.salesCreditDays days before the purchase (inclusive).
 * Interactions by anyone else (support, a previous owner, the system) do not count. Otherwise self-serve.
 */
export async function computeSalesCredit(contactId: string, purchasedAt: Date, tx: Tx = db): Promise<SalesCredit> {
  const [c] = await tx.select({ ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!c?.ownerId) return { creditedUserId: null, assisted: false, interactionId: null };
  const { salesCreditDays } = await getSetting("thresholds", tx);
  const from = new Date(purchasedAt.getTime() - salesCreditDays * DAY_MS);
  const [hit] = await tx
    .select({ id: interactions.id })
    .from(interactions)
    .where(
      and(
        eq(interactions.contactId, contactId),
        eq(interactions.userId, c.ownerId),
        gte(interactions.occurredAt, from),
        lte(interactions.occurredAt, purchasedAt),
      ),
    )
    .orderBy(desc(interactions.occurredAt))
    .limit(1);
  if (!hit) return { creditedUserId: null, assisted: false, interactionId: null };
  return { creditedUserId: c.ownerId, assisted: true, interactionId: hit.id };
}

/** Credit can go to admins, managers and salespeople. Support never sells. */
export async function assertCreditableUser(userId: string, tx: Tx): Promise<void> {
  const [u] = isUuid(userId)
    ? await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)).limit(1)
    : [];
  if (!u) throw new NotFoundError("User");
  if (u.role === "support") throw new ValidationError("Sales credit can't go to a support team member.", "creditedUserId");
}

/**
 * Manager/admin override of a purchase's sales credit. `userId` null marks it self-serve.
 * Sets credited_user_id, assisted (= userId != null) and credit_adjusted_by_id; audited.
 */
export async function adjustCredit(purchaseId: string, userId: string | null, actor: Actor, tx: Tx = db): Promise<void> {
  assertActorCan(actor, "credit.adjust", "Only a manager can change sales credit.");
  await inTx(tx, async (t) => {
    const p = await lockPurchase(purchaseId, t);
    if (userId) await assertCreditableUser(userId, t);
    const next = { creditedUserId: userId, assisted: userId !== null, creditAdjustedById: actor.id };
    await t
      .update(purchases)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(purchases.id, purchaseId));
    await audit(
      [
        { table: "purchases", rowId: purchaseId, action: "update", field: "creditedUserId", oldValue: p.creditedUserId, newValue: userId, userId: actor.id },
        { table: "purchases", rowId: purchaseId, action: "update", field: "assisted", oldValue: p.assisted, newValue: next.assisted, userId: actor.id },
      ],
      t,
    );
    await recomputeWithReferrer(p.contactId, t);
  });
}
