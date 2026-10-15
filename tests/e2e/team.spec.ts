import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { contacts, users } from "@/db/schema";
import { getOnboarding } from "@/lib/admin/onboarding";
import { test, expect, db, makeContact, makeUser, uniqueName, uniqueWord } from "./support/fixtures";
import { PEOPLE } from "./support/env";

/**
 * First run and team administration, as a brand-new owner meets them: the "Getting started" checklist on Today,
 * Team in the main navigation, adding a teammate (temporary password shown once, with a message to send), that
 * teammate signing in, reset, deactivate with handover, and "Forgot password?" on the sign-in page.
 */

async function openTeam(page: Page, isMobile: boolean) {
  await page.goto("/today");
  if (isMobile) await page.getByRole("button", { name: "Menu" }).click();
  // the main navigation's Team (Today also has a "Mine | Team" queue toggle)
  await page.locator('a[href="/team"]:visible').first().click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByRole("heading", { name: "Team", level: 1 })).toBeVisible();
}

test("a new admin sees the getting started checklist on Today, can hide it and bring it back from Settings", async ({ pageFor }) => {
  const admin = await makeUser({ role: "admin" });
  const page = await pageFor(admin);
  // whole documents at once (see watchErrors in admin-pages.spec.ts: a streamed document under parallel load can
  // start hydrating half-parsed and report a recoverable #418 that is not a real server/client difference)
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    await route.fulfill({ response: await route.fetch() });
  });
  const errors: string[] = [];
  // React #418 (a recoverable hydration retry) also shows on a few percent of loads of untouched pages in a production
  // build at the base commit, with or without this checklist; it is tracked separately. Everything else fails the test.
  page.on("pageerror", (e) => {
    if (!e.message.includes("Minified React error #418")) errors.push(e.message);
  });
  const onboarding = await getOnboarding();
  test.skip(onboarding.complete, "every set-up step is already done in this database");

  await page.goto("/today");
  const checklist = page.getByRole("region", { name: "Getting started" });
  await expect(checklist).toBeVisible();
  await expect(checklist).toContainText(/\d of 6 done/);
  for (const title of ["Add your team", "Set your real product prices", "Set teams and lead assignment", "Connect TagMango, Libromi and Pabbly", "Import your old data", "Set currency rates"]) {
    await expect(checklist.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  }
  await checklist.getByRole("link", { name: /Set currency rates/ }).click();
  await expect(page).toHaveURL(/\/settings\/currency$/);

  await page.goto("/today");
  await page.getByRole("button", { name: "Hide the getting started checklist" }).click();
  await expect(checklist).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByRole("region", { name: "Getting started" })).toBeVisible();
  await page.getByRole("button", { name: "Show this checklist on Today again" }).click();
  // the button goes once the action has run
  await expect(page.getByRole("button", { name: "Show this checklist on Today again" })).toHaveCount(0);
  await page.goto("/today");
  await expect(checklist).toBeVisible();
  expect(errors).toEqual([]);
});

