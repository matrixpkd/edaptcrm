import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  auditLog,
  contacts,
  duplicateReviews,
  enquiries,
  importBatches,
  importRows,
  ownershipLog,
  payments,
  products,
  purchases,
  type Contact,
} from "@/db/schema";
import { captureEnquiry } from "@/lib/contacts/capture";
import { logInteraction } from "@/lib/contacts/interactions";
import {
  changeSheet,
  createImportBatch,
  getBatchView,
  invalidRowsCsv,
  listRows,
  resolveAllConflictsAsNew,
  resolveConflict,
  runCleanChunk,
  saveMapping,
  setRowsSkipped,
  uniqueCustomerCount,
  type MappingInput,
} from "@/lib/import/batches";
import { runCommitChunk, startCommit } from "@/lib/import/commit";
import { runMatchChunk } from "@/lib/import/match";
import type { AppliedRow, BatchCounts, ImportSource, StoredClean } from "@/lib/import/types";
import { runUndoChunk, startUndo } from "@/lib/import/undo";
import { makeUser, resetDb } from "../support/db";

const FIX = path.join(process.cwd(), "tests/fixtures/import");
type User = Awaited<ReturnType<typeof makeUser>>;

beforeAll(() => {
  // the tests must never reach the network: Claude is replaced by the heuristics
  delete process.env.ANTHROPIC_API_KEY;
});

