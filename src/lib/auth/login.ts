import "server-only";
import { count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { MIN_PASSWORD_LENGTH } from "./account";
import { checkLoginAllowed, recordLoginAttempt } from "./login-limit";
import { hashPassword, needsRehash, verifyPassword } from "./password";

/**
 * Sign-in and first-run setup, without the cookie and redirect (the server actions in src/app/(auth)/actions.ts
 * add those), so the rules are testable.
 */

export type AuthResult = { ok: true; userId: string } | { ok: false; error: string };

export const BAD_CREDENTIALS = "That email and password don't match.";

/**
 * Checks an email and password from `ip`:
 * - refused before any password check while the email / IP is locked out (login-limit.ts);
 * - one bcrypt comparison whether or not the email exists (no timing difference);
 * - the same message for an unknown email and a wrong password;
 * - a deactivated account is refused only after the right password, so it does not reveal itself to a guesser.
 * Every checked attempt is recorded for the lockout; a successful one is audited.
 */
export async function authenticate(emailRaw: string | null, password: string | null, ip: string, now: Date = new Date()): Promise<AuthResult> {
  const email = (emailRaw ?? "").trim().toLowerCase();
  if (!email || !password) return { ok: false, error: "Enter your email and password." };
  if (email.length > 320) return { ok: false, error: BAD_CREDENTIALS };

  const gate = await checkLoginAllowed(email, ip, now);
  if (!gate.allowed) {
    return {
      ok: false,
      error: `Too many sign-in attempts. Try again in ${gate.retryAfterMinutes} minute${gate.retryAfterMinutes === 1 ? "" : "s"}.`,
    };
  }

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, active: users.active })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  let okPw = await verifyPassword(password, user?.passwordHash);
  // passwords chosen on the account page keep surrounding spaces; older ones (set up before that) were trimmed
  const trimmed = password.trim();
  if (!okPw && user?.passwordHash && trimmed !== password && trimmed) okPw = await verifyPassword(trimmed, user.passwordHash);
  await recordLoginAttempt(email, ip, okPw, now);
  if (!user || !okPw) return { ok: false, error: BAD_CREDENTIALS };
  if (!user.active) return { ok: false, error: "This account has been deactivated. Ask your admin." };

  if (user.passwordHash && needsRehash(user.passwordHash)) {
    await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, user.id));
  }
  await audit({ table: "users", rowId: user.id, action: "login", userId: user.id });
  return { ok: true, userId: user.id };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * First run only: creates the first admin when there are no users at all. Race-safe: the count and the insert
 * run in one transaction under an advisory lock, so two people submitting /setup at the same moment cannot both
 * become admin (the second gets "already complete").
 */
export async function createFirstAdmin(input: { name: string | null; email: string | null; password: string | null }): Promise<AuthResult> {
  const name = input.name?.trim() ?? "";
  const email = (input.email ?? "").trim().toLowerCase();
  const password = input.password ?? "";
  if (!name || !email || !password) return { ok: false, error: "All fields are required." };
  if (name.length > 200) return { ok: false, error: "The name is too long." };
  if (email.length > 320 || !EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.` };
  if (password.length > 200) return { ok: false, error: "That password is too long." };
  const passwordHash = await hashPassword(password);
  const id = await db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext('edapt:first-admin-setup'))`);
    const [{ n }] = await t.select({ n: count() }).from(users);
    if (n > 0) return null;
    const [u] = await t.insert(users).values({ name, email, passwordHash, role: "admin", team: "kerala" }).returning({ id: users.id });
    await audit({ table: "users", rowId: u.id, action: "create", field: "first_admin", newValue: { email, role: "admin" }, userId: u.id }, t);
    return u.id;
  });
  if (!id) return { ok: false, error: "Setup is already complete. Sign in instead." };
  return { ok: true, userId: id };
}

/** True while there are no users at all (the /setup page is only shown then). */
export async function setupOpen(): Promise<boolean> {
  const [{ n }] = await db.select({ n: count() }).from(users);
  return n === 0;
}
