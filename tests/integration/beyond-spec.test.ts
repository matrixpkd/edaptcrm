import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, queryRows } from "@/db";
import {
  appErrors,
  auditLog,
  contactMerges,
  contacts,
  enquiries,
  importBatches,
  importRows,
  interactions,
  notifications,
  organisations,
  ownershipLog,
  payments,
  products,
  purchases,
  ratings,
  tasks,
  webhookEvents,
} from "@/db/schema";
import { getActivityFeed } from "@/lib/activity/feed";
import { createTask } from "@/lib/alerts/core";
import { buildDailyDigest, buildWeeklySummary } from "@/lib/alerts/digest";
import { untouchedLeads } from "@/lib/alerts/rules";
import { handoverAllContacts, reassignContacts, releaseStaleLeads, requestTransfer, setOwner } from "@/lib/contacts/assignment";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactErasedError, ContactValidationError, ERASED_MESSAGE } from "@/lib/contacts/errors";
import { logInteraction } from "@/lib/contacts/interactions";
import { reopenContact, setManualStage } from "@/lib/contacts/lifecycle";
import { mergeContacts, undoMerge } from "@/lib/contacts/merge";
import { addNote, getPinnedNote, setPinned } from "@/lib/contacts/notes";
import { linkContactToOrganisation } from "@/lib/contacts/organisations";
import { ERASED_NAME, ERASED_REASON, eraseContact, setConsent } from "@/lib/contacts/privacy";
import { applyRating, updateContactProfile } from "@/lib/contacts/profile";
import { getContactTimeline, getOrganisationPeople, listContacts, listOrganisations, parseContactFilters } from "@/lib/contacts/queries";
import { createImportBatch, getBatchView, listRows, resolveAllConflictsAsNew, runCleanChunk, saveMapping } from "@/lib/import/batches";
import { runCommitChunk, startCommit } from "@/lib/import/commit";
import { runMatchChunk } from "@/lib/import/match";
import type { AppliedRow, StoredClean } from "@/lib/import/types";
import { runUndoChunk, startUndo } from "@/lib/import/undo";
import { addPayment, adjustCredit, cancelPurchase, recordPurchase, recordRefund, rejectPayment, verifyPayment } from "@/lib/money";
import { PROOF_FOLDER, canReadStoredFile, discardUnsavedProof, saveFile, storedKeyFromUrl } from "@/lib/storage";
import { ingestWebhook } from "@/lib/webhooks/handlers";
import { getBoard } from "@/lib/pipeline/board";
import { globalSearch } from "@/lib/search/global";
import { TaskError } from "@/lib/tasks/rules";
import { agendaTasks, contactOpenTasks, createManualTask, listTasks, setTaskStatus, taskCounts, updateTask } from "@/lib/tasks/service";
import { notificationHref } from "@/lib/today/inbox";
import { getTeamQueues, getTodayQueue } from "@/lib/today/queue";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const phone = () => `98471${String(10000 + seq++).padStart(5, "0")}`;

async function lead(ownerId: string | null, name = "Priya Nair", extra: Record<string, unknown> = {}) {
  return (
    await captureEnquiry({ phone: phone(), name, channel: "phone_call", ownerId, skipAssignment: true, skipAlerts: true, ...extra })
  ).contact;
}

const H = 3_600_000;

// payment proofs go to ./uploads in tests (no Supabase): whatever a test leaves there is removed at the end
const UPLOADS = path.join(process.cwd(), "uploads");
const leftovers: string[] = [];
afterAll(async () => {
  for (const p of leftovers) await rm(p, { recursive: true, force: true });
});
async function proofFile(name: string): Promise<string> {
  const url = await saveFile({ name, type: "image/png", data: new Uint8Array([137, 80, 78, 71]) }, PROOF_FOLDER);
  leftovers.push(path.join(UPLOADS, storedKeyFromUrl(url)!));
  return url;
}
const onDisk = (url: string) => existsSync(path.join(UPLOADS, storedKeyFromUrl(url)!));

/** The error a promise rejects with, or null when it resolves (so a refusal can be checked after other awaits). */
const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

/** Waits until `n` connections to the test database are waiting for a lock (the writes under test have queued). */
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

type Admin = Awaited<ReturnType<typeof makeUser>>;

/** A real TagMango import of `csv`, cleaned and matched: ready for review. */
async function importOrders(csv: string, admin: Admin, mapping: Record<string, string> = {}): Promise<string> {
  const batchId = await createImportBatch({ fileName: "orders.csv", fileType: "text/csv", bytes: new TextEncoder().encode(csv), source: "tagmango" }, admin);
  const [stored] = await db.select({ fileUrl: importBatches.fileUrl }).from(importBatches).where(eq(importBatches.id, batchId));
  if (stored.fileUrl) leftovers.push(path.join(UPLOADS, storedKeyFromUrl(stored.fileUrl)!));
  const view = (await getBatchView(batchId, admin))!;
  await saveMapping(batchId, { mapping: { ...(view.mapping ?? {}), ...mapping }, defaults: {} }, admin);
  for (let i = 0; i < 20; i++) if ((await runCleanChunk(batchId, admin)).finished) break;
  for (let i = 0; i < 20; i++) if ((await runMatchChunk(batchId, admin)).finished) break;
  return batchId;
}

async function commitImport(batchId: string, admin: Admin): Promise<void> {
  await startCommit(batchId, admin);
  for (let i = 0; i < 20; i++) if ((await runCommitChunk(batchId, admin)).finished) break;
}

async function undoImport(batchId: string, admin: Admin): Promise<void> {
  await startUndo(batchId, admin);
  for (let i = 0; i < 20; i++) if ((await runUndoChunk(batchId, admin)).finished) break;
}

