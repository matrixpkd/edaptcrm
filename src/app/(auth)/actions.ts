"use server";
import { redirect } from "next/navigation";
import { count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, destroySession } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { fail, str, type ActionResult } from "@/lib/action";

export async function loginAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const email = str(formData, "email")?.toLowerCase();
  const password = str(formData, "password");
  if (!email || !password) return fail("Enter your email and password.");
  const [user] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email)).limit(1);
  const okPw = await verifyPassword(password, user?.passwordHash);
  if (!user || !okPw) return fail("That email and password don't match.");
  if (!user.active) return fail("This account has been deactivated. Ask your admin.");
  await createSession(user.id);
  await audit({ table: "users", rowId: user.id, action: "login", userId: user.id });
  const next = str(formData, "next");
  redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/today");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

/** First-run only: creates the first admin when there are no users at all. */
export async function setupAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n > 0) return fail("Setup is already complete. Sign in instead.");
  const name = str(formData, "name");
  const email = str(formData, "email")?.toLowerCase();
  const password = str(formData, "password");
  if (!name || !email || !password) return fail("All fields are required.");
  if (password.length < 8) return fail("Use at least 8 characters for the password.");
  const [u] = await db
    .insert(users)
    .values({ name, email, passwordHash: await hashPassword(password), role: "admin", team: "kerala" })
    .returning({ id: users.id });
  await createSession(u.id);
  redirect("/settings/users");
}
