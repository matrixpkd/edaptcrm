import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, notifications, tasks, type NewContact, type TaskType } from "@/db/schema";
import { createTask, notify } from "@/lib/alerts/core";
import { requestTransfer } from "@/lib/contacts/assignment";
import { logInteraction } from "@/lib/contacts/interactions";
import { setSetting, DEFAULT_SETTINGS } from "@/lib/settings";
import { listNotifications, markAllNotificationsRead, markNotificationsRead } from "@/lib/today/inbox";
import { getTeamQueues, getTodayQueue } from "@/lib/today/queue";
import { actOnTasks, TodayError } from "@/lib/today/tasks";
import { makeUser, resetDb } from "../support/db";

// 13 Oct 2026, 15:00 in India
const NOW = new Date("2026-10-13T09:30:00Z");
const H = 3600_000;
const D = 24 * H;

let seq = 0;
async function contact(over: Partial<NewContact> = {}) {
  seq += 1;
  const [c] = await db
    .insert(contacts)
    .values({
      phoneE164: `+9198470${String(10000 + seq).padStart(5, "0")}`,
      phoneCountry: "IN",
      name: `Contact ${seq}`,
      firstDoor: "youtube",
      grade: "C",
      edaptScore: 50,
      ...over,
    })
    .returning();
  return c;
}
async function gccContact(over: Partial<NewContact> = {}) {
  seq += 1;
  return contact({ phoneE164: `+97150${String(1000000 + seq).padStart(7, "0")}`, phoneCountry: "AE", ...over });
}
async function task(
  contactId: string | null,
  userId: string | null,
  over: { type?: TaskType; reason?: string; dueAt?: Date; priority?: number } = {},
) {
  const id = await createTask({
    contactId,
    userId,
    type: over.type ?? "new_lead",
    reason: over.reason ?? "New lead assigned to you",
    dueAt: over.dueAt ?? new Date(NOW.getTime() - H),
    priority: over.priority ?? 0,
  });
  return id!;
}

