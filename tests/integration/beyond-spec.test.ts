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
  purchases,
  ratings,
  tasks,
  webhookEvents,
} from "@/db/schema";
import { getActivityFeed } from "@/lib/activity/feed";
import { createTask } from "@/lib/alerts/core";
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
import { listContacts, parseContactFilters } from "@/lib/contacts/queries";
import { addPayment, adjustCredit, cancelPurchase, recordPurchase, recordRefund, rejectPayment, verifyPayment } from "@/lib/money";
import { PROOF_FOLDER, canReadStoredFile, discardUnsavedProof, saveFile, storedKeyFromUrl } from "@/lib/storage";
import { ingestWebhook } from "@/lib/webhooks/handlers";
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
    // an owner change with a typed reason, and an import row that remembers her old and new email
    await reassignContacts([c.id], other.id, manager, "Priya prefers Hindi");
    const [batch] = await db.insert(importBatches).values({ fileName: "leads.csv", source: "other" }).returning();
    await db.insert(importRows).values({
      batchId: batch.id,
      rowNumber: 1,
      raw: { Name: "Priya Nair" },
      contactId: c.id,
      issues: [`${c.phoneE164} belongs to Priya Nair, so it was not added`],
      applied: { contactId: c.id, enquiryId: null, before: { email: "priya@old.example" }, after: { email: "priya@new.example" } },
    });

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
    // the import row keeps what an undo needs, not the values it would put back
    const [row] = await db.select().from(importRows).where(eq(importRows.batchId, batch.id));
    expect(row).toMatchObject({ raw: {}, issues: [], applied: { contactId: c.id, enquiryId: null } });
    expect(row.applied).not.toHaveProperty("before");
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
