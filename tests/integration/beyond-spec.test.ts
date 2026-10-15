import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, contactMerges, contacts, enquiries, interactions, notifications, payments, purchases, tasks } from "@/db/schema";
import { getActivityFeed } from "@/lib/activity/feed";
import { createTask } from "@/lib/alerts/core";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactValidationError } from "@/lib/contacts/errors";
import { logInteraction } from "@/lib/contacts/interactions";
import { setManualStage } from "@/lib/contacts/lifecycle";
import { mergeContacts, undoMerge } from "@/lib/contacts/merge";
import { addNote, getPinnedNote, setPinned } from "@/lib/contacts/notes";
import { ERASED_NAME, eraseContact, setConsent } from "@/lib/contacts/privacy";
import { listContacts, parseContactFilters } from "@/lib/contacts/queries";
import { recordPurchase } from "@/lib/money";
import { getBoard } from "@/lib/pipeline/board";
import { globalSearch } from "@/lib/search/global";
import { TaskError } from "@/lib/tasks/rules";
import { agendaTasks, contactOpenTasks, createManualTask, listTasks, setTaskStatus, taskCounts, updateTask } from "@/lib/tasks/service";
import { notificationHref } from "@/lib/today/inbox";
import { getTodayQueue } from "@/lib/today/queue";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const phone = () => `98471${String(10000 + seq++).padStart(5, "0")}`;

async function lead(ownerId: string | null, name = "Priya Nair", extra: Record<string, unknown> = {}) {
  return (
    await captureEnquiry({ phone: phone(), name, channel: "phone_call", ownerId, skipAssignment: true, skipAlerts: true, ...extra })
  ).contact;
}

const H = 3_600_000;

