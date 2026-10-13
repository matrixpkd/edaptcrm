/**
 * The growth cockpit's sections, in the order of the spec table ("Dashboard: the growth cockpit"). Server
 * components: each takes the numbers from src/lib/dashboard/metrics.ts and lays them out; charts are small client
 * islands with a table twin right below them.
 */
import Link from "next/link";
import { AlertTriangle, ChevronRight, Copy, ShieldCheck, Star } from "lucide-react";
import { Table, Td, Th } from "@/components/ui/table";
import type { DashboardRange } from "@/lib/dashboard/period";
import { count, deltaOf, formatHours, plural, pointsDelta, share } from "@/lib/dashboard/format";
import type {
  AssistedSplit,
  BeyondUmer,
  CheckoutRecovery,
  DataHealth,
  LanguageMix,
  LeadsByChannel,
  LostReasons,
  LtvByDoor,
  ReferralLeaderboard,
  RevenueByFamily,
  RungMoves,
  TeamRow,
} from "@/lib/dashboard/metrics";
import { UNRATED_LABEL } from "@/lib/contacts/rules";
import { cn, formatINR, formatINRCompact } from "@/lib/utils";
import { LeadsByChannelChart, LtvByDoorChart, RevenueByFamilyChart, ShareTrendChart } from "./charts";
import { DeltaLine, Figure, Meter, Section, SectionEmpty, SplitBar, Swatch, TableToggle } from "./kit";
import { VIZ } from "./palette";

const ALL_TIME = "All time";
const NOW = "Now";
const num = "tabular text-right";

// 1 ---------------------------------------------------------------------------

export function RevenueSection({ data, range, className }: { data: RevenueByFamily; range: DashboardRange; className?: string }) {
  const { totals } = data;
  return (
    <Section id="revenue" title="Revenue by product family" why="Where the money is coming from now." scope={range.label} className={className}>
      {data.rows.length === 0 ? (
        <SectionEmpty title="No revenue in this period yet">
          Verified payments show up here as they arrive. Bank and UPI payments count once a manager verifies them.
        </SectionEmpty>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-x-8 gap-y-3">
            <Figure label={range.label} value={formatINRCompact(totals.current)} title={formatINR(totals.current)} />
            <Figure label={range.prevLabel} value={formatINRCompact(totals.previous)} title={formatINR(totals.previous)} />
            {range.key === "month" && (
              <div className="min-w-0">
                <p className="text-xs text-muted">At the same point last month</p>
                <p className="mt-0.5 text-xl font-semibold tracking-tight" title={formatINR(totals.previousToDate)}>
                  {formatINRCompact(totals.previousToDate)}
                </p>
                <DeltaLine delta={deltaOf(totals.current, totals.previousToDate)} compare={range.compareLabel} />
              </div>
            )}
          </div>
          <RevenueByFamilyChart
            rows={data.rows.map((r) => ({ label: r.label, current: r.current, previous: r.previous }))}
            currentName={range.label}
            previousName={range.prevLabel}
            ariaLabel={`Revenue by product family, ${range.label} against ${range.prevLabel}`}
          />
          <TableToggle>
            <Table>
              <thead>
                <tr>
                  <Th>Family</Th>
                  <Th className="text-right">{range.label}</Th>
                  <Th className="text-right">{range.prevLabel}</Th>
                  <Th className="text-right">Change</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.family}>
                    <Td>{r.label}</Td>
                    <Td className={num}>{formatINR(r.current)}</Td>
                    <Td className={num}>{formatINR(r.previous)}</Td>
                    <Td className={num}>{deltaOf(r.current, r.previous).text || "—"}</Td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <Td>Total</Td>
                  <Td className={num}>{formatINR(totals.current)}</Td>
                  <Td className={num}>{formatINR(totals.previous)}</Td>
                  <Td className={num}>{deltaOf(totals.current, totals.previous).text || "—"}</Td>
                </tr>
              </tbody>
            </Table>
          </TableToggle>
          <p className="mt-3 text-xs text-muted">
            Verified payments minus refunds, in INR, dated by when the money moved (a transfer verified later still counts on the
            day it was paid).
          </p>
        </>
      )}
    </Section>
  );
}

