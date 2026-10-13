import "server-only";
/**
 * Plumbing shared by the alert rules, the email sender and the digests: transactions, who receives what,
 * "already sent" markers, and the wording helpers for reasons. Not part of the public API.
 */
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db, type Database, type Tx } from "@/db";
import { auditLog, users, type Role } from "@/db/schema";
import { teamForCountry } from "@/lib/contacts/rules";
import { getSetting, type AssignmentConfig, type Team } from "@/lib/settings";
import { localTime, shortDate, validTimeZone } from "@/lib/today/time";
import { isUuid } from "@/lib/utils";
import { adminIds } from "./core";

export const DAY_MS = 24 * 3600 * 1000;
export const HOUR_MS = 3600 * 1000;

/** Runs `fn` atomically: a transaction on the root handle, a savepoint inside an open transaction. */
export function inTx<T>(tx: Tx, fn: (t: Tx) => Promise<T>): Promise<T> {
  return (tx as Database).transaction((t) => fn(t));
}

/** The person a contact's alert goes to: its owner when they can still act on it, otherwise the pool (null). */
export function assigneeFor(owner: { id: string | null; active: boolean | null; role: Role | null }): string | null {
  if (!owner.id || !owner.active || owner.role === "support") return null;
  return owner.id;
}

/** Time zone used for a pool alert's wording: the contact's team zone (GCC numbers -> Dubai), else India. */
export function teamTimeZone(phoneCountry: string | null, teams: Team[], assignment: AssignmentConfig): string {
  const key = teamForCountry(phoneCountry, assignment);
  return validTimeZone(teams.find((t) => t.key === key)?.timezone);
}

/** "4:30 pm on 13 Oct" in `timeZone` (adds the year when it is not the current one). */
export function atTimeOn(d: Date, now: Date, timeZone: string): string {
  return `${localTime(d, timeZone)} on ${shortDate(d, now, timeZone)}`;
}

/** "₹5,000", "₹1,250.50", "AED 1,500" — whole amounts without decimals. */
export function money(amount: number, currency: string): string {
  const v = Number(amount) || 0;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `${currency} ${v.toLocaleString("en-IN")}`;
  }
}

export function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

// ---------------------------------------------------------------------------
// Umer: admins plus settings digest.weeklyRecipients
// ---------------------------------------------------------------------------

export type DigestRecipient = { userId: string | null; email: string; name: string; timezone: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who receives the weekly summary and the VIP digest ("Owner and Umer"): every active admin, plus each entry of
 * settings digest.weeklyRecipients — a user id, a team member's email, or an outside email address.
 * Deduplicated by email. Inactive users are skipped.
 */
export async function umerRecipients(tx: Tx = db): Promise<DigestRecipient[]> {
  const cfg = await getSetting("digest", tx);
  const entries = (Array.isArray(cfg.weeklyRecipients) ? cfg.weeklyRecipients : [])
    .map((e) => String(e ?? "").trim())
    .filter(Boolean);
  const isId = (e: string): boolean => isUuid(e);
  const ids = unique([...(await adminIds(tx)), ...entries.filter(isId)]);
  const emails = unique(entries.filter((e) => !isId(e) && EMAIL_RE.test(e)).map((e) => e.toLowerCase()));
  const cols = { id: users.id, email: users.email, name: users.name, timezone: users.timezone };
  const byId = ids.length
    ? await tx.select(cols).from(users).where(and(eq(users.active, true), inArray(users.id, ids)))
    : [];
  const byEmail = emails.length
    ? await tx
        .select(cols)
        .from(users)
        .where(and(eq(users.active, true), inArray(sql`lower(${users.email})`, emails)))
    : [];
  const out = new Map<string, DigestRecipient>();
  for (const u of [...byId, ...byEmail]) {
    out.set(u.email.toLowerCase(), { userId: u.id, email: u.email, name: u.name, timezone: validTimeZone(u.timezone) });
  }
  for (const e of emails) {
    if (!out.has(e)) out.set(e, { userId: null, email: e, name: e.split("@")[0], timezone: validTimeZone(null) });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// "Already sent" markers for digests (rows in audit_log, table "alerts")
// ---------------------------------------------------------------------------

const MARKER_TABLE = "alerts";
const MARKER_ACTION = "digest";

/**
 * Atomically claims a marker such as "daily:<userId>:2026-10-13", stamped `at`. Returns false when it already exists (the email
 * went out, or another run is sending it right now). A transaction-scoped advisory lock on the key makes the
 * check-and-insert safe against overlapping cron runs.
 */
export async function claimMarker(
  key: string,
  field: string,
  meta: Record<string, unknown>,
  at: Date,
  tx: Tx = db,
): Promise<boolean> {
  return inTx(tx, async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`edapt:alerts:${key}`}))`);
    const seen = await t
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.tableName, MARKER_TABLE), eq(auditLog.rowId, key)))
      .limit(1);
    if (seen[0]) return false;
    await t.insert(auditLog).values({
      tableName: MARKER_TABLE,
      rowId: key,
      action: MARKER_ACTION,
      field,
      newValue: meta as unknown,
      userId: null,
      changedAt: at,
    });
    return true;
  });
}

/** Updates what a claimed marker records (e.g. { status: "sent", id }). */
export async function updateMarker(key: string, meta: Record<string, unknown>, tx: Tx = db): Promise<void> {
  await tx
    .update(auditLog)
    .set({ newValue: meta as unknown })
    .where(and(eq(auditLog.tableName, MARKER_TABLE), eq(auditLog.rowId, key)));
}

/** Gives a claim back after a failed send, so the next run tries again. */
export async function releaseMarker(key: string, tx: Tx = db): Promise<void> {
  await tx.delete(auditLog).where(and(eq(auditLog.tableName, MARKER_TABLE), eq(auditLog.rowId, key)));
}

/** Which of these marker keys already exist. */
export async function existingMarkers(keys: string[], tx: Tx = db): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await tx
    .select({ rowId: auditLog.rowId })
    .from(auditLog)
    .where(and(eq(auditLog.tableName, MARKER_TABLE), inArray(auditLog.rowId, keys)));
  return new Set(rows.map((r) => r.rowId!).filter(Boolean));
}

/** When the newest marker starting with `prefix` was written (e.g. the person's previous daily digest). */
export async function lastMarkerAt(prefix: string, before: Date, tx: Tx = db): Promise<Date | null> {
  const rows = await tx
    .select({ at: auditLog.changedAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tableName, MARKER_TABLE),
        like(auditLog.rowId, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
        sql`${auditLog.changedAt} < ${before.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(auditLog.changedAt))
    .limit(1);
  return rows[0]?.at ?? null;
}
