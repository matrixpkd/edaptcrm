import type { Page } from "@playwright/test";
import { test, expect, expectNoHorizontalScroll, getContact, makeContact, makeUser } from "./support/fixtures";

/**
 * The pipeline board (beyond the spec): columns for the eight lifecycle stages, scoped like the Contacts list; only
 * Qualified, Lost (with a reason) and Reopen can be set, by dragging on a laptop or with Move on a phone.
 */

async function moveWithMenu(page: Page, name: string, target: RegExp | string) {
  await page.locator("[data-contact]").filter({ hasText: name }).getByRole("button", { name: `Move ${name}` }).click();
  const sheet = page.getByRole("dialog", { name: `Move ${name}` });
  await sheet.getByRole("button", { name: target }).click();
}

test("a salesperson sees their own contacts and the pool, and moves a lead to Qualified, Lost and back", async ({ pageFor }, testInfo) => {
  const rep = await makeUser({ role: "sales" });
  const other = await makeUser({ role: "sales" });
  const mine = await makeContact({ owner: rep });
  const theirs = await makeContact({ owner: other });
  const page = await pageFor(rep);
  await page.goto("/pipeline?owner=mine");
  const board = page.getByTestId("pipeline-board");
  await expect(board.getByRole("listitem", { name: /^New: \d+/ })).toBeVisible();
  await expect(page.getByText("You set only")).toBeVisible();
  await expect(board.locator("[data-contact]").filter({ hasText: mine.name })).toBeVisible();
  await expect(page.getByText(theirs.name)).toHaveCount(0);
  if (testInfo.project.name === "phone") await expectNoHorizontalScroll(page);

  await moveWithMenu(page, mine.name, "Qualified");
  await expect(page.getByRole("status").filter({ hasText: `${mine.name} moved to Qualified` })).toBeVisible();
  await expect(page.locator('section[data-stage="qualified"]')).toContainText(mine.name);
  expect((await getContact(mine.id)).stage).toBe("qualified");

  if (testInfo.project.name === "laptop") {
    // drag: while a card is held, a bar offers only the allowed targets, whatever column is scrolled into view
    await page.locator("[data-contact]").filter({ hasText: mine.name }).hover();
    await page.mouse.down();
    await page.mouse.move(600, 400, { steps: 5 });
    await expect(page.getByRole("group", { name: "Drop here" })).toBeVisible();
    await page.locator('[data-drop="lost"]').hover();
    await page.mouse.up();
  } else {
    await moveWithMenu(page, mine.name, "Lost");
  }
  const lost = page.getByRole("dialog", { name: `Why was ${mine.name} lost?` });
  await lost.getByRole("button", { name: "Mark lost" }).click();
  await expect(lost.getByRole("alert")).toHaveText("Choose a reason");
  await lost.getByRole("radio", { name: "Price" }).click();
  await lost.getByRole("button", { name: "Mark lost" }).click();
  await expect(page.locator('section[data-stage="lost"]')).toContainText("Price");
  expect(await getContact(mine.id)).toMatchObject({ stage: "lost", lostReason: "price" });

  await moveWithMenu(page, mine.name, /Reopen/);
  await expect(page.getByRole("status").filter({ hasText: `Reopened: ${mine.name}` })).toBeVisible();
  expect((await getContact(mine.id)).stage).not.toBe("lost");
});

test("support has no board and the filters narrow it", async ({ pageFor }) => {
  const support = await makeUser({ role: "support" });
  const sp = await pageFor(support);
  await sp.goto("/pipeline");
  await expect(sp).toHaveURL(/\/today\?denied=1/);

  const manager = await makeUser({ role: "manager" });
  const rep = await makeUser({ role: "sales" });
  const c = await makeContact({ owner: rep });
  const mp = await pageFor(manager);
  await mp.goto("/pipeline");
  await mp.getByLabel("Owner").selectOption({ value: rep.id });
  await mp.getByRole("button", { name: "Apply" }).click();
  await expect(mp).toHaveURL(new RegExp(`owner=${rep.id}`));
  await expect(mp.locator("[data-contact]")).toHaveCount(1);
  await expect(mp.locator("[data-contact]")).toContainText(c.name);
  await mp.getByRole("link", { name: "Clear" }).click();
  await expect(mp).toHaveURL(/\/pipeline$/);
});
