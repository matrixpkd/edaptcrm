"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, currentSessionId, destroySession, requirePasswordChoice } from "@/lib/auth/session";
import { authenticate, BAD_CREDENTIALS, createFirstAdmin } from "@/lib/auth/login";
import { AccountError, chooseOwnPassword } from "@/lib/auth/account";
import { requestPasswordReset, resetPasswordWithToken } from "@/lib/auth/password-reset";
import { clientIp } from "@/lib/auth/login-limit";
import { safeNextPath } from "@/lib/auth/redirect";
import { CHOOSE_PASSWORD_PATH } from "@/lib/auth/temporary-password";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { flash } from "@/lib/flash";

/** Passwords are read as typed: spaces at either end are part of the password. */
function rawField(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  return typeof v === "string" && v !== "" ? v : null;
}

export async function loginAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const ip = clientIp(await headers());
  const r = await authenticate(str(formData, "email"), rawField(formData, "password"), ip);
  if (!r.ok) return fail(r.error);
  // false when the password changed (or an admin reset it) in the moment since it was checked
  if (!(await createSession(r.userId, r.passwordHash))) return fail(BAD_CREDENTIALS);
  // signed in with an admin's temporary password: their own password first (every other page sends them there too)
  if (r.mustChoosePassword) redirect(CHOOSE_PASSWORD_PATH);
  // only a path on this site: never "//evil.com", "/\evil.com" or an absolute URL
  redirect(safeNextPath(str(formData, "next"), "/today"));
}

/**
 * "Choose your password" after signing in with an admin's temporary password. requirePasswordChoice is this
 * screen's requireUser: it lets in only a session that still has to choose (signed out → /login, done → /today).
 * This browser stays signed in, every other session ends, and the person lands on Today.
 */
export async function choosePasswordAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requirePasswordChoice();
  try {
    await chooseOwnPassword(user.id, { next: rawField(formData, "next"), confirm: rawField(formData, "confirm") }, await currentSessionId());
  } catch (e) {
    if (e instanceof AccountError) return fail(e.message, e.field ? { [e.field]: e.message } : undefined);
    throw e;
  }
  await flash("Password saved. Use it from now on.");
  redirect("/today");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

/** First-run only: creates the first admin when there are no users at all (race-safe, see createFirstAdmin). */
export async function setupAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const r = await createFirstAdmin({
    name: str(formData, "name"),
    email: str(formData, "email"),
    password: rawField(formData, "password"),
  });
  if (!r.ok) return fail(r.error);
  if (!(await createSession(r.userId, r.passwordHash))) return fail("Setup is complete. Sign in instead.");
  // Today shows the new owner the "Getting started" checklist: team, prices, assignment, integrations, ...
  redirect("/today");
}

/**
 * "Forgot password?": emails a single-use link when email is set up. The answer is the same whether or not the
 * address has an account, so the form cannot be used to find out who works here.
 */
export async function forgotPasswordAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const email = str(formData, "email");
  if (!email) return fail("Enter the email you sign in with.", { email: "Enter the email you sign in with." });
  const r = await requestPasswordReset(email, clientIp(await headers()));
  if (r.reason === "unavailable") return fail("Email is not set up for this CRM. Ask an admin to reset your password.");
  // a failed send (logged on the server) gets the same answer too: anything else would tell who has an account
  return ok(undefined, "If that email belongs to an account, a reset link is on its way. It works once, for one hour. Nothing after a few minutes? Check spam, or ask an admin to reset your password.");
}

/** Sets a new password from an emailed link, then sends the person to sign in with it. */
export async function resetPasswordAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    await resetPasswordWithToken(str(formData, "token"), { next: rawField(formData, "next"), confirm: rawField(formData, "confirm") });
  } catch (e) {
    if (e instanceof AccountError) return fail(e.message, e.field ? { [e.field]: e.message } : undefined);
    throw e;
  }
  redirect("/login?reset=1");
}
