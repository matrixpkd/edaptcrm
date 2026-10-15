import { recordPurchase } from "@/lib/money/purchases";
import { test, expect, makeContact, makeUser } from "./support/fixtures";

// Day one: an empty queue still says what to do next, and a manager's Today shows the money waiting on them.
// Both projects run it (Today is phone-first and used on laptops).

test("an empty queue lists what to do next, and each step opens its screen", async ({ pageFor }) => {
  const rep = await makeUser();
  const page = await pageFor(rep);
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "All clear for today" })).toBeVisible();
  await expect(page.getByText("What to do next")).toBeVisible();
  // a salesperson cannot import
  await expect(page.getByRole("link", { name: /Import your old records/ })).toHaveCount(0);

  await page.getByRole("link", { name: /Go through your contacts/ }).click();
  await expect(page).toHaveURL(/\/contacts\?owner=mine/);
  await page.goto("/today");
  await page.getByRole("link", { name: /^Add a lead/ }).click();
  await expect(page).toHaveURL(/\/contacts\/new$/);
});

test("a manager's Today shows payments waiting for verification and opens the desk", async ({ pageFor }) => {
  const manager = await makeUser({ role: "manager" });
  const contact = await makeContact({ owner: "sales" });
  await recordPurchase(
    {
      contactId: contact.id,
      productName: "First-run workshop",
      family: "workshop",
      amount: 999,
      currency: "INR",
      mode: "upi_qr",
      source: "manual",
      paidNow: { amount: 999, reference: `FR${Date.now()}${Math.floor(Math.random() * 1000)}` },
    },
    { id: manager.id, role: "manager" },
  );

  const page = await pageFor(manager);
  await page.goto("/today");
  const waiting = page.getByRole("navigation", { name: "Waiting on you" });
  const verify = waiting.getByRole("link", { name: /payments? to verify/ });
  await expect(verify).toBeVisible();
  await verify.click();
  await expect(page).toHaveURL(/\/payments\?tab=unverified/);
  await expect(page.getByRole("listitem").filter({ hasText: contact.name })).toBeVisible();
});
