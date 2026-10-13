import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, ownershipLog, tasks, users, type TaskType } from "@/db/schema";
import { managerIds, notify } from "@/lib/alerts/core";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { getSetting } from "@/lib/settings";
import { DAY_MS } from "@/lib/utils";
import { ContactForbiddenError, ContactNotFoundError, ContactValidationError } from "./errors";
import { assertAssignableOwner, getContact, getLiveContact, userName, withTx, type Actor } from "./internal";
import { isUuid, teamForCountry } from "./rules";

export { teamForCountry } from "./rules";

/**
 * Ownership and handover rules (spec "Ownership and handover rules"):
 * 1. New leads are auto-assigned: GCC numbers to the Dubai team, others to Kerala, round robin among active sales.
 * 2. Returning contacts stay with their current owner.
 * 3. The first owner never changes.
 * 4. An open lead with no logged interaction for N days returns to the pool and alerts the manager.
 * 5. Only a manager or admin reassigns; salespeople request a transfer.
 * 7. Support never owns.
 * 8. When someone leaves, all their contacts move in one action.
 * setOwner() is the ONLY function that writes contacts.owner_id.
 */

/** Task types raised for managers about a contact; they stay with the manager when the contact changes hands. */
const MANAGER_TASK_TYPES: TaskType[] = ["lead_released", "transfer_request", "duplicate_review"];

// ---------------------------------------------------------------------------
// Auto-assignment
// ---------------------------------------------------------------------------

/**
 * Round robin: the active salesperson in the lead's team who was assigned least recently (never-assigned first)
 * gets the next lead. The chosen row is locked (FOR UPDATE SKIP LOCKED, so parallel captures pick different
 * people) and stamped with clock_timestamp() so several assignments inside one transaction still rotate.
 * Returns null — the unassigned pool — when auto-assign is off or the team has no active salesperson.
 */
export async function pickAutoOwner(phoneCountry: string | null, tx: Tx = db): Promise<string | null> {
  const cfg = await getSetting("assignment", tx);
  if (!cfg.autoAssign) return null;
  const team = teamForCountry(phoneCountry, cfg);
  // the lock and the stamp must be one unit of work: called on the root handle, a bare SELECT ... FOR UPDATE
  // releases its lock at once and parallel callers all pick the same person
  return withTx(tx, async (t) => {
    const candidates = () =>
      t
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.active, true), eq(users.role, "sales"), eq(users.team, team)))
        .orderBy(sql`${users.lastAssignedAt} asc nulls first`, asc(users.createdAt), asc(users.id))
        .limit(1);
    let rows = await candidates().for("update", { skipLocked: true });
    // everyone is locked by parallel assignments: wait for the next in line rather than dropping to the pool
    if (!rows[0]) rows = await candidates().for("update");
    const id = rows[0]?.id;
    if (!id) return null;
    await t
      .update(users)
      .set({ lastAssignedAt: sql`clock_timestamp()` })
      .where(eq(users.id, id));
    return id;
  });
}

// ---------------------------------------------------------------------------
// The one writer of contacts.owner_id
// ---------------------------------------------------------------------------

export type SetOwnerResult = {
  changed: boolean;
  fromUserId: string | null;
  toUserId: string | null;
};

/**
 * Changes a contact's owner (null = the pool). No-op when unchanged. Rejects support and inactive users.
 * Stamps owner_assigned_at, sets first_owner_id only when it is still empty, writes ownership_log and audit.
 * By default the previous owner's open tasks for this contact follow the contact (manager tasks stay put).
 */
