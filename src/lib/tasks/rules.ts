/**
 * Tasks and reminders (beyond the spec, docs/CRM_GAP_ANALYSIS.md): PURE rules shared by the service, the /tasks
 * screens and the forms. No server imports, safe in client components; every function takes `now`.
 *
 * A task is a row in `tasks`. Two kinds are managed on /tasks:
 *   - "task": a to-do or reminder someone typed (title in `reason`, optional notes in `payload.notes`);
 *   - "follow_up": the follow-up set when logging a call (rescheduled and completed here, never edited).
 * Everything else in `tasks` is an alert raised by the system and lives on Today.
 */
import type { Role, TaskType } from "@/db/schema";
import { localTimeInDays } from "@/lib/contacts/follow-up";
import { localDateAt, localDayEnd, localDayStart, localIsoDate, validTimeZone } from "@/lib/today/time";

/** The task types listed on /tasks and on the contact page. */
export const LISTED_TASK_TYPES: TaskType[] = ["task", "follow_up"];

export const TASK_TITLE_MAX = 200;
export const TASK_NOTES_MAX = 2000;
/** How far ahead a task may be due. */
export const TASK_MAX_DAYS_AHEAD = 731;

export class TaskError extends Error {
  readonly code: "invalid" | "forbidden" | "not_found";
  readonly field?: string;
  constructor(code: TaskError["code"], message: string, field?: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
    this.field = field;
  }
}

/** "HH:MM" (24 h) → [hour, minute], or null. */
export function parseTime(raw: string | null | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return [h, min];
}

/**
 * The due instant from the form's date ("YYYY-MM-DD") and optional time ("HH:MM", default 10:00) in the person's
 * time zone. A due time earlier today is allowed (a reminder you forgot to add); a day before today is not.
 */
export function resolveDue(
  date: string | null | undefined,
  time: string | null | undefined,
  now: Date,
  timeZone: string | null | undefined,
): Date {
  if (!date?.trim()) throw new TaskError("invalid", "Pick a due date", "dueDate");
  const t = time?.trim() ? parseTime(time) : [10, 0];
  if (!t) throw new TaskError("invalid", "Enter the time as hours and minutes, e.g. 15:30", "dueTime");
  const at = localDateAt(date, timeZone, t[0], t[1]);
  if (!at) throw new TaskError("invalid", "Pick a real date", "dueDate");
  if (at.getTime() < localDayStart(now, timeZone).getTime()) {
    throw new TaskError("invalid", "The due date is in the past", "dueDate");
  }
  if (at.getTime() > now.getTime() + TASK_MAX_DAYS_AHEAD * 86_400_000) {
    throw new TaskError("invalid", "Pick a due date within two years", "dueDate");
  }
  return at;
}

/** Trimmed title, required, at most TASK_TITLE_MAX characters. */
export function cleanTitle(raw: string | null | undefined): string {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) throw new TaskError("invalid", "Write what needs doing", "title");
  if (t.length > TASK_TITLE_MAX) throw new TaskError("invalid", `Keep the title under ${TASK_TITLE_MAX} characters`, "title");
  return t;
}

export function cleanNotes(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if (t.length > TASK_NOTES_MAX) throw new TaskError("invalid", `Keep the notes under ${TASK_NOTES_MAX} characters`, "notes");
  return t;
}

/** Managers and admins give tasks to anyone; everyone else only to themselves. */
export function canAssignToOthers(user: { role: Role }): boolean {
  return user.role === "admin" || user.role === "manager";
}

/** Team tasks (everyone's list) are for managers and admins. */
export function canSeeTeamTasks(user: { role: Role }): boolean {
  return canAssignToOthers(user);
}

/**
 * Who may change a task (edit, reschedule, complete, reopen, cancel): its assignee, the person who created it, or a
 * manager or admin. A pool follow-up (no assignee) is anyone's who can see its contact (checked by the caller).
 */
export function canChangeTask(
  user: { id: string; role: Role },
  task: { userId: string | null; createdById: string | null },
): boolean {
  if (canAssignToOthers(user)) return true;
  if (task.userId === null) return user.role === "sales";
  return task.userId === user.id || task.createdById === user.id;
}

export type TaskBucket = "overdue" | "today" | "upcoming";

/** Overdue (due before now), due later today, or upcoming (a later day), in the person's time zone. */
export function bucketOf(dueAt: Date, now: Date, timeZone: string | null | undefined): TaskBucket {
  if (dueAt.getTime() < now.getTime()) return "overdue";
  if (dueAt.getTime() < localDayEnd(now, timeZone).getTime()) return "today";
  return "upcoming";
}

export const TASK_VIEWS = ["mine", "overdue", "upcoming", "team", "done", "agenda"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export function parseTaskView(raw: string | null | undefined, user: { role: Role }): TaskView {
  const v = (TASK_VIEWS as readonly string[]).includes(raw ?? "") ? (raw as TaskView) : "mine";
  if (v === "team" && !canSeeTeamTasks(user)) return "mine";
  return v;
}

export type AgendaRange = "day" | "week";

/** The agenda window: today, or seven local days from today; `offset` moves it by whole windows. */
export function agendaWindow(
  now: Date,
  timeZone: string | null | undefined,
  range: AgendaRange,
  offset = 0,
): { from: Date; to: Date; days: { key: string; start: Date; end: Date }[] } {
  const tz = validTimeZone(timeZone);
  const span = range === "day" ? 1 : 7;
  const steps = Math.trunc(offset) * span;
  // walk whole local days (never 24-hour steps, so a DST change never skips or repeats a day)
  let cursor = localDayStart(now, tz);
  for (let i = 0; i < Math.abs(steps); i++) {
    cursor = steps > 0 ? localDayEnd(cursor, tz) : localDayStart(new Date(cursor.getTime() - 12 * 3_600_000), tz);
  }
  const days: { key: string; start: Date; end: Date }[] = [];
  for (let i = 0; i < span; i++) {
    const end = localDayEnd(cursor, tz);
    days.push({ key: localIsoDate(cursor, tz), start: cursor, end });
    cursor = end;
  }
  return { from: days[0].start, to: days[days.length - 1].end, days };
}

/** Value for <input type="date"> and <input type="time"> from an instant, in the person's zone. */
export function dueInputs(dueAt: Date, timeZone: string | null | undefined): { date: string; time: string } {
  const tz = validTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz })
    .format(dueAt)
    .replace(/^24:/, "00:");
  return { date: localIsoDate(dueAt, tz), time: parts };
}

/** The quick date chips of the task form, as local dates: Today, Tomorrow, In 3 days, Next week. */
export function dueChips(now: Date, timeZone: string | null | undefined): { key: string; label: string; date: string }[] {
  const tz = validTimeZone(timeZone);
  const at = (days: number) => localIsoDate(localTimeInDays(now, tz, days, 12, 0), tz);
  return [
    { key: "today", label: "Today", date: at(0) },
    { key: "tomorrow", label: "Tomorrow", date: at(1) },
    { key: "in3Days", label: "In 3 days", date: at(3) },
    { key: "nextWeek", label: "Next week", date: at(7) },
  ];
}

/** The task form's default time for a task due today: 10:00, or the next whole hour once that has passed. */
export function todayDefaultTime(now: Date, timeZone: string | null | undefined): string {
  const tz = validTimeZone(timeZone);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(now)) % 24;
  if (hour < 10) return "10:00";
  return `${String(Math.min(hour + 1, 23)).padStart(2, "0")}:00`;
}
