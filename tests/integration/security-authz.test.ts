/**
 * Authorization of every server action that takes an id, called the way an attacker would: directly, with
 * someone else's id (IDOR), as each role. The session is mocked; everything else (actions, services, database)
 * is real. Spec roles table: sales see own + pool only; support only logs, never owns or edits; manager reassigns
 * and verifies; admin alone runs settings, imports and exports.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  contacts,
  duplicateReviews,
  importBatches,
  interactions,
  notifications,
  payments,
  purchases,
  savedViews,
  tasks,
  users,
  type Role,
} from "@/db/schema";
import { makeUser, resetDb } from "../support/db";

type U = { id: string; name: string; email: string; role: Role; team: string | null; timezone: string; active: boolean };
const session = vi.hoisted(() => ({ user: null as null | U }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
// the one-time toast message a redirecting action leaves in a cookie (no request scope here)
const flash = vi.hoisted(() => vi.fn(async (_message: string) => {}));
vi.mock("@/lib/flash", () => ({ flash }));
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

const contactActions = await import("@/app/(app)/contacts/[id]/actions");
const editActions = await import("@/app/(app)/contacts/[id]/edit/actions");
const { logInteractionAction } = await import("@/app/(app)/contacts/[id]/log/actions");
const { rateContactAction } = await import("@/app/(app)/contacts/[id]/rate/actions");
const { recordPaymentAction } = await import("@/app/(app)/contacts/[id]/payment/actions");
const listActions = await import("@/app/(app)/contacts/actions");
const dupActions = await import("@/app/(app)/duplicates/actions");
const notificationActions = await import("@/app/(app)/notifications/actions");
const orgActions = await import("@/app/(app)/organisations/actions");
const paymentActions = await import("@/app/(app)/payments/actions");
const todayActions = await import("@/app/(app)/today/actions");
const importActions = await import("@/app/(app)/import/actions");
const userActions = await import("@/app/(app)/settings/users/actions");
const listSettingsActions = await import("@/app/(app)/settings/lists/actions");
const integrationActions = await import("@/app/(app)/settings/integrations/actions");
const { runAlertsNowAction } = await import("@/lib/alerts/actions");
const exportContacts = await import("@/app/api/export/contacts/route");
const invalidRows = await import("@/app/(app)/import/[batchId]/invalid-rows/route");

function form(values: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

/** Runs an action; a redirect (success path) is returned as { redirect }. */
async function run<T>(fn: () => Promise<T>): Promise<T | { redirect: string }> {
  try {
    return await fn();
  } catch (e) {
    const m = /^NEXT_REDIRECT:(.*)$/.exec((e as Error).message);
    if (m) return { redirect: m[1] };
    throw e;
  }
}

function denied(r: unknown) {
  expect(r).toMatchObject({ ok: false });
}

