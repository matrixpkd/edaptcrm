"use client";
import Link from "next/link";
import { startTransition, useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Field, FormMessage, Input, Select, Textarea, type Option } from "@/components/ui/form";
import { ChipGroup } from "@/components/ui/chips";
import { updateProfileAction } from "./actions";

export type EditValues = {
  name: string;
  phone: string;
  email: string;
  type: "individual" | "business";
  organisationId: string;
  companyName: string;
  designation: string;
  city: string;
  state: string;
  country: string;
  language: string;
  ageBand: string;
  industry: string;
  salesNotes: string;
  consent: "yes" | "no" | "";
  tags: string[];
  firstDoor: string;
};

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4 sm:p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function EditContactForm({
  contactId,
  values,
  organisations,
  countries,
  languages,
  ageBands,
  industries,
  tags,
  firstDoors,
  places,
}: {
  contactId: string;
  values: EditValues;
  organisations: Option[];
  countries: Option[];
  languages: Option[];
  ageBands: Option[];
  industries: Option[];
  tags: Option[];
  /** admin only: the first door can be corrected */
  firstDoors: Option[] | null;
  /** city and state suggestions (search dropdowns; free text still allowed) */
  places: { cities: string[]; states: string[] };
}) {
  const [state, dispatch, pending] = useActionState(updateProfileAction, null);
  const fe = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        // dispatching by hand keeps what was typed when the server sends back an error
        startTransition(() => dispatch(fd));
      }}
    >
      <input type="hidden" name="contactId" value={contactId} />
      <Section title="Contact">
        <Field label="Name" htmlFor="ed-name" required error={fe.name} className="sm:col-span-2">
          <Input
            id="ed-name"
            name="name"
            defaultValue={values.name}
            required
            autoComplete="off"
            aria-invalid={!!fe.name}
          />
        </Field>
        <Field
          label="Phone"
          htmlFor="ed-phone"
          required
          error={fe.phone}
          hint="The identity key. Alternates are below."
        >
          <Input
            id="ed-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            defaultValue={values.phone}
            required
            aria-invalid={!!fe.phone}
          />
        </Field>
        <Field label="Email" htmlFor="ed-email" error={fe.email}>
          <Input
            id="ed-email"
            name="email"
            type="email"
            inputMode="email"
            defaultValue={values.email}
            aria-invalid={!!fe.email}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" id="ed-type">
            Contact type
          </span>
          <div role="group" aria-labelledby="ed-type">
            <ChipGroup
              name="type"
              defaultValue={values.type}
              allowDeselect={false}
              options={[
                { value: "individual", label: "Individual" },
                { value: "business", label: "Business" },
              ]}
            />
          </div>
        </div>
        <Field
          label="Organisation"
          htmlFor="ed-org"
          error={fe.organisationId}
          hint={
            <>
              For B2B. Not listed?{" "}
              <Link href="/organisations?new=1" className="underline">
                Add an organisation
              </Link>
            </>
          }
        >
          <Select
            id="ed-org"
            name="organisationId"
            defaultValue={values.organisationId}
            placeholder="None"
            options={organisations}
          />
        </Field>
        <Field label="Company name" htmlFor="ed-company">
          <Input id="ed-company" name="companyName" defaultValue={values.companyName} />
        </Field>
        <Field label="Designation" htmlFor="ed-designation">
          <Input id="ed-designation" name="designation" defaultValue={values.designation} />
        </Field>
      </Section>

      <Section title="Location and language">
        <Field label="City" htmlFor="ed-city">
          <Input id="ed-city" name="city" defaultValue={values.city} autoCapitalize="words" list="ed-city-list" autoComplete="off" />
          <datalist id="ed-city-list">
            {places.cities.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="State" htmlFor="ed-state">
          <Input id="ed-state" name="state" defaultValue={values.state} autoCapitalize="words" list="ed-state-list" autoComplete="off" />
          <datalist id="ed-state-list">
            {places.states.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </Field>
        <Field label="Country" htmlFor="ed-country" error={fe.country}>
          <Select
            id="ed-country"
            name="country"
            defaultValue={values.country}
            placeholder="Not known"
            options={countries}
          />
        </Field>
        <Field label="Preferred language" htmlFor="ed-language" error={fe.language}>
          <Select
            id="ed-language"
            name="language"
            defaultValue={values.language}
            placeholder="Not known"
            options={languages}
          />
        </Field>
      </Section>

      <Section
        title="Profile"
        description="AI knowledge, Umer familiarity, spending power and gut rating are set on the Rate screen."
      >
        <Field label="Age band" htmlFor="ed-age" error={fe.ageBand}>
          <Select id="ed-age" name="ageBand" defaultValue={values.ageBand} placeholder="Not known" options={ageBands} />
        </Field>
        <Field label="Industry or role" htmlFor="ed-industry" error={fe.industry}>
          <Select
            id="ed-industry"
            name="industry"
            defaultValue={values.industry}
            placeholder="Not known"
            options={industries}
          />
        </Field>
        <Field label="Sales notes" htmlFor="ed-notes" className="sm:col-span-2" hint="Anything the scales miss.">
          <Textarea id="ed-notes" name="salesNotes" rows={4} defaultValue={values.salesNotes} />
        </Field>
      </Section>

      <Section title="Labels and consent">
        {firstDoors && (
          <Field
            label="First door"
            htmlFor="ed-door"
            error={fe.firstDoor}
            hint="Stored forever. Only an admin corrects it."
          >
            <Select id="ed-door" name="firstDoor" defaultValue={values.firstDoor} options={firstDoors} />
          </Field>
        )}
        <Field label="Marketing consent" htmlFor="ed-consent">
          <Select id="ed-consent" name="consent" defaultValue={values.consent}>
            <option value="">Not asked</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </Field>
        {tags.length > 0 && (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium" id="ed-tags">
              Tags
            </span>
            <div role="group" aria-labelledby="ed-tags">
              <ChipGroup name="tags" options={tags} defaultValue={values.tags} multiple />
            </div>
          </div>
        )}
      </Section>

      {state && !state.ok && <FormMessage state={state} />}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Link href={`/contacts/${contactId}?tab=details`} className={buttonClass("ghost", "lg")}>
          Cancel
        </Link>
        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending ? "Saving…" : "Save details"}
        </Button>
      </div>
    </form>
  );
}
