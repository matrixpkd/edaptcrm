import { test, expect, makeContact, makeUser, uniqueWord } from "./support/fixtures";

/**
 * Global search (beyond the spec): the Search button and Ctrl/Cmd+K find contacts by name, phone or email inside the
 * person's scope, organisations and screens, and Enter jumps to the record.
 */

test("search finds my contact by name and by phone, never a colleague's, and opens it", async ({ pageFor }, testInfo) => {
  const rep = await makeUser({ role: "sales" });
  const other = await makeUser({ role: "sales" });
  const word = uniqueWord();
  const mine = await makeContact({ owner: rep, name: `Zara ${word}` });
  await makeContact({ owner: other, name: `Yusuf ${word}` });
  const page = await pageFor(rep);
  await page.goto("/today");
  if (testInfo.project.name === "laptop") await page.keyboard.press("Control+k");
  else await page.getByRole("button", { name: "Search" }).click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  const box = dialog.getByRole("combobox");
  await expect(box).toBeFocused();
  await box.fill(word);
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option")).toContainText(mine.name);

  await box.fill(mine.phoneE164.slice(-7));
  await expect(dialog.getByRole("option").first()).toContainText(mine.name);
  await box.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/contacts/${mine.id}$`));
  await expect(dialog).toHaveCount(0);
});

test("search lists screens and says when nothing matches", async ({ pageFor }) => {
  const rep = await makeUser({ role: "sales" });
  const page = await pageFor(rep);
  await page.goto("/contacts");
  await page.getByRole("button", { name: "Search" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await dialog.getByRole("combobox").fill("pipel");
  await dialog.getByRole("option", { name: /Pipeline/ }).click();
  await expect(page).toHaveURL(/\/pipeline$/);

  await page.getByRole("button", { name: "Search" }).first().click();
  await dialog.getByRole("combobox").fill(`nobody ${uniqueWord()}`);
  await expect(dialog).toContainText("Nothing found");
  await dialog.getByRole("button", { name: "Close search" }).click();
  await expect(dialog).toHaveCount(0);
});
