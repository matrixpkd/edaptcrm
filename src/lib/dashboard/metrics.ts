import "server-only";
/**
 * The growth cockpit's numbers (spec "Dashboard: the growth cockpit"). Every metric is one or two SQL aggregates
 * grouped in Postgres, so the dashboard stays fast on 50k contacts / 100k purchases; nothing here loops over rows
 * in JavaScript except the handful of grouped results.
 *
 * Shared definitions
 * - Revenue = verified payments minus verified refunds, in INR as stored on each payment (amount_inr, at that
 *   month's rate), exactly like LTV. Unverified, scheduled and rejected rows never count.
 * - Revenue is dated by when the money moved: paid_at (the payment or refund date), falling back to verified_at,
 *   then created_at. A bank transfer made on 30 Sep and verified on 2 Oct counts in September, the month the
 *   customer paid, so the figure for last month can still grow a little while verifications catch up. This is the
 *   same date the weekly summary and LTV facts use.
 * - A customer is a contact with at least one paid or part-paid purchase (contacts.purchase_count > 0).
 * - Merged-away contacts never count (their child rows already moved to the surviving contact).
 * - Calculated columns (ltv_inr, expected_90d_inr, at_risk, network_value_inr, ...) are read as stored; they are
 *   written by recomputeContact and refreshed nightly.
 *
 * Each function takes the range (or `now`) and an optional `tx`, so tests can run them inside one transaction.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { getSettings, labelFor } from "@/lib/settings";
import type { ProductFamily, Rung } from "@/lib/settings/defaults";
import { monthRange, trailingMonths, type DashboardRange } from "./period";

/** Umer familiarity levels counted as "beyond Umer" (spec: familiarity 0 to 2). */
export const BEYOND_UMER_MAX_LEVEL = 2;
/** The language key that is not "expansion" (settings lists.languages: Malayalam). */
export const HOME_LANGUAGE = "ml";
/** Months shown on the Beyond-Umer trend line. */
export const TREND_MONTHS = 6;
/** Rows on the referral leaderboard. */
export const LEADERBOARD_SIZE = 10;
/** ownership_log reason written by handoverAllContacts (src/lib/contacts/assignment.ts) when someone leaves. */
const HANDOVER_REASON = "Owner left the team";
/** Purchase statuses that count as bought (money verified in full or in part). */
const COUNTED = sql.raw(`('paid', 'partial')`);

type TimeRange = Pick<DashboardRange, "start" | "end">;
type CompareRange = Pick<DashboardRange, "start" | "end" | "prevStart" | "prevEnd" | "prevToDateEnd">;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const money = (v: unknown): number => Math.round(num(v) * 100) / 100;
const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** Net INR of a payment row aliased `p`: refunds count negative. */
const NET = sql.raw(`(case when p.kind = 'refund' then -p.amount_inr else p.amount_inr end)`);
/** When the money moved, for a payment row aliased `p`. */
const MOVED_AT = sql.raw(`coalesce(p.paid_at, p.verified_at, p.created_at)`);

function familyOrder(ladder: ProductFamily[], key: string): number {
  const i = ladder.findIndex((f) => f.key === key);
  return i === -1 ? ladder.length : i;
}

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

export type RevenueTotals = {
  /** revenue in the selected period */
  current: number;
  /** revenue in the whole previous period */
  previous: number;
  /** revenue in the previous period up to the same elapsed point (1-13 Sep against 1-13 Oct) */
  previousToDate: number;
};
export type FamilyRevenueRow = RevenueTotals & { family: string; label: string; rung: number | null };
export type RevenueByFamily = { rows: FamilyRevenueRow[]; totals: RevenueTotals };

/**
 * Revenue by product family (purchases.family, the family at the time of sale) for the period and the period
 * before it. With the default period that is "revenue this month vs last". Families are ordered as the ladder
 * in settings; families with no money in either period are left out.
 */
export async function revenueByFamily(range: CompareRange, tx: Tx = db): Promise<RevenueByFamily> {
  const { "ladder.families": ladder } = await getSettings(["ladder.families"], tx);
  const rows = await tx.execute<{ family: string; current: string; previous: string; previous_to_date: string }>(sql`
    select pu.family,
      coalesce(sum(${NET}) filter (where ${MOVED_AT} >= ${ts(range.start)}), 0) as current,
      coalesce(sum(${NET}) filter (where ${MOVED_AT} >= ${ts(range.prevStart)} and ${MOVED_AT} < ${ts(range.prevEnd)}), 0) as previous,
      coalesce(sum(${NET}) filter (where ${MOVED_AT} >= ${ts(range.prevStart)} and ${MOVED_AT} < ${ts(range.prevToDateEnd)}), 0) as previous_to_date
    from payments p
    join purchases pu on pu.id = p.purchase_id
    where p.status = 'verified'
      and ${MOVED_AT} >= ${ts(range.prevStart)}
      and ${MOVED_AT} < ${ts(range.end)}
    group by pu.family
  `);
  const out: FamilyRevenueRow[] = rows
    .map((r) => {
      const fam = ladder.find((f) => f.key === r.family);
      return {
        family: r.family,
        label: fam?.label ?? r.family,
        rung: fam?.rung ?? null,
        current: money(r.current),
        previous: money(r.previous),
        previousToDate: money(r.previous_to_date),
      };
    })
    .filter((r) => r.current !== 0 || r.previous !== 0)
    .sort((a, b) => familyOrder(ladder, a.family) - familyOrder(ladder, b.family) || a.label.localeCompare(b.label));
  const totals = out.reduce<RevenueTotals>(
    (t, r) => ({
      current: t.current + r.current,
      previous: t.previous + r.previous,
      previousToDate: t.previousToDate + r.previousToDate,
    }),
    { current: 0, previous: 0, previousToDate: 0 },
  );
  return {
    rows: out,
    totals: { current: money(totals.current), previous: money(totals.previous), previousToDate: money(totals.previousToDate) },
  };
}

