import "server-only";
import { and, asc, count, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { db, type Database, type Tx } from "@/db";
import { contacts, products } from "@/db/schema";
import { audit } from "@/lib/audit";
import { UnknownCurrencyError } from "@/lib/money/errors";
import { rateFromTable } from "@/lib/money/fx";
import { getSettings, type CurrencyConfig } from "@/lib/settings";
import { isUuid } from "@/lib/utils";
import { computeCalculatedColumns, type CalculatedColumns, type ContactInputs, type MetricsContext } from "./compute";
import { computeActivityFactsBulk, computeMoneyFactsBulk, computeReferralFactsBulk } from "./facts";
import type { NboProduct } from "./nbo";
import { buildCohorts } from "./repeat";

/**
 * The ONE place calculated columns on `contacts` are written (CLAUDE.md "Calculated columns").
 *
 * For each contact: money facts (LTV, purchase count, families, rung, first/last purchase, first family),
 * activity markers (last enquiry / interaction / activity), stage (automatic stages, with an audit row when it
 * changes), Fit / Readiness / Value / Edapt Score / grade, repeat metrics (average gap, expected next purchase,
 * at risk, 90-day repeat probability), next best offer, expected 90-day revenue, referral count and network value.
 */

/** Settings and catalogue for one recompute call or one nightly run. */
export async function loadMetricsContext(tx: Tx = db, now: Date = new Date()): Promise<MetricsContext> {
  const s = await getSettings(
    ["scoring", "thresholds", "locations", "assignment", "ladder.families", "nbo.rules", "metrics.cohorts", "currency"],
    tx,
  );
  const catalogue = await tx
    .select({
      id: products.id,
      name: products.name,
      family: products.family,
      rung: products.rung,
      listPrice: products.listPrice,
      currency: products.currency,
      active: products.active,
    })
    .from(products);
  return {
    scoring: s.scoring,
    thresholds: s.thresholds,
    locations: s.locations,
    gccCountries: s.assignment.gccCountries ?? [],
    families: s["ladder.families"],
    nboRules: s["nbo.rules"],
    cohorts: s["metrics.cohorts"],
    products: catalogue.map((p): NboProduct => ({ ...p, listPrice: Number(p.listPrice) })),
    toInr: inrConverter(s.currency, now),
  };
}

/** amount in `currency` -> INR at the rate of `at`'s month; NaN for a currency without a rate. */
export function inrConverter(currency: CurrencyConfig, at: Date): (amount: number, cur: string) => number {
  return (amount, cur) => {
    let rate: number;
    try {
      rate = rateFromTable(currency.rates, cur, at);
    } catch (e) {
      // no usable rate for this currency: such a product cannot be priced (nbo skips it)
      if (e instanceof UnknownCurrencyError) return Number.NaN;
      throw e;
    }
    return Math.round(amount * rate * 100) / 100;
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Postgres type of every written column, keyed by the Drizzle property name. */
const WRITE_TYPES: Record<keyof CalculatedColumns, string> = {
  ltvInr: "numeric",
  purchaseCount: "int",
  familyCount: "int",
  families: "text[]",
  currentRung: "int",
  firstPurchaseAt: "timestamptz",
  lastPurchaseAt: "timestamptz",
  firstFamily: "text",
  lastEnquiryAt: "timestamptz",
  lastInteractionAt: "timestamptz",
  lastActivityAt: "timestamptz",
  stage: "text",
  stageChangedAt: "timestamptz",
  lostReason: "text",
  fit: "int",
  readiness: "int",
  value: "int",
  edaptScore: "int",
  grade: "text",
  scoredAt: "timestamptz",
  avgGapDays: "numeric",
  nextExpectedAt: "timestamptz",
  atRisk: "boolean",
  repeatProb90d: "numeric",
  nextOffer: "text",
  nextOfferProductId: "uuid",
  expected90dInr: "numeric",
  referralCount: "int",
  networkValueInr: "numeric",
};
const WRITE_KEYS = Object.keys(WRITE_TYPES) as (keyof CalculatedColumns)[];
const colName = (k: keyof CalculatedColumns) => contacts[k].name;

/** One UPDATE for the whole batch (jsonb_to_recordset), so a nightly batch of 500 is a single statement. */
async function writeColumns(rows: { id: string; columns: CalculatedColumns }[], t: Tx): Promise<void> {
  if (!rows.length) return;
  const payload = rows.map(({ id, columns }) => {
    const o: Record<string, unknown> = { id };
    for (const k of WRITE_KEYS) {
      const v = columns[k];
      o[colName(k)] = v instanceof Date ? v.toISOString() : v;
    }
    return o;
  });
  const setList = WRITE_KEYS.map((k) => `"${colName(k)}" = v."${colName(k)}"`).join(", ");
  const recordDef = ["id uuid", ...WRITE_KEYS.map((k) => `"${colName(k)}" ${WRITE_TYPES[k]}`)].join(", ");
  await t.execute(sql`
    update contacts as c set ${sql.raw(setList)}
    from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as v(${sql.raw(recordDef)})
    where c.id = v.id
  `);
}

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

export type RecomputeOptions = {
  now?: Date;
  /** reuse settings/products already loaded for this run */
  ctx?: MetricsContext;
  /** nightly job: skip contacts another transaction holds (it recomputes them itself) instead of waiting */
  skipLocked?: boolean;
};

const CONTACT_INPUTS = {
  id: contacts.id,
  stage: contacts.stage,
  stageChangedAt: contacts.stageChangedAt,
  lostReason: contacts.lostReason,
  createdAt: contacts.createdAt,
  spendingBand: contacts.spendingBand,
  industry: contacts.industry,
  ageBand: contacts.ageBand,
  country: contacts.country,
  state: contacts.state,
  city: contacts.city,
  phoneCountry: contacts.phoneCountry,
  umerLevel: contacts.umerLevel,
  aiLevel: contacts.aiLevel,
  gutStars: contacts.gutStars,
  tags: contacts.tags,
  firstDoor: contacts.firstDoor,
};

/**
 * Bulk recompute: locks the (non-merged) contacts, gathers every fact in a handful of queries, writes all
 * columns in one statement and audits stage changes. Merged or missing ids are skipped. Returns how many
 * contacts were written.
 */
export async function recomputeContacts(contactIds: string[], tx: Tx = db, opts: RecomputeOptions = {}): Promise<number> {
  return (await recomputeBatch(contactIds, tx, opts)).length;
}

/** recomputeContacts, returning the ids actually written (merged, missing and skip-locked ids are left out). */
async function recomputeBatch(contactIds: string[], tx: Tx, opts: RecomputeOptions): Promise<string[]> {
  // a malformed id (e.g. from a URL) is skipped like a missing one, never a raw cast error
  const ids = [...new Set(contactIds)].filter(isUuid);
  if (!ids.length) return [];
  const now = opts.now ?? new Date();
  return (tx as Database).transaction(async (t) => {
    const idList: SQL = sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;
    const base = t
      .select(CONTACT_INPUTS)
      .from(contacts)
      .where(and(sql`${contacts.id} = any(${idList})`, isNull(contacts.mergedIntoId)))
      .orderBy(asc(contacts.id));
    const rows: ContactInputs[] = opts.skipLocked ? await base.for("update", { skipLocked: true }) : await base.for("update");
    if (!rows.length) return [];

    const live = rows.map((r) => r.id);
    const ctx = opts.ctx ?? (await loadMetricsContext(t, now));
    const [money, referral, activity] = [
      await computeMoneyFactsBulk(live, t, ctx.families),
      await computeReferralFactsBulk(live, t),
      await computeActivityFactsBulk(live, t),
    ];

    const out: { id: string; columns: CalculatedColumns }[] = [];
    const stageAudits: Parameters<typeof audit>[0] = [];
    for (const c of rows) {
      const r = computeCalculatedColumns(
        c,
        { money: money.get(c.id)!, referral: referral.get(c.id)!, activity: activity.get(c.id)! },
        ctx,
        now,
      );
      out.push({ id: c.id, columns: r.columns });
      if (r.stageChange) {
        stageAudits.push({ table: "contacts", rowId: c.id, action: "update", field: "stage", oldValue: r.stageChange.from, newValue: r.stageChange.to, userId: null });
        if (c.lostReason !== r.columns.lostReason) {
          stageAudits.push({ table: "contacts", rowId: c.id, action: "update", field: "lost_reason", oldValue: c.lostReason, newValue: r.columns.lostReason, userId: null });
        }
      }
    }
    await writeColumns(out, t);
    await audit(stageAudits, t);
    return out.map((o) => o.id);
  });
}

/**
 * Recalculates every calculated column on one contact: money facts (LTV, purchase count, families, rung,
 * first/last purchase), activity markers, stage (auto stages), Fit/Readiness/Value, Edapt Score and grade,
 * repeat metrics, next best offer, expected 90-day revenue, network value.
 *
 * Call it after ANY change that can affect those values. Safe to call repeatedly. Merged contacts are skipped.
 */
export async function recomputeContact(
  contactId: string,
  tx: Tx = db,
  opts: { now?: Date } = {},
): Promise<void> {
  await recomputeContacts([contactId], tx, { now: opts.now });
}

/** Follows merged_into_id to the surviving contact id (null when missing). */
async function survivorId(contactId: string, t: Tx): Promise<string | null> {
  let id: string | null = contactId;
  for (let hop = 0; id && hop < 10; hop++) {
    const [c]: { id: string; mergedIntoId: string | null }[] = await t
      .select({ id: contacts.id, mergedIntoId: contacts.mergedIntoId })
      .from(contacts)
      .where(eq(contacts.id, id))
      .limit(1);
    if (!c) return null;
    if (!c.mergedIntoId) return c.id;
    id = c.mergedIntoId;
  }
  return null;
}

/**
 * Recomputes the contact, then the contact who referred them (network value and referral count depend on the
 * referred contact's payments). The referrer is followed through merges.
 */
export async function recomputeReferrerChain(contactId: string, tx: Tx = db, opts: { now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  await recomputeContact(contactId, tx, { now });
  const [c] = await tx
    .select({ referredById: contacts.referredById })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!c?.referredById || c.referredById === contactId) return;
  const referrer = await survivorId(c.referredById, tx);
  if (referrer && referrer !== contactId) await recomputeContact(referrer, tx, { now });
}

/**
 * The nightly job: rebuilds the cohort table, then recomputes every non-merged contact in id-ordered batches
 * (one transaction per batch, settings and products loaded once for the run). A contact locked by another
 * transaction is skipped in its batch (so one long lock never stalls 500 rows) and recomputed on its own at the
 * end, waiting for the lock: the lock holder may not recompute it (e.g. an owner change), and time-based columns
 * (dormant, recency, at risk) must still move every night. Returns how many were written.
 */
export async function recomputeAll(
  opts: { now?: Date; batchSize?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 500));
  await buildCohorts(db, now);
  const ctx = await loadMetricsContext(db, now);
  const [{ total }] = await db.select({ total: count() }).from(contacts).where(isNull(contacts.mergedIntoId));

  let done = 0;
  let written = 0;
  const skipped: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page: { id: string }[] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(after ? and(isNull(contacts.mergedIntoId), gt(contacts.id, after)) : isNull(contacts.mergedIntoId))
      .orderBy(asc(contacts.id))
      .limit(batchSize);
    if (!page.length) break;
    const pageIds = page.map((p) => p.id);
    const wrote = new Set(await recomputeBatch(pageIds, db, { now, ctx, skipLocked: true }));
    written += wrote.size;
    for (const id of pageIds) if (!wrote.has(id)) skipped.push(id);
    done += page.length;
    after = page[page.length - 1].id;
    opts.onProgress?.(done, Number(total));
  }
  // locked rows (and rows merged meanwhile, which recomputeBatch skips again): one at a time, waiting for the lock
  for (const id of skipped) written += (await recomputeBatch([id], db, { now, ctx })).length;
  return written;
}
