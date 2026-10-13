import "server-only";
import { and, asc, eq, gt, gte, lt, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  PAYMENT_MODES,
  auditLog,
  PURCHASE_SOURCES,
  PURCHASE_STATUSES,
  contacts,
  organisations,
  purchases,
  users,
  type PaymentMode,
  type PurchaseSource,
  type PurchaseStatus,
  type Role,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { contactListWhere, filtersToQuery, parseContactFilters, type ContactFilters } from "@/lib/contacts/queries";
import { getSettings, labelFor, type ListItem } from "@/lib/settings";
import { localDateAt } from "@/lib/today/time";
import { CSV_BOM, csvDateTime, csvRow, exportFileName, type CsvValue } from "./csv";
import { AdminForbiddenError } from "./errors";

/**
 * CSV exports (spec "Data hygiene": only the admin can export, and every export is logged).
 * - Contacts take the same filters as the Contacts list URL (grade, stage, door, campaign, channel, owner,
 *   family, country, lang, tag, risk, unrated, q).
 * - Purchases take from / to (dates in the admin's time zone), status, family, mode, source.
 * Rows stream in id order, `batchSize` at a time (keyset pagination), so 50,000 rows never sit in memory.
 * Before any data leaves, audit_log gets one "export" row with the filters and the row count. A refused attempt
 * writes an "export_denied" row.
 */

export type ExportKind = "contacts" | "purchases";
export const EXPORT_KINDS: ExportKind[] = ["contacts", "purchases"];

export type Exporter = { id: string; role: Role; timezone?: string | null };

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function toSearchParams(p: Params): URLSearchParams {
  if (p instanceof URLSearchParams) return p;
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
    else if (v !== undefined) out.append(k, v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Purchase filters
// ---------------------------------------------------------------------------

export type PurchaseFilters = {
  /** YYYY-MM-DD, inclusive, in the exporter's time zone */
  from?: string | null;
  /** YYYY-MM-DD, inclusive */
  to?: string | null;
  status?: PurchaseStatus | null;
  family?: string | null;
  mode?: PaymentMode | null;
  source?: PurchaseSource | null;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function parsePurchaseFilters(p: Params): PurchaseFilters {
  const sp = toSearchParams(p);
  const one = (k: string) => sp.get(k)?.trim() || null;
  const pick = <T extends string>(k: string, allowed: readonly T[]) => {
    const v = one(k);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
  };
  const from = one("from");
  const to = one("to");
  return {
    from: from && YMD.test(from) ? from : null,
    to: to && YMD.test(to) ? to : null,
    status: pick("status", PURCHASE_STATUSES),
    family: one("family")?.slice(0, 60) ?? null,
    mode: pick("mode", PAYMENT_MODES),
    source: pick("source", PURCHASE_SOURCES),
  };
}

function purchaseWhere(f: PurchaseFilters, timeZone: string): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  const from = f.from ? localDateAt(f.from, timeZone, 0, 0) : null;
  const toStart = f.to ? localDateAt(f.to, timeZone, 0, 0) : null;
  if (from) conds.push(gte(purchases.purchasedAt, from));
  if (toStart) conds.push(lt(purchases.purchasedAt, new Date(toStart.getTime() + 24 * 3600 * 1000)));
  if (f.status) conds.push(eq(purchases.status, f.status));
  if (f.family) conds.push(eq(purchases.family, f.family));
  if (f.mode) conds.push(eq(purchases.mode, f.mode));
  if (f.source) conds.push(eq(purchases.source, f.source));
  return conds.length ? and(...conds) : undefined;
}

function cleanPurchaseFilters(f: PurchaseFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v) out[k] = String(v);
  return out;
}

// ---------------------------------------------------------------------------
// Column sets
// ---------------------------------------------------------------------------

type Labels = {
  channels: ListItem[];
  firstDoors: ListItem[];
  campaigns: ListItem[];
  languages: ListItem[];
  ageBands: ListItem[];
  industries: ListItem[];
  lostReasons: ListItem[];
  families: { key: string; label: string }[];
};

async function loadLabels(): Promise<Labels> {
  const s = await getSettings([
    "lists.channels",
    "lists.firstDoors",
    "lists.campaigns",
    "lists.languages",
    "lists.ageBands",
    "lists.industries",
    "lists.lostReasons",
    "ladder.families",
  ]);
  return {
    channels: s["lists.channels"],
    firstDoors: s["lists.firstDoors"],
    campaigns: s["lists.campaigns"],
    languages: s["lists.languages"],
    ageBands: s["lists.ageBands"],
    industries: s["lists.industries"],
    lostReasons: s["lists.lostReasons"],
    families: s["ladder.families"],
  };
}

const owner = alias(users, "owner");
const firstOwner = alias(users, "first_owner");
const referrer = alias(contacts, "referrer");
const credited = alias(users, "credited");
const buyer = alias(contacts, "buyer");

const CONTACT_COLS = {
  id: contacts.id,
  name: contacts.name,
  phoneE164: contacts.phoneE164,
  altPhones: contacts.altPhones,
  email: contacts.email,
  altEmails: contacts.altEmails,
  type: contacts.type,
  organisation: organisations.name,
  companyName: contacts.companyName,
  designation: contacts.designation,
  city: contacts.city,
  state: contacts.state,
  country: contacts.country,
  language: contacts.language,
  ageBand: contacts.ageBand,
  industry: contacts.industry,
  spendingBand: contacts.spendingBand,
  aiLevel: contacts.aiLevel,
  umerLevel: contacts.umerLevel,
  gutStars: contacts.gutStars,
  firstDoor: contacts.firstDoor,
  firstCampaign: contacts.firstCampaign,
  firstChannel: contacts.firstChannel,
  lastChannel: contacts.lastChannel,
  stage: contacts.stage,
  lostReason: contacts.lostReason,
  ownerName: owner.name,
  firstOwnerName: firstOwner.name,
  referrerName: referrer.name,
  referrerPhone: referrer.phoneE164,
  tags: contacts.tags,
  consent: contacts.consent,
  consentAt: contacts.consentAt,
  ltvInr: contacts.ltvInr,
  purchaseCount: contacts.purchaseCount,
  families: contacts.families,
  currentRung: contacts.currentRung,
  firstPurchaseAt: contacts.firstPurchaseAt,
  lastPurchaseAt: contacts.lastPurchaseAt,
  nextExpectedAt: contacts.nextExpectedAt,
  atRisk: contacts.atRisk,
  repeatProb90d: contacts.repeatProb90d,
  expected90dInr: contacts.expected90dInr,
  nextOffer: contacts.nextOffer,
  fit: contacts.fit,
  readiness: contacts.readiness,
  value: contacts.value,
  edaptScore: contacts.edaptScore,
  grade: contacts.grade,
  networkValueInr: contacts.networkValueInr,
  referralCount: contacts.referralCount,
  lastActivityAt: contacts.lastActivityAt,
  createdAt: contacts.createdAt,
};
function contactPage(where: SQL | undefined, after: string | null, limit: number) {
  return db
    .select(CONTACT_COLS)
    .from(contacts)
    .leftJoin(organisations, eq(organisations.id, contacts.organisationId))
    .leftJoin(owner, eq(owner.id, contacts.ownerId))
    .leftJoin(firstOwner, eq(firstOwner.id, contacts.firstOwnerId))
    .leftJoin(referrer, eq(referrer.id, contacts.referredById))
    .where(and(where, after ? gt(contacts.id, after) : undefined))
    .orderBy(asc(contacts.id))
    .limit(limit);
}
type ContactRow = Awaited<ReturnType<typeof contactPage>>[number];

function contactColumns(l: Labels, tz: string): [string, (r: ContactRow) => CsvValue][] {
  const fam = (keys: string[] | null) => (keys ?? []).map((k) => l.families.find((f) => f.key === k)?.label ?? k).join("; ");
  const dt = (d: Date | null) => csvDateTime(d, tz);
  return [
    ["Contact id", (r) => r.id],
    ["Name", (r) => r.name],
    ["Phone", (r) => r.phoneE164],
    ["Other phones", (r) => (r.altPhones ?? []).join("; ")],
    ["Email", (r) => r.email],
    ["Other emails", (r) => (r.altEmails ?? []).join("; ")],
    ["Type", (r) => r.type],
    ["Organisation", (r) => r.organisation],
    ["Company", (r) => r.companyName],
    ["Designation", (r) => r.designation],
    ["City", (r) => r.city],
    ["State", (r) => r.state],
    ["Country", (r) => r.country],
    ["Language", (r) => labelFor(l.languages, r.language)],
    ["Age band", (r) => labelFor(l.ageBands, r.ageBand)],
    ["Industry", (r) => labelFor(l.industries, r.industry)],
    ["Spending power", (r) => r.spendingBand],
    ["AI knowledge", (r) => r.aiLevel],
    ["Umer familiarity", (r) => r.umerLevel],
    ["Gut stars", (r) => r.gutStars],
    ["First door", (r) => labelFor(l.firstDoors, r.firstDoor)],
    ["First campaign", (r) => labelFor(l.campaigns, r.firstCampaign)],
    ["First channel", (r) => labelFor(l.channels, r.firstChannel)],
    ["Last channel", (r) => labelFor(l.channels, r.lastChannel)],
    ["Stage", (r) => r.stage],
    ["Lost reason", (r) => labelFor(l.lostReasons, r.lostReason)],
    ["Owner", (r) => r.ownerName],
    ["First owner", (r) => r.firstOwnerName],
    ["Referred by", (r) => r.referrerName],
    ["Referrer phone", (r) => r.referrerPhone],
    ["Tags", (r) => (r.tags ?? []).join("; ")],
    ["Marketing consent", (r) => (r.consent === null ? "" : r.consent)],
    [`Consent at (${tz})`, (r) => dt(r.consentAt)],
    ["LTV (INR)", (r) => r.ltvInr],
    ["Purchases", (r) => r.purchaseCount],
    ["Product families", (r) => fam(r.families)],
    ["Ladder rung", (r) => r.currentRung],
    [`First purchase (${tz})`, (r) => dt(r.firstPurchaseAt)],
    [`Last purchase (${tz})`, (r) => dt(r.lastPurchaseAt)],
    [`Expected next purchase (${tz})`, (r) => dt(r.nextExpectedAt)],
    ["At risk", (r) => r.atRisk],
    ["Repeat probability 90d", (r) => r.repeatProb90d],
    ["Expected 90-day revenue (INR)", (r) => r.expected90dInr],
    ["Next best offer", (r) => r.nextOffer],
    ["Fit", (r) => r.fit],
    ["Readiness", (r) => r.readiness],
    ["Value", (r) => r.value],
    ["Edapt Score", (r) => r.edaptScore],
    ["Grade", (r) => r.grade],
    ["Network value (INR)", (r) => r.networkValueInr],
    ["Paying referrals", (r) => r.referralCount],
    [`Last activity (${tz})`, (r) => dt(r.lastActivityAt)],
    [`Created (${tz})`, (r) => dt(r.createdAt)],
  ];
}

const paidInr = sql<number>`coalesce((
  select sum(case when p.kind = 'refund' then -p.amount_inr else p.amount_inr end)
  from payments p where p.purchase_id = ${sql.raw(`"purchases"."id"`)} and p.status = 'verified'
), 0)`;

const PURCHASE_COLS = {
  id: purchases.id,
  purchasedAt: purchases.purchasedAt,
  contactId: purchases.contactId,
  contactName: buyer.name,
  contactPhone: buyer.phoneE164,
  organisation: organisations.name,
  productName: purchases.productName,
  family: purchases.family,
  listPrice: purchases.listPrice,
  discount: purchases.discount,
  amount: purchases.amount,
  currency: purchases.currency,
  fxRate: purchases.fxRate,
  amountInr: purchases.amountInr,
  paidInr,
  mode: purchases.mode,
  reference: purchases.reference,
  status: purchases.status,
  creditedName: credited.name,
  assisted: purchases.assisted,
  source: purchases.source,
  hasInstalments: purchases.hasInstalments,
  campaign: purchases.campaign,
  createdAt: purchases.createdAt,
};
function purchasePage(where: SQL | undefined, after: string | null, limit: number) {
  return db
    .select(PURCHASE_COLS)
    .from(purchases)
    .innerJoin(buyer, eq(buyer.id, purchases.contactId))
    .leftJoin(organisations, eq(organisations.id, purchases.organisationId))
    .leftJoin(credited, eq(credited.id, purchases.creditedUserId))
    .where(and(where, after ? gt(purchases.id, after) : undefined))
    .orderBy(asc(purchases.id))
    .limit(limit);
}
type PurchaseRow = Awaited<ReturnType<typeof purchasePage>>[number];

function purchaseColumns(l: Labels, tz: string): [string, (r: PurchaseRow) => CsvValue][] {
  return [
    ["Purchase id", (r) => r.id],
    [`Purchased (${tz})`, (r) => csvDateTime(r.purchasedAt, tz)],
    ["Contact id", (r) => r.contactId],
    ["Contact", (r) => r.contactName],
    ["Phone", (r) => r.contactPhone],
    ["Organisation", (r) => r.organisation],
    ["Product", (r) => r.productName],
    ["Family", (r) => l.families.find((f) => f.key === r.family)?.label ?? r.family],
    ["List price", (r) => r.listPrice],
    ["Discount", (r) => r.discount],
    ["Amount", (r) => r.amount],
    ["Currency", (r) => r.currency],
    ["Rate (INR per unit)", (r) => r.fxRate],
    ["Amount (INR)", (r) => r.amountInr],
    ["Received, verified (INR)", (r) => Number(r.paidInr)],
    ["Mode", (r) => r.mode],
    ["Reference", (r) => r.reference],
    ["Status", (r) => r.status],
    ["Credited to", (r) => r.creditedName ?? "Self-serve"],
    ["Assisted", (r) => r.assisted],
    ["Source", (r) => r.source],
    ["Instalments", (r) => r.hasInstalments],
    ["Campaign", (r) => labelFor(l.campaigns, r.campaign)],
    [`Created (${tz})`, (r) => csvDateTime(r.createdAt, tz)],
  ];
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

export type PreparedExport = {
  kind: ExportKind;
  fileName: string;
  rows: number;
  /** the filters as logged */
  filters: Record<string, unknown>;
  stream: ReadableStream<Uint8Array>;
};

/**
 * Checks the exporter, logs the export (with filters and row count) and returns a CSV stream. A non-admin gets
 * AdminForbiddenError after an "export_denied" audit row. `batchSize` rows are read per query.
 */
export async function prepareExport(
  kind: ExportKind,
  user: Exporter,
  params: Params,
  opts: { now?: Date; batchSize?: number } = {},
): Promise<PreparedExport> {
  const now = opts.now ?? new Date();
  const tz = user.timezone || "Asia/Kolkata";
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 2000, 10000));
  const sp = toSearchParams(params);
  const contactFilters: ContactFilters | null = kind === "contacts" ? parseContactFilters(sp) : null;
  const purchaseFilters: PurchaseFilters | null = kind === "purchases" ? parsePurchaseFilters(sp) : null;
  const filters: Record<string, unknown> = contactFilters
    ? Object.fromEntries(new URLSearchParams(filtersToQuery({ ...contactFilters, sort: undefined })))
    : cleanPurchaseFilters(purchaseFilters!);

  if (!can(user, "export.run")) {
    await audit({ table: kind, action: "export_denied", field: kind, newValue: { filters, role: user.role }, userId: user.id });
    throw new AdminForbiddenError("Only the admin can export data");
  }

  const fileName = exportFileName(kind, now, tz);
  const labels = await loadLabels();

  if (contactFilters) {
    const where = contactListWhere(user, { ...contactFilters, sort: undefined });
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where);
    const rows = Number(n);
    await audit({ table: "contacts", action: "export", field: "contacts", newValue: { filters, rows, fileName }, userId: user.id });
    const cols = contactColumns(labels, tz);
    const fetchPage = (after: string | null) => contactPage(where, after, batchSize);
    return { kind, fileName, rows, filters, stream: csvStream(cols, fetchPage, (r) => r.id, batchSize) };
  }

  const where = purchaseWhere(purchaseFilters!, tz);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(purchases).where(where);
  const rows = Number(n);
  await audit({ table: "purchases", action: "export", field: "purchases", newValue: { filters, rows, fileName }, userId: user.id });
  const cols = purchaseColumns(labels, tz);
  const fetchPage = (after: string | null) => purchasePage(where, after, batchSize);
  return { kind, fileName, rows, filters, stream: csvStream(cols, fetchPage, (r) => r.id, batchSize) };
}