// 2 ---------------------------------------------------------------------------

export function ChannelsSection({ data, range, className }: { data: LeadsByChannel; range: DashboardRange; className?: string }) {
  const charted = data.rows.filter((r) => r.leads > 0);
  return (
    <Section
      id="channels"
      title="Leads and conversion by channel"
      why="Which channels convert, not just which are busy."
      scope={range.label}
      className={className}
    >
      {data.rows.length === 0 ? (
        <SectionEmpty title="No new leads or enquiries in this period">New contacts appear here by the channel they first came in on.</SectionEmpty>
      ) : (
        <>
          <p className="mb-3 text-sm">
            <span className="font-semibold">{plural(data.totals.leads, "new lead")}</span>
            <span className="text-muted">
              {" "}
              · {share(data.totals.conversion)} have paid · {plural(data.totals.enquiries, "enquiry", "enquiries")} in all
            </span>
          </p>
          {charted.length > 0 ? (
            <LeadsByChannelChart
              rows={charted.map((r) => ({
                label: r.label,
                converted: r.converted,
                open: r.leads - r.converted,
                leads: r.leads,
                conversionText: share(r.conversion),
              }))}
              ariaLabel={`New leads by first channel and how many have paid, ${range.label}`}
            />
          ) : (
            <SectionEmpty title="No new leads in this period">Enquiries from returning contacts are in the table.</SectionEmpty>
          )}
          <TableToggle>
            <Table>
              <thead>
                <tr>
                  <Th>Channel</Th>
                  <Th className="text-right">New leads</Th>
                  <Th className="text-right">Paid</Th>
                  <Th className="text-right">Conversion</Th>
                  <Th className="text-right">Enquiries</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.channel || "none"}>
                    <Td>{r.label}</Td>
                    <Td className={num}>{count(r.leads)}</Td>
                    <Td className={num}>{count(r.converted)}</Td>
                    <Td className={num}>{share(r.conversion)}</Td>
                    <Td className={num}>{count(r.enquiries)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableToggle>
          <p className="mt-3 text-xs text-muted">
            New leads are contacts first seen in this period, by their first channel; paid means they are paying customers now.
            Enquiries count every inbound touch, from new and returning contacts.
            {notLeadsNote(data.notLeads)}
          </p>
        </>
      )}
    </Section>
  );
}

/** " Not counted as leads: 1,200 imported records and 3 contacts who had paid before the CRM first saw them." */
function notLeadsNote({ imported, alreadyCustomers }: LeadsByChannel["notLeads"]): string {
  const parts = [
    imported > 0 ? plural(imported, "imported record") : null,
    alreadyCustomers > 0 ? `${plural(alreadyCustomers, "contact")} who had paid before the CRM first saw them` : null,
  ].filter(Boolean);
  return parts.length ? ` Not counted as leads: ${parts.join(" and ")}.` : "";
}

// 3 ---------------------------------------------------------------------------

export function DoorsSection({ data, className }: { data: LtvByDoor; className?: string }) {
  const paying = data.rows.filter((r) => r.customers > 0);
  return (
    <Section id="doors" title="LTV by First Door" why="Which doors bring valuable customers over time." scope={ALL_TIME} className={className}>
      {paying.length === 0 ? (
        <SectionEmpty title="No paying customers yet">Once people pay, their lifetime value is grouped by how they first found Edapt.</SectionEmpty>
      ) : (
        <>
          <p className="mb-3 text-sm">
            <span className="font-semibold">{formatINRCompact(data.totals.avgLtvInr)}</span>
            <span className="text-muted"> average LTV across {plural(data.totals.customers, "customer")}</span>
          </p>
          <LtvByDoorChart
            rows={[...paying]
              .sort((a, b) => (b.avgLtvInr ?? 0) - (a.avgLtvInr ?? 0))
              .map((r) => ({ label: r.label, avg: r.avgLtvInr ?? 0, customers: r.customers }))}
            ariaLabel="Average lifetime value per customer by First Door"
          />
          <TableToggle>
            <Table>
              <thead>
                <tr>
                  <Th>First Door</Th>
                  <Th className="text-right">Contacts</Th>
                  <Th className="text-right">Customers</Th>
                  <Th className="text-right">Total LTV</Th>
                  <Th className="text-right">Average</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.door}>
                    <Td>{r.label}</Td>
                    <Td className={num}>{count(r.contacts)}</Td>
                    <Td className={num}>
                      {count(r.customers)} <span className="text-muted">({share(r.conversion)})</span>
                    </Td>
                    <Td className={num}>{formatINR(r.totalLtvInr)}</Td>
                    <Td className={num}>{r.avgLtvInr === null ? "—" : formatINR(r.avgLtvInr)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableToggle>
        </>
      )}
    </Section>
  );
}

