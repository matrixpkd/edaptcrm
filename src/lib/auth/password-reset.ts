import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { passwordResets, sessions, users } from "@/db/schema";
import { normalizeUserEmail } from "@/lib/admin/validate";
import { audit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { renderEmail } from "@/emails/render";
import { AccountError, MIN_PASSWORD_LENGTH } from "./account";
import { hashPassword } from "./password";

/**
 * "Forgot password?" by email (/forgot, /reset). Without email (no RESEND_API_KEY) or without a known site address
 * (no APP_URL: a link must never be built from a request's Host header, which an attacker controls) the login page
 * only explains that an admin resets passwords (Team → the person → Reset password).
 *
 * - A link works once, for RESET_TTL_MINUTES. Only the sha256 of its token is stored.
 * - Requesting never reveals whether an email belongs to someone: the answer is the same either way.
 * - At most RESET_LIMITS.perUser links per person and RESET_LIMITS.perIp requests per address an hour.
 * - Using a link sets the new password, voids every other open link of that person and signs them out everywhere.
 */

export const RESET_TTL_MINUTES = 60;
export const RESET_LIMITS = { perUser: 3, perIp: 10, windowMinutes: 60 } as const;

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The site's own address for links in emails, or null when it is not configured. */
export function appBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.APP_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** True when "Forgot password?" can email a link: Resend is set up and the site address is known. */
export function emailResetAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.RESEND_API_KEY?.trim() && appBaseUrl(env) !== null;
}

export type ResetRequestResult = { sent: boolean; reason?: "unavailable" | "no_account" | "rate_limited" | "email_failed" };

/**
 * Emails a reset link to an active user with this email. The caller shows the same message whatever the result
 * (the reason is for logs and tests only), so the form never tells whether an address has an account.
 */
export async function requestPasswordReset(
  rawEmail: string | null | undefined,
  ip: string,
  now: Date = new Date(),
  tx: Tx = db,
): Promise<ResetRequestResult> {
  const base = appBaseUrl();
  if (!emailResetAvailable() || !base) return { sent: false, reason: "unavailable" };
  const email = normalizeUserEmail(rawEmail);
  if (!email) return { sent: false, reason: "no_account" };
  const since = new Date(now.getTime() - RESET_LIMITS.windowMinutes * 60_000);

  const [{ n: fromIp }] = await tx
    .select({ n: count() })
    .from(passwordResets)
    .where(and(eq(passwordResets.ip, ip), gt(passwordResets.createdAt, since)));
  if (Number(fromIp) >= RESET_LIMITS.perIp) return { sent: false, reason: "rate_limited" };

  const [user] = await tx
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(sql`lower(${users.email})`, email), eq(users.active, true)))
    .limit(1);
  if (!user) return { sent: false, reason: "no_account" };

  const [{ n: forUser }] = await tx
    .select({ n: count() })
    .from(passwordResets)
    .where(and(eq(passwordResets.userId, user.id), gt(passwordResets.createdAt, since)));
  if (Number(forUser) >= RESET_LIMITS.perUser) return { sent: false, reason: "rate_limited" };

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + RESET_TTL_MINUTES * 60_000);
  await tx.insert(passwordResets).values({ id: hashResetToken(token), userId: user.id, expiresAt, ip, createdAt: now });

  const link = `${base}/reset?token=${encodeURIComponent(token)}`;
  const first = user.name.split(" ")[0] || user.name;
  const mail = renderEmail({
    subject: "Reset your Edapt CRM password",
    preheader: `The link works once, for ${RESET_TTL_MINUTES} minutes.`,
    title: "Reset your password",
    intro: `Hi ${first}, someone (hopefully you) asked to reset the password of your Edapt CRM account.`,
    blocks: [
      { kind: "button", href: link, label: "Choose a new password" },
      { kind: "text", text: `The link works once, for ${RESET_TTL_MINUTES} minutes.`, muted: true },
    ],
    footer: "If you did not ask for this, ignore this email: your password stays the same.",
  });
  let r: { ok: boolean; error?: string };
  try {
    r = await sendEmail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text });
  } catch (e) {
    // Resend unreachable: the same answer as a refused send
    r = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!r.ok) {
    console.error("[password-reset] email failed", r.error);
    // nobody received this link: drop it so it does not count against the person's hourly limit
    await tx.delete(passwordResets).where(eq(passwordResets.id, hashResetToken(token)));
    return { sent: false, reason: "email_failed" };
  }
  return { sent: true };
}

