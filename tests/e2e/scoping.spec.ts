import { desc, eq } from "drizzle-orm";
import { auditLog, interactions } from "@/db/schema";
import { test, expect, db, getContact, makeContact, uniqueWord, userId } from "./support/fixtures";

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
