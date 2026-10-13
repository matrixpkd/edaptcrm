import { test, expect, findContactByPhone, makeContact, uniqueName, uniquePhone, userId } from "./support/fixtures";
import { PEOPLE } from "./support/env";

// Quick Add is phone-first and used on laptops too: both projects run it

test("a known number shows the existing contact and its owner before saving, and cannot be saved", async ({ pageAs }) => {
  const phone = await uniquePhone();
  const existing = await makeContact({ owner: "sales2", phone: phone.e164, name: uniqueName("Known") });

  const page = await pageAs("sales");
  await page.goto("/contacts/new");
  await page.getByRole("textbox", { name: /^Phone/ }).fill(phone.typed);

  const card = page.getByRole("alert").filter({ hasText: "Already in the CRM" });
  await expect(card).toBeVisible();
  await expect(card).toContainText(existing.name);
  await expect(card).toContainText(`Owner: ${PEOPLE.sales2.name}`);
  await expect(card).toContainText(phone.international);
  // another salesperson's contact: no link into it, a transfer request instead
  await expect(card.getByRole("link", { name: "Open contact" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Request transfer" })).toBeVisible();

  // nothing to fill in: the rest of the form is hidden, so it cannot be saved as a second record
  await expect(page.getByRole("textbox", { name: /^Name/ })).toBeHidden();
  await expect(page.getByRole("button", { name: /^(Save contact|Already in the CRM)$/ })).toBeHidden();

  // the transfer request replaces itself with a confirmation, so it cannot be sent twice
  await card.getByRole("button", { name: "Request transfer" }).click();
  await card.getByRole("button", { name: "Send to manager" }).click();
  await expect(card.getByRole("status")).toContainText("Your manager has the request");
  await expect(card.getByRole("button", { name: "Send to manager" })).toHaveCount(0);
  expect(await findContactByPhone(phone.e164)).toMatchObject({ id: existing.id, ownerId: await userId("sales2") });
});

test("a new UAE 05X number becomes +971 and the saved lead is the salesperson's, stage New, with a grade", async ({ pageAs }) => {
  const phone = await uniquePhone("AE");
  expect(phone.typed).toMatch(/^05\d /);
  const name = uniqueName("Dubai");

  const page = await pageAs("sales");
  await page.goto("/contacts/new");
  await page.getByRole("textbox", { name: /^Phone/ }).fill(phone.typed);
  const status = page.getByText(/^New number/);
  await expect(status).toContainText(phone.international);
  await expect(status).toContainText("United Arab Emirates");
  expect(phone.international).toMatch(/^\+971 5\d /);

  await page.getByRole("textbox", { name: /^Name/ }).fill(name);
  await page.getByRole("radiogroup", { name: "Most used channels" }).getByRole("radio").first().click();
  await page.getByLabel("First door").selectOption({ label: "YouTube" });
  await page.getByRole("button", { name: "Save contact" }).click();

  // lands on the new contact page (the banner then drops ?added=1 from the address bar)
  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}(\?added=1)?$/);
  await expect(page.getByRole("status").filter({ hasText: "Contact saved. It is yours." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText(`${PEOPLE.sales.name} (you)`)).toBeVisible();
  await expect(page.locator("main").getByText("New", { exact: true }).first()).toBeVisible();
  await expect(page.getByTitle(/^Edapt Score \d+$/)).toHaveText(/^[ABCD]\d+$/);

  const saved = await findContactByPhone(phone.e164);
  expect(saved).not.toBeNull();
  expect(saved!.phoneE164).toMatch(/^\+9715\d{8}$/);
  expect(saved!).toMatchObject({ name, stage: "new", ownerId: await userId("sales"), firstOwnerId: await userId("sales") });
  expect(saved!.grade).toMatch(/^[ABCD]$/);
  expect(page.url()).toContain(saved!.id);
});
