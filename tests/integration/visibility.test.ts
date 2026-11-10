/**
 * What a salesperson can learn about contacts outside their scope (their own plus the unassigned pool), called the
 * way the browser (or an attacker) would: the Quick Add duplicate check route and save action (the name and owner
 * the spec asks for, nothing more, rate limited per user, and lookups sent at once cannot overshoot the limit), the
 * Edit page's number checks (the same limit, a referrer's number too, and a colleague's contact is not named), the
 * pipeline board's move action and the organisation page's link action (a hidden contact answers like one that does
 * not exist), and the contact page's referrals (a colleague's contacts are only counted). Organisation read models
 * are covered in contacts-queries.test.ts. The session is mocked; routes, actions, services and the database are
 * real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, queryRows } from "@/db";
import { poolConfig } from "@/db/connection";
import { contacts, rateLimitHits, tasks, type Role } from "@/db/schema";
import {
  QUICK_ADD_LOOKUP_LIMIT,
  RATE_LIMIT_RETENTION_HOURS,
  RateLimitedError,
  pruneRateLimitHits,
  takeRateLimit,
} from "@/lib/auth/rate-limit";
import { checkQuickAddDuplicate } from "@/lib/contacts/identity";
import { createOrganisation } from "@/lib/contacts/organisations";
import { getContactReferrals } from "@/lib/contacts/queries";
import { makeUser, resetDb } from "../support/db";

type U = { id: string; name: string; email: string; role: Role; team: string | null; timezone: string; active: boolean };
const session = vi.hoisted(() => ({ user: null as null | U }));
/** Every statement the app sends while `capturing` is set (src/db reads this hook when it loads, before the imports above run). */
const queryLog = vi.hoisted(() => {
  const log = { capturing: null as null | string[] };
  (globalThis as unknown as { __edaptQueryLog?: (q: string, p: unknown[]) => void }).__edaptQueryLog = (q) => {
    log.capturing?.push(q);
  };
  return log;
});

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
const { linkPersonAction } = await import("@/app/(app)/organisations/actions");
const { alternateAction, referrerAction, updateProfileAction } = await import("@/app/(app)/contacts/[id]/edit/actions");

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

  /** Waits until another connection is waiting for a lock (here: the advisory lock of a subject). */
  async function waitForLockWaiters(n: number) {
    for (let i = 0; i < 300; i++) {
      const [r] = await queryRows<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (r.n >= n) return;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error(`fewer than ${n} connections ever waited for a lock`);
  }
  const hits = async (bucket: string, subject: string) =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(rateLimitHits)
        .where(and(eq(rateLimitHits.bucket, bucket), eq(rateLimitHits.subject, subject)))
    )[0].n;

  it("lookups sent at the same moment take turns: at one below the limit, exactly one of many is counted", async () => {
    const limit = { bucket: "test_parallel", max: 300, windowMinutes: 10 };
    const poolSize = poolConfig(process.env.DATABASE_URL!).max!; // what src/db opens its pool with
    expect(poolSize).toBeGreaterThanOrEqual(4);
    // three rounds: without the lock most rounds overshoot, but now and then one still counts exactly one
    for (const subject of ["u1", "u2", "u3"]) {
      const minuteAgo = new Date(Date.now() - 60_000);
      await db.insert(rateLimitHits).values(Array.from({ length: limit.max - 1 }, () => ({ bucket: limit.bucket, subject, createdAt: minuteAgo })));
      // Open every connection of the pool first, so the lookups below really run at the same moment (a cold pool
      // connects one by one and staggers them)
      await Promise.all(Array.from({ length: poolSize }, () => db.execute(sql`select pg_sleep(0.05)`)));
      const gates = await Promise.all(Array.from({ length: 40 }, () => takeRateLimit(limit, subject)));
      expect(gates.filter((g) => g.allowed)).toHaveLength(1);
      expect(gates.filter((g) => !g.allowed)).toEqual(Array(39).fill({ allowed: false, retryAfterMinutes: 9 }));
      expect(await hits(limit.bucket, subject)).toBe(limit.max);
    }
  });

  it("a lookup is one statement, so the lock lasts only while the server runs it, never across a round trip", async () => {
    // With the lock taken in a statement of its own (then the count, then COMMIT, each a round trip), every lookup
    // waiting for it held a pooled connection until the holder's round trips came back: a burst from one person
    // stalled everyone else's queries.
    await db.insert(rateLimitHits).values([0, 1].map(() => ({ bucket: LIMIT.bucket, subject: "u1", createdAt: new Date(Date.now() - 60_000) })));
    let sent: string[] = [];
    queryLog.capturing = sent;
    try {
      expect(await takeRateLimit(LIMIT, "u1")).toEqual({ allowed: true });
      expect(await takeRateLimit(LIMIT, "u1")).toEqual({ allowed: false, retryAfterMinutes: 9 });
    } finally {
      sent = queryLog.capturing ?? [];
      queryLog.capturing = null;
    }
    expect(sent).toHaveLength(2);
    for (const q of sent) expect(q).toMatch(/^select counted, oldest from edapt_take_rate_limit\(/);
    expect(await hits(LIMIT.bucket, "u1")).toBe(LIMIT.max);
    // once it has returned, nothing is left locked
    const [locks] = await queryRows<{ n: number }>(
      sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`,
    );
    expect(locks.n).toBe(0);
  });

  it("inside a caller's transaction the lookup holds the lock until it commits; one sent meanwhile waits, then counts it", async () => {
    await db.insert(rateLimitHits).values([0, 1].map(() => ({ bucket: LIMIT.bucket, subject: "u1", createdAt: new Date(Date.now() - 60_000) })));
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let taken!: (g: unknown) => void;
    const takenP = new Promise((r) => (taken = r));
    const held = db.transaction(async (t) => {
      taken(await takeRateLimit(LIMIT, "u1", new Date(), t));
      await gate;
    });
    // the last slot, counted in the open transaction
    expect(await takenP).toEqual({ allowed: true });
    const racing = takeRateLimit(LIMIT, "u1");
    try {
      await waitForLockWaiters(1);
    } finally {
      commit();
      await held;
    }
    expect(await racing).toEqual({ allowed: false, retryAfterMinutes: 9 });
    expect(await hits(LIMIT.bucket, "u1")).toBe(LIMIT.max);
    // another subject never waits for this one
    expect(await takeRateLimit(LIMIT, "u2")).toEqual({ allowed: true });
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

describe("organisation page: linking people", () => {
  const GONE = { ok: false, error: "Contact not found" };
  const missing = "00000000-0000-4000-8000-000000000000";

  it("a colleague's contact gets the same reply as one that does not exist, linked, unlinked or merged", async () => {
    const orgA = await createOrganisation({ name: "GHSS Kozhikode", kind: "school" }, admin);
    const orgB = await createOrganisation({ name: "Acme" }, admin);
    const linked = await contact(s2.id, { type: "business", organisationId: orgA.id });
    const unlinked = await contact(s2.id);
    const survivor = await contact(s2.id);
    const merged = await contact(s2.id, { mergedIntoId: survivor.id });
    session.user = s1;

    for (const id of [linked.id, unlinked.id, merged.id, missing]) {
      for (const org of [orgA.id, orgB.id]) {
        expect(await linkPersonAction(null, form({ orgId: org, contactId: id })), `${id} -> ${org}`).toEqual(GONE);
        expect(await linkPersonAction(null, form({ orgId: org, contactId: id, unlink: "1" })), `${id} unlink`).toEqual(GONE);
      }
    }
    const after = await db.select({ id: contacts.id, org: contacts.organisationId, type: contacts.type }).from(contacts);
    expect(Object.fromEntries(after.map((c) => [c.id, [c.org, c.type]]))).toEqual({
      [linked.id]: [orgA.id, "business"],
      [unlinked.id]: [null, "individual"],
      [survivor.id]: [null, "individual"],
      [merged.id]: [null, "individual"],
    });
  });

  it("own and pool contacts keep their replies; managers and admins link anyone's; support cannot link", async () => {
    const org = await createOrganisation({ name: "GHSS Kozhikode", kind: "school" }, admin);
    const mine = await contact(s1.id);
    const pool = await contact(null);
    const theirs = await contact(s2.id, { type: "business", organisationId: org.id });
    const survivor = await contact(s2.id);
    const merged = await contact(s2.id, { mergedIntoId: survivor.id });

    session.user = s1;
    expect(await linkPersonAction(null, form({ orgId: org.id, contactId: mine.id }))).toMatchObject({ ok: true, message: "Linked to this organisation" });
    expect(await linkPersonAction(null, form({ orgId: org.id, contactId: mine.id }))).toMatchObject({ ok: true, message: "Already linked" });
    expect(await linkPersonAction(null, form({ orgId: org.id, contactId: pool.id, unlink: "1" }))).toMatchObject({
      ok: true,
      message: "Already unlinked",
    });

    for (const boss of [manager, admin]) {
      session.user = boss;
      expect(await linkPersonAction(null, form({ orgId: org.id, contactId: theirs.id }))).toMatchObject({ ok: true, message: "Already linked" });
      expect(await linkPersonAction(null, form({ orgId: org.id, contactId: merged.id }))).toEqual({
        ok: false,
        error: "This contact was merged into another record",
      });
    }
    session.user = manager;
    expect(await linkPersonAction(null, form({ orgId: org.id, contactId: theirs.id, unlink: "1" }))).toMatchObject({ ok: true, message: "Unlinked" });

    session.user = support;
    expect(await linkPersonAction(null, form({ orgId: org.id, contactId: mine.id, unlink: "1" }))).toEqual({
      ok: false,
      error: "Only sales, managers and admins can link people",
    });
    expect((await db.select().from(contacts).where(eq(contacts.id, mine.id)))[0].organisationId).toBe(org.id);
  });
});

describe("contact page: referrals", () => {
  it("a salesperson sees the people they may open and only a count of a colleague's; everyone else sees all", async () => {
    const referrer = await contact(s1.id, { name: "Ravi", networkValueInr: 61000 });
    const own = await contact(s1.id, { name: "Own Friend", referredById: referrer.id, ltvInr: 1000, grade: "C", stage: "first_purchase" });
    const pool = await contact(null, { name: "Pool Friend", referredById: referrer.id, ltvInr: 0, grade: "D", stage: "new" });
    const theirs = await contact(s2.id, { name: "Their Friend", referredById: referrer.id, ltvInr: 60000, grade: "A", stage: "repeat" });
    const theirsToo = await contact(s2.id, { name: "Another Friend", referredById: referrer.id, ltvInr: 500 });
    // merged-away rows are never listed or counted
    await contact(s2.id, { referredById: referrer.id, mergedIntoId: theirs.id, ltvInr: 9 });

    const forSales = await getContactReferrals(referrer.id, s1);
    expect(forSales.hidden).toBe(2);
    expect(forSales.referred.map((r) => r.id)).toEqual([own.id, pool.id]);
    expect(forSales.referred[0]).toMatchObject({ name: "Own Friend", ownerName: "Asha", ltvInr: 1000, grade: "C", stage: "first_purchase" });
    const sent = JSON.stringify(forSales);
    for (const leak of [theirs.id, theirsToo.id, "Their Friend", "Another Friend", "Biju", "60000", '"A"', "repeat"]) {
      expect(sent).not.toContain(leak);
    }

    for (const viewer of [manager, admin, support]) {
      const all = await getContactReferrals(referrer.id, viewer);
      expect(all.hidden).toBe(0);
      expect(all.referred.map((r) => r.id)).toEqual([theirs.id, own.id, theirsToo.id, pool.id]);
      expect(all.referred[0]).toMatchObject({ name: "Their Friend", ownerName: "Biju", ltvInr: 60000, grade: "A", stage: "repeat" });
    }
    // the colleague sees their own two and the pool's, and counts Asha's
    const forColleague = await getContactReferrals(referrer.id, s2);
    expect(forColleague.hidden).toBe(1);
    expect(forColleague.referred.map((r) => r.id)).toEqual([theirs.id, theirsToo.id, pool.id]);
  });
});

describe("Edit page: number checks", () => {
  const LIMITED = "Too many number checks in a short time. Try again in 9 minutes.";
  const counted = async (userId: string) =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(rateLimitHits).where(eq(rateLimitHits.subject, userId)))[0].n;
  function profileForm(c: { id: string; name: string }, phone: string) {
    return form({ contactId: c.id, name: c.name, phone, type: "individual" });
  }

  it("a clash with a colleague's contact does not name it; whoever may open the holder gets its name", async () => {
    const mine = await contact(s1.id);
    const theirs = await contact(s2.id, { name: "Colleague Secret", altPhones: ["+919847299999"] });
    const pool = await contact(null, { name: "Pool Holder" });
    const hidden = "This number already belongs to a colleague's contact";

    session.user = s1;
    for (const number of [theirs.phoneE164, "+919847299999"]) {
      expect(await alternateAction(null, form({ contactId: mine.id, kind: "phone", op: "add", value: number }))).toEqual({
        ok: false,
        error: hidden,
        fieldErrors: { altPhones: hidden },
      });
      expect(await updateProfileAction(null, profileForm(mine, number))).toEqual({ ok: false, error: hidden, fieldErrors: { phone: hidden } });
    }
    expect(await alternateAction(null, form({ contactId: mine.id, kind: "phone", op: "add", value: pool.phoneE164 }))).toMatchObject({
      ok: false,
      error: "This number already belongs to Pool Holder",
    });
    // every number looked up counted, the refused ones too
    expect(await counted(s1.id)).toBe(5);

    for (const boss of [manager, admin]) {
      session.user = boss;
      expect(await alternateAction(null, form({ contactId: mine.id, kind: "phone", op: "add", value: theirs.phoneE164 }))).toMatchObject({
        ok: false,
        error: "This number already belongs to Colleague Secret",
      });
    }
    expect((await db.select().from(contacts).where(eq(contacts.id, mine.id)))[0].altPhones).toEqual([]);
  });

  it("over the lookup limit the Edit page refuses before looking the number up; saves that look nothing up still work", async () => {
    const mine = await contact(s1.id, { altPhones: ["+919847288888"] });
    const theirs = await contact(s2.id, { name: "Colleague Secret" });
    await prefill(s1.id, QUICK_ADD_LOOKUP_LIMIT.max);
    session.user = s1;

    const add = await alternateAction(null, form({ contactId: mine.id, kind: "phone", op: "add", value: theirs.phoneE164 }));
    expect(add).toEqual({ ok: false, error: LIMITED, fieldErrors: { value: LIMITED } });
    const save = await updateProfileAction(null, profileForm(mine, theirs.phoneE164));
    expect(save).toEqual({ ok: false, error: LIMITED, fieldErrors: { phone: LIMITED } });
    for (const r of [add, save]) expect(JSON.stringify(r)).not.toContain("Colleague");
    expect(await counted(s1.id)).toBe(QUICK_ADD_LOOKUP_LIMIT.max);

    // nothing looked up: the same number (typed differently), a number already on the record, removing, emails
    await expect(updateProfileAction(null, profileForm(mine, mine.phoneE164.replace("+91", "0")))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await alternateAction(null, form({ contactId: mine.id, kind: "phone", op: "add", value: "+919847288888" }))).toMatchObject({ ok: true });
    expect(await alternateAction(null, form({ contactId: mine.id, kind: "phone", op: "remove", value: "+919847288888" }))).toMatchObject({ ok: true });
    expect(await alternateAction(null, form({ contactId: mine.id, kind: "email", op: "add", value: "x@example.com" }))).toMatchObject({ ok: true });
    expect(await counted(s1.id)).toBe(QUICK_ADD_LOOKUP_LIMIT.max);

    // the limit is per person: a manager is not held up
    session.user = manager;
    expect(await alternateAction(null, form({ contactId: mine.id, kind: "phone", op: "add", value: theirs.phoneE164 }))).toMatchObject({
      ok: false,
      error: "This number already belongs to Colleague Secret",
    });
  });

  it("a referrer's number counts as a lookup: at the limit it is refused before the lookup; clearing and invalid numbers count nothing", async () => {
    const mine = await contact(s1.id);
    const theirs = await contact(s2.id, { name: "Colleague Secret" });
    const other = await contact(s2.id, { name: "Another Secret" });
    const referrer = async () => (await db.select({ id: contacts.referredById }).from(contacts).where(eq(contacts.id, mine.id)))[0].id;
    await prefill(s1.id, QUICK_ADD_LOOKUP_LIMIT.max - 1);
    session.user = s1;

    // under the limit: looked up, linked, and counted once
    expect(await referrerAction(null, form({ contactId: mine.id, phone: theirs.phoneE164 }))).toMatchObject({ ok: true, message: "Referrer linked" });
    expect(await referrer()).toBe(theirs.id);
    expect(await counted(s1.id)).toBe(QUICK_ADD_LOOKUP_LIMIT.max);

    // at the limit: refused before the lookup, whether the number is in the CRM or not, and nothing changes
    for (const number of [other.phoneE164, "+919847277777"]) {
      const r = await referrerAction(null, form({ contactId: mine.id, phone: number }));
      expect(r).toEqual({ ok: false, error: LIMITED, fieldErrors: { phone: LIMITED } });
    }
    expect(await referrer()).toBe(theirs.id);
    expect(await counted(s1.id)).toBe(QUICK_ADD_LOOKUP_LIMIT.max);

    // nothing looked up: an invalid number, and clearing the referrer (which still works at the limit)
    expect(await referrerAction(null, form({ contactId: mine.id, phone: "12345" }))).toMatchObject({ ok: false, error: "That is not a valid number" });
    expect(await referrerAction(null, form({ contactId: mine.id, clear: "1" }))).toMatchObject({ ok: true, message: "Referrer removed" });
    expect(await referrer()).toBeNull();
    expect(await counted(s1.id)).toBe(QUICK_ADD_LOOKUP_LIMIT.max);

    // the limit is per person: a manager links and is counted once
    session.user = manager;
    expect(await referrerAction(null, form({ contactId: mine.id, phone: other.phoneE164 }))).toMatchObject({ ok: true, message: "Referrer linked" });
    expect(await referrer()).toBe(other.id);
    expect(await counted(manager.id)).toBe(1);
  });
});
