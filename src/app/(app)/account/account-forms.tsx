"use client";
import { useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { Field, Input, Select } from "@/components/ui/form";
import { FieldError, FormSubmit, SettingsForm } from "../settings/_components/settings-form";
import { changePasswordAction, signOutOthersAction, timezoneAction } from "./actions";

/** Current password, new password twice. Cleared after a successful change. */
export function PasswordForm({ minLength }: { minLength: number }) {
  const [round, setRound] = useState(0);
  return (
    <SettingsForm action={changePasswordAction} inlineFieldErrors onSuccess={() => setRound((n) => n + 1)} aria-label="Change password">
      <div key={round} className="grid max-w-md gap-4">
        <Field label="Current password" htmlFor="pw-current">
          <Input id="pw-current" name="current" type="password" autoComplete="current-password" required aria-describedby="pw-current-error" />
          <FieldError field="current" id="pw-current-error" />
        </Field>
        <Field label="New password" htmlFor="pw-next" hint={`At least ${minLength} characters. A short sentence is easy to remember.`}>
          <Input id="pw-next" name="next" type="password" autoComplete="new-password" minLength={minLength} required aria-describedby="pw-next-error" />
          <FieldError field="next" id="pw-next-error" />
        </Field>
        <Field label="New password again" htmlFor="pw-confirm">
          <Input id="pw-confirm" name="confirm" type="password" autoComplete="new-password" minLength={minLength} required aria-describedby="pw-confirm-error" />
          <FieldError field="confirm" id="pw-confirm-error" />
        </Field>
        <div>
          <FormSubmit pendingText="Changing…">
            <KeyRound className="h-4 w-4" aria-hidden /> Change password
          </FormSubmit>
        </div>
      </div>
    </SettingsForm>
  );
}

/** The person's own time zone (dates, Today and the 8:30 digest follow it). */
export function TimezoneForm({ value, options }: { value: string; options: { value: string; label: string }[] }) {
  return (
    <SettingsForm action={timezoneAction} inlineFieldErrors aria-label="Time zone">
      <div className="flex max-w-md flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Time zone" htmlFor="acc-tz" className="flex-1">
          <Select id="acc-tz" name="timezone" defaultValue={value} options={options} aria-describedby="acc-tz-error" />
          <FieldError field="timezone" id="acc-tz-error" />
        </Field>
        <FormSubmit variant="outline" pendingText="Saving…">
          Save
        </FormSubmit>
      </div>
    </SettingsForm>
  );
}

/** Ends every other session of this person (a lost phone, a shared laptop). */
export function SignOutOthersForm({ others }: { others: number }) {
  return (
    <SettingsForm
      action={signOutOthersAction}
      confirm={`Sign out of ${others} other session${others === 1 ? "" : "s"}? This browser stays signed in.`}
      aria-label="Sign out other sessions"
    >
      <FormSubmit variant="outline" pendingText="Signing out…" disabled={others === 0}>
        <LogOut className="h-4 w-4" aria-hidden /> Sign out other sessions
      </FormSubmit>
    </SettingsForm>
  );
}
