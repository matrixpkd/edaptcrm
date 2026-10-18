import "server-only";
/**
 * Step 4: matching every clean row against the CRM and against the earlier rows of the same file
 * (spec "One person, one record"): exact phone, then exact email -> "merge"; the same name in the same city
 * -> "conflict" (a human decides); otherwise "new". The same person in several rows of one file collapses into
 * one contact: later rows merge into the first one.
 *
 * Built for 50,000 rows: rows are processed in chunks in row order, and each chunk looks up all its phones,
 * emails, names and order ids with a handful of set-based queries (never one query per row).
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, queryRows, type Tx } from "@/db";
import { contacts, importBatches, importRows, type ImportMatchResult } from "@/db/schema";
import { looseKey } from "@/lib/contacts/rules";
import { addCounts, assertCanImport, bulkUpdateRows, ImportError, loadBatch, refreshCounts, setProgress, textArray, uuidArray, type Actor } from "./internal";
import type { PhaseResult } from "./batches";
import type { MatchInfo, Resolution, StoredClean } from "./types";

type ContactLite = { id: string; name: string; phone: string; city: string | null };

/** Where an earlier row of the file points: its row (or the row it follows) and the contact it merges into. */
type Leader = { row: number; contactId: string | null; result: ImportMatchResult; name: string | null };

export type MatchDecision = {
  result: ImportMatchResult;
  contactId: string | null;
  match: MatchInfo;
  issues: string[];
};

const DEFAULT_RESOLUTION: Record<ImportMatchResult, Resolution | null> = {
  new: "create",
  merge: "merge",
  conflict: null,
  invalid: "skip",
  skip: "skip",
};