describe("tasks and reminders", () => {
  beforeEach(resetDb);

  it("a salesperson adds a task for themselves; it shows on /tasks, the contact and Today when due", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await lead(sales.id);
    const now = new Date();
    const id = await createManualTask({ title: "Send the brochure", notes: "AI Office PDF", dueAt: new Date(now.getTime() - H), contactId: c.id }, sales);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row).toMatchObject({ type: "task", userId: sales.id, contactId: c.id, reason: "Send the brochure", status: "open", createdById: sales.id });
    expect(row.payload).toEqual({ notes: "AI Office PDF" });

    const mine = await listTasks(sales, "mine", { now });
    expect(mine.rows.map((r) => r.id)).toEqual([id]);
    expect((await listTasks(sales, "overdue", { now })).total).toBe(1);
    expect((await listTasks(sales, "upcoming", { now })).total).toBe(0);
    expect((await contactOpenTasks(c.id, sales)).map((t) => t.title)).toEqual(["Send the brochure"]);
    expect(await taskCounts(sales, now)).toMatchObject({ open: 1, overdue: 1, team: null });

    const today = await getTodayQueue(sales, now);
    const r = today.rows.find((x) => x.taskIds.includes(id));
    expect(r?.reason).toBe("Send the brochure");

    // a logged call does not close a manual task (only follow-ups and lead alerts)
    await logInteraction(c.id, { type: "call", outcome: "interested" }, sales);
    expect((await db.select().from(tasks).where(eq(tasks.id, id)))[0].status).toBe("open");

    expect(await setTaskStatus(id, "done", sales)).toBe(true);
    expect((await listTasks(sales, "done", { now })).rows[0]).toMatchObject({ id, status: "done" });
    expect(await setTaskStatus(id, "open", sales)).toBe(true);
    expect(await setTaskStatus(id, "cancel", sales)).toBe(true);
    expect((await db.select().from(tasks).where(eq(tasks.id, id)))[0].status).toBe("dismissed");
  });

  it("a task with no contact shows on Today on its own row", async () => {
    const sales = await makeUser({ role: "sales" });
    const now = new Date();
    const id = await createManualTask({ title: "Prepare the Dubai price list", dueAt: new Date(now.getTime() - 60_000) }, sales);
    const today = await getTodayQueue(sales, now);
    expect(today.rows.find((x) => x.taskIds.includes(id))).toMatchObject({ contact: null, reason: "Prepare the Dubai price list" });
  });

  it("only managers give tasks to others; the assignee is told and must be able to see the contact", async () => {
    const manager = await makeUser({ role: "manager", name: "Meera" });
    const s1 = await makeUser({ role: "sales", name: "Asha" });
    const s2 = await makeUser({ role: "sales", name: "Biju" });
    const due = new Date(Date.now() + 24 * H);
    await expect(createManualTask({ title: "x", dueAt: due, assigneeId: s2.id }, s1)).rejects.toThrow(/Only a manager/);

    const mine = await lead(s1.id);
    await expect(createManualTask({ title: "Call back", dueAt: due, assigneeId: s2.id, contactId: mine.id }, manager)).rejects.toThrow(
      /Biju cannot see/,
    );
    const id = await createManualTask({ title: "Call back", dueAt: due, assigneeId: s1.id, contactId: mine.id }, { ...manager, name: "Meera" });
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, s1.id));
    expect(n).toMatchObject({ type: "task_assigned", title: "New task from Meera: Call back", taskId: id, contactId: mine.id });
    // opening the alert goes to the task list, where the task shows who it is from
    expect(notificationHref(n)).toBe("/tasks");

    // a salesperson cannot see or touch someone else's task
    await expect(setTaskStatus(id, "done", s2)).rejects.toThrow(/belongs to someone else/);
    // the team view is for managers
    await expect(listTasks(s1, "team")).rejects.toBeInstanceOf(TaskError);
    expect((await listTasks(manager, "team", { assigneeId: s1.id })).total).toBe(1);

    // reassigning moves it and tells the new person
    const pool = await lead(null);
    expect(await updateTask(id, { contactId: pool.id, assigneeId: s2.id }, manager)).toBe(true);
    expect((await db.select().from(tasks).where(eq(tasks.id, id)))[0]).toMatchObject({ userId: s2.id, contactId: pool.id });
    expect(await db.select().from(notifications).where(eq(notifications.userId, s2.id))).toHaveLength(1);

    // a deactivated person cannot get tasks
    const gone = await makeUser({ role: "sales", active: false, name: "Gone" });
    await expect(createManualTask({ title: "x", dueAt: due, assigneeId: gone.id }, manager)).rejects.toThrow(/deactivated/);
  });

  it("follow-ups are rescheduled and completed on /tasks but never edited or cancelled", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await lead(sales.id);
    await logInteraction(c.id, { type: "call", nextFollowUpAt: new Date(Date.now() + 2 * H) }, sales);
    const [f] = await db.select().from(tasks).where(and(eq(tasks.contactId, c.id), eq(tasks.type, "follow_up")));
    const later = new Date(Date.now() + 48 * H);
    expect(await updateTask(f.id, { dueAt: later }, sales)).toBe(true);
    expect((await db.select().from(tasks).where(eq(tasks.id, f.id)))[0].dueAt.getTime()).toBe(later.getTime());
    await expect(updateTask(f.id, { title: "Changed" }, sales)).rejects.toThrow(/only be rescheduled/);
    await expect(setTaskStatus(f.id, "cancel", sales)).rejects.toThrow(/not cancelled/);

    const { rows } = await agendaTasks(sales, new Date(Date.now() + 24 * H), new Date(Date.now() + 72 * H));
    expect(rows.map((r) => r.id)).toEqual([f.id]);
  });

  it("validates titles and refuses a contact that was merged away", async () => {
    const sales = await makeUser({ role: "sales" });
    const manager = await makeUser({ role: "manager" });
    await expect(createManualTask({ title: "  ", dueAt: new Date() }, sales)).rejects.toThrow("Write what needs doing");
    const a = await lead(null, "Same Person");
    const b = await lead(null, "Same Person");
    await mergeContacts(a.id, b.id, manager);
    await expect(createManualTask({ title: "x", dueAt: new Date(), contactId: b.id }, sales)).rejects.toThrow(/no longer exists/);
  });
});

describe("notes", () => {
  beforeEach(resetDb);

  it("adds a note, pins one at a time, and a note never closes a follow-up", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await lead(sales.id);
    await logInteraction(c.id, { type: "call", nextFollowUpAt: new Date(Date.now() + H) }, sales);
    const fresh = await lead(sales.id, "Fresh Lead");
    await addNote(fresh.id, "Met at the Kochi workshop", sales);
    // a note is not contact with the person: the lead stays New
    expect((await db.select().from(contacts).where(eq(contacts.id, fresh.id)))[0].stage).toBe("new");
    const first = await addNote(c.id, "Only call after 6 pm", sales, { pin: true });
    expect((await db.select().from(tasks).where(and(eq(tasks.contactId, c.id), eq(tasks.type, "follow_up"))))[0].status).toBe("open");
    expect((await getPinnedNote(c.id))?.id).toBe(first);

    const second = await addNote(c.id, "Runs three supermarkets", sales);
    await setPinned(second, true, sales);
    expect((await getPinnedNote(c.id))?.summary).toBe("Runs three supermarkets");
    expect((await db.select().from(interactions).where(eq(interactions.id, first)))[0].pinnedAt).toBeNull();
    await setPinned(second, false, sales);
    expect(await getPinnedNote(c.id)).toBeNull();

    await expect(addNote(c.id, "   ", sales)).rejects.toThrow("Write the note first");
    const call = (await db.select().from(interactions).where(and(eq(interactions.contactId, c.id), eq(interactions.type, "call"))))[0];
    await expect(setPinned(call.id, true, sales)).rejects.toThrow("Only notes can be pinned");
    const other = await makeUser({ role: "sales" });
    await expect(addNote(c.id, "sneaky", other)).rejects.toThrow();
    const audits = await db.select().from(auditLog).where(eq(auditLog.tableName, "interactions"));
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });
});

