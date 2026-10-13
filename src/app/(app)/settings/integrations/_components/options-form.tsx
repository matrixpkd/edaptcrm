"use client";
import { useActionState, useId, useState } from "react";
import { Field, FormMessage, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/lib/action";
import type { IntegrationOptions } from "@/lib/webhooks/config";

type Action = (prev: ActionResult, fd: FormData) => Promise<ActionResult>;

/** Where Edapt's tools run: India, the Gulf, and UTC for tools that write UTC without saying so. */
const TIME_ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Riyadh", "Asia/Qatar", "Asia/Muscat", "Asia/Kuwait", "Asia/Bahrain", "UTC"];

/** The integration options. Controlled, so a rejected save keeps what was typed. */
export function OptionsForm({
  action,
  initial,
  families,
  currencies,
}: {
  action: Action;
  initial: IntegrationOptions;
  families: { value: string; label: string }[];
  currencies: string[];
}) {
  const id = useId();
  const [v, setV] = useState(initial);
  const [state, formAction] = useActionState(action, null);
  const err = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const zoneOptions = [...new Set([...TIME_ZONES, v.timeZone].filter(Boolean))].map((z) => ({ value: z, label: z }));
  const set = (k: keyof IntegrationOptions) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }));

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Default country"
          htmlFor={`${id}-country`}
          hint="For numbers written without a country code."
          error={err.defaultCountry}
        >
          <Input
            id={`${id}-country`}
            name="defaultCountry"
            value={v.defaultCountry}
            onChange={set("defaultCountry")}
            maxLength={2}
            autoCapitalize="characters"
            className="uppercase"
            aria-invalid={err.defaultCountry ? true : undefined}
          />
        </Field>
        <Field
          label="Default currency for TagMango"
          htmlFor={`${id}-currency`}
          hint="Used when an order does not say its currency."
          error={err.defaultCurrency}
        >
          <Select
            id={`${id}-currency`}
            name="defaultCurrency"
            value={v.defaultCurrency}
            onChange={set("defaultCurrency")}
            options={currencies.map((c) => ({ value: c, label: c }))}
            aria-invalid={err.defaultCurrency ? true : undefined}
          />
        </Field>
        <Field
          label="Family for products not in the catalogue"
          htmlFor={`${id}-family`}
          hint="A TagMango product we cannot match is recorded in this family, with a note to map it."
          error={err.tagmangoDefaultFamily}
        >
          <Select
            id={`${id}-family`}
            name="tagmangoDefaultFamily"
            value={v.tagmangoDefaultFamily}
            onChange={set("tagmangoDefaultFamily")}
            options={families}
            aria-invalid={err.tagmangoDefaultFamily ? true : undefined}
          />
        </Field>
        <Field
          label="WhatsApp conversation window (hours)"
          htmlFor={`${id}-window`}
          hint="A message after this much silence is a new enquiry; inside it, a reply on the timeline."
          error={err.libromiWindowHours}
        >
          <Input
            id={`${id}-window`}
            name="libromiWindowHours"
            type="number"
            inputMode="numeric"
            min={1}
            max={168}
            value={String(v.libromiWindowHours)}
            onChange={set("libromiWindowHours")}
            aria-invalid={err.libromiWindowHours ? true : undefined}
          />
        </Field>
        <Field
          label="Time zone of payload times"
          htmlFor={`${id}-tz`}
          hint="For order and lead times sent without a zone (TagMango writes India time). Exact times are never shifted."
          error={err.timeZone}
        >
          <Select
            id={`${id}-tz`}
            name="timeZone"
            value={v.timeZone}
            onChange={set("timeZone")}
            options={zoneOptions}
            aria-invalid={err.timeZone ? true : undefined}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText="Saving…">Save options</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
