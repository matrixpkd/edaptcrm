import "server-only";
/**
 * Repeat purchase metrics (server side). The pure core lives in ./repeat-core.ts and is re-exported here.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { getSetting, setSetting } from "@/lib/settings";
import { round, type CohortTable } from "./repeat-core";

export * from "./repeat-core";

type CohortRow = { cohort: string; n: number; repeated: number };

/**
 * Rebuilds the cohort table from Edapt's own purchase history and saves it to settings `metrics.cohorts`.
 *
 * For every non-merged customer, with paid / part-paid purchases ordered by date (up to `now`), purchase k
 * contributes an observation to cohort "<first family>:<k>": repeated when purchase k+1 came within
 * `thresholds.repeatWindowDays` of purchase k. A customer's last purchase only counts once it is at least
 * `repeatWindowDays` old (before that the outcome is unknown).
 * - companyRate = repeated / observations, over every cohort (null when there are none);
 * - medianFirstGapDays = median days between first and second purchase, over customers with 2 or more.
 * One SQL statement with window functions, so it scales to the full customer base.
 */
export async function buildCohorts(tx: Tx = db, now: Date = new Date()): Promise<CohortTable> {
  const thresholds = await getSetting("thresholds", tx);
  const windowDays = Math.max(0, Math.round(thresholds.repeatWindowDays));
  const nowIso = now.toISOString();

  const [res] = await tx.execute<{ cohorts: CohortRow[] | string | null; median_first_gap: number | string | null }>(sql`
    with p as (
      select
        pu.purchased_at,
        row_number() over w as k,
        lead(pu.purchased_at) over w as next_at,
        first_value(pu.family) over w as first_family
      from purchases pu
      join contacts c on c.id = pu.contact_id and c.merged_into_id is null
      where pu.status in ('paid', 'partial') and pu.purchased_at <= ${nowIso}::timestamptz
      window w as (partition by pu.contact_id order by pu.purchased_at, pu.created_at, pu.id)
    ),
    obs as (
      select first_family || ':' || k as cohort,
        (next_at is not null and next_at <= purchased_at + ${windowDays}::int * interval '1 day') as repeated
      from p
      where next_at is not null
         or purchased_at <= ${nowIso}::timestamptz - ${windowDays}::int * interval '1 day'
    ),
    agg as (
      select cohort, count(*)::int as n, (count(*) filter (where repeated))::int as repeated
      from obs group by cohort
    )
    select
      (select coalesce(json_agg(agg), '[]'::json) from agg) as cohorts,
      (select percentile_cont(0.5) within group (order by extract(epoch from (next_at - purchased_at))::float8 / 86400)
         from p where k = 1 and next_at is not null) as median_first_gap
  `);

  const rows: CohortRow[] =
    typeof res?.cohorts === "string" ? (JSON.parse(res.cohorts) as CohortRow[]) : (res?.cohorts ?? []);
  const cohorts: CohortTable["cohorts"] = {};
  let total = 0;
  let repeated = 0;
  for (const r of rows) {
    const n = Number(r.n);
    const rep = Number(r.repeated);
    cohorts[r.cohort] = { n, repeated: rep, rate: n ? rep / n : 0 };
    total += n;
    repeated += rep;
  }
  const median = res?.median_first_gap === null || res?.median_first_gap === undefined ? null : Number(res.median_first_gap);
  const table: CohortTable = {
    builtAt: now.toISOString(),
    companyRate: total ? repeated / total : null,
    medianFirstGapDays: median === null || !Number.isFinite(median) ? null : round(median, 2),
    cohorts,
  };
  await setSetting("metrics.cohorts", table, null, tx);
  return table;
}
