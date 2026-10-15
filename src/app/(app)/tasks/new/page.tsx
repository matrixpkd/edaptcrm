import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardBody, PageHeader } from "@/components/ui/card";
import { TaskForm } from "@/components/tasks/task-form";
import { canViewContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getContactHeader } from "@/lib/contacts/queries";
import { canAssignToOthers, dueChips, todayDefaultTime } from "@/lib/tasks/rules";
import { taskAssigneeOptions } from "@/lib/tasks/service";
import { safeReturnPath } from "@/lib/today/rules";
import { localIsoDate, validTimeZone } from "@/lib/today/time";
import { createTaskAction } from "../actions";

export const metadata = { title: "New task" };

/** New task: from /tasks, Today ("Add task") or a contact page (?contact=<id>). */
export default async function NewTaskPage({ searchParams }: { searchParams: Promise<{ contact?: string; return?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  let contact: { id: string; name: string } | null = null;
  if (sp.contact) {
    const c = await getContactHeader(sp.contact);
    if (!c || c.mergedIntoId || c.erasedAt || !canViewContact(user, c)) notFound();
    contact = { id: c.id, name: c.name };
  }
  const now = new Date();
  const tz = validTimeZone(user.timezone);
  const fallback = contact ? `/contacts/${contact.id}` : "/tasks";
  const back = safeReturnPath(sp.return, fallback);
  const assignees = canAssignToOthers(user) ? await taskAssigneeOptions() : null;
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        back={
          <Link href={back} className="hover:underline">
            ← Back
          </Link>
        }
        title={contact ? `New task for ${contact.name}` : "New task"}
        description="It shows on Today when it is due."
      />
      <Card>
        <CardBody>
          <TaskForm
            action={createTaskAction}
            chips={dueChips(now, tz)}
            todayTime={todayDefaultTime(now, tz)}
            minDate={localIsoDate(now, tz)}
            assignees={assignees}
            meId={user.id}
            fixedContact={contact}
            returnTo={back}
            submitLabel="Add task"
          />
        </CardBody>
      </Card>
    </div>
  );
}