/** A pull-based stream: header first, then one query per batch until a short page. */
function csvStream<R>(
  cols: [string, (r: R) => CsvValue][],
  fetchPage: (after: string | null) => Promise<R[]>,
  idOf: (r: R) => string,
  batchSize: number,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let after: string | null = null;
  let started = false;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(enc.encode(CSV_BOM + csvRow(cols.map(([h]) => h))));
        return;
      }
      if (done) {
        controller.close();
        return;
      }
      const page = await fetchPage(after);
      if (page.length) {
        let chunk = "";
        for (const r of page) chunk += csvRow(cols.map(([, get]) => get(r)));
        controller.enqueue(enc.encode(chunk));
        after = idOf(page[page.length - 1]);
      }
      if (page.length < batchSize) done = true;
      if (!page.length) controller.close();
    },
  });
}

/** Recent exports (and refused attempts) for the Export screen. */
export async function recentExports(limit = 10) {
  return db
    .select({
      id: auditLog.id,
      tableName: auditLog.tableName,
      action: auditLog.action,
      newValue: auditLog.newValue,
      userName: users.name,
      changedAt: auditLog.changedAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(sql`${auditLog.action} in ('export', 'export_denied')`)
    .orderBy(sql`${auditLog.id} desc`)
    .limit(limit);
}
