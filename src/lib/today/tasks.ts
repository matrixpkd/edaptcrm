import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, type Database, type Tx } from "@/db";
import { contacts, tasks } from "@/db/schema";
import { localTimeInDays } from "@/lib/contacts/follow-up";
import { isUuid } from "@/lib/utils";
import { canActOnTask, dismissible, SNOOZE_OPTIONS, type SnoozeKey } from "./rules";
import { validTimeZone } from "./time";

/**
 * Done / Snooze / Dismiss on Today rows. A row can hold several tasks for one contact; the action applies to
 * all of them. Permission (canActOnTask): the task's assignee, a manager or admin, or a salesperson for a
 * pool task on a contact they can see. Tasks that are no longer open are skipped (a double tap is harmless).
 */

export type QueueAction = "done" | "dismiss" | "snooze";

export class TodayError extends Error {
  readonly code: "forbidden" | "invalid" | "not_found";
  constructor(code: TodayError["code"], message: string) {
    super(message);
    this.name = "TodayError";
    this.code = code;
  }
}

export type QueueActor = { id: string; role: "admin" | "manager" | "sales" | "support"; timezone?: string | null };

/** Returns the number of tasks changed. Snoozed tasks are due again at 10:00 local time on the chosen day. */
export async function actOnTasks(
  taskIds: string[],
  action: QueueAction,
  actor: QueueActor,
  opts: { snooze?: SnoozeKey; now?: Date } = {},
  tx: Tx = db,
): Promise<number> {
  const ids = [...new Set(taskIds)];
  if (!ids.length || ids.some((id) => !isUuid(id))) throw new TodayError("not_found", "That task no longer exists");
  if (ids.length > 50) throw new TodayError("invalid", "Too many tasks at once");
  if (action !== "done" && action !== "dismiss" && action !== "snooze") {
    throw new TodayError("invalid", "Unknown action");
  }
  const now = opts.now ?? new Date();

  return (tx as Database).transaction(async (t) => {
    const rows = await t
      .select({ id: tasks.id, type: tasks.type, status: tasks.status, userId: tasks.userId, ownerId: contacts.ownerId, contactId: tasks.contactId })
      .from(tasks)
      .leftJoin(contacts, eq(contacts.id, tasks.contactId))
      .where(inArray(tasks.id, ids))
      .for("update", { of: tasks });
    if (rows.length !== ids.length) throw new TodayError("not_found", "That task no longer exists");
    for (const r of rows) {
      const contact = r.contactId ? { ownerId: r.ownerId } : null;
      if (!canActOnTask(actor, r, contact)) throw new TodayError("forbidden", "This task belongs to someone else");
    }
    const open = rows.filter((r) => r.status === "open");
    if (!open.length) return 0;
    if (action !== "snooze" && open.some((r) => r.type === "transfer_request")) {
      throw new TodayError("invalid", "Approve or decline the transfer request");
    }
    if (action === "dismiss" && open.some((r) => !dismissible(r.type))) {
      throw new TodayError("invalid", "Follow-ups can be done or snoozed, not dismissed");
    }
    const openIds = open.map((r) => r.id);

    if (action === "snooze") {
      const opt = SNOOZE_OPTIONS.find((o) => o.key === (opts.snooze ?? "tomorrow"));
      if (!opt) throw new TodayError("invalid", "Choose when to snooze until");
      const dueAt = localTimeInDays(now, validTimeZone(actor.timezone), opt.days);
      await t
        .update(tasks)
        .set({ dueAt })
        .where(and(inArray(tasks.id, openIds), eq(tasks.status, "open")));
      return openIds.length;
    }
    await t
      .update(tasks)
      .set({ status: action === "done" ? "done" : "dismissed", completedAt: now, completedById: actor.id })
      .where(and(inArray(tasks.id, openIds), eq(tasks.status, "open")));
    return openIds.length;
  });
}
