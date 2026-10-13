"use client";
import { useActionState, useEffect, useRef } from "react";
import type { ActionResult } from "@/lib/action";
import { FormMessage } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";

type JsonAction = (prev: ActionResult, fd: FormData) => Promise<ActionResult>;

/**
 * Saves an editor's state through a server action: the value goes in a hidden "json" field, the action validates
 * it again on the server and answers with an ActionResult shown under the button.
 */
export function JsonSaveForm({
  action,
  value,
  dirty,
  disabled,
  submitLabel = "Save changes",
  pendingText = "Saving…",
  onSaved,
  hidden,
  aside,
  className,
}: {
  action: JsonAction;
  value: unknown;
  /** shows "Unsaved changes" next to the button */
  dirty?: boolean;
  disabled?: boolean;
  submitLabel?: string;
  pendingText?: string;
  onSaved?: () => void;
  /** extra hidden inputs */
  hidden?: Record<string, string>;
  /** extra controls next to the button */
  aside?: React.ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const seen = useRef<ActionResult>(null);
  useEffect(() => {
    if (state && state !== seen.current) {
      seen.current = state;
      if (state.ok) onSaved?.();
    }
  }, [state, onSaved]);
  return (
    <form action={formAction} className={cn("flex flex-col gap-2", className)}>
      <input type="hidden" name="json" value={JSON.stringify(value)} />
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText={pendingText} disabled={disabled}>
          {submitLabel}
        </SubmitButton>
        {aside}
        {dirty && (
          <span className="text-xs font-medium text-warning" role="status">
            Unsaved changes
          </span>
        )}
      </div>
      <FormMessage state={state} />
    </form>
  );
}
