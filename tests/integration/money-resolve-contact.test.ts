/**
 * resolveContact (src/lib/money/internal.ts), which every purchase goes through, thousands of times on an import or
 * a webhook burst: a live contact is found and locked in one read; a merged one is followed to the survivor, and only
 * the survivor is locked; a merge or an undone merge landing meanwhile is read as it committed. The statements are
 * counted through src/db's query log hook, and selectContacts is wrapped so a test can act between two reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

/** Every statement the app sends while `capturing` is set (src/db reads this hook when it loads, before the imports below). */
const queryLog = vi.hoisted(() => {
  const log = { capturing: null as null | { q: string; p: unknown[] }[] };
  (globalThis as unknown as { __edaptQueryLog?: (q: string, p: unknown[]) => void }).__edaptQueryLog = (q, p) => {
    log.capturing?.push({ q, p });
  };
  return log;
});

/** Runs once, just before the next unlocked contact read. */
const between = vi.hoisted(() => ({ beforePlainRead: null as null | (() => Promise<void>) }));
vi.mock("@/lib/contacts/rows", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/contacts/rows")>();
  return {
    ...real,
    selectContacts: async (...args: Parameters<typeof real.selectContacts>) => {
      const hook = between.beforePlainRead;
      if (hook && !args[2]?.forUpdate) {
        between.beforePlainRead = null;
        await hook();
      }
      return real.selectContacts(...args);
    },
  };
});

import { db, queryRows } from "@/db";
import { contacts, type Contact, type NewContact } from "@/db/schema";
import { mergeContacts } from "@/lib/contacts/merge";
import { resolveContact } from "@/lib/money/internal";
import { makeUser, resetDb } from "../support/db";

let phoneN = 0;
async function makeContact(over: Partial<NewContact> = {}) {
  phoneN += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9190011${String(phoneN).padStart(5, "0")}`, name: `Contact ${phoneN}`, firstDoor: "youtube", ...over })
    .returning();
  return c;
}

/** Waits until another connection is waiting for a row lock. */
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

let rows: Contact[] = [];
const nameOf = (id: unknown) => rows.find((c) => c.id === id)?.name ?? "?";

/** True when another connection cannot lock the row right now. */
async function lockedElsewhere(id: string): Promise<boolean> {
  try {
    await db.execute(sql`select id from contacts where id = ${id} for update nowait`);
    return false;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if ((err.cause?.code ?? err.code) === "55P03") return true; // lock_not_available
    throw e;
  }
}

/**
 * resolveContact in a transaction of its own: what it found, the contact reads it sent ("locked Name" / "plain Name")
 * and which contacts that transaction holds locked once it returns.
 */
async function resolve(id: string, forUpdate: boolean) {
  return db.transaction(async (t) => {
    queryLog.capturing = [];
    const found = await resolveContact(id, t, { forUpdate });
    const sent = queryLog.capturing;
    queryLog.capturing = null;
    const reads = sent
      .filter((s) => /^\s*select\b/i.test(s.q) && /from "contacts"/.test(s.q))
      .map((s) => `${/\bfor update\b/.test(s.q) ? "locked" : "plain"} ${nameOf(s.p[0])}`);
    const locked: string[] = [];
    for (const c of rows) if (await lockedElsewhere(c.id)) locked.push(c.name);
    return { found: found?.name, reads, locked };
  });
}

describe("money: resolving the contact a purchase lands on", () => {
  let live: Contact, winner: Contact, loser: Contact;
  beforeEach(async () => {
    await resetDb();
    between.beforePlainRead = null;
    live = await makeContact({ name: "Live" });
    winner = await makeContact({ name: "Winner" });
    loser = await makeContact({ name: "Loser", mergedIntoId: winner.id, mergedAt: new Date() });
    rows = [live, winner, loser];
  });

  it("a live contact is found and locked in one read; a merged one is followed and only the survivor is locked", async () => {
    expect(await resolve(live.id, true)).toEqual({ found: "Live", reads: ["locked Live"], locked: ["Live"] });
    expect(await resolve(loser.id, true)).toEqual({ found: "Winner", reads: ["locked Loser", "plain Loser", "locked Winner"], locked: ["Winner"] });
    // without the lock: one plain read per row on the way
    expect(await resolve(live.id, false)).toEqual({ found: "Live", reads: ["plain Live"], locked: [] });
    expect(await resolve(loser.id, false)).toEqual({ found: "Winner", reads: ["plain Loser", "plain Winner"], locked: [] });
    // an unknown id is looked for once each way; a malformed one is not looked up at all
    expect(await resolve("00000000-0000-0000-0000-000000000000", true)).toEqual({ found: undefined, reads: ["locked ?", "plain ?"], locked: [] });
    expect(await resolve("not-an-id", true)).toEqual({ found: undefined, reads: [], locked: [] });
  });

  it("a merge in progress is waited for, then the purchase follows it to the survivor", async () => {
    const admin = await makeUser({ role: "admin" });
    const other = await makeContact({ name: "Other" });
    rows.push(other);
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let merged!: () => void;
    const mergedP = new Promise<void>((r) => (merged = r));
    // Other is being merged into Live: both rows are locked until the merge commits
    const merge = db.transaction(async (t) => {
      await mergeContacts(live.id, other.id, admin, "Same person", t);
      merged();
      await gate;
    });
    await mergedP;
    const resolving = resolve(other.id, true);
    try {
      await waitForLockWaiters(1);
    } finally {
      commit();
      await merge;
    }
    // Other stops matching the locked read once merged, and is followed to Live. Postgres keeps the lock it took on
    // Other while waiting for the merge (the way it always has), until this transaction ends.
    expect(await resolving).toEqual({ found: "Live", reads: ["locked Other", "plain Other", "locked Live"], locked: ["Live", "Other"] });
  });

  it("a merge undone between the two reads: the contact is read again, locked", async () => {
    between.beforePlainRead = async () => {
      await db.update(contacts).set({ mergedIntoId: null, mergedAt: null }).where(eq(contacts.id, loser.id));
    };
    expect(await resolve(loser.id, true)).toEqual({ found: "Loser", reads: ["locked Loser", "plain Loser", "locked Loser"], locked: ["Loser"] });
    expect(between.beforePlainRead).toBeNull();
  });
});