test("the admin adds a teammate from Team; the temporary password and a ready message are shown once, and it signs them in", async ({ pageAs, browser, isMobile }, testInfo) => {
  const page = await pageAs("admin");
  await openTeam(page, isMobile);
  await page.getByRole("link", { name: "Add teammate" }).click();
  await expect(page).toHaveURL(/\/team\/new$/);

  const name = uniqueName("Mate");
  const email = `e2e-mate-${uniqueWord().toLowerCase()}@e2e.test`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("combobox", { name: "Role" }).selectOption("sales");
  await page.getByRole("combobox", { name: "Team" }).selectOption("dubai");
  await page.getByRole("button", { name: "Add teammate" }).click();

  const password = (await page.getByTestId("temp-password").textContent())!.trim();
  expect(password).toMatch(/^\w{4}-\w{4}-\w{4}-\w{4}$/);
  const message = page.getByTestId("invite-message");
  await expect(message).toContainText(`${email}`);
  await expect(message).toContainText(password);
  await expect(message).toContainText("/login");
  await expect(page.getByRole("link", { name: "Send on WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);

  // the same email again is refused, next to the field
  await page.getByRole("button", { name: "Add another" }).click();
  await page.getByLabel("Name").fill(uniqueName("Dup"));
  await page.getByLabel("Email").fill(email.toUpperCase());
  await page.getByRole("button", { name: "Add teammate" }).click();
  await expect(page.getByText("Someone already uses that email")).toBeVisible();

  // the new teammate signs in with the temporary password and gets the salesperson's menu
  const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: testInfo.project.use.viewport, serviceWorkers: "block" });
  const theirs = await ctx.newPage();
  await theirs.goto("/login");
  await theirs.getByLabel("Email").fill(email);
  await theirs.getByLabel("Password").fill(password);
  await theirs.getByRole("button", { name: "Sign in" }).click();
  await expect(theirs).toHaveURL(/\/today$/);
  await theirs.goto("/team");
  await expect(theirs).toHaveURL(/\/today\?denied=1$/);
  await ctx.close();
});

test("the admin resets a password and deactivates a leaver, whose contacts move to the chosen person", async ({ pageAs, pageFor }) => {
  test.skip(test.info().project.name === "phone", "desk flow, run on the laptop");
  const leaver = await makeUser({ role: "sales", name: uniqueName("Leaver") });
  const contact = await makeContact({ owner: leaver });
  const page = await pageAs("admin");
  page.on("dialog", (d) => d.accept());
  await page.goto(`/team/${leaver.id}`);
  await expect(page.getByText("Contacts owned")).toBeVisible();

  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByTestId("temp-password")).toBeVisible();
  await expect(page.getByTestId("invite-message")).toContainText("password was reset");

  const form = page.getByRole("form", { name: "Deactivate" });
  const receiver = form.getByLabel("Who receives their contacts?");
  await receiver.selectOption((await receiver.locator("option", { hasText: PEOPLE.manager.name }).getAttribute("value"))!);
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: /Deactivate and hand over/ }).click();
  await expect(page.getByText(`${leaver.name} is deactivated and signed out everywhere. 1 contact moved`)).toBeVisible();
  const [after] = await db.select({ ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, contact.id));
  const [manager] = await db.select({ id: users.id }).from(users).where(eq(users.email, PEOPLE.manager.email));
  expect(after.ownerId).toBe(manager.id);

  // a deactivated person's old session no longer works
  const theirs = await pageFor(leaver);
  await theirs.goto("/today");
  await expect(theirs).toHaveURL(/\/login/);

  await page.getByRole("button", { name: /Reactivate/ }).click();
  await expect(page.getByText("Reactivated.")).toBeVisible();
});

test("a manager sees the team read-only; sales and support do not get Team", async ({ pageAs, isMobile }) => {
  const manager = await pageAs("manager");
  await openTeam(manager, isMobile);
  await expect(manager.getByRole("link", { name: "Add teammate" })).toHaveCount(0);
  await manager.goto("/team/new");
  await expect(manager).toHaveURL(/\/today\?denied=1$/);

  for (const role of ["sales", "support"] as const) {
    const page = await pageAs(role);
    await page.goto("/today");
    if (isMobile) await page.getByRole("button", { name: "Menu" }).click();
    await expect(page.locator('a[href="/team"]:visible')).toHaveCount(0);
  }
});

test("old Settings → Users links land on Team", async ({ pageAs }) => {
  const page = await pageAs("admin");
  await page.goto("/settings/users");
  await expect(page).toHaveURL(/\/team$/);
  await page.goto("/settings/users/new");
  await expect(page).toHaveURL(/\/team\/new$/);
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Forgot password? explains how to get a new one", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot$/);
    // e2e runs without email (RESEND_API_KEY is empty): an admin resets it
    await expect(page.getByText("Ask an admin to reset it")).toBeVisible();
    await expect(page.getByText(/Team → your name → Reset password/)).toBeVisible();
    await page.goto("/reset?token=not-a-real-reset-token-at-all");
    await expect(page.getByText("This reset link is not valid.")).toBeVisible();
  });
});