describe("data privacy", () => {
  beforeEach(resetDb);

  it("erases personal data, keeps the money, hides the contact and audits it", async () => {
    const admin = await makeUser({ role: "admin" });
    const sales = await makeUser({ role: "sales" });
    const c = await lead(sales.id, "Priya Nair", { email: "priya@example.com" });
    await addNote(c.id, "Lives in Kochi, two kids", sales, { pin: true });
    await logInteraction(c.id, { type: "call", summary: "Asked about fees", nextFollowUpAt: new Date(Date.now() + H) }, sales);
    await recordPurchase(
      { contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: `TM-${seq++}`, purchasedAt: new Date() },
      null,
    );
    const before = (await db.select().from(contacts).where(eq(contacts.id, c.id)))[0];
    expect(before.ltvInr).toBe(999);

    await expect(eraseContact(c.id, sales, "asked")).rejects.toThrow(/Only an admin/);
    await expect(eraseContact(c.id, admin, " ")).rejects.toBeInstanceOf(ContactValidationError);
    await eraseContact(c.id, admin, "Asked by email on 12 Oct");

    const after = (await db.select().from(contacts).where(eq(contacts.id, c.id)))[0];
    expect(after).toMatchObject({ name: ERASED_NAME, email: null, phoneE164: `erased:${c.id}`, consent: false, ltvInr: 999, purchaseCount: 1 });
    expect(after.erasedAt).not.toBeNull();
    const ints = await db.select().from(interactions).where(eq(interactions.contactId, c.id));
    expect(ints.every((i) => i.summary === null && i.pinnedAt === null)).toBe(true);
    expect((await db.select().from(enquiries).where(eq(enquiries.contactId, c.id))).every((e) => e.rawPayload === null)).toBe(true);
    expect(await db.select().from(purchases).where(eq(purchases.contactId, c.id))).toHaveLength(1);
    expect(await db.select().from(payments).where(eq(payments.contactId, c.id))).toHaveLength(1);
    const open = await db.select().from(tasks).where(and(eq(tasks.contactId, c.id), eq(tasks.status, "open")));
    expect(open).toHaveLength(0);
    const contactAudit = await db.select().from(auditLog).where(and(eq(auditLog.tableName, "contacts"), eq(auditLog.rowId, c.id)));
    const erase = contactAudit.find((a) => a.action === "erase");
    expect(erase?.newValue).toEqual({ reason: "Asked by email on 12 Oct", rows: 1 });
    expect(JSON.stringify(contactAudit)).not.toContain("Priya");

    // gone from lists and search; the same number comes back as a new person
    const list = await listContacts(admin, parseContactFilters({}));
    expect(list.rows.map((r) => r.id)).not.toContain(c.id);
    expect(await globalSearch(admin, "Priya")).toEqual([]);
    const again = await captureEnquiry({ phone: before.phoneE164, name: "Priya Nair", channel: "phone_call", skipAlerts: true, skipAssignment: true });
    expect(again.contact.id).not.toBe(c.id);
    await expect(eraseContact(c.id, admin, "again")).rejects.toThrow(/already erased/);
  });

  it("refuses while a payment waits, erases merged-away rows and blocks undoing their merge", async () => {
    const admin = await makeUser({ role: "admin" });
    const c = await lead(null, "Waiting Payer");
    await recordPurchase(
      { contactId: c.id, productName: "AAM", family: "applied_ai_mastery", amount: 5000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, purchasedAt: new Date() },
      admin,
    );
    await expect(eraseContact(c.id, admin, "asked")).rejects.toThrow(/still waiting/);

    const a = await lead(null, "Twin Person");
    const b = await lead(null, "Twin Person");
    const mergeId = await mergeContacts(a.id, b.id, admin);
    const r = await eraseContact(a.id, admin, "asked");
    expect(r.erasedIds.sort()).toEqual([a.id, b.id].sort());
    expect((await db.select().from(contacts).where(eq(contacts.id, b.id)))[0].name).toBe(ERASED_NAME);
    expect((await db.select().from(contactMerges).where(eq(contactMerges.id, mergeId)))[0].winnerBefore).toEqual({});
    await expect(undoMerge(mergeId, admin)).rejects.toThrow(/erased/);
  });

  it("records and withdraws consent with the date", async () => {
    const sales = await makeUser({ role: "sales" });
    const support = await makeUser({ role: "support" });
    const c = await lead(sales.id);
    await setConsent(c.id, true, sales);
    let row = (await db.select().from(contacts).where(eq(contacts.id, c.id)))[0];
    expect(row.consent).toBe(true);
    expect(row.consentAt).not.toBeNull();
    await setConsent(c.id, false, sales);
    row = (await db.select().from(contacts).where(eq(contacts.id, c.id)))[0];
    expect(row.consent).toBe(false);
    await expect(setConsent(c.id, true, support)).rejects.toThrow();
  });
});