export type ResetTokenState =
  | { ok: true; userId: string; name: string; email: string }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/** What a reset link is worth right now (for the /reset page); `forUpdate` locks the row inside a transaction. */
export async function checkResetToken(token: string | null | undefined, now: Date = new Date(), tx: Tx = db, forUpdate = false): Promise<ResetTokenState> {
  if (!token || token.length < 20 || token.length > 200) return { ok: false, reason: "invalid" };
  const q = tx
    .select({
      userId: passwordResets.userId,
      expiresAt: passwordResets.expiresAt,
      usedAt: passwordResets.usedAt,
      name: users.name,
      email: users.email,
      active: users.active,
    })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(eq(passwordResets.id, hashResetToken(token)))
    .limit(1);
  const [row] = forUpdate ? await q.for("update", { of: passwordResets }) : await q;
  if (!row || !row.active) return { ok: false, reason: "invalid" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, userId: row.userId, name: row.name, email: row.email };
}

/**
 * Sets a new password from a reset link: the link must be unused, unexpired and its person active. Voids every
 * other open link of theirs, ends all their sessions and writes the audit log (without the password).
 */
export async function resetPasswordWithToken(
  token: string | null | undefined,
  input: { next: string | null; confirm: string | null },
  now: Date = new Date(),
  tx: Tx = db,
): Promise<{ userId: string; email: string }> {
  const next = input.next ?? "";
  if (next.length < MIN_PASSWORD_LENGTH) throw new AccountError(`Use at least ${MIN_PASSWORD_LENGTH} characters`, "next");
  if (next.length > 200) throw new AccountError("That password is too long", "next");
  if (next !== (input.confirm ?? "")) throw new AccountError("The two passwords do not match", "confirm");
  const passwordHash = await hashPassword(next);
  return tx.transaction(async (t) => {
    const state = await checkResetToken(token, now, t, true);
    if (!state.ok) throw new AccountError(RESET_REFUSALS[state.reason]);
    await t.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, state.userId));
    await t
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.userId, state.userId), isNull(passwordResets.usedAt)));
    await t.delete(sessions).where(eq(sessions.userId, state.userId));
    await audit({ table: "users", rowId: state.userId, action: "update", field: "password", newValue: "reset by email link", userId: state.userId }, t);
    return { userId: state.userId, email: state.email };
  });
}

export const RESET_REFUSALS: Record<"invalid" | "expired" | "used", string> = {
  invalid: "This reset link is not valid. Ask for a new one, or ask an admin to reset your password.",
  expired: `This reset link has expired (links work for ${RESET_TTL_MINUTES} minutes). Ask for a new one.`,
  used: "This reset link has already been used. Ask for a new one if you need to.",
};

/** Voids every open reset link of a person (an admin reset their password, or they changed it themselves). */
export async function voidResetLinks(userId: string, now: Date = new Date(), tx: Tx = db): Promise<void> {
  await tx
    .update(passwordResets)
    .set({ usedAt: now })
    .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
}

/** Nightly: drops links that expired or were used more than a day ago. */
export async function prunePasswordResets(now: Date = new Date(), tx: Tx = db): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - 24 * 3600_000);
  const gone = await tx
    .delete(passwordResets)
    .where(or(lt(passwordResets.expiresAt, cutoff), lt(passwordResets.usedAt, cutoff)))
    .returning({ id: passwordResets.id });
  return { deleted: gone.length };
}
