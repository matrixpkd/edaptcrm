import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, ListTodo, Plus } from "lucide-react";
import { ButtonLink, buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { TaskRowCard } from "@/components/tasks/task-row";
import { requireUser } from "@/lib/auth/session";
import { agendaWindow, canSeeTeamTasks, parseTaskView, type AgendaRange, type TaskView } from "@/lib/tasks/rules";
import { agendaTasks, listTasks, taskAssigneeOptions, taskCounts } from "@/lib/tasks/service";
import { rescheduleTargets, toTaskRowView } from "@/lib/tasks/view";
import { validTimeZone, weekdayDate } from "@/lib/today/time";
import { cn } from "@/lib/utils";

export const metadata = { title: "Tasks" };
export const dynamic = "force-dynamic";

type SP = { view?: string; page?: string; who?: string; range?: string; offset?: string };

const EMPTY: Record<Exclude<TaskView, "agenda">, { title: string; text: string }> = {
  mine: { title: "No open tasks", text: "Add a reminder for anything you promised: a brochure to send, a call to return, a price to check." },
  overdue: { title: "Nothing overdue", text: "Every task and follow-up is on time." },
  upcoming: { title: "Nothing coming up", text: "Tasks and follow-ups due later show here." },
  team: { title: "The team has no open tasks", text: "Tasks you give someone show here and on their Today when due." },
  done: { title: "Nothing done yet", text: "Completed and cancelled tasks show here, latest first." },
};

export default async function TasksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const view = parseTaskView(sp.view, user);
  const now = new Date();
  const tz = validTimeZone(user.timezone);
  const counts = await taskCounts(user, now);
  const href = (v: TaskView) => (v === "mine" ? "/tasks" : `/tasks?view=${v}`);
  const tabs = [
    { key: "mine", label: "My tasks", href: href("mine"), count: counts.open || undefined },
    { key: "overdue", label: "Overdue", href: href("overdue"), count: counts.overdue || undefined },
    { key: "upcoming", label: "Upcoming", href: href("upcoming") },
    { key: "agenda", label: "Agenda", href: href("agenda") },
    ...(canSeeTeamTasks(user) ? [{ key: "team", label: "Team tasks", href: href("team"), count: counts.team || undefined }] : []),
    { key: "done", label: "Done", href: href("done") },
  ];
  const returnTo = `/tasks${view === "mine" ? "" : `?view=${view}`}`;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Tasks"
        description="Your reminders and follow-ups. Anything due today also shows on Today."
        actions={
          <ButtonLink href={`/tasks/new?return=${encodeURIComponent(returnTo)}`} variant="primary">
            <Plus className="h-4 w-4" aria-hidden /> New task
          </ButtonLink>
        }
      />
      <Tabs tabs={tabs} active={view} className="mb-4" />
      {view === "agenda" ? (
        <Agenda user={user} now={now} tz={tz} range={sp.range === "day" ? "day" : "week"} offset={Number.parseInt(sp.offset ?? "0", 10) || 0} />
      ) : (
        <TaskList user={user} view={view} now={now} tz={tz} page={Number.parseInt(sp.page ?? "1", 10) || 1} who={sp.who ?? null} returnTo={returnTo} />
      )}
    </div>
  );
}

type PageUser = Awaited<ReturnType<typeof requireUser>>;