/** Uploaded files land in ./uploads (dev storage): remove the ones these tests wrote. */
const stored: string[] = [];
afterAll(() => {
  for (const url of stored) rmSync(path.join(process.cwd(), "uploads", url.replace(/^\/api\/files\//, "")), { force: true });
});

async function remember(batchId: string) {
  const [b] = await db.select({ fileUrl: importBatches.fileUrl }).from(importBatches).where(eq(importBatches.id, batchId));
  if (b?.fileUrl) stored.push(b.fileUrl);
  return batchId;
}

async function uploadFile(file: string, source: ImportSource, admin: User) {
  const bytes = new Uint8Array(readFileSync(path.join(FIX, file)));
  return remember(await createImportBatch({ fileName: file, fileType: "", bytes, source }, admin));
}

async function uploadText(name: string, text: string, source: ImportSource, admin: User) {
  return remember(await createImportBatch({ fileName: name, fileType: "text/csv", bytes: new TextEncoder().encode(text), source }, admin));
}

/** Steps 2 to 4 with tiny chunks, so every phase runs across several chunks. */
async function prepare(batchId: string, admin: User, over: { mapping?: Record<string, string>; defaults?: MappingInput["defaults"] } = {}) {
  const b = await getBatchView(batchId, admin);
  await saveMapping(batchId, { mapping: { ...(b!.mapping ?? {}), ...(over.mapping ?? {}) }, defaults: over.defaults ?? {} }, admin);
  for (let i = 0; i < 100; i++) if ((await runCleanChunk(batchId, admin, { limit: 3 })).finished) break;
  for (let i = 0; i < 100; i++) if ((await runMatchChunk(batchId, admin, { limit: 3 })).finished) break;
  return (await getBatchView(batchId, admin))!;
}

async function commit(batchId: string, admin: User) {
  await startCommit(batchId, admin);
  for (let i = 0; i < 100; i++) if ((await runCommitChunk(batchId, admin, { limit: 2 })).finished) break;
  return (await getBatchView(batchId, admin))!;
}

async function undo(batchId: string, admin: User) {
  await startUndo(batchId, admin);
  for (let i = 0; i < 100; i++) if ((await runUndoChunk(batchId, admin, { limit: 2 })).finished) break;
  return (await getBatchView(batchId, admin))!;
}

async function rowsOf(batchId: string) {
  return db.select().from(importRows).where(eq(importRows.batchId, batchId)).orderBy(asc(importRows.rowNumber));
}

async function contactByPhone(phone: string) {
  const [c] = await db.select().from(contacts).where(eq(contacts.phoneE164, phone));
  return c;
}

async function seedCatalogue() {
  await db.insert(products).values([
    { name: "AI Workshop", family: "workshop", rung: 1, listPrice: 999 },
    { name: "AI Agents for Business", family: "workshop", rung: 1, listPrice: 1999 },
    { name: "Applied AI Mastery", family: "applied_ai_mastery", rung: 2, listPrice: 24999 },
    { name: "The AI Office membership", family: "ai_office", rung: 3, listPrice: 99, currency: "USD" },
  ]);
}

describe("import: permissions", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("only an admin can run an import", async () => {
    const sales = await makeUser({ role: "sales" });
    const manager = await makeUser({ role: "manager" });
    for (const u of [sales, manager]) {
      await expect(uploadFile("zoho-contacts.csv", "zoho", u)).rejects.toThrow("Only an admin can run imports.");
    }
    expect(await db.select().from(importBatches)).toHaveLength(0);
  });
});

describe("import: TagMango customers and orders", () => {
  let admin: User;
  beforeEach(async () => {
    await resetDb();
    admin = await makeUser({ role: "admin" });
    await seedCatalogue();
  });

  it("keeps every raw row and proposes the mapping offline", async () => {
    const id = await uploadFile("tagmango-orders.csv", "tagmango", admin);
    const b = (await getBatchView(id, admin))!;
    expect(b.status).toBe("uploaded");
    expect(b.settings.mappingBy).toBe("heuristic");
    expect(b.settings.file.rowCount).toBe(11);
    expect(b.fileUrl).toMatch(/^\/api\/files\/imports\//);
    expect(b.mapping).toMatchObject({ "Order ID": "order_id", Phone: "phone", "Dial Code": "dial_code", Mango: "product", Amount: "amount" });
    const rows = await rowsOf(id);
    expect(rows[0].rowNumber).toBe(2);
    expect(rows[0].raw).toMatchObject({ "Order ID": "TM-1001", "Customer Name": "ANIL KUMAR", Amount: "₹999" });
  });

  it("collapses repeat buyers into unique customers with verified purchases and the right LTV", async () => {
    const id = await uploadFile("tagmango-orders.csv", "tagmango", admin);
    const prepared = await prepare(id, admin);
    expect(prepared.status).toBe("matched");
    const c = prepared.countsT;
    expect({ total: c.total, new: c.new, merge: c.merge, conflict: c.conflict, invalid: c.invalid, skip: c.skip }).toEqual({
      total: 11,
      new: 5,
      merge: 3,
      conflict: 0,
      invalid: 2,
      skip: 1,
    });
    const rows = await rowsOf(id);
    const byRow = new Map(rows.map((r) => [r.rowNumber, r]));
    expect((byRow.get(3)!.cleaned as StoredClean).match?.sameAsRow).toBe(2);
    expect((byRow.get(5)!.cleaned as StoredClean).match?.sameAsRow).toBe(4);
    expect(byRow.get(9)!.matchResult).toBe("skip");
    expect(byRow.get(9)!.issues).toContain("Same order id as row 8");
    expect(byRow.get(10)!.issues).toContain("No valid phone or email");
    expect(byRow.get(11)!.issues).toContain("No valid phone: a new contact needs a phone number");

    const done = await commit(id, admin);
    expect(done.status).toBe("committed");
    expect(done.countsT).toMatchObject({ created: 5, updated: 3, purchases: 8, failed: 0, uniqueContacts: 5 });
    expect(await uniqueCustomerCount()).toBe(5);

    const all = await db.select().from(contacts);
    expect(all).toHaveLength(5);
    for (const ct of all) expect(ct.importBatchId).toBe(id);

    const anil = await contactByPhone("+919847012345");
    expect(anil).toMatchObject({ name: "Anil Kumar", email: "anil.kumar@example.com", city: "Kochi", firstDoor: "other", firstChannel: "import", ownerId: null });
    expect(anil.ltvInr).toBe(25998);
    expect(anil.purchaseCount).toBe(2);

    // the UAE number written 0501234567 with dial code 971, and +971 50 123 4567, are one person
    const fathima = await contactByPhone("+971501234567");
    expect(fathima).toMatchObject({ name: "Fathima Rahman", phoneCountry: "AE", email: "fathima@example.com" });
    expect(fathima.purchaseCount).toBe(2);
    // AED at the earliest rate in Settings (22.6): 75 + 450 = 525 AED
    expect(fathima.ltvInr).toBe(11865);

    const priya = await contactByPhone("+919895000222");
    expect(priya.ltvInr).toBe(120699);
    const sneha = await contactByPhone("+919020000333");
    expect(sneha.ltvInr).toBe(8236.8);

    // the affiliate on Joseph's order is Anil: a referral, and Anil's network value
    const joseph = await contactByPhone("+919446000111");
    expect(joseph.referredById).toBe(anil.id);
    expect(joseph.firstDoor).toBe("referral");
    expect(anil.networkValueInr).toBe(999);

    const ps = await db.select().from(purchases);
    expect(ps).toHaveLength(8);
    for (const p of ps) {
      expect(p.source).toBe("import");
      expect(p.mode).toBe("tagmango");
      expect(p.importBatchId).toBe(id);
      expect(p.status).toBe("paid");
    }
    expect(ps.map((p) => p.reference).sort()).toEqual(["TM-1001", "TM-1002", "TM-1003", "TM-1004", "TM-1005", "TM-1006", "TM-1007", "TM-1010"]);
    const pays = await db.select().from(payments);
    expect(pays).toHaveLength(8);
    for (const p of pays) expect(p.status).toBe("verified");
    const catalogue = await db.select().from(products);
    expect(ps.find((p) => p.reference === "TM-1002")!.productId).toBe(catalogue.find((x) => x.name === "Applied AI Mastery")!.id);

    const enq = await db.select().from(enquiries).where(eq(enquiries.contactId, anil.id)).orderBy(asc(enquiries.receivedAt));
    expect(enq.map((e) => e.sourceRef)).toEqual([`import:${id}:2`, `import:${id}:3`]);
    for (const e of enq) expect(e.channel).toBe("import");

    // applied keeps what changed, for review and undo
    const r2 = (await rowsOf(id)).find((r) => r.rowNumber === 2)!;
    expect(r2.contactId).toBe(anil.id);
    expect(r2.applied).toMatchObject({ createdContact: true, contactId: anil.id });
    expect((r2.applied as AppliedRow).purchaseId).toBeTruthy();
  });

  it("re-importing the same file adds nothing: every order is already recorded", async () => {
    const first = await uploadFile("tagmango-orders.csv", "tagmango", admin);
    await prepare(first, admin);
    await commit(first, admin);
    const ltvBefore = (await db.select({ id: contacts.id, ltv: contacts.ltvInr }).from(contacts)).sort((a, b) => a.id.localeCompare(b.id));

    const again = await uploadFile("tagmango-orders.csv", "tagmango", admin);
    const b = await prepare(again, admin);
    expect(b.countsT).toMatchObject({ new: 0, merge: 0, invalid: 2, skip: 9, toCommit: 0 });
    const rows = await rowsOf(again);
    expect(rows.find((r) => r.rowNumber === 2)!.issues).toContain("Order TM-1001 is already recorded on Anil Kumar");
    await expect(startCommit(again, admin)).rejects.toThrow("Nothing to import");

    expect(await db.select().from(contacts)).toHaveLength(5);
    expect(await db.select().from(purchases)).toHaveLength(8);
    const ltvAfter = (await db.select({ id: contacts.id, ltv: contacts.ltvInr }).from(contacts)).sort((a, b) => a.id.localeCompare(b.id));
    expect(ltvAfter).toEqual(ltvBefore);
  });

  it("an order recorded meanwhile (e.g. by the webhook) is skipped at commit, never counted twice", async () => {
    const id = await uploadFile("tagmango-orders.csv", "tagmango", admin);
    await prepare(id, admin);
    // between review and commit, TM-1010 arrives through another path
    const sneha = await captureEnquiry({ phone: "9020000333", name: "Sneha Pillai", channel: "tagmango_checkout", skipAlerts: true });
    const { recordPurchase } = await import("@/lib/money/purchases");
    await recordPurchase(
      { contactId: sneha.contact.id, productName: "AI Office", family: "ai_office", amount: 99, currency: "USD", mode: "tagmango", reference: "TM-1010", source: "tagmango" },
      null,
    );
    const done = await commit(id, admin);
    expect(done.countsT).toMatchObject({ purchases: 7, purchasesSkipped: 1, failed: 0 });
    expect(await db.select().from(purchases).where(eq(purchases.reference, "TM-1010"))).toHaveLength(1);
    const row = (await rowsOf(id)).find((r) => r.rowNumber === 12)!;
    expect((row.applied as AppliedRow).purchaseSkipped).toContain("TM-1010");
  });

  it("skipped rows are left out of the commit", async () => {
    const id = await uploadFile("tagmango-orders.csv", "tagmango", admin);
    await prepare(id, admin);
    const sneha = (await rowsOf(id)).find((r) => r.rowNumber === 12)!;
    expect(await setRowsSkipped(id, [sneha.id], true, admin)).toBe(1);
    expect((await getBatchView(id, admin))!.countsT).toMatchObject({ new: 4, skip: 2 });
    const done = await commit(id, admin);
    expect(done.countsT.created).toBe(4);
    expect(await contactByPhone("+919020000333")).toBeUndefined();
  });
});

describe("import: Zoho CRM", () => {
  it("matches owners by name or email, carries notes over, and keeps the pool when the owner is unknown", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const one = await makeUser({ role: "sales", name: "Sales One", email: "sales.one@edapt.test" });
    const two = await makeUser({ role: "sales", name: "Sales Two", email: "sales.two@edapt.test" });
    const existing = await captureEnquiry({ phone: "9847012345", name: "Anil Kumar", channel: "phone_call", firstDoor: "meta_ad", skipAssignment: true, skipAlerts: true });
    expect(existing.contact.ownerId).toBeNull();

    const id = await uploadFile("zoho-contacts.csv", "zoho", admin);
    const b = await prepare(id, admin);
    expect(b.mapping).toMatchObject({ "Contact Owner": "owner", "First Name": "name", "Last Name": "name", Mobile: "phone", Description: "notes", "Lead Source": "first_door" });
    expect(b.countsT).toMatchObject({ new: 2, merge: 1 });
    const vivekRow = (await rowsOf(id)).find((r) => r.rowNumber === 4)!;
    expect(vivekRow.issues.join(" ")).toContain('Owner "Unknown Person" is not a team member');
    await commit(id, admin);

    const anil = await contactByPhone("+919847012345");
    expect(anil.ownerId).toBe(one.id);
    expect(anil.firstOwnerId).toBe(one.id);
    // the first door is set once: Zoho's lead source does not overwrite it
    expect(anil.firstDoor).toBe("meta_ad");
    const [note] = await db.select().from(enquiries).where(and(eq(enquiries.contactId, anil.id), eq(enquiries.channel, "import")));
    expect(note.notes).toBe("Asked about The AI Office");

    const meera = await contactByPhone("+919746001122");
    expect(meera).toMatchObject({ name: "Meera Das", ownerId: two.id, city: "Kannur", firstDoor: "workshop_webinar", email: "meera@example.com" });

    const vivek = await contactByPhone("+919633004455");
    expect(vivek.ownerId).toBeNull();
    expect(vivek.firstDoor).toBe("other");
  });

  it("owner fallback: a named salesperson, or round robin", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const rep = await makeUser({ role: "sales", name: "Rep" });
    const id = await uploadFile("zoho-contacts.csv", "zoho", admin);
    await prepare(id, admin, { mapping: { "Contact Owner": "ignore" }, defaults: { ownerFallback: rep.id } });
    await commit(id, admin);
    const all = await db.select().from(contacts);
    expect(all).toHaveLength(3);
    for (const c of all) expect(c.ownerId).toBe(rep.id);
  });
});

describe("import: delegation list and program sheets", () => {
  it("a delegation doc: rows pulled from the text, first door Delegation and the Legacy: Delegation tag", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const lakshmi = await captureEnquiry({ phone: "9447654321", name: "Lakshmi Menon", channel: "whatsapp_app", firstDoor: "youtube", skipAssignment: true, skipAlerts: true });
    const id = await uploadFile("delegation-list.txt", "delegation", admin);
    const b0 = (await getBatchView(id, admin))!;
    expect(b0.settings.file.extractedBy).toBe("heuristic");
    expect(b0.settings.file.rowCount).toBe(3);
    const b = await prepare(id, admin);
    expect(b.countsT).toMatchObject({ new: 2, merge: 1, invalid: 0 });
    await commit(id, admin);

    const thomas = await contactByPhone("+919847123456");
    expect(thomas).toMatchObject({ name: "Thomas George", firstDoor: "delegation", tags: ["Legacy: Delegation"] });
    // delegation alumni surface first for The AI Office (next best offer)
    expect(thomas.nextOffer).toBe("The AI Office and premium programs");
    const abdul = await contactByPhone("+971557654321");
    expect(abdul).toMatchObject({ firstDoor: "delegation", phoneCountry: "AE" });
    const after = await contactByPhone("+919447654321");
    expect(after.id).toBe(lakshmi.contact.id);
    expect(after.firstDoor).toBe("youtube");
    expect(after.tags).toEqual(["Legacy: Delegation"]);
    expect(after.email).toBe("lakshmi.menon@example.com");
  });

  it("an Excel program sheet: first door MLA program, campaign and a tag for the program", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const id = await uploadFile("program-sheet.xlsx", "program_sheet", admin);
    const b0 = (await getBatchView(id, admin))!;
    expect(b0.settings.file).toMatchObject({ kind: "xlsx", sheets: ["Attendees", "Summary"], sheet: "Attendees", rowCount: 4 });
    expect(b0.mapping).toMatchObject({ "Participant Name": "name", "Mobile Number": "phone", "Email ID": "email", "Sl No": "ignore" });

    // another sheet can be chosen, and back
    await changeSheet(id, "Summary", admin);
    expect((await getBatchView(id, admin))!.settings.file).toMatchObject({ sheet: "Summary", rowCount: 1 });
    await changeSheet(id, "Attendees", admin);

    const b = await prepare(id, admin, { defaults: { campaign: "koduvally_ai_literacy" } });
    expect(b.countsT).toMatchObject({ new: 3, invalid: 1 });
    await commit(id, admin);
    const all = await db.select().from(contacts).orderBy(asc(contacts.name));
    expect(all.map((c) => c.name)).toEqual(["Ramla Beevi", "Shahul Hameed", "Suresh Babu"]);
    for (const c of all) {
      expect(c.firstDoor).toBe("mla_program");
      expect(c.firstCampaign).toBe("koduvally_ai_literacy");
      expect(c.tags).toEqual(["Koduvally AI Literacy Mission"]);
    }
    expect(all.find((c) => c.name === "Ramla Beevi")!.phoneE164).toBe("+919847055502");
    expect(all.find((c) => c.name === "Suresh Babu")!.email).toBe("suresh@example.com");
  });
});

