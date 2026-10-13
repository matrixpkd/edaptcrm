"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, destroySession } from "@/lib/auth/session";
import { authenticate, createFirstAdmin } from "@/lib/auth/login";
import { clientIp } from "@/lib/auth/login-limit";
import { safeNextPath } from "@/lib/auth/redirect";
import { fail, str, type ActionResult } from "@/lib/action";

/** Passwords are read as typed: spaces at either end are part of the password. */
function rawField(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  return typeof v === "string" && v !== "" ? v : null;
}

export async function loginAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const ip = clientIp(await headers());
  const r = await authenticate(str(formData, "email"), rawField(formData, "password"), ip);
  if (!r.ok) return fail(r.error);
  await createSession(r.userId);
  // only a path on this site: never "//evil.com", "/\evil.com" or an absolute URL
  redirect(safeNextPath(str(formData, "next"), "/today"));
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
  await createSession(r.userId);
  redirect("/settings/users");
}