async function TaskList({
  user,
  view,
  now,
  tz,
  page,
  who,
  returnTo,
}: {
  user: PageUser;
  view: Exclude<TaskView, "agenda">;
  now: Date;
  tz: string;
  page: number;
  who: string | null;
  returnTo: string;
}) {
  const [result, people] = await Promise.all([
    listTasks(user, view, { now, page, assigneeId: view === "team" ? who : null }),
    view === "team" ? taskAssigneeOptions() : Promise.resolve(null),
  ]);
  const targets = rescheduleTargets(now, tz);
  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (view !== "mine") q.set("view", view);
    if (who) q.set("who", who);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return `/tasks${s ? `?${s}` : ""}`;
  };
  return (
    <>
      {people && (
        <form method="get" action="/tasks" className="mb-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="view" value="team" />
          <label className="flex flex-col gap-1 text-sm font-medium">
            Person
            <select name="who" defaultValue={who ?? ""} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm">
              <option value="">Everyone</option>
              <option value="pool">Pool (no one yet)</option>
              {people.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClass("outline", "md")}>
            Show
          </button>
        </form>
      )}
      {result.rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface px-6 py-12 text-center">
          <ListTodo className="mx-auto mb-3 h-8 w-8 text-muted" aria-hidden />
          <p className="font-medium">{EMPTY[view].title}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{EMPTY[view].text}</p>
          {view !== "done" && (
            <ButtonLink href={`/tasks/new?return=${encodeURIComponent(returnTo)}`} variant="outline" className="mt-4">
              <Plus className="h-4 w-4" aria-hidden /> New task
            </ButtonLink>
          )}
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">
            {result.total} {result.total === 1 ? "task" : "tasks"}
          </p>
          <ul className="space-y-2">
            {result.rows.map((t) => (
              <TaskRowCard
                key={t.id}
                task={toTaskRowView(t, user, now, tz, { showAssignee: view === "team" })}
                reschedule={targets}
                returnTo={returnTo}
              />
            ))}
          </ul>
          {result.pageCount > 1 && (
            <nav className="mt-4 flex items-center justify-between" aria-label="Pages">
              {result.page > 1 ? (
                <Link href={pageHref(result.page - 1)} className={buttonClass("outline", "sm")}>
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-sm text-muted">
                Page {result.page} of {result.pageCount}
              </span>
              {result.page < result.pageCount ? (
                <Link href={pageHref(result.page + 1)} className={buttonClass("outline", "sm")}>
                  Next
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </>
  );
}

async function Agenda({ user, now, tz, range, offset }: { user: PageUser; now: Date; tz: string; range: AgendaRange; offset: number }) {
  const win = agendaWindow(now, tz, range, offset);
  const { rows, overdueBefore } = await agendaTasks(user, win.from, win.to);
  const targets = rescheduleTargets(now, tz);
  const link = (r: AgendaRange, o: number) => `/tasks?view=agenda&range=${r}${o ? `&offset=${o}` : ""}`;
  const todayKey = agendaWindow(now, tz, "day", 0).days[0].key;
  return (
    <section aria-label="Agenda">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border bg-surface p-0.5" role="group" aria-label="Agenda range">
          {(["day", "week"] as const).map((r) => (
            <Link
              key={r}
              href={link(r, 0)}
              aria-current={range === r ? "page" : undefined}
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium", range === r ? "bg-foreground text-white" : "text-muted hover:text-foreground")}
            >
              {r === "day" ? "Day" : "Week"}
            </Link>
          ))}
        </div>
        <Link href={link(range, offset - 1)} className={buttonClass("outline", "icon")} aria-label={range === "day" ? "Previous day" : "Previous week"}>
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <Link href={link(range, offset + 1)} className={buttonClass("outline", "icon")} aria-label={range === "day" ? "Next day" : "Next week"}>
          <ChevronRight className="h-4 w-4" />
        </Link>
        {offset !== 0 && (
          <Link href={link(range, 0)} className={buttonClass("ghost", "sm")}>
            Back to today
          </Link>
        )}
      </div>
      {overdueBefore > 0 && (
        <p className="mb-4 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          {overdueBefore} overdue {overdueBefore === 1 ? "task is" : "tasks are"} not in this view.{" "}
          <Link href="/tasks?view=overdue" className="font-medium underline">
            See overdue
          </Link>
        </p>
      )}
      <ol className="space-y-5">
        {win.days.map((d) => {
          const due = rows.filter((r) => r.dueAt >= d.start && r.dueAt < d.end);
          return (
            <li key={d.key} aria-label={weekdayDate(d.start, tz)}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <CalendarDays className="h-4 w-4 text-muted" aria-hidden />
                {weekdayDate(d.start, tz)}
                {d.key === todayKey && <span className="rounded-full bg-foreground px-2 text-xs text-white">Today</span>}
                <span className="font-normal text-muted">· {due.length || "nothing"}</span>
              </h2>
              {due.length > 0 && (
                <ul className="space-y-2">
                  {due.map((t) => (
                    <TaskRowCard key={t.id} task={toTaskRowView(t, user, now, tz)} reschedule={targets} returnTo="/tasks?view=agenda" compact />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
