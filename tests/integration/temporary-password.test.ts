/**
 * Temporary passwords an admin issues (Add teammate, Reset password): they work for 7 days, and signing in with
 * one opens a session that can only choose the person's own password. The cookie jar, the request headers and
 * redirect() are stubbed (there is no request scope here); the session code, the actions, the services and the
 * database are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, loginAttempts, passwordResets, sessions, users } from "@/db/schema";
import { makeUser, resetDb } from "../support/db";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers({ "user-agent": "vitest", "x-real-ip": "10.1.1.1" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { createUser, deactivateUser, getAdminUser, reactivateUser, resetUserPassword } = await import("@/lib/admin/users");
const { AccountError, changeOwnPassword, chooseOwnPassword } = await import("@/lib/auth/account");
const { authenticate, BAD_CREDENTIALS } = await import("@/lib/auth/login");
const { LOGIN_LIMITS } = await import("@/lib/auth/login-limit");
const { hashPassword, verifyPassword } = await import("@/lib/auth/password");
const { checkResetToken, hashResetToken, resetPasswordWithToken } = await import("@/lib/auth/password-reset");
const session = await import("@/lib/auth/session");
const { TEMP_PASSWORD_DAYS, TEMP_PASSWORD_EXPIRED } = await import("@/lib/auth/temporary-password");
const { FLASH_COOKIE } = await import("@/lib/flash-cookie");
const authActions = await import("@/app/(auth)/actions");
const accountActions = await import("@/app/(app)/account/actions");
const userActions = await import("@/app/(app)/settings/users/actions");
const search = await import("@/app/api/search/route");

const DAY = 24 * 3600 * 1000;
const IP = "10.1.1.1";

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

/** Runs an action or a session check; a redirect comes back as { redirect }. */
async function run<T>(fn: () => Promise<T>): Promise<T | { redirect: string }> {
  try {
    return await fn();
  } catch (e) {
    const m = /^NEXT_REDIRECT:(.*)$/.exec((e as Error).message);
    if (m) return { redirect: m[1] };
    throw e;
  }
}

async function userRow(id: string) {
  return (await db.select().from(users).where(eq(users.id, id)))[0];
}

/** A teammate added by an admin, with the temporary password the admin was shown. */
async function newTeammate(role: "sales" | "admin" = "sales") {
  const admin = await makeUser({ role: "admin" });
  const { user, tempPassword } = await createUser(
    { name: "Asha Nair", email: `asha-${Date.now()}@edapt.in`, role, team: "kerala", timezone: null, phone: null },
    admin,
  );
  return { admin, user, tempPassword };
}

/** Signs in through the real login action; the session cookie lands in the stubbed jar. */
function signIn(email: string, password: string, next = "") {
  return run(() => authActions.loginAction(null, form({ email, password, next })));
}

async function sessionIds(userId: string) {
  return (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).map((s) => s.id).sort();
}

function expectWithin(d: Date | null, from: number, to: number) {
  expect(d).toBeInstanceOf(Date);
  expect(d!.getTime()).toBeGreaterThanOrEqual(from);
  expect(d!.getTime()).toBeLessThanOrEqual(to);
}

