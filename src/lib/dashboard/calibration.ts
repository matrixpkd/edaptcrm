import "server-only";
/**
 * The calibration report: conversion and repeat rates by grade, Edapt Score band and each scoring input (the Value
 * inputs judged at each purchase, see VALUE_DIMENSIONS), so the weights in Settings > Scoring can be checked against
 * what actually happened.
 *
 * Populations (window = settings thresholds.repeatWindowDays, 90 days by default):
 * - Conversion: contacts created at least `window` days before `now` (so the outcome is known), leaving out records
 *   brought in by an import (old leads, not inbound ones; the dashboard's lead counts leave them out too) and people
 *   who were already customers more than a day before the CRM first saw them. Converted = first paid purchase
 *   within `window` days of being created.
 * - Repeat: customers whose first paid purchase was at least `window` days before `now`. Repeated = a second paid
 *   purchase within `window` days of the first.
 * Contacts are grouped by their CURRENT grade, score and inputs (there is no score history). For customers today's
 * score already includes what they bought, so the input rows (who they are, what they know) are the cleaner signal.
 *
 * One SQL statement: every contact is unpivoted into one row per dimension and grouped in Postgres, so the cost
 * is a single scan of contacts and purchases however many buckets there are.
 */
import { sql } from "drizzle-orm";
import { db, queryRows, type Tx } from "@/db";
import { getSettings } from "@/lib/settings";
import {
  buildCalibrationTables,
  calibrationTotals,
  type CalibrationRawRow,
  type CalibrationTable,
  type CalibrationTotals,
} from "./calibration-core";

export * from "./calibration-core";

export type CalibrationReport = {
  generatedAt: Date;
  windowDays: number;
  /** cells under this many people are flagged */
  minN: number;
  totals: CalibrationTotals;
  tables: CalibrationTable[];
  /** earliest contact and earliest paid purchase, so the page can say how much history there is */
  firstContactAt: Date | null;
  firstPurchaseAt: Date | null;
};

