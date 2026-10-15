"use client";
import { useActionState, useEffect, useRef } from "react";
import type { ActionResult } from "@/lib/action";
import { FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";

type FormAction = (prev: ActionResult, fd: FormData) => Promise<ActionResult>;

type Snapshot = { name: string; value: string; checked: boolean | null }[];

/** The values of every editable named field (hidden inputs and files are left alone). */
function snapshot(form: HTMLFormElement): Snapshot {
  const out: Snapshot = [];
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (!el.name || el.type === "hidden" || el.type === "file" || el.type === "submit") continue;
      const box = el.type === "checkbox" || el.type === "radio";
      out.push({ name: el.name, value: el.value, checked: box ? el.checked : null });
    } else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      if (el.name) out.push({ name: el.name, value: el.value, checked: null });
    }
  }
  return out;
}

/** Puts back what was typed (React resets a form after its action runs, even when the action reports an error). */
function restore(form: HTMLFormElement, snap: Snapshot) {
  const els = Array.from(form.elements);
  let i = 0;
  for (const el of els) {
    if (el instanceof HTMLInputElement) {
      if (!el.name || el.type === "hidden" || el.type === "file" || el.type === "submit") continue;
      const s = snap[i++];
      if (!s || s.name !== el.name) return;
      if (s.checked !== null) el.checked = s.checked;
      else el.value = s.value;
    } else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      if (!el.name) continue;
      const s = snap[i++];
      if (!s || s.name !== el.name) return;
      el.value = s.value;
    }
  }
}

/**
 * A small form bound to a server action through useActionState, showing the action's message under it.
 * Children are usually server-rendered fields plus a SubmitButton. When the action fails, the error shows under the
 * form and the typed values are restored; on success the message shows as a toast and the form is cleared (React's
 * default for form actions).
 */
export function ActionForm({
  action,
  children,
  className,
  onSuccess,
  messageClassName,
  confirm,
  "aria-label": ariaLabel,
}: {
  action: FormAction;
  children: React.ReactNode;
  className?: string;
  onSuccess?: () => void;
  messageClassName?: string;
  /** asks before submitting */
  confirm?: string;
  "aria-label"?: string;
}) {
  // the success toast is raised as soon as the action answers, not in an effect: the form (or the list row holding
  // it) is often gone after the refresh the action triggers, and an unmounted form would never announce anything
  const [state, formAction] = useActionState(async (prev: ActionResult, fd: FormData) => {
    const r = await action(prev, fd);
    if (r?.ok && r.message) toast(r.message);
    return r;
  }, null);
  const seen = useRef<ActionResult>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const typed = useRef<Snapshot | null>(null);
  useEffect(() => {
    if (state && state !== seen.current) {
      seen.current = state;
      if (state.ok) onSuccess?.();
      else if (formRef.current && typed.current) restore(formRef.current, typed.current);
    }
  }, [state, onSuccess]);
  return (
    <form
      ref={formRef}
      action={formAction}
      className={className}
      aria-label={ariaLabel}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) {
          e.preventDefault();
          return;
        }
        typed.current = snapshot(e.currentTarget);
      }}
    >
      {children}
      {state && !state.ok && (
        <div className={messageClassName ?? "mt-2"}>
          <FormMessage state={state} />
        </div>
      )}
    </form>
  );
}
