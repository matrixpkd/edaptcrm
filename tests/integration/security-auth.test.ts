/**
 * Security rules outside the per-action authorization checks (those are in security-authz.test.ts): sign-in
 * lockout, timing and rehash, race-safe first-run setup, same-site redirects, shared secrets that fail closed in
 * production, capped webhook bodies, CSV formula injection, stored-file keys, sniffing and response headers, and
 * the app-wide security headers.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, loginAttempts, payments, purchases, sessions, users } from "@/db/schema";
import { csvCell, neutraliseFormula } from "@/lib/admin/csv";
import { csvCell as importCsvCell } from "@/lib/import/csv";
import { authenticate, BAD_CREDENTIALS, createFirstAdmin } from "@/lib/auth/login";
import { checkLoginAllowed, clientIp, LOGIN_LIMITS, pruneExpiredSessions, pruneLoginAttempts, recordLoginAttempt } from "@/lib/auth/login-limit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { safeNextPath } from "@/lib/auth/redirect";
import { sniffFileType } from "@/lib/file-types";
import { isAuthorizedCron, isAuthorizedWebhook } from "@/lib/secrets";
import { contentSecurityPolicy, securityHeaders } from "@/lib/security-headers";
import { cleanStoredKey, storedFileHeaders } from "@/lib/storage";
import { readWebhookBody } from "@/lib/webhooks/body";
import { safeReturnPath } from "@/lib/today/rules";
import { storeProof } from "@/app/(app)/payments/_lib/forms";
import { makeUser, resetDb } from "../support/db";

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: "admin" | "manager" | "sales" | "support" } }));
vi.mock("@/lib/auth/session", () => ({ getApiUser: vi.fn(async () => session.user) }));
const files = await import("@/app/api/files/[...key]/route");
const cronNightly = await import("@/app/api/cron/nightly/route");
const tagmango = await import("@/app/api/webhooks/tagmango/route");

const PASSWORD = "correct horse battery";

async function userWithPassword(over: { active?: boolean; email?: string } = {}) {
  const u = await makeUser({ role: "sales", active: over.active ?? true, email: over.email });
  await db.update(users).set({ passwordHash: await hashPassword(PASSWORD) }).where(eq(users.id, u.id));
  return u;
}

describe("sign-in", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("the same answer for an unknown email and a wrong password, and both cost a bcrypt comparison", async () => {
    const u = await userWithPassword();
    expect(await authenticate("nobody@test.local", PASSWORD, "1.1.1.1")).toEqual({ ok: false, error: BAD_CREDENTIALS });
    expect(await authenticate(u.email, "wrong password", "1.1.1.1")).toEqual({ ok: false, error: BAD_CREDENTIALS });
    expect(await authenticate(u.email.toUpperCase(), PASSWORD, "1.1.1.1")).toEqual({ ok: true, userId: u.id });

    const t0 = performance.now();
    expect(await verifyPassword("anything", null)).toBe(false);
    const missing = performance.now() - t0;
    const t1 = performance.now();
    await verifyPassword("anything", await hashPassword("x"));
    const real = performance.now() - t1;
    // no early return for a missing user: within the same order of magnitude as a real check
    expect(missing).toBeGreaterThan(real / 5);
  });

  it("a password is checked as typed (spaces kept), and older trimmed passwords still work", async () => {
    const u = await makeUser({ role: "sales" });
    await db.update(users).set({ passwordHash: await hashPassword("  spaced out pass  ") }).where(eq(users.id, u.id));
    expect((await authenticate(u.email, "  spaced out pass  ", "1.1.1.1")).ok).toBe(true);
    expect((await authenticate(u.email, "spaced out pass", "1.1.1.1")).ok).toBe(false);
    await db.update(users).set({ passwordHash: await hashPassword("trimmed at setup") }).where(eq(users.id, u.id));
    expect((await authenticate(u.email, " trimmed at setup ", "1.1.1.1")).ok).toBe(true);
  });

  it("a deactivated account only says so after the right password", async () => {
    const u = await userWithPassword({ active: false });
    expect(await authenticate(u.email, "wrong password", "1.1.1.1")).toEqual({ ok: false, error: BAD_CREDENTIALS });
    expect(await authenticate(u.email, PASSWORD, "1.1.1.1")).toMatchObject({ ok: false, error: expect.stringMatching(/deactivated/) });
  });

  it("locks an email + IP after 5 failures, even for the right password; other IPs and a success are unaffected", async () => {
    const u = await userWithPassword();
    for (let i = 0; i < LOGIN_LIMITS.PER_EMAIL_IP; i++) {
      expect(await authenticate(u.email, `guess ${i}`, "6.6.6.6")).toEqual({ ok: false, error: BAD_CREDENTIALS });
    }
    const locked = await authenticate(u.email, PASSWORD, "6.6.6.6");
    expect(locked).toMatchObject({ ok: false, error: expect.stringMatching(/Too many sign-in attempts\. Try again in 15 minutes/) });
    // the refused attempt never reached the password check, so it was not recorded
    expect(await db.select().from(loginAttempts)).toHaveLength(LOGIN_LIMITS.PER_EMAIL_IP);
    // the real person on another network still gets in, and their success clears their own failures only
    expect(await authenticate(u.email, PASSWORD, "10.0.0.1")).toEqual({ ok: true, userId: u.id });
    expect((await authenticate(u.email, PASSWORD, "6.6.6.6")).ok).toBe(false);
    // the lock lifts after the window
    const later = new Date(Date.now() + (LOGIN_LIMITS.WINDOW_MINUTES + 1) * 60_000);
    expect(await checkLoginAllowed(u.email, "6.6.6.6", later)).toEqual({ allowed: true });
  });

  it("a success clears the failures of that email + IP", async () => {
    const u = await userWithPassword();
    for (let i = 0; i < LOGIN_LIMITS.PER_EMAIL_IP - 1; i++) await authenticate(u.email, "nope", "2.2.2.2");
    expect((await authenticate(u.email, PASSWORD, "2.2.2.2")).ok).toBe(true);
    for (let i = 0; i < LOGIN_LIMITS.PER_EMAIL_IP - 1; i++) await authenticate(u.email, "nope", "2.2.2.2");
    expect((await authenticate(u.email, PASSWORD, "2.2.2.2")).ok).toBe(true);
  });

  it("locks an email guessed from many IPs, and an IP spraying many emails", async () => {
    const now = new Date();
    for (let i = 0; i < LOGIN_LIMITS.PER_EMAIL; i++) await recordLoginAttempt("target@test.local", `9.9.9.${i}`, false, now);
    expect((await checkLoginAllowed("target@test.local", "8.8.8.8", now)).allowed).toBe(false);
    for (let i = 0; i < LOGIN_LIMITS.PER_IP; i++) await recordLoginAttempt(`victim${i}@test.local`, "7.7.7.7", false, now);
    expect((await checkLoginAllowed("someone-new@test.local", "7.7.7.7", now)).allowed).toBe(false);
    expect((await checkLoginAllowed("someone-new@test.local", "7.7.7.8", now)).allowed).toBe(true);
  });

  it("upgrades a weaker hash at the next sign-in, and prunes old attempts and expired sessions", async () => {
    const u = await makeUser({ role: "sales" });
    await db.update(users).set({ passwordHash: await bcrypt.hash(PASSWORD, 4) }).where(eq(users.id, u.id));
    expect((await authenticate(u.email, PASSWORD, "1.1.1.1")).ok).toBe(true);
    const [after] = await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, u.id));
    expect(bcrypt.getRounds(after.h!)).toBe(11);
    expect(await bcrypt.compare(PASSWORD, after.h!)).toBe(true);

    const old = new Date(Date.now() - 2 * 24 * 3600_000);
    await recordLoginAttempt("x@test.local", "1.2.3.4", false, old);
    await db.insert(sessions).values([
      { id: "expired", userId: u.id, expiresAt: old },
      { id: "live", userId: u.id, expiresAt: new Date(Date.now() + 3600_000) },
    ]);
    expect((await pruneLoginAttempts(new Date())).deleted).toBe(1);
    expect((await pruneExpiredSessions(new Date())).deleted).toBe(1);
    expect((await db.select().from(sessions)).map((s) => s.id)).toEqual(["live"]);
  });

  it("reads the client IP the platform reports", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(clientIp(h({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }))).toBe("1.2.3.4");
    expect(clientIp(h({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" }))).toBe("5.6.7.8");
    expect(clientIp(h({}))).toBe("unknown");
  });
});

describe("first-run setup", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("makes exactly one admin when several people submit at once, then closes", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => createFirstAdmin({ name: `Admin ${i}`, email: `admin${i}@test.local`, password: "long enough password" })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && /already complete/.test(r.error))).toBe(true);
    expect(await db.select().from(users)).toHaveLength(1);
    expect((await createFirstAdmin({ name: "Late", email: "late@test.local", password: "long enough password" })).ok).toBe(false);
  });

  it("asks for a real email and a password of at least 10 characters", async () => {
    expect(await createFirstAdmin({ name: "A", email: "not-an-email", password: "long enough password" })).toMatchObject({ ok: false });
    expect(await createFirstAdmin({ name: "A", email: "a@test.local", password: "short" })).toMatchObject({ ok: false });
    expect(await db.select().from(users)).toHaveLength(0);
  });
});

describe("same-site redirects (?next=, ?return=)", () => {
  it("keeps paths on this site and refuses everything else", () => {
    for (const ok of ["/today", "/contacts/abc?tab=details", "/contacts?q=john doe", "/payments#x"]) expect(safeNextPath(ok, "/today")).toBe(ok);
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\\/evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "javascript:alert(1)",
      " //evil.example",
      "",
      null,
      undefined,
      `/${"a".repeat(600)}`,
    ]) {
      expect(safeNextPath(bad, "/today")).toBe("/today");
    }
    expect(safeReturnPath("/\t/evil.example", "/contacts/x")).toBe("/contacts/x");
    expect(safeReturnPath("/today", "/contacts/x")).toBe("/today");
  });
});

describe("shared secrets fail closed in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const cronReq = (auth?: string) => new Request("http://localhost/api/cron/nightly", { headers: auth ? { authorization: auth } : {} });

  it("cron: no secret configured in production refuses everyone; a configured secret needs the exact bearer", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorizedCron(cronReq("Bearer "))).toBe(false);
    expect(isAuthorizedCron(cronReq())).toBe(false);
    expect((await cronNightly.GET(cronReq("Bearer anything"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "   ");
    expect(isAuthorizedCron(cronReq("Bearer    "))).toBe(false);
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    expect(isAuthorizedCron(cronReq("Bearer s3cret-value"))).toBe(true);
    expect(isAuthorizedCron(cronReq("Bearer s3cret-valu"))).toBe(false);
    expect(isAuthorizedCron(cronReq("s3cret-value"))).toBe(false);
    // development without a secret stays convenient
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorizedCron(cronReq())).toBe(true);
  });

  it("webhooks: no secret in production is a 401 before the body is read", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TAGMANGO_WEBHOOK_SECRET", "");
    const req = new Request("http://localhost/api/webhooks/tagmango?token=", { method: "POST", body: "{}" });
    expect(isAuthorizedWebhook(req, "TAGMANGO_WEBHOOK_SECRET")).toBe(false);
    expect((await tagmango.POST(req)).status).toBe(401);
    vi.stubEnv("TAGMANGO_WEBHOOK_SECRET", "tm-secret");
    expect(isAuthorizedWebhook(new Request("http://localhost/x?token=tm-secret"), "TAGMANGO_WEBHOOK_SECRET")).toBe(true);
    expect(isAuthorizedWebhook(new Request("http://localhost/x", { headers: { "x-webhook-secret": "tm-secret" } }), "TAGMANGO_WEBHOOK_SECRET")).toBe(true);
    expect(isAuthorizedWebhook(new Request("http://localhost/x", { headers: { authorization: "Bearer tm-secret" } }), "TAGMANGO_WEBHOOK_SECRET")).toBe(true);
    expect(isAuthorizedWebhook(new Request("http://localhost/x?token=tm-secre"), "TAGMANGO_WEBHOOK_SECRET")).toBe(false);
  });
});

describe("webhook bodies are capped while streaming", () => {
  function streamOf(chunks: number, size: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= chunks) return controller.close();
        sent += 1;
        controller.enqueue(new TextEncoder().encode("a".repeat(size)));
      },
    });
  }

  it("refuses a chunked body (no content-length) as soon as it passes the cap", async () => {
    const req = new Request("http://localhost/x", { method: "POST", body: streamOf(100, 1000), duplex: "half" } as RequestInit);
    expect(await readWebhookBody(req, 5000)).toMatchObject({ ok: false, status: 413 });
  });

  it("refuses a declared length over the cap, and a multipart form over the cap", async () => {
    const big = new Request("http://localhost/x", { method: "POST", headers: { "content-length": "999999999" }, body: "{}" });
    expect(await readWebhookBody(big, 5000)).toMatchObject({ ok: false, status: 413 });
    const fd = new FormData();
    fd.append("payload", "x".repeat(6000));
    expect(await readWebhookBody(new Request("http://localhost/x", { method: "POST", body: fd }), 5000)).toMatchObject({ ok: false, status: 413 });
    const small = new FormData();
    small.append("phone", "9847012345");
    expect(await readWebhookBody(new Request("http://localhost/x", { method: "POST", body: small }), 5000)).toEqual({ ok: true, payload: { phone: "9847012345" } });
  });
});

describe("CSV formula injection", () => {
  it("every CSV we write neutralises formulas but keeps phone numbers and amounts", () => {
    for (const cell of [csvCell, importCsvCell]) {
      expect(cell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
      expect(cell("@SUM(A1)")).toBe("'@SUM(A1)");
      expect(cell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
      expect(cell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
      expect(cell("  =1+1")).toBe("'  =1+1");
      expect(cell("\t=1")).toBe("'\t=1");
      expect(cell("＝1+1")).toBe("'＝1+1");
      expect(cell("+919876543210")).toBe("+919876543210");
      expect(cell("+91 98765 43210")).toBe("+91 98765 43210");
      expect(cell("-1250.50")).toBe("-1250.50");
      expect(cell("Kochi")).toBe("Kochi");
    }
    expect(neutraliseFormula("a=b")).toBe("a=b");
  });
});

describe("stored files", () => {
  const PDF_KEY = "proofs/2026-10/2b1e2c1a-6f4e-4d3a-9c55-1d2e3f4a5b6c-statement.pdf";
  const PNG_KEY = "proofs/2026-10/3c1e2c1a-6f4e-4d3a-9c55-1d2e3f4a5b6c-shot.png";
  const local = (k: string) => path.join(process.cwd(), "uploads", k);
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

  beforeEach(async () => {
    await resetDb();
    session.user = null;
  });
  afterAll(async () => {
    await rm(local(PDF_KEY), { force: true });
    await rm(local(PNG_KEY), { force: true });
  });

  it("refuses keys that climb out of the store, including encoded slashes inside one segment", () => {
    expect(cleanStoredKey(["proofs", "..%2F..%2Fetc"])).toBe("proofs/..%2F..%2Fetc");
    expect(cleanStoredKey(["proofs", "../../etc/passwd"])).toBeNull();
    expect(cleanStoredKey(["proofs", "..", "x"])).toBeNull();
    expect(cleanStoredKey(["proofs", "a\\..\\b"])).toBeNull();
    expect(cleanStoredKey(["proofs", "a\0b"])).toBeNull();
    expect(cleanStoredKey("proofs/2026-10/x.png")).toBe("proofs/2026-10/x.png");
  });

  it("knows a file by its bytes, not its name", () => {
    expect(sniffFileType(new Uint8Array(PNG))).toEqual({ ext: "png", mime: "image/png" });
    expect(sniffFileType(new TextEncoder().encode("%PDF-1.7\n..."))).toEqual({ ext: "pdf", mime: "application/pdf" });
    expect(sniffFileType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toMatchObject({ ext: "jpg" });
    expect(sniffFileType(new TextEncoder().encode("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(sniffFileType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
  });

  it("a proof that only claims to be a picture is refused; a real one is stored under its real type", async () => {
    const fake = new File(["<html><script>alert(document.cookie)</script></html>"], "receipt.png", { type: "image/png" });
    await expect(storeProof(fake)).rejects.toMatchObject({ field: "proof" });
    const jpegNamedPng = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])], "shot.png", { type: "image/png" });
    const url = await storeProof(jpegNamedPng);
    expect(url).toMatch(/^\/api\/files\/proofs\/\d{4}-\d{2}\/[0-9a-f-]{36}-shot\.jpg$/);
    await rm(local(url.replace("/api/files/", "")), { force: true });
  });

  it("serves pictures inline and everything else as a sandboxed download", async () => {
    const owner = await makeUser({ role: "sales" });
    const [c] = await db.insert(contacts).values({ phoneE164: "+919847055501", name: "Proof owner", firstDoor: "other", ownerId: owner.id }).returning();
    for (const [key, bytes] of [
      [PDF_KEY, Buffer.from("%PDF-1.4\n%%EOF")],
      [PNG_KEY, PNG],
    ] as const) {
      await mkdir(path.dirname(local(key)), { recursive: true });
      await writeFile(local(key), bytes);
      const [p] = await db
        .insert(purchases)
        .values({ contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, amountInr: 999, mode: "bank_transfer" })
        .returning();
      await db.insert(payments).values({ purchaseId: p.id, contactId: c.id, amount: 999, amountInr: 999, status: "unverified", proofUrl: `/api/files/${key}` });
    }
    session.user = owner;
    const get = (key: string) => files.GET(new Request(`http://localhost/api/files/${key}`), { params: Promise.resolve({ key: key.split("/") }) });

    const pdf = await get(PDF_KEY);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="statement.pdf"');
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pdf.headers.get("content-security-policy")).toMatch(/sandbox/);

    const png = await get(PNG_KEY);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("content-disposition")).toBe("inline");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");

    expect(storedFileHeaders("imports/2026-10/x.html", "application/octet-stream")["Content-Disposition"]).toMatch(/^attachment/);
    expect(storedFileHeaders("proofs/2026-10/x.png", "application/octet-stream")["Content-Disposition"]).toMatch(/^attachment/);
  });
});

describe("app-wide security headers", () => {
  it("production: CSP without eval, frames refused, HSTS; Supabase allowed for images and uploads", () => {
    const h = Object.fromEntries(securityHeaders({ production: true, supabaseUrl: "https://abc.supabase.co/" }).map((x) => [x.key, x.value]));
    expect(h["Content-Security-Policy"]).toMatch(/frame-ancestors 'none'/);
    expect(h["Content-Security-Policy"]).toMatch(/object-src 'none'/);
    expect(h["Content-Security-Policy"]).toMatch(/img-src 'self' data: blob: https:\/\/abc\.supabase\.co;/);
    expect(h["Content-Security-Policy"]).toMatch(/connect-src 'self' https:\/\/abc\.supabase\.co;/);
    expect(h["Content-Security-Policy"]).not.toMatch(/unsafe-eval/);
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toMatch(/camera=\(\)/);
  });

  it("development: no HSTS, eval and websockets allowed for React Refresh", () => {
    const h = Object.fromEntries(securityHeaders({ production: false }).map((x) => [x.key, x.value]));
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(contentSecurityPolicy({ production: false })).toMatch(/'unsafe-eval'/);
    expect(contentSecurityPolicy({ production: false })).toMatch(/ws:/);
  });
});
