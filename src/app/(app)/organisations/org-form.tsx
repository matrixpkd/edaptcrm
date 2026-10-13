"use client";
import Link from "next/link";
import { startTransition, useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Field, FormMessage, Input, Select, Textarea, type Option } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action";

export type OrgFormValues = {
  id?: string;
  name: string;
  kind: string;
  city: string;
  state: string;
  country: string;
  phone: string;
  notes: string;
};

/** Create or edit an organisation. Values typed stay put when the server sends back an error. */
export function OrganisationForm({
  action,
  values,
  kinds,
  countries,
  submitLabel,
  cancelHref,
}: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  values: OrgFormValues;
  kinds: Option[];
  countries: Option[];
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, dispatch, pending] = useActionState(action, null);
  const fe = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => dispatch(fd));
      }}
    >
      {values.id && <input type="hidden" name="id" value={values.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="org-name" required error={fe.name} className="sm:col-span-2">
          <Input
            id="org-name"
            name="name"
            defaultValue={values.name}
            required
            autoComplete="off"
            aria-invalid={!!fe.name}
          />
        </Field>
        <Field label="Kind" htmlFor="org-kind" error={fe.kind}>
          <Select id="org-kind" name="kind" defaultValue={values.kind || "company"} options={kinds} />
        </Field>
        <Field label="Phone" htmlFor="org-phone" error={fe.phone}>
          <Input
            id="org-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            defaultValue={values.phone}
            aria-invalid={!!fe.phone}
          />
        </Field>
        <Field label="City" htmlFor="org-city">
          <Input id="org-city" name="city" defaultValue={values.city} autoCapitalize="words" />
        </Field>
        <Field label="State" htmlFor="org-state">
          <Input id="org-state" name="state" defaultValue={values.state} autoCapitalize="words" />
        </Field>
        <Field label="Country" htmlFor="org-country" error={fe.country}>
          <Select
            id="org-country"
            name="country"
            defaultValue={values.country}
            placeholder="Not known"
            options={countries}
          />
        </Field>
        <Field label="Notes" htmlFor="org-notes" className="sm:col-span-2">
          <Textarea id="org-notes" name="notes" rows={3} defaultValue={values.notes} />
        </Field>
      </div>
      {state && !state.ok && <FormMessage state={state} />}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Link href={cancelHref} className={buttonClass("ghost", "md")}>
          Cancel
        </Link>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