describe("temporary passwords from an admin", () => {
  beforeEach(async () => {
    await resetDb();
    jar.clear();
  });

  it("adding a teammate and resetting a password both give a temporary password that works for 7 days", async () => {
    const before = Date.now();
    const { admin, user } = await newTeammate();
    expectWithin(user.passwordTemporaryUntil, before + TEMP_PASSWORD_DAYS * DAY, Date.now() + TEMP_PASSWORD_DAYS * DAY);
    // the Team page shows it
    expect((await getAdminUser(user.id))?.passwordTemporaryUntil?.getTime()).toBe(user.passwordTemporaryUntil!.getTime());

    // someone who chose their own long ago gets a fresh temporary one from a reset
    const old = await makeUser({ role: "sales" });
    expect((await userRow(old.id)).passwordTemporaryUntil).toBeNull();
    const t0 = Date.now();
    const { tempPassword } = await resetUserPassword(old.id, admin);
    const row = await userRow(old.id);
    expect(await verifyPassword(tempPassword, row.passwordHash)).toBe(true);
    expectWithin(row.passwordTemporaryUntil, t0 + TEMP_PASSWORD_DAYS * DAY, Date.now() + TEMP_PASSWORD_DAYS * DAY);
  });

  it("a valid temporary password signs in, but every page, action and API sends the person to choose their own", async () => {
    const { user, tempPassword } = await newTeammate("admin");
    expect(await authenticate(user.email, tempPassword, IP)).toEqual({ ok: true, userId: user.id, mustChoosePassword: true });

    expect(await signIn(user.email, tempPassword, "/contacts")).toEqual({ redirect: "/choose-password" });
    expect(jar.has(session.SESSION_COOKIE)).toBe(true);
    expect(await sessionIds(user.id)).toHaveLength(1);
    // signing in is audited like any other
    const logins = await db.select().from(auditLog).where(and(eq(auditLog.rowId, user.id), eq(auditLog.action, "login")));
    expect(logins).toHaveLength(2);

    // the session is there, but only for choosing a password
    expect(await session.getSessionState()).toMatchObject({ user: { id: user.id }, mustChoosePassword: true });
    expect(await session.getCurrentUser()).toBeNull();
    expect(await session.getApiUser()).toBeNull();
    expect(await session.getApiUser(["admin"])).toBeNull();
    // pages (the signed-in layout and every page call requireUser) and actions
    expect(await run(() => session.requireUser())).toEqual({ redirect: "/choose-password" });
    expect(await run(() => session.requireUser(["admin"]))).toEqual({ redirect: "/choose-password" });
    expect(
      await run(() => accountActions.changePasswordAction(null, form({ current: tempPassword, next: "my own password", confirm: "my own password" }))),
    ).toEqual({ redirect: "/choose-password" });
    expect(
      await run(() =>
        userActions.createUserAction(null, form({ name: "Sneaky", email: "sneaky@edapt.in", role: "admin", team: "kerala", timezone: "", phone: "" })),
      ),
    ).toEqual({ redirect: "/choose-password" });
    expect(await db.select().from(users).where(eq(users.email, "sneaky@edapt.in"))).toHaveLength(0);
    // API routes answer with JSON
    const res = await search.GET(new Request("http://localhost/api/search?q=asha"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorised" });

    // the "Choose your password" screen lets them in
    expect(await session.requirePasswordChoice()).toMatchObject({ id: user.id, email: user.email });

    // and signing out still works
    expect(await run(() => authActions.logoutAction())).toEqual({ redirect: "/login" });
    expect(jar.has(session.SESSION_COOKIE)).toBe(false);
    expect(await sessionIds(user.id)).toEqual([]);
    expect(await run(() => session.requirePasswordChoice())).toEqual({ redirect: "/login" });
  });

  it("an expired temporary password is refused, but only after the right password", async () => {
    const { user, tempPassword } = await newTeammate();
    const until = user.passwordTemporaryUntil!;
    const later = new Date(until.getTime() + 60_000);

    // just before the expiry it still works; from the expiry on it does not
    expect((await authenticate(user.email, tempPassword, "10.0.0.9", new Date(until.getTime() - 60_000))).ok).toBe(true);
    expect(await authenticate(user.email, tempPassword, IP, until)).toEqual({ ok: false, error: TEMP_PASSWORD_EXPIRED });

    // a wrong password gets the usual answer: nothing tells a guesser the account exists
    expect(await authenticate(user.email, "a wrong guess", IP, later)).toEqual({ ok: false, error: BAD_CREDENTIALS });
    expect(await authenticate("nobody@edapt.in", tempPassword, IP, later)).toEqual({ ok: false, error: BAD_CREDENTIALS });
    expect(await authenticate(user.email, tempPassword, IP, later)).toEqual({ ok: false, error: TEMP_PASSWORD_EXPIRED });
    expect(TEMP_PASSWORD_EXPIRED).toBe("This temporary password has expired. Ask an admin to reset it.");

    // counted like the deactivated refusal: the right password is a successful check, never a sign-in in the audit
    const attempts = await db.select().from(loginAttempts).where(eq(loginAttempts.email, user.email));
    expect(attempts.filter((a) => a.success && a.ip === IP)).toHaveLength(2);
    const logins = await db.select().from(auditLog).where(and(eq(auditLog.rowId, user.id), eq(auditLog.action, "login")));
    expect(logins).toHaveLength(1); // the one before the expiry

    // the lockout is still checked first
    for (let i = 0; i < LOGIN_LIMITS.PER_EMAIL_IP; i++) await authenticate(user.email, `guess ${i}`, "6.6.6.6", later);
    expect((await authenticate(user.email, tempPassword, "6.6.6.6", later)) as { error: string }).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Too many sign-in attempts/),
    });

    // through the form: the message, and no session
    await db.update(users).set({ passwordTemporaryUntil: new Date(Date.now() - 60_000) }).where(eq(users.id, user.id));
    expect(await signIn(user.email, tempPassword)).toEqual({ ok: false, error: TEMP_PASSWORD_EXPIRED });
    expect(jar.has(session.SESSION_COOKIE)).toBe(false);
    expect(await sessionIds(user.id)).toEqual([]);

    // a deactivated account still says that first
    await db.update(users).set({ active: false }).where(eq(users.id, user.id));
    expect(await authenticate(user.email, tempPassword, "10.0.0.8")).toMatchObject({ ok: false, error: expect.stringMatching(/deactivated/) });
  });

  it("choosing a password clears the temporary one, keeps this browser signed in, ends the others and opens the app", async () => {
    const { user, tempPassword } = await newTeammate();
    expect(await signIn(user.email, tempPassword)).toEqual({ redirect: "/choose-password" });
    const here = (await session.currentSessionId())!;
    await db.insert(sessions).values({ id: "their-phone", userId: user.id, expiresAt: new Date(Date.now() + DAY) });
    const token = "an-open-forgot-password-link-token";
    await db.insert(passwordResets).values({ id: hashResetToken(token), userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });

    const choose = (next: string, confirm = next) => run(() => authActions.choosePasswordAction(null, form({ next, confirm })));
    expect(await choose("too short")).toMatchObject({ ok: false, fieldErrors: { next: "Use at least 10 characters" } });
    expect(await choose("x".repeat(201))).toMatchObject({ ok: false, fieldErrors: { next: "That password is too long" } });
    expect(await choose("my own password", "my own passwrod")).toMatchObject({ ok: false, fieldErrors: { confirm: "The two passwords do not match" } });
    expect(await choose(tempPassword)).toMatchObject({ ok: false, fieldErrors: { next: "Choose a password different from the temporary one" } });
    expect((await userRow(user.id)).passwordTemporaryUntil).not.toBeNull();

    expect(await choose("  my very own password ")).toEqual({ redirect: "/today" });
    expect(jar.get(FLASH_COOKIE)).toBe("Password saved. Use it from now on.");
    const row = await userRow(user.id);
    expect(row.passwordTemporaryUntil).toBeNull();
    // spaces are part of what they typed
    expect(await verifyPassword("  my very own password ", row.passwordHash)).toBe(true);
    expect(await verifyPassword(tempPassword, row.passwordHash)).toBe(false);
    expect(await sessionIds(user.id)).toEqual([here]);
    expect(await checkResetToken(token)).toEqual({ ok: false, reason: "used" });
    const [log] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.rowId, user.id), eq(auditLog.field, "password")));
    expect(log).toMatchObject({ action: "update", userId: user.id, newValue: "chosen by the user" });
    expect(JSON.stringify(log)).not.toContain("my very own password");

    // the gate lets them through now
    expect(await session.requireUser()).toMatchObject({ id: user.id });
    expect(await session.getCurrentUser()).toMatchObject({ id: user.id });
    expect(await session.getApiUser(["sales"])).toMatchObject({ id: user.id });
    expect((await search.GET(new Request("http://localhost/api/search?q=asha"))).status).toBe(200);
    expect(await run(() => session.requirePasswordChoice())).toEqual({ redirect: "/today" });
    expect(await choose("another long password")).toEqual({ redirect: "/today" });
    await expect(chooseOwnPassword(user.id, { next: "another long password", confirm: "another long password" }, here)).rejects.toThrow(
      /already chosen your password/,
    );
    // and the new password signs in like anyone's
    expect(await authenticate(user.email, "  my very own password ", "10.0.0.7")).toEqual({ ok: true, userId: user.id });
  });

  it("changing your own password, or using an emailed reset link, also clears the temporary one", async () => {
    const { admin, user, tempPassword } = await newTeammate();
    await changeOwnPassword(user.id, { current: tempPassword, next: "chosen on the account page", confirm: "chosen on the account page" }, null);
    expect((await userRow(user.id)).passwordTemporaryUntil).toBeNull();

    await resetUserPassword(user.id, admin);
    expect((await userRow(user.id)).passwordTemporaryUntil).not.toBeNull();
    const token = "a-forgot-password-link-for-asha-0001";
    await db.insert(passwordResets).values({ id: hashResetToken(token), userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
    await resetPasswordWithToken(token, { next: "chosen from the email link", confirm: "chosen from the email link" });
    const row = await userRow(user.id);
    expect(row.passwordTemporaryUntil).toBeNull();
    expect(await authenticate(user.email, "chosen from the email link", IP)).toEqual({ ok: true, userId: user.id });
  });

  it("chooseOwnPassword refuses a deactivated account", async () => {
    const { user } = await newTeammate();
    await db.update(users).set({ active: false }).where(eq(users.id, user.id));
    await expect(chooseOwnPassword(user.id, { next: "long enough password", confirm: "long enough password" }, null)).rejects.toBeInstanceOf(AccountError);
    expect((await userRow(user.id)).passwordTemporaryUntil).not.toBeNull();
  });

  it("deactivating someone voids their open reset links, so reactivating them does not bring a link back", async () => {
    const admin = await makeUser({ role: "admin" });
    const manager = await makeUser({ role: "manager" });
    const leaver = await makeUser({ role: "sales", name: "Leaver" });
    const other = await makeUser({ role: "sales" });
    const tokens = ["leaver-reset-link-token-number-1", "leaver-reset-link-token-number-2", "other-reset-link-token-number-01"];
    await db.insert(passwordResets).values([
      { id: hashResetToken(tokens[0]), userId: leaver.id, expiresAt: new Date(Date.now() + 3600_000) },
      { id: hashResetToken(tokens[1]), userId: leaver.id, expiresAt: new Date(Date.now() + 3600_000) },
      { id: hashResetToken(tokens[2]), userId: other.id, expiresAt: new Date(Date.now() + 3600_000) },
    ]);

    await deactivateUser(leaver.id, manager.id, admin);
    const open = await db.select().from(passwordResets).where(eq(passwordResets.userId, leaver.id));
    expect(open.map((r) => r.usedAt)).toEqual([expect.any(Date), expect.any(Date)]);
    expect(await checkResetToken(tokens[0])).toEqual({ ok: false, reason: "invalid" });

    await reactivateUser(leaver.id, admin);
    expect(await checkResetToken(tokens[0])).toEqual({ ok: false, reason: "used" });
    expect(await checkResetToken(tokens[1])).toEqual({ ok: false, reason: "used" });
    // someone else's link is untouched
    expect(await checkResetToken(tokens[2])).toMatchObject({ ok: true, userId: other.id });
  });

  it("people who chose their own password sign in and use the app as before", async () => {
    const u = await makeUser({ role: "manager" });
    expect(u.passwordTemporaryUntil).toBeNull();
    await db.update(users).set({ passwordHash: await hashPassword("their own password") }).where(eq(users.id, u.id));
    expect(await authenticate(u.email, "their own password", IP)).toEqual({ ok: true, userId: u.id });
    expect(await signIn(u.email, "their own password", "/contacts?q=asha")).toEqual({ redirect: "/contacts?q=asha" });
    expect(await session.requireUser(["manager"])).toMatchObject({ id: u.id, role: "manager" });
    expect(await session.getApiUser()).toMatchObject({ id: u.id });
    expect(await run(() => session.requirePasswordChoice())).toEqual({ redirect: "/today" });
  });
});
