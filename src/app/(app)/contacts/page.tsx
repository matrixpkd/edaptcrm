import Link from "next/link";
import { Download, Search, UserPlus } from "lucide-react";
import { GradeBadge, StageBadge, STAGE_LABELS } from "@/components/ui/badge";
import { ButtonLink, buttonClass } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { Table, Td, Th } from "@/components/ui/table";
import { ContactQuickActions } from "@/components/contacts/quick-actions";
import { countryName } from "@/components/contacts/labels";
import { STAGES } from "@/db/schema";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import {
  GRADES,
  activeFilterCount,
  canShareViews,
  filtersToQuery,
  assigneeOptions,
  countPoolContacts,
  listContactCountries,
  listContacts,
  listOwnerOptions,
  listProductOptions,
  listSavedViews,
  parseContactFilters,
  parsePage,
  type ContactFilters,
  type ContactListRow,
} from "@/lib/contacts/queries";
import { UNRATED_LABEL } from "@/lib/contacts/rules";
import { formatPhone } from "@/lib/phone";
import { activeItems, getSettings, labelFor } from "@/lib/settings";
import { cn, formatINR, formatRelative } from "@/lib/utils";
import { BULK_FORM_ID } from "./_components/bulk-form";
import { BulkReassignBar } from "./_components/bulk-reassign";
import { FilterForm } from "./_components/filter-form";
import { OwnerCell } from "./_components/owner-cell";
import { SavedViews } from "./_components/saved-views";

export const metadata = { title: "Contacts" };

type SP = Record<string, string | string[] | undefined>;

/** The default sort (Edapt Score) has an empty value so it never clutters the URL. */
const SORT_OPTIONS = [
  { value: "", label: "Edapt Score" },
  { value: "ltv", label: "LTV" },
  { value: "activity", label: "Last activity" },
  { value: "created", label: "Newest" },
  { value: "name", label: "Name" },
];