export async function setOwner(
  contactId: string,
  toUserId: string | null,
  opts: {
    reason: string;
    changedById: string | null;
    moveTasks?: boolean;
    now?: Date;
  },
  tx: Tx = db,
): Promise<SetOwnerResult> {
  const reason = opts.reason?.trim();
  if (!reason) throw new ContactValidationError("Give a reason for the owner change", "reason");
  return withTx(tx, async (t) => {
    const c = await getLiveContact(contactId, t, { forUpdate: true });
    const fromUserId = c.ownerId;
    if (fromUserId === toUserId) return { changed: false, fromUserId, toUserId };
    if (toUserId) await assertAssignableOwner(toUserId, t);
    const now = opts.now ?? new Date();
    await t
      .update(contacts)
      .set({
        ownerId: toUserId,
        ownerAssignedAt: toUserId ? now : null,
        firstOwnerId: c.firstOwnerId ?? toUserId,
        updatedAt: now,
      })
      .where(eq(contacts.id, contactId));
    await t.insert(ownershipLog).values({
      contactId,
      fromUserId,
      toUserId,
      reason,
      changedById: opts.changedById,
      changedAt: now,
    });
    const entries = [
      {
        table: "contacts",
        rowId: contactId,
        action: "reassign",
        field: "owner_id",
        oldValue: fromUserId,
        newValue: toUserId,
        userId: opts.changedById,
      },
    ];
    if (!c.firstOwnerId && toUserId) {
      entries.push({
        table: "contacts",
        rowId: contactId,
        action: "reassign",
        field: "first_owner_id",
        oldValue: null,
        newValue: toUserId,
        userId: opts.changedById,
      });
    }
    await audit(entries, t);
    if (opts.moveTasks !== false) {
      await t
        .update(tasks)
        .set({ userId: toUserId })
        .where(
          and(
            eq(tasks.contactId, contactId),
            eq(tasks.status, "open"),
            fromUserId ? eq(tasks.userId, fromUserId) : isNull(tasks.userId),
            notInArray(tasks.type, MANAGER_TASK_TYPES),
          ),
        );
    }
    return { changed: true, fromUserId, toUserId };
  });
}

// ---------------------------------------------------------------------------
// Manager actions
// ---------------------------------------------------------------------------

function assertCanReassign(actor: Actor) {
  if (!can(actor, "contacts.reassign"))
    throw new ContactForbiddenError("Only a manager or admin can reassign contacts");
}

/**
 * Manager/admin: moves the given contacts to `toUserId` (null = back to the pool), with a reason.
 * Returns how many contacts actually changed owner. The new owner gets one in-app notification.
 */
export async function reassignContacts(
  contactIds: string[],
  toUserId: string | null,
  actor: Actor,
  reason: string,
  tx: Tx = db,
): Promise<number> {
  assertCanReassign(actor);
  if (!reason?.trim()) throw new ContactValidationError("Give a reason for the reassignment", "reason");
  const ids = [...new Set(contactIds)];
  if (!ids.length) return 0;
  return withTx(tx, async (t) => {
    if (toUserId) await assertAssignableOwner(toUserId, t);
    let changed = 0;
    for (const id of ids) {
      const r = await setOwner(id, toUserId, { reason: reason.trim(), changedById: actor.id }, t);
      if (r.changed) changed += 1;
    }
    if (changed && toUserId && toUserId !== actor.id) {
      await notify(
        {
          userId: toUserId,
          type: "contacts_assigned",
          title: changed === 1 ? "A contact was assigned to you" : `${changed} contacts were assigned to you`,
          body: reason.trim(),
          contactId: ids.length === 1 ? ids[0] : null,
        },
        t,
      );
    }
    return changed;
  });
}

/**
 * "When someone leaves": every live contact owned by `fromUserId` moves to `toUserId` in one action
 * (reason "Owner left the team"), and all of their open tasks move too. Manager/admin only.
 * Returns the number of contacts moved.
 */
