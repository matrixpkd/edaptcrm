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
import { canViewContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import {
  canManageOrganisations,
  getOrganisation,
  getOrganisationPeople,
  getOrganisationPurchases,
} from "@/lib/contacts/queries";
import { formatPhone } from "@/lib/phone";
import { formatDate, formatINR } from "@/lib/utils";
import { updateOrganisationAction } from "../actions";
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
  const [{ people, hidden }, purchases] = await Promise.all([
    getOrganisationPeople(user, org.id),
    getOrganisationPurchases(org.id),
  ]);
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
        <Stat label="People" value={people.length + hidden} className="col-span-2 sm:col-span-1" />
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
            hidden > 0 ? `${hidden} more linked, owned by colleagues` : "Linked from each contact's Edit page"
          }
        />
        {people.length === 0 ? (
          <EmptyState title="No people linked" description="Open a contact, choose Edit, and pick this organisation." />
        ) : (
          <ul className="divide-y divide-border">
            {people.map((p) => (
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
                    <span className="tabular">{formatPhone(p.phoneE164)}</span> · {p.ownerName ?? "Pool"}
                  </p>
                </div>
                <div className="hidden sm:block">
                  <StageBadge stage={p.stage} />
                </div>
                <p className="tabular w-24 text-right text-sm font-semibold">{formatINR(p.ltvInr)}</p>
              </li>
            ))}
          </ul>
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
                    {canViewContact(user, { ownerId: p.contactOwnerId }) ? (
                      <Link href={`/contacts/${p.contactId}`} className="underline-offset-2 hover:underline">
                        {p.contactName}
                      </Link>
                    ) : (
                      p.contactName
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
