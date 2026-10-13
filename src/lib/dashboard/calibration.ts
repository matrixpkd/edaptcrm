import "server-only";
/**
 * The calibration report: conversion and repeat rates by grade, Edapt Score band and each scoring input, so the
 * weights in Settings > Scoring can be checked against what actually happened.
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
import { db, type Tx } from "@/db";
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

  const [rows, [span]] = await Promise.all([
    tx.execute<{ dim: string; key: string; leads: string; converted: string; customers: string; repeated: string }>(sql`
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
    `),
    tx.execute<{ first_contact: string | null; first_purchase: string | null }>(sql`
      select
        (select min(c.created_at) from contacts c where c.merged_into_id is null) as first_contact,
        (select min(pu.purchased_at) from purchases pu where pu.status in ('paid', 'partial')) as first_purchase
    `),
  ]);

  const raw: CalibrationRawRow[] = rows.map((r) => ({
    dim: r.dim,
    key: r.key ?? "",
    leads: num(r.leads),
    converted: num(r.converted),
    customers: num(r.customers),
    repeated: num(r.repeated),
  }));
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