/** New paying customers: contacts whose first paid purchase falls in the period (and the previous period). */
export async function newCustomers(range: CompareRange, tx: Tx = db): Promise<RevenueTotals> {
  const [r] = await tx.execute<{ current: string; previous: string; previous_to_date: string }>(sql`
    select
      count(*) filter (where c.first_purchase_at >= ${ts(range.start)}) as current,
      count(*) filter (where c.first_purchase_at < ${ts(range.prevEnd)}) as previous,
      count(*) filter (where c.first_purchase_at < ${ts(range.prevToDateEnd)}) as previous_to_date
    from contacts c
    where c.merged_into_id is null
      and c.first_purchase_at >= ${ts(range.prevStart)}
      and c.first_purchase_at < ${ts(range.end)}
  `);
  return { current: num(r?.current), previous: num(r?.previous), previousToDate: num(r?.previous_to_date) };
}

// ---------------------------------------------------------------------------
// Leads and conversion by channel
// ---------------------------------------------------------------------------

export type ChannelRow = {
  /** channel key; "" when the contact has no first channel recorded */
  channel: string;
  label: string;
  /** contacts created in the period whose FIRST channel is this one */
  leads: number;
  /** of those, how many are paying customers now */
  converted: number;
  conversion: number | null;
  /** every enquiry received on this channel in the period (new and returning contacts) */
  enquiries: number;
  /** distinct contacts behind those enquiries */
  enquiringContacts: number;
};
export type LeadsByChannel = {
  rows: ChannelRow[];
  totals: { leads: number; converted: number; conversion: number | null; enquiries: number };
  /** contacts created in the period that are not counted as leads: imported records and people who had already paid */
  notLeads: { imported: number; alreadyCustomers: number };
};

/**
 * A contact created at `c` counts as a lead unless it was brought in by an import (old records, not inbound
 * leads; an import of 50,000 historic rows must not read as 50,000 new leads) or it had already paid more than a
 * day before the CRM first saw it (history). The day of slack keeps checkout buyers, whose order can be stamped
 * a little before the contact row, as converted leads. The calibration report uses the same history rule.
 */
const IS_LEAD = sql.raw(
  `(c.import_batch_id is null and (c.first_purchase_at is null or c.first_purchase_at >= c.created_at - interval '1 day'))`,
);

/**
 * Leads created in the period by their first channel, and the share that became paying customers (by now),
 * plus every enquiry received in the period by channel. Rows are sorted by leads, then enquiries.
 */
export async function leadsAndConversionByChannel(range: TimeRange, tx: Tx = db): Promise<LeadsByChannel> {
  const { "lists.channels": channels } = await getSettings(["lists.channels"], tx);
  const [leads, enq] = await Promise.all([
    tx.execute<{ channel: string; leads: string; converted: string; imported: string; already: string }>(sql`
      select coalesce(c.first_channel, '') as channel,
        count(*) filter (where ${IS_LEAD}) as leads,
        count(*) filter (where ${IS_LEAD} and c.purchase_count > 0) as converted,
        count(*) filter (where c.import_batch_id is not null) as imported,
        count(*) filter (where not ${IS_LEAD} and c.import_batch_id is null) as already
      from contacts c
      where c.merged_into_id is null
        and c.created_at >= ${ts(range.start)} and c.created_at < ${ts(range.end)}
      group by 1
    `),
    tx.execute<{ channel: string; enquiries: string; people: string }>(sql`
      select e.channel, count(*) as enquiries, count(distinct e.contact_id) as people
      from enquiries e
      where e.received_at >= ${ts(range.start)} and e.received_at < ${ts(range.end)}
      group by e.channel
    `),
  ]);
  const by = new Map<string, ChannelRow>();
  const row = (key: string): ChannelRow => {
    let r = by.get(key);
    if (!r) {
      r = {
        channel: key,
        label: key ? labelFor(channels, key) : "Not recorded",
        leads: 0,
        converted: 0,
        conversion: null,
        enquiries: 0,
        enquiringContacts: 0,
      };
      by.set(key, r);
    }
    return r;
  };
  const notLeads = { imported: 0, alreadyCustomers: 0 };
  for (const l of leads) {
    notLeads.imported += num(l.imported);
    notLeads.alreadyCustomers += num(l.already);
    if (num(l.leads) === 0) continue;
    const r = row(l.channel);
    r.leads = num(l.leads);
    r.converted = num(l.converted);
    r.conversion = ratio(r.converted, r.leads);
  }
  for (const e of enq) {
    const r = row(e.channel ?? "");
    r.enquiries = num(e.enquiries);
    r.enquiringContacts = num(e.people);
  }
  const rows = [...by.values()].sort(
    (a, b) => b.leads - a.leads || b.enquiries - a.enquiries || a.label.localeCompare(b.label),
  );
  const t = rows.reduce((s, r) => ({ leads: s.leads + r.leads, converted: s.converted + r.converted, enquiries: s.enquiries + r.enquiries }), {
    leads: 0,
    converted: 0,
    enquiries: 0,
  });
  return { rows, totals: { ...t, conversion: ratio(t.converted, t.leads) }, notLeads };
}

