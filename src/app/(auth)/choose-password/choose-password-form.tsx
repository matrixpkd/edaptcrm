"use client";
import { useActionState } from "react";
import { choosePasswordAction } from "../actions";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";

/** Phone-first: big fields (16px text, so phones do not zoom in) and a full-width button. */
export function ChoosePasswordForm({ email, minLength }: { email: string; minLength: number }) {
  const [state, action] = useActionState(choosePasswordAction, null);
  const err = (f: string) => (state && !state.ok ? state.fieldErrors?.[f] : undefined);
  return (
    <form action={action} className="space-y-4" aria-label="Choose your password">
      {/* lets a password manager save the new password under the right account */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <Field label="New password" htmlFor="next" hint={`At least ${minLength} characters. A short sentence is easy to remember.`} error={err("next")}>
        <Input
          id="next"
          name="next"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          maxLength={200}
          required
          autoFocus
          className="h-12 text-base"
          aria-invalid={!!err("next")}
        />
      </Field>
      <Field label="New password again" htmlFor="confirm" error={err("confirm")}>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          maxLength={200}
          required
          className="h-12 text-base"
          aria-invalid={!!err("confirm")}
        />
      </Field>
      {state && !state.ok && !state.fieldErrors && <FormMessage state={state} />}
      <SubmitButton className="w-full" size="lg" pendingText="Saving…">
        Save and continue
      </SubmitButton>
    </form>
  );
}
