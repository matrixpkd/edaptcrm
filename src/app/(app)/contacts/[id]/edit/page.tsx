import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { X } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ActionForm } from "@/components/contacts/action-form";
import { countryOptions } from "@/components/contacts/countries";
import { can, canEditContact, canViewContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { resolveSurvivor } from "@/lib/contacts/internal";
import { getContactHeader, listOrganisationOptions } from "@/lib/contacts/queries";
import { formatPhone } from "@/lib/phone";
import { activeItems, getSettings, type ListItem } from "@/lib/settings";
import { alternateAction, referrerAction } from "./actions";
import { EditContactForm } from "./edit-form";

export const metadata = { title: "Edit contact" };

/** Options from a settings list, keeping a stored value that was since switched off. */
function options(list: ListItem[], current?: string | null) {
  const items = activeItems(list).map((i) => ({ value: i.key, label: i.label }));
  if (current && !items.some((i) => i.value === current)) {
    items.push({ value: current, label: list.find((i) => i.key === current)?.label ?? current });
  }
  return items;
}

export default async function EditContactPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const c = await getContactHeader(id);
  if (!c) notFound();
  if (c.mergedIntoId) {
    const survivor = await resolveSurvivor(c);
    if (survivor && canViewContact(user, survivor)) redirect(`/contacts/${survivor.id}/edit`);
    notFound();
  }
  if (!canViewContact(user, c)) notFound();
  const back = (
    <Link href={`/contacts/${c.id}`} className="hover:underline">
      ← {c.name}
    </Link>
  );
  if (!can(user, "contacts.edit") || !canEditContact(user, c)) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Edit contact" back={back} />
        <EmptyState
          title="You cannot edit this contact"
          description="Support logs interactions and notes; a salesperson edits their own contacts and the pool."
        />
      </div>
    );
  }

  const [s, orgs] = await Promise.all([
    getSettings(["lists.languages", "lists.ageBands", "lists.industries", "lists.tags", "lists.firstDoors"]),
    listOrganisationOptions(),
  ]);
  const tagOptions = options(s["lists.tags"]);
  for (const t of c.tags) if (!tagOptions.some((o) => o.value === t)) tagOptions.push({ value: t, label: t });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Edit contact"
        description="Profile fields. Scores and LTV are calculated and cannot be edited."
        back={back}
      />

      <EditContactForm
        contactId={c.id}
        values={{
          name: c.name,
          phone: formatPhone(c.phoneE164),
          email: c.email ?? "",
          type: c.type,
          organisationId: c.organisationId ?? "",
          companyName: c.companyName ?? "",
          designation: c.designation ?? "",
          city: c.city ?? "",
          state: c.state ?? "",
          country: c.country ?? "",
          language: c.language ?? "",
          ageBand: c.ageBand ?? "",
          industry: c.industry ?? "",
          salesNotes: c.salesNotes ?? "",
          consent: c.consent == null ? "" : c.consent ? "yes" : "no",
          tags: c.tags,
          firstDoor: c.firstDoor,
        }}
        organisations={orgs.map((o) => ({ value: o.id, label: o.city ? `${o.name} (${o.city})` : o.name }))}
        countries={countryOptions()}
        languages={options(s["lists.languages"], c.language)}
        ageBands={options(s["lists.ageBands"], c.ageBand)}
        industries={options(s["lists.industries"], c.industry)}
        tags={tagOptions}
        firstDoors={user.role === "admin" ? options(s["lists.firstDoors"], c.firstDoor) : null}
      />

      <section className="rounded-xl border border-border bg-surface p-4 sm:p-5" aria-labelledby="alt-title">
        <h2 id="alt-title" className="text-sm font-semibold">
          Alternate numbers and emails
        </h2>
        <p className="mt-0.5 text-xs text-muted">They match too: an enquiry from any of them lands on this contact.</p>
        <div className="mt-4 grid gap-6 sm:grid-cols-2">
          <Alternates
            contactId={c.id}
            kind="phone"
            label="Phones"
            values={c.altPhones}
            show={formatPhone}
            input={
              <Input
                name="value"
                type="tel"
                inputMode="tel"
                placeholder="Another number"
                aria-label="Another phone number"
                required
              />
            }
          />
          <Alternates
            contactId={c.id}
            kind="email"
            label="Emails"
            values={c.altEmails}
            show={(v) => v}
            input={
              <Input
                name="value"
                type="email"
                inputMode="email"
                placeholder="Another email"
                aria-label="Another email address"
                required
              />
            }
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4 sm:p-5" aria-labelledby="ref-title">
        <h2 id="ref-title" className="text-sm font-semibold">
          Referred by
        </h2>
        <p className="mt-0.5 text-xs text-muted">Their LTV counts toward the referrer&apos;s network value.</p>
        {c.referrer ? (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-surface-muted px-3 py-2">
            <span className="text-sm font-medium">{c.referrer.name}</span>
            <ActionForm action={referrerAction}>
              <input type="hidden" name="contactId" value={c.id} />
              <input type="hidden" name="clear" value="1" />
              <SubmitButton variant="ghost" size="md" pendingText="Removing…">
                Remove
              </SubmitButton>
            </ActionForm>
          </div>
        ) : null}
        <ActionForm action={referrerAction} className="mt-3">
          <input type="hidden" name="contactId" value={c.id} />
          <label htmlFor="ref-phone" className="text-sm font-medium">
            {c.referrer ? "Change to (phone)" : "Referrer's phone"}
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="ref-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              placeholder="98470 12345"
              required
              className="flex-1"
            />
            <SubmitButton variant="outline" pendingText="Linking…">
              Link
            </SubmitButton>
          </div>
        </ActionForm>
      </section>
    </div>
  );
}

function Alternates({
  contactId,
  kind,
  label,
  values,
  show,
  input,
}: {
  contactId: string;
  kind: "phone" | "email";
  label: string;
  values: string[];
  show: (v: string) => string;
  input: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{label}</h3>
      {values.length === 0 ? (
        <p className="mt-2 text-sm text-muted">None</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {values.map((v) => (
            <li key={v} className="flex items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-1.5">
              <span className="tabular min-w-0 truncate text-sm">{show(v)}</span>
              <ActionForm action={alternateAction}>
                <input type="hidden" name="contactId" value={contactId} />
                <input type="hidden" name="kind" value={kind} />
                <input type="hidden" name="op" value="remove" />
                <input type="hidden" name="value" value={v} />
                <SubmitButton
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10"
                  aria-label={`Remove ${show(v)}`}
                  title="Remove"
                >
                  <X className="h-4 w-4" />
                </SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <ActionForm action={alternateAction} className="mt-2">
        <input type="hidden" name="contactId" value={contactId} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="op" value="add" />
        <div className="flex gap-2">
          <div className="flex-1">{input}</div>
          <SubmitButton variant="outline" pendingText="Adding…">
            Add
          </SubmitButton>
        </div>
      </ActionForm>
    </div>
  );
}
