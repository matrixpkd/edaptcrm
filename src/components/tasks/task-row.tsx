"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { CalendarClock, Check, Pencil, RotateCcw, X } from "lucide-react";
import { rescheduleTaskAction, taskStatusAction } from "@/app/(app)/tasks/actions";
import { Badge, GradeBadge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action";
import { cn } from "@/lib/utils";

export type TaskRowView = {
  id: string;
  kind: "task" | "follow_up";
  title: string;
  notes: string | null;
  status: "open" | "done" | "dismissed";
  bucket: "overdue" | "today" | "upcoming" | null;
  dueLabel: string;
  /** "Done 12 Oct" etc. for closed tasks */
  closedLabel: string | null;
  assigneeName: string | null;
  showAssignee: boolean;
  createdByOther: string | null;
  contact: { id: string; name: string; grade: "A" | "B" | "C" | "D" | null } | null;
  canChange: boolean;
};

const btn =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:h-9";

/** One task on /tasks, the agenda or a contact page: Done, Reschedule, Edit, Cancel (tasks) or Reopen. */
export function TaskRowCard({
  task,
  reschedule,
  returnTo,
  compact = false,
  hideContact = false,
}: {
  task: TaskRowView;
  /** quick reschedule targets as local dates */
  reschedule: { label: string; date: string }[];
  returnTo: string;
  compact?: boolean;
  /** on the contact's own page the contact link would only repeat the page */
  hideContact?: boolean;
}) {
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  function run(action: (p: ActionResult, fd: FormData) => Promise<ActionResult>, fields: Record<string, string>, hide = true) {
    const fd = new FormData();
    fd.set("taskId", task.id);
    if (task.contact) fd.set("contactId", task.contact.id);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    setError(null);
    if (hide) setHidden(true);
    start(async () => {
      let r: ActionResult;
      try {
        r = await action(null, fd);
      } catch {
        r = { ok: false, error: "Could not reach the server. Check your connection and try again." };
      }
      if (!r?.ok) {
        setHidden(false);
        setError(r?.error ?? "Something went wrong");
      } else {
        setMoving(false);
        toast(`${r.message ?? "Saved"}: ${task.title}`);
      }
    });
  }

  if (hidden && !error) return <li className="sr-only">{pending ? "Saving…" : "Saved"}</li>;

  const open = task.status === "open";
  const editHref = `/tasks/${task.id}?return=${encodeURIComponent(returnTo)}`;
  return (
    <li className={cn("rounded-xl border bg-surface", compact ? "p-3" : "p-3 sm:p-4", task.bucket === "overdue" && open ? "border-warning/50" : "border-border")}>
      <div className="flex items-start gap-3">
        {open && task.canChange ? (
          <button
            type="button"
            onClick={() => run(taskStatusAction, { change: "done" })}
            disabled={pending}
            aria-label={`Mark done: ${task.title}`}
            title="Mark done"
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-border text-transparent hover:border-success hover:text-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Check className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <span
            className={cn(
              "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
              task.status === "done" ? "bg-success text-white" : "border-2 border-border text-muted",
            )}
            aria-hidden
          >
            {task.status === "done" ? <Check className="h-4 w-4" /> : task.status === "dismissed" ? <X className="h-4 w-4" /> : null}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-semibold leading-snug sm:text-base", task.status !== "open" && "text-muted line-through")}>{task.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            {open ? (
              <Badge tone={task.bucket === "overdue" ? "warning" : task.bucket === "today" ? "info" : "neutral"}>{task.dueLabel}</Badge>
            ) : (
              task.closedLabel && <span className="text-muted">{task.closedLabel}</span>
            )}
            {task.kind === "follow_up" && <Badge>Follow-up</Badge>}
            {task.showAssignee && <span className="text-muted">For {task.assigneeName ?? "the pool"}</span>}
            {task.createdByOther && <span className="text-muted">From {task.createdByOther}</span>}
          </div>
          {task.contact && !hideContact && (
            <Link href={`/contacts/${task.contact.id}`} className="mt-1.5 inline-flex max-w-full items-center gap-1.5 text-sm hover:underline">
              <GradeBadge grade={task.contact.grade} size="sm" />
              <span className="truncate font-medium">{task.contact.name}</span>
            </Link>
          )}
          {task.notes && !compact && <p className="mt-1 whitespace-pre-line text-sm text-muted">{task.notes}</p>}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {task.canChange && (
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-10">
          {open ? (
            moving ? (
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Reschedule to">
                {reschedule.map((r, i) => (
                  <button
                    key={r.label}
                    type="button"
                    className={btn}
                    autoFocus={i === 0}
                    disabled={pending}
                    onClick={() => run(rescheduleTaskAction, { dueDate: r.date, dueTime: "10:00" }, false)}
                  >
                    {r.label}
                  </button>
                ))}
                <Link href={editHref} className={btn}>
                  Pick a time
                </Link>
                <button type="button" className={cn(btn, "border-transparent text-muted")} onClick={() => setMoving(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button type="button" className={btn} disabled={pending} onClick={() => run(taskStatusAction, { change: "done" })}>
                  <Check className="h-4 w-4" aria-hidden /> Done
                </button>
                <button type="button" className={btn} disabled={pending} onClick={() => setMoving(true)}>
                  <CalendarClock className="h-4 w-4" aria-hidden /> Reschedule
                </button>
                <Link href={editHref} className={btn} aria-label={`Edit: ${task.title}`}>
                  <Pencil className="h-4 w-4" aria-hidden /> Edit
                </Link>
                {task.kind === "task" && (
                  <button
                    type="button"
                    className={cn(btn, "text-muted")}
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Cancel the task "${task.title}"?`)) run(taskStatusAction, { change: "cancel" });
                    }}
                  >
                    <X className="h-4 w-4" aria-hidden /> Cancel task
                  </button>
                )}
              </>
            )
          ) : (
            <button type="button" className={btn} disabled={pending} onClick={() => run(taskStatusAction, { change: "open" })}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Reopen
            </button>
          )}
        </div>
      )}
    </li>
  );
}