export async function handoverAllContacts(
  fromUserId: string,
  toUserId: string,
  actor: Actor,
  tx: Tx = db,
): Promise<number> {
  assertCanReassign(actor);
  if (fromUserId === toUserId)
    throw new ContactValidationError("Choose a different person to hand over to", "toUserId");
  if (!isUuid(fromUserId)) throw new ContactValidationError("That team member does not exist", "fromUserId");
  return withTx(tx, async (t) => {
    await assertAssignableOwner(toUserId, t);
    // Set-based, so a leaver with thousands of contacts moves in a handful of statements (a per-contact loop
    // took ~5 ms per contact locally and far longer against a remote database). Same effect as setOwner() per
    // contact: owner_assigned_at stamped, first_owner_id kept (filled only when empty), one ownership_log row
    // with the reason and one audit row per contact (plus first_owner_id when it was filled).
    const now = new Date().toISOString();
    const reason = "Owner left the team";
    const rows = await t.execute<{ n: number }>(sql`
      with target as (
        select id, first_owner_id is null as first_set
        from contacts
        where owner_id = ${fromUserId}::uuid and merged_into_id is null
        order by id
        for update
      ), upd as (
        update contacts c
        set owner_id = ${toUserId}::uuid,
            owner_assigned_at = ${now}::timestamptz,
            first_owner_id = coalesce(c.first_owner_id, ${toUserId}::uuid),
            updated_at = ${now}::timestamptz
        from target
        where c.id = target.id
        returning c.id, target.first_set
      ), log as (
        insert into ownership_log (contact_id, from_user_id, to_user_id, reason, changed_by_id, changed_at)
        select id, ${fromUserId}::uuid, ${toUserId}::uuid, ${reason}, ${actor.id}::uuid, ${now}::timestamptz from upd
      ), aud as (
        insert into audit_log (table_name, row_id, action, field, old_value, new_value, user_id, changed_at)
        select 'contacts', id::text, 'reassign', 'owner_id', to_jsonb(${fromUserId}::text), to_jsonb(${toUserId}::text), ${actor.id}::uuid, ${now}::timestamptz
        from upd
        union all
        select 'contacts', id::text, 'reassign', 'first_owner_id', null, to_jsonb(${toUserId}::text), ${actor.id}::uuid, ${now}::timestamptz
        from upd where first_set
      )
      select count(*)::int as n from upd
    `);
    const moved = Number(rows[0]?.n ?? 0);
    // every open task of theirs (their contacts' follow-ups, pool follow-ups, manager tasks, ...) goes to the new person
    await t
      .update(tasks)
      .set({ userId: toUserId })
      .where(and(eq(tasks.userId, fromUserId), eq(tasks.status, "open")));
    await audit(
      {
        table: "users",
        rowId: fromUserId,
        action: "reassign",
        field: "handover",
        oldValue: fromUserId,
        newValue: { toUserId, contacts: moved },
        userId: actor.id,
      },
      t,
    );
    if (moved) {
      await notify(
        {
          userId: toUserId,
          type: "contacts_assigned",
          title: moved === 1 ? "1 contact was handed over to you" : `${moved} contacts were handed over to you`,
          body: `From ${(await userName(fromUserId, t)) ?? "a former team member"}`,
        },
        t,
      );
    }
    return moved;
  });
}

// ---------------------------------------------------------------------------
// Rule 4: use it or lose it
// ---------------------------------------------------------------------------

/**
 * Returns open leads to the pool when their owner has logged no interaction for `thresholds.leadReleaseDays`
 * days since the lead was assigned (an interaction older than that window does not keep it). Customers —
 * anyone with a purchase — and Lost contacts never expire. Each release raises one "lead_released" task and
 * an in-app alert for every manager. Returns the released contact ids. Safe to run repeatedly (cron).
 */