describe("getTodayQueue", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("ranks abandoned checkouts on top, then overdue follow-ups, then customers by revenue and leads by score", async () => {
    const s = await makeUser({ role: "sales" });
    const abandoned = await contact({ ownerId: s.id, name: "Abandoned", edaptScore: 20, grade: "D" });
    const overdue = await contact({ ownerId: s.id, name: "Overdue", edaptScore: 30 });
    const lead90 = await contact({ ownerId: s.id, name: "Lead 90", edaptScore: 90, grade: "A", lastEnquiryAt: new Date(NOW.getTime() - 2 * H) });
    const cust20k = await contact({ ownerId: s.id, name: "Customer 20K", purchaseCount: 2, expected90dInr: 20_000, stage: "repeat" });
    const cust5k = await contact({ ownerId: s.id, name: "Customer 5K", purchaseCount: 1, expected90dInr: 5_000, stage: "first_purchase" });
    const cust500 = await contact({ ownerId: s.id, name: "Customer 500", purchaseCount: 1, expected90dInr: 500, stage: "first_purchase" });
    const lead60 = await contact({ ownerId: s.id, name: "Lead 60", edaptScore: 60, grade: "B" });
    const tomorrow = await contact({ ownerId: s.id, name: "Tomorrow", edaptScore: 99 });

    await task(lead60.id, s.id, { type: "follow_up", reason: "Follow-up you set after a call", dueAt: new Date("2026-10-13T03:00:00Z") });
    await task(cust500.id, s.id, { type: "next_rung", reason: "Due for the next rung" });
    await task(lead90.id, s.id, { type: "hot_lead", reason: "Grade A lead enquired" });
    await task(overdue.id, s.id, { type: "follow_up", reason: "Follow-up you set after a call", dueAt: new Date(NOW.getTime() - 2 * D) });
    await task(cust20k.id, s.id, { type: "at_risk", reason: "At risk" });
    await task(cust5k.id, s.id, { type: "new_advocate", reason: "Their referral just paid — call to thank" });
    await task(abandoned.id, s.id, { type: "abandoned_checkout", reason: "Started checkout, did not finish" });
    await task(tomorrow.id, s.id, { type: "follow_up", dueAt: new Date(NOW.getTime() + D) });

    const q = await getTodayQueue(s, NOW);
    expect(q.rows.map((r) => r.contact?.name)).toEqual([
      "Abandoned",
      "Overdue",
      "Lead 90", // 90
      "Customer 20K", // ≈86
      "Customer 5K", // ≈74
      "Lead 60", // 60
      "Customer 500", // ≈54
    ]);
    expect(q.counts).toMatchObject({ abandoned: 1, overdue: 1, customers: 3, leads: 2, total: 7 });
    expect(q.leftOut).toBe(0);

    // every row says why it is there
    for (const r of q.rows) {
      expect(r.reason).toBeTruthy();
      expect(r.context.length).toBeGreaterThan(0);
    }
    expect(q.rows[1].context).toContain("Overdue 2 days");
    expect(q.rows[2].context).toEqual(["Grade A lead", "enquired 2h ago"]);
  });

  it("caps at settings thresholds.todayCap and counts what was left out", async () => {
    const s = await makeUser({ role: "sales" });
    for (let i = 0; i < 6; i++) {
      const c = await contact({ ownerId: s.id, edaptScore: 10 + i * 10 });
      await task(c.id, s.id);
    }
    expect((await getTodayQueue(s, NOW)).rows).toHaveLength(6); // default cap 40

    await setSetting("thresholds", { ...DEFAULT_SETTINGS.thresholds, todayCap: 4 }, null);
    const q = await getTodayQueue(s, NOW);
    expect(q.cap).toBe(4);
    expect(q.rows).toHaveLength(4);
    expect(q.total).toBe(6);
    expect(q.leftOut).toBe(2);
    expect(q.rows.map((r) => r.contact?.edaptScore)).toEqual([60, 50, 40, 30]);

    const capped = await getTodayQueue(s, NOW, { cap: 1 });
    expect(capped.rows).toHaveLength(1);
    expect(capped.leftOut).toBe(5);
  });

  it("a salesperson sees their own tasks plus their team's pool, nothing of a colleague's", async () => {
    const kerala1 = await makeUser({ role: "sales", team: "kerala" });
    const kerala2 = await makeUser({ role: "sales", team: "kerala" });
    const dubai = await makeUser({ role: "sales", team: "dubai" });
    const noTeam = await makeUser({ role: "sales", team: null });
    const manager = await makeUser({ role: "manager" });

    const mine = await contact({ ownerId: kerala1.id, name: "Mine" });
    const theirs = await contact({ ownerId: kerala2.id, name: "Theirs" });
    const poolIn = await contact({ ownerId: null, name: "Pool India" });
    const poolAe = await gccContact({ ownerId: null, name: "Pool Dubai" });
    const ownedButPoolTask = await contact({ ownerId: kerala2.id, name: "Owned, pool task" });

    await task(mine.id, kerala1.id);
    await task(theirs.id, kerala2.id);
    await task(poolIn.id, null, { type: "abandoned_checkout", reason: "Checkout failed" });
    await task(poolAe.id, null, { type: "abandoned_checkout", reason: "Checkout failed" });
    await task(ownedButPoolTask.id, null);
    await task(mine.id, manager.id, { type: "lead_released" });

    const names = async (u: Parameters<typeof getTodayQueue>[0]) =>
      (await getTodayQueue(u, NOW)).rows.map((r) => r.contact?.name).sort();
    expect(await names(kerala1)).toEqual(["Mine", "Pool India"]);
    // a pool task on a contact someone owns only shows to that owner
    expect(await names(kerala2)).toEqual(["Owned, pool task", "Pool India", "Theirs"]);
    expect(await names(dubai)).toEqual(["Pool Dubai"]);
    expect(await names(noTeam)).toEqual(["Pool Dubai", "Pool India"]);
    // managers' own queue holds only their own tasks; the pool is in the team view
    expect(await names(manager)).toEqual(["Mine"]);

    const kq = await getTodayQueue(kerala1, NOW);
    const poolRow = kq.rows.find((r) => r.contact?.name === "Pool India")!;
    expect(poolRow.pool).toBe(true);
    expect(poolRow.band).toBe("abandoned");
    expect(kq.rows[0].contact?.name).toBe("Pool India");
  });

  it("support sees only their own tasks, never the pool", async () => {
    const support = await makeUser({ role: "support", team: "kerala" });
    const c = await contact({ ownerId: null });
    await task(c.id, null);
    expect((await getTodayQueue(support, NOW)).total).toBe(0);
  });

  it("leaves out done, dismissed and merged-away tasks; folds one contact's tasks into one row", async () => {
    const s = await makeUser({ role: "sales" });
    const live = await contact({ ownerId: s.id, name: "Live", purchaseCount: 1, expected90dInr: 2_000 });
    const winner = await contact({ ownerId: s.id, name: "Winner" });
    const merged = await contact({ ownerId: s.id, name: "Merged", mergedIntoId: winner.id });
    const t1 = await task(live.id, s.id, { type: "at_risk", reason: "At risk" });
    const t2 = await task(live.id, s.id, { type: "follow_up", reason: "Call back after payday", dueAt: new Date(NOW.getTime() - D) });
    const done = await task(winner.id, s.id);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, done));
    await task(merged.id, s.id);

    const q = await getTodayQueue(s, NOW);
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].taskIds).toEqual([t2, t1]);
    expect(q.rows[0].reason).toBe("Call back after payday");
    expect(q.rows[0].alsoReasons).toEqual(["At risk"]);
    expect(q.rows[0].band).toBe("overdue");
  });

  it("uses the user's own time zone for today and overdue", async () => {
    const dubai = await makeUser({ role: "sales", team: "dubai", timezone: "Asia/Dubai" });
    const c = await gccContact({ ownerId: dubai.id });
    // 23:30 Dubai on the 13th: due today in Dubai
    await task(c.id, dubai.id, { type: "follow_up", dueAt: new Date("2026-10-13T19:30:00Z") });
    // 00:30 Dubai on the 14th: tomorrow
    const c2 = await gccContact({ ownerId: dubai.id });
    await task(c2.id, dubai.id, { type: "follow_up", dueAt: new Date("2026-10-13T20:30:00Z") });
    const q = await getTodayQueue(dubai, NOW);
    expect(q.rows.map((r) => r.contact?.id)).toEqual([c.id]);
    expect(q.timeZone).toBe("Asia/Dubai");
  });
});