// ---------------------------------------------------------------------------
// LTV by First Door
// ---------------------------------------------------------------------------

export type DoorRow = {
  door: string;
  label: string;
  /** every contact who came through this door */
  contacts: number;
  /** paying customers among them */
  customers: number;
  /** customers / contacts */
  conversion: number | null;
  totalLtvInr: number;
  /** total LTV / customers */
  avgLtvInr: number | null;
};
export type LtvByDoor = { rows: DoorRow[]; totals: { contacts: number; customers: number; totalLtvInr: number; avgLtvInr: number | null } };

/** All-time customers, total and average LTV (stored ltv_inr) by First Door. Sorted by total LTV. */
export async function ltvByFirstDoor(tx: Tx = db): Promise<LtvByDoor> {
  const { "lists.firstDoors": doors } = await getSettings(["lists.firstDoors"], tx);
  const rows = await tx.execute<{ door: string; contacts: string; customers: string; ltv: string }>(sql`
    select c.first_door as door,
      count(*) as contacts,
      count(*) filter (where c.purchase_count > 0) as customers,
      coalesce(sum(c.ltv_inr) filter (where c.purchase_count > 0), 0) as ltv
    from contacts c
    where c.merged_into_id is null
    group by c.first_door
  `);
  const out: DoorRow[] = rows
    .map((r) => {
      const customers = num(r.customers);
      const total = money(r.ltv);
      return {
        door: r.door,
        label: labelFor(doors, r.door),
        contacts: num(r.contacts),
        customers,
        conversion: ratio(customers, num(r.contacts)),
        totalLtvInr: total,
        avgLtvInr: customers ? money(total / customers) : null,
      };
    })
    .sort((a, b) => b.totalLtvInr - a.totalLtvInr || b.customers - a.customers || a.label.localeCompare(b.label));
  const contacts = out.reduce((s, r) => s + r.contacts, 0);
  const customers = out.reduce((s, r) => s + r.customers, 0);
  const totalLtvInr = money(out.reduce((s, r) => s + r.totalLtvInr, 0));
  return { rows: out, totals: { contacts, customers, totalLtvInr, avgLtvInr: customers ? money(totalLtvInr / customers) : null } };
}

// ---------------------------------------------------------------------------
// Repeat rate
// ---------------------------------------------------------------------------

/** Share of customers (all time) with two or more paid purchases. */
export async function repeatRate(tx: Tx = db): Promise<{ customers: number; repeaters: number; rate: number | null }> {
  const [r] = await tx.execute<{ customers: string; repeaters: string }>(sql`
    select count(*) filter (where c.purchase_count >= 1) as customers,
           count(*) filter (where c.purchase_count >= 2) as repeaters
    from contacts c
    where c.merged_into_id is null and c.purchase_count >= 1
  `);
  const customers = num(r?.customers);
  const repeaters = num(r?.repeaters);
  return { customers, repeaters, rate: ratio(repeaters, customers) };
}

/**
 * Median days from first to second paid purchase, over customers with two or more (purchases ordered like the
 * cohort builder: purchased_at, then created_at, then id). Computed live; settings metrics.cohorts holds last
 * night's copy.
 */
export async function medianDaysFirstToSecond(tx: Tx = db): Promise<{ medianDays: number | null; customers: number }> {
  const [r] = await tx.execute<{ median_days: string | null; n: string }>(sql`
    with p as (
      select pu.purchased_at,
        row_number() over w as k,
        lead(pu.purchased_at) over w as next_at
      from purchases pu
      join contacts c on c.id = pu.contact_id and c.merged_into_id is null and c.purchase_count >= 2
      where pu.status in ${COUNTED}
      window w as (partition by pu.contact_id order by pu.purchased_at, pu.created_at, pu.id)
    )
    select percentile_cont(0.5) within group (order by extract(epoch from (next_at - purchased_at)) / 86400.0) as median_days,
      count(*) as n
    from p
    where k = 1 and next_at is not null
  `);
  const median = r?.median_days === null || r?.median_days === undefined ? null : Number(r.median_days);
  return { medianDays: median === null || !Number.isFinite(median) ? null : Math.round(median * 10) / 10, customers: num(r?.n) };
}

// ---------------------------------------------------------------------------
// Rung moves
// ---------------------------------------------------------------------------

export type RungMove = { from: number; to: number; fromLabel: string; toLabel: string; customers: number };
export type RungMoves = {
  moves: RungMove[];
  /** customers who were already on the ladder and reached a higher rung in the period */
  climbed: number;
  /** first-time buyers who stepped onto the ladder in the period */
  entered: number;
};

/**
 * Customers whose highest rung rose in the period, from which rung to which. Derived from purchases: the highest
 * rung (settings ladder.families) bought before the period starts against the highest bought by its end. Rung 0
 * means "not on the ladder yet" (no purchase, or only side groups such as B2B or delegation).
 */
