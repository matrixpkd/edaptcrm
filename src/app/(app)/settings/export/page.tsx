import { sql } from "drizzle-orm";
import { Download, ShieldCheck } from "lucide-react";
import { Badge, STAGE_LABELS } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Input, Select } from "@/components/ui/form";
import { countryName, PAYMENT_MODE_LABELS, PURCHASE_STATUS_LABELS } from "@/components/contacts/labels";
import { db } from "@/db";
import { PAYMENT_MODES, PURCHASE_SOURCES, PURCHASE_STATUSES, STAGES, contacts, purchases } from "@/db/schema";
import { recentExports } from "@/lib/admin/export";
import { requireUser } from "@/lib/auth/session";
import { activeFilterCount, contactListWhere, GRADES, listContactCountries, listOwnerOptions, parseContactFilters } from "@/lib/contacts/queries";
import { getSettings } from "@/lib/settings";
import { formatDateTime } from "@/lib/utils";
import { SettingsHeader } from "../_components/settings-header";

export const metadata = { title: "Export" };

const SOURCE_LABELS: Record<(typeof PURCHASE_SOURCES)[number], string> = { tagmango: "TagMango", manual: "Manual", import: "Import" };

function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
      {children}
    </label>
  );
}

export default async function ExportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireUser(["admin"]);
  const sp = await searchParams;
  const tz = me.timezone || "Asia/Kolkata";
  const f = parseContactFilters(sp);
  const counting = sp.count === "1";
  const [s, owners, countries, [totals], matching, recent] = await Promise.all([
    getSettings(["lists.firstDoors", "lists.campaigns", "lists.channels", "lists.languages", "lists.tags", "ladder.families"]),
    listOwnerOptions(),
    listContactCountries(me),
    db.execute<{ contacts: number; purchases: number }>(sql`
      select (select count(*)::int from ${contacts} where merged_into_id is null) as contacts,
             (select count(*)::int from ${purchases}) as purchases
    `),
    counting
      ? db
          .select({ n: sql<number>`count(*)::int` })
          .from(contacts)
          .where(contactListWhere(me, { ...f, sort: undefined }))
          .then((r) => Number(r[0].n))
      : Promise.resolve(null),
    recentExports(8),
  ]);
  const opts = (list: { key: string; label: string }[]) => list.map((i) => ({ value: i.key, label: i.label }));

  return (
    <div className="mx-auto max-w-4xl">
      <SettingsHeader
        title="Export"
        description="Download contacts or purchases as a spreadsheet (CSV, opens in Excel and Google Sheets). Times are in your time zone."
      />
      <div className="flex flex-col gap-5">
        <p className="flex items-start gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Only the admin can export, and every export is logged with its filters and row count.{" "}
            <span className="text-muted">Keep files out of shared drives: they hold phone numbers and emails.</span>
          </span>
        </p>

        <Card>
          <CardHeader
            title="Contacts"
            description={`${Number(totals.contacts).toLocaleString("en-IN")} in total. Leave everything empty for all of them; the filters match the Contacts list.`}
          />
          <CardBody>
            <form method="get" action="/api/export/contacts" className="flex flex-col gap-4" aria-label="Export contacts">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
                  <Label htmlFor="x-q">Search (name, phone or email)</Label>
                  <Input id="x-q" name="q" defaultValue={f.q ?? ""} />
                </div>
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1 text-xs font-medium text-muted">Grade</legend>
                  <div className="flex flex-wrap gap-3">
                    {GRADES.map((g) => (
                      <Checkbox key={g} name="grade" value={g} defaultChecked={f.grades?.includes(g)} label={g} />
                    ))}
                  </div>
                </fieldset>
                <fieldset className="flex flex-col gap-1.5 sm:col-span-1 lg:col-span-2">
                  <legend className="mb-1 text-xs font-medium text-muted">Stage</legend>
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                    {STAGES.map((st) => (
                      <Checkbox key={st} name="stage" value={st} defaultChecked={f.stages?.includes(st)} label={STAGE_LABELS[st]} />
                    ))}
                  </div>
                </fieldset>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="x-door">First door</Label>
                  <Select id="x-door" name="door" defaultValue={f.firstDoor ?? ""} placeholder="Any" options={opts(s["lists.firstDoors"])} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="x-campaign">Campaign</Label>
                  <Select id="x-campaign" name="campaign" defaultValue={f.campaign ?? ""} placeholder="Any" options={opts(s["lists.campaigns"])} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="x-channel">Channel (any enquiry)</Label>
                  <Select id="x-channel" name="channel" defaultValue={f.channel ?? ""} placeholder="Any" options={opts(s["lists.channels"])} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="x-owner">Owner</Label>
                  <Select id="x-owner" name="owner" defaultValue={f.owner ?? ""} placeholder="Anyone">
                    <option value="pool">The pool (no owner)</option>
                    {owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                        {o.active ? "" : " (deactivated)"}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="x-family">Bought from family</Label>
                  <Select id="x-family" name="family" defaultValue={f.family ?? ""} placeholder="Any" options={opts(s["ladder.families"])} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="x-country">Country</Label>
                  <Select
                    id="x-country"
                    name="country"
                    defaultValue={f.country ?? ""}
                    placeholder="Any"
                    options={countries.map((c) => ({ value: c.country, label: `${countryName(c.country)} (${c.n.toLocaleString("en-IN")})` }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="x-lang">Language</Label>
                  <Select id="x-lang" name="lang" defaultValue={f.language ?? ""} placeholder="Any" options={opts(s["lists.languages"])} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="x-tag">Tag</Label>
                  <Select id="x-tag" name="tag" defaultValue={f.tag ?? ""} placeholder="Any" options={opts(s["lists.tags"])} />
                </div>
                <div className="flex flex-col justify-end gap-1.5">
                  <Checkbox name="risk" value="1" defaultChecked={f.atRisk} label="At risk only" />
                  <Checkbox name="unrated" value="1" defaultChecked={f.unrated} label="Not rated by sales" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" className={buttonClass("primary")}>
                  <Download className="h-4 w-4" aria-hidden /> Download contacts
                </button>
                <button type="submit" formAction="/settings/export" name="count" value="1" className={buttonClass("outline")}>
                  Count matches
                </button>
                {matching !== null && (
                  <span role="status" className="text-sm">
                    <span className="tabular font-semibold">{matching.toLocaleString("en-IN")}</span> contact{matching === 1 ? "" : "s"} match
                    {activeFilterCount(f) || f.q ? "" : " (no filters)"}.
                  </span>
                )}
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Purchases" description={`${Number(totals.purchases).toLocaleString("en-IN")} in total, with amounts, INR values, rates, references and verified money received.`} />
          <CardBody>
            <form method="get" action="/api/export/purchases" className="flex flex-col gap-4" aria-label="Export purchases">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="p-from">Purchased from</Label>
                  <Input id="p-from" name="from" type="date" />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="p-to">Purchased to</Label>
                  <Input id="p-to" name="to" type="date" />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="p-status">Status</Label>
                  <Select id="p-status" name="status" placeholder="Any" options={PURCHASE_STATUSES.map((x) => ({ value: x, label: PURCHASE_STATUS_LABELS[x] }))} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="p-family">Family</Label>
                  <Select id="p-family" name="family" placeholder="Any" options={opts(s["ladder.families"])} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="p-mode">Payment mode</Label>
                  <Select id="p-mode" name="mode" placeholder="Any" options={PAYMENT_MODES.map((x) => ({ value: x, label: PAYMENT_MODE_LABELS[x] }))} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="p-source">Source</Label>
                  <Select id="p-source" name="source" placeholder="Any" options={PURCHASE_SOURCES.map((x) => ({ value: x, label: SOURCE_LABELS[x] }))} />
                </div>
              </div>
              <div>
                <button type="submit" className={buttonClass("primary")}>
                  <Download className="h-4 w-4" aria-hidden /> Download purchases
                </button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent exports" description="Reload the page after a download to see it here. The full record is in the audit log." />
          {recent.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">No exports yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((r) => {
                const v = (r.newValue ?? {}) as { rows?: number; filters?: Record<string, string> };
                const filters = Object.entries(v.filters ?? {})
                  .map(([k, x]) => `${k}=${x}`)
                  .join(", ");
                return (
                  <li key={r.id} className="flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-3">
                    <span className="shrink-0 text-xs text-muted sm:w-32">{formatDateTime(r.changedAt, tz)}</span>
                    <span className="min-w-0 flex-1">
                      {r.userName ?? "Someone"} · {r.tableName}
                      {r.action === "export" ? ` · ${(v.rows ?? 0).toLocaleString("en-IN")} rows` : ""}
                      {filters && <span className="block truncate text-xs text-muted sm:inline sm:before:content-['_·_']">{filters}</span>}
                    </span>
                    {r.action === "export_denied" && <Badge tone="danger">Refused</Badge>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