describe("getTeamQueues", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("managers see every queue grouped, with the pool first; sales cannot", async () => {
    const manager = await makeUser({ role: "manager", name: "Manager" });
    const asha = await makeUser({ role: "sales", name: "Asha" });
    const bilal = await makeUser({ role: "sales", name: "Bilal" });
    const sales = await makeUser({ role: "sales", name: "Zara" });
    for (const u of [asha, bilal, asha]) {
      const c = await contact({ ownerId: u.id });
      await task(c.id, u.id);
    }
    const pool = await contact({ ownerId: null });
    await task(pool.id, null, { type: "abandoned_checkout" });

    const groups = await getTeamQueues(manager, NOW);
    expect(groups.map((g) => [g.name, g.queue.total])).toEqual([
      ["Pool", 1],
      ["Asha", 2],
      ["Bilal", 1],
    ]);
    expect(groups[0].userId).toBeNull();
    await expect(getTeamQueues(sales, NOW)).rejects.toThrow(/managers/);
  });
});

describe("actOnTasks", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("the assignee marks done; a colleague cannot; a manager can", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const m = await makeUser({ role: "manager" });
    const c = await contact({ ownerId: s1.id });
    const t = await task(c.id, s1.id);
    await expect(actOnTasks([t], "done", s2, { now: NOW })).rejects.toBeInstanceOf(TodayError);
    expect(await actOnTasks([t], "done", s1, { now: NOW })).toBe(1);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, t));
    expect(row).toMatchObject({ status: "done", completedById: s1.id });
    // a second tap changes nothing
    expect(await actOnTasks([t], "done", s1, { now: NOW })).toBe(0);

    const t2 = await task(c.id, s1.id, { type: "at_risk" });
    expect(await actOnTasks([t2], "dismiss", m, { now: NOW })).toBe(1);
    expect((await db.select().from(tasks).where(eq(tasks.id, t2)))[0].status).toBe("dismissed");
  });

  it("snoozes to 10:00 local tomorrow or in 3 days", async () => {
    const s = await makeUser({ role: "sales", timezone: "Asia/Dubai" });
    const c = await contact({ ownerId: s.id });
    const t = await task(c.id, s.id, { type: "follow_up" });
    await actOnTasks([t], "snooze", s, { snooze: "tomorrow", now: NOW });
    expect((await db.select().from(tasks).where(eq(tasks.id, t)))[0].dueAt.toISOString()).toBe("2026-10-14T06:00:00.000Z");
    await actOnTasks([t], "snooze", s, { snooze: "in3Days", now: NOW });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, t));
    expect(row.dueAt.toISOString()).toBe("2026-10-16T06:00:00.000Z");
    expect(row.status).toBe("open");
    // and it leaves today's queue
    expect((await getTodayQueue(s, NOW)).total).toBe(0);
  });

  it("follow-ups cannot be dismissed; transfer requests are answered, not done", async () => {
    const s = await makeUser({ role: "sales" });
    const m = await makeUser({ role: "manager" });
    const c = await contact({ ownerId: s.id });
    const f = await task(c.id, s.id, { type: "follow_up" });
    await expect(actOnTasks([f], "dismiss", s, { now: NOW })).rejects.toThrow(/not dismissed/);

    const pool = await contact({ ownerId: null });
    const { taskIds } = await requestTransfer(pool.id, s, "Spoke to them at the workshop");
    await expect(actOnTasks(taskIds, "done", m, { now: NOW })).rejects.toThrow(/Approve or decline/);
    expect(await actOnTasks(taskIds, "snooze", m, { snooze: "tomorrow", now: NOW })).toBe(1);
  });

  it("salespeople can work pool tasks on pool contacts, but not pool tasks on a colleague's contact", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const support = await makeUser({ role: "support" });
    const pool = await contact({ ownerId: null });
    const pt = await task(pool.id, null, { type: "abandoned_checkout" });
    await expect(actOnTasks([pt], "done", support, { now: NOW })).rejects.toBeInstanceOf(TodayError);
    expect(await actOnTasks([pt], "done", s1, { now: NOW })).toBe(1);

    const owned = await contact({ ownerId: s2.id });
    const ot = await task(owned.id, null);
    await expect(actOnTasks([ot], "done", s1, { now: NOW })).rejects.toThrow(/someone else/);
  });

  it("rejects unknown ids", async () => {
    const s = await makeUser({ role: "sales" });
    await expect(actOnTasks(["not-a-uuid"], "done", s)).rejects.toThrow(/no longer exists/);
    await expect(actOnTasks(["00000000-0000-4000-8000-000000000000"], "done", s)).rejects.toThrow(/no longer exists/);
  });
});

