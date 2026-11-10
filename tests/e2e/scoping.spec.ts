import { desc, eq } from "drizzle-orm";
import { auditLog, interactions, rateLimitHits } from "@/db/schema";
import { QUICK_ADD_LOOKUP_LIMIT } from "@/lib/auth/rate-limit";
import { createOrganisation } from "@/lib/contacts/organisations";
import { recordPurchase } from "@/lib/money/purchases";
import { test, expect, db, getContact, makeContact, makeUser, uniqueWord, userId } from "./support/fixtures";

// laptop project only (playwright.config.ts)

test("a salesperson cannot open or find another salesperson's contact", async ({ pageAs }) => {
  const theirs = await makeContact({ owner: "sales2" });
  const mine = await makeContact({ owner: "sales", name: `${theirs.name.split(" ")[0]} ${theirs.name.split(" ")[1]}x` });
  const page = await pageAs("sales");

  for (const path of [`/contacts/${theirs.id}`, `/contacts/${theirs.id}/log`, `/contacts/${theirs.id}/rate`, `/contacts/${theirs.id}/payment`]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }

  // search by name and by phone: their contact never shows, mine does
  await page.goto(`/contacts?q=${encodeURIComponent(theirs.name.split(" ")[1])}`);
  await expect(page.getByRole("link", { name: mine.name }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: theirs.name, exact: true })).toHaveCount(0);
  await page.goto(`/contacts?q=${encodeURIComponent(theirs.phoneE164)}`);
  await expect(page.getByRole("link", { name: theirs.name, exact: true })).toHaveCount(0);

  // the owner does see it
  const owner = await pageAs("sales2");
  await owner.goto(`/contacts?q=${encodeURIComponent(theirs.phoneE164)}`);
  await expect(owner.getByRole("link", { name: theirs.name, exact: true }).first()).toBeVisible();
});

