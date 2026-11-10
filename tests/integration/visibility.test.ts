/**
 * What a salesperson can learn about contacts outside their scope (their own plus the unassigned pool), called the
 * way the browser (or an attacker) would: the Quick Add duplicate check route and save action (the name and owner
 * the spec asks for, nothing more, rate limited per user) and the pipeline board's move action (a hidden contact
 * answers like one that does not exist). Organisations are covered with their read models in
 * contacts-queries.test.ts. The session is mocked; routes, actions, services and the database are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, rateLimitHits, tasks, type Role } from "@/db/schema";
import {
  QUICK_ADD_LOOKUP_LIMIT,
  RATE_LIMIT_RETENTION_HOURS,
  RateLimitedError,
  pruneRateLimitHits,
  takeRateLimit,
} from "@/lib/auth/rate-limit";
import { checkQuickAddDuplicate } from "@/lib/contacts/identity";
import { makeUser, resetDb } from "../support/db";

type U = { id: string; name: string; email: string; role: Role; team: string | null; timezone: string; active: boolean };
const session = vi.hoisted(() => ({ user: null as null | U }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth/session", () => ({
  SESSION_COOKIE: "edapt_session",
  getCurrentUser: vi.fn(async () => session.user),
  getApiUser: vi.fn(async (roles?: Role[]) => (session.user && (!roles || roles.includes(session.user.role)) ? session.user : null)),
  requireUser: vi.fn(async (roles?: Role[]) => {
    if (!session.user) throw new Error("NEXT_REDIRECT:/login");
    if (roles && !roles.includes(session.user.role)) throw new Error("NEXT_REDIRECT:/today?denied=1");
    return session.user;
  }),
  currentSessionId: vi.fn(async () => null),
  createSession: vi.fn(),
  destroySession: vi.fn(),
  destroyUserSessions: vi.fn(),
}));

const checkRoute = await import("@/app/(app)/contacts/new/check/route");
const { quickAddAction } = await import("@/app/(app)/contacts/new/actions");
const { requestTransferAction } = await import("@/app/(app)/contacts/[id]/actions");
const { moveCardAction } = await import("@/app/(app)/pipeline/actions");

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

let seq = 0;
async function contact(ownerId: string | null, over: Partial<typeof contacts.$inferInsert> = {}) {
  seq += 1;
  const [c] = await db
    .insert(contacts)
    .values({
      phoneE164: `+9198472${String(10000 + seq).padStart(5, "0")}`,
      name: `Person ${seq}`,
      firstDoor: "youtube",
      ownerId,
      stage: "contacted",
      grade: "B",
      ...over,
    })
    .returning();
  return c;
}

async function check(as: U, phone: string) {
  session.user = as;
  const res = await checkRoute.GET(new NextRequest(`http://localhost/contacts/new/check?phone=${encodeURIComponent(phone)}`));
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/** `n` counted Quick Add lookups for a user, `minutesAgo` old. */
async function prefill(userId: string, n: number, minutesAgo = 1) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await db.insert(rateLimitHits).values(Array.from({ length: n }, () => ({ bucket: QUICK_ADD_LOOKUP_LIMIT.bucket, subject: userId, createdAt: at })));
}

let admin: U, manager: U, s1: U, s2: U, support: U;

beforeEach(async () => {
  await resetDb();
  admin = (await makeUser({ role: "admin", name: "Umer" })) as U;
  manager = (await makeUser({ role: "manager", name: "Meera" })) as U;
  s1 = (await makeUser({ role: "sales", name: "Asha" })) as U;
  s2 = (await makeUser({ role: "sales", name: "Biju" })) as U;
  support = (await makeUser({ role: "support", team: null, name: "Sana" })) as U;
  session.user = s1;
});

