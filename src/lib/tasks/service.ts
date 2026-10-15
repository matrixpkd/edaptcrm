import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Database, type Tx } from "@/db";
import { contacts, tasks, users, type Role, type TaskStatus, type TaskType } from "@/db/schema";
import { notify } from "@/lib/alerts/core";
import { can, canViewContact } from "@/lib/auth/permissions";
import { isUuid } from "@/lib/utils";
import {
  LISTED_TASK_TYPES,
  TaskError,
  canAssignToOthers,
  canChangeTask,
  canSeeTeamTasks,
  cleanNotes,
  cleanTitle,
  type TaskView,
} from "./rules";

/**
 * Tasks and reminders (beyond the spec; rules in ./rules.ts). A manual task is a `tasks` row of type "task": the
 * title is the row's `reason` (the "why it is here" line Today shows), notes live in `payload.notes`. Due tasks reach
 * Today through the normal queue (src/lib/today/queue.ts); overdue ones sit with overdue follow-ups.
 *
 * Follow-ups (type "follow_up", set when a touch is logged) are listed here too and can be rescheduled, completed
 * and reopened; their text comes from the logged touch and is not edited here.
 */

export type TaskActor = { id: string; role: Role; name?: string | null };

export type TaskInput = {
  title: string;
  notes?: string | null;
  dueAt: Date;
  /** default: the actor */
  assigneeId?: string | null;
  contactId?: string | null;
};

type ContactRef = { id: string; name: string; ownerId: string | null; mergedIntoId: string | null; erasedAt: Date | null };

async function loadContact(contactId: string, tx: Tx): Promise<ContactRef> {
  if (!isUuid(contactId)) throw new TaskError("not_found", "That contact no longer exists", "contactId");
  const rows = await tx
    .select({ id: contacts.id, name: contacts.name, ownerId: contacts.ownerId, mergedIntoId: contacts.mergedIntoId, erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  const c = rows[0];
  if (!c || c.mergedIntoId) throw new TaskError("not_found", "That contact no longer exists", "contactId");
  if (c.erasedAt) throw new TaskError("invalid", "This contact's data was erased", "contactId");
  return c;
}

async function loadAssignee(userId: string, tx: Tx) {
  if (!isUuid(userId)) throw new TaskError("invalid", "Choose who the task is for", "assigneeId");
  const rows = await tx
    .select({ id: users.id, name: users.name, role: users.role, active: users.active })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const u = rows[0];
  if (!u) throw new TaskError("invalid", "Choose who the task is for", "assigneeId");
  if (!u.active) throw new TaskError("invalid", `${u.name} is deactivated`, "assigneeId");
  return u;
}

/** Checks actor → assignee → contact rights and returns the assignee (and contact). */
async function checkTarget(
  actor: TaskActor,
  assigneeId: string,
  contactId: string | null,
  tx: Tx,
): Promise<{ assignee: Awaited<ReturnType<typeof loadAssignee>>; contact: ContactRef | null }> {
  if (assigneeId !== actor.id && !canAssignToOthers(actor)) {
    throw new TaskError("forbidden", "Only a manager or admin can give tasks to someone else", "assigneeId");
  }
  const assignee = await loadAssignee(assigneeId, tx);
  let contact: ContactRef | null = null;
  if (contactId) {
    contact = await loadContact(contactId, tx);
    if (!canViewContact(actor, contact)) throw new TaskError("not_found", "That contact no longer exists", "contactId");
    if (!canViewContact(assignee, contact)) {
      throw new TaskError(
        "invalid",
        `${assignee.name} cannot see ${contact.name}: it belongs to another salesperson. Reassign the contact first, or give the task to its owner.`,
        "assigneeId",
      );
    }
  }
  return { assignee, contact };
}

async function tellAssignee(
  actor: TaskActor,
  assignee: { id: string },
  taskId: string,
  title: string,
  contact: ContactRef | null,
  dueAt: Date,
  tx: Tx,
) {
  if (assignee.id === actor.id) return;
  const by = actor.name ?? (await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.id)).limit(1))[0]?.name;
  await notify(
    {
      userId: assignee.id,
      type: "task_assigned",
      title: `New task from ${by ?? "a manager"}: ${title}`,
      body: contact ? `For ${contact.name}` : null,
      contactId: contact?.id ?? null,
      taskId,
      // one alert per assignment (a second reassignment back and forth notifies again)
      dedupeKey: `task_assigned:${taskId}:${dueAt.toISOString()}`,
    },
    tx,
  );
}