function uniq(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

/** Follows merged_into_id to the surviving contacts (a few set-based hops). */
async function survivors(
  rows: { id: string; name: string; phone_e164: string; city: string | null; merged_into_id: string | null }[],
  t: Tx,
): Promise<Map<string, ContactLite>> {
  const out = new Map<string, ContactLite>();
  let pending = new Map<string, string[]>(); // merged_into_id -> original ids
  for (const r of rows) {
    if (!r.merged_into_id) out.set(r.id, { id: r.id, name: r.name, phone: r.phone_e164, city: r.city });
    else pending.set(r.merged_into_id, [...(pending.get(r.merged_into_id) ?? []), r.id]);
  }
  for (let hop = 0; hop < 10 && pending.size; hop++) {
    const ids = [...pending.keys()];
    const next = await t
      .select({ id: contacts.id, name: contacts.name, phone: contacts.phoneE164, city: contacts.city, mergedIntoId: contacts.mergedIntoId })
      .from(contacts)
      .where(inArray(contacts.id, ids));
    const following = new Map<string, string[]>();
    for (const c of next) {
      const origins = [...(pending.get(c.id) ?? []), c.id];
      if (!c.mergedIntoId) for (const o of origins) out.set(o, { id: c.id, name: c.name, phone: c.phone, city: c.city });
      else following.set(c.mergedIntoId, [...(following.get(c.mergedIntoId) ?? []), ...origins]);
    }
    pending = following;
  }
  return out;
}

/** Step 4, one chunk. The batch moves to "matched" (with fresh counts) when every row is done. */
export async function runMatchChunk(batchId: string, actor: Actor, opts: { limit?: number } = {}): Promise<PhaseResult> {
  assertCanImport(actor);
  const limit = Math.max(1, Math.min(opts.limit ?? 2000, 5000));
  return db.transaction(async (t) => {
    const b = await loadBatch(batchId, t, { lock: "skip" });
    if (!b) return { processed: 0, done: 0, total: 0, finished: false, busy: true };
    const total = b.countsT.total ?? b.settings.file.rowCount;
    if (b.status !== "cleaned") {
      if (["matched", "committing", "committed"].includes(b.status)) return { processed: 0, done: total, total, finished: true };
      throw new ImportError("Clean the rows first.");
    }
    const cursor = b.settings.progress?.matchCursor ?? 0;
    const rows = await t
      .select({ id: importRows.id, rowNumber: importRows.rowNumber, cleaned: importRows.cleaned })
      .from(importRows)
      .where(and(eq(importRows.batchId, batchId), gt(importRows.rowNumber, cursor)))
      .orderBy(asc(importRows.rowNumber))
      .limit(limit);
    if (!rows.length) {
      await t.update(importBatches).set({ status: "matched" }).where(eq(importBatches.id, batchId));
      await refreshCounts(batchId, t);
      return { processed: 0, done: total, total, finished: true };
    }
    const decisions = await matchRows(
      batchId,
      rows.map((r) => ({ id: r.id, rowNumber: r.rowNumber, clean: r.cleaned as StoredClean | null })),
      cursor,
      t,
    );
    await bulkUpdateRows(
      batchId,
      rows.map((r, i) => {
        const d = decisions[i];
        const clean = r.cleaned as StoredClean | null;
        return {
          id: r.id,
          matchResult: d.result,
          matchContactId: d.contactId,
          resolution: DEFAULT_RESOLUTION[d.result],
          cleaned: clean ? { ...clean, match: d.match } : clean,
          issues: [...(clean?.errors ?? []), ...d.issues, ...(clean?.warnings ?? [])],
        };
      }),
      ["matchResult", "matchContactId", "resolution", "cleaned", "issues"],
      t,
    );
    await setProgress(batchId, { matchCursor: rows[rows.length - 1].rowNumber }, t);
    await addCounts(batchId, { matched: rows.length }, t);
    return { processed: rows.length, done: (b.countsT.matched ?? 0) + rows.length, total, finished: false };
  });
}

/**
 * Decides every row of one chunk (in row order). `before` is the last row number of earlier chunks: those
 * rows are already decided and are looked up in the database.
 */
export async function matchRows(
  batchId: string,
  rows: { id: string; rowNumber: number; clean: StoredClean | null }[],
  before: number,
  t: Tx,
): Promise<MatchDecision[]> {
  const valid = rows.filter((r) => r.clean?.valid);
  const phones = uniq(valid.flatMap((r) => [r.clean!.phone, ...(r.clean!.altPhones ?? [])]));
  const emails = uniq(valid.flatMap((r) => [r.clean!.email, ...(r.clean!.altEmails ?? [])]));
  const names = uniq(valid.filter((r) => r.clean!.name && r.clean!.city).map((r) => r.clean!.name!.toLowerCase()));
  const orders = uniq(valid.map((r) => r.clean!.purchase?.orderId));

  // ---- the CRM, a handful of queries for the whole chunk
  const byPhone = new Map<string, ContactLite>();
  const byEmail = new Map<string, ContactLite>();
  const byName = new Map<string, ContactLite[]>();
  const orderHolder = new Map<string, string | null>();
  if (phones.length) {
    const hits = await queryRows<{ id: string; name: string; phone_e164: string; alt_phones: string[]; city: string | null; merged_into_id: string | null }>(sql`
      select id, name, phone_e164, alt_phones, city, merged_into_id from contacts
      where phone_e164 = any(${textArray(phones)}) or alt_phones && ${textArray(phones)}
      order by (merged_into_id is null) desc, created_at
    `, t);
    const live = await survivors([...hits], t);
    const wanted = new Set(phones);
    // primary numbers first, so a number that is one contact's primary and another's alternate goes to the primary
    for (const h of hits) if (wanted.has(h.phone_e164) && live.get(h.id) && !byPhone.has(h.phone_e164)) byPhone.set(h.phone_e164, live.get(h.id)!);
    for (const h of hits) for (const p of h.alt_phones ?? []) if (wanted.has(p) && live.get(h.id) && !byPhone.has(p)) byPhone.set(p, live.get(h.id)!);
  }
  if (emails.length) {
    const hits = await queryRows<{ id: string; name: string; phone_e164: string; email: string | null; alt_emails: string[]; city: string | null; merged_into_id: string | null }>(sql`
      select id, name, phone_e164, email, alt_emails, city, merged_into_id from contacts
      where lower(email) = any(${textArray(emails)}) or alt_emails && ${textArray(emails)}
      order by (merged_into_id is null) desc, created_at
    `, t);
    const live = await survivors([...hits], t);
    const wanted = new Set(emails);
    for (const h of hits) {
      const e = h.email?.toLowerCase();
      if (e && wanted.has(e) && live.get(h.id) && !byEmail.has(e)) byEmail.set(e, live.get(h.id)!);
    }
    for (const h of hits) for (const e of h.alt_emails ?? []) if (wanted.has(e) && live.get(h.id) && !byEmail.has(e)) byEmail.set(e, live.get(h.id)!);
  }
  if (names.length) {
    const hits = await queryRows<{ id: string; name: string; phone_e164: string; city: string | null }>(sql`
      select id, name, phone_e164, city from contacts
      where merged_into_id is null and lower(name) = any(${textArray(names)}) and city is not null
      order by created_at limit 20000
    `, t);
    for (const h of hits) {
      const k = `${looseKey(h.name)}|${looseKey(h.city)}`;
      byName.set(k, [...(byName.get(k) ?? []), { id: h.id, name: h.name, phone: h.phone_e164, city: h.city }]);
    }
  }
  if (orders.length) {
    // a cancelled purchase gives its reference back (see money/internal releaseCancelledReference)
    const hits = await queryRows<{ reference: string; name: string | null }>(sql`
      select p.reference, c.name from purchases p join contacts c on c.id = p.contact_id
      where p.reference = any(${textArray(orders)}) and p.status <> 'cancelled'
      union all
      select pay.reference, c.name from payments pay
      join purchases p on p.id = pay.purchase_id join contacts c on c.id = pay.contact_id
      where pay.reference = any(${textArray(orders)}) and p.status <> 'cancelled'
    `, t);
    for (const h of hits) if (!orderHolder.has(h.reference)) orderHolder.set(h.reference, h.name);
  }

  // ---- earlier rows of this file
  const filePhone = new Map<string, Leader>();
  const fileEmail = new Map<string, Leader>();
  const fileName = new Map<string, Leader>();
  const fileOrder = new Map<string, number>();
  const fileBuys = new Map<string, Buy[]>();
  if (before > 0 && (phones.length || emails.length || names.length || orders.length)) {
    const earlier = await queryRows<{
      row_number: number;
      match_result: ImportMatchResult;
      match_contact_id: string | null;
      phone: string | null;
      alt_phones: string[] | null;
      email: string | null;
      alt_emails: string[] | null;
      name: string | null;
      city: string | null;
      order_id: string | null;
      same_as: number | null;
      purchase: StoredClean["purchase"] | null;
    }>(sql`
      select row_number, match_result, match_contact_id,
        cleaned->>'phone' as phone, cleaned->'altPhones' as alt_phones,
        cleaned->>'email' as email, cleaned->'altEmails' as alt_emails,
        cleaned->>'name' as name, cleaned->>'city' as city,
        cleaned->'purchase'->>'orderId' as order_id,
        (cleaned->'match'->>'sameAsRow')::int as same_as,
        cleaned->'purchase' as purchase
      from import_rows
      where batch_id = ${batchId} and row_number <= ${before} and match_result is not null and match_result <> 'invalid'
        and (
          cleaned->>'phone' = any(${textArray(phones)})
          or jsonb_exists_any(coalesce(cleaned->'altPhones', '[]'::jsonb), ${textArray(phones)})
          or cleaned->>'email' = any(${textArray(emails)})
          or jsonb_exists_any(coalesce(cleaned->'altEmails', '[]'::jsonb), ${textArray(emails)})
          or lower(cleaned->>'name') = any(${textArray(names)})
          or cleaned->'purchase'->>'orderId' = any(${textArray(orders)})
        )
      order by row_number
    `, t);
    for (const e of earlier) {
      if (e.order_id && !fileOrder.has(e.order_id)) fileOrder.set(e.order_id, e.row_number);
      if (e.match_result === "skip") continue;
      if (e.purchase && !e.purchase.orderId && e.match_result !== "conflict") {
        rememberBuy(fileBuys, buyerKey(e.match_contact_id, e.same_as ?? e.row_number), e.purchase, e.row_number);
      }
      const leader: Leader = { row: e.same_as ?? e.row_number, contactId: e.match_contact_id, result: e.match_result, name: e.name };
      for (const p of [e.phone, ...(e.alt_phones ?? [])]) if (p && !filePhone.has(p)) filePhone.set(p, leader);
      for (const m of [e.email, ...(e.alt_emails ?? [])]) if (m && !fileEmail.has(m)) fileEmail.set(m, leader);
      if (e.name && e.city && e.match_result !== "merge") {
        const k = `${looseKey(e.name)}|${looseKey(e.city)}`;
        if (!fileName.has(k)) fileName.set(k, leader);
      }
    }
  }

  // ---- decide, in row order (each decided row becomes "earlier" for the next)
  const out: MatchDecision[] = [];
  for (const r of rows) {
    const c = r.clean;
    if (!c || !c.valid) {
      out.push({ result: "invalid", contactId: null, match: {}, issues: [] });
      continue;
    }
    const d = decide(r.rowNumber, c, { byPhone, byEmail, byName, orderHolder, filePhone, fileEmail, fileName, fileOrder });
    out.push(d);
    // a payment without an order id, written twice in this file for the same person
    const buy = c.purchase;
    if (buy && !buy.orderId && (d.result === "new" || d.result === "merge")) {
      const key = buyerKey(d.result === "merge" ? d.contactId : null, d.match.sameAsRow ?? r.rowNumber);
      const twin = findBuy(fileBuys.get(key), buy);
      if (twin !== null) {
        d.match.duplicatePurchase = `Same payment as row ${twin} (no order id): recorded once`;
        d.issues.push(d.match.duplicatePurchase);
      } else rememberBuy(fileBuys, key, buy, r.rowNumber);
    }
    // remember this row for the rows after it
    const order = c.purchase?.orderId;
    if (order && !fileOrder.has(order)) fileOrder.set(order, r.rowNumber);
    if (d.result === "new" || d.result === "merge" || d.result === "conflict") {
      const leader: Leader = { row: d.match.sameAsRow ?? r.rowNumber, contactId: d.contactId && d.result === "merge" ? d.contactId : null, result: d.result, name: c.name };
      for (const p of [c.phone, ...c.altPhones]) if (p && !filePhone.has(p)) filePhone.set(p, leader);
      for (const m of [c.email, ...c.altEmails]) if (m && !fileEmail.has(m)) fileEmail.set(m, leader);
      if (c.name && c.city && d.result !== "merge") {
        const k = `${looseKey(c.name)}|${looseKey(c.city)}`;
        if (!fileName.has(k)) fileName.set(k, leader);
      }
    }
  }
  await flagRecordedPurchases(rows, out, t);
  return out;
}

type Buy = { family: string | null; currency: string; amount: number; at: number; row: number };

/** Who pays: the existing contact, else the first row of this file for the person. */
function buyerKey(contactId: string | null, leaderRow: number): string {
  return contactId ? `c:${contactId}` : `r:${leaderRow}`;
}

const DAY_MS = 24 * 3600 * 1000;

/** The same payment: same product family, currency and amount, on the same day (less than 24 hours apart). */
function samePayment(
  a: { family: string | null; currency: string; amount: number; at: number },
  b: { family: string | null; currency: string; amount: number; at: number },
): boolean {
  return (
    a.family === b.family &&
    a.currency.toUpperCase() === b.currency.toUpperCase() &&
    Math.abs(a.amount - b.amount) < 0.005 &&
    Math.abs(a.at - b.at) < DAY_MS
  );
}

function asBuy(p: NonNullable<StoredClean["purchase"]>, row: number): Buy | null {
  if (!p.purchasedAt) return null;
  const at = new Date(p.purchasedAt).getTime();
  return Number.isFinite(at) ? { family: p.family, currency: p.currency, amount: Number(p.amount), at, row } : null;
}

function rememberBuy(map: Map<string, Buy[]>, key: string, p: NonNullable<StoredClean["purchase"]>, row: number): void {
  const b = asBuy(p, row);
  if (b) map.set(key, [...(map.get(key) ?? []), b]);
}

/** The row of an earlier, identical payment of the same person (or null). */
function findBuy(list: Buy[] | undefined, p: NonNullable<StoredClean["purchase"]>): number | null {
  const b = asBuy(p, 0);
  if (!b || !list) return null;
  return list.find((x) => samePayment(x, b))?.row ?? null;
}

/**
 * Rows merging into an existing contact whose payment (without an order id) is already in the CRM: same family,
 * currency, amount and day. One query for the whole chunk. Re-importing a sheet without order ids, or a second
 * source listing a payment TagMango already brought in, never counts the money twice.
 */
async function flagRecordedPurchases(
  rows: { rowNumber: number; clean: StoredClean | null }[],
  out: MatchDecision[],
  t: Tx,
): Promise<void> {
  const idx = rows
    .map((_, i) => i)
    .filter((i) => {
      const p = rows[i].clean?.purchase;
      return out[i].result === "merge" && !!out[i].contactId && !!p && !p.orderId && !!p.purchasedAt && !out[i].match.duplicatePurchase;
    });
  if (!idx.length) return;
  const ids = uniq(idx.map((i) => out[i].contactId));
  const recorded = await queryRows<{ contact_id: string; family: string; currency: string; amount: string; purchased_at: string; product_name: string }>(sql`
    select contact_id, family, currency, amount::text as amount, purchased_at, product_name from purchases
    where contact_id = any(${uuidArray(ids)}) and status <> 'cancelled'
  `, t);
  type Recorded = (typeof recorded)[number];
  const byContact = new Map<string, Recorded[]>();
  for (const p of recorded) byContact.set(p.contact_id, [...(byContact.get(p.contact_id) ?? []), p]);
  for (const i of idx) {
    const buy = asBuy(rows[i].clean!.purchase!, rows[i].rowNumber);
    if (!buy) continue;
    const hit = (byContact.get(out[i].contactId!) ?? []).find((p) =>
      samePayment(buy, { family: p.family, currency: p.currency, amount: Number(p.amount), at: new Date(p.purchased_at).getTime() }),
    );
    if (hit) {
      const msg = `This payment (${hit.product_name}) is already recorded on ${out[i].match.contactName ?? "the contact"}: not recorded again`;
      out[i].match.duplicatePurchase = msg;
      out[i].issues.push(msg);
    }
  }
}

type Lookups = {
  byPhone: Map<string, ContactLite>;
  byEmail: Map<string, ContactLite>;
  byName: Map<string, ContactLite[]>;
  orderHolder: Map<string, string | null>;
  filePhone: Map<string, Leader>;
  fileEmail: Map<string, Leader>;
  fileName: Map<string, Leader>;
  fileOrder: Map<string, number>;
};

/** One row against everything known: phone, then email (CRM first, then this file), then name + city. */
function decide(rowNumber: number, c: StoredClean, L: Lookups): MatchDecision {
  const order = c.purchase?.orderId;
  if (order && L.orderHolder.has(order)) {
    const who = L.orderHolder.get(order);
    return { result: "skip", contactId: null, match: {}, issues: [`Order ${order} is already recorded${who ? ` on ${who}` : ""}`] };
  }
  if (order && L.fileOrder.has(order) && L.fileOrder.get(order)! < rowNumber) {
    return { result: "skip", contactId: null, match: {}, issues: [`Same order id as row ${L.fileOrder.get(order)}`] };
  }
  const existing = (x: ContactLite, by: "phone" | "email"): MatchDecision => ({
    result: "merge",
    contactId: x.id,
    match: { by, contactName: x.name },
    issues: [],
  });
  const follow = (l: Leader): MatchDecision => ({
    result: "merge",
    contactId: l.result === "merge" ? l.contactId : null,
    match: { sameAsRow: l.row, contactName: l.name },
    issues: [],
  });
  if (c.phone && L.byPhone.has(c.phone)) return existing(L.byPhone.get(c.phone)!, "phone");
  if (c.phone && L.filePhone.has(c.phone)) return follow(L.filePhone.get(c.phone)!);
  for (const p of c.altPhones) if (L.byPhone.has(p)) return existing(L.byPhone.get(p)!, "phone");
  for (const p of c.altPhones) if (L.filePhone.has(p)) return follow(L.filePhone.get(p)!);
  for (const e of [c.email, ...c.altEmails]) if (e && L.byEmail.has(e)) return existing(L.byEmail.get(e)!, "email");
  for (const e of [c.email, ...c.altEmails]) if (e && L.fileEmail.has(e)) return follow(L.fileEmail.get(e)!);
  if (!c.phone) {
    return { result: "invalid", contactId: null, match: {}, issues: ["No valid phone: a new contact needs a phone number"] };
  }
  if (c.name && c.city) {
    const k = `${looseKey(c.name)}|${looseKey(c.city)}`;
    const candidates = (L.byName.get(k) ?? []).slice(0, 3);
    if (candidates.length) {
      return {
        result: "conflict",
        contactId: candidates[0].id,
        match: { by: "name_city", candidates, contactName: candidates[0].name },
        issues: [],
      };
    }
    const earlier = L.fileName.get(k);
    if (earlier) {
      return { result: "conflict", contactId: null, match: { by: "name_city", conflictRow: earlier.row, contactName: earlier.name }, issues: [] };
    }
  }
  return { result: "new", contactId: null, match: {}, issues: [] };
}
