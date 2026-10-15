import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardBody, PageHeader } from "@/components/ui/card";
import { TaskForm } from "@/components/tasks/task-form";
import { requireUser } from "@/lib/auth/session";
import { canAssignToOthers, dueChips, dueInputs, todayDefaultTime } from "@/lib/tasks/rules";
import { getTaskForEdit, taskAssigneeOptions } from "@/lib/tasks/service";
import { safeReturnPath } from "@/lib/today/rules";
import { localIsoDate, validTimeZone } from "@/lib/today/time";
import { updateTaskAction } from "../actions";

export const metadata = { title: "Edit task" };

export default async function EditTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ return?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const task = await getTaskForEdit(id, user);
  if (!task) notFound();
  const now = new Date();
  const tz = validTimeZone(user.timezone);
  const back = safeReturnPath(sp.return, "/tasks");
  const due = dueInputs(task.dueAt, tz);
  const kind = task.type === "task" ? "task" : "follow_up";
  const assignees = kind === "task" && canAssignToOthers(user) ? await taskAssigneeOptions() : null;
  const today = localIsoDate(now, tz);
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        back={
          <Link href={back} className="hover:underline">
            ← Back
          </Link>
        }
        title={kind === "task" ? "Edit task" : "Reschedule follow-up"}
        description={task.status === "open" ? undefined : "This task is closed. Reopen it from the Done list to change it."}
      />
      <Card>
        <CardBody>
          <TaskForm
            action={updateTaskAction}
            kind={kind}
            taskId={task.id}
            initial={{
              title: task.title,
              notes: task.notes,
              // an overdue task keeps its date in the field only if it is still valid (today or later)
              dueDate: due.date < today ? today : due.date,
              dueTime: due.time,
              assigneeId: task.userId ?? undefined,
            }}
            pickerContact={task.contact ? { id: task.contact.id, name: task.contact.name } : null}
            chips={dueChips(now, tz)}
            todayTime={todayDefaultTime(now, tz)}
            minDate={today}
            assignees={assignees}
            meId={user.id}
            returnTo={back}
            submitLabel="Save"
          />
        </CardBody>
      </Card>
    </div>
  );
}
