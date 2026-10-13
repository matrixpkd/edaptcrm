import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, sessions, users } from "@/db/schema";
import { AccountError, changeOwnPassword, describeUserAgent, listOwnSessions, setOwnTimezone, signOutOtherSessions } from "@/lib/auth/account";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { makeUser, resetDb } from "../support/db";

const DAY = 24 * 3600 * 1000;

async function withPassword(password: string) {
  const u = await makeUser({ role: "sales" });
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, u.id));
  return u;
}

async function addSession(userId: string, id: string, ua: string | null = null, expiresInDays = 30) {
  await db.insert(sessions).values({ id, userId, userAgent: ua, expiresAt: new Date(Date.now() + expiresInDays * DAY) });
}

async function hashOf(userId: string) {
  return (await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, userId)))[0].h;
}

describe("own account", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("changes the password with the current one, and signs out every other session", async () => {
    const u = await withPassword("old-password-1");
    const other = await makeUser({ role: "sales" });
    await addSession(u.id, "this-browser");
    await addSession(u.id, "phone");
    await addSession(other.id, "someone-else");

    const r = await changeOwnPassword(u.id, { current: "old-password-1", next: "a much longer one", confirm: "a much longer one" }, "this-browser");
    expect(r.sessionsEnded).toBe(1);
    expect(await verifyPassword("a much longer one", await hashOf(u.id))).toBe(true);
    const left = (await db.select({ id: sessions.id }).from(sessions)).map((s) => s.id).sort();
    expect(left).toEqual(["someone-else", "this-browser"]);
    const [log] = await db.select().from(auditLog).where(and(eq(auditLog.rowId, u.id), eq(auditLog.field, "password")));
    expect(log).toMatchObject({ userId: u.id, newValue: "changed by the user" });
    expect(JSON.stringify(log)).not.toContain("a much longer one");
  });

  it("refuses a wrong current password, a short or mismatched new one, and reuse", async () => {
    const u = await withPassword("old-password-1");
    const attempt = (current: string | null, next: string, confirm = next) => changeOwnPassword(u.id, { current, next, confirm }, null);
    await expect(attempt(null, "long enough pw")).rejects.toMatchObject({ field: "current" });
    await expect(attempt("wrong-password", "long enough pw")).rejects.toMatchObject({ field: "current", message: "Your current password is not right" });
    await expect(attempt("old-password-1", "short9char")).resolves.toBeTruthy();
    // 9 characters is too short
    await expect(changeOwnPassword(u.id, { current: "short9char", next: "123456789", confirm: "123456789" }, null)).rejects.toMatchObject({ field: "next" });
    await expect(changeOwnPassword(u.id, { current: "short9char", next: "long enough pw", confirm: "long enough pX" }, null)).rejects.toMatchObject({ field: "confirm" });
    await expect(changeOwnPassword(u.id, { current: "short9char", next: "short9char", confirm: "short9char" }, null)).rejects.toBeInstanceOf(AccountError);
    expect(await verifyPassword("short9char", await hashOf(u.id))).toBe(true);
  });

  it("sets the own time zone (audited), refusing unknown zones", async () => {
    const u = await makeUser({ role: "support", timezone: "Asia/Kolkata" });
    expect(await setOwnTimezone(u.id, "Asia/Dubai")).toBe(true);
    expect(await setOwnTimezone(u.id, "Asia/Dubai")).toBe(false);
    await expect(setOwnTimezone(u.id, "Mars/Olympus")).rejects.toMatchObject({ field: "timezone" });
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0].timezone).toBe("Asia/Dubai");
    const [log] = await db.select().from(auditLog).where(and(eq(auditLog.rowId, u.id), eq(auditLog.field, "timezone")));
    expect(log).toMatchObject({ oldValue: "Asia/Kolkata", newValue: "Asia/Dubai", userId: u.id });
  });

  it("lists live sessions without their ids and signs out the others", async () => {
    const u = await makeUser({ role: "manager" });
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    await addSession(u.id, "laptop", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
    await addSession(u.id, "phone", iphone);
    await addSession(u.id, "expired", null, -1);
    const list = await listOwnSessions(u.id, "laptop");
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("laptop");
    expect(describeUserAgent(iphone)).toBe("Safari on iPhone");
    expect(describeUserAgent(null)).toBe("Unknown browser");

    expect(await signOutOtherSessions(u.id, "laptop")).toBe(2);
    expect((await db.select({ id: sessions.id }).from(sessions)).map((s) => s.id)).toEqual(["laptop"]);
  });
});
