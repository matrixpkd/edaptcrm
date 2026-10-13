"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { AlarmClock, Check, Loader2, NotebookPen, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { queueTaskAction, transferDecisionAction } from "@/app/(app)/today/actions";
import { ContactQuickActions } from "@/components/contacts/quick-actions";
import { Badge, GradeBadge, StageBadge } from "@/components/ui/badge";
import type { ActionResult } from "@/lib/action";
import { SNOOZE_OPTIONS } from "@/lib/today/rules";
import { cn } from "@/lib/utils";
import type { QueueRowView } from "./row-view";

const btnBase =
  "relative z-10 inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50 sm:h-9";
const actionBtn = cn(btnBase, "border-border bg-surface text-foreground hover:bg-surface-muted");
const primaryBtn = cn(btnBase, "border-foreground bg-foreground text-white hover:bg-black/85");
/** icon-only on phones (keeps the action row on one line), labelled from sm up */
const logBtn =
  "relative z-10 ml-auto inline-flex h-10 w-10 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface text-sm font-medium text-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 sm:h-9 sm:w-auto sm:px-3";

/**
 * One Today row. Tapping the name opens the contact (the link covers the card); Call / WhatsApp, Log and the
 * Done / Snooze / Dismiss buttons sit above it. The row hides at once and comes back with the error if the
 * server says no.
 */
export function QueueRowCard({
  row,
  returnTo = "/today",
  canAnswerTransfer = false,
  rank,
}: {
  row: QueueRowView;
  returnTo?: string;
  canAnswerTransfer?: boolean;
  /** 1-based position in the ranked list */
  rank?: number;
}) {
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snoozing, setSnoozing] = useState(false);
  const [pending, start] = useTransition();
  const c = row.contact;

  function run(fields: Record<string, string>, kind: "task" | "transfer" = "task") {
    const fd = new FormData();
    if (kind === "transfer") fd.set("taskId", row.transferTaskId ?? "");
    else for (const id of row.taskIds) fd.append("taskId", id);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    setError(null);
    setHidden(true);
    start(async () => {
      let r: ActionResult;
      try {
        r = kind === "transfer" ? await transferDecisionAction(null, fd) : await queueTaskAction(null, fd);
      } catch {
        r = { ok: false, error: "Could not reach the server. Check your connection and try again." };
      }
      if (!r?.ok) {
        setHidden(false);
        setSnoozing(false);
        setError(r?.error ?? "Something went wrong");
      }
    });
  }

  if (hidden && !error) {
    return (
      <li className="sr-only" aria-live="polite">
        {pending ? "Saving…" : "Saved"}
      </li>
    );
  }

  const tone = row.band === "abandoned" ? "danger" : row.band === "overdue" ? "warning" : "neutral";
  const name = c?.name ?? "No contact";
  const href = c ? `/contacts/${c.id}` : null;
  const logHref = c ? `/contacts/${c.id}/log?return=${encodeURIComponent(returnTo)}` : null;

  return (
    <li
      className={cn(
        "relative rounded-xl border bg-surface p-3 transition-shadow focus-within:shadow-sm hover:shadow-sm sm:p-4",
        row.band === "abandoned" ? "border-danger/40" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <GradeBadge grade={c?.grade} size="md" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {rank !== undefined && <span className="tabular text-xs text-muted">{rank}.</span>}
            {href ? (
              <Link
                href={href}
                className="truncate text-base font-semibold leading-tight outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                {name}
              </Link>
            ) : (
              <span className="truncate text-base font-semibold leading-tight">{name}</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={tone}>{row.typeLabel}</Badge>
            {row.extraTypeLabels.map((l) => (
              <Badge key={l}>{l}</Badge>
            ))}
            {c && <StageBadge stage={c.stage} />}
            {row.pool && <Badge tone="info">Pool</Badge>}
          </div>
        </div>
        {c && <ContactQuickActions contact={c} variant="row" className="relative z-10 shrink-0" />}
      </div>

      <div className="mt-2.5 space-y-1 sm:pl-11">
        <p className="text-sm font-medium leading-snug">{row.reason}</p>
        {row.context.length > 0 && <p className="text-xs leading-relaxed text-muted">{row.context.join(" · ")}</p>}
        {row.alsoReasons.map((r) => (
          <p key={r} className="text-xs leading-relaxed text-muted">
            Also: {r}
          </p>
        ))}
        {c?.nextOffer && (
          <p className="text-xs leading-relaxed">
            <span className="text-muted">Next offer: </span>
            <span className="font-medium">{c.nextOffer}</span>
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="relative z-10 mt-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger sm:ml-11">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 sm:pl-11">
        {snoozing ? (
          <div className="relative z-10 flex flex-wrap items-center gap-2" role="group" aria-label="Snooze until">
            <span className="text-sm text-muted">Snooze until</span>
            {SNOOZE_OPTIONS.map((o, i) => (
              <button
                key={o.key}
                type="button"
                // keep keyboard focus in the row when the choices replace the Snooze button
                autoFocus={i === 0}
                className={actionBtn}
                disabled={pending}
                onClick={() => run({ action: "snooze", snooze: o.key })}
              >
                {o.label}
              </button>
            ))}
            <button
              type="button"
              className={cn(btnBase, "border-transparent bg-transparent text-muted hover:text-foreground")}
              onClick={() => setSnoozing(false)}
            >
              Cancel
            </button>
          </div>
        ) : row.taskIds.length === 0 ? (
          // a derived new-lead row: there is no task to complete; logging the first touch clears it
          logHref && (
            <>
              <Link href={logHref} className={primaryBtn} aria-label={`Log an interaction with ${name}`}>
                <NotebookPen className="h-4 w-4" aria-hidden /> Log
              </Link>
              <span className="text-xs text-muted">Log your first call or message to clear it</span>
            </>
          )
        ) : (
          <>
            {row.transferTaskId && canAnswerTransfer ? (
              <>
                <button
                  type="button"
                  className={primaryBtn}
                  disabled={pending}
                  onClick={() => run({ decision: "approve" }, "transfer")}
                >
                  <ThumbsUp className="hidden h-4 w-4 sm:block" aria-hidden /> Approve
                </button>
                <button
                  type="button"
                  className={actionBtn}
                  disabled={pending}
                  onClick={() => run({ decision: "decline" }, "transfer")}
                >
                  <ThumbsDown className="hidden h-4 w-4 sm:block" aria-hidden /> Decline
                </button>
              </>
            ) : (
              <button
                type="button"
                className={primaryBtn}
                disabled={pending}
                onClick={() => run({ action: "done" })}
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                Done
              </button>
            )}
            <button
              type="button"
              className={actionBtn}
              disabled={pending}
              aria-haspopup="true"
              onClick={() => setSnoozing(true)}
            >
              <AlarmClock className="hidden h-4 w-4 sm:block" aria-hidden /> Snooze
            </button>
            {row.canDismiss && (
              <button type="button" className={actionBtn} disabled={pending} onClick={() => run({ action: "dismiss" })}>
                <X className="hidden h-4 w-4 sm:block" aria-hidden /> Dismiss
              </button>
            )}
            {logHref && (
              <Link
                href={logHref}
                className={logBtn}
                aria-label={`Log an interaction with ${name}`}
                title="Log interaction"
              >
                <NotebookPen className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">Log</span>
              </Link>
            )}
          </>
        )}
      </div>
    </li>
  );
}
