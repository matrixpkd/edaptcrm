import "server-only";
import { lt, sql } from "drizzle-orm";
import { db, queryRows, type Tx } from "@/db";
import { rateLimitHits } from "@/db/schema";

/**
 * Per-user limits on lookups that answer questions about contacts the person may not open, stored in
 * `rate_limit_hits` so they hold across serverless instances. The same pattern as the sign-in lockout
 * (src/lib/auth/login-limit.ts): counted rows in a sliding window, refused tries are not recorded (so the limit
 * lifts as the oldest counted lookup ages out), and old rows are pruned nightly.
 */
export type RateLimit = {
  /** stored in rate_limit_hits.bucket */
  bucket: string;
  /** lookups allowed per window */
  max: number;
  windowMinutes: number;
};

/**
 * The Quick Add duplicate check (live while typing, and again on save). The spec gives no number: this is generous
 * for live typing (a slow typist sends a few lookups per number, so about 60 numbers in 10 minutes) and stops a
 * script walking through the number space to learn who owns which contact.
 */
export const QUICK_ADD_LOOKUP_LIMIT: RateLimit = { bucket: "quick_add_lookup", max: 300, windowMinutes: 10 };

/** How long counted lookups are kept (the nightly job prunes older rows); longer than any window. */
export const RATE_LIMIT_RETENTION_HOURS = 24;

/** Thrown by a service when a lookup is over its limit. The message is shown to the person as is. */
export class RateLimitedError extends Error {
  readonly retryAfterMinutes: number;

  constructor(retryAfterMinutes: number, what = "number checks") {
    const m = Math.max(1, retryAfterMinutes);
    super(`Too many ${what} in a short time. Try again in ${m} minute${m === 1 ? "" : "s"}.`);
    this.name = "RateLimitedError";
    this.retryAfterMinutes = m;
  }
}

export type RateGate = { allowed: true } | { allowed: false; retryAfterMinutes: number };

/**
 * Counts one lookup for `subject` when it is under the limit. Over the limit nothing is recorded and the gate says
 * when a slot frees up.
 *
 * One statement (one round trip while typing), and race-safe: it calls `edapt_take_rate_limit`
 * (drizzle/custom/0001_take_rate_limit.sql), which takes a transaction-scoped advisory lock for this bucket and
 * subject, then counts and inserts, all on the server. Lookups sent at the same moment (a script, or several tabs)
 * take turns and never overshoot the limit, and the lock is held only while the server runs that call, never across a
 * round trip, so a burst from one person does not tie up pooled connections. Inside a caller's transaction the lock
 * is held until that transaction ends. Transaction-scoped locks are safe on Supabase's transaction pooler.
 */
export async function takeRateLimit(limit: RateLimit, subject: string, now: Date = new Date(), tx: Tx = db): Promise<RateGate> {
  const since = new Date(now.getTime() - limit.windowMinutes * 60_000);
  const [row] = await queryRows<{ counted: number; oldest: string | Date | null }>(
    sql`select counted, oldest from edapt_take_rate_limit(${limit.bucket}::text, ${subject}::text, ${limit.max}::integer, ${since.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`,
    tx,
  );
  if ((row?.counted ?? 0) < limit.max) return { allowed: true };
  // a slot frees up when the oldest counted lookup leaves the window
  const oldest = row?.oldest ? new Date(row.oldest).getTime() : now.getTime();
  const frees = oldest + limit.windowMinutes * 60_000;
  return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil((frees - now.getTime()) / 60_000)) };
}

/** takeRateLimit, throwing RateLimitedError when the lookup is refused. */
export async function enforceRateLimit(limit: RateLimit, subject: string, now: Date = new Date(), tx: Tx = db): Promise<void> {
  const gate = await takeRateLimit(limit, subject, now, tx);
  if (!gate.allowed) throw new RateLimitedError(gate.retryAfterMinutes);
}

/** Nightly: deletes counted lookups older than the retention window. */
export async function pruneRateLimitHits(now: Date, tx: Tx = db): Promise<{ deleted: number }> {
  const before = new Date(now.getTime() - RATE_LIMIT_RETENTION_HOURS * 3_600_000);
  const rows = await tx.delete(rateLimitHits).where(lt(rateLimitHits.createdAt, before)).returning({ id: rateLimitHits.id });
  return { deleted: rows.length };
}
