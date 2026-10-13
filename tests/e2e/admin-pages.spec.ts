import { asc, eq } from "drizzle-orm";
import { products, users } from "@/db/schema";
import { test, expect, db } from "./support/fixtures";
import { PEOPLE } from "./support/env";
import type { Page } from "@playwright/test";

// laptop project only (playwright.config.ts)

/**
 * Collects uncaught page errors and console errors while a page is open.
 *
 * Each document is delivered to the browser in one piece. Under the suite's parallel load `next start` streams the
 * HTML in several chunks, and with the JS chunks already cached React (19.1, Next 15.5) can start hydrating a
 * half-parsed document and report a recoverable hydration mismatch (#418) on any page; buffering the document
 * removes that network race while still catching every real server/client difference.
 */
async function watchErrors(page: Page) {
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    await route.fulfill({ response: await route.fetch() });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function expectRenders(page: Page, path: string, errors: string[]) {
  const res = await page.goto(path);
  expect(res?.status(), path).toBe(200);
  await expect(page.locator("h1").first(), path).toBeVisible();
  await expect(page.getByText(/Application error|Something went wrong|This page could not be found/i), path).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(errors, path).toEqual([]);
}

test("the dashboard and the calibration report render for the admin", async ({ pageAs }) => {
  const page = await pageAs("admin");
  const errors = await watchErrors(page);
  await expectRenders(page, "/dashboard", errors);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/dashboard|cockpit/i);
  await expectRenders(page, "/dashboard/calibration", errors);
});

test("every settings page renders for the admin", async ({ pageAs }) => {
  test.setTimeout(120_000);
  const [someone] = await db.select({ id: users.id }).from(users).where(eq(users.email, PEOPLE.sales.email));
  const [product] = await db.select({ id: products.id }).from(products).orderBy(asc(products.name)).limit(1);
  const page = await pageAs("admin");
  const errors = await watchErrors(page);
  const paths = [
    "/settings",
    "/settings/users",
    "/settings/users/new",
    `/settings/users/${someone.id}`,
    "/settings/teams-assignment",
    "/settings/products",
    "/settings/products/new",
    `/settings/products/${product.id}`,
    "/settings/scoring",
    "/settings/currency",
    "/settings/alerts",
    "/settings/lists",
    "/settings/locations",
    "/settings/nbo",
    "/settings/integrations",
    "/settings/export",
    "/settings/audit",
  ];
  for (const path of paths) await expectRenders(page, path, errors);
});

test("the other admin screens render too", async ({ pageAs }) => {
  const page = await pageAs("admin");
  const errors = await watchErrors(page);
  for (const path of ["/today", "/today?view=team", "/contacts", "/payments", "/organisations", "/duplicates", "/import", "/notifications", "/account"]) {
    await expectRenders(page, path, errors);
  }
});

test("a scoring weight change shows at once in the worked-example preview (nothing saved)", async ({ pageAs }) => {
  const page = await pageAs("admin");
  await page.goto("/settings/scoring");
  const preview = page.getByRole("complementary", { name: "Preview and save" });
  const example = preview.getByRole("listitem").filter({ hasText: "New lead: Kerala-city business owner" });
  const badge = example.getByTitle(/^Edapt Score \d+$/);
  const before = Number(/\d+/.exec((await badge.getAttribute("title"))!)![0]);
  await expect(example).not.toContainText("(spec");

  // Umer familiarity is worth 8 points a level; at 4 this lead (Umer 3) loses Readiness
  await page.getByLabel("Points per Umer familiarity level").fill("4");
  await expect(badge).not.toHaveAttribute("title", `Edapt Score ${before}`);
  const after = Number(/\d+/.exec((await badge.getAttribute("title"))!)![0]);
  expect(after).toBeLessThan(before);
  await expect(example).toContainText(`(spec ${before}`);
});
