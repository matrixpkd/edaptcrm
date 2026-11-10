import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, queryRows } from "@/db";
import { sessions, users, type Role, type User } from "@/db/schema";
import { CHOOSE_PASSWORD_PATH } from "./temporary-password";

export const SESSION_COOKIE = "edapt_session";
const SESSION_DAYS = 30;

export type SessionUser = Pick<User, "id" | "name" | "email" | "role" | "team" | "timezone" | "active">;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Opens a session for someone who just signed in and sets the cookie. `passwordHash` is the stored hash their
 * password matched (from authenticate / createFirstAdmin). The session is written only while the person is active
 * and that is still their password, checked with their row locked (FOR SHARE). So a password change, an admin's
 * reset or a deactivation that lands between the password check and this insert either commits first (nothing is
 * opened: returns false, no cookie) or waits for this insert and then ends this session with the others. Without
 * that, a sign-in with the old password could outlive a reset and choose a password over the admin's new temporary
 * one.
 */
export async function createSession(userId: string, passwordHash: string): Promise<boolean> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  const h = await headers();
  const userAgent = h.get("user-agent")?.slice(0, 300) ?? null;
  const opened = await queryRows<{ id: string }>(sql`
    insert into sessions (id, user_id, expires_at, user_agent)
    select ${hashToken(token)}::text, u.id, ${expiresAt.toISOString()}::timestamptz, ${userAgent}::text
    from users u
    where u.id = ${userId}::uuid and u.active and u.password_hash = ${passwordHash}::text
    for share
    returning id`);
  if (opened.length === 0) return false;
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return true;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
  jar.delete(SESSION_COOKIE);
}

/** The id (token hash) of this browser's session, or null when there is no session cookie. */
export async function currentSessionId(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? hashToken(token) : null;
}

/** Ends every session of a user (used when someone is deactivated). */
export async function destroyUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** A session's person, and whether they must still choose their own password (they signed in with a temporary one). */
export type SessionState = { user: SessionUser; mustChoosePassword: boolean };

/**
 * Who this browser's session belongs to, or null. Cached per request. Includes someone who signed in with an
 * admin's temporary password and has not chosen their own yet: only the sign-in and "Choose your password" screens
 * use this. Everything else goes through getCurrentUser / requireUser / getApiUser, which shut such a session out.
 */
export const getSessionState = cache(async (): Promise<SessionState | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      team: users.team,
      timezone: users.timezone,
      active: users.active,
      passwordTemporaryUntil: users.passwordTemporaryUntil,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row || !row.active) return null;
  const { passwordTemporaryUntil, ...user } = row;
  // Sessions of someone on a temporary password were opened with it (a new teammate has none before, and a reset
  // ends them all), so one may still choose a password after the temporary one expires; it can do nothing else.
  return { user, mustChoosePassword: passwordTemporaryUntil !== null };
});

/**
 * The signed-in user for this request, or null. Cached per request. Null as well while the person still has to
 * choose their own password, so nothing that reads it treats a temporary-password session as signed in.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const s = await getSessionState();
  return s && !s.mustChoosePassword ? s.user : null;
});

/**
 * For pages and server actions: the signed-in user, redirecting to /login when signed out and to "Choose your
 * password" while the person is on a temporary password. When `roles` is given and the user's role is not in it,
 * redirects to /today.
 */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const s = await getSessionState();
  if (!s) redirect("/login");
  if (s.mustChoosePassword) redirect(CHOOSE_PASSWORD_PATH);
  const user = s.user;
  if (roles && !roles.includes(user.role)) redirect("/today?denied=1");
  return user;
}

/**
 * For the "Choose your password" screen and its action only: the person who signed in with a temporary password.
 * Redirects to /login when signed out and to /today when they already chose their own.
 */
export async function requirePasswordChoice(): Promise<SessionUser> {
  const s = await getSessionState();
  if (!s) redirect("/login");
  if (!s.mustChoosePassword) redirect("/today");
  return s.user;
}

/** For route handlers: the user or null (never redirects). Null while the person must still choose their password. */
export async function getApiUser(roles?: Role[]): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  if (roles && !roles.includes(user.role)) return null;
  return user;
}