export async function rungMoves(range: TimeRange, tx: Tx = db): Promise<RungMoves> {
  const s = await getSettings(["ladder.families", "ladder.rungs"], tx);
  const rungOf: Record<string, number> = {};
  for (const f of s["ladder.families"]) if (typeof f.rung === "number") rungOf[f.key] = f.rung;
  const rows = await tx.execute<{ from_rung: string; to_rung: string; n: string }>(sql`
    with buyers as (
      select distinct pu.contact_id
      from purchases pu
      where pu.status in ${COUNTED}
        and pu.purchased_at >= ${ts(range.start)} and pu.purchased_at < ${ts(range.end)}
    ),
    agg as (
      select pu.contact_id,
        coalesce(max((${JSON.stringify(rungOf)}::jsonb ->> pu.family)::int) filter (where pu.purchased_at < ${ts(range.start)}), 0) as from_rung,
        coalesce(max((${JSON.stringify(rungOf)}::jsonb ->> pu.family)::int), 0) as to_rung
      from purchases pu
      join buyers b on b.contact_id = pu.contact_id
      join contacts c on c.id = pu.contact_id and c.merged_into_id is null
      where pu.status in ${COUNTED} and pu.purchased_at < ${ts(range.end)}
      group by pu.contact_id
    )
    select from_rung, to_rung, count(*) as n
    from agg
    where to_rung > from_rung
    group by from_rung, to_rung
    order by from_rung, to_rung
  `);
  const label = (rung: number) => (rung === 0 ? "Not on the ladder" : rungLabel(s["ladder.rungs"], rung));
  const moves = rows.map((r) => {
    const from = num(r.from_rung);
    const to = num(r.to_rung);
    return { from, to, fromLabel: label(from), toLabel: label(to), customers: num(r.n) };
  });
  return {
    moves,
    climbed: moves.filter((m) => m.from > 0).reduce((a, m) => a + m.customers, 0),
    entered: moves.filter((m) => m.from === 0).reduce((a, m) => a + m.customers, 0),
  };
}

/** Rung moves for the current calendar month in the given time zone. */
export async function rungMovesThisMonth(now: Date, timeZone: string, tx: Tx = db): Promise<RungMoves> {
  return rungMoves(monthRange(now, timeZone), tx);
}

function rungLabel(rungs: Rung[], rung: number): string {
  const r = rungs.find((x) => x.rung === rung);
  return r ? `Rung ${rung}: ${r.label}` : `Rung ${rung}`;
}

// ---------------------------------------------------------------------------
// Forecast and at-risk pool
// ---------------------------------------------------------------------------

/** 90-day revenue forecast: the sum of expected_90d_inr (repeat probability x next best offer price). */
export async function forecast90d(tx: Tx = db): Promise<{ totalInr: number; customers: number }> {
  const [r] = await tx.execute<{ total: string; customers: string }>(sql`
    select coalesce(sum(c.expected_90d_inr), 0) as total,
           count(*) filter (where c.expected_90d_inr > 0) as customers
    from contacts c
    where c.merged_into_id is null and c.expected_90d_inr is not null
  `);
  return { totalInr: money(r?.total), customers: num(r?.customers) };
}

/** Customers past their expected purchase date by thresholds.atRiskDays (stored at_risk), with their expected value. */
export async function atRiskPool(tx: Tx = db): Promise<{ count: number; expectedInr: number; ltvInr: number }> {
  const [r] = await tx.execute<{ n: string; expected: string; ltv: string }>(sql`
    select count(*) as n,
           coalesce(sum(c.expected_90d_inr), 0) as expected,
           coalesce(sum(c.ltv_inr), 0) as ltv
    from contacts c
    where c.merged_into_id is null and c.at_risk
  `);
  return { count: num(r?.n), expectedInr: money(r?.expected), ltvInr: money(r?.ltv) };
}

// ---------------------------------------------------------------------------
// Abandoned checkouts
// ---------------------------------------------------------------------------

export type CheckoutRecovery = {
  /** checkouts that passed the abandoned-checkout window without a completed order (still open + recovered) */
  abandoned: number;
  /** of those, recovered: the customer paid afterwards */
  recovered: number;
  /** abandoned and not (yet) recovered */
  stillOpen: number;
  recoveryRate: number | null;
  /** verified net money on the purchase that recovered each checkout */
  revenueSavedInr: number;
  /** distinct purchases behind revenueSavedInr */
  recoveringPurchases: number;
};

/**
 * Abandoned checkouts started in the period and how many were recovered. Checkout enquiries are marked
 * "abandoned" by the alert job and "recovered" by the money module when the customer later pays
 * (see checkoutResolution). Revenue saved is the verified net money (INR) on the first purchase each recovered
 * contact made at or after the checkout started; a purchase recovering two checkouts counts once.
 */
