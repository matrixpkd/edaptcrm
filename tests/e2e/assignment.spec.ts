import { test, expect, getContact, makeContact, openTasks, userId } from "./support/fixtures";
import { PEOPLE } from "./support/env";

/**
 * Assignment as a manager and a salesperson actually use it: assign from the contact header, unassign to the pool,
 * one-click Assign in the Pool view, a salesperson's Request on a pool lead and the manager's approval on Today.
 * Every step must say what happened (a toast) and update the page without a refresh.
 */

const toast = (page: import("@playwright/test").Page) => page.locator("[data-toast]");

test("a manager assigns from the contact header, then unassigns to the pool", async ({ pageAs }) => {
  const contact = await makeContact({ owner: null });
  const page = await pageAs("manager");
  await page.goto(`/contacts/${contact.id}`);

  const ownerLine = page.locator("p").filter({ hasText: /^Owner:/ });
  await expect(ownerLine).toContainText("Unassigned (pool)");
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  const form = page.getByRole("form", { name: "Assign this contact" });
  await form.getByLabel("Assign to").selectOption({ label: `${PEOPLE.sales.name} (Sales, Kerala)` });
  await form.getByRole("button", { name: "Assign", exact: true }).click();

  await expect(toast(page)).toContainText(`Assigned to ${PEOPLE.sales.name}`);
  await expect(ownerLine).toContainText(`Owner: ${PEOPLE.sales.name}`);
  expect((await getContact(contact.id)).ownerId).toBe(await userId("sales"));

  await page.getByRole("button", { name: "Change", exact: true }).click();
  await page.getByRole("button", { name: "Unassign to pool" }).click();
  await expect(toast(page)).toContainText("Back in the pool");
  await expect(ownerLine).toContainText("Owner: Unassigned (pool)");
  expect((await getContact(contact.id)).ownerId).toBeNull();
});

test("Pool view: a salesperson requests a lead, the manager approves it on Today", async ({ pageAs }) => {
  const contact = await makeContact({ owner: null, name: `Requested Lead ${Date.now()}` });
  const sales = await pageAs("sales");
  await sales.goto(`/contacts?owner=pool&q=${encodeURIComponent(contact.name)}`);
  // salespeople see the pool (the chip counts it) and ask for a lead; they never take it themselves
  await expect(sales.locator('a[href="/contacts?owner=pool"]')).toContainText("Pool");
  await sales.getByRole("button", { name: "Request" }).filter({ visible: true }).click();
  await expect(toast(sales)).toContainText("Requested");
  expect(await openTasks(contact.id, ["transfer_request"])).not.toHaveLength(0);

  const manager = await pageAs("manager");
  await manager.goto("/today");
  const row = manager.locator("li").filter({ hasText: contact.name }).filter({ hasText: "Transfer request" });
  await row.getByRole("button", { name: /Approve/ }).click();
  await expect(toast(manager)).toContainText(`Transfer approved and moved: ${contact.name}`);
  expect((await getContact(contact.id)).ownerId).toBe(await userId("sales"));
});

test("Pool view: a manager assigns a lead in one step from the list", async ({ pageAs }) => {
  const contact = await makeContact({ owner: null, name: `Inline lead ${Date.now()}` });
  const page = await pageAs("manager");
  await page.goto(`/contacts?owner=pool&q=${encodeURIComponent(contact.name)}`);
  await page.getByRole("button", { name: "Assign this contact" }).filter({ visible: true }).click();
  const form = page.getByRole("form", { name: "Assign this contact" }).filter({ visible: true });
  await form.getByRole("combobox").selectOption({ label: `${PEOPLE.sales2.name} (Sales, Kerala)` });
  await form.getByRole("button", { name: "Assign", exact: true }).click();
  // the row leaves the Pool view; the toast still says where it went
  await expect(toast(page)).toContainText(`Assigned to ${PEOPLE.sales2.name}`);
  await expect(page.getByText("No contacts match")).toBeVisible();
  expect((await getContact(contact.id)).ownerId).toBe(await userId("sales2"));
});
