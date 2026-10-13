import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { notifications, tasks, users, type TaskType } from "@/db/schema";

export type NewTask = {
  contactId?: string | null;
  /** null = the unassigned pool */
  userId: string | null;
  type: TaskType;
  /** the "why it is here" line shown on Today */
  reason: string;
  dueAt?: Date;
  priority?: number;
  /** if set, a second task with the same key is silently skipped */
  dedupeKey?: string | null;
  payload?: Record<string, unknown> | null;
  createdById?: string | null;
};

/** Creates a task (a Today row). Returns the new id, or null when the dedupe key already exists. */
export async function createTask(t: NewTask, tx: Tx = db): Promise<string | null> {
  const rows = await tx
    .insert(tasks)
    .values({
      contactId: t.contactId ?? null,
      userId: t.userId,
      type: t.type,
      reason: t.reason,
      dueAt: t.dueAt ?? new Date(),
      priority: t.priority ?? 0,
      dedupeKey: t.dedupeKey ?? null,
      payload: t.payload ?? null,
      createdById: t.createdById ?? null,
    })
    .onConflictDoNothing({ target: tasks.dedupeKey })
    .returning({ id: tasks.id });
  return rows[0]?.id ?? null;
}

/**
 * Creates many tasks in one statement per 500 rows; rows whose dedupe key already exists are skipped.
 * Returns the ids of the tasks actually created (in no particular order).
 */
export async function createTasks(list: NewTask[], tx: Tx = db): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const now = new Date();
    const rows = await tx
      .insert(tasks)
      .values(
        chunk.map((t) => ({
          contactId: t.contactId ?? null,
          userId: t.userId,
          type: t.type,
          reason: t.reason,
          dueAt: t.dueAt ?? now,
          priority: t.priority ?? 0,
          dedupeKey: t.dedupeKey ?? null,
          payload: t.payload ?? null,
          createdById: t.createdById ?? null,
        })),
      )
      .onConflictDoNothing({ target: tasks.dedupeKey })
      .returning({ id: tasks.id });
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

export type NewNotification = {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  contactId?: string | null;
  taskId?: string | null;
  /** also send by email */
  email?: boolean;
  dedupeKey?: string | null;
};

/** In-app alert (the bell). Dedupe keys are scoped per user automatically. */
export async function notify(n: NewNotification | NewNotification[], tx: Tx = db): Promise<number> {
  const list = Array.isArray(n) ? n : [n];
  if (!list.length) return 0;
  const rows = await tx
    .insert(notifications)
    .values(
      list.map((x) => ({
        userId: x.userId,
        type: x.type,
        title: x.title,
        body: x.body ?? null,
        contactId: x.contactId ?? null,
        taskId: x.taskId ?? null,
        email: x.email ?? false,
        dedupeKey: x.dedupeKey ? `${x.dedupeKey}:${x.userId}` : null,
      })),
    )
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });
  return rows.length;
}

/** Active managers (falls back to admins when no manager exists — the spec's default manager is Umer). */
export async function managerIds(tx: Tx = db): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.active, true), inArray(users.role, ["manager", "admin"])));
  const managers = rows.filter((r) => r.role === "manager").map((r) => r.id);
  return managers.length ? managers : rows.map((r) => r.id);
}

/** Active admins. */
export async function adminIds(tx: Tx = db): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.active, true), eq(users.role, "admin")));
  return rows.map((r) => r.id);
}

export async function completeTask(taskId: string, userId: string | null, status: "done" | "dismissed" = "done", tx: Tx = db) {
  await tx
    .update(tasks)
    .set({ status, completedAt: new Date(), completedById: userId })
    .where(eq(tasks.id, taskId));
}

/** Closes open tasks of the given types for a contact (e.g. follow-ups once someone pays). */
export async function closeContactTasks(contactId: string, types: TaskType[], userId: string | null, tx: Tx = db) {
  if (!types.length) return;
  await tx
    .update(tasks)
    .set({ status: "done", completedAt: new Date(), completedById: userId })
    .where(and(eq(tasks.contactId, contactId), eq(tasks.status, "open"), inArray(tasks.type, types)));
}
