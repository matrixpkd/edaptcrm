/**
 * The first-run selling flows a brand-new owner hits on an empty CRM: who can be assigned, the Pool count,
 * one-click assign from the pool, and linking people from an organisation's page.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, ownershipLog, type Contact } from "@/db/schema";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactForbiddenError } from "@/lib/contacts/errors";
import { createOrganisation, linkContactToOrganisation } from "@/lib/contacts/organisations";
import { updateContactProfile } from "@/lib/contacts/profile";
import { reassignContacts, requestTransfer } from "@/lib/contacts/assignment";
import { assigneeOptions, countPoolContacts, listAssignableUsers } from "@/lib/contacts/queries";
import { assignReason } from "@/lib/contacts/rules";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
async function lead(over: Partial<Parameters<typeof captureEnquiry>[0]> = {}): Promise<Contact> {
  seq += 1;
  const r = await captureEnquiry({
    phone: `98472${String(10000 + seq).padStart(5, "0")}`,
    name: `Lead ${seq}`,
    channel: "phone_call",
    firstDoor: "youtube",
    skipAlerts: true,
    ...over,
  });
  return r.contact;
}

beforeEach(async () => {
  await resetDb();
});

describe("assignable team members", () => {
  it("lists active sales, managers and admins (sales first); never support or inactive users", async () => {
    const admin = await makeUser({ role: "admin", name: "Umer" });
    const manager = await makeUser({ role: "manager", name: "Maya" });
    const sales = await makeUser({ role: "sales", name: "Zed", team: "dubai" });
    await makeUser({ role: "support", name: "Sam" });
    await makeUser({ role: "sales", name: "Gone", active: false });
    const ids = (await listAssignableUsers()).map((u) => u.id);
    expect(ids).toEqual([sales.id, manager.id, admin.id]);
    const opts = await assigneeOptions();
    expect(opts.map((o) => o.label)).toEqual(["Zed (Sales, Dubai)", "Maya (Manager, Kerala)", "Umer (Admin, Kerala)"]);
  });

  it("an admin alone on a new CRM can take a pool lead (the founder sells too)", async () => {
    const admin = await makeUser({ role: "admin" });
    const c = await lead(); // no salesperson yet: auto-assign leaves it in the pool
    expect(c.ownerId).toBeNull();
    const changed = await reassignContacts([c.id], admin.id, admin, assignReason(null, null, admin.id));
    expect(changed).toBe(1);
    const [row] = await db.select().from(contacts).where(eq(contacts.id, c.id));
    expect(row.ownerId).toBe(admin.id);
    expect(row.firstOwnerId).toBe(admin.id);
    const log = await db.select().from(ownershipLog).where(eq(ownershipLog.contactId, c.id));
    expect(log.at(-1)?.reason).toBe("Assigned from the pool by a manager");
  });
});

describe("the Pool", () => {
  it("counts live unassigned contacts the viewer can see", async () => {
    const manager = await makeUser({ role: "manager" });
    const sales = await makeUser({ role: "sales" });
    const other = await makeUser({ role: "sales" });
    await lead({ skipAssignment: true });
    await lead({ skipAssignment: true });
    await lead({ ownerId: sales.id });
    expect(await countPoolContacts(manager)).toBe(2);
    expect(await countPoolContacts(sales)).toBe(2); // sales see the pool too
    const c = await lead({ skipAssignment: true });
    await reassignContacts([c.id], other.id, manager, "x");
    expect(await countPoolContacts(sales)).toBe(2);
  });

  it("a salesperson asks for a pool lead; asking twice creates nothing new", async () => {
    await makeUser({ role: "manager" });
    const sales = await makeUser({ role: "sales" });
    const c = await lead({ skipAssignment: true });
    const first = await requestTransfer(c.id, sales, "Asked for this pool lead from the contacts list");
    expect(first.created).toBe(true);
    const again = await requestTransfer(c.id, sales, "Asked for this pool lead from the contacts list");
    expect(again.created).toBe(false);
  });
});

describe("linking people from an organisation's page", () => {
  it("links (making them Business) and unlinks (back to Individual)", async () => {
    const sales = await makeUser({ role: "sales" });
    const org = await createOrganisation({ name: "GHSS Kozhikode", kind: "school" }, sales);
    const c = await lead({ ownerId: sales.id });
    expect((await linkContactToOrganisation(c.id, org.id, sales)).changed).toBe(true);
    let [row] = await db.select().from(contacts).where(eq(contacts.id, c.id));
    expect(row.organisationId).toBe(org.id);
    expect(row.type).toBe("business");
    expect((await linkContactToOrganisation(c.id, org.id, sales)).changed).toBe(false);
    expect((await linkContactToOrganisation(c.id, null, sales)).changed).toBe(true);
    [row] = await db.select().from(contacts).where(eq(contacts.id, c.id));
    expect(row.organisationId).toBeNull();
    expect(row.type).toBe("individual");
  });

  it("a business contact still needs its organisation on the Edit page", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await lead({ ownerId: sales.id });
    await expect(updateContactProfile(c.id, { type: "business" }, sales)).rejects.toThrow(/Link the school/);
  });

  it("a salesperson cannot link someone else's contact", async () => {
    const sales = await makeUser({ role: "sales" });
    const other = await makeUser({ role: "sales" });
    const org = await createOrganisation({ name: "Acme" }, sales);
    const c = await lead({ ownerId: other.id });
    await expect(linkContactToOrganisation(c.id, org.id, sales)).rejects.toBeInstanceOf(ContactForbiddenError);
  });
});