describe("import: conflicts (same name, same city)", () => {
  const csv = ["Name,Phone,City", "Anil Kumar,9847111111,Kochi", "Meera Das,9847222222,Kannur", "Ravi Shankar,9847333333,Kollam", "Ravi Shankar,9847444444,Kollam"].join("\n");

  it("needs a human: treat as new, or merge into the contact or the earlier row", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const anil = await captureEnquiry({ phone: "9847000001", name: "Anil Kumar", channel: "phone_call", profile: { city: "Kochi" }, skipAssignment: true, skipAlerts: true });
    const meera = await captureEnquiry({ phone: "9847000002", name: "Meera Das", channel: "phone_call", profile: { city: "Kannur" }, skipAssignment: true, skipAlerts: true });

    const id = await uploadText("people.csv", csv, "other", admin);
    const b = await prepare(id, admin);
    expect(b.countsT).toMatchObject({ new: 1, conflict: 3, unresolved: 3 });
    const rows = await rowsOf(id);
    const [rAnil, rMeera, , rRavi2] = rows;
    expect((rAnil.cleaned as StoredClean).match?.candidates?.[0]).toMatchObject({ id: anil.contact.id, name: "Anil Kumar" });
    expect((rRavi2.cleaned as StoredClean).match?.conflictRow).toBe(4);
    await expect(startCommit(id, admin)).rejects.toThrow("Decide the 3 conflicts first");

    await resolveConflict(id, rAnil.id, { kind: "contact", contactId: anil.contact.id }, admin);
    await resolveConflict(id, rMeera.id, { kind: "new" }, admin);
    await resolveConflict(id, rRavi2.id, { kind: "row" }, admin);
    await expect(resolveConflict(id, rAnil.id, { kind: "contact", contactId: meera.contact.id }, admin)).rejects.toThrow();
    const done = await commit(id, admin);
    expect(done.countsT).toMatchObject({ created: 2, updated: 2, failed: 0 });

    const a = await contactByPhone("+919847000001");
    expect(a.altPhones).toEqual(["+919847111111"]);
    const meeras = await db.select().from(contacts).where(eq(contacts.name, "Meera Das"));
    expect(meeras).toHaveLength(2);
    // treated as new: the pair is flagged for review, never merged
    const reviews = await db.select().from(duplicateReviews);
    expect(reviews).toHaveLength(1);
    const ravi = await contactByPhone("+919847333333");
    expect(ravi.altPhones).toEqual(["+919847444444"]);
  });

  it("all conflicts as new, in one click", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    await captureEnquiry({ phone: "9847000001", name: "Anil Kumar", channel: "phone_call", profile: { city: "Kochi" }, skipAssignment: true, skipAlerts: true });
    const id = await uploadText("people.csv", csv, "other", admin);
    await prepare(id, admin);
    expect(await resolveAllConflictsAsNew(id, admin)).toBe(2);
    expect((await getBatchView(id, admin))!.countsT.unresolved).toBe(0);
    await commit(id, admin);
    expect(await db.select().from(contacts)).toHaveLength(5);
  });
});