test("an organisation shows a salesperson no money, deals or details of a colleague's contacts; a manager sees it all", async ({ pageAs }) => {
  const admin = { id: await userId("admin"), role: "admin" as const };
  const org = await createOrganisation({ name: `School ${uniqueWord()}`, kind: "school", city: "Kochi" }, admin);
  const mine = await makeContact({ owner: "sales", profile: { organisationId: org.id } });
  const theirs = await makeContact({ owner: "sales2", profile: { organisationId: org.id } });
  const deal = `Colleague program ${uniqueWord()}`;
  await recordPurchase(
    {
      contactId: theirs.id,
      organisationId: org.id,
      productName: deal,
      family: "b2b_program",
      amount: 123456,
      currency: "INR",
      mode: "bank_transfer",
      reference: `UTR-ORG-${uniqueWord()}${Date.now()}`,
      source: "manual",
      verified: true,
    },
    admin,
  );

  const page = await pageAs("sales");
  await page.goto(`/organisations/${org.id}`);
  await expect(page.getByRole("heading", { level: 1, name: org.name })).toBeVisible();
  const main = page.locator("main");
  await expect(main.getByRole("link", { name: mine.name })).toBeVisible();
  await expect(main.getByText("1 more person is linked here, owned by colleagues. Their details stay private.")).toBeVisible();
  for (const hidden of [theirs.name, deal, "1,23,456", "Total revenue"]) await expect(main).not.toContainText(hidden);
  await expect(main.getByText("No purchases you can see")).toBeVisible();
  // the list has no purchase or revenue columns for a salesperson
  await page.goto(`/organisations?q=${encodeURIComponent(org.name)}`);
  await expect(page.getByRole("link", { name: org.name })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Revenue" })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("1,23,456");

  // a manager sees every person, the deal and the totals
  const mp = await pageAs("manager");
  await mp.goto(`/organisations/${org.id}`);
  const all = mp.locator("main");
  await expect(all.getByText("Total revenue")).toBeVisible();
  await expect(all).toContainText("₹1,23,456");
  await expect(all.getByRole("link", { name: theirs.name }).first()).toBeVisible();
  await expect(all).toContainText(deal);
  await mp.goto(`/organisations?q=${encodeURIComponent(org.name)}`);
  await expect(mp.getByRole("columnheader", { name: "Revenue" })).toBeVisible();
  await expect(mp.locator("main")).toContainText("₹1,23,456");
});

test("a contact's referrals show a salesperson only a count of a colleague's contacts; a manager sees them", async ({ pageAs }) => {
  const admin = { id: await userId("admin"), role: "admin" as const };
  const referrer = await makeContact({ owner: "sales" });
  const theirs = await makeContact({ owner: "sales2", referrer: { contactId: referrer.id } });
  await recordPurchase(
    {
      contactId: theirs.id,
      productName: `Workshop ${uniqueWord()}`,
      family: "workshop",
      amount: 23456,
      currency: "INR",
      mode: "cash",
      source: "manual",
      verified: true,
    },
    admin,
  );

  const page = await pageAs("sales");
  await page.goto(`/contacts/${referrer.id}?tab=referrals`);
  const main = page.locator("main");
  await expect(main.getByText("1 more person they referred is owned by a colleague. Their details stay private.")).toBeVisible();
  await expect(main.getByText("of 1 referred")).toBeVisible();
  // no row for them: no name, no stand-in label, no link (the network value card keeps the spec's total)
  await expect(main).not.toContainText(theirs.name);
  await expect(main).not.toContainText("Another salesperson's contact");
  await expect(main.locator(`a[href="/contacts/${theirs.id}"]`)).toHaveCount(0);
  await expect(main.getByText("No referrals yet")).toHaveCount(0);

  const mp = await pageAs("manager");
  await mp.goto(`/contacts/${referrer.id}?tab=referrals`);
  const all = mp.locator("main");
  await expect(all.getByRole("link", { name: theirs.name }).first()).toBeVisible();
  await expect(all).not.toContainText("owned by a colleague");
});

test("the Edit page does not name a colleague's contact that holds a number, and counts the check", async ({ pageFor }) => {
  // a fresh salesperson, so no other spec's lookups count
  const rep = await makeUser({ role: "sales" });
  const mine = await makeContact({ owner: rep });
  const theirs = await makeContact({ owner: "sales2" });

  const page = await pageFor(rep);
  await page.goto(`/contacts/${mine.id}/edit`);
  const phoneInput = page.getByRole("textbox", { name: "Another phone number" });
  const addPhone = page.locator("form").filter({ has: phoneInput });
  await phoneInput.fill(theirs.phoneE164);
  await addPhone.getByRole("button", { name: "Add" }).click();
  await expect(addPhone.getByText("This number already belongs to a colleague's contact")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(theirs.name);
  const counted = await db.select().from(rateLimitHits).where(eq(rateLimitHits.subject, rep.id));
  expect(counted).toHaveLength(1);

  // over the limit it says so instead of answering
  const at = new Date(Date.now() - 60_000);
  await db
    .insert(rateLimitHits)
    .values(Array.from({ length: QUICK_ADD_LOOKUP_LIMIT.max }, () => ({ bucket: QUICK_ADD_LOOKUP_LIMIT.bucket, subject: rep.id, createdAt: at })));
  await page.reload();
  await phoneInput.fill(theirs.phoneE164);
  await addPhone.getByRole("button", { name: "Add" }).click();
  await expect(addPhone.getByText(/^Too many number checks in a short time\. Try again in \d+ minutes?\.$/).first()).toBeVisible();
  await expect(page.locator("main")).not.toContainText("already belongs");
  expect((await getContact(mine.id)).altPhones).toEqual([]);
});

test("a salesperson is sent back to Today from settings, the dashboard and import", async ({ pageAs }) => {
  const page = await pageAs("sales");
  for (const path of ["/settings", "/settings/scoring", "/dashboard", "/dashboard/calibration", "/import"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/today\?denied=1$/);
    await expect(page.getByRole("alert").filter({ hasText: "That page is not available for your role" })).toBeVisible();
  }
});

test("support logs a note on any contact but cannot edit or reassign it", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales2" });
  const note = `Asked for the invoice again ${uniqueWord()}`;
  const page = await pageAs("support");
  await page.goto(`/contacts/${contact.id}`);
  await expect(page.getByRole("heading", { level: 1, name: contact.name })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Rate", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Stage and owner" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Reassign/ })).toHaveCount(0);

  await page.getByRole("link", { name: "Log", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Support issue" })).toBeChecked();
  await page.locator("label").filter({ hasText: /^Note$/ }).click();
  await page.getByRole("textbox", { name: /^Note/ }).fill(note);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${contact.id}$`));
  await expect(page.getByRole("list", { name: "Timeline" }).locator("li").filter({ hasText: note })).toContainText("Note");
  const [logged] = await db.select().from(interactions).where(eq(interactions.contactId, contact.id)).orderBy(desc(interactions.createdAt));
  expect(logged).toMatchObject({ type: "note", summary: note, userId: await userId("support") });
  expect((await getContact(contact.id)).ownerId).toBe(await userId("sales2"));

  // the edit screen refuses
  await page.goto(`/contacts/${contact.id}/edit`);
  await expect(page.getByText("You cannot edit this contact")).toBeVisible();
  await expect(page.getByRole("button", { name: /Save/ })).toHaveCount(0);
});

test("only the admin can export; a manager's attempt is refused and logged", async ({ pageAs }) => {
  const admin = await pageAs("admin");
  const ok = await admin.request.get("/api/export/contacts");
  expect(ok.status()).toBe(200);
  expect(ok.headers()["content-type"]).toContain("text/csv");
  expect((await ok.text()).split("\n")[0]).toMatch(/phone/i);

  const manager = await pageAs("manager");
  for (const kind of ["contacts", "purchases"]) {
    const res = await manager.request.get(`/api/export/${kind}`);
    expect(res.status(), kind).toBe(403);
    expect((await res.json()).error).toContain("Only the admin can export");
  }
  const sales = await pageAs("sales");
  expect((await sales.request.get("/api/export/contacts")).status()).toBe(403);

  const managerId = await userId("manager");
  const denied = await db.select().from(auditLog).where(eq(auditLog.userId, managerId)).orderBy(desc(auditLog.changedAt)).limit(5);
  expect(denied.some((r) => JSON.stringify(r).includes("export_denied"))).toBe(true);
});
