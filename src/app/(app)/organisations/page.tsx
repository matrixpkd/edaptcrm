import Link from "next/link";
import { Building2, Plus, Search } from "lucide-react";
import { ORG_KINDS } from "@/db/schema";
import { Button, ButtonLink, buttonClass } from "@/components/ui/button";
import { Card, CardHeader, CardBody, EmptyState, PageHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { Table, Td, Th } from "@/components/ui/table";
import { countryOptions } from "@/components/contacts/countries";
import { ORG_KIND_LABELS, countryName } from "@/components/contacts/labels";
import { requireUser } from "@/lib/auth/session";
import { canManageOrganisations, listOrganisations } from "@/lib/contacts/queries";
import { formatINR } from "@/lib/utils";
import { createOrganisationAction } from "./actions";
import { OrganisationForm } from "./org-form";
import { isUuid } from "@/lib/utils";

export const metadata = { title: "Organisations" };

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => {
  const v = sp[k];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim().slice(0, 100) : null;
};

const KIND_OPTIONS = ORG_KINDS.map((k) => ({ value: k, label: ORG_KIND_LABELS[k] }));

function href(q: string | null, kind: string | null, page = 1) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (kind) p.set("kind", kind);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `/organisations?${s}` : "/organisations";
}

export default async function OrganisationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = one(sp, "q");
  const kindRaw = one(sp, "kind");
  const kind = kindRaw && (ORG_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : null;
  const page = Math.max(1, Number.parseInt(one(sp, "page") ?? "1", 10) || 1);
  const canManage = canManageOrganisations(user);
  const creating = canManage && one(sp, "new") === "1";
  // "Not listed? Add an organisation" on a contact's Edit page: the new organisation is linked to them
  const forRaw = one(sp, "for");
  const forContactId = forRaw && isUuid(forRaw) ? forRaw : null;
  const result = await listOrganisations({ q, kind, page });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Organisations"
        description="Schools, constituency offices, companies and partners: the B2B accounts and the people who sign for them."
        actions={
          canManage && !creating ? (
            <ButtonLink href="/organisations?new=1">
              <Plus className="h-4 w-4" aria-hidden /> New organisation
            </ButtonLink>
          ) : null
        }
      />

      {creating && (
        <Card>
          <CardHeader
            title="New organisation"
            description={
              forContactId
                ? "Saved and linked to the contact you were editing; you go straight back to them."
                : "Link people from its page once it is saved."
            }
          />
          <CardBody>
            <OrganisationForm
              action={createOrganisationAction}
              values={{ name: "", kind: "company", city: "", state: "", country: "IN", phone: "", notes: "" }}
              kinds={KIND_OPTIONS}
              countries={countryOptions()}
              submitLabel={forContactId ? "Add and link" : "Add organisation"}
              cancelHref={forContactId ? `/contacts/${forContactId}/edit` : "/organisations"}
              forContactId={forContactId}
            />
          </CardBody>
        </Card>
      )}

      <form
        method="get"
        action="/organisations"
        role="search"
        className="flex flex-col gap-2 sm:flex-row"
        aria-label="Search organisations"
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <label htmlFor="org-q" className="sr-only">
            Search by name or city
          </label>
          <Input
            id="org-q"
            name="q"
            type="search"
            defaultValue={q ?? ""}
            placeholder="Search name or city"
            className="pl-9"
          />
        </div>
        <label htmlFor="org-kind-filter" className="sr-only">
          Kind
        </label>
        <Select
          id="org-kind-filter"
          name="kind"
          defaultValue={kind ?? ""}
          className="sm:w-52"
          placeholder="Every kind"
          options={KIND_OPTIONS}
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      <p className="text-sm text-muted">
        {result.total.toLocaleString("en-IN")} organisation{result.total === 1 ? "" : "s"}
      </p>

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<Building2 className="h-6 w-6" />}
            title={q || kind ? "No organisations match" : "No organisations yet"}
            description={
              q || kind ? "Try another name or kind." : "Add schools, constituency offices and companies you sell to."
            }
            action={
              q || kind ? (
                <ButtonLink href="/organisations" variant="outline">
                  Clear search
                </ButtonLink>
              ) : canManage ? (
                <ButtonLink href="/organisations?new=1">New organisation</ButtonLink>
              ) : null
            }
          />
        </div>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {result.rows.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/organisations/${o.id}`}
                  className="block rounded-xl border border-border bg-surface p-3 hover:bg-surface-muted"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate font-semibold">{o.name}</p>
                    <p className="tabular shrink-0 text-sm font-semibold">{formatINR(o.revenueInr)}</p>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {ORG_KIND_LABELS[o.kind]}
                    {o.city ? ` · ${o.city}` : ""}
                    {o.country ? ` · ${countryName(o.country)}` : ""} · {o.people}{" "}
                    {o.people === 1 ? "person" : "people"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-hidden rounded-xl border border-border bg-surface md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Kind</Th>
                  <Th>City</Th>
                  <Th className="text-right">People</Th>
                  <Th className="text-right">Purchases</Th>
                  <Th className="text-right">Revenue</Th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((o) => (
                  <tr key={o.id} className="hover:bg-surface-muted/50">
                    <Td>
                      <Link href={`/organisations/${o.id}`} className="font-medium underline-offset-2 hover:underline">
                        {o.name}
                      </Link>
                    </Td>
                    <Td className="text-sm">{ORG_KIND_LABELS[o.kind]}</Td>
                    <Td className="text-sm">
                      {o.city ?? <span className="text-muted">–</span>}
                      {o.country && <span className="text-muted"> · {o.country}</span>}
                    </Td>
                    <Td className="tabular text-right">{o.people}</Td>
                    <Td className="tabular text-right">{o.purchaseCount}</Td>
                    <Td className="tabular text-right font-medium">{formatINR(o.revenueInr)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}

      {result.pageCount > 1 && (
        <nav className="flex items-center justify-between" aria-label="Pages">
          {result.page > 1 ? (
            <Link href={href(q, kind, result.page - 1)} className={buttonClass("outline", "sm")}>
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted">
            Page {result.page} of {result.pageCount}
          </span>
          {result.page < result.pageCount ? (
            <Link href={href(q, kind, result.page + 1)} className={buttonClass("outline", "sm")}>
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