describe("notifications inbox", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lists unread first, newest first, paginated; marks only the user's own", async () => {
    const u = await makeUser({ role: "sales" });
    const other = await makeUser({ role: "sales" });
    const c = await contact({ ownerId: u.id, name: "Fatima" });
    for (let i = 0; i < 5; i++) {
      await notify({ userId: u.id, type: "new_lead", title: `Alert ${i}`, contactId: c.id });
    }
    await notify({ userId: other.id, type: "new_lead", title: "Not yours" });
    const rows = await db.select().from(notifications).where(eq(notifications.userId, u.id));
    // spread created_at so the order is deterministic; alerts 3 and 4 are already read
    for (const r of rows) {
      const k = Number(r.title.split(" ")[1]);
      await db
        .update(notifications)
        .set({ createdAt: new Date(NOW.getTime() - (10 - k) * H), readAt: k >= 3 ? NOW : null })
        .where(eq(notifications.id, r.id));
    }

    const p1 = await listNotifications(u.id, { page: 1, pageSize: 2 });
    expect(p1).toMatchObject({ total: 5, unread: 3, pages: 3, page: 1 });
    expect(p1.items.map((n) => n.title)).toEqual(["Alert 2", "Alert 1"]);
    expect(p1.items[0].contactName).toBe("Fatima");
    const p2 = await listNotifications(u.id, { page: 2, pageSize: 2 });
    expect(p2.items.map((n) => n.title)).toEqual(["Alert 0", "Alert 4"]);
    expect((await listNotifications(u.id, { page: 99, pageSize: 2 })).page).toBe(3);

    const theirs = (await db.select().from(notifications).where(eq(notifications.userId, other.id)))[0];
    expect(await markNotificationsRead(u.id, [theirs.id, "nope"])).toBe(0);
    expect(await markNotificationsRead(u.id, [p1.items[0].id])).toBe(1);
    expect((await listNotifications(u.id)).unread).toBe(2);
    expect(await markAllNotificationsRead(u.id)).toBe(2);
    expect((await listNotifications(u.id)).unread).toBe(0);
    expect((await listNotifications(other.id)).unread).toBe(1);
  });
});

