/**
 * Turns task rows into what the task components show (plain strings, safe to hand to a client component). PURE.
 */
import type { Role, TaskStatus, TaskType } from "@/db/schema";
import type { TaskRowView } from "@/components/tasks/task-row";
import { localDaysBetween, localTime, shortDate, weekdayDate } from "@/lib/today/time";
import { bucketOf, canChangeTask, dueChips } from "./rules";

export type TaskLike = {
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
  contact: { id: string; name: string; grade: "A" | "B" | "C" | "D" | null } | null;
};

/** "Overdue 2 days · 14 Oct", "Today 4:30 pm", "Tomorrow 10:00 am", "Fri 17 Oct 10:00 am". */
export function dueLabel(dueAt: Date, now: Date, timeZone: string): string {
  const days = localDaysBetween(now, dueAt, timeZone);
  const time = localTime(dueAt, timeZone);
  if (dueAt.getTime() < now.getTime()) {
    if (days === 0) return `Overdue · today ${time}`;
    const n = -days;
    return `Overdue ${n} day${n === 1 ? "" : "s"} · ${shortDate(dueAt, now, timeZone)}`;
  }
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${weekdayDate(dueAt, timeZone)} ${time}`;
  return `${shortDate(dueAt, now, timeZone)} ${time}`;
}

export function toTaskRowView(
  t: TaskLike,
  viewer: { id: string; role: Role },
  now: Date,
  timeZone: string,
  opts: { showAssignee?: boolean } = {},
): TaskRowView {
  return {
    id: t.id,
    kind: t.type === "task" ? "task" : "follow_up",
    title: t.title,
    notes: t.notes,
    status: t.status,
    bucket: t.status === "open" ? bucketOf(t.dueAt, now, timeZone) : null,
    dueLabel: dueLabel(t.dueAt, now, timeZone),
    closedLabel:
      t.status === "open" || !t.completedAt
        ? null
        : `${t.status === "done" ? "Done" : "Cancelled"} ${shortDate(t.completedAt, now, timeZone)}`,
    assigneeName: t.assigneeName,
    showAssignee: !!opts.showAssignee,
    createdByOther: t.createdById && t.createdById !== t.userId && t.createdById !== viewer.id ? t.createdByName : null,
    contact: t.contact ? { id: t.contact.id, name: t.contact.name, grade: t.contact.grade } : null,
    canChange: canChangeTask(viewer, t),
  };
}

/** Quick reschedule targets: tomorrow and next week (local dates). */
export function rescheduleTargets(now: Date, timeZone: string): { label: string; date: string }[] {
  const chips = dueChips(now, timeZone);
  return [
    { label: "Tomorrow", date: chips.find((c) => c.key === "tomorrow")!.date },
    { label: "In 3 days", date: chips.find((c) => c.key === "in3Days")!.date },
    { label: "Next week", date: chips.find((c) => c.key === "nextWeek")!.date },
  ];
}
