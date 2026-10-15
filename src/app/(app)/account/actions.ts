"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { AccountError, changeOwnPassword, setOwnTimezone, signOutOtherSessions } from "@/lib/auth/account";
import { currentSessionId, requireUser } from "@/lib/auth/session";

/**
 * The signed-in person's own account. Every action acts on the session's user only: nobody can change someone
 * else's password or time zone from here (admins do that on the Team page).
 */

function failure(e: unknown, what: string): ActionResult<never> {
  if (e instanceof AccountError) return fail(e.message, e.field ? { [e.field]: e.message } : undefined);
  console.error(`[account] ${what}`, e);
  return fail("Something went wrong. Nothing was changed. Please try again.");
}

export async function changePasswordAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  try {
    // passwords are read raw: spaces at either end are part of what the person typed
    const raw = (k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : null);
    const { sessionsEnded } = await changeOwnPassword(
      user.id,
      { current: raw("current"), next: raw("next"), confirm: raw("confirm") },
      await currentSessionId(),
    );
    revalidatePath("/account");
    return ok(
      undefined,
      sessionsEnded
        ? `Password changed. ${sessionsEnded} other session${sessionsEnded === 1 ? " was" : "s were"} signed out.`
        : "Password changed.",
    );
  } catch (e) {
    return failure(e, "change password");
  }
}

export async function timezoneAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const changed = await setOwnTimezone(user.id, str(fd, "timezone"));
    revalidatePath("/", "layout");
    return ok(undefined, changed ? "Time zone saved." : "That is already your time zone.");
  } catch (e) {
    return failure(e, "time zone");
  }
}

export async function signOutOthersAction(_prev: ActionResult, _fd: FormData): Promise<ActionResult> {
  void _fd;
  const user = await requireUser();
  try {
    const n = await signOutOtherSessions(user.id, await currentSessionId());
    revalidatePath("/account");
    return ok(undefined, n ? `Signed out of ${n} other session${n === 1 ? "" : "s"}.` : "No other sessions were signed in.");
  } catch (e) {
    return failure(e, "sign out other sessions");
  }
}
