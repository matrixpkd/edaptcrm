"use client";
import { useActionState } from "react";
import { resetPasswordAction } from "../actions";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";

export function ResetForm({ token, minLength }: { token: string; minLength: number }) {
  const [state, action] = useActionState(resetPasswordAction, null);
  const err = (f: string) => (state && !state.ok ? state.fieldErrors?.[f] : undefined);
  return (
    <form action={action} className="space-y-4" aria-label="Choose a new password">
      <input type="hidden" name="token" value={token} />
      <Field label="New password" htmlFor="next" hint={`At least ${minLength} characters. A short sentence is easy to remember.`} error={err("next")}>
        <Input id="next" name="next" type="password" autoComplete="new-password" minLength={minLength} required autoFocus />
      </Field>
      <Field label="New password again" htmlFor="confirm" error={err("confirm")}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={minLength} required />
      </Field>
      {state && !state.ok && !state.fieldErrors && <FormMessage state={state} />}
      <SubmitButton className="w-full" size="lg" pendingText="Saving…">
        Save new password
      </SubmitButton>
    </form>
  );
}