const importRowsOf = (batchId: string) => db.select().from(importRows).where(eq(importRows.batchId, batchId)).orderBy(importRows.rowNumber);

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
    expect(erase?.newValue).toEqual({ reason: "Asked by email on 12 Oct", rows: 1, proofs: 0 });
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
    const mergeId = await mergeContacts(a.id, b.id, admin, "Twin's second number");
    const r = await eraseContact(a.id, admin, "asked");
    expect(r.erasedIds.sort()).toEqual([a.id, b.id].sort());
    expect((await db.select().from(contacts).where(eq(contacts.id, b.id)))[0].name).toBe(ERASED_NAME);
    expect((await db.select().from(contactMerges).where(eq(contactMerges.id, mergeId)))[0]).toMatchObject({ winnerBefore: {}, reason: null });
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

  it("unlinks and deletes payment proofs and clears free text on money rows; references and amounts stay", async () => {
    const admin = await makeUser({ role: "admin" });
    const manager = await makeUser({ role: "manager" });
    const sales = await makeUser({ role: "sales" });
    const other = await makeUser({ role: "sales" });
    const c = await lead(sales.id, "Priya Nair");
    const shot = await proofFile("priya-nair-gpay.png");
    const slip = await proofFile("priya-bank-slip.png");
    // a verified bank transfer with its screenshot (on the purchase and on its payment)
    await recordPurchase(
      { contactId: c.id, productName: "AAM", family: "applied_ai_mastery", amount: 5000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, proofUrl: shot, notes: "Paid by Priya's husband", verified: true, purchasedAt: new Date() },
      admin,
    );
    // a TagMango order, partly refunded with a reason
    const refundRef = `RF-${seq++}`;
    const tm = await recordPurchase(
      { contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: `TM-${seq++}`, rawPayload: { name: "Priya Nair" }, purchasedAt: new Date() },
      null,
    );
    await recordRefund(tm.purchaseId, { amount: 199, reason: "Priya moved to Dubai", reference: refundRef }, admin);
    // a claimed payment rejected with a note
    const claim = await recordPurchase(
      { contactId: c.id, productName: "AAM", family: "applied_ai_mastery", amount: 2000, currency: "INR", mode: "upi_qr", source: "manual", reference: `UPI${seq++}`, proofUrl: slip, purchasedAt: new Date() },
      sales,
    );
    await rejectPayment(claim.paymentIds[0], manager, "Wrong UTR from Priya");
    // an owner change with a typed reason (import rows: see "takes the person out of every import")
    await reassignContacts([c.id], other.id, manager, "Priya prefers Hindi");

    const buysBefore = await db.select().from(purchases).where(eq(purchases.contactId, c.id));
    const paysBefore = await db.select().from(payments).where(eq(payments.contactId, c.id));
    const ltvBefore = (await db.select().from(contacts).where(eq(contacts.id, c.id)))[0].ltvInr;
    expect(ltvBefore).toBe(5000 + 999 - 199);
    expect(onDisk(shot) && onDisk(slip)).toBe(true);
    expect(await canReadStoredFile(other, storedKeyFromUrl(shot)!)).toBe(true);

    const r = await eraseContact(c.id, admin, "Asked by email");
    expect(r.proofKeys.sort()).toEqual([storedKeyFromUrl(shot), storedKeyFromUrl(slip)].sort());
    expect(r).toMatchObject({ filesDeleted: 2, fileErrors: 0 });

    // the proofs: no row points at them (the file route serves nobody), and the files are gone
    for (const url of [shot, slip]) {
      expect(onDisk(url)).toBe(false);
      expect(await canReadStoredFile(admin, storedKeyFromUrl(url)!)).toBe(false);
    }
    // money rows: free text and proofs cleared, everything the accounts need unchanged
    const buys = await db.select().from(purchases).where(eq(purchases.contactId, c.id));
    expect(buys).toHaveLength(3);
    for (const p of buys) {
      expect(p).toMatchObject({ proofUrl: null, notes: null, rawPayload: null });
      const b = buysBefore.find((x) => x.id === p.id)!;
      expect({ ...p, proofUrl: b.proofUrl, notes: b.notes, rawPayload: b.rawPayload, updatedAt: b.updatedAt }).toEqual(b);
    }
    const pays = await db.select().from(payments).where(eq(payments.contactId, c.id));
    expect(pays).toHaveLength(paysBefore.length);
    for (const p of pays) {
      expect(p).toMatchObject({ proofUrl: null, reason: null });
      const b = paysBefore.find((x) => x.id === p.id)!;
      expect({ ...p, proofUrl: b.proofUrl, reason: b.reason, updatedAt: b.updatedAt }).toEqual(b);
    }
    expect(pays.find((p) => p.kind === "refund")).toMatchObject({ reference: refundRef, amount: 199, status: "verified" });
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0].ltvInr).toBe(ltvBefore);
    // the same notes in the money rows' history are gone; the references stay
    const moneyAudit = JSON.stringify(await db.select().from(auditLog).where(inArray(auditLog.tableName, ["purchases", "payments"])));
    expect(moneyAudit).not.toMatch(/Priya|Dubai|husband/);
    expect(moneyAudit).toContain(refundRef);
    // owner changes keep who and when, not the reason typed
    const log = await db.select().from(ownershipLog).where(eq(ownershipLog.contactId, c.id));
    expect(log).toHaveLength(2);
    expect(log.every((l) => l.reason === ERASED_REASON)).toBe(true);
  });

  it("takes the person out of every import: their rows are wiped, other contacts' rows lose what they quote of them", async () => {
    const admin = await makeUser({ role: "admin" });
    await db.insert(products).values({ name: "AI Workshop", family: "workshop", rung: 1, listPrice: 999 });
    // a namesake in the same city, older than her (so the first candidate of a same-name conflict), and Anil
    const namesake = await lead(null, "Priya Nair", { profile: { city: "Kochi" } });
    const p = await lead(null, "Priya Nair", { email: "priya@example.com", profile: { city: "Kochi" } });
    const anil = await lead(null, "Anil Kumar");
    const order = `TM-${seq++}`;
    await recordPurchase(
      { contactId: p.id, productName: "AI Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: order, purchasedAt: new Date("2025-09-01T10:00:00Z") },
      null,
    );
    const national = p.phoneE164.slice(3);
    const newcomer = phone();
    const csv = [
      "Order ID,Name,Phone,Email,City,State,Mango,Amount,Date,Alt Phone,Referred By",
      // 1: her order again: skipped, "already recorded on Priya Nair", linked to no contact
      `${order},Priya Nair,${national},priya@example.com,Kochi,,AI Workshop,999,01/10/2025,,`,
      // 2: her, by number: merged into her (the state is new: the undo would put it back)
      `TM-${seq++},Priya Nair,${national},,Kochi,Kerala,AI Workshop,999,02/10/2025,,`,
      // 3: Anil, with her number as his other number: "<her number> belongs to Priya Nair, so it was not added"
      `TM-${seq++},Anil Kumar,${anil.phoneE164.slice(3)},,,,AI Workshop,999,03/10/2025,${national},`,
      // 4: another Priya Nair of Kochi: a conflict with both Priya Nairs as candidates, imported as new
      `TM-${seq++},Priya Nair,${newcomer},,Kochi,,AI Workshop,999,04/10/2025,,`,
      // 5: her number with an amount that is not one: invalid, linked to no contact
      `TM-${seq++},Priya Nair,${national},,Kochi,,AI Workshop,lots,05/10/2025,,`,
      // 6: someone she referred, naming her by number
      `TM-${seq++},Meera Das,${phone()},,,,AI Workshop,999,06/10/2025,,${national}`,
    ].join("\n");
    const batchId = await importOrders(csv, admin, { State: "state", "Alt Phone": "alt_phone", "Referred By": "referrer_phone" });
    expect(await resolveAllConflictsAsNew(batchId, admin)).toBe(1);
    await commitImport(batchId, admin);

    const rows = () => importRowsOf(batchId);
    const [skipped, merged, anils, conflict, invalid, referred] = await rows();
    // what the import left: her data on rows of hers that point at no contact, and quoted on other contacts' rows
    expect(skipped).toMatchObject({ matchResult: "skip", contactId: null, matchContactId: null, issues: [`Order ${order} is already recorded on Priya Nair`] });
    expect(JSON.stringify(skipped.raw)).toContain("priya@example.com");
    expect(merged).toMatchObject({ contactId: p.id, applied: { before: { state: null }, after: { state: "Kerala" } } });
    expect(anils.contactId).toBe(anil.id);
    expect(anils.issues).toContain(`${p.phoneE164} belongs to Priya Nair, so it was not added`);
    const candidates = (conflict.cleaned as StoredClean).match?.candidates ?? [];
    expect(candidates.map((x) => x.id)).toEqual([namesake.id, p.id]);
    expect(conflict).toMatchObject({ matchContactId: namesake.id, resolution: "create" });
    expect(conflict.contactId).not.toBeNull();
    expect(invalid).toMatchObject({ matchResult: "invalid", contactId: null, matchContactId: null });
    expect((invalid.cleaned as StoredClean).phone).toBe(p.phoneE164);
    expect(referred.applied).toMatchObject({ referrerId: p.id });
    expect(JSON.stringify(referred.raw)).toContain(national);

    await eraseContact(p.id, admin, "Asked by email");

    const after = await rows();
    const [skippedA, mergedA, anilsA, conflictA, invalidA, referredA] = after;
    // her own rows: wiped, keeping only what an undo needs (not the values it would put back)
    for (const r of [skippedA, mergedA, invalidA]) expect(r).toMatchObject({ raw: {}, mapped: null, cleaned: null, issues: [] });
    expect(mergedA.applied).toMatchObject({ contactId: p.id, purchaseId: (merged.applied as AppliedRow).purchaseId });
    expect(mergedA.applied).not.toHaveProperty("before");
    expect(mergedA.applied).not.toHaveProperty("after");
    // other contacts' rows stay whole, without what quoted her
    expect(anilsA).toMatchObject({ raw: anils.raw, cleaned: anils.cleaned, applied: anils.applied, contactId: anil.id });
    expect(anilsA.issues).toEqual(anils.issues.filter((i) => !i.includes(p.phoneE164)));
    expect((conflictA.cleaned as StoredClean).match?.candidates?.map((x) => x.id)).toEqual([namesake.id]);
    expect(conflictA).toMatchObject({ raw: conflict.raw, applied: conflict.applied, contactId: conflict.contactId });
    expect(referredA.raw).toEqual(Object.fromEntries(Object.entries(referred.raw).filter(([k]) => k !== "Referred By")));
    expect((referredA.cleaned as StoredClean).referrer).toBeNull();
    expect(referredA.mapped).not.toHaveProperty("referrer_phone");
    expect(referredA.applied).toEqual(referred.applied);
    // nothing in the import, nor on its review screen, ties her number or email to her any more; her number stays only
    // where the file gave it as Anil's other number (his row's own values, kept for him)
    const review = JSON.stringify(await listRows(batchId, admin, { pageSize: 200 }));
    expect(review).not.toMatch(/priya@example\.com|belongs to Priya Nair|recorded on Priya Nair/);
    const notAnils = JSON.stringify(after.map((r) => (r.id === anils.id ? { ...r, raw: null, mapped: null, cleaned: null } : r)));
    for (const hers of [national, "priya@example.com"]) expect(notAnils).not.toContain(hers);

    // the other contacts' rows still undo: Anil's purchase from this import goes, he stays as he was
    await undoImport(batchId, admin);
    expect((await getBatchView(batchId, admin))!.status).toBe("undone");
    expect(await db.select().from(purchases).where(eq(purchases.contactId, anil.id))).toHaveLength(0);
    expect((await db.select().from(contacts).where(eq(contacts.id, anil.id)))[0].altPhones).toEqual([]);
  });

  it("a same-name conflict where she was the first candidate stays the row of the person the file was about", async () => {
    const admin = await makeUser({ role: "admin" });
    await db.insert(products).values({ name: "AI Workshop", family: "workshop", rung: 1, listPrice: 999 });
    const p = await lead(null, "Priya Nair", { email: "priya@example.com", profile: { city: "Kochi" } });
    const header = "Order ID,Name,Phone,Email,City,Mango,Amount,Date";
    // another Priya Nair of Kochi, with her own number and email: a conflict with her as the only (so first)
    // candidate, so the row's matched contact; imported as a new contact (below)
    const done = await importOrders(`${header}\nTM-${seq++},Priya Nair,${phone()},pn.kochi@example.com,Kochi,AI Workshop,999,04/10/2025`, admin);
    // a third one, in a file still in review: she and a newer namesake are its candidates, nothing decided yet
    const namesake = await lead(null, "Priya Nair", { profile: { city: "Kochi" } });
    const third = phone();
    const pending = await importOrders(`${header}\nTM-${seq++},Priya Nair,${third},nair.p@example.com,Kochi,AI Workshop,999,05/10/2025`, admin);
    expect(await resolveAllConflictsAsNew(done, admin)).toBe(1);
    await commitImport(done, admin);
    const [created] = await importRowsOf(done);
    const [waiting] = await importRowsOf(pending);
    const y = created.contactId!;
    expect(created).toMatchObject({ matchResult: "conflict", matchContactId: p.id, resolution: "create" });
    expect(created.applied).toMatchObject({ contactId: y, createdContact: true });
    expect(y).not.toBe(p.id);
    expect((created.cleaned as StoredClean).match).toMatchObject({ candidates: [{ id: p.id }], contactName: "Priya Nair" });
    expect(waiting).toMatchObject({ matchResult: "conflict", matchContactId: p.id, resolution: null, contactId: null });
    expect((waiting.cleaned as StoredClean).match?.candidates?.map((c) => c.id)).toEqual([p.id, namesake.id]);

    await eraseContact(p.id, admin, "Asked by email");

    // both rows stay whole: only her entry as a candidate goes, with the name the conflict showed for her
    const withoutHer = (r: typeof created, keep: string[]) => {
      const clean = r.cleaned as StoredClean;
      const { contactName, ...match } = clean.match!;
      expect(contactName).toBe("Priya Nair");
      return { ...clean, match: { ...match, candidates: match.candidates!.filter((c) => keep.includes(c.id)) } };
    };
    const [createdA] = await importRowsOf(done);
    const [waitingA] = await importRowsOf(pending);
    expect(createdA).toMatchObject({ raw: created.raw, mapped: created.mapped, issues: created.issues, applied: created.applied, contactId: y });
    expect(createdA.cleaned).toEqual(withoutHer(created, []));
    expect(waitingA).toMatchObject({ raw: waiting.raw, mapped: waiting.mapped, issues: waiting.issues, resolution: null });
    expect(waitingA.cleaned).toEqual(withoutHer(waiting, [namesake.id]));
    for (const batchId of [done, pending]) {
      expect(JSON.stringify(await listRows(batchId, admin, { pageSize: 200 }))).not.toMatch(new RegExp(`priya@example\\.com|\\${p.phoneE164}`));
    }

    // the file still in review can be decided and imported
    expect(await resolveAllConflictsAsNew(pending, admin)).toBe(1);
    await commitImport(pending, admin);
    const [imported] = await importRowsOf(pending);
    expect(imported.applied).not.toHaveProperty("error");
    expect(imported.applied).toMatchObject({ createdContact: true });
    expect((await db.select().from(contacts).where(eq(contacts.id, imported.contactId!)))[0]).toMatchObject({ name: "Priya Nair", phoneE164: `+91${third}` });
    // and the first import still undoes: the contact it created goes
    await undoImport(done, admin);
    expect((await getBatchView(done, admin))!.status).toBe("undone");
    expect(await db.select().from(contacts).where(eq(contacts.id, y))).toHaveLength(0);
  });

  it("a row linked to no contact is hers by her number or order, by her email only when the import tied it to no one else", async () => {
    const admin = await makeUser({ role: "admin" });
    await db.insert(products).values({ name: "AI Workshop", family: "workshop", rung: 1, listPrice: 999 });
    // she and Anil share the family email (an edit gave it to him; emails are not unique); priya@example.com is hers
    const p = await lead(null, "Priya Nair", { email: "family@example.com" });
    await updateContactProfile(p.id, { altEmails: { add: ["priya@example.com"] } }, admin);
    const anil = await lead(null, "Anil Kumar");
    await updateContactProfile(anil.id, { email: "family@example.com" }, admin);
    const anilsOrder = `TM-${seq++}`;
    await recordPurchase(
      { contactId: anil.id, productName: "AI Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: anilsOrder, purchasedAt: new Date("2025-09-01T10:00:00Z") },
      null,
    );
    const his = anil.phoneE164.slice(3);
    const newcomer = phone();
    const csv = [
      "Order ID,Name,Phone,Email,City,Mango,Amount,Date",
      // 1: his order again: skipped, "already recorded on Anil Kumar", linked to no contact
      `${anilsOrder},Anil Kumar,${his},family@example.com,,AI Workshop,999,01/10/2025`,
      // 2: his order again, from a number the CRM does not know
      `${anilsOrder},Anil Kumar,${phone()},family@example.com,,AI Workshop,999,01/10/2025`,
      // 3: his number with an amount that is not one: invalid
      `TM-${seq++},Anil Kumar,${his},family@example.com,,AI Workshop,lots,02/10/2025`,
      // 4 and 5: someone new, then the same number with the family email: one new person (the file is in review)
      `TM-${seq++},Meera Das,${newcomer},,,AI Workshop,999,03/10/2025`,
      `TM-${seq++},Meera Das,${newcomer},family@example.com,,AI Workshop,999,04/10/2025`,
      // 6: her own email from a number the CRM does not know, with an amount that is not one: invalid, and hers
      `TM-${seq++},Priya Nair,${phone()},priya@example.com,,AI Workshop,lots,05/10/2025`,
    ].join("\n");
    const batchId = await importOrders(csv, admin);
    const before = await importRowsOf(batchId);
    expect(before.map((r) => [r.matchResult, r.contactId, r.matchContactId])).toEqual([
      ["skip", null, null],
      ["skip", null, null],
      ["invalid", null, null],
      ["new", null, null],
      ["merge", null, null],
      ["invalid", null, null],
    ]);
    expect(before[0].issues).toEqual([`Order ${anilsOrder} is already recorded on Anil Kumar`]);
    expect(before.map((r) => (r.cleaned as StoredClean).email)).toEqual([
      "family@example.com",
      "family@example.com",
      "family@example.com",
      null,
      "family@example.com",
      "priya@example.com",
    ]);

    await eraseContact(p.id, admin, "Asked by email");

    const after = await importRowsOf(batchId);
    // the import tied rows 1 to 5 to someone else (his order, his number, the new person's earlier row): untouched
    expect(after.slice(0, 5)).toEqual(before.slice(0, 5));
    expect(after[5]).toMatchObject({ raw: {}, mapped: null, cleaned: null, issues: [] });
  });

  it("a proof file that cannot be deleted goes to the error log, without its file name, and the erasure stands", async () => {
    const admin = await makeUser({ role: "admin" });
    const c = await lead(null, "Rahul Menon");
    const key = `${PROOF_FOLDER}/2026-11/0b6f3f3e-2f6a-4a51-9d0e-6b1f4f0c9a11-rahul-menon-receipt.png`;
    // a folder where the file should be: the store refuses to delete it
    const where = path.join(UPLOADS, key);
    await mkdir(where, { recursive: true });
    leftovers.push(where);
    await recordPurchase(
      { contactId: c.id, productName: "AAM", family: "applied_ai_mastery", amount: 3000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, proofUrl: `/api/files/${key}`, verified: true, purchasedAt: new Date() },
      admin,
    );
    expect(await canReadStoredFile(admin, key)).toBe(true);

    const r = await eraseContact(c.id, admin, "Asked on the phone");
    expect(r).toMatchObject({ proofKeys: [key], filesDeleted: 0, fileErrors: 1 });
    const errors = await db.select().from(appErrors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "server", source: "erasure", path: `/contacts/${c.id}`, userId: admin.id });
    expect(errors[0].message).toContain(`${PROOF_FOLDER}/2026-11/0b6f3f3e-2f6a-4a51-9d0e-6b1f4f0c9a11`);
    expect(`${errors[0].message} ${errors[0].stack ?? ""}`).not.toContain("rahul-menon");
    // the erasure stands and the file is unreachable already
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0].erasedAt).not.toBeNull();
    expect(await canReadStoredFile(admin, key)).toBe(false);
  });

  it("an erased contact is locked: every write that would add personal data is refused by the service", async () => {
    const admin = await makeUser({ role: "admin" });
    const manager = await makeUser({ role: "manager" });
    const sales = await makeUser({ role: "sales" });
    const other = await makeUser({ role: "sales" });
    const c = await lead(sales.id, "Priya Nair");
    const noteId = await addNote(c.id, "Lives in Kochi", sales);
    const partly = await recordPurchase(
      { contactId: c.id, productName: "AAM", family: "applied_ai_mastery", amount: 4000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, paidNow: { amount: 1000, reference: `UTR${seq++}` }, verified: true, purchasedAt: new Date() },
      admin,
    );
    const live = await lead(sales.id, "Priya Nair");
    const [org] = await db.insert(organisations).values({ name: "Acme Traders" }).returning();
    await eraseContact(c.id, admin, "Asked by email");
    const erasedRow = async () => (await db.select().from(contacts).where(eq(contacts.id, c.id)))[0];
    const before = await erasedRow();
    const counts = async () => ({
      interactions: (await db.select().from(interactions).where(eq(interactions.contactId, c.id))).length,
      ratings: (await db.select().from(ratings).where(eq(ratings.contactId, c.id))).length,
      purchases: (await db.select().from(purchases).where(eq(purchases.contactId, c.id))).length,
      payments: (await db.select().from(payments).where(eq(payments.contactId, c.id))).length,
      tasks: (await db.select().from(tasks).where(eq(tasks.contactId, c.id))).length,
      owners: (await db.select().from(ownershipLog).where(eq(ownershipLog.contactId, c.id))).length,
    });
    const countsBefore = await counts();
    const refused = async (p: Promise<unknown>) => {
      const e = await p.then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(ContactErasedError);
      expect((e as Error).message).toBe(ERASED_MESSAGE);
    };

    // profile, consent, organisation, notes, interactions, ratings, stage
    await refused(updateContactProfile(c.id, { name: "Priya Nair", email: "priya@example.com" }, admin));
    await refused(updateContactProfile(c.id, { altPhones: { add: ["+919847099999"] } }, admin));
    await refused(setConsent(c.id, true, admin));
    await refused(linkContactToOrganisation(c.id, org.id, admin));
    await refused(addNote(c.id, "Called back", admin));
    await refused(setPinned(noteId, true, admin));
    await refused(logInteraction(c.id, { type: "call", summary: "Spoke to Priya" }, admin));
    await refused(logInteraction(c.id, { type: "whatsapp", direction: "in", summary: "Hi", externalRef: `libromi:msg:x${seq++}` }, null));
    await refused(applyRating(c.id, { aiLevel: 3, notes: "Sharp" }, "sales", admin.id));
    await refused(applyRating(c.id, { aiLevel: 3 }, "self", null));
    await refused(setManualStage(c.id, "lost", { lostReason: "price" }, admin));
    await refused(reopenContact(c.id, admin));
    // owner: reassignment (one or in bulk), transfer requests, any owner change, merges either way
    await refused(reassignContacts([c.id], other.id, manager, "Move"));
    await expect(reassignContacts([live.id, c.id], other.id, manager, "Move")).rejects.toThrow(/erased\. Reload the list/);
    await refused(requestTransfer(c.id, other, "I know her"));
    await refused(setOwner(c.id, other.id, { reason: "Moved", changedById: manager.id }));
    await refused(mergeContacts(live.id, c.id, manager));
    await refused(mergeContacts(c.id, live.id, manager));
    // new money: a purchase, a part payment on a purchase it already has
    await refused(
      recordPurchase(
        { contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: `TM-${seq++}`, purchasedAt: new Date() },
        null,
      ),
    );
    await refused(addPayment(partly.purchaseId, { amount: 500, mode: "bank_transfer", reference: `UTR${seq++}`, verify: true }, admin));
    // tasks refuse with their own error; a living contact cannot take the erased one as referrer, by hand or on capture
    await expect(createManualTask({ title: "Call Priya", dueAt: new Date(), contactId: c.id }, admin)).rejects.toThrow(ERASED_MESSAGE);
    await expect(updateContactProfile(live.id, { referredById: c.id }, admin)).rejects.toThrow(/referrer's personal data was erased/);
    const referred = await captureEnquiry({ phone: phone(), name: "New Friend", channel: "phone_call", referrer: { contactId: c.id }, skipAlerts: true, skipAssignment: true });
    expect(referred.contact.referredById).toBeNull();

    // nothing changed on the erased contact
    expect(await erasedRow()).toEqual(before);
    expect(await counts()).toEqual(countsBefore);
    expect(await db.select().from(contactMerges)).toHaveLength(0);
  });

  it("system jobs leave an erased lead alone; a leaver's handover still moves it", async () => {
    const admin = await makeUser({ role: "admin" });
    const sales = await makeUser({ role: "sales" });
    const heir = await makeUser({ role: "sales" });
    const c = await lead(sales.id, "Old Lead");
    const stale = await lead(sales.id, "Stale Lead");
    await eraseContact(c.id, admin, "Asked by email");
    // use it or lose it (the 15-minute cron) skips an erased lead instead of failing on it
    expect(await releaseStaleLeads(new Date(Date.now() + 60 * 24 * H))).toEqual([stale.id]);
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0].ownerId).toBe(sales.id);
    // when someone leaves, their erased contacts move too (a fixed reason, no personal data)
    expect(await handoverAllContacts(sales.id, heir.id, admin)).toBe(1);
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0].ownerId).toBe(heir.id);
  });

  it("money already recorded on an erased contact stays workable: refunds, verification, cancelling, credit", async () => {
    const admin = await makeUser({ role: "admin" });
    const manager = await makeUser({ role: "manager" });
    const sales = await makeUser({ role: "sales" });
    const c = await lead(sales.id, "Priya Nair", { email: "priya@example.com" });
    const oldPhone = c.phoneE164;
    const paid = await recordPurchase(
      { contactId: c.id, productName: "AAM", family: "applied_ai_mastery", amount: 5000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, verified: true, purchasedAt: new Date() },
      admin,
    );
    const claimed = await recordPurchase(
      { contactId: c.id, productName: "AAM", family: "applied_ai_mastery", amount: 2000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, purchasedAt: new Date() },
      sales,
    );
    await rejectPayment(claimed.paymentIds[0], manager, "Not in the account yet");
    const wrong = await recordPurchase(
      { contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, purchasedAt: new Date() },
      sales,
    );
    await rejectPayment(wrong.paymentIds[0], manager, "Recorded on the wrong person");
    const order = `TM-${seq++}`;
    await recordPurchase(
      { contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: order, purchasedAt: new Date() },
      null,
    );
    await eraseContact(c.id, admin, "Asked by email");
    const ltv = async () => (await db.select().from(contacts).where(eq(contacts.id, c.id)))[0].ltvInr;
    expect(await ltv()).toBe(5999);

    await recordRefund(paid.purchaseId, { amount: 1000, reason: "Refund on request", reference: `RF-${seq++}` }, admin);
    expect(await ltv()).toBe(4999);
    // the manager changed their mind: the money did arrive
    await verifyPayment(claimed.paymentIds[0], manager);
    expect(await ltv()).toBe(6999);
    expect(await cancelPurchase(wrong.purchaseId, manager, "Duplicate entry")).toBe("cancelled");
    await adjustCredit(paid.purchaseId, sales.id, manager);
    expect((await db.select().from(purchases).where(eq(purchases.id, paid.purchaseId)))[0].creditedUserId).toBe(sales.id);

    // a TagMango refund still lands on the order, without the customer's own words, and its payload is not kept
    const refund = await ingestWebhook("tagmango", {
      orderId: order,
      status: "refunded",
      refundAmount: 999,
      refundId: "rf_erased",
      reason: "Priya could not attend",
      name: "Priya Nair",
      phone: oldPhone,
      email: "priya@example.com",
    });
    expect(refund).toMatchObject({ ok: true, contactId: c.id });
    const [tmRefund] = await db.select().from(payments).where(eq(payments.reference, `${order}:refund:rf_erased`));
    expect(tmRefund).toMatchObject({ kind: "refund", amount: 999, reason: "Refunded on TagMango", contactId: c.id });
    expect(await ltv()).toBe(6000);
    const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, refund.eventId!));
    expect(ev).toMatchObject({ payload: {}, contactId: c.id, error: null });
    expect(ev.processedAt).not.toBeNull();

    // a new order from the old number is a new person: a new contact, nothing added to the erased one
    const fresh = await ingestWebhook("tagmango", {
      orderId: `TM-${seq++}`,
      orderStatus: "completed",
      name: "Priya Nair",
      phone: oldPhone,
      amountPaid: 499,
      currency: "INR",
      mangoName: "Prompt Workshop",
    });
    expect(fresh.ok).toBe(true);
    expect(fresh.contactId).not.toBe(c.id);
    const [again] = await db.select().from(contacts).where(eq(contacts.id, fresh.contactId!));
    expect(again).toMatchObject({ phoneE164: oldPhone, name: "Priya Nair", erasedAt: null, ltvInr: 499 });
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0]).toMatchObject({ name: ERASED_NAME, email: null });
  });

  it("takes the person's name off what their referrer holds: the thank-you task and the new-lead alert", async () => {
    const admin = await makeUser({ role: "admin" });
    const manager = await makeUser({ role: "manager" });
    // the referrer's owner (auto-assigned: the only salesperson)
    const sales = await makeUser({ role: "sales" });
    // Priya names a referrer nobody had yet: a new contact, whose owner's "New lead" alert says who they referred
    const cap = await captureEnquiry({
      phone: phone(),
      name: "Priya Nair",
      channel: "phone_call",
      referrer: { phone: phone(), name: "Ravi Kumar" },
      skipAssignment: true,
    });
    const priya = cap.contact;
    const ravi = cap.referrerId!;
    expect(cap.referrerCreated).toBe(true);
    const raviAlerts = () => db.select().from(notifications).where(eq(notifications.contactId, ravi));
    expect((await raviAlerts()).map((n) => n.body)).toEqual(["Referred Priya Nair"]);
    // renamed later: the thank-you task quotes the new name, the alert still the old one
    await updateContactProfile(priya.id, { name: "Priya N" }, admin);
    await recordPurchase(
      { contactId: priya.id, productName: "AAM", family: "applied_ai_mastery", amount: 5000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, verified: true, purchasedAt: new Date() },
      admin,
    );
    const thank = async () => (await db.select().from(tasks).where(and(eq(tasks.contactId, ravi), eq(tasks.type, "new_advocate"))))[0];
    expect((await thank()).reason).toBe("Their referral Priya N just paid — call to thank");
    expect((await thank()).payload).toMatchObject({ referredName: "Priya N", referredContactId: priya.id });

    await eraseContact(priya.id, admin, "Asked by email");

    // the referrer keeps the task (still open, still on their owner's Today) and the alert, without her name
    const t = await thank();
    expect(t).toMatchObject({ reason: "Their referral just paid — call to thank", status: "open", userId: sales.id });
    expect(t.payload).toMatchObject({ referredContactId: priya.id });
    expect(t.payload).not.toHaveProperty("referredName");
    const [alert] = await raviAlerts();
    expect(alert).toMatchObject({ type: "new_lead", body: null });
    expect(alert.title).toMatch(/^New lead: /);
    const everything = JSON.stringify([await db.select().from(tasks), await db.select().from(notifications)]);
    expect(everything).not.toMatch(/Priya/);
    expect(JSON.stringify(await getTodayQueue(sales))).not.toMatch(/Priya/);

    // verifying an erased contact's old money (allowed, for the accounts) starts no thank-you call about her
    const asha = (await captureEnquiry({ phone: phone(), name: "Asha Menon", channel: "phone_call", referrer: { contactId: ravi }, skipAlerts: true, skipAssignment: true })).contact;
    const claim = await recordPurchase(
      { contactId: asha.id, productName: "AAM", family: "applied_ai_mastery", amount: 2000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, purchasedAt: new Date() },
      sales,
    );
    await rejectPayment(claim.paymentIds[0], manager, "Not in the account yet");
    await eraseContact(asha.id, admin, "Asked by phone");
    await verifyPayment(claim.paymentIds[0], manager);
    expect(await db.select().from(tasks).where(eq(tasks.dedupeKey, `new_advocate:${asha.id}`))).toHaveLength(0);
  });

  it("an erased contact's tasks stay closed: no reopening or editing them; done and cancel still close one", async () => {
    const admin = await makeUser({ role: "admin" });
    const sales = await makeUser({ role: "sales" });
    const c = await lead(sales.id, "Priya Nair");
    const taskId = await createManualTask({ title: "Call Priya", notes: "After 6 pm", dueAt: new Date(Date.now() + H), contactId: c.id }, sales);
    await eraseContact(c.id, admin, "Asked by email");
    const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
    const closed = await row(taskId);
    expect(closed).toMatchObject({ status: "dismissed", reason: ERASED_NAME, payload: null });

    // reopening it, or editing it (which needs it open), would put free text back on the erased contact
    for (const who of [sales, admin]) {
      await expect(setTaskStatus(taskId, "open", who)).rejects.toThrow(ERASED_MESSAGE);
      await expect(updateTask(taskId, { title: "Call Priya Nair on 9847012345", notes: "She lives in Kochi" }, who)).rejects.toThrow(ERASED_MESSAGE);
    }
    await expect(updateTask(taskId, { dueAt: new Date(Date.now() + 2 * H) }, sales)).rejects.toBeInstanceOf(TaskError);
    expect(await row(taskId)).toEqual(closed);
    // and the task list offers no Reopen for it
    const done = await listTasks(sales, "done");
    expect(done.rows.find((r) => r.id === taskId)?.contact).toMatchObject({ id: c.id, erased: true });

    // a task still open on it (a system alert raised after the erasure) can be finished or cancelled, not edited
    const follow = (await createTask({ contactId: c.id, userId: sales.id, type: "follow_up", reason: "Follow-up due", dueAt: new Date() }))!;
    const manual = (await createTask({ contactId: c.id, userId: sales.id, type: "task", reason: "Check in", dueAt: new Date() }))!;
    await expect(updateTask(manual, { title: "Ask Priya about Kochi" }, sales)).rejects.toThrow(ERASED_MESSAGE);
    await expect(updateTask(follow, { dueAt: new Date(Date.now() + 2 * H) }, sales)).rejects.toThrow(ERASED_MESSAGE);
    expect(await setTaskStatus(follow, "done", sales)).toBe(true);
    expect(await setTaskStatus(manual, "cancel", sales)).toBe(true);
    expect((await row(follow)).status).toBe("done");
    expect(await row(manual)).toMatchObject({ status: "dismissed", reason: "Check in" });
    await expect(setTaskStatus(follow, "open", sales)).rejects.toThrow(ERASED_MESSAGE);
  });

  it("a purchase or task racing an erasure waits for it and is then refused: nothing lands on the erased contact", async () => {
    const admin = await makeUser({ role: "admin" });
    const c = await lead(null, "Priya Nair");
    // the erasure has locked the contact and cleared it, but not committed yet
    let erased!: () => void;
    const erasedP = new Promise<void>((r) => (erased = r));
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    const erasure = db.transaction(async (t) => {
      await eraseContact(c.id, admin, "Asked by email", {}, t);
      erased();
      await gate;
    });
    await erasedP;
    // a TagMango order (with the customer's details) and a task for the same contact arrive meanwhile
    const order = `TM-${seq++}`;
    const buy = settle(
      recordPurchase(
        { contactId: c.id, productName: "Workshop", family: "workshop", amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: order, rawPayload: { name: "Priya Nair", phone: c.phoneE164 }, notes: "Priya's second order", purchasedAt: new Date() },
        null,
      ),
    );
    const task = settle(createManualTask({ title: "Call Priya Nair", dueAt: new Date(Date.now() + H), contactId: c.id }, admin));
    await waitForLockWaiters(2);
    commit();
    await erasure;

    expect(await buy).toBeInstanceOf(ContactErasedError);
    const taskError = await task;
    expect(taskError).toBeInstanceOf(TaskError);
    expect((taskError as Error).message).toBe(ERASED_MESSAGE);
    expect(await db.select().from(purchases).where(eq(purchases.reference, order))).toHaveLength(0);
    expect(await db.select().from(tasks).where(eq(tasks.contactId, c.id))).toHaveLength(0);
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0]).toMatchObject({ name: ERASED_NAME, ltvInr: 0 });
  });

  it("an alert rule that read a lead just before its erasure committed takes back what it raised, in the same run", async () => {
    const admin = await makeUser({ role: "admin" });
    const sales = await makeUser({ role: "sales" });
    await makeUser({ role: "manager" });
    const c = await lead(sales.id, "Priya Nair");
    await db.update(contacts).set({ ownerAssignedAt: new Date(Date.now() - 50 * H) }).where(eq(contacts.id, c.id));
    // the erasure has locked the contact and cleared it, but not committed yet
    let erased!: () => void;
    const erasedP = new Promise<void>((r) => (erased = r));
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    const erasure = db.transaction(async (t) => {
      await eraseContact(c.id, admin, "Asked by email", {}, t);
      erased();
      await gate;
    });
    await erasedP;
    // the 15-minute run reads the lead as it was, then waits to write its task and alerts
    const run = untouchedLeads(new Date());
    await waitForLockWaiters(1);
    commit();
    await erasure;
    expect(await run).toMatchObject({ ownerAlerts: 1, managerAlerts: 1 });
    // ... and closes them once they land on the erased contact: no open task, no alert with her name
    expect(await db.select().from(tasks).where(and(eq(tasks.contactId, c.id), eq(tasks.status, "open")))).toHaveLength(0);
    expect(await db.select().from(notifications).where(eq(notifications.contactId, c.id))).toHaveLength(0);
    expect(JSON.stringify(await db.select().from(tasks).where(eq(tasks.contactId, c.id)))).not.toContain("Priya");
  });

  it("an erased lead or customer leaves Today and the digests", async () => {
    const admin = await makeUser({ role: "admin" });
    const sales = await makeUser({ role: "sales" });
    // assigned just now: a "new lead" row on her owner's Today and in the daily digest
    const c = await lead(sales.id, "Priya Nair");
    const vip = await lead(sales.id, "Ravi Menon");
    const now = new Date(Date.now() + 1000);
    expect((await getTodayQueue(sales, now)).rows.map((r) => r.contact?.id)).toContain(c.id);
    await eraseContact(c.id, admin, "Asked by email");
    await eraseContact(vip.id, admin, "Asked by email");
    // a grade A customer gone quiet, as its money (which stays) can keep it
    await db
      .update(contacts)
      .set({ grade: "A", purchaseCount: 3, ltvInr: 120000, stage: "repeat", lastActivityAt: new Date(now.getTime() - 200 * 24 * H) })
      .where(eq(contacts.id, vip.id));
    // and a task left open on her (raised while the erasure was committing)
    await createTask({ contactId: c.id, userId: sales.id, type: "follow_up", reason: "Follow-up due", dueAt: new Date(now.getTime() - 60_000) });

    const queue = await getTodayQueue(sales, now);
    expect(queue.rows.map((r) => r.contact?.id)).toEqual([]);
    expect((await getTeamQueues(admin, now)).flatMap((g) => g.queue.rows.map((r) => r.contact?.id))).toEqual([]);
    const daily = await buildDailyDigest(sales, now);
    expect(daily.newLeads).toEqual({ count: 0, items: [] });
    expect(daily.today.total).toBe(0);
    const weekly = await buildWeeklySummary(now);
    expect(weekly.vipQuiet).toMatchObject({ count: 0, items: [] });
  });

  it("an erased contact leaves its organisation's people and their count; it cannot be unlinked, and no screen offers it", async () => {
    const admin = await makeUser({ role: "admin" });
    const sales = await makeUser({ role: "sales" });
    const other = await makeUser({ role: "sales" });
    const [org] = await db.insert(organisations).values({ name: "Acme Traders" }).returning();
    const kept = await lead(sales.id, "Anil Kumar");
    const gone = await lead(sales.id, "Priya Nair");
    for (const c of [kept, gone]) await linkContactToOrganisation(c.id, org.id, admin);
    expect((await getOrganisationPeople(admin, org.id)).people).toHaveLength(2);
    expect(await getOrganisationPeople(other, org.id)).toEqual({ people: [], hidden: 2 });

    await eraseContact(gone.id, admin, "Asked by email");
    expect((await getOrganisationPeople(admin, org.id)).people.map((p) => p.id)).toEqual([kept.id]);
    expect((await getOrganisationPeople(sales, org.id)).people.map((p) => p.id)).toEqual([kept.id]);
    expect(await getOrganisationPeople(other, org.id)).toEqual({ people: [], hidden: 1 });
    expect((await listOrganisations(admin)).rows.find((o) => o.id === org.id)?.people).toBe(1);
    // the link stays (the erasure lock refuses any change to the contact, unlinking too)
    await expect(linkContactToOrganisation(gone.id, null, admin)).rejects.toThrow(ERASED_MESSAGE);
    expect((await db.select().from(contacts).where(eq(contacts.id, gone.id)))[0].organisationId).toBe(org.id);
  });

  it("an undone merge keeps nothing of the erased person in the other contact's history, which keeps its own", async () => {
    const admin = await makeUser({ role: "admin" });
    const anil = await lead(null, "Anil Kumar");
    const p = await lead(null, "Priya Nair", { email: "priya@example.com" });
    const extra = `+91${phone()}`;
    const mergeId = await mergeContacts(anil.id, p.id, admin, "Same family");
    // while merged, an edit of Anil's numbers records hers in his history
    await updateContactProfile(anil.id, { altPhones: { add: [extra] } }, admin);
    await undoMerge(mergeId, admin);
    const timeline = async (id: string) => (await getContactTimeline(id)).items;
    const mergedItem = async () => (await timeline(anil.id)).find((i) => i.kind === "merge" && i.action === "merge");
    expect(await mergedItem()).toMatchObject({ otherName: "Priya Nair", otherPhone: p.phoneE164 });
    // the reverse: she was the winner of a merge since undone (that entry is in her own history)
    const ravi = await lead(null, "Ravi Menon");
    await undoMerge(await mergeContacts(p.id, ravi.id, admin), admin);

    await eraseContact(p.id, admin, "Asked by email");
    // "Merged a duplicate record into this contact": no name, no number
    expect(await mergedItem()).toMatchObject({ otherName: null, otherPhone: null });
    const history = async (id: string) => db.select().from(auditLog).where(and(eq(auditLog.tableName, "contacts"), eq(auditLog.rowId, id)));
    const anils = await history(anil.id);
    expect(JSON.stringify(anils)).not.toMatch(/Priya|priya@example\.com/);
    expect(JSON.stringify(anils)).not.toContain(p.phoneE164);
    // his own entries stay: the merge (by id) and the number he was given
    expect(anils.find((a) => a.action === "merge")?.oldValue).toEqual({ loserId: p.id });
    expect(anils.find((a) => a.field === "altPhones")).toMatchObject({ oldValue: [], newValue: [extra] });
    expect(JSON.stringify([await timeline(ravi.id), await history(ravi.id)])).not.toMatch(/Priya/);
    expect((await history(p.id)).every((a) => a.action === "erase" || (a.oldValue === null && a.newValue === null))).toBe(true);
  });

  it("an undone merge: the other contact keeps its own numbers and emails in its history, even ones she shares", async () => {
    const admin = await makeUser({ role: "admin" });
    // she has the family email and old@example.com; emails are not unique, and Anil had both at some point
    const p = await lead(null, "Priya Nair", { email: "family@example.com" });
    await updateContactProfile(p.id, { altEmails: { add: ["old@example.com"] } }, admin);
    const anil = await lead(null, "Anil Kumar");
    const emailsOf = (id: string) => and(eq(auditLog.tableName, "contacts"), eq(auditLog.rowId, id), eq(auditLog.field, "email"));
    // long before the merge: his email was old@example.com, then the family email
    await updateContactProfile(anil.id, { email: "old@example.com" }, admin);
    await updateContactProfile(anil.id, { email: "family@example.com" }, admin);
    await db.update(auditLog).set({ changedAt: new Date(Date.now() - 30 * 24 * H) }).where(emailsOf(anil.id));
    // merged by mistake ("same email"): while merged his email changes, and after the undo it changes back
    const mergeId = await mergeContacts(anil.id, p.id, admin, "Same email");
    await updateContactProfile(anil.id, { email: "anil@example.com" }, admin);
    await undoMerge(mergeId, admin);
    await updateContactProfile(anil.id, { email: "family@example.com" }, admin);
    const history = async () =>
      (await db.select().from(auditLog).where(emailsOf(anil.id)).orderBy(auditLog.id)).map((a) => [a.oldValue, a.newValue]);
    const his = await history();
    expect(his).toEqual([
      [null, "old@example.com"],
      ["old@example.com", "family@example.com"],
      ["family@example.com", "anil@example.com"],
      ["anil@example.com", "family@example.com"],
    ]);

    await eraseContact(p.id, admin, "Asked by email");
    // before the merge: his own history, not hers; while merged: the family email is still his own
    expect(await history()).toEqual(his);
    expect((await db.select().from(contacts).where(eq(contacts.id, anil.id)))[0].email).toBe("family@example.com");
  });

  it("the proof of a payment that was not saved leaves file storage; a proof a payment holds stays", async () => {
    const admin = await makeUser({ role: "admin" });
    const c = await lead(null, "Priya Nair");
    const live = await lead(null, "Rahul Menon");
    await eraseContact(c.id, admin, "Asked by email");
    // stored with the form, then refused by the service (the contact was erased meanwhile): nothing points at it
    const orphan = await proofFile("priya-nair-gpay.png");
    await expect(
      recordPurchase(
        { contactId: c.id, productName: "AAM", family: "applied_ai_mastery", amount: 3000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, proofUrl: orphan, purchasedAt: new Date() },
        admin,
      ),
    ).rejects.toBeInstanceOf(ContactErasedError);
    await discardUnsavedProof(orphan, { path: `/contacts/${c.id}/payment`, userId: admin.id });
    expect(onDisk(orphan)).toBe(false);

    // a proof a payment does hold is never deleted this way
    const kept = await proofFile("rahul-receipt.png");
    await recordPurchase(
      { contactId: live.id, productName: "AAM", family: "applied_ai_mastery", amount: 3000, currency: "INR", mode: "bank_transfer", source: "manual", reference: `UTR${seq++}`, proofUrl: kept, verified: true, purchasedAt: new Date() },
      admin,
    );
    await discardUnsavedProof(kept, { path: `/contacts/${live.id}/payment`, userId: admin.id });
    expect(onDisk(kept)).toBe(true);

    // one that cannot be deleted goes to the error log, named without its file name
    const key = `${PROOF_FOLDER}/2026-11/5d1c7a52-8f0e-4c1b-9a63-2f4b7e9d0c18-priya-nair-upi.png`;
    const where = path.join(UPLOADS, key);
    await mkdir(where, { recursive: true });
    leftovers.push(where);
    await discardUnsavedProof(`/api/files/${key}`, { path: `/contacts/${c.id}/payment`, userId: admin.id });
    const errors = await db.select().from(appErrors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "server", source: "payments", path: `/contacts/${c.id}/payment`, userId: admin.id });
    expect(errors[0].message).toContain(`${PROOF_FOLDER}/2026-11/5d1c7a52-8f0e-4c1b-9a63-2f4b7e9d0c18`);
    expect(`${errors[0].message} ${errors[0].stack ?? ""}`).not.toContain("priya-nair");
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