describe("Quick Add duplicate check", () => {
  it("a colleague's contact gives its name and owner only; whoever may open it gets the stage and grade too", async () => {
    const theirs = await contact(s2.id, { name: "Gopika Nair", stage: "qualified", grade: "A" });

    const forColleague = await check(s1, theirs.phoneE164);
    expect(forColleague.status).toBe(200);
    expect(forColleague.headers.get("cache-control")).toBe("no-store");
    expect(forColleague.body.existing).toEqual({ visible: false, id: theirs.id, name: "Gopika Nair", ownerName: "Biju", ownerIsMe: false });
    expect(JSON.stringify(forColleague.body)).not.toMatch(/qualified|"grade"|"stage"/);

    expect((await check(s2, theirs.phoneE164)).body.existing).toEqual({
      visible: true,
      id: theirs.id,
      name: "Gopika Nair",
      ownerName: "Biju",
      ownerIsMe: true,
      stage: "qualified",
      grade: "A",
    });
    for (const viewer of [manager, admin, support]) {
      expect((await check(viewer, theirs.phoneE164)).body.existing).toEqual({
        visible: true,
        id: theirs.id,
        name: "Gopika Nair",
        ownerName: "Biju",
        ownerIsMe: false,
        stage: "qualified",
        grade: "A",
      });
    }

    // the pool is every salesperson's: the full card
    const pool = await contact(null, { name: "Pool Person", stage: "new", grade: "C" });
    expect((await check(s1, pool.phoneE164)).body.existing).toMatchObject({ visible: true, id: pool.id, stage: "new", grade: "C", ownerName: null });
  });

  it("the id it gives for a colleague's contact only serves a transfer request, which re-checks the rights", async () => {
    const theirs = await contact(s2.id, { name: "Hamdan" });
    const id = (await check(s1, theirs.phoneE164)).body.existing.id as string;
    expect(id).toBe(theirs.id);

    session.user = s1;
    expect(await requestTransferAction(null, form({ contactId: id, reason: "They called me directly" }))).toMatchObject({ ok: true });
    const asked = await db.select().from(tasks).where(and(eq(tasks.contactId, theirs.id), eq(tasks.type, "transfer_request")));
    expect(asked.map((t) => t.userId)).toEqual([manager.id]);
    // a stage change with the same id is still refused, and nothing about the record changed hands
    expect(await moveCardAction(null, form({ contactId: id, to: "qualified" }))).toEqual({ ok: false, error: "That contact no longer exists" });
    const [after] = await db.select().from(contacts).where(eq(contacts.id, theirs.id));
    expect(after).toMatchObject({ ownerId: s2.id, stage: "contacted" });

    // support may open every contact, so never needs (or may make) a transfer request
    session.user = support;
    expect(await requestTransferAction(null, form({ contactId: id, reason: "x" }))).toMatchObject({ ok: false });
  });

  it("over the per-user limit the check answers 429 with a message for Quick Add; other people and invalid numbers are not held up", async () => {
    const theirs = await contact(s2.id, { name: "Rahul" });
    await prefill(s1.id, QUICK_ADD_LOOKUP_LIMIT.max - 1);

    // the last lookup in the window still answers
    expect((await check(s1, theirs.phoneE164)).status).toBe(200);
    const refused = await check(s1, theirs.phoneE164);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: "Too many number checks in a short time. Try again in 9 minutes." });
    expect(refused.headers.get("retry-after")).toBe(String(9 * 60));
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(refused.body)).not.toContain("Rahul");
    // refused lookups are not counted, so the limit lifts as the old ones age out
    const counted = await db.select({ n: sql<number>`count(*)::int` }).from(rateLimitHits).where(eq(rateLimitHits.subject, s1.id));
    expect(counted[0].n).toBe(QUICK_ADD_LOOKUP_LIMIT.max);

    // nothing to look up: not counted, not refused
    expect(await check(s1, "12345")).toMatchObject({ status: 200, body: { valid: false, existing: null } });
    // the limit is per person
    expect((await check(s2, theirs.phoneE164)).status).toBe(200);

    // saving runs the same lookup, so it cannot be used to get round the limit
    session.user = s1;
    const saved = await quickAddAction(
      null,
      form({ phone: theirs.phoneE164, name: "Someone", channel: "phone_call", firstDoor: "youtube", attachTo: theirs.id }),
    );
    expect(saved).toEqual({
      ok: false,
      error: "Too many number checks in a short time. Try again in 9 minutes.",
      fieldErrors: { phone: "Too many number checks in a short time. Try again in 9 minutes." },
    });

    // once the window has passed, the check answers again
    await db.update(rateLimitHits).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(rateLimitHits.subject, s1.id));
    expect((await check(s1, theirs.phoneE164)).status).toBe(200);
  });

  it("an attached save to a colleague's number says only who has it, and counts as a lookup", async () => {
    const theirs = await contact(s2.id, { name: "Fathima" });
    session.user = s1;
    const r = await quickAddAction(
      null,
      form({ phone: theirs.phoneE164, name: "Someone", channel: "phone_call", firstDoor: "youtube", attachTo: theirs.id }),
    );
    expect(r).toMatchObject({ ok: false, error: "Fathima already has this number" });
    const counted = await db.select({ n: sql<number>`count(*)::int` }).from(rateLimitHits).where(eq(rateLimitHits.subject, s1.id));
    expect(counted[0].n).toBe(1);
  });

  it("the service throws RateLimitedError over the limit, before looking anything up", async () => {
    const theirs = await contact(s2.id);
    await prefill(s1.id, QUICK_ADD_LOOKUP_LIMIT.max);
    await expect(checkQuickAddDuplicate(theirs.phoneE164, s1)).rejects.toBeInstanceOf(RateLimitedError);
    await expect(checkQuickAddDuplicate(theirs.phoneE164, manager)).resolves.toMatchObject({ existing: { visible: true } });
  });
});

