import { eq } from "drizzle-orm";
import { tasks } from "@/db/schema";
import { test, expect, db, makeContact, openTasks, uniqueWord } from "./support/fixtures";

// phone project only (playwright.config.ts)

test("Call and WhatsApp open the dialler and WhatsApp; coming back from a call opens Log interaction", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales" });
  const page = await pageAs("sales");
  await page.goto(`/contacts/${contact.id}`);

  const call = page.getByRole("link", { name: "Call", exact: true });
  const whatsapp = page.getByRole("link", { name: "WhatsApp", exact: true });
  await expect(call).toHaveAttribute("href", `tel:${contact.phoneE164}`);
  await expect(whatsapp).toHaveAttribute("href", `https://wa.me/${contact.phoneE164.slice(1)}`);
  await expect(whatsapp).toHaveAttribute("target", "_blank");

  // the tap hands over to the dialler (the page stays put in a browser without one)...
  await page.evaluate(() => {
    document.addEventListener("click", (e) => (e.target as Element).closest('a[href^="tel:"]') && e.preventDefault(), { once: true });
  });
  await call.tap();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // ...and the person comes back after the call (anything under 1.5 s counts as the dialler still opening)
  await page.waitForTimeout(1700);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(page).toHaveURL(new RegExp(`/contacts/${contact.id}/log\\?type=call&fromCall=1`));
  await expect(page.getByRole("heading", { name: "How did the call go?" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Call", exact: true })).toBeChecked();
});

test("logging a call with an outcome and a 3-day follow-up shows on the timeline and on the owner's Today when due", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales" });
  const note = `Wants the weekend batch ${uniqueWord()}`;
  const page = await pageAs("sales");
  await page.goto(`/contacts/${contact.id}`);
  await page.getByRole("link", { name: "Log", exact: true }).tap();

  await expect(page).toHaveURL(new RegExp(`/contacts/${contact.id}/log$`));
  await expect(page.getByRole("heading", { name: "Log interaction" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Call", exact: true })).toBeChecked();
  await page.locator("label").filter({ hasText: /^Interested$/ }).tap();
  await page.locator("label").filter({ hasText: /^3 days$/ }).tap();
  await expect(page.getByRole("radio", { name: "3 days" })).toBeChecked();
  await expect(page.getByText(/^On your Today list/)).toBeVisible();
  await page.getByRole("textbox", { name: /^Note/ }).fill(note);
  await page.getByRole("button", { name: "Save", exact: true }).tap();

  // back on the contact page: the call is on the timeline with its outcome, note and follow-up
  await expect(page).toHaveURL(new RegExp(`/contacts/${contact.id}$`));
  const timeline = page.getByRole("list", { name: "Timeline" });
  const entry = timeline.locator("li").filter({ hasText: note });
  await expect(entry).toContainText("Call · Interested");
  await expect(entry).toContainText("Follow-up");

  // the follow-up task is the owner's, due in 3 days at 10:00 their time
  const [task] = await openTasks(contact.id, ["follow_up"]);
  expect(task.userId).toBe(contact.ownerId);
  const days = (task.dueAt.getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(2);
  expect(days).toBeLessThan(4);

  // not on Today yet; once it falls due it is
  await page.goto("/today");
  await expect(page.getByRole("link", { name: contact.name, exact: true })).toHaveCount(0);
  await db.update(tasks).set({ dueAt: new Date(Date.now() - 60_000) }).where(eq(tasks.id, task.id));
  await page.reload();
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: contact.name, exact: true }) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`Follow-up you set after a call: ${note}`);
});
