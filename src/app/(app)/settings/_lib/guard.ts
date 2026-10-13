import "server-only";
import { fail, type ActionResult } from "@/lib/action";
import { AdminError } from "@/lib/admin/errors";
import { can } from "@/lib/auth/permissions";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { ContactError } from "@/lib/contacts/errors";

/**
 * For Settings server actions: the signed-in admin, or null (the action then returns a friendly refusal).
 * Signed-out users are redirected to /login by requireUser.
 */
export async function adminForAction(): Promise<SessionUser | null> {
  const user = await requireUser();
  return can(user, "settings.manage") ? user : null;
}

export const NOT_ADMIN = "Only an admin can change settings.";

/** Turns a service error into the form's message; anything unexpected is logged and reported plainly. */
export function failFrom(e: unknown, context: string): ActionResult<never> {
  if (e instanceof AdminError || e instanceof ContactError) {
    return fail(e.message, e.field ? { [e.field]: e.message } : undefined);
  }
  console.error(`[settings] ${context} failed`, e);
  return fail("Something went wrong and nothing was saved. Try again in a minute.");
}

/** Parses the editor's JSON payload (a hidden "json" field). */
export function jsonField(fd: FormData, name = "json"): { ok: true; value: unknown } | { ok: false } {
  const raw = fd.get(name);
  if (typeof raw !== "string" || !raw) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** A message plus any warnings, for ActionResult.message. */
export function withWarnings(message: string, warnings: string[]): string {
  return warnings.length ? `${message} Note: ${warnings.join(" ")}` : message;
}