describe("import: undo", () => {
  /** Every column of a contact except bookkeeping timestamps. */
  function state(c: Contact) {
    const { updatedAt, scoredAt, stageChangedAt, ...rest } = c;
    void updatedAt;
    void scoredAt;
    void stageChangedAt;
    return rest;
  }

  it("undoes a whole batch: created contacts go, existing contacts return exactly to their previous state", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const rep = await makeUser({ role: "sales", name: "Rep" });
    await seedCatalogue();
    const x = await captureEnquiry({
      phone: "9847000001",
      name: "Xavier Thomas",
      channel: "phone_call",
      firstDoor: "youtube",
      tags: ["VIP"],
      skipAssignment: true,
      skipAlerts: true,
    });
    const xBefore = state((await db.select().from(contacts).where(eq(contacts.id, x.contact.id)))[0]);
    const enqBefore = await db.select().from(enquiries);

    const csv = [
      "Order ID,Name,Phone,Email,City,Mango,Amount,Date,Alt Phone",
      "U-1,Xavier Thomas,9847000001,xavier@example.com,Kochi,AI Workshop,999,01/10/2025,9847000099",
      "U-2,Nimmy Joseph,9847000002,,Thrissur,AI Workshop,999,02/10/2025,",
      "U-3,Navas Ali,9847000003,,Kozhikode,Applied AI Mastery,24999,03/10/2025,",
      "U-4,Nimmy Joseph,9847000002,nimmy@example.com,,AI Workshop,699,04/10/2025,",
      "U-5,Xavier T,9847000001,,,Applied AI Mastery,24999,05/10/2025,",
    ].join("\n");
    const id = await uploadText("orders.csv", csv, "tagmango", admin);
    await prepare(id, admin, { mapping: { "Alt Phone": "alt_phone" }, defaults: { ownerFallback: rep.id, tags: ["Imported"] } });
    await commit(id, admin);

    const xAfter = await contactByPhone("+919847000001");
    expect(xAfter).toMatchObject({ ownerId: rep.id, email: "xavier@example.com", city: "Kochi", altPhones: ["+919847000099"], tags: ["VIP", "Imported"] });
    expect(xAfter.ltvInr).toBe(25998);

    // Navas gets a call logged after the import: he must survive the undo
    const navas = await contactByPhone("+919847000003");
    await logInteraction(navas.id, { type: "call", outcome: "connected", summary: "Called after import" }, rep);

    const undone = await undo(id, admin);
    expect(undone.status).toBe("undone");
    expect(undone.undoneById).toBe(admin.id);
    expect(undone.countsT).toMatchObject({ deletedContacts: 1, keptContacts: 1, deletedPurchases: 5, revertedContacts: 1 } satisfies BatchCounts);
    // Nimmy's second row merged into the contact her first row created: undone with it, not "put back"
    const nimmy2 = (await rowsOf(id)).find((r) => r.rowNumber === 5)!;
    expect((nimmy2.applied as AppliedRow).withCreatedContact).toBe(true);

    // the existing contact is exactly as before
    const xBack = state((await db.select().from(contacts).where(eq(contacts.id, x.contact.id)))[0]);
    expect(xBack).toEqual(xBefore);
    expect(await db.select().from(enquiries).where(eq(enquiries.contactId, x.contact.id))).toEqual(enqBefore.filter((e) => e.contactId === x.contact.id));

    // created contacts are gone, except the one with activity since (reported on its row)
    expect(await contactByPhone("+919847000002")).toBeUndefined();
    const navasKept = await contactByPhone("+919847000003");
    expect(navasKept).toBeTruthy();
    expect(navasKept.purchaseCount).toBe(0);
    const kept = await listRows(id, admin, { view: "kept" });
    expect(kept.rows).toHaveLength(1);
    expect((kept.rows[0].applied as AppliedRow).undoNote).toContain("a call, chat or note was logged");

    expect(await db.select().from(purchases)).toHaveLength(0);
    expect(await db.select().from(payments)).toHaveLength(0);
    expect(await db.select().from(enquiries).where(like(enquiries.sourceRef, `import:${id}:%`))).toHaveLength(0);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tableName, "import_batches"), eq(auditLog.rowId, id), eq(auditLog.action, "undo")));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    await expect(startUndo(id, admin)).rejects.toThrow("already undone");
  });

  it("a value someone changed after the import is kept by the undo", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const x = await captureEnquiry({ phone: "9847000001", name: "Xavier Thomas", channel: "phone_call", skipAssignment: true, skipAlerts: true });
    const id = await uploadText("people.csv", "Name,Phone,City,Email\nXavier Thomas,9847000001,Kochi,xavier@example.com", "other", admin);
    await prepare(id, admin);
    await commit(id, admin);
    const { updateContactProfile } = await import("@/lib/contacts/profile");
    await updateContactProfile(x.contact.id, { city: "Ernakulam" }, admin);
    await undo(id, admin);
    const back = await contactByPhone("+919847000001");
    expect(back.city).toBe("Ernakulam");
    expect(back.email).toBeNull();
  });

  it("undo is admin only and needs a committed import", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const manager = await makeUser({ role: "manager" });
    const id = await uploadText("people.csv", "Name,Phone\nA,9847000001", "other", admin);
    await expect(startUndo(id, admin)).rejects.toThrow("Only a committed import can be undone.");
    await prepare(id, admin);
    await commit(id, admin);
    await expect(startUndo(id, manager)).rejects.toThrow("Only an admin can run imports.");
    const rows = await db.select().from(importRows).where(inArray(importRows.batchId, [id]));
    expect(rows[0].contactId).toBeTruthy();
  });
});

