import { test, expect, getContact, makeContact } from "./support/fixtures";

/** Every action says what it did, even when its button disappears or the page changes. */

const toast = (page: import("@playwright/test").Page) => page.locator("[data-toast]");

test("Mark qualified and logging a call each confirm with a toast", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales" });
  const page = await pageAs("sales");
  await page.goto(`/contacts/${contact.id}`);

  // the button goes away once the stage is Qualified: the toast is the only feedback
  await page.getByRole("button", { name: "Mark qualified" }).click();
  await expect(toast(page)).toContainText("Marked as qualified");
  await expect(page.getByRole("button", { name: "Mark qualified" })).toHaveCount(0);

  await page.getByRole("link", { name: "Log", exact: true }).click();
  await page.locator("label").filter({ hasText: /^Tomorrow$/ }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${contact.id}$`));
  await expect(toast(page)).toContainText("Call logged. Follow-up set.");
});

test("an organisation's page links and unlinks people", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales", name: `Principal ${Date.now()}` });
  const page = await pageAs("sales");
  await page.goto("/organisations?new=1");
  await page.locator("#org-name").fill(`School ${Date.now()}`);
  await page.getByRole("button", { name: "Add organisation" }).click();
  await expect(page).toHaveURL(/\/organisations\/[0-9a-f-]{36}/);

  await page.getByRole("searchbox", { name: "Find a person to link" }).fill(contact.name);
  await page.getByRole("button", { name: "Find" }).click();
  const found = page.getByRole("list", { name: "People found" });
  await found.getByRole("button", { name: "Link" }).click();
  await expect(toast(page)).toContainText("Linked to this organisation");
  await expect(found).toContainText("Linked");
  const linked = await getContact(contact.id);
  expect(linked.organisationId).not.toBeNull();
  expect(linked.type).toBe("business");

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: `Unlink ${contact.name}` }).click();
  await expect(toast(page)).toContainText("Unlinked");
  expect((await getContact(contact.id)).organisationId).toBeNull();
});