const num = (v: unknown) => Number(v ?? 0) || 0;
const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function calibration(now: Date = new Date(), tx: Tx = db): Promise<CalibrationReport> {
  const s = await getSettings(
    ["scoring", "thresholds", "locations", "assignment", "lists.industries", "lists.ageBands", "lists.firstDoors"],
    tx,
  );
  const windowDays = Math.max(1, Math.round(Number(s.thresholds.repeatWindowDays) || 90));
  const minN = Math.max(1, Math.round(Number(s.thresholds.cohortMinSize) || 30));
  const nowIso = now.toISOString();

  // money band of the spend so far: the index of the first `below` threshold it stays under, else "top"
  const ltvRows = [...s.scoring.value.ltv].sort((a, b) => a.below - b.below);
  const moneyBand = ltvRows.length
    ? sql`case ${sql.join(
        ltvRows.map((r, i) => sql`when m.spent < ${Number(r.below)}::numeric then ${String(i)}`),
        sql` `,
      )} else 'top' end`
    : sql`'top'`;

  const [rows, valueRows, snapshotRows, [span]] = await Promise.all([
    queryRows<{ dim: string; key: string; leads: string; converted: string; customers: string; repeated: string }>(sql`
      with p as (
        select pu.contact_id,
          (array_agg(pu.purchased_at order by pu.purchased_at, pu.created_at, pu.id))[1] as first_at,
          (array_agg(pu.purchased_at order by pu.purchased_at, pu.created_at, pu.id))[2] as second_at
        from purchases pu
        where pu.status in ('paid', 'partial') and pu.purchased_at <= ${nowIso}::timestamptz
        group by pu.contact_id
      ),
      base as (
        select c.grade, c.edapt_score, c.spending_band, c.industry, c.age_band, c.umer_level, c.ai_level, c.gut_stars,
          c.first_door, c.country, c.state, c.city, c.phone_country,
          (c.created_at <= ${nowIso}::timestamptz - ${windowDays}::int * interval '1 day'
            and c.import_batch_id is null
            and (p.first_at is null or p.first_at >= c.created_at - interval '1 day')) as is_lead,
          (p.first_at is not null and p.first_at <= c.created_at + ${windowDays}::int * interval '1 day') as converted,
          (p.first_at is not null and p.first_at <= ${nowIso}::timestamptz - ${windowDays}::int * interval '1 day') as is_customer,
          (p.second_at is not null and p.second_at <= p.first_at + ${windowDays}::int * interval '1 day') as repeated
        from contacts c
        left join p on p.contact_id = c.id
        where c.merged_into_id is null
      )
      select d.dim, d.key,
        count(*) filter (where b.is_lead) as leads,
        count(*) filter (where b.is_lead and b.converted) as converted,
        count(*) filter (where b.is_customer) as customers,
        count(*) filter (where b.is_customer and b.repeated) as repeated
      from base b
      cross join lateral (values
        ('grade', coalesce(b.grade, '')),
        ('score_band', coalesce((least(greatest(b.edapt_score, 0), 99) / 10 * 10)::text, '')),
        ('spending_band', coalesce(b.spending_band::text, '')),
        ('industry', coalesce(b.industry, '')),
        ('age_band', coalesce(b.age_band, '')),
        ('umer_level', coalesce(b.umer_level::text, '')),
        ('ai_level', coalesce(b.ai_level::text, '')),
        ('gut_stars', coalesce(b.gut_stars::text, '')),
        ('first_door', coalesce(b.first_door, '')),
        ('location', concat_ws('|', coalesce(lower(trim(b.country)), ''), coalesce(lower(trim(b.state)), ''),
          coalesce(lower(trim(b.city)), ''), coalesce(lower(trim(b.phone_country)), '')))
      ) as d(dim, key)
      where b.is_lead or b.is_customer
      group by d.dim, d.key
    `, tx),
    // Value inputs, judged at each purchase (see VALUE_DIMENSIONS): every paid purchase at least `window` days old,
    // with the spend, purchases, families and paying referrals up to it, and whether another purchase followed
    // within `window` days. Purchases are ordered like the cohort builder (purchased_at, created_at, id).
    queryRows<{ dim: string; key: string; customers: string; repeated: string }>(sql`
      with p as (
        select pu.contact_id, pu.purchased_at,
          row_number() over w as k,
          lead(pu.purchased_at) over w as next_at,
          sum(pu.amount_inr) over (w rows between unbounded preceding and current row) as spent,
          (row_number() over (partition by pu.contact_id, pu.family order by pu.purchased_at, pu.created_at, pu.id) = 1)::int as new_family
        from purchases pu
        join contacts c on c.id = pu.contact_id and c.merged_into_id is null
        where pu.status in ('paid', 'partial') and pu.purchased_at <= ${nowIso}::timestamptz
        window w as (partition by pu.contact_id order by pu.purchased_at, pu.created_at, pu.id)
      ),
      o as (
        select p.k, p.spent,
          sum(p.new_family) over (partition by p.contact_id order by p.k rows between unbounded preceding and current row) as families,
          (p.next_at is not null and p.next_at <= p.purchased_at + ${windowDays}::int * interval '1 day') as repeated,
          p.purchased_at, p.contact_id
        from p
      ),
      m as (
        select o.*,
          (select count(*) from contacts r
            where r.referred_by_id = o.contact_id and r.merged_into_id is null and r.id <> o.contact_id
              and r.first_purchase_at is not null and r.first_purchase_at <= o.purchased_at) as referrals
        from o
        where o.purchased_at <= ${nowIso}::timestamptz - ${windowDays}::int * interval '1 day'
      )
      select d.dim, d.key, count(*) as customers, count(*) filter (where m.repeated) as repeated
      from m
      cross join lateral (values
        ('value_money', ${moneyBand}),
        ('value_frequency', least(m.k, 1000)::text),
        ('value_breadth', least(m.families, 1000)::text),
        ('value_referrals', least(m.referrals, 1000)::text)
      ) as d(dim, key)
      group by d.dim, d.key
    `, tx),
    // Recent interest and recency, judged at the snapshot `window` days ago (see SNAPSHOT_DIMENSIONS). A chat is what
    // Readiness counts (src/lib/metrics/facts.ts): a call, WhatsApp, meeting or email that was inbound or reached them.
    queryRows<{ dim: string; key: string | null; leads: string; converted: string; customers: string; repeated: string }>(sql`
      with d as (select ${nowIso}::timestamptz - ${windowDays}::int * interval '1 day' as at),
      bought as (
        select pu.contact_id,
          max(pu.purchased_at) filter (where pu.purchased_at <= d.at) as last_before,
          bool_or(pu.purchased_at > d.at) as bought_after
        from purchases pu
        join contacts c on c.id = pu.contact_id and c.merged_into_id is null
        cross join d
        where pu.status in ('paid', 'partial') and pu.purchased_at <= ${nowIso}::timestamptz
        group by pu.contact_id
      ),
      customers as (
        select 'value_recency' as dim, floor(extract(epoch from (d.at - b.last_before)) / 86400)::int as days, b.bought_after as outcome
        from bought b cross join d
        where b.last_before is not null
      ),
      leads as (
        select 'recent_interest' as dim,
          floor(extract(epoch from (d.at - greatest(
            (select max(e.received_at) from enquiries e where e.contact_id = c.id and e.received_at <= d.at),
            (select max(i.occurred_at) from interactions i where i.contact_id = c.id and i.occurred_at <= d.at
              and i.type in ('call', 'whatsapp', 'meeting', 'email')
              and (i.direction = 'in' or coalesce(i.outcome, '') not in ('no_answer', 'busy', 'wrong_number')))
          ))) / 86400)::int as days,
          coalesce(b.bought_after, false) as outcome
        from contacts c
        cross join d
        left join bought b on b.contact_id = c.id
        where c.merged_into_id is null and c.import_batch_id is null and c.created_at <= d.at
          and b.last_before is null
      )
      select dim, days::text as key,
        count(*) filter (where dim = 'recent_interest') as leads,
        count(*) filter (where dim = 'recent_interest' and outcome) as converted,
        count(*) filter (where dim = 'value_recency') as customers,
        count(*) filter (where dim = 'value_recency' and outcome) as repeated
      from (select * from customers union all select * from leads) x
      group by dim, days
    `, tx),
    queryRows<{ first_contact: string | null; first_purchase: string | null }>(sql`
      select
        (select min(c.created_at) from contacts c where c.merged_into_id is null) as first_contact,
        (select min(pu.purchased_at) from purchases pu where pu.status in ('paid', 'partial')) as first_purchase
    `, tx),
  ]);

  const raw: CalibrationRawRow[] = [
    ...rows.map((r) => ({
      dim: r.dim,
      key: r.key ?? "",
      leads: num(r.leads),
      converted: num(r.converted),
      customers: num(r.customers),
      repeated: num(r.repeated),
    })),
    ...valueRows.map((r) => ({ dim: r.dim, key: r.key ?? "", leads: 0, converted: 0, customers: num(r.customers), repeated: num(r.repeated) })),
    ...snapshotRows.map((r) => ({
      dim: r.dim,
      key: r.key ?? "",
      leads: num(r.leads),
      converted: num(r.converted),
      customers: num(r.customers),
      repeated: num(r.repeated),
    })),
  ];
  const tables = buildCalibrationTables(raw, {
    scoring: s.scoring,
    industries: s["lists.industries"],
    ageBands: s["lists.ageBands"],
    firstDoors: s["lists.firstDoors"],
    locations: s.locations,
    gccCountries: s.assignment.gccCountries,
    minN,
  });
  return {
    generatedAt: now,
    windowDays,
    minN,
    totals: calibrationTotals(raw),
    tables,
    firstContactAt: toDate(span?.first_contact),
    firstPurchaseAt: toDate(span?.first_purchase),
  };
}