export async function releaseStaleLeads(now: Date, tx: Tx = db, opts: { limit?: number } = {}): Promise<string[]> {
  // opts.limit caps one run (the 15-minute cron), so a big backlog (e.g. after an import assigned thousands of
  // old leads) is released over several runs instead of one transaction that outlives the function's time limit.
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : null;
  const { leadReleaseDays } = await getSetting("thresholds", tx);
  const days = Number(leadReleaseDays);
  if (!Number.isFinite(days) || days <= 0) return [];
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  return withTx(tx, async (t) => {
    const assignedAt = sql`coalesce(${contacts.ownerAssignedAt}, ${contacts.createdAt})`;
    const stale = await t
      .select({
        id: contacts.id,
        name: contacts.name,
        ownerId: contacts.ownerId,
        ownerAssignedAt: contacts.ownerAssignedAt,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .where(
        and(
          isNull(contacts.mergedIntoId),
          isNotNull(contacts.ownerId),
          eq(contacts.purchaseCount, 0),
          // Lost and Dormant contacts are not open leads (old imported leads turn Dormant on recompute)
          notInArray(contacts.stage, ["lost", "dormant"]),
          sql`${assignedAt} <= ${cutoff}::timestamptz`,
          sql`not exists (select 1 from purchases p where p.contact_id = ${contacts.id} and p.status <> 'cancelled')`,
          sql`not exists (
            select 1 from interactions i
            where i.contact_id = ${contacts.id}
              and i.user_id = ${contacts.ownerId}
              and i.occurred_at >= ${assignedAt}
              and i.occurred_at > ${cutoff}::timestamptz
          )`,
        ),
      )
      .orderBy(contacts.id)
      .limit(limit ?? Number.MAX_SAFE_INTEGER)
      .for("update", { skipLocked: true });
    if (!stale.length) return [];

    const managers = await managerIds(t);
    const reason = `No interaction for ${days} days`;
    const released: string[] = [];
    for (const c of stale) {
      const r = await setOwner(c.id, null, { reason, changedById: null, now }, t);
      if (!r.changed) continue;
      released.push(c.id);
      const stamp = (c.ownerAssignedAt ?? c.createdAt).toISOString();
      const ownerName = (await userName(c.ownerId, t)) ?? "its owner";
      const why = `Back in the pool: ${ownerName} logged no interaction for ${days} days`;
      for (const m of managers) {
        const taskId = await createReleasedTask(t, {
          contactId: c.id,
          managerId: m,
          why,
          stamp,
          fromUserId: c.ownerId,
          now,
        });
        await notify(
          {
            userId: m,
            type: "lead_released",
            title: `${c.name} returned to the pool`,
            body: why,
            contactId: c.id,
            taskId,
            dedupeKey: `lead_released:${c.id}:${stamp}`,
          },
          t,
        );
      }
    }
    return released;
  });
}

async function createReleasedTask(
  t: Tx,
  x: {
    contactId: string;
    managerId: string;
    why: string;
    stamp: string;
    fromUserId: string | null;
    now: Date;
  },
): Promise<string | null> {
  const rows = await t
    .insert(tasks)
    .values({
      contactId: x.contactId,
      userId: x.managerId,
      type: "lead_released",
      reason: x.why,
      dueAt: x.now,
      dedupeKey: `lead_released:${x.contactId}:${x.stamp}:${x.managerId}`,
      payload: {
        contactId: x.contactId,
        fromUserId: x.fromUserId,
        assignedAt: x.stamp,
      },
    })
    .onConflictDoNothing({ target: tasks.dedupeKey })
    .returning({ id: tasks.id });
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Rule 5: salespeople request, managers decide
// ---------------------------------------------------------------------------

export type TransferRequestResult = { created: boolean; taskIds: string[] };

/**
 * A salesperson asks for a contact (default: for themselves; or to hand one of theirs to `toUserId`).
 * Creates one "transfer_request" task and an in-app alert per manager. While a request for the same
 * contact, requester and target is still open, asking again creates nothing.
 */
export async function requestTransfer(
  contactId: string,
  requester: Actor,
  reason: string,
  toUserId?: string | null,
  tx: Tx = db,
): Promise<TransferRequestResult> {
  if (!can(requester, "contacts.requestTransfer")) {
    throw new ContactForbiddenError(
      can(requester, "contacts.reassign") ? "Managers reassign directly" : "You cannot request transfers",
    );
  }
  const why = reason?.trim();
  if (!why) throw new ContactValidationError("Say why you need this contact", "reason");
  const target = toUserId ?? requester.id;
  return withTx(tx, async (t) => {
    const c = await getLiveContact(contactId, t, { forUpdate: true }); // serialises requests for one contact
    if (c.ownerId === target) throw new ContactValidationError("This contact already belongs to that person");
    if (toUserId && toUserId !== requester.id && c.ownerId !== requester.id) {
      throw new ContactForbiddenError("You can only hand over contacts you own");
    }
    await assertAssignableOwner(target, t);

    const open = await t
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.contactId, contactId),
          eq(tasks.type, "transfer_request"),
          eq(tasks.status, "open"),
          sql`${tasks.payload}->>'requestedBy' = ${requester.id}`,
          sql`${tasks.payload}->>'toUserId' = ${target}`,
        ),
      );
    if (open.length) return { created: false, taskIds: open.map((r) => r.id) };

    const requesterName = (await userName(requester.id, t)) ?? "A salesperson";
    const targetName = target === requester.id ? null : await userName(target, t);
    const ownerName = await userName(c.ownerId, t);
    const ask = targetName
      ? `${requesterName} asks to hand ${c.name} to ${targetName}`
      : `${requesterName} asks for ${c.name}${ownerName ? ` (owned by ${ownerName})` : " (in the pool)"}`;
    const stamp = new Date().toISOString();
    const taskIds: string[] = [];
    for (const m of await managerIds(t)) {
      const rows = await t
        .insert(tasks)
        .values({
          contactId,
          userId: m,
          type: "transfer_request",
          reason: `${ask}: ${why}`,
          dedupeKey: `transfer_request:${contactId}:${requester.id}:${target}:${stamp}:${m}`,
          payload: {
            contactId,
            requestedBy: requester.id,
            toUserId: target,
            fromUserId: c.ownerId,
            reason: why,
          },
          createdById: requester.id,
        })
        .onConflictDoNothing({ target: tasks.dedupeKey })
        .returning({ id: tasks.id });
      const taskId = rows[0]?.id ?? null;
      if (taskId) taskIds.push(taskId);
      await notify(
        {
          userId: m,
          type: "transfer_request",
          title: "Transfer request",
          body: `${ask}: ${why}`,
          contactId,
          taskId,
        },
        t,
      );
    }
    await audit(
      {
        table: "contacts",
        rowId: contactId,
        action: "transfer_request",
        newValue: { requestedBy: requester.id, toUserId: target, reason: why },
        userId: requester.id,
      },
      t,
    );
    return { created: true, taskIds };
  });
}