/** Creates a manual task (type "task") and returns its id. */
export async function createManualTask(input: TaskInput, actor: TaskActor, tx: Tx = db): Promise<string> {
  const title = cleanTitle(input.title);
  const notes = cleanNotes(input.notes);
  if (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.getTime())) {
    throw new TaskError("invalid", "Pick a due date", "dueDate");
  }
  const assigneeId = input.assigneeId || actor.id;
  return (tx as Database).transaction(async (t) => {
    const { assignee, contact } = await checkTarget(actor, assigneeId, input.contactId || null, t);
    const [row] = await t
      .insert(tasks)
      .values({
        type: "task",
        reason: title,
        dueAt: input.dueAt,
        userId: assignee.id,
        contactId: contact?.id ?? null,
        payload: notes ? { notes } : null,
        createdById: actor.id,
      })
      .returning({ id: tasks.id });
    await tellAssignee(actor, assignee, row.id, title, contact, input.dueAt, t);
    return row.id;
  });
}

type LockedTask = {
  id: string;
  type: TaskType;
  status: TaskStatus;
  userId: string | null;
  createdById: string | null;
  contactId: string | null;
  reason: string;
  dueAt: Date;
  payload: Record<string, unknown> | null;
};

async function lockTask(taskId: string, actor: TaskActor, tx: Tx): Promise<LockedTask> {
  if (!isUuid(taskId)) throw new TaskError("not_found", "That task no longer exists");
  const rows = await tx
    .select({
      id: tasks.id,
      type: tasks.type,
      status: tasks.status,
      userId: tasks.userId,
      createdById: tasks.createdById,
      contactId: tasks.contactId,
      reason: tasks.reason,
      dueAt: tasks.dueAt,
      payload: tasks.payload,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("update")
    .limit(1);
  const task = rows[0];
  if (!task || !LISTED_TASK_TYPES.includes(task.type)) throw new TaskError("not_found", "That task no longer exists");
  if (!canChangeTask(actor, task)) throw new TaskError("forbidden", "This task belongs to someone else");
  if (task.contactId && !can(actor, "contacts.viewAll")) {
    const c = await tx.select({ ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, task.contactId)).limit(1);
    if (!c[0] || !canViewContact(actor, c[0])) throw new TaskError("forbidden", "This task belongs to someone else");
  }
  return task;
}

export type TaskPatch = Partial<TaskInput>;

/**
 * Edits an open task. A manual task's title, notes, due time, assignee and contact can change; a follow-up can only
 * be rescheduled (its text is the logged touch). Returns true when something changed.
 */
export async function updateTask(taskId: string, patch: TaskPatch, actor: TaskActor, tx: Tx = db): Promise<boolean> {
  return (tx as Database).transaction(async (t) => {
    const task = await lockTask(taskId, actor, t);
    if (task.status !== "open") throw new TaskError("invalid", "Reopen the task before changing it");
    const set: Partial<typeof tasks.$inferInsert> = {};
    if (patch.dueAt !== undefined) {
      if (!(patch.dueAt instanceof Date) || Number.isNaN(patch.dueAt.getTime())) {
        throw new TaskError("invalid", "Pick a due date", "dueDate");
      }
      if (patch.dueAt.getTime() !== task.dueAt.getTime()) set.dueAt = patch.dueAt;
    }
    const editsText = patch.title !== undefined || patch.notes !== undefined || patch.assigneeId !== undefined || patch.contactId !== undefined;
    if (task.type !== "task" && editsText) {
      // a follow-up's words come from the logged touch: only its time moves (the form never sends the rest)
      const onlySame =
        (patch.title === undefined || patch.title === task.reason) &&
        patch.notes === undefined &&
        (patch.assigneeId === undefined || patch.assigneeId === task.userId) &&
        (patch.contactId === undefined || patch.contactId === task.contactId);
      if (!onlySame) throw new TaskError("invalid", "A follow-up can only be rescheduled or completed");
    }
    let notifyAssignee: Awaited<ReturnType<typeof loadAssignee>> | null = null;
    let contact: ContactRef | null = null;
    if (task.type === "task") {
      if (patch.title !== undefined) {
        const title = cleanTitle(patch.title);
        if (title !== task.reason) set.reason = title;
      }
      if (patch.notes !== undefined) {
        const notes = cleanNotes(patch.notes);
        const before = (task.payload?.notes as string | undefined) ?? null;
        if (notes !== before) set.payload = { ...(task.payload ?? {}), notes };
      }
      const assigneeId = patch.assigneeId === undefined ? task.userId : patch.assigneeId || actor.id;
      const contactId = patch.contactId === undefined ? task.contactId : patch.contactId || null;
      if (assigneeId !== task.userId || contactId !== task.contactId) {
        if (!assigneeId) throw new TaskError("invalid", "Choose who the task is for", "assigneeId");
        // moving a task to someone else is a manager's call, like creating one for them
        const target = await checkTarget(actor, assigneeId, contactId, t);
        contact = target.contact;
        if (assigneeId !== task.userId) {
          set.userId = assigneeId;
          notifyAssignee = target.assignee;
        }
        if (contactId !== task.contactId) set.contactId = contactId;
      }
    }
    if (!Object.keys(set).length) return false;
    await t.update(tasks).set(set).where(eq(tasks.id, task.id));
    if (notifyAssignee) {
      if (!contact && task.contactId) contact = await loadContact(task.contactId, t).catch(() => null);
      await tellAssignee(actor, notifyAssignee, task.id, set.reason ?? task.reason, contact, set.dueAt ?? task.dueAt, t);
    }
    return true;
  });
}

export type TaskStatusChange = "done" | "open" | "cancel";

/**
 * Done, reopen (a done or cancelled task becomes open again) or cancel. Cancel is for manual tasks only: a
 * follow-up is done or rescheduled, never dropped (the same rule as Dismiss on Today).
 */
export async function setTaskStatus(
  taskId: string,
  change: TaskStatusChange,
  actor: TaskActor,
  opts: { now?: Date } = {},
  tx: Tx = db,
): Promise<boolean> {
  const now = opts.now ?? new Date();
  return (tx as Database).transaction(async (t) => {
    const task = await lockTask(taskId, actor, t);
    if (change === "open") {
      if (task.status === "open") return false;
      await t.update(tasks).set({ status: "open", completedAt: null, completedById: null }).where(eq(tasks.id, task.id));
      return true;
    }
    if (task.status !== "open") return false;
    if (change === "cancel" && task.type !== "task") {
      throw new TaskError("invalid", "Follow-ups can be done or rescheduled, not cancelled");
    }
    await t
      .update(tasks)
      .set({ status: change === "done" ? "done" : "dismissed", completedAt: now, completedById: actor.id })
      .where(eq(tasks.id, task.id));
    return true;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type TaskRow = {
  id: string;
  type: TaskType;
  title: string;
  notes: string | null;
  dueAt: Date;
  status: TaskStatus;
  userId: string | null;
  assigneeName: string | null;
  createdById: string | null;
  createdByName: string | null;
  completedAt: Date | null;
  contact: { id: string; name: string; phoneE164: string; grade: "A" | "B" | "C" | "D" | null } | null;
};

const creator = alias(users, "task_creator");

function baseSelect(tx: Tx) {
  return tx
    .select({
      id: tasks.id,
      type: tasks.type,
      title: tasks.reason,
      payload: tasks.payload,
      dueAt: tasks.dueAt,
      status: tasks.status,
      userId: tasks.userId,
      assigneeName: users.name,
      createdById: tasks.createdById,
      createdByName: creator.name,
      completedAt: tasks.completedAt,
      contactId: contacts.id,
      contactName: contacts.name,
      phoneE164: contacts.phoneE164,
      grade: contacts.grade,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.userId))
    .leftJoin(creator, eq(creator.id, tasks.createdById))
    .leftJoin(contacts, eq(contacts.id, tasks.contactId));
}

type RawRow = Awaited<ReturnType<ReturnType<typeof baseSelect>["execute"]>>[number];

function toRow(r: RawRow): TaskRow {
  const notes = r.payload && typeof r.payload.notes === "string" ? r.payload.notes : null;
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    notes,
    dueAt: r.dueAt,
    status: r.status,
    userId: r.userId,
    assigneeName: r.assigneeName,
    createdById: r.createdById,
    createdByName: r.createdByName,
    completedAt: r.completedAt,
    contact:
      r.contactId && r.contactName !== null && r.phoneE164 !== null
        ? { id: r.contactId, name: r.contactName, phoneE164: r.phoneE164, grade: r.grade }
        : null,
  };
}

type Viewer = { id: string; role: Role };

/** Tasks on contacts the viewer can no longer see never show (a salesperson's contact moved to a colleague). */
function visible(viewer: Viewer): SQL | undefined {
  const live = or(isNull(tasks.contactId), isNull(contacts.mergedIntoId));
  if (can(viewer, "contacts.viewAll")) return live;
  return and(live, or(isNull(tasks.contactId), isNull(contacts.ownerId), eq(contacts.ownerId, viewer.id)));
}

export const TASKS_PAGE_SIZE = 50;

/**
 * One /tasks view, newest-relevant first:
 *   mine     open tasks of the viewer, by due time
 *   overdue  the viewer's open tasks due before now
 *   upcoming the viewer's open tasks due from now on
 *   team     every open task (managers and admins), optionally one person's (`assigneeId`, "pool" for unassigned)
 *   done     the viewer's done or cancelled tasks, latest first
 */
export async function listTasks(
  viewer: Viewer,
  view: Exclude<TaskView, "agenda">,
  opts: { now?: Date; assigneeId?: string | null; page?: number; tx?: Tx } = {},
): Promise<{ rows: TaskRow[]; total: number; page: number; pageCount: number }> {
  const tx = opts.tx ?? db;
  const now = opts.now ?? new Date();
  if (view === "team" && !canSeeTeamTasks(viewer)) throw new TaskError("forbidden", "Only managers and admins see the team's tasks");
  const conds: (SQL | undefined)[] = [inArray(tasks.type, LISTED_TASK_TYPES), visible(viewer)];
  if (view === "team") {
    conds.push(eq(tasks.status, "open"));
    if (opts.assigneeId === "pool") conds.push(isNull(tasks.userId));
    else if (opts.assigneeId && isUuid(opts.assigneeId)) conds.push(eq(tasks.userId, opts.assigneeId));
  } else {
    conds.push(eq(tasks.userId, viewer.id));
    if (view === "done") conds.push(inArray(tasks.status, ["done", "dismissed"]));
    else conds.push(eq(tasks.status, "open"));
    if (view === "overdue") conds.push(lt(tasks.dueAt, now));
    if (view === "upcoming") conds.push(gte(tasks.dueAt, now));
  }
  const where = and(...conds);
  const [{ n }] = await tx
    .select({ n: count() })
    .from(tasks)
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .where(where);
  const pageCount = Math.max(1, Math.ceil(n / TASKS_PAGE_SIZE));
  const page = Math.min(Math.max(1, opts.page ?? 1), pageCount);
  const order = view === "done" ? [desc(tasks.completedAt), desc(tasks.id)] : [asc(tasks.dueAt), asc(tasks.id)];
  const rows = n
    ? await baseSelect(tx)
        .where(where)
        .orderBy(...order)
        .limit(TASKS_PAGE_SIZE)
        .offset((page - 1) * TASKS_PAGE_SIZE)
    : [];
  return { rows: rows.map(toRow), total: n, page, pageCount };
}

/** Badge counts for the /tasks tabs (the viewer's open, overdue; the team's open for managers). */
export async function taskCounts(viewer: Viewer, now: Date = new Date(), tx: Tx = db) {
  const base = and(inArray(tasks.type, LISTED_TASK_TYPES), eq(tasks.status, "open"), visible(viewer));
  const [mine] = await tx
    .select({
      open: count(),
      overdue: sql<number>`count(*) filter (where ${tasks.dueAt} < ${now.toISOString()}::timestamptz)::int`,
    })
    .from(tasks)
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .where(and(base, eq(tasks.userId, viewer.id)));
  let team: number | null = null;
  if (canSeeTeamTasks(viewer)) {
    const [r] = await tx.select({ n: count() }).from(tasks).leftJoin(contacts, eq(contacts.id, tasks.contactId)).where(base);
    team = r.n;
  }
  return { open: mine.open, overdue: Number(mine.overdue), upcoming: mine.open - Number(mine.overdue), team };
}

/** The viewer's open tasks and follow-ups due in [from, to), plus how many are overdue before `from`. */
export async function agendaTasks(
  viewer: Viewer,
  from: Date,
  to: Date,
  tx: Tx = db,
): Promise<{ rows: TaskRow[]; overdueBefore: number }> {
  const base = and(inArray(tasks.type, LISTED_TASK_TYPES), eq(tasks.status, "open"), eq(tasks.userId, viewer.id), visible(viewer));
  const [rows, [{ n }]] = await Promise.all([
    baseSelect(tx)
      .where(and(base, gte(tasks.dueAt, from), lt(tasks.dueAt, to)))
      .orderBy(asc(tasks.dueAt), asc(tasks.id))
      .limit(500),
    tx.select({ n: count() }).from(tasks).leftJoin(contacts, eq(contacts.id, tasks.contactId)).where(and(base, lt(tasks.dueAt, from))),
  ]);
  return { rows: rows.map(toRow), overdueBefore: n };
}

/** Open tasks and follow-ups on one contact (contact page card), soonest first. */
export async function contactOpenTasks(contactId: string, viewer: Viewer, tx: Tx = db): Promise<TaskRow[]> {
  if (!isUuid(contactId)) return [];
  const rows = await baseSelect(tx)
    .where(and(eq(tasks.contactId, contactId), inArray(tasks.type, LISTED_TASK_TYPES), eq(tasks.status, "open"), visible(viewer)))
    .orderBy(asc(tasks.dueAt), asc(tasks.id))
    .limit(20);
  return rows.map(toRow);
}

/** One task for its edit form (null when the viewer may not change it). */
export async function getTaskForEdit(taskId: string, viewer: TaskActor, tx: Tx = db): Promise<TaskRow | null> {
  if (!isUuid(taskId)) return null;
  const rows = await baseSelect(tx)
    .where(and(eq(tasks.id, taskId), inArray(tasks.type, LISTED_TASK_TYPES), visible(viewer)))
    .limit(1);
  const r = rows[0];
  if (!r || !canChangeTask(viewer, { userId: r.userId, createdById: r.createdById })) return null;
  return toRow(r);
}

/** People a task can be given to: active team members (support included: they keep their own reminders). */
export async function taskAssigneeOptions(tx: Tx = db): Promise<{ value: string; label: string }[]> {
  const rows = await tx
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(asc(users.name));
  const roleLabel: Record<Role, string> = { admin: "Admin", manager: "Manager", sales: "Sales", support: "Support" };
  return rows.map((u) => ({ value: u.id, label: `${u.name} (${roleLabel[u.role]})` }));
}
