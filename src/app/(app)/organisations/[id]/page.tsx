import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { Badge, GradeBadge, StageBadge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { FlashBanner } from "@/components/contacts/flash-banner";
import { countryOptions } from "@/components/contacts/countries";
import {
  ORG_KIND_LABELS,
  PURCHASE_STATUS_LABELS,
  PURCHASE_STATUS_TONE,
  countryName,
  formatAmount,
} from "@/components/contacts/labels";
import { ORG_KINDS } from "@/db/schema";
import { requireUser } from "@/lib/auth/session";
import {
  canManageOrganisations,
  getOrganisation,
  getOrganisationPeople,
  getOrganisationPurchases,
  searchContactsForPicker,
} from "@/lib/contacts/queries";
import { formatPhone } from "@/lib/phone";
import { formatDate, formatINR } from "@/lib/utils";
import { linkPersonAction, updateOrganisationAction } from "../actions";
import { ActionForm } from "@/components/contacts/action-form";
import { SubmitButton } from "@/components/ui/submit-button";
import { Input } from "@/components/ui/form";
import { OrganisationForm } from "../org-form";

type SP = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const o = await getOrganisation(id);
  return { title: o?.name ?? "Organisation" };
}

export default async function OrganisationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const org = await getOrganisation(id);
  if (!org) notFound();
  const tz = user.timezone || "Asia/Kolkata";
  const canManage = canManageOrganisations(user);
  const editing = canManage && sp.edit === "1";
  const personQuery = (typeof sp.pq === "string" ? sp.pq : "").trim().slice(0, 100);
  const [{ people, hidden }, purchases, picks] = await Promise.all([
    getOrganisationPeople(user, org.id),
    getOrganisationPurchases(org.id, user),
    canManage && personQuery ? searchContactsForPicker(user, personQuery, { limit: 8 }) : Promise.resolve([]),
  ]);
  const linkedIds = new Set(people.map((p) => p.id));
  const paid = purchases.filter((p) => p.status !== "cancelled");

  return (
    <div className="space-y-5">
      {sp.created === "1" && (
        <FlashBanner param="created" message="Organisation added. Link people to it from their contact's Edit page." />
      )}
      {sp.saved === "1" && <FlashBanner param="saved" message="Saved." />}
      <PageHeader
        title={org.name}
        back={
          <Link href="/organisations" className="hover:underline">
            ← Organisations
          </Link>
        }
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge>{ORG_KIND_LABELS[org.kind]}</Badge>
            {[org.city, org.state, org.country ? countryName(org.country) : null].filter(Boolean).join(", ") ||
              "Location not set"}
            {org.phone && (
              <a href={`tel:${org.phone}`} className="tabular hover:underline">
                {formatPhone(org.phone)}
              </a>
            )}
          </span>
        }
        actions={
          canManage && !editing ? (
            <ButtonLink href={`/organisations/${org.id}?edit=1`} variant="outline">
              <Pencil className="h-4 w-4" aria-hidden /> Edit
            </ButtonLink>
          ) : null
        }
      />

      {editing && (
        <Card>
          <CardHeader title="Edit organisation" />
          <CardBody>
            <OrganisationForm
              action={updateOrganisationAction}
              values={{
                id: org.id,
                name: org.name,
                kind: org.kind,
                city: org.city ?? "",
                state: org.state ?? "",
                country: org.country ?? "",
                phone: org.phone ? formatPhone(org.phone) : "",
                notes: org.notes ?? "",
              }}
              kinds={ORG_KINDS.map((k) => ({ value: k, label: ORG_KIND_LABELS[k] }))}
              countries={countryOptions()}
              submitLabel="Save"
              cancelHref={`/organisations/${org.id}`}
            />
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Total revenue" value={formatINR(org.revenueInr)} hint="Verified payments minus refunds" />
        <Stat label="Purchases" value={paid.length} />
        <Stat label="People" value={people.length} className="col-span-2 sm:col-span-1" />
      </div>

      {org.notes && !editing && (
        <Card>
          <CardBody>
            <p className="whitespace-pre-line text-sm">{org.notes}</p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="People"
          description={
            hidden > 0
              ? `${hidden} owned by colleagues: their LTV counts, their details stay private`
              : canManage
                ? "Find a person below to link them, or pick this organisation on their Edit page"
                : "The people who work here"
          }
        />
        {people.length === 0 ? (
          <EmptyState
            title="No people linked"
            description={
              canManage ? "Search for the principal, MLA or owner below and link them." : "Nobody is linked yet."
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {people.map((p) =>
              p.hidden ? (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <GradeBadge grade={null} size="sm" />
                  <p className="min-w-0 flex-1 truncate text-sm text-muted">{p.name}</p>
                  <p className="tabular w-24 text-right text-sm font-semibold">{formatINR(p.ltvInr)}</p>
                </li>
              ) : (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <GradeBadge grade={p.grade} size="sm" />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/contacts/${p.id}`}
                      className="block truncate text-sm font-medium underline-offset-2 hover:underline"
                    >
                      {p.name}
                    </Link>
                    <p className="truncate text-xs text-muted">
                      {p.designation ? `${p.designation} · ` : ""}
                      {p.phoneE164 && <span className="tabular">{formatPhone(p.phoneE164)}</span>} · {p.ownerName ?? "Pool"}
                    </p>
                  </div>
                  <div className="hidden sm:block">
                    <StageBadge stage={p.stage} />
                  </div>
                  <p className="tabular w-24 text-right text-sm font-semibold">{formatINR(p.ltvInr)}</p>
                  {canManage && (
                    <ActionForm action={linkPersonAction} confirm={`Unlink ${p.name} from ${org.name}?`}>
                      <input type="hidden" name="orgId" value={org.id} />
                      <input type="hidden" name="contactId" value={p.id} />
                      <input type="hidden" name="unlink" value="1" />
                      <SubmitButton variant="ghost" size="sm" pendingText="…" aria-label={`Unlink ${p.name}`}>
                        Unlink
                      </SubmitButton>
                    </ActionForm>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
        {canManage && (
          <div className="border-t border-border px-4 py-4">
            <form method="get" action={`/organisations/${org.id}`} role="search" className="flex gap-2">
              <label htmlFor="org-person-q" className="sr-only">
                Find a person to link
              </label>
              <Input
                id="org-person-q"
                name="pq"
                type="search"
                defaultValue={personQuery}
                placeholder="Link a person: name, phone or email"
                autoComplete="off"
                className="flex-1"
              />
              <SubmitButton variant="outline">Find</SubmitButton>
            </form>
            {personQuery && (
              <ul className="mt-3 divide-y divide-border rounded-lg border border-border" aria-label="People found">
                {picks.length === 0 && (
                  <li className="px-3 py-3 text-sm text-muted">
                    Nobody matches. Add them with{" "}
                    <Link href="/contacts/new" className="font-medium text-foreground underline">
                      Quick Add
                    </Link>{" "}
                    first.
                  </li>
                )}
                {picks.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                    <GradeBadge grade={c.grade} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="tabular truncate text-xs text-muted">
                        {formatPhone(c.phoneE164)}
                        {c.city ? ` · ${c.city}` : ""} · {c.ownerName ?? "Pool"}
                      </p>
                    </div>
                    {linkedIds.has(c.id) ? (
                      <span className="text-xs text-muted">Linked</span>
                    ) : (
                      <ActionForm action={linkPersonAction}>
                        <input type="hidden" name="orgId" value={org.id} />
                        <input type="hidden" name="contactId" value={c.id} />
                        <SubmitButton size="sm" pendingText="Linking…">
                          Link
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Purchases" description="B2B deals linked to this organisation and the person who signed" />
        {purchases.length === 0 ? (
          <EmptyState
            title="No purchases linked"
            description="Choose this organisation when recording a B2B payment."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th className="hidden sm:table-cell">Signed by</Th>
                <Th className="hidden text-right sm:table-cell">Amount</Th>
                <Th className="text-right">Received</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <span className="block font-medium">{p.productName}</span>
                    <span className="text-xs text-muted">{formatDate(p.purchasedAt, tz)}</span>
                  </Td>
                  <Td className="hidden text-sm sm:table-cell">
                    {p.contactHidden ? (
                      <span className="text-muted">{p.contactName}</span>
                    ) : (
                      <Link href={`/contacts/${p.contactId}`} className="underline-offset-2 hover:underline">
                        {p.contactName}
                      </Link>
                    )}
                  </Td>
                  <Td className="tabular hidden text-right sm:table-cell">{formatAmount(p.amount, p.currency)}</Td>
                  <Td className="tabular text-right font-medium">{formatINR(p.netInr)}</Td>
                  <Td>
                    <Badge tone={PURCHASE_STATUS_TONE[p.status]}>{PURCHASE_STATUS_LABELS[p.status]}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
