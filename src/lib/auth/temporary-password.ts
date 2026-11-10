/**
 * Temporary passwords an admin issues (Team → Add teammate, Team → the person → Reset password). PURE: safe in
 * client components (the invite message and the password panel quote the number of days).
 *
 * - The password works for TEMP_PASSWORD_DAYS; after that sign-in refuses it, but only once the password matched
 *   (src/lib/auth/login.ts), so the answer never tells a guesser whether an email has an account.
 * - Signing in with it opens a session that can only choose the person's own password (src/lib/auth/session.ts).
 * - `users.password_temporary_until` holds the expiry; null means the person chose their own password.
 *
 * The spec gives no number, so the period is a constant here rather than a setting.
 */

/** How long a temporary password from an admin works if nobody signs in with it. */
export const TEMP_PASSWORD_DAYS = 7;

const DAY_MS = 24 * 3600 * 1000;

/** When a temporary password issued at `now` stops working. */
export function temporaryPasswordExpiry(now: Date): Date {
  return new Date(now.getTime() + TEMP_PASSWORD_DAYS * DAY_MS);
}

export type TemporaryPasswordState = "own" | "temporary" | "expired";

/**
 * "own" when the person chose their password (no expiry stored), "temporary" while an admin's temporary password
 * still works, "expired" from the moment it stops working.
 */
export function temporaryPasswordState(until: Date | null | undefined, now: Date): TemporaryPasswordState {
  if (!until) return "own";
  return until.getTime() > now.getTime() ? "temporary" : "expired";
}

/** The sign-in refusal for an expired temporary password (shown only after the password matched). */
export const TEMP_PASSWORD_EXPIRED = "This temporary password has expired. Ask an admin to reset it.";

/** Where a session on a temporary password is sent until the person chooses their own. */
export const CHOOSE_PASSWORD_PATH = "/choose-password";