let seq = 0;
async function contact(ownerId: string | null, over: Partial<typeof contacts.$inferInsert> = {}) {
  seq += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9198470${String(10000 + seq).padStart(5, "0")}`, name: `Person ${seq}`, firstDoor: "youtube", ownerId, ...over })
    .returning();
  return c;
}
async function purchaseFor(contactId: string) {
  const [p] = await db
    .insert(purchases)
    .values({ contactId, productName: "AI Workshop", family: "workshop", amount: 999, amountInr: 999, mode: "bank_transfer", status: "pending" })
    .returning();
  const [pay] = await db
    .insert(payments)
    .values({ purchaseId: p.id, contactId, amount: 999, amountInr: 999, status: "unverified", mode: "bank_transfer", reference: `UTR${seq}${Date.now()}` })
    .returning();
  return { purchase: p, payment: pay };
}

let admin: U, manager: U, s1: U, s2: U, support: U;
let theirs: Awaited<ReturnType<typeof contact>>;

describe("server actions refuse other people's ids and the wrong roles", () => {
  beforeEach(async () => {
    await resetDb();
    admin = (await makeUser({ role: "admin" })) as U;
    manager = (await makeUser({ role: "manager" })) as U;
    s1 = (await makeUser({ role: "sales" })) as U;
    s2 = (await makeUser({ role: "sales" })) as U;
    support = (await makeUser({ role: "support", team: null })) as U;
    theirs = await contact(s2.id, { stage: "contacted" });
    session.user = s1;
  });

  it("contact page actions: a salesperson cannot touch a colleague's contact; support cannot edit or own", async () => {
    session.user = s1;
    denied(await run(() => contactActions.setStageAction(null, form({ contactId: theirs.id, stage: "qualified" }))));
    denied(await run(() => contactActions.reassignAction(null, form({ contactId: theirs.id, toUserId: s1.id, reason: "mine now" }))));
    denied(await run(() => contactActions.mergeAction(null, form({ winnerId: theirs.id, loserId: (theirs.id) }))));
    denied(await run(() => contactActions.undoMergeAction(null, form({ mergeId: theirs.id, contactId: theirs.id }))));
    const lost = await contact(s2.id, { stage: "lost", lostReason: "price" });
    denied(await run(() => contactActions.reopenAction(null, form({ contactId: lost.id }))));

    session.user = support;
    denied(await run(() => contactActions.setStageAction(null, form({ contactId: theirs.id, stage: "lost", lostReason: "price" }))));
    denied(await run(() => contactActions.reassignAction(null, form({ contactId: theirs.id, toUserId: support.id, reason: "x" }))));
    denied(await run(() => contactActions.requestTransferAction(null, form({ contactId: theirs.id, reason: "please" }))));

    const [after] = await db.select().from(contacts).where(eq(contacts.id, theirs.id));
    expect(after.ownerId).toBe(s2.id);
    expect(after.stage).toBe("contacted");
    const [lostAfter] = await db.select().from(contacts).where(eq(contacts.id, lost.id));
    expect(lostAfter.stage).toBe("lost");
  });

  it("profile edits: only the owner (or pool), a manager or admin; never support", async () => {
    for (const u of [s1, support]) {
      session.user = u;
      denied(await run(() => editActions.updateProfileAction(null, form({ contactId: theirs.id, name: "Hacked", phone: theirs.phoneE164 }))));
      denied(await run(() => editActions.alternateAction(null, form({ contactId: theirs.id, kind: "phone", op: "add", value: "+919847099999" }))));
      denied(await run(() => editActions.referrerAction(null, form({ contactId: theirs.id, clear: "1" }))));
    }
    const [after] = await db.select().from(contacts).where(eq(contacts.id, theirs.id));
    expect(after.name).toBe(theirs.name);
    expect(after.altPhones).toEqual([]);
  });

  it("log and rate: sales only on own + pool; support logs anywhere without becoming owner, but never rates", async () => {
    session.user = s1;
    denied(await run(() => logInteractionAction(theirs.id, null, form({ type: "call", direction: "out", summary: "x" }))));
    denied(await run(() => rateContactAction(theirs.id, null, form({ aiLevel: "3" }))));
    expect(await db.select().from(interactions).where(eq(interactions.contactId, theirs.id))).toHaveLength(0);

    session.user = support;
    denied(await run(() => rateContactAction(theirs.id, null, form({ aiLevel: "3" }))));
    const pool = await contact(null);
    for (const c of [theirs, pool]) {
      const r = await run(() => logInteractionAction(c.id, null, form({ type: "support_issue", direction: "in", summary: "asked for the recording" })));
      expect(r).toMatchObject({ redirect: `/contacts/${c.id}` });
      expect(flash).toHaveBeenLastCalledWith("Support issue logged.");
      const [after] = await db.select().from(contacts).where(eq(contacts.id, c.id));
      expect(after.ownerId).toBe(c.ownerId);
    }
  });

  it("money: no recording on a colleague's contact, no verify / refund / credit for sales, nothing for support", async () => {
    const { purchase, payment } = await purchaseFor(theirs.id);
    session.user = s1;
    denied(await run(() => recordPaymentAction(theirs.id, null, form({ productId: "other", productName: "X", family: "workshop", amount: "100", mode: "cash" }))));
    denied(await run(() => paymentActions.addPaymentAction(null, form({ purchaseId: purchase.id, amount: "10", mode: "cash", paidDate: "2026-10-01" }))));
    denied(await run(() => paymentActions.recordInstalmentAction(null, form({ paymentId: payment.id, mode: "cash", paidDate: "2026-10-01" }))));
    denied(await run(() => paymentActions.cancelPurchaseAction(null, form({ purchaseId: purchase.id, reason: "oops" }))));
    denied(await run(() => paymentActions.verifyPaymentAction(null, form({ paymentId: payment.id }))));
    denied(await run(() => paymentActions.rejectPaymentAction(null, form({ paymentId: payment.id, reason: "no" }))));
    denied(await run(() => paymentActions.recordRefundAction(null, form({ purchaseId: purchase.id, amount: "1", reason: "r", refundDate: "2026-10-01" }))));
    denied(await run(() => paymentActions.adjustCreditAction(null, form({ purchaseId: purchase.id, creditedUserId: s1.id }))));

    session.user = support;
    denied(await run(() => recordPaymentAction(theirs.id, null, form({ productId: "other", productName: "X", family: "workshop", amount: "100", mode: "cash" }))));
    denied(await run(() => paymentActions.verifyPaymentAction(null, form({ paymentId: payment.id }))));

    const [p] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
    expect(p.status).toBe("pending");
    expect(p.creditedUserId).toBeNull();
    const [pay] = await db.select().from(payments).where(eq(payments.id, payment.id));
    expect(pay.status).toBe("unverified");
    expect(await db.select().from(purchases).where(eq(purchases.contactId, theirs.id))).toHaveLength(1);
  });

  it("tasks, notifications and saved views belong to their user", async () => {
    const [task] = await db.insert(tasks).values({ contactId: theirs.id, userId: s2.id, type: "follow_up", reason: "call back" }).returning();
    const [note] = await db.insert(notifications).values({ userId: s2.id, type: "contacts_assigned", title: "A contact was assigned to you" }).returning();
    const [view] = await db.insert(savedViews).values({ userId: s2.id, name: "Mine", query: "grade=A" }).returning();

    session.user = s1;
    denied(await run(() => todayActions.queueTaskAction(null, form({ action: "done", taskId: task.id }))));
    denied(await run(() => todayActions.transferDecisionAction(null, form({ taskId: task.id, decision: "approve" }))));
    await run(() => notificationActions.markReadAction(form({ id: note.id })));
    const opened = await run(() => notificationActions.openNotificationAction(form({ id: note.id })));
    expect(opened).toEqual({ redirect: "/notifications" });
    denied(await run(() => listActions.deleteViewAction(null, form({ viewId: view.id }))));
    denied(await run(() => listActions.saveViewAction(null, form({ name: "Everyone", query: "grade=A", shared: "on" }))));
    denied(await run(() => listActions.bulkReassignAction(null, form({ ids: theirs.id, toUserId: s1.id, reason: "x" }))));

    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0].status).toBe("open");
    expect((await db.select().from(notifications).where(eq(notifications.id, note.id)))[0].readAt).toBeNull();
    expect(await db.select().from(savedViews).where(eq(savedViews.id, view.id))).toHaveLength(1);
    expect(await db.select().from(savedViews).where(eq(savedViews.shared, true))).toHaveLength(0);
  });

  it("merges and duplicate reviews are manager / admin only", async () => {
    const other = await contact(null, { name: theirs.name });
    const [review] = await db.insert(duplicateReviews).values({ contactAId: theirs.id, contactBId: other.id, reason: "same name, same city" }).returning();
    for (const u of [s1, support]) {
      session.user = u;
      denied(await run(() => dupActions.mergePairAction(null, form({ winnerId: theirs.id, loserId: other.id }))));
      denied(await run(() => dupActions.dismissPairAction(null, form({ reviewId: review.id }))));
    }
    expect((await db.select().from(duplicateReviews).where(eq(duplicateReviews.id, review.id)))[0].status).toBe("open");
    expect((await db.select().from(contacts).where(eq(contacts.id, other.id)))[0].mergedIntoId).toBeNull();
  });

  it("organisations: support cannot add or edit", async () => {
    session.user = support;
    denied(await run(() => orgActions.createOrganisationAction(null, form({ name: "Evil school" }))));
  });

  it("imports, settings, users and alerts are admin only (a manager is refused)", async () => {
    const [batch] = await db.insert(importBatches).values({ fileName: "old.csv", source: "other", uploadedById: admin.id }).returning();
    session.user = manager;
    denied(await run(() => importActions.discardBatchAction(null, form({ batchId: batch.id }))));
    denied(await run(() => importActions.startCommitAction(batch.id)));
    denied(await run(() => importActions.startUndoAction(batch.id)));
    denied(await run(() => importActions.runImportPhaseAction(batch.id, "commit")));
    denied(await run(() => userActions.createUserAction(null, form({ name: "Mallory", email: "m@evil.test", role: "admin", team: "kerala" }))));
    denied(await run(() => userActions.updateUserAction(null, form({ id: manager.id, name: manager.name, email: manager.email, role: "admin", team: "kerala" }))));
    denied(await run(() => userActions.resetPasswordAction(null, form({ id: admin.id }))));
    denied(await run(() => userActions.deactivateUserAction(null, form({ id: admin.id, confirm: "on" }))));
    denied(await run(() => listSettingsActions.saveListAction(null, form({ key: "lists.tags", json: "[]" }))));
    denied(await run(() => integrationActions.reprocessEventAction(null, form({ eventId: batch.id }))));
    denied(await run(() => runAlertsNowAction()));

    expect(await db.select().from(importBatches).where(eq(importBatches.id, batch.id))).toHaveLength(1);
    expect((await db.select().from(users).where(eq(users.id, manager.id)))[0].role).toBe("manager");
    expect(await db.select().from(users).where(eq(users.email, "m@evil.test"))).toHaveLength(0);
  });

  it("exports and invalid-row downloads are admin only, and a refused attempt is logged", async () => {
    session.user = manager;
    const req = new Request("http://localhost/api/export/contacts") as unknown as Parameters<typeof exportContacts.GET>[0];
    Object.defineProperty(req, "nextUrl", { value: new URL("http://localhost/api/export/contacts") });
    const res = await exportContacts.GET(req);
    expect(res.status).toBe(403);
    const [batch] = await db.insert(importBatches).values({ fileName: "old.csv", source: "other" }).returning();
    const res2 = await invalidRows.GET(new Request("http://localhost/x"), { params: Promise.resolve({ batchId: batch.id }) });
    expect(res2.status).toBe(403);
    const denials = await db.select().from(auditLog).where(and(eq(auditLog.action, "export_denied"), eq(auditLog.userId, manager.id)));
    expect(denials.length).toBe(2);
  });
});