describe("getTodayQueue: review fixes", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("never shows a salesperson a task left behind on a contact that moved to a colleague", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const moved = await contact({ ownerId: s2.id, name: "Moved away" });
    const contactless = await task(null, s1.id, { type: "follow_up", reason: "Check the import report" });
    await task(moved.id, s1.id, { type: "follow_up", reason: "Old follow-up" });
    const q = await getTodayQueue(s1, NOW);
    expect(q.rows.map((r) => r.contact?.name ?? null)).toEqual([null]);
    expect(q.rows[0].taskIds).toEqual([contactless]);
    // a manager (who sees every contact) keeps such a task
    const m = await makeUser({ role: "manager" });
    await task(moved.id, m.id, { type: "lead_released" });
    expect((await getTodayQueue(m, NOW)).rows.map((r) => r.contact?.name)).toEqual(["Moved away"]);
  });

  it("shows freshly assigned leads with no touch yet as derived new / hot lead rows", async () => {
    const s = await makeUser({ role: "sales" });
    const other = await makeUser({ role: "sales" });
    const fresh = await contact({ ownerId: s.id, name: "Fresh", ownerAssignedAt: new Date(NOW.getTime() - 2 * H), lastEnquiryAt: new Date(NOW.getTime() - 2 * H) });
    const hot = await contact({ ownerId: s.id, name: "Hot", grade: "A", edaptScore: 82, ownerAssignedAt: new Date(NOW.getTime() - 30 * 60_000) });
    // older than thresholds.untouchedOwnerHours (24h): the untouched-lead alert owns it now
    await contact({ ownerId: s.id, name: "Old", ownerAssignedAt: new Date(NOW.getTime() - 30 * H) });
    await contact({ ownerId: s.id, name: "Customer", purchaseCount: 1, ownerAssignedAt: new Date(NOW.getTime() - H) });
    await contact({ ownerId: s.id, name: "Lost", stage: "lost", ownerAssignedAt: new Date(NOW.getTime() - H) });
    await contact({ ownerId: other.id, name: "Colleague's", ownerAssignedAt: new Date(NOW.getTime() - H) });
    const touched = await contact({ ownerId: s.id, name: "Touched", ownerAssignedAt: new Date(NOW.getTime() - 3 * H) });
    await logInteraction(touched.id, { type: "call", occurredAt: new Date(NOW.getTime() - H) }, s);

    const q = await getTodayQueue(s, NOW);
    expect(q.rows.map((r) => r.contact?.name)).toEqual(["Hot", "Fresh"]);
    const [h, f] = q.rows;
    expect(h.primary.type).toBe("hot_lead");
    expect(f.primary.type).toBe("new_lead");
    expect(f.reason).toMatch(/^New lead: no call or message logged/);
    expect(f.context).toEqual(["Grade C lead", "enquired 2h ago"]);
    // nothing to complete: logging the first touch clears it
    expect(f.taskIds).toEqual([]);
    expect(f.canDismiss).toBe(false);
    expect(q.counts.leads).toBe(2);

    await logInteraction(fresh.id, { type: "whatsapp", occurredAt: NOW }, s);
    expect((await getTodayQueue(s, NOW)).rows.map((r) => r.contact?.name)).toEqual(["Hot"]);

    // a stored task on the same contact folds the derived row into it
    const t = await task(hot.id, s.id, { type: "follow_up", reason: "Call at 4" });
    const q2 = await getTodayQueue(s, NOW);
    expect(q2.rows).toHaveLength(1);
    expect(q2.rows[0].taskIds).toEqual([t]);

    // and the team view shows it under its owner
    const m = await makeUser({ role: "manager" });
    const groups = await getTeamQueues(m, NOW);
    expect(groups.find((g) => g.userId === s.id)?.queue.total).toBe(1);
  });

  it("fetches in ranking order, so a huge backlog never pushes an abandoned checkout or overdue follow-up out", async () => {
    const s = await makeUser({ role: "sales" });
    const N = 2100;
    const many = await db
      .insert(contacts)
      .values(
        Array.from({ length: N }, (_, i) => ({
          phoneE164: `+9197${String(10_000_000 + i)}`,
          phoneCountry: "IN",
          name: `Backlog ${i}`,
          firstDoor: "youtube",
          ownerId: s.id,
          edaptScore: 10,
        })),
      )
      .returning({ id: contacts.id });
    // old, low-ranked tasks fill the fetch window if it were ordered by due date
    await db.insert(tasks).values(
      many.map((c, i) => ({
        contactId: c.id,
        userId: s.id,
        type: "next_rung" as const,
        reason: "Due for the next rung",
        dueAt: new Date(NOW.getTime() - 30 * D + i * 1000),
      })),
    );
    const abandoned = await contact({ ownerId: s.id, name: "Abandoned", edaptScore: 5 });
    await task(abandoned.id, s.id, { type: "abandoned_checkout", dueAt: new Date(NOW.getTime() - 5 * 60_000) });
    const overdue = await contact({ ownerId: s.id, name: "Overdue", edaptScore: 5 });
    await task(overdue.id, s.id, { type: "follow_up", dueAt: new Date(NOW.getTime() - 2 * D) });
    const top = await contact({ ownerId: s.id, name: "Top lead", edaptScore: 95, grade: "A" });
    await task(top.id, s.id, { type: "new_lead", dueAt: new Date(NOW.getTime() - H) });

    // a second task on the same contact folds into its row (it does not add to the counts)
    await task(top.id, s.id, { type: "at_risk", reason: "At risk", dueAt: new Date(NOW.getTime() - 2 * H) });

    const q = await getTodayQueue(s, NOW);
    expect(q.rows.slice(0, 3).map((r) => r.contact?.name)).toEqual(["Abandoned", "Overdue", "Top lead"]);
    expect(q.total).toBe(N + 3);
    expect(q.leftOut).toBe(N + 3 - 40);

    // the team view loads at most 400 tasks per person in one pass, and still reports the true row count
    const m = await makeUser({ role: "manager" });
    const group = (await getTeamQueues(m, NOW)).find((g) => g.userId === s.id);
    expect(group?.queue.rows.slice(0, 3).map((r) => r.contact?.name)).toEqual(["Abandoned", "Overdue", "Top lead"]);
    expect(group?.queue.rows[2].taskIds).toHaveLength(2);
    expect(group?.queue.total).toBe(N + 3);
    expect(group?.queue.leftOut).toBe(N + 3 - 40);
  });
});

describe("getTodayQueue: snoozing a fresh lead's task", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("takes the person off Today until the snooze ends, instead of showing them again as a new lead", async () => {
    const s = await makeUser({ role: "sales" });
    const lead = await contact({ ownerId: s.id, name: "Checkout", ownerAssignedAt: new Date(NOW.getTime() - 2 * H) });
    const t = await task(lead.id, s.id, { type: "abandoned_checkout", reason: "Started paying, did not finish" });
    const before = await getTodayQueue(s, NOW);
    expect(before.rows.map((r) => [r.contact?.name, r.primary.type])).toEqual([["Checkout", "abandoned_checkout"]]);

    await actOnTasks([t], "snooze", s, { snooze: "tomorrow", now: NOW });
    expect((await getTodayQueue(s, NOW)).rows).toEqual([]);

    // tomorrow the task is due again, with the person
    const tomorrow = new Date(NOW.getTime() + 26 * H);
    const back = await getTodayQueue(s, tomorrow);
    expect(back.rows.map((r) => r.contact?.name)).toEqual(["Checkout"]);
    expect(back.rows[0].taskIds).toEqual([t]);
  });
});
