import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { loginAttempts, sessions } from "@/db/schema";

/**
 * Sign-in brute-force protection, stored in `login_attempts` so it holds across serverless instances.
 *
 * Within the last WINDOW_MINUTES a sign-in is refused BEFORE the password is checked when:
 * - this email from this IP failed PER_EMAIL_IP times (someone mistyping, or a targeted guess), or
 * - this email failed PER_EMAIL times from any IPs (a distributed guess at one account), or
 * - this IP failed PER_IP times for any emails (one machine spraying passwords across accounts).
 * A successful sign-in clears the failures of that email + IP. Refused attempts are not recorded, so the lock
 * lifts WINDOW_MINUTES after the last counted failure.
 *
 * Trade-off: the per-email limit lets an attacker who knows an email lock that person out for up to
 * WINDOW_MINUTES at a time. It sits well above the per email + IP limit, so it only trips under a guess spread
 * over many IPs, which is the attack it exists to stop; see docs/SECURITY.md.
 */
export const LOGIN_LIMITS = {
  WINDOW_MINUTES: 15,
  PER_EMAIL_IP: 5,
  PER_EMAIL: 20,
  PER_IP: 50,
} as const;

/** How long attempts are kept (the nightly job prunes older rows). */
export const LOGIN_ATTEMPT_RETENTION_HOURS = 24;

export type LoginGate = { allowed: true } | { allowed: false; retryAfterMinutes: number };

/** The client IP as the platform reports it (Vercel sets x-real-ip / x-forwarded-for itself). */
export function clientIp(h: { get(name: string): string | null }): string {
  const real = h.get("x-real-ip")?.trim();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = real || forwarded || "unknown";
  return ip.slice(0, 64);
}

function normEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 320);
}

/** May this email + IP try a password now? Checked before the password is verified. */
export async function checkLoginAllowed(email: string, ip: string, now: Date = new Date(), tx: Tx = db): Promise<LoginGate> {
  const e = normEmail(email);
  const since = new Date(now.getTime() - LOGIN_LIMITS.WINDOW_MINUTES * 60_000);
  const [row] = await tx
    .select({
      emailIp: sql<number>`count(*) filter (where ${loginAttempts.email} = ${e} and ${loginAttempts.ip} = ${ip})::int`,
      email: sql<number>`count(*) filter (where ${loginAttempts.email} = ${e})::int`,
      ip: sql<number>`count(*) filter (where ${loginAttempts.ip} = ${ip})::int`,
      oldestEmailIp: sql<string | null>`min(${loginAttempts.createdAt}) filter (where ${loginAttempts.email} = ${e} and ${loginAttempts.ip} = ${ip})`,
      newest: sql<string | null>`max(${loginAttempts.createdAt})`,
    })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.success, false),
        gte(loginAttempts.createdAt, since),
        sql`(${loginAttempts.email} = ${e} or ${loginAttempts.ip} = ${ip})`,
      ),
    );
  const locked =
    (row?.emailIp ?? 0) >= LOGIN_LIMITS.PER_EMAIL_IP || (row?.email ?? 0) >= LOGIN_LIMITS.PER_EMAIL || (row?.ip ?? 0) >= LOGIN_LIMITS.PER_IP;
  if (!locked) return { allowed: true };
  // the lock lifts a window after the newest counted failure
  const newest = row?.newest ? new Date(row.newest).getTime() : now.getTime();
  const lifts = newest + LOGIN_LIMITS.WINDOW_MINUTES * 60_000;
  return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil((lifts - now.getTime()) / 60_000)) };
}

/** Records the outcome of a password check. A success clears the failures of this email + IP. */
export async function recordLoginAttempt(email: string, ip: string, success: boolean, now: Date = new Date(), tx: Tx = db): Promise<void> {
  const e = normEmail(email);
  if (success) {
    await tx.delete(loginAttempts).where(and(eq(loginAttempts.email, e), eq(loginAttempts.ip, ip), eq(loginAttempts.success, false)));
  }
  await tx.insert(loginAttempts).values({ email: e, ip, success, createdAt: now });
}

/** Nightly: deletes attempts older than the retention window. */
export async function pruneLoginAttempts(now: Date, tx: Tx = db): Promise<{ deleted: number }> {
  const before = new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_HOURS * 3_600_000);
  const rows = await tx.delete(loginAttempts).where(lt(loginAttempts.createdAt, before)).returning({ id: loginAttempts.id });
  return { deleted: rows.length };
}

/** Nightly: deletes sessions past their expiry (they no longer sign anyone in; this only tidies the table). */
export async function pruneExpiredSessions(now: Date, tx: Tx = db): Promise<{ deleted: number }> {
  const rows = await tx.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id });
  return { deleted: rows.length };
}
