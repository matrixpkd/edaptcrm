"use client";
import { useState } from "react";
import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { Field, Input, Select, type Option } from "@/components/ui/form";
import { FormSubmit, SettingsForm, useFieldError } from "../../_components/settings-form";
import { TempPassword } from "../../_components/temp-password";
import { createUserAction } from "../actions";

type Created = { id: string; name: string; tempPassword: string };
type Props = {
  roles: Option[];
  roleHelp: Record<string, string>;
  teams: (Option & { timezone: string })[];
  zones: Option[];
};

export function NewUserForm(props: Props) {
  const [created, setCreated] = useState<Created | null>(null);
  if (created) {
    return (
      <div className="flex flex-col gap-4">
        <TempPassword password={created.tempPassword} who={created.name} />
        <div className="flex flex-wrap gap-2">
          <Link href={`/settings/users/${created.id}`} className={buttonClass("primary")}>
            Open {created.name}
          </Link>
          <Link href="/settings/users" className={buttonClass("outline")}>
            Back to users
          </Link>
          {/* a fresh form; the password above is gone for good */}
          <button type="button" className={buttonClass("ghost")} onClick={() => setCreated(null)}>
            Add another
          </button>
        </div>
      </div>
    );
  }
  return (
    <SettingsForm<Created>
      action={createUserAction}
      aria-label="New user" inlineFieldErrors
      onSuccess={(s) => {
        if (s?.ok && s.data) setCreated(s.data);
      }}
    >
      <Fields {...props} />
    </SettingsForm>
  );
}

function Fields({ roles, roleHelp, teams, zones }: Props) {
  const [role, setRole] = useState("sales");
  const [team, setTeam] = useState(teams[0]?.value ?? "");
  const [zone, setZone] = useState(teams[0]?.timezone ?? "Asia/Kolkata");
  const err = {
    name: useFieldError("name"),
    email: useFieldError("email"),
    role: useFieldError("role"),
    team: useFieldError("team"),
    timezone: useFieldError("timezone"),
    phone: useFieldError("phone"),
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" htmlFor="name" required error={err.name}>
        <Input id="name" name="name" required autoComplete="off" maxLength={100} aria-invalid={!!err.name} />
      </Field>
      <Field label="Email" htmlFor="email" required error={err.email} hint="They sign in with this.">
        <Input id="email" name="email" type="email" required autoComplete="off" aria-invalid={!!err.email} />
      </Field>
      <Field label="Role" htmlFor="role" required error={err.role} hint={roleHelp[role]}>
        <Select id="role" name="role" options={roles} value={role} onChange={(e) => setRole(e.target.value)} />
      </Field>
      <Field label="Team" htmlFor="team" error={err.team} hint="Salespeople get new leads of their team.">
        <Select
          id="team"
          name="team"
          value={team}
          onChange={(e) => {
            setTeam(e.target.value);
            const z = teams.find((t) => t.value === e.target.value)?.timezone;
            if (z) setZone(z);
          }}
          placeholder="No team"
          options={teams}
        />
      </Field>
      <Field label="Time zone" htmlFor="timezone" error={err.timezone} hint="Dates and the daily digest use it.">
        <Select id="timezone" name="timezone" value={zone} onChange={(e) => setZone(e.target.value)} options={zones} />
      </Field>
      <Field label="Phone" htmlFor="phone" error={err.phone} hint="Optional. Their work mobile.">
        <Input id="phone" name="phone" type="tel" autoComplete="off" inputMode="tel" aria-invalid={!!err.phone} />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <FormSubmit pendingText="Adding…">Add user</FormSubmit>
        <p className="text-xs text-muted">A strong temporary password is created and shown once.</p>
      </div>
    </div>
  );
}