describe("rate limit store", () => {
  const LIMIT = { bucket: "test_bucket", max: 3, windowMinutes: 10 };

  it("counts in a sliding window, does not record refusals, and says when a slot frees up", async () => {
    const t0 = new Date("2026-11-10T10:00:00Z");
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(await takeRateLimit(LIMIT, "u1", at(0))).toEqual({ allowed: true });
    expect(await takeRateLimit(LIMIT, "u1", at(1))).toEqual({ allowed: true });
    expect(await takeRateLimit(LIMIT, "u1", at(2))).toEqual({ allowed: true });
    // the oldest leaves the window at 10:10, so 7 minutes from 10:03
    expect(await takeRateLimit(LIMIT, "u1", at(3))).toEqual({ allowed: false, retryAfterMinutes: 7 });
    expect(await takeRateLimit(LIMIT, "u1", at(9.5))).toEqual({ allowed: false, retryAfterMinutes: 1 });
    // another subject and another bucket are separate
    expect(await takeRateLimit(LIMIT, "u2", at(3))).toEqual({ allowed: true });
    expect(await takeRateLimit({ ...LIMIT, bucket: "other" }, "u1", at(3))).toEqual({ allowed: true });
    // past 10:10 the first lookup has aged out
    expect(await takeRateLimit(LIMIT, "u1", at(10.5))).toEqual({ allowed: true });
    const rows = await db.select().from(rateLimitHits).where(and(eq(rateLimitHits.bucket, LIMIT.bucket), eq(rateLimitHits.subject, "u1")));
    expect(rows).toHaveLength(4);
  });

  it("the nightly prune deletes lookups older than the retention window", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (RATE_LIMIT_RETENTION_HOURS + 1) * 3_600_000);
    const recent = new Date(now.getTime() - 60_000);
    await db.insert(rateLimitHits).values([
      { bucket: "b", subject: "u", createdAt: old },
      { bucket: "b", subject: "u", createdAt: recent },
    ]);
    expect(await pruneRateLimitHits(now)).toEqual({ deleted: 1 });
    expect(await db.select().from(rateLimitHits)).toHaveLength(1);
  });
});

describe("pipeline board moves", () => {
  const GONE = { ok: false, error: "That contact no longer exists" };

  it("a colleague's contact gets the same reply as one that does not exist, whatever its stage or the column", async () => {
    const theirs = await contact(s2.id, { stage: "contacted" });
    const customer = await contact(s2.id, { stage: "first_purchase", purchaseCount: 1 });
    const lost = await contact(s2.id, { stage: "lost", lostReason: "price" });
    const missing = "00000000-0000-4000-8000-000000000000";
    session.user = s1;

    for (const id of [theirs.id, customer.id, lost.id, missing]) {
      for (const to of ["new", "contacted", "qualified", "first_purchase", "lost"]) {
        const r = await moveCardAction(null, form({ contactId: id, to, lostReason: "price" }));
        expect(r, `${id} -> ${to}`).toEqual(GONE);
      }
    }
    expect(await moveCardAction(null, form({ contactId: "not-an-id", to: "qualified" }))).toEqual(GONE);

    const after = await db.select({ id: contacts.id, stage: contacts.stage }).from(contacts);
    expect(Object.fromEntries(after.map((c) => [c.id, c.stage]))).toEqual({
      [theirs.id]: "contacted",
      [customer.id]: "first_purchase",
      [lost.id]: "lost",
    });
  });

  it("own and pool contacts keep their replies and moves; managers and admins move anyone's; support cannot move", async () => {
    const mine = await contact(s1.id, { stage: "contacted" });
    const pool = await contact(null, { stage: "new" });
    const theirs = await contact(s2.id, { stage: "contacted" });
    const theirsLost = await contact(s2.id, { stage: "lost", lostReason: "price" });

    session.user = s1;
    expect(await moveCardAction(null, form({ contactId: mine.id, to: "contacted" }))).toEqual({ ok: false, error: "It is already there" });
    expect(await moveCardAction(null, form({ contactId: mine.id, to: "first_purchase" }))).toEqual({
      ok: false,
      error: "First purchase is set by the system, not by hand",
    });
    expect(await moveCardAction(null, form({ contactId: mine.id, to: "qualified" }))).toMatchObject({ ok: true, data: { stage: "qualified" } });
    expect(await moveCardAction(null, form({ contactId: pool.id, to: "lost", lostReason: "price" }))).toMatchObject({
      ok: true,
      data: { stage: "lost" },
    });

    session.user = manager;
    expect(await moveCardAction(null, form({ contactId: theirs.id, to: "qualified" }))).toMatchObject({ ok: true, data: { stage: "qualified" } });
    session.user = admin;
    expect(await moveCardAction(null, form({ contactId: theirsLost.id, to: "new" }))).toMatchObject({ ok: true });
    expect((await db.select().from(contacts).where(eq(contacts.id, theirsLost.id)))[0].stage).not.toBe("lost");

    // support has no board and cannot set stages: refused before the contact is looked at
    session.user = support;
    expect(await moveCardAction(null, form({ contactId: mine.id, to: "lost", lostReason: "price" }))).toEqual({
      ok: false,
      error: "You cannot change stages",
    });
    expect((await db.select().from(contacts).where(eq(contacts.id, mine.id)))[0].stage).toBe("qualified");
  });
});
