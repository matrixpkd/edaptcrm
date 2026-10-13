"use client";
import { useActionState } from "react";
import type { ActionResult } from "@/lib/action";
import { FormMessage } from "@/components/ui/form";
import { cn } from "@/lib/utils";

type FormAction = (prev: ActionResult, fd: FormData) => Promise<ActionResult>;

/**
 * A form bound to a server action through useActionState, with the action's message under it
 * (announced to screen readers). `confirm` asks before submitting.
 */
export function ImportActionForm({
  action,
  children,
  className,
  confirm,
  messageClassName,
  errorsOnly = false,
  "aria-label": ariaLabel,
}: {
  action: FormAction;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  messageClassName?: string;
  /** show only failures (the page itself shows the change) */
  errorsOnly?: boolean;
  "aria-label"?: string;
}) {
  const [result, formAction] = useActionState(action, null);
  const state = errorsOnly && result?.ok ? null : result;
  return (
    <form
      action={formAction}
      className={className}
      aria-label={ariaLabel}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state && (
        <div className={cn("mt-2", messageClassName)} aria-live="polite">
          <FormMessage state={state} />
        </div>
      )}
    </form>
  );
}