export async function abandonedCheckoutsRecovered(range: TimeRange, tx: Tx = db): Promise<CheckoutRecovery> {
  const [r] = await tx.execute<{ abandoned: string; recovered: string; saved: string; purchases: string }>(sql`
    with e as (
      select e.contact_id, e.received_at, e.status
      from enquiries e
      where e.status in ('abandoned', 'recovered')
        and e.received_at >= ${ts(range.start)} and e.received_at < ${ts(range.end)}
    ),
    rec as (
      select distinct fp.id
      from e
      cross join lateral (
        select pu.id
        from purchases pu
        where pu.contact_id = e.contact_id
          and pu.purchased_at >= e.received_at
          and pu.status in ('paid', 'partial', 'refunded')
        order by pu.purchased_at, pu.created_at, pu.id
        limit 1
      ) fp
      where e.status = 'recovered'
    )
    select
      (select count(*) from e) as abandoned,
      (select count(*) from e where status = 'recovered') as recovered,
      (select coalesce(sum(${NET}), 0) from payments p where p.status = 'verified' and p.purchase_id in (select id from rec)) as saved,
      (select count(*) from rec) as purchases
  `);
  const abandoned = num(r?.abandoned);
  const recovered = num(r?.recovered);
  return {
    abandoned,
    recovered,
    stillOpen: abandoned - recovered,
    recoveryRate: ratio(recovered, abandoned),
    revenueSavedInr: money(r?.saved),
    recoveringPurchases: num(r?.purchases),
  };
}

// ---------------------------------------------------------------------------
// Assisted vs self-serve (ownership rule 6)
// ---------------------------------------------------------------------------

export type RevenueSplit = {
  inr: number;
  /** purchases with a verified payment in the period (refunds lower the revenue, not these counts) */
  purchases: number;
  /** customers with a verified payment in the period */
  customers: number;
  /** revenue per paying customer */
  perCustomerInr: number | null;
};
export type AssistedSplit = { assisted: RevenueSplit; selfServe: RevenueSplit; totalInr: number; assistedShare: number | null };

/**
 * Revenue in the period split by sales credit on the purchase: assisted (credited to the owner who talked to the
 * customer in the 30 days before, or adjusted by a manager) vs self-serve.
 */
export async function assistedVsSelfServe(range: TimeRange, tx: Tx = db): Promise<AssistedSplit> {
  const rows = await tx.execute<{ assisted: boolean | string; inr: string; purchases: string; customers: string }>(sql`
    select pu.assisted,
      coalesce(sum(${NET}), 0) as inr,
      count(distinct pu.id) filter (where p.kind = 'payment') as purchases,
      count(distinct pu.contact_id) filter (where p.kind = 'payment') as customers
    from payments p
    join purchases pu on pu.id = p.purchase_id
    where p.status = 'verified'
      and ${MOVED_AT} >= ${ts(range.start)} and ${MOVED_AT} < ${ts(range.end)}
    group by pu.assisted
  `);
  const split = (assisted: boolean): RevenueSplit => {
    const r = rows.find((x) => (x.assisted === true || x.assisted === "true" || x.assisted === "t") === assisted);
    const inr = money(r?.inr);
    const customers = num(r?.customers);
    return { inr, purchases: num(r?.purchases), customers, perCustomerInr: customers ? money(inr / customers) : null };
  };
  const assisted = split(true);
  const selfServe = split(false);
  const totalInr = money(assisted.inr + selfServe.inr);
  return { assisted, selfServe, totalInr, assistedShare: ratio(assisted.inr, totalInr) };
}

// ---------------------------------------------------------------------------
// Team view
// ---------------------------------------------------------------------------

export type TeamRow = {
  userId: string;
  name: string;
  role: string;
  active: boolean;
  /** lead assignments in the period (contacts with no purchase before they were assigned) */
  assigned: number;
  /** assignments the new owner followed up with an interaction */
  responded: number;
  /** median hours from assignment to the owner's first interaction (responded assignments only) */
  medianResponseHours: number | null;
  /** distinct contacts the person logged an interaction with in the period */
  handled: number;
  interactions: number;
  /** distinct leads assigned in the period */
  leads: number;
  /** of those, how many have paid since */
  converted: number;
  conversion: number | null;
  /** verified net revenue in the period on purchases credited to this person */
  assistedInr: number;
};

/**
 * Per person (sales, managers and admins; support never owns or sells):
 * - first-response time: median hours from each lead assignment in the period (ownership_log) to that owner's
 *   first interaction with the contact (when it happened, or when it was logged if that was earlier, never before
 *   the assignment); reassignments count as new assignments, customers being reassigned do not, and neither do
 *   bulk moves (a leaver's handover, owners given by an import);
 * - contacts handled: distinct contacts with an interaction they logged in the period;
 * - conversion: leads assigned to them in the period that have paid since;
 * - assisted revenue: money in the period on purchases credited to them.
 * Active salespeople always appear (an idle week shows as zeros); others only when they have numbers.
 */
