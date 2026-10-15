import { logInteraction } from "@/lib/contacts/interactions";
import { test, expect, makeContact, makeUser } from "./support/fixtures";

/** Team activity (beyond the spec): managers see who did what, newest first; salespeople have no such page. */

test("a manager sees a salesperson's calls and leads, filtered by person and kind", async ({ pageFor }, testInfo) => {
  const manager = await makeUser({ role: "manager" });
  const rep = await makeUser({ role: "sales" });
  const c = await makeContact({ owner: rep });
  await logInteraction(c.id, { type: "call", outcome: "interested" }, { id: rep.id, role: "sales" });
  const page = await pageFor(manager);
  await page.goto("/today");
  if (testInfo.project.name === "phone") await page.getByRole("button", { name: "Menu" }).click();
  await page.locator('a[href="/activity"]:visible').first().click();
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await page.getByLabel("Person").selectOption({ value: rep.id });
  await page.getByRole("button", { name: "Show" }).click();
  const feed = page.getByRole("list", { name: "Team activity" });
  await expect(feed).toContainText(`${rep.name} logged a call with ${c.name}`);
  await expect(feed).toContainText(`${rep.name} added the lead ${c.name}`);
  await page.getByRole("link", { name: "Leads added" }).click();
  await expect(feed).not.toContainText("logged a call");
  await expect(feed).toContainText("added the lead");
  await feed.getByRole("link", { name: c.name }).first().click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${c.id}$`));

  const rp = await pageFor(rep);
  await rp.goto("/activity");
  await expect(rp).toHaveURL(/\/today\?denied=1/);
});