/**
 * Manager/admin answers a transfer request. Approving moves the contact (through setOwner) to the requested
 * person; either way every manager's copy of the request is closed and the requester is told.
 */
export async function resolveTransferRequest(
  taskId: string,
  decision: "approve" | "decline",
  actor: Actor,
  tx: Tx = db,
): Promise<{ moved: boolean }> {
  assertCanReassign(actor);
  if (!isUuid(taskId)) throw new ContactNotFoundError("Transfer request");
  return withTx(tx, async (t) => {
    const rows = await t.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const task = rows[0];
    if (!task || task.type !== "transfer_request" || !task.contactId)
      throw new ContactNotFoundError("Transfer request");
    if (task.status !== "open") throw new ContactValidationError("This request was already answered");
    const p = (task.payload ?? {}) as {
      requestedBy?: string;
      toUserId?: string;
      reason?: string;
    };
    const contact = await getContact(task.contactId, t);
    let moved = false;
    if (decision === "approve") {
      if (!p.toUserId) throw new ContactValidationError("The request has no target person");
      const r = await setOwner(
        contact.id,
        p.toUserId,
        {
          reason: `Transfer approved${p.reason ? `: ${p.reason}` : ""}`,
          changedById: actor.id,
        },
        t,
      );
      moved = r.changed;
    }
    const now = new Date();
    await t
      .update(tasks)
      .set({
        status: decision === "approve" ? "done" : "dismissed",
        completedAt: now,
        completedById: actor.id,
      })
      .where(
        and(
          eq(tasks.contactId, contact.id),
          eq(tasks.type, "transfer_request"),
          eq(tasks.status, "open"),
          sql`${tasks.payload}->>'requestedBy' = ${p.requestedBy ?? ""}`,
          sql`${tasks.payload}->>'toUserId' = ${p.toUserId ?? ""}`,
        ),
      );
    if (p.requestedBy && p.requestedBy !== actor.id) {
      await notify(
        {
          userId: p.requestedBy,
          type: "transfer_request",
          title: decision === "approve" ? `Transfer approved: ${contact.name}` : `Transfer declined: ${contact.name}`,
          contactId: contact.id,
        },
        t,
      );
    }
    return { moved };
  });
}

/** Ownership history of a contact, newest first, with names. */
export async function ownershipHistory(contactId: string, tx: Tx = db) {
  const rows = await tx
    .select()
    .from(ownershipLog)
    .where(eq(ownershipLog.contactId, contactId))
    .orderBy(sql`${ownershipLog.changedAt} desc`);
  const ids = [
    ...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId, r.changedById]).filter((x): x is string => !!x)),
  ];
  const names = new Map<string, string>();
  if (ids.length) {
    for (const u of await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))) {
      names.set(u.id, u.name);
    }
  }
  return rows.map((r) => ({
    ...r,
    fromName: r.fromUserId ? (names.get(r.fromUserId) ?? null) : null,
    toName: r.toUserId ? (names.get(r.toUserId) ?? null) : null,
    changedByName: r.changedById ? (names.get(r.changedById) ?? null) : null,
  }));
}