function FilterSelect({
  label,
  name,
  value,
  options,
  all = "Any",
}: {
  label: string;
  name: string;
  value: string | null | undefined;
  options: { value: string; label: string }[];
  all?: string;
}) {
  const id = `f-${name}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      <Select
        id={id}
        name={name}
        defaultValue={value ?? ""}
        className={cn("h-9", value && "border-foreground font-medium")}
      >
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

function pageHref(query: string, page: number) {
  const p = new URLSearchParams(query);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `/contacts?${s}` : "/contacts";
}

export default async function ContactsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filters: ContactFilters = parseContactFilters(sp);
  const page = parsePage(sp);
  const query = filtersToQuery(filters);
  const viewAll = can(user, "contacts.viewAll");
  const canReassign = can(user, "contacts.reassign");
  const tz = user.timezone || "Asia/Kolkata";

  const [result, settings, views, countries, owners, assignable, productOptions, poolCount] = await Promise.all([
    listContacts(user, filters, { page }),
    getSettings([
      "lists.channels",
      "lists.firstDoors",
      "lists.campaigns",
      "lists.languages",
      "lists.tags",
      "ladder.families",
    ]),
    listSavedViews(user),
    listContactCountries(user),
    viewAll ? listOwnerOptions() : Promise.resolve([]),
    canReassign ? assigneeOptions() : Promise.resolve([]),
    listProductOptions(),
    countPoolContacts(user),
  ]);
  const people = assignable.map(({ value, label }) => ({ value, label }));
  const ownerMode = canReassign ? "assign" : can(user, "contacts.requestTransfer") ? "request" : null;
  const opt = (key: "lists.channels" | "lists.firstDoors" | "lists.campaigns" | "lists.languages" | "lists.tags") =>
    activeItems(settings[key]).map((i) => ({ value: i.key, label: i.label }));
  const doors = settings["lists.firstDoors"];
  const activeCount = activeFilterCount(filters);
  const ownerOptions = [
    ...(user.role !== "support" ? [{ value: "mine", label: "Mine" }] : []),
    { value: "pool", label: "Pool (no owner)" },
    ...owners
      .filter((o) => o.id !== user.id)
      .map((o) => ({ value: o.id, label: o.active ? o.name : `${o.name} (inactive)` })),
  ];
  const first = (result.page - 1) * result.pageSize + 1;
  const last = first + result.rows.length - 1;
  const sortLabel =
    SORT_OPTIONS.find((s) => s.value === (filters.sort === "score" ? "" : filters.sort))?.label ?? "Edapt Score";

  const search = (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <label htmlFor="contacts-q" className="sr-only">
        Search by name, phone or email
      </label>
      <Input
        id="contacts-q"
        name="q"
        type="search"
        defaultValue={filters.q ?? ""}
        placeholder="Name, phone or email"
        autoComplete="off"
        enterKeyHint="search"
        className="pl-9"
      />
    </div>
  );

  const filterFields = (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-muted">Grade</legend>
          <div className="flex gap-1.5">
            {GRADES.map((g) => (
              <label key={g} className="cursor-pointer">
                <input
                  type="checkbox"
                  name="grade"
                  value={g}
                  defaultChecked={filters.grades?.includes(g)}
                  className="peer sr-only"
                />
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-sm font-semibold peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1">
                  {g}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="risk"
            value="1"
            defaultChecked={filters.atRisk}
            className="h-4 w-4 accent-black"
          />
          At risk
        </label>
        <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="unrated"
            value="1"
            defaultChecked={filters.unrated}
            className="h-4 w-4 accent-black"
          />
          {UNRATED_LABEL}
        </label>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <FilterSelect
          label="Stage"
          name="stage"
          value={filters.stages?.[0]}
          options={STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }))}
        />
        <FilterSelect label="Owner" name="owner" value={filters.owner} options={ownerOptions} all="Anyone" />
        <FilterSelect label="First door" name="door" value={filters.firstDoor} options={opt("lists.firstDoors")} />
        <FilterSelect label="Campaign" name="campaign" value={filters.campaign} options={opt("lists.campaigns")} />
        <FilterSelect label="Channel" name="channel" value={filters.channel} options={opt("lists.channels")} />
        <FilterSelect
          label="Product family bought"
          name="family"
          value={filters.family}
          options={settings["ladder.families"].map((f) => ({ value: f.key, label: f.label }))}
        />
        <FilterSelect label="Product bought" name="product" value={filters.product} options={productOptions} />
        <FilterSelect
          label="Country"
          name="country"
          value={filters.country}
          options={[
            ...countries.map((c) => ({ value: c.country, label: countryName(c.country) })),
            ...(filters.country && !countries.some((c) => c.country === filters.country)
              ? [{ value: filters.country, label: countryName(filters.country) }]
              : []),
          ]}
        />
        <FilterSelect label="Language" name="lang" value={filters.language} options={opt("lists.languages")} />
        <FilterSelect label="Tag" name="tag" value={filters.tag} options={opt("lists.tags")} />
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="f-sort" className="text-xs font-medium text-muted">
            Sort by
          </label>
          <Select
            id="f-sort"
            name="sort"
            defaultValue={filters.sort === "score" ? "" : (filters.sort ?? "")}
            className="h-9"
            options={SORT_OPTIONS}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <noscript>
          <button type="submit" className={buttonClass("outline", "sm")}>
            Apply
          </button>
        </noscript>
        {(activeCount > 0 || filters.q) && (
          <Link
            href={filters.sort && filters.sort !== "score" ? `/contacts?sort=${filters.sort}` : "/contacts"}
            className="ml-auto text-sm font-medium underline-offset-2 hover:underline"
          >
            Clear filters
          </Link>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Contacts"
        description={viewAll ? "Everyone in the CRM." : "Your contacts and the unassigned pool."}
        actions={
          <div className="flex flex-wrap gap-2">
            {can(user, "export.run") && (
              // a plain link: the browser downloads the CSV of exactly this filtered list (the export is audited)
              <a
                href={`/api/export/contacts${query ? `?${query}` : ""}`}
                className={buttonClass("outline", "md")}
                download
              >
                <Download className="h-4 w-4" aria-hidden /> Export CSV
              </a>
            )}
            <ButtonLink href="/contacts/new">
              <UserPlus className="h-4 w-4" aria-hidden /> Quick Add
            </ButtonLink>
          </div>
        }
      />

      <SavedViews
        views={views}
        currentQuery={query}
        canShare={canShareViews(user)}
        canDeleteShared={user.role === "admin"}
        builtIn={[
          ...(user.role !== "support" ? [{ query: "owner=mine", label: "My contacts", count: null }] : []),
          { query: "owner=pool", label: "Pool", count: poolCount },
        ]}
      />

      {/* keyed by the query so the fields show the URL's values after every navigation (e.g. Clear filters) */}
      <FilterForm
        search={<div key={query}>{search}</div>}
        filters={<div key={query}>{filterFields}</div>}
        activeCount={activeCount}
      />

      <p className="text-sm text-muted" aria-live="polite">
        {result.total === 0 ? (
          "No contacts"
        ) : (
          <>
            <span className="font-medium text-foreground">{result.total.toLocaleString("en-IN")}</span> contact
            {result.total === 1 ? "" : "s"}
            {result.pageCount > 1 && (
              <>
                {" "}
                · showing {first.toLocaleString("en-IN")}–{last.toLocaleString("en-IN")}
              </>
            )}{" "}
            · sorted by {sortLabel.toLowerCase()}
          </>
        )}
      </p>

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            title={activeCount || filters.q ? "No contacts match" : "No contacts yet"}
            description={
              activeCount || filters.q
                ? "Try fewer filters, or search part of a number (three digits or more)."
                : "Add the first one with Quick Add, or import your old records."
            }
            action={
              activeCount || filters.q ? (
                <ButtonLink href="/contacts" variant="outline">
                  Clear filters
                </ButtonLink>
              ) : (
                <ButtonLink href="/contacts/new">Quick Add</ButtonLink>
              )
            }
          />
        </div>
      ) : (
        <>
          {/* phones: cards */}
          <ul className="space-y-2 md:hidden">
            {result.rows.map((r) => (
              <ContactCard
                key={r.id}
                r={r}
                doorLabel={labelFor(doors, r.firstDoor)}
                meId={user.id}
                owner={
                  ownerMode ? (
                    <OwnerCell
                      contactId={r.id}
                      ownerId={r.ownerId}
                      ownerName={r.ownerName}
                      meId={user.id}
                      mode={ownerMode}
                      people={people}
                      className="mt-2 border-t border-border pt-2 text-sm"
                    />
                  ) : null
                }
              />
            ))}
          </ul>

          {/* laptops: table (the bulk bar shares its container so it can stick to the bottom while scrolling) */}
          <div className="hidden md:block">
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              <Table>
                <caption className="sr-only">Contacts, sorted by {sortLabel}</caption>
                <thead>
                  <tr>
                    {canReassign && (
                      <Th className="w-10">
                        <input
                          type="checkbox"
                          data-bulk-all
                          aria-label="Select every contact on this page"
                          className="h-4 w-4 accent-black"
                        />
                      </Th>
                    )}
                    <Th className="w-20">Grade</Th>
                    <Th>Name</Th>
                    <Th>Stage</Th>
                    <Th>Owner</Th>
                    <Th className="text-right">LTV</Th>
                    <Th className="hidden xl:table-cell">Next offer</Th>
                    <Th>Last activity</Th>
                    <Th className="w-24">
                      <span className="sr-only">Call or WhatsApp</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.id} className="hover:bg-surface-muted/50">
                      {canReassign && (
                        <Td>
                          <input
                            type="checkbox"
                            name="ids"
                            value={r.id}
                            form={BULK_FORM_ID}
                            aria-label={`Select ${r.name}`}
                            className="h-4 w-4 accent-black"
                          />
                        </Td>
                      )}
                      <Td>
                        <GradeBadge grade={r.grade} score={r.edaptScore} />
                      </Td>
                      <Td className="max-w-64">
                        <Link
                          href={`/contacts/${r.id}`}
                          className="block truncate font-medium underline-offset-2 hover:underline"
                        >
                          {r.name}
                        </Link>
                        <span className="tabular block truncate text-xs text-muted">{formatPhone(r.phoneE164)}</span>
                      </Td>
                      <Td>
                        <div className="flex flex-col items-start gap-1">
                          <StageBadge stage={r.stage} />
                          {r.atRisk && <span className="text-xs font-medium text-danger">At risk</span>}
                        </div>
                      </Td>
                      <Td className="text-sm">
                        <OwnerCell
                          contactId={r.id}
                          ownerId={r.ownerId}
                          ownerName={r.ownerName}
                          meId={user.id}
                          mode={ownerMode}
                          people={people}
                        />
                      </Td>
                      <Td className="tabular text-right font-medium">{formatINR(r.ltvInr)}</Td>
                      <Td className="hidden max-w-56 xl:table-cell">
                        <span className="line-clamp-2 text-sm text-foreground/80">{r.nextOffer ?? "–"}</span>
                      </Td>
                      <Td
                        className="whitespace-nowrap text-sm text-muted"
                        title={
                          r.lastActivityAt
                            ? new Date(r.lastActivityAt).toLocaleString("en-IN", { timeZone: tz })
                            : undefined
                        }
                      >
                        {r.lastActivityAt ? formatRelative(r.lastActivityAt) : "–"}
                      </Td>
                      <Td>
                        <ContactQuickActions contact={{ id: r.id, name: r.name, phoneE164: r.phoneE164 }} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            {canReassign && <BulkReassignBar people={people} />}
          </div>
        </>
      )}

      {result.pageCount > 1 && (
        <nav className="flex items-center justify-between gap-2" aria-label="Pages">
          {result.page > 1 ? (
            <Link href={pageHref(query, result.page - 1)} className={buttonClass("outline", "sm")}>
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted">
            Page {result.page} of {result.pageCount.toLocaleString("en-IN")}
          </span>
          {result.page < result.pageCount ? (
            <Link href={pageHref(query, result.page + 1)} className={buttonClass("outline", "sm")}>
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

function ContactCard({
  r,
  doorLabel,
  meId,
  owner,
}: {
  r: ContactListRow;
  doorLabel: string;
  meId: string;
  /** the owner with Assign (managers) or Request (sales, pool leads) */
  owner: React.ReactNode;
}) {
  return (
    <li className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-start gap-3">
        <GradeBadge grade={r.grade} score={null} />
        <Link
          href={`/contacts/${r.id}`}
          className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="truncate font-semibold">{r.name}</p>
          <p className="tabular truncate text-xs text-muted">
            {formatPhone(r.phoneE164)}
            {r.edaptScore != null && ` · score ${r.edaptScore}`}
          </p>
        </Link>
        <ContactQuickActions contact={{ id: r.id, name: r.name, phoneE164: r.phoneE164 }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <StageBadge stage={r.stage} />
        {r.atRisk && <span className="font-medium text-danger">At risk</span>}
        {!owner && (
          <>
            <span className="text-muted">{r.ownerName ? (r.ownerId === meId ? "You" : r.ownerName) : "Pool"}</span>
            <span className="text-muted">·</span>
          </>
        )}
        <span className="tabular font-medium">{formatINR(r.ltvInr)}</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{r.lastActivityAt ? formatRelative(r.lastActivityAt) : doorLabel}</span>
      </div>
      {r.nextOffer && <p className="mt-1.5 truncate text-xs text-foreground/80">Next: {r.nextOffer}</p>}
      {owner}
    </li>
  );
}
