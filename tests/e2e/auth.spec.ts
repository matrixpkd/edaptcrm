import { test, expect } from "./support/fixtures";
import { PASSWORD, PEOPLE } from "./support/env";

// signed-out browsers: no saved session
test.use({ storageState: { cookies: [], origins: [] } });

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("signs in and lands on Today", async ({ page }) => {
  await page.goto("/login");
  await signIn(page, PEOPLE.admin.email, PASSWORD);
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Umer");
});

test("a wrong password says so and stays on the sign-in page", async ({ page }) => {
  await page.goto("/login");
  await signIn(page, PEOPLE.admin.email, "not-the-password");
  await expect(page.getByText("That email and password don't match.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("signing out ends the session", async ({ page, isMobile }) => {
  await page.goto("/login");
  await signIn(page, PEOPLE.sales.email, PASSWORD);
  await expect(page).toHaveURL(/\/today$/);
  const cookies = await page.context().cookies();
  if (isMobile) await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  // the old cookie, put back, no longer opens anything: the session is gone on the server
  await page.context().addCookies(cookies);
  await page.goto("/contacts");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a signed-out visit goes to sign-in with ?next= and comes back after", async ({ page }) => {
  await page.goto("/contacts?q=asha");
  await expect(page).toHaveURL(/\/login\?next=%2Fcontacts%3Fq%3Dasha$/);
  await signIn(page, PEOPLE.manager.email, PASSWORD);
  await expect(page).toHaveURL(/\/contacts\?q=asha$/);
  await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();
});

test("/setup sends people to sign-in once a user exists", async ({ page }) => {
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
