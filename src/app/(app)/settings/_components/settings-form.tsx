"use client";
import { createContext, startTransition, useActionState, useContext, useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action";

type FormAction<T> = (prev: ActionResult<T>, fd: FormData) => Promise<ActionResult<T>>;

const Ctx = createContext<{ pending: boolean; state: ActionResult }>({ pending: false, state: null });

/**
 * A Settings form bound to a server action. Unlike a plain `<form action>`, it does not clear what was typed when
 * the server refuses the values, so a validation message never costs the admin their edits.
 * Use FormSubmit for its buttons and useSettingsForm() for field errors.
 */
export function SettingsForm<T = unknown>({
  action,
  children,
  className,
  confirm,
  onSuccess,
  messageClassName = "mt-3",
  inlineFieldErrors = false,
  "aria-label": ariaLabel,
}: {
  action: FormAction<T>;
  children: React.ReactNode;
  className?: string;
  /** asks before submitting */
  confirm?: string;
  onSuccess?: (state: ActionResult<T>) => void;
  messageClassName?: string;
  /** every field error is shown next to its field (FieldError), so a field error is not repeated under the form */
  inlineFieldErrors?: boolean;
  "aria-label"?: string;
}) {
  const [state, dispatch, pending] = useActionState<ActionResult<T>, FormData>(action, null);
  const seen = useRef<ActionResult<T>>(null);
  useEffect(() => {
    if (state && state !== seen.current) {
      seen.current = state;
      if (state.ok) onSuccess?.(state);
    }
  }, [state, onSuccess]);
  return (
    <form
      className={className}
      aria-label={ariaLabel}
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        if (confirm && !window.confirm(confirm)) return;
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
        const fd = new FormData(e.currentTarget, submitter);
        startTransition(() => dispatch(fd));
      }}
    >
      <Ctx.Provider value={{ pending, state: state as ActionResult }}>{children}</Ctx.Provider>
      {state && (state.ok ? !!state.message : !(inlineFieldErrors && state.fieldErrors && Object.keys(state.fieldErrors).length)) && (
        <div className={messageClassName}>
          <FormMessage state={state} />
        </div>
      )}
    </form>
  );
}

/** The enclosing SettingsForm's pending flag and last result. */
export function useSettingsForm() {
  return useContext(Ctx);
}

/** The error for one field from the last result, if any. */
export function useFieldError(field: string): string | undefined {
  const { state } = useContext(Ctx);
  return state && !state.ok ? state.fieldErrors?.[field] : undefined;
}

/** A submit button that shows a spinner while its SettingsForm is saving. */
export function FormSubmit({ children, pendingText, disabled, ...props }: ButtonProps & { pendingText?: string }) {
  const { pending } = useContext(Ctx);
  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={pending} {...props}>
      {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {pending && pendingText ? pendingText : children}
    </Button>
  );
}

/** Shows the field's server error under a control (place it inside a Field's children or after it). */
export function FieldError({ field, id }: { field: string; id?: string }) {
  const error = useFieldError(field);
  if (!error) return null;
  return (
    <p id={id} className="text-xs text-danger">
      {error}
    </p>
  );
}
