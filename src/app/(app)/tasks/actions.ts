"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { safeReturnPath } from "@/lib/today/rules";
import { requireUser } from "@/lib/auth/session";
import { flash } from "@/lib/flash";
import { resolveDue, TaskError } from "@/lib/tasks/rules";
import { createManualTask, setTaskStatus, updateTask, type TaskStatusChange } from "@/lib/tasks/service";

function failTask(e: unknown): ActionResult<never> {
  if (e instanceof TaskError) return fail(e.message, e.field ? { [e.field]: e.message } : undefined);
  throw e;
}

function refresh(contactId: string | null) {
  revalidatePath("/tasks");
  revalidatePath("/today");
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

/** New task (from /tasks/new, the contact page or Today). Goes back to ?return= (same site only) or /tasks. */
export async function createTaskAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const contactId = str(fd, "contactId");
  try {
    const dueAt = resolveDue(str(fd, "dueDate"), str(fd, "dueTime"), new Date(), user.timezone);
    await createManualTask(
      { title: str(fd, "title") ?? "", notes: str(fd, "notes"), dueAt, assigneeId: str(fd, "assigneeId"), contactId },
      { id: user.id, role: user.role, name: user.name },
    );
  } catch (e) {
    return failTask(e);
  }
  refresh(contactId);
  await flash("Task added");
  redirect(safeReturnPath(str(fd, "return"), contactId ? `/contacts/${contactId}` : "/tasks"));
}

/** Edit a task (a follow-up: reschedule only). */
export async function updateTaskAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const taskId = str(fd, "taskId") ?? "";
  const kind = str(fd, "kind");
  const contactId = str(fd, "contactId");
  try {
    const dueAt = resolveDue(str(fd, "dueDate"), str(fd, "dueTime"), new Date(), user.timezone);
    await updateTask(
      taskId,
      kind === "task"
        ? { title: str(fd, "title") ?? "", notes: str(fd, "notes"), dueAt, assigneeId: str(fd, "assigneeId"), contactId }
        : { dueAt },
      { id: user.id, role: user.role, name: user.name },
    );
  } catch (e) {
    return failTask(e);
  }
  refresh(contactId);
  await flash("Task saved");
  redirect(safeReturnPath(str(fd, "return"), "/tasks"));
}

const STATUS_MESSAGES: Record<TaskStatusChange, string> = { done: "Marked done", open: "Reopened", cancel: "Task cancelled" };

/** Done / Reopen / Cancel from a task row. */
export async function taskStatusAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const change = str(fd, "change");
  if (change !== "done" && change !== "open" && change !== "cancel") return fail("Unknown action");
  try {
    const changed = await setTaskStatus(str(fd, "taskId") ?? "", change, user);
    refresh(str(fd, "contactId"));
    return ok(undefined, changed ? STATUS_MESSAGES[change] : "Nothing to change");
  } catch (e) {
    return failTask(e);
  }
}

/** Quick reschedule chips on a task row: tomorrow / next week at 10:00 local, or a typed date. */
export async function rescheduleTaskAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const dueAt = resolveDue(str(fd, "dueDate"), str(fd, "dueTime"), new Date(), user.timezone);
    await updateTask(str(fd, "taskId") ?? "", { dueAt }, user);
  } catch (e) {
    return failTask(e);
  }
  refresh(str(fd, "contactId"));
  return ok(undefined, "Rescheduled");
}