describe("import: review fixes", () => {
  it("a payment without an order id is recorded once: repeated in the file, or already in the CRM on re-import", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    await seedCatalogue();
    const csv = [
      "Name,Phone,Product,Amount,Date",
      "Asha Varghese,9847000011,AI Workshop,999,01/10/2025",
      "Asha Varghese,9847000011,AI Workshop,999,01/10/2025",
      "Asha Varghese,9847000011,AI Workshop,999,05/10/2025",
    ].join("\n");
    const first = await uploadText("sheet.csv", csv, "other", admin);
    await prepare(first, admin);
    const rows = await rowsOf(first);
    expect((rows[1].cleaned as StoredClean).match?.duplicatePurchase).toContain("Same payment as row 2");
    expect((rows[2].cleaned as StoredClean).match?.duplicatePurchase).toBeFalsy();
    const done = await commit(first, admin);
    expect(done.countsT).toMatchObject({ purchases: 2, purchasesSkipped: 1, failed: 0 });
    const asha = await contactByPhone("+919847000011");
    expect(asha.ltvInr).toBe(1998);

    // the same sheet again: the person merges, the money is not counted twice
    const again = await uploadText("sheet.csv", csv, "other", admin);
    const b = await prepare(again, admin);
    expect(b.countsT).toMatchObject({ merge: 3, new: 0 });
    for (const r of await rowsOf(again)) expect((r.cleaned as StoredClean).match?.duplicatePurchase).toBeTruthy();
    const redone = await commit(again, admin);
    expect(redone.countsT).toMatchObject({ purchases: 0, purchasesSkipped: 3 });
    expect(await db.select().from(purchases)).toHaveLength(2);
    expect((await contactByPhone("+919847000011")).ltvInr).toBe(1998);
  });

  it("Zoho owners carry over onto contacts that already have an owner, and the undo puts the owner back", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const rep = await makeUser({ role: "sales", name: "Round Robin Rep" });
    const one = await makeUser({ role: "sales", name: "Sales One", email: "sales.one@edapt.test" });
    await makeUser({ role: "sales", name: "Sales Two", email: "sales.two@edapt.test" });
    const existing = await captureEnquiry({ phone: "9847012345", name: "Anil Kumar", channel: "tagmango_checkout", ownerId: rep.id, skipAlerts: true });
    expect(existing.contact.ownerId).toBe(rep.id);

    const id = await uploadFile("zoho-contacts.csv", "zoho", admin);
    expect((await getBatchView(id, admin))!.settings.ownerFromFile).toBe(true);
    await prepare(id, admin);
    await commit(id, admin);
    const anil = await contactByPhone("+919847012345");
    expect(anil.ownerId).toBe(one.id);
    // the first owner never changes
    expect(anil.firstOwnerId).toBe(rep.id);
    const log = await db.select().from(ownershipLog).where(eq(ownershipLog.contactId, anil.id));
    expect(log.map((l) => l.reason)).toContain("Import: owner in Zoho");

    await undo(id, admin);
    const back = await contactByPhone("+919847012345");
    expect(back.ownerId).toBe(rep.id);
    expect(back.firstOwnerId).toBe(rep.id);
  });

  it("with the option off, existing contacts keep their owner", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const rep = await makeUser({ role: "sales", name: "Round Robin Rep" });
    await makeUser({ role: "sales", name: "Sales One", email: "sales.one@edapt.test" });
    await captureEnquiry({ phone: "9847012345", name: "Anil Kumar", channel: "tagmango_checkout", ownerId: rep.id, skipAlerts: true });
    const id = await uploadFile("zoho-contacts.csv", "zoho", admin);
    await prepare(id, admin, { defaults: { ownerFromFile: false } });
    await commit(id, admin);
    expect((await contactByPhone("+919847012345")).ownerId).toBe(rep.id);
  });

  it("old records are dated by the records date, not today, so they never look like fresh interest", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    const id = await uploadFile("delegation-list.txt", "delegation", admin);
    await prepare(id, admin, { defaults: { recordsDate: "2024-05-10" } });
    await commit(id, admin);
    const thomas = await contactByPhone("+919847123456");
    const when = new Date("2024-05-10T06:30:00.000Z");
    expect(thomas.createdAt).toEqual(when);
    expect(thomas.lastEnquiryAt).toEqual(when);
    const [enq] = await db.select().from(enquiries).where(eq(enquiries.contactId, thomas.id));
    expect(enq.receivedAt).toEqual(when);

    const bad = await uploadFile("delegation-list.txt", "delegation", admin);
    const b = await getBatchView(bad, admin);
    await expect(saveMapping(bad, { mapping: b!.mapping ?? {}, defaults: { recordsDate: "2999-01-01" } }, admin)).rejects.toThrow("can't be in the future");
  });

  it("downloading the invalid rows is an export: it is logged", async () => {
    await resetDb();
    const admin = await makeUser({ role: "admin" });
    await seedCatalogue();
    const id = await uploadFile("tagmango-orders.csv", "tagmango", admin);
    await prepare(id, admin);
    let csvText = "";
    for await (const piece of invalidRowsCsv(id, admin)) csvText += piece;
    expect(csvText.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect(csvText).toContain("No valid phone or email");
    const logged = await db.select().from(auditLog).where(and(eq(auditLog.action, "export"), eq(auditLog.rowId, id)));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ tableName: "import_rows", field: "invalid_rows", userId: admin.id });
  });
});
