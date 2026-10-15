import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, passwordResets, sessions, users } from "@/db/schema";
import { sendEmail, type Email } from "@/lib/email";
import { resetUserPassword } from "@/lib/admin/users";
import { AccountError, changeOwnPassword } from "@/lib/auth/account";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  appBaseUrl,
  checkResetToken,
  emailResetAvailable,
  hashResetToken,
  prunePasswordResets,
  requestPasswordReset,
  RESET_LIMITS,
  resetPasswordWithToken,
} from "@/lib/auth/password-reset";
import { makeUser, resetDb } from "../support/db";

const sent: Email[] = [];
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (e: Email) => {
    sent.push(e);
    return { ok: true, id: "test" };
  }),
}));

const NOW = new Date("2026-10-15T10:00:00Z");
const MIN = 60_000;

async function person(email = "asha@edapt.in", password = "old-password-1") {
  const u = await makeUser({ role: "sales", email });
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, u.id));
  return u;
}

/** The token from the last email's link. */
function lastToken(): string {
  const m = /\/reset\?token=([A-Za-z0-9_%-]+)/.exec(sent.at(-1)!.text ?? "");
  return decodeURIComponent(m![1]);
}

async function hashOf(id: string) {
  return (await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, id)))[0].h;
}

describe("forgot password by email", () => {
  beforeEach(async () => {
    await resetDb();
    sent.length = 0;
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("APP_URL", "https://crm.edapt.in/");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is offered only when Resend and the site address are both configured", () => {
    expect(emailResetAvailable({ RESEND_API_KEY: "re_x", APP_URL: "https://crm.edapt.in" })).toBe(true);
    expect(emailResetAvailable({ RESEND_API_KEY: "", APP_URL: "https://crm.edapt.in" })).toBe(false);
    // never a link built from the request's Host header
    expect(emailResetAvailable({ RESEND_API_KEY: "re_x" })).toBe(false);
    expect(appBaseUrl({ APP_URL: "javascript:alert(1)" })).toBeNull();
    expect(appBaseUrl({ APP_URL: "https://crm.edapt.in/some/path" })).toBe("https://crm.edapt.in");
  });

  it("emails a one-hour, single-use link; only the token's hash is stored", async () => {
    const u = await person();
    expect(await requestPasswordReset("  ASHA@edapt.in ", "1.2.3.4", NOW)).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("asha@edapt.in");
    expect(sent[0].text).toContain("https://crm.edapt.in/reset?token=");
    expect(sent[0].html).toContain("Choose a new password");
    const token = lastToken();
    const [row] = await db.select().from(passwordResets);
    expect(row.id).toBe(hashResetToken(token));
    expect(row.id).not.toContain(token);
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(60 * MIN);

    expect(await checkResetToken(token, NOW)).toMatchObject({ ok: true, userId: u.id, email: "asha@edapt.in" });
    await db.insert(sessions).values({ id: "phone", userId: u.id, expiresAt: new Date(NOW.getTime() + 86400_000) });

    await resetPasswordWithToken(token, { next: "a brand new password", confirm: "a brand new password" }, new Date(NOW.getTime() + 5 * MIN));
    expect(await verifyPassword("a brand new password", await hashOf(u.id))).toBe(true);
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(0);
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.tableName, "users"), eq(auditLog.field, "password")));
    expect(a).toMatchObject({ rowId: u.id, newValue: "reset by email link", userId: u.id });

    // single use
    expect(await checkResetToken(token, NOW)).toEqual({ ok: false, reason: "used" });
    await expect(resetPasswordWithToken(token, { next: "another new password", confirm: "another new password" }, NOW)).rejects.toThrow(/already been used/);
  });

  it("refuses expired, unknown and deactivated-account links, and weak or mismatched passwords", async () => {
    const u = await person();
    await requestPasswordReset("asha@edapt.in", "1.2.3.4", NOW);
    const token = lastToken();
    await expect(resetPasswordWithToken(token, { next: "short", confirm: "short" }, NOW)).rejects.toBeInstanceOf(AccountError);
    await expect(resetPasswordWithToken(token, { next: "long enough pass", confirm: "long enough pasz" }, NOW)).rejects.toMatchObject({ field: "confirm" });
    expect(await checkResetToken(token, new Date(NOW.getTime() + 61 * MIN))).toEqual({ ok: false, reason: "expired" });
    await expect(resetPasswordWithToken(token, { next: "long enough pass", confirm: "long enough pass" }, new Date(NOW.getTime() + 61 * MIN))).rejects.toThrow(/expired/);
    expect(await checkResetToken("not-a-real-token-but-long-enough", NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await checkResetToken(null, NOW)).toEqual({ ok: false, reason: "invalid" });
    await db.update(users).set({ active: false }).where(eq(users.id, u.id));
    expect(await checkResetToken(token, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyPassword("old-password-1", await hashOf(u.id))).toBe(true);
  });

  it("answers the same for unknown and deactivated emails and sends nothing", async () => {
    const u = await person();
    expect(await requestPasswordReset("nobody@edapt.in", "1.2.3.4", NOW)).toMatchObject({ sent: false, reason: "no_account" });
    await db.update(users).set({ active: false }).where(eq(users.id, u.id));
    expect(await requestPasswordReset("asha@edapt.in", "1.2.3.4", NOW)).toMatchObject({ sent: false, reason: "no_account" });
    expect(sent).toHaveLength(0);
  });

  it("without email set up, nothing is stored or sent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    await person();
    expect(await requestPasswordReset("asha@edapt.in", "1.2.3.4", NOW)).toEqual({ sent: false, reason: "unavailable" });
    expect(await db.select().from(passwordResets)).toHaveLength(0);
  });

  it("when the email cannot be sent, says so and keeps no link", async () => {
    await person();
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: false, error: "422 invalid from" });
    expect(await requestPasswordReset("asha@edapt.in", "1.2.3.4", NOW)).toEqual({ sent: false, reason: "email_failed" });
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("fetch failed"));
    expect(await requestPasswordReset("asha@edapt.in", "1.2.3.4", NOW)).toEqual({ sent: false, reason: "email_failed" });
    expect(await db.select().from(passwordResets)).toHaveLength(0);
  });

  it("limits links per person and requests per address in an hour", async () => {
    await person();
    for (let i = 0; i < RESET_LIMITS.perUser; i++) expect((await requestPasswordReset("asha@edapt.in", "1.2.3.4", NOW)).sent).toBe(true);
    expect(await requestPasswordReset("asha@edapt.in", "5.6.7.8", NOW)).toMatchObject({ sent: false, reason: "rate_limited" });
    // an hour later it works again
    expect((await requestPasswordReset("asha@edapt.in", "1.2.3.4", new Date(NOW.getTime() + 61 * MIN))).sent).toBe(true);

    for (let i = 0; i < RESET_LIMITS.perIp; i++) await person(`p${i}@edapt.in`);
    const later = new Date(NOW.getTime() + 3 * 60 * MIN);
    for (let i = 0; i < RESET_LIMITS.perIp; i++) await requestPasswordReset(`p${i}@edapt.in`, "9.9.9.9", later);
    expect(await requestPasswordReset("asha@edapt.in", "9.9.9.9", later)).toMatchObject({ sent: false, reason: "rate_limited" });
  });

  it("a newer password (admin reset or own change) voids open links; old rows are pruned", async () => {
    const admin = await makeUser({ role: "admin" });
    const u = await person();
    await requestPasswordReset("asha@edapt.in", "1.2.3.4", NOW);
    const first = lastToken();
    await resetUserPassword(u.id, admin);
    expect(await checkResetToken(first, NOW)).toEqual({ ok: false, reason: "used" });

    await requestPasswordReset("asha@edapt.in", "1.2.3.4", NOW);
    const second = lastToken();
    await db.update(users).set({ passwordHash: await hashPassword("old-password-1") }).where(eq(users.id, u.id));
    await changeOwnPassword(u.id, { current: "old-password-1", next: "my own new password", confirm: "my own new password" }, null);
    expect(await checkResetToken(second, NOW)).toEqual({ ok: false, reason: "used" });

    expect(await prunePasswordResets(new Date(NOW.getTime() + 2 * 86400_000))).toEqual({ deleted: 2 });
  });
});
