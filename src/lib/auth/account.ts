import "server-only";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { passwordResets, sessions, users } from "@/db/schema";
import { isTimeZone } from "@/lib/admin/validate";
import { audit } from "@/lib/audit";
import { hashPassword, verifyPassword } from "./password";

/**
 * The signed-in person's own account (/account): see their details, change their password and time zone, and
 * sign out their other sessions. Every function acts on `userId` only, which callers take from the session; an
 * admin manages other people on the Team page (src/lib/admin/users.ts).
 */

/** Shortest password a person may choose for themselves. */
export const MIN_PASSWORD_LENGTH = 10;

export class AccountError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

/**
 * Changes the user's own password: the current password is required, the new one needs MIN_PASSWORD_LENGTH
 * characters, must be typed twice and must differ from the current one. Every other session of the user ends (the
 * one in `keepSessionId`, this browser, stays signed in). Audited without the password.
 */
export async function changeOwnPassword(
  userId: string,
  input: { current: string | null; next: string | null; confirm: string | null },
  keepSessionId: string | null,
  tx: Tx = db,
): Promise<{ sessionsEnded: number }> {
  const current = input.current ?? "";
  const next = input.next ?? "";
  if (!current) throw new AccountError("Enter your current password", "current");
  if (next.length < MIN_PASSWORD_LENGTH) {
    throw new AccountError(`Use at least ${MIN_PASSWORD_LENGTH} characters`, "next");
  }
  if (next.length > 200) throw new AccountError("That password is too long", "next");
  if (next !== (input.confirm ?? "")) throw new AccountError("The two new passwords do not match", "confirm");
  if (next === current) throw new AccountError("Choose a password different from your current one", "next");

  const [u] = await tx.select({ id: users.id, hash: users.passwordHash, active: users.active }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !u.active) throw new AccountError("Your account is not active");
  if (!(await verifyPassword(current, u.hash))) throw new AccountError("Your current password is not right", "current");

  const passwordHash = await hashPassword(next);
  const sessionsEnded = await tx.transaction(async (t) => {
    await t.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
    // an emailed "forgot password" link must not undo this change (src/lib/auth/password-reset.ts)
    await t.update(passwordResets).set({ usedAt: new Date() }).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
    const ended = await endOtherSessions(userId, keepSessionId, t);
    await audit({ table: "users", rowId: userId, action: "update", field: "password", newValue: "changed by the user", userId }, t);
    return ended;
  });
  return { sessionsEnded };
}

/** Sets the user's own time zone (dates, the Today list and the 8:30 digest follow it). Returns false when unchanged. */
export async function setOwnTimezone(userId: string, timezone: string | null, tx: Tx = db): Promise<boolean> {
  const tz = timezone?.trim() ?? "";
  if (!isTimeZone(tz)) throw new AccountError("Choose a time zone from the list", "timezone");
  const [u] = await tx.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new AccountError("Your account no longer exists");
  if (u.timezone === tz) return false;
  await tx.transaction(async (t) => {
    await t.update(users).set({ timezone: tz, updatedAt: new Date() }).where(eq(users.id, userId));
    await audit({ table: "users", rowId: userId, action: "update", field: "timezone", oldValue: u.timezone, newValue: tz, userId }, t);
  });
  return true;
}

/** Ends every session of the user except `keepSessionId` (this browser). Returns how many ended. */
export async function signOutOtherSessions(userId: string, keepSessionId: string | null, tx: Tx = db): Promise<number> {
  return endOtherSessions(userId, keepSessionId, tx);
}

async function endOtherSessions(userId: string, keepSessionId: string | null, tx: Tx): Promise<number> {
  const where = keepSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)) : eq(sessions.userId, userId);
  const ended = await tx.delete(sessions).where(where).returning({ id: sessions.id });
  return ended.length;
}

export type OwnSession = { current: boolean; userAgent: string | null; createdAt: Date; expiresAt: Date };

/** The user's live sessions, newest first, marking the one in `currentSessionId`. Session ids are never returned. */
export async function listOwnSessions(userId: string, currentSessionId: string | null, now: Date = new Date(), tx: Tx = db): Promise<OwnSession[]> {
  const rows = await tx
    .select({ id: sessions.id, userAgent: sessions.userAgent, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.createdAt))
    .limit(50);
  return rows.map((r) => ({ current: r.id === currentSessionId, userAgent: r.userAgent, createdAt: r.createdAt, expiresAt: r.expiresAt }));
}

/** "Chrome on Android", "Safari on iPhone", ... from a user-agent string; "Unknown browser" when it says nothing. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return os ? `${browser} on ${os}` : browser;
}