export async function teamView(range: TimeRange, tx: Tx = db): Promise<TeamRow[]> {
  const [people, assigned, handled, revenue] = await Promise.all([
    tx.execute<{ id: string; name: string; role: string; active: boolean | string }>(sql`
      select u.id::text, u.name, u.role, u.active from users u where u.role <> 'support'
    `),
    tx.execute<{ user_id: string; assigned: string; responded: string; median_hours: string | null; leads: string; converted: string }>(sql`
      with a as (
        select ol.to_user_id as user_id, ol.contact_id, ol.changed_at, c.first_purchase_at,
          -- a call logged right after the lead was added (occurred a few minutes before it, logged after) counts as
          -- an immediate response; interactions both made and logged before the assignment belong to someone else's turn
          (select min(greatest(ol.changed_at, least(i.occurred_at, i.created_at))) from interactions i
            where i.contact_id = ol.contact_id and i.user_id = ol.to_user_id
              and (i.occurred_at >= ol.changed_at or i.created_at >= ol.changed_at)) as first_at
        from ownership_log ol
        join contacts c on c.id = ol.contact_id and c.merged_into_id is null
        where ol.to_user_id is not null
          and ol.changed_at >= ${ts(range.start)} and ol.changed_at < ${ts(range.end)}
          and (c.first_purchase_at is null or c.first_purchase_at > ol.changed_at)
          -- bulk moves are not leads handed to someone: a leaver's book moving to the manager (handoverAllContacts)
          -- and the owners an import gives to old records (the imported contact's first owner, or "Import: ...")
          and ol.reason <> ${HANDOVER_REASON}
          and ol.reason not like 'Import:%'
          and not (c.import_batch_id is not null and not exists (
            select 1 from ownership_log o2 where o2.contact_id = ol.contact_id and o2.changed_at < ol.changed_at))
      )
      select a.user_id::text,
        count(*) as assigned,
        count(a.first_at) as responded,
        percentile_cont(0.5) within group (order by extract(epoch from (a.first_at - a.changed_at)) / 3600.0) as median_hours,
        count(distinct a.contact_id) as leads,
        count(distinct a.contact_id) filter (where a.first_purchase_at is not null) as converted
      from a
      group by a.user_id
    `),
    tx.execute<{ user_id: string; handled: string; interactions: string }>(sql`
      select i.user_id::text, count(distinct i.contact_id) as handled, count(*) as interactions
      from interactions i
      where i.user_id is not null
        and i.occurred_at >= ${ts(range.start)} and i.occurred_at < ${ts(range.end)}
      group by i.user_id
    `),
    tx.execute<{ user_id: string; inr: string }>(sql`
      select pu.credited_user_id::text as user_id, coalesce(sum(${NET}), 0) as inr
      from payments p
      join purchases pu on pu.id = p.purchase_id
      where p.status = 'verified' and pu.assisted and pu.credited_user_id is not null
        and ${MOVED_AT} >= ${ts(range.start)} and ${MOVED_AT} < ${ts(range.end)}
      group by pu.credited_user_id
    `),
  ]);
  const aBy = new Map(assigned.map((r) => [r.user_id, r]));
  const hBy = new Map(handled.map((r) => [r.user_id, r]));
  const rBy = new Map(revenue.map((r) => [r.user_id, r]));
  const rows: TeamRow[] = [];
  for (const p of people) {
    const a = aBy.get(p.id);
    const h = hBy.get(p.id);
    const active = p.active === true || p.active === "true" || p.active === "t";
    const leads = num(a?.leads);
    const converted = num(a?.converted);
    const median = a?.median_hours === null || a?.median_hours === undefined ? null : Number(a.median_hours);
    const row: TeamRow = {
      userId: p.id,
      name: p.name,
      role: p.role,
      active,
      assigned: num(a?.assigned),
      responded: num(a?.responded),
      medianResponseHours: median === null || !Number.isFinite(median) ? null : Math.round(median * 10) / 10,
      handled: num(h?.handled),
      interactions: num(h?.interactions),
      leads,
      converted,
      conversion: ratio(converted, leads),
      assistedInr: money(rBy.get(p.id)?.inr),
    };
    const hasNumbers = row.assigned > 0 || row.handled > 0 || row.assistedInr !== 0;
    if ((p.role === "sales" && active) || hasNumbers) rows.push(row);
  }
  return rows.sort(
    (a, b) => b.assistedInr - a.assistedInr || b.handled - a.handled || b.assigned - a.assigned || a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Beyond-Umer revenue share
// ---------------------------------------------------------------------------

export type UmerSplit = {
  /** revenue from customers at Umer familiarity 0..2 */
  beyondInr: number;
  /** revenue from customers at familiarity 3..5 */
  circleInr: number;
  /** revenue from customers whose familiarity is not rated: left out of the share, shown separately */
  unratedInr: number;
  /** beyond / (beyond + circle); null when no rated revenue */
  share: number | null;
};
export type BeyondUmer = {
  current: UmerSplit;
  previous: UmerSplit;
  /** one point per calendar month (viewer's time zone), the last TREND_MONTHS months up to the period's end */
  trend: (UmerSplit & { month: string; label: string })[];
};

function umerSplit(beyond: number, circle: number, unrated: number): UmerSplit {
  return {
    beyondInr: money(beyond),
    circleInr: money(circle),
    unratedInr: money(unrated),
    share: ratio(beyond, beyond + circle),
  };
}

/**
 * Share of revenue from customers who barely know Umer (familiarity 0 to 2), for the period, the previous period
 * and month by month. Uses each customer's CURRENT familiarity (the latest rating), not the level when they paid.
 * Unrated customers are excluded from the share and reported separately, so a rating backlog cannot move it.
 */
export async function beyondUmerShare(range: CompareRange & { timeZone?: string }, tx: Tx = db): Promise<BeyondUmer> {
  const tz = range.timeZone ?? "Asia/Kolkata";
  const months = trailingMonths(range.end, TREND_MONTHS, tz);
  const trendStart = months[0].start;
  // the last month stops where the period stops, so its point matches the headline share
  const trendEnd = new Date(Math.min(months[months.length - 1].end.getTime(), range.end.getTime()));
  const bucket = sql.raw(
    `case when c.umer_level is null then 'unrated' when c.umer_level <= ${BEYOND_UMER_MAX_LEVEL} then 'beyond' else 'circle' end`,
  );
  const [periods, trend] = await Promise.all([
    tx.execute<{ bucket: string; current: string; previous: string }>(sql`
      select ${bucket} as bucket,
        coalesce(sum(${NET}) filter (where ${MOVED_AT} >= ${ts(range.start)}), 0) as current,
        coalesce(sum(${NET}) filter (where ${MOVED_AT} < ${ts(range.prevEnd)}), 0) as previous
      from payments p
      join contacts c on c.id = p.contact_id
      where p.status = 'verified'
        and ${MOVED_AT} >= ${ts(range.prevStart)} and ${MOVED_AT} < ${ts(range.end)}
      group by 1
    `),
    tx.execute<{ month: string; bucket: string; inr: string }>(sql`
      select to_char(${MOVED_AT} at time zone ${tz}, 'YYYY-MM') as month, ${bucket} as bucket, coalesce(sum(${NET}), 0) as inr
      from payments p
      join contacts c on c.id = p.contact_id
      where p.status = 'verified'
        and ${MOVED_AT} >= ${ts(trendStart)} and ${MOVED_AT} < ${ts(trendEnd)}
      group by 1, 2
    `),
  ]);
  const pick = (b: string, f: "current" | "previous") => num(periods.find((r) => r.bucket === b)?.[f]);
  const cell = (m: string, b: string) => num(trend.find((r) => r.month === m && r.bucket === b)?.inr);
  return {
    current: umerSplit(pick("beyond", "current"), pick("circle", "current"), pick("unrated", "current")),
    previous: umerSplit(pick("beyond", "previous"), pick("circle", "previous"), pick("unrated", "previous")),
    trend: months.map((m) => ({
      month: m.key,
      label: m.label,
      ...umerSplit(cell(m.key, "beyond"), cell(m.key, "circle"), cell(m.key, "unrated")),
    })),
  };
}

// ---------------------------------------------------------------------------
// Language mix (the expansion meter)
// ---------------------------------------------------------------------------

export type LanguageRow = { language: string; label: string; customers: number; newCustomers: number };
export type LanguageMix = {
  rows: LanguageRow[];
  /** customers with a preferred language recorded */
  known: number;
  /** of those, not Malayalam */
  nonMalayalam: number;
  /** customers with no preferred language recorded: excluded from the share */
  unknown: number;
  /** nonMalayalam / known */
  share: number | null;
  /** the same share among customers whose first purchase was in the period */
  newShare: number | null;
  newKnown: number;
};

/**
 * Preferred language of paying customers (all time, and new customers in the period). The share who don't speak
 * Malayalam tracks the move beyond the Malayali market; customers with no language recorded are shown separately.
 */
export async function languageMix(range: TimeRange, tx: Tx = db): Promise<LanguageMix> {
  const { "lists.languages": languages } = await getSettings(["lists.languages"], tx);
  const rows = await tx.execute<{ language: string; customers: string; new_customers: string }>(sql`
    select coalesce(nullif(c.language, ''), '') as language,
      count(*) as customers,
      count(*) filter (where c.first_purchase_at >= ${ts(range.start)} and c.first_purchase_at < ${ts(range.end)}) as new_customers
    from contacts c
    where c.merged_into_id is null and c.purchase_count > 0
    group by 1
  `);
  const out: LanguageRow[] = rows
    .map((r) => ({
      language: r.language,
      label: r.language ? labelFor(languages, r.language) : "Not recorded",
      customers: num(r.customers),
      newCustomers: num(r.new_customers),
    }))
    .sort((a, b) => Number(a.language === "") - Number(b.language === "") || b.customers - a.customers || a.label.localeCompare(b.label));
  const known = out.filter((r) => r.language !== "");
  const sum = (list: LanguageRow[], f: "customers" | "newCustomers") => list.reduce((s, r) => s + r[f], 0);
  const nonHome = known.filter((r) => r.language !== HOME_LANGUAGE);
  const knownN = sum(known, "customers");
  const newKnown = sum(known, "newCustomers");
  return {
    rows: out,
    known: knownN,
    nonMalayalam: sum(nonHome, "customers"),
    unknown: sum(out.filter((r) => r.language === ""), "customers"),
    share: ratio(sum(nonHome, "customers"), knownN),
    newShare: ratio(sum(nonHome, "newCustomers"), newKnown),
    newKnown,
  };
}

// ---------------------------------------------------------------------------
// Referral leaderboard
// ---------------------------------------------------------------------------

export type AdvocateRow = {
  contactId: string;
  name: string;
  /** referred contacts who have paid */
  referralCount: number;
  /** sum of the LTV of everyone they referred */
  networkValueInr: number;
  /** their own LTV */
  ltvInr: number;
  ownerName: string | null;
};
export type ReferralLeaderboard = { rows: AdvocateRow[]; advocates: number; totalNetworkInr: number };

/** Top advocates by network value (then paying referrals), plus how many advocates there are in total. */
export async function referralLeaderboard(limit: number = LEADERBOARD_SIZE, tx: Tx = db): Promise<ReferralLeaderboard> {
  const size = Math.max(1, Math.min(100, Math.floor(limit) || LEADERBOARD_SIZE));
  const [rows, [totals]] = await Promise.all([
    tx.execute<{ id: string; name: string; referral_count: string; network: string; ltv: string; owner_name: string | null }>(sql`
      select c.id::text, c.name, c.referral_count, c.network_value_inr as network, c.ltv_inr as ltv, u.name as owner_name
      from contacts c
      left join users u on u.id = c.owner_id
      where c.merged_into_id is null and (c.network_value_inr > 0 or c.referral_count > 0)
      order by c.network_value_inr desc, c.referral_count desc, c.name, c.id
      limit ${size}
    `),
    tx.execute<{ advocates: string; network: string }>(sql`
      select count(*) as advocates, coalesce(sum(c.network_value_inr), 0) as network
      from contacts c
      where c.merged_into_id is null and (c.network_value_inr > 0 or c.referral_count > 0)
    `),
  ]);
  return {
    rows: rows.map((r) => ({
      contactId: r.id,
      name: r.name,
      referralCount: num(r.referral_count),
      networkValueInr: money(r.network),
      ltvInr: money(r.ltv),
      ownerName: r.owner_name,
    })),
    advocates: num(totals?.advocates),
    totalNetworkInr: money(totals?.network),
  };
}

// ---------------------------------------------------------------------------
// Data health
// ---------------------------------------------------------------------------

export type DataHealth = {
  contacts: number;
  /** contacts with no rating at all: no ratings rows and none of the four scales set */
  unrated: number;
  unratedCustomers: number;
  unverified: { count: number; inr: number; stale: number; staleDays: number };
  /** open duplicate reviews where both contacts still exist (not merged away) */
  duplicates: number;
};

/** Unrated contacts, unverified manual payments (and those older than thresholds.unverifiedPaymentDays), possible duplicates. */
export async function dataHealth(now: Date, tx: Tx = db): Promise<DataHealth> {
  const { thresholds } = await getSettings(["thresholds"], tx);
  const staleDays = Math.max(0, Number(thresholds.unverifiedPaymentDays) || 0);
  const staleCutoff = new Date(now.getTime() - staleDays * 24 * 3600 * 1000);
  const [[ratings], [unv], [dups]] = await Promise.all([
    tx.execute<{ contacts: string; unrated: string; unrated_customers: string }>(sql`
      select count(*) as contacts,
        count(*) filter (where x.unrated) as unrated,
        count(*) filter (where x.unrated and x.customer) as unrated_customers
      from (
        select c.purchase_count > 0 as customer,
          (c.ai_level is null and c.umer_level is null and c.spending_band is null and c.gut_stars is null
            and not exists (select 1 from ratings r where r.contact_id = c.id)) as unrated
        from contacts c
        where c.merged_into_id is null
      ) x
    `),
    tx.execute<{ n: string; inr: string; stale: string }>(sql`
      select count(*) as n,
        coalesce(sum(p.amount_inr), 0) as inr,
        count(*) filter (where coalesce(p.paid_at, p.created_at) <= ${ts(staleCutoff)}) as stale
      from payments p
      join purchases pu on pu.id = p.purchase_id
      join contacts c on c.id = p.contact_id
      where p.kind = 'payment' and p.status = 'unverified' and pu.status <> 'cancelled' and c.merged_into_id is null
    `),
    tx.execute<{ n: string }>(sql`
      select count(*) as n
      from duplicate_reviews d
      join contacts a on a.id = d.contact_a_id and a.merged_into_id is null
      join contacts b on b.id = d.contact_b_id and b.merged_into_id is null
      where d.status = 'open'
    `),
  ]);
  return {
    contacts: num(ratings?.contacts),
    unrated: num(ratings?.unrated),
    unratedCustomers: num(ratings?.unrated_customers),
    unverified: { count: num(unv?.n), inr: money(unv?.inr), stale: num(unv?.stale), staleDays },
    duplicates: num(dups?.n),
  };
}

// ---------------------------------------------------------------------------
// Lost reasons (spec "Lifecycle stages": "Lost reasons show on the dashboard as product feedback")
// ---------------------------------------------------------------------------

export type LostReasonRow = { reason: string; label: string; contacts: number };
export type LostReasons = { rows: LostReasonRow[]; total: number };

/**
 * Contacts marked Lost in the period, by lost reason (settings lists.lostReasons). Uses each contact's current
 * stage: someone marked Lost who has since come back (a new enquiry or payment reopens them) is no longer counted.
 * Rows follow the order of the settings list; a reason no longer in the list keeps its key as the label.
 */
export async function lostReasons(range: TimeRange, tx: Tx = db): Promise<LostReasons> {
  const { "lists.lostReasons": reasons } = await getSettings(["lists.lostReasons"], tx);
  const rows = await tx.execute<{ reason: string; n: string }>(sql`
    select coalesce(c.lost_reason, '') as reason, count(*) as n
    from contacts c
    where c.merged_into_id is null and c.stage = 'lost'
      and c.stage_changed_at >= ${ts(range.start)} and c.stage_changed_at < ${ts(range.end)}
    group by 1
  `);
  const order = (key: string) => {
    const i = reasons.findIndex((r) => r.key === key);
    return key === "" ? reasons.length + 1 : i === -1 ? reasons.length : i;
  };
  const out: LostReasonRow[] = rows
    .map((r) => ({ reason: r.reason, label: r.reason ? labelFor(reasons, r.reason) : "No reason given", contacts: num(r.n) }))
    .sort((a, b) => b.contacts - a.contacts || order(a.reason) - order(b.reason));
  return { rows: out, total: out.reduce((s, r) => s + r.contacts, 0) };
}