// 4 ---------------------------------------------------------------------------

export function RepeatSection({
  rate,
  median,
  className,
}: {
  rate: { customers: number; repeaters: number; rate: number | null };
  median: { medianDays: number | null; customers: number };
  className?: string;
}) {
  return (
    <Section id="repeat" title="Repeat rate" why="How strong the ladder is." scope={ALL_TIME} className={className}>
      {rate.customers === 0 ? (
        <SectionEmpty title="No customers yet" />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Figure
            label="Bought more than once"
            value={share(rate.rate)}
            hint={`${count(rate.repeaters)} of ${plural(rate.customers, "customer")}`}
          />
          <Figure
            label="Median days, 1st to 2nd purchase"
            value={median.medianDays === null ? "—" : `${count(Math.round(median.medianDays))} days`}
            hint={median.customers ? `across ${plural(median.customers, "repeat customer")}` : "No second purchases yet"}
          />
        </div>
      )}
    </Section>
  );
}

// 5 ---------------------------------------------------------------------------

export function RungsSection({ data, range, className }: { data: RungMoves; range: DashboardRange; className?: string }) {
  return (
    <Section id="rungs" title="Rung moves" why="How many customers climbed, and from which rung." scope={range.label} className={className}>
      <div className="grid grid-cols-2 gap-4">
        <Figure label="Climbed a rung" value={count(data.climbed)} hint="Already on the ladder" />
        <Figure label="Stepped onto the ladder" value={count(data.entered)} hint="First rung bought" />
      </div>
      {data.moves.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Nobody moved up a rung in this period yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {data.moves.map((m) => (
            <li key={`${m.from}-${m.to}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="text-muted">{m.fromLabel}</span>
                <span aria-hidden className="mx-1.5 text-muted">
                  →
                </span>
                <span className="sr-only"> to </span>
                <span className="font-medium">{m.toLabel}</span>
              </span>
              <span className="tabular shrink-0 font-semibold">{count(m.customers)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// 6, 7 ------------------------------------------------------------------------

export function ForecastSection({ data, className }: { data: { totalInr: number; customers: number }; className?: string }) {
  return (
    <Section id="forecast" title="90-day revenue forecast" why="Money likely to arrive from existing customers." scope={NOW} className={className}>
      <p className="text-3xl font-semibold tracking-tight" title={formatINR(data.totalInr)}>
        {formatINRCompact(data.totalInr)}
      </p>
      <p className="mt-1 text-sm text-muted">
        {data.customers ? `Expected from ${plural(data.customers, "customer")}.` : "Nothing expected yet."} The sum of each
        customer&apos;s repeat probability times the price of their next best offer, from Edapt&apos;s own repeat history.
      </p>
    </Section>
  );
}

export function AtRiskSection({
  data,
  atRiskDays,
  className,
}: {
  data: { count: number; expectedInr: number; ltvInr: number };
  atRiskDays: number;
  className?: string;
}) {
  return (
    <Section id="at-risk" title="At-risk pool" why="Customers past their expected date." scope={NOW} className={className}>
      <div className="grid grid-cols-2 gap-4">
        <Figure label="Customers at risk" value={count(data.count)} />
        <Figure label="Expected value" value={formatINRCompact(data.expectedInr)} title={formatINR(data.expectedInr)} />
      </div>
      <p className="mt-3 text-sm text-muted">
        More than {plural(atRiskDays, "day")} past their expected next purchase.{" "}
        {data.count > 0 && <>They have spent {formatINRCompact(data.ltvInr)} with Edapt so far. Each one is on its owner&apos;s Today list.</>}
      </p>
    </Section>
  );
}

// 8 ---------------------------------------------------------------------------

export function CheckoutsSection({ data, range, className }: { data: CheckoutRecovery; range: DashboardRange; className?: string }) {
  return (
    <Section id="checkouts" title="Abandoned checkouts recovered" why="Count recovered and revenue saved." scope={range.label} className={className}>
      {data.abandoned === 0 ? (
        <SectionEmpty title="No abandoned checkouts in this period">
          A TagMango payment that starts or fails without a completed order becomes a call task at the top of Today.
        </SectionEmpty>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Figure label="Abandoned" value={count(data.abandoned)} />
            <Figure label="Recovered" value={count(data.recovered)} hint={`${share(data.recoveryRate)} of them`} />
            <Figure label="Revenue saved" value={formatINRCompact(data.revenueSavedInr)} title={formatINR(data.revenueSavedInr)} />
          </div>
          <div className="mt-4">
            <Meter value={data.recoveryRate} label="Share of abandoned checkouts recovered" />
          </div>
          <p className="mt-3 text-xs text-muted">
            {data.stillOpen > 0 ? `${plural(data.stillOpen, "checkout")} not recovered yet. ` : ""}
            Revenue saved is the verified money on the purchase each customer made after abandoning.
          </p>
        </>
      )}
    </Section>
  );
}

// 9 ---------------------------------------------------------------------------

export function AssistedSection({
  data,
  range,
  creditDays,
  className,
}: {
  data: AssistedSplit;
  range: DashboardRange;
  creditDays: number;
  className?: string;
}) {
  const parts = [
    { name: "Assisted", value: data.assisted.inr, color: VIZ.series1, split: data.assisted, share: data.assistedShare },
    {
      name: "Self-serve",
      value: data.selfServe.inr,
      color: VIZ.series2,
      split: data.selfServe,
      share: data.assistedShare === null ? null : 1 - data.assistedShare,
    },
  ];
  const a = data.assisted.perCustomerInr;
  const s = data.selfServe.perCustomerInr;
  return (
    <Section
      id="assisted"
      title="Assisted vs self-serve revenue"
      why="Whether sales calls change what customers spend."
      scope={range.label}
      className={className}
    >
      {data.totalInr === 0 && data.assisted.purchases + data.selfServe.purchases === 0 ? (
        <SectionEmpty title="No revenue in this period yet" />
      ) : (
        <>
          <SplitBar
            parts={parts}
            label={`Assisted ${share(data.assistedShare)}, self-serve ${share(parts[1].share)} of revenue`}
          />
          <ul className="mt-3 space-y-2">
            {parts.map((p) => (
              <li key={p.name} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="flex items-center gap-1.5 font-medium">
                  <Swatch color={p.color} />
                  {p.name}
                </span>
                <span className="tabular font-semibold" title={formatINR(p.value)}>
                  {formatINRCompact(p.value)}
                </span>
                <span className="text-muted">
                  {share(p.share)} · {plural(p.split.purchases, "purchase")}
                  {p.split.perCustomerInr !== null && <> · {formatINRCompact(p.split.perCustomerInr)} per customer</>}
                </span>
              </li>
            ))}
          </ul>
          {a !== null && s !== null && s > 0 && (
            <p className="mt-3 text-sm">
              Customers a salesperson talked to spent <span className="font-semibold">{(a / s).toFixed(1)}×</span> what
              self-serve customers spent in this period.
            </p>
          )}
          <p className="mt-3 text-xs text-muted">
            Assisted: the owner logged an interaction in the {creditDays} days before the purchase, or a manager credited it.
          </p>
        </>
      )}
    </Section>
  );
}

// 10 --------------------------------------------------------------------------

export function TeamSection({ rows, range, className }: { rows: TeamRow[]; range: DashboardRange; className?: string }) {
  return (
    <Section
      id="team"
      title="Team view"
      why="First-response time, contacts handled, conversion and assisted revenue per person."
      scope={range.label}
      className={className}
      bodyClassName="p-0"
    >
      {rows.length === 0 ? (
        <div className="p-4">
          <SectionEmpty title="No salespeople yet">Add the team in Settings, then their numbers show up here.</SectionEmpty>
        </div>
      ) : (
        <>
          <Table>
            <caption className="sr-only">Team view, {range.label}</caption>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th className="text-right">First response</Th>
                <Th className="text-right">Leads given</Th>
                <Th className="text-right">Contacts handled</Th>
                <Th className="text-right">Conversion</Th>
                <Th className="text-right">Assisted revenue</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <Td className="whitespace-nowrap">
                    <span className="font-medium">{r.name}</span>
                    {!r.active && <span className="ml-2 text-xs text-muted">(inactive)</span>}
                    {r.role !== "sales" && <span className="ml-2 text-xs capitalize text-muted">{r.role}</span>}
                  </Td>
                  <Td className={cn(num, "whitespace-nowrap")}>
                    {formatHours(r.medianResponseHours)}
                    {r.assigned > r.responded && (
                      <span className="block text-xs text-muted">{count(r.assigned - r.responded)} not contacted</span>
                    )}
                  </Td>
                  <Td className={num}>{count(r.leads)}</Td>
                  <Td className={num}>{count(r.handled)}</Td>
                  <Td className={cn(num, "whitespace-nowrap")}>
                    {share(r.conversion)}
                    {r.leads > 0 && (
                      <span className="block text-xs text-muted">
                        {count(r.converted)} of {count(r.leads)}
                      </span>
                    )}
                  </Td>
                  <Td className={cn(num, "whitespace-nowrap")} title={formatINR(r.assistedInr)}>
                    {formatINRCompact(r.assistedInr)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="px-4 py-3 text-xs text-muted">
            First response: median time from a lead being given to the owner&apos;s first logged interaction. Conversion: leads given in
            this period that have paid since. Assisted revenue: money in this period on purchases credited to the person.
          </p>
        </>
      )}
    </Section>
  );
}

// 11 --------------------------------------------------------------------------

export function BeyondUmerSection({ data, range, className }: { data: BeyondUmer; range: DashboardRange; className?: string }) {
  const c = data.current;
  const hasTrend = data.trend.some((t) => t.share !== null);
  return (
    <Section
      id="beyond-umer"
      title="Beyond-Umer revenue share"
      why="Share of revenue from customers at Umer familiarity 0 to 2. Rising means the brand sells without its founder."
      scope={range.label}
      className={className}
    >
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-3xl font-semibold tracking-tight">{share(c.share)}</p>
          {c.share !== null && data.previous.share !== null && (
            <DeltaLine delta={pointsDelta(c.share, data.previous.share)} compare={range.prevLabel} />
          )}
        </div>
        <p className="pb-1 text-sm text-muted">
          {c.share === null
            ? "No revenue from rated customers in this period."
            : `${formatINRCompact(c.beyondInr)} of ${formatINRCompact(c.beyondInr + c.circleInr)} from rated customers`}
        </p>
      </div>
      {hasTrend && (
        <div className="mt-4">
          <p className="mb-1 text-xs font-medium text-muted">By month</p>
          <ShareTrendChart
            rows={data.trend.map((t) => ({ label: t.label, share: t.share, rated: t.beyondInr + t.circleInr, beyond: t.beyondInr }))}
            ariaLabel="Beyond-Umer revenue share by month"
          />
          <TableToggle>
            <Table>
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th className="text-right">Familiarity 0–2</Th>
                  <Th className="text-right">Familiarity 3–5</Th>
                  <Th className="text-right">Share</Th>
                  <Th className="text-right">Not rated</Th>
                </tr>
              </thead>
              <tbody>
                {data.trend.map((t) => (
                  <tr key={t.month}>
                    <Td>{t.label}</Td>
                    <Td className={num}>{formatINR(t.beyondInr)}</Td>
                    <Td className={num}>{formatINR(t.circleInr)}</Td>
                    <Td className={num}>{share(t.share)}</Td>
                    <Td className={num}>{formatINR(t.unratedInr)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableToggle>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        {c.unratedInr !== 0 ? (
          <>
            {formatINRCompact(c.unratedInr)} this period came from customers whose Umer familiarity is not rated yet. It is left out of the
            share until someone rates them.{" "}
          </>
        ) : null}
        Uses each customer&apos;s latest rating.
      </p>
    </Section>
  );
}

// 12 --------------------------------------------------------------------------

export function LanguageSection({ data, range, className }: { data: LanguageMix; range: DashboardRange; className?: string }) {
  const total = data.known + data.unknown;
  const max = Math.max(1, ...data.rows.map((r) => r.customers));
  return (
    <Section
      id="language"
      title="Language mix"
      why="Share of customers whose preferred language is not Malayalam: the expansion meter."
      scope={ALL_TIME}
      className={className}
    >
      {total === 0 ? (
        <SectionEmpty title="No customers yet" />
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            <p className="text-3xl font-semibold tracking-tight">{share(data.share)}</p>
            <p className="pb-1 text-right text-sm text-muted">
              {count(data.nonMalayalam)} of {plural(data.known, "customer")} with a language recorded
            </p>
          </div>
          <div className="mt-3">
            <Meter value={data.share} label="Customers whose preferred language is not Malayalam" />
          </div>
          <p className="mt-2 text-xs text-muted">
            New customers ({range.label}):{" "}
            {data.newKnown ? `${share(data.newShare)} not Malayalam` : "none with a language recorded"}.
            {data.unknown > 0 && ` ${plural(data.unknown, "customer")} with no language recorded ${data.unknown === 1 ? "is" : "are"} left out.`}
          </p>
          <ul className="mt-4 space-y-1.5" aria-label="Customers by preferred language">
            {data.rows.map((r) => (
              <li key={r.language || "none"} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-sm">
                <span className={cn("truncate", r.language === "" && "text-muted")}>{r.label}</span>
                <span aria-hidden className="h-2 overflow-hidden rounded-full bg-surface-muted">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${(r.customers / max) * 100}%`, background: r.language === "" ? VIZ.context : VIZ.series1 }}
                  />
                </span>
                <span className="tabular text-right font-medium">{count(r.customers)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

// 13 --------------------------------------------------------------------------

export function ReferralsSection({ data, className }: { data: ReferralLeaderboard; className?: string }) {
  return (
    <Section
      id="referrals"
      title="Referral leaderboard"
      why="Top advocates and the revenue their network brought."
      scope={ALL_TIME}
      className={className}
      bodyClassName="p-0"
    >
      {data.rows.length === 0 ? (
        <div className="p-4">
          <SectionEmpty title="No referrals yet">
            When someone comes in through a customer&apos;s affiliate link or is marked as referred by them, the referrer shows up here.
          </SectionEmpty>
        </div>
      ) : (
        <>
          <p className="px-4 pt-3 text-sm">
            <span className="font-semibold">{plural(data.advocates, "advocate")}</span>
            <span className="text-muted"> brought in {formatINRCompact(data.totalNetworkInr)} through the people they referred.</span>
          </p>
          <Table className="mt-2">
            <caption className="sr-only">Top advocates by network value</caption>
            <thead>
              <tr>
                <Th className="w-8">#</Th>
                <Th>Advocate</Th>
                <Th className="text-right">Paying referrals</Th>
                <Th className="text-right">Network value</Th>
                <Th className="text-right">Own LTV</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={r.contactId}>
                  <Td className="tabular text-muted">{i + 1}</Td>
                  <Td className="whitespace-nowrap">
                    <Link
                      href={`/contacts/${r.contactId}`}
                      className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {r.name}
                    </Link>
                    {r.ownerName && <span className="block text-xs text-muted">Owner: {r.ownerName}</span>}
                  </Td>
                  <Td className={num}>{count(r.referralCount)}</Td>
                  <Td className={cn(num, "font-semibold")} title={formatINR(r.networkValueInr)}>
                    {formatINRCompact(r.networkValueInr)}
                  </Td>
                  <Td className={num} title={formatINR(r.ltvInr)}>
                    {formatINRCompact(r.ltvInr)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </Section>
  );
}

// 14 --------------------------------------------------------------------------

export function DataHealthSection({ data, className }: { data: DataHealth; className?: string }) {
  const items = [
    {
      key: "unrated",
      icon: Star,
      label: UNRATED_LABEL,
      value: count(data.unrated),
      hint: data.unrated ? `${plural(data.unratedCustomers, "paying customer")} among them` : "Everyone has a rating",
      href: "/contacts?unrated=1" as string | null,
      warn: data.unratedCustomers > 0,
    },
    {
      key: "unverified",
      icon: ShieldCheck,
      label: "Unverified payments",
      value: count(data.unverified.count),
      hint: data.unverified.count
        ? `${formatINRCompact(data.unverified.inr)} waiting${data.unverified.stale ? ` · ${count(data.unverified.stale)} over ${plural(data.unverified.staleDays, "day")}` : ""}`
        : "All verified",
      href: "/payments?tab=unverified",
      warn: data.unverified.stale > 0,
    },
    {
      key: "duplicates",
      icon: Copy,
      label: "Possible duplicates",
      value: count(data.duplicates),
      hint: data.duplicates ? "Waiting for review" : "Nothing to review",
      href: "/duplicates",
      warn: false,
    },
  ];
  return (
    <Section
      id="data-health"
      title="Data health"
      why="Unrated contacts, unverified payments, possible duplicates."
      scope={NOW}
      className={className}
    >
      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((i) => {
          const Icon = i.icon;
          const inner = (
            <>
              <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{i.label}</span>
                <span className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                  {i.warn && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Needs attention" />}
                  {i.hint}
                </span>
              </span>
              <span className="tabular text-xl font-semibold">{i.value}</span>
            </>
          );
          return (
            <li key={i.key}>
              {i.href ? (
                <Link
                  href={i.href}
                  className="flex items-center gap-3 px-3 py-3 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {inner}
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                </Link>
              ) : (
                <div className="flex items-center gap-3 px-3 py-3">
                  {inner}
                  <span className="w-4 shrink-0" aria-hidden />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {data.contacts > 0 && (
        <p className="mt-3 text-xs text-muted">
          Unrated: no rating of any kind, from sales, a self-rating or an import ({share(data.unrated / data.contacts)} of{" "}
          {plural(data.contacts, "contact")}).
        </p>
      )}
    </Section>
  );
}

// Lost reasons ----------------------------------------------------------------

export function LostReasonsSection({ data, range, className }: { data: LostReasons; range: DashboardRange; className?: string }) {
  const max = Math.max(1, ...data.rows.map((r) => r.contacts));
  return (
    <Section
      id="lost-reasons"
      title="Lost reasons"
      why="Why people said no: product feedback from every contact marked Lost."
      scope={range.label}
      className={className}
    >
      {data.total === 0 ? (
        <SectionEmpty title="Nobody was marked Lost in this period">When a salesperson marks someone Lost, the reason they chose shows up here.</SectionEmpty>
      ) : (
        <>
          <p className="mb-3 text-sm">
            <span className="font-semibold">{plural(data.total, "contact")}</span>
            <span className="text-muted"> marked Lost and still lost</span>
          </p>
          <ul className="space-y-1.5" aria-label="Contacts marked Lost by reason">
            {data.rows.map((r) => (
              <li key={r.reason || "none"} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
                <span className={cn("truncate", r.reason === "" && "text-muted")}>{r.label}</span>
                <span aria-hidden className="h-2 overflow-hidden rounded-full bg-surface-muted">
                  <span className="block h-full rounded-full" style={{ width: `${(r.contacts / max) * 100}%`, background: VIZ.series1 }} />
                </span>
                <span className="tabular text-right font-medium">
                  {count(r.contacts)} <span className="text-xs font-normal text-muted">({share(r.contacts / data.total)})</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Counted by when they were marked Lost. People who came back since are left out.</p>
        </>
      )}
    </Section>
  );
}