describe("search, pipeline and activity", () => {
  beforeEach(resetDb);

  it("global search finds contacts by name, phone and email inside the person's scope, and organisations", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const mine = await lead(s1.id, "Fathima Rahman", { email: "fathima@example.com" });
    await lead(s2.id, "Fathima Other");
    const hits = await globalSearch(s1, "fathima");
    expect(hits.filter((h) => h.kind === "contact").map((h) => h.id)).toEqual([mine.id]);
    const byPhone = await globalSearch(s1, mine.phoneE164.slice(-6));
    expect(byPhone.some((h) => h.id === mine.id)).toBe(true);
    expect((await globalSearch(s1, "fathima@example")).some((h) => h.id === mine.id)).toBe(true);
    expect(await globalSearch(s1, "f")).toEqual([]);
    // screens the person may open
    expect((await globalSearch(s1, "pipel")).map((h) => h.href)).toContain("/pipeline");
    expect((await globalSearch(s1, "settings")).map((h) => h.href)).not.toContain("/settings");
  });

  it("the pipeline board groups contacts by stage within scope and filters", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const manager = await makeUser({ role: "manager" });
    const a = await lead(s1.id, "Alpha One");
    const b = await lead(s1.id, "Bravo Two");
    await lead(s2.id, "Charlie Three");
    await lead(null, "Delta Pool");
    await setManualStage(b.id, "lost", { lostReason: "price" }, s1);
    const board = await getBoard(s1, {});
    const count = (stage: string) => board.find((c) => c.stage === stage)!.count;
    expect(board).toHaveLength(8);
    expect(count("new") + count("contacted")).toBe(2);
    expect(count("lost")).toBe(1);
    expect(board.flatMap((c) => c.cards.map((x) => x.name))).not.toContain("Charlie Three");
    const mineOnly = await getBoard(s1, { owner: "mine" });
    expect(mineOnly.flatMap((c) => c.cards.map((x) => x.id)).sort()).toEqual([a.id, b.id].sort());
    expect((await getBoard(manager, {})).reduce((n, c) => n + c.count, 0)).toBe(4);
    expect((await getBoard(manager, { owner: "pool" })).reduce((n, c) => n + c.count, 0)).toBe(1);
  });

  it("the activity feed shows what people did, newest first, by person and kind", async () => {
    const manager = await makeUser({ role: "manager" });
    const sales = await makeUser({ role: "sales", name: "Asha" });
    const c = (await captureEnquiry({ phone: phone(), name: "Feed Person", channel: "phone_call", createdById: sales.id, ownerId: sales.id, skipAssignment: true, skipAlerts: true })).contact;
    await logInteraction(c.id, { type: "call", outcome: "interested" }, sales);
    await setManualStage(c.id, "qualified", {}, sales);
    const t = await createTask({ contactId: c.id, userId: sales.id, type: "follow_up", reason: "Call back", dueAt: new Date() });
    await setTaskStatus(t!, "done", sales);
    const feed = await getActivityFeed(manager);
    const kinds = feed.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["lead", "interaction", "stage", "task"]));
    expect(feed.items.every((i) => i.actorName === "Asha")).toBe(true);
    expect((await getActivityFeed(manager, { kinds: ["interaction"] })).items.map((i) => i.detail)).toEqual(["call"]);
    expect((await getActivityFeed(manager, { userId: manager.id })).items).toEqual([]);
    await expect(getActivityFeed(sales)).rejects.toThrow();
    const page = await getActivityFeed(manager, { limit: 2 });
    expect(page.items).toHaveLength(2);
    const rest = await getActivityFeed(manager, { before: page.nextBefore });
    expect(rest.items.every((i) => i.at.getTime() < page.nextBefore!.getTime())).toBe(true);
  });
});
