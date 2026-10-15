import { randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { payments, purchases, users } from "@/db/schema";
import { formatINR } from "@/lib/utils";
import { test, expect, db, getContact, makeContact, userId } from "./support/fixtures";
import type { Page } from "@playwright/test";

// laptop project only (playwright.config.ts)

/** A real 1x1 PNG: the bank screenshot. */
const PROOF = {
  name: "utr-screenshot.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
};

function newUtr() {
  return `UTR${Date.now().toString().slice(-8)}${randomInt(1000, 9999)}`;
}

/** Fills Record payment for the first product in the catalogue, paid by bank transfer, and saves. */
async function recordBankTransfer(page: Page, contactId: string, utr: string, opts: { amount?: string; proof?: boolean } = {}) {
  await page.goto(`/contacts/${contactId}/payment`);
  const product = page.getByLabel(/^Product/);
  const first = await product.locator("optgroup option").first().getAttribute("value");
  await product.selectOption(first!);
  if (opts.amount) await page.getByLabel(/^Final amount/).fill(opts.amount);
  await page.locator("label").filter({ hasText: /^Bank transfer$/ }).click();
  await page.getByLabel(/^UTR/).fill(utr);
  if (opts.proof !== false) await page.getByLabel(/^Proof/).setInputFiles(PROOF);
  await page.getByRole("button", { name: "Record payment" }).click();
}

test("a bank transfer counts toward LTV only once verified; duplicate UTRs are refused; refunds lower LTV", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales" });
  const other = await makeContact({ owner: "sales" });
  const utr = newUtr();
  const sales = await pageAs("sales");

  // sales records the transfer with its UTR and the screenshot
  await recordBankTransfer(sales, contact.id, utr, { amount: "4999" });
  await expect(sales).toHaveURL(/\/payments\/[0-9a-f-]{36}/);
  await expect(sales.getByText("Payment recorded. It counts toward LTV once a manager verifies it.")).toBeVisible();
  const purchaseId = /\/payments\/([0-9a-f-]{36})/.exec(sales.url())![1];
  const [payment] = await db.select().from(payments).where(eq(payments.purchaseId, purchaseId));
  expect(payment).toMatchObject({ status: "unverified", reference: utr, mode: "bank_transfer", amountInr: 4999 });
  expect(payment.proofUrl).toMatch(/^\/api\/files\/proofs\//);
  // the proof is stored and opens for the salesperson
  const proof = await sales.request.get(payment.proofUrl!);
  expect(proof.status()).toBe(200);

  // LTV is unchanged until a manager verifies
  expect((await getContact(contact.id)).ltvInr).toBe(0);
  await sales.goto(`/contacts/${contact.id}`);
  await expect(sales.getByText("LTV", { exact: true }).locator("..")).toContainText(formatINR(0));

  // the same UTR again (any contact) is refused with a plain message
  await recordBankTransfer(sales, other.id, utr, { amount: "999", proof: false });
  await expect(sales.getByText(`This UTR (${utr}) is already recorded on ${contact.name}.`).first()).toBeVisible();
  expect(await db.select().from(payments).where(eq(payments.reference, utr))).toHaveLength(1);

  // the manager finds it under Unverified and verifies it
  const manager = await pageAs("manager");
  await manager.goto("/payments");
  await expect(manager.getByRole("link", { name: "Unverified", exact: false }).first()).toBeVisible();
  const row = manager.getByRole("listitem").filter({ hasText: contact.name });
  await expect(row).toContainText(utr);
  await row.getByRole("button", { name: "Verify" }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await getContact(contact.id)).ltvInr).toBe(4999);
  await manager.goto(`/contacts/${contact.id}`);
  await expect(manager.getByText("LTV", { exact: true }).locator("..")).toContainText(formatINR(4999));

  // a refund lowers it again
  await manager.goto(`/payments/${purchaseId}`);
  await manager.getByRole("button", { name: "Record refund" }).click();
  const sheet = manager.getByRole("dialog");
  await sheet.getByLabel(/^Amount refunded/).fill("1000");
  await sheet.getByLabel(/^Reason/).fill("Could not attend the second day");
  await sheet.getByRole("button", { name: "Record refund" }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(async () => (await getContact(contact.id)).ltvInr).toBe(3999);
  await manager.goto(`/contacts/${contact.id}`);
  await expect(manager.getByText("LTV", { exact: true }).locator("..")).toContainText(formatINR(3999));
});

test("an AED purchase shows and stores its INR value at the month's rate", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "manager", country: "AE" });
  const page = await pageAs("manager");
  await page.goto(`/contacts/${contact.id}/payment`);
  const product = page.getByLabel(/^Product/);
  await product.selectOption((await product.locator("optgroup option").first().getAttribute("value"))!);
  await page.getByLabel(/^Currency/).selectOption("AED");
  await page.getByLabel(/^Final amount/).fill("1000");

  const live = page.locator("#rp-inr");
  await expect(live).toContainText(/≈ ₹[\d,]+ at ₹[\d.]+ per AED/);
  const [, inrText, rateText] = /≈ ₹([\d,]+) at ₹([\d.]+) per AED/.exec((await live.textContent())!)!;
  const rate = Number(rateText);
  expect(rate).toBeGreaterThan(10);
  expect(Number(inrText.replace(/,/g, ""))).toBe(Math.round(1000 * rate));

  await page.locator("label").filter({ hasText: /^Cash$/ }).click();
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}/);
  const purchaseId = /\/payments\/([0-9a-f-]{36})/.exec(page.url())![1];
  await expect(page.getByText(`${formatINR(1000 * rate)} at ₹${rate} per AED`)).toBeVisible();
  const [p] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
  expect(p).toMatchObject({ currency: "AED", amount: 1000, fxRate: rate, amountInr: 1000 * rate });
});

test("a typed list price or discount that is not a number is refused, not silently dropped", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales" });
  const page = await pageAs("sales");
  await page.goto(`/contacts/${contact.id}/payment`);
  const product = page.getByLabel(/^Product/);
  await product.selectOption((await product.locator("optgroup option").first().getAttribute("value"))!);
  await page.getByLabel(/^List price/).fill("abc");
  await page.getByLabel(/^Discount/).fill("ten");
  await page.getByLabel(/^Final amount/).fill("999");
  await page.locator("label").filter({ hasText: /^Cash$/ }).click();
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Enter the list price as a number, or leave it empty.")).toBeVisible();
  await expect(page.getByText("Enter the discount as a number, or leave it empty.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/contacts/${contact.id}/payment$`));
  expect(await db.select().from(purchases).where(eq(purchases.contactId, contact.id))).toHaveLength(0);
});

test("an instalment paid later shows who took the payment, not who set up the schedule", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales" });
  const sales = await pageAs("sales");
  await sales.goto(`/contacts/${contact.id}/payment`);
  const product = sales.getByLabel(/^Product/);
  await product.selectOption((await product.locator("optgroup option").first().getAttribute("value"))!);
  await sales.getByLabel(/^Final amount/).fill("6000");
  await sales.locator("label").filter({ hasText: /^Bank transfer$/ }).click();
  await sales.getByRole("switch").check({ force: true });
  await sales.getByLabel("Instalments", { exact: true }).selectOption("2");
  await sales.getByLabel(/first instalment is paid now/).uncheck();
  await sales.getByRole("button", { name: "Save purchase and schedule" }).click();
  await expect(sales).toHaveURL(/\/payments\/[0-9a-f-]{36}/);
  const purchaseId = /\/payments\/([0-9a-f-]{36})/.exec(sales.url())![1];

  const manager = await pageAs("manager");
  const managerId = await userId("manager");
  const [{ name: managerName }] = await db.select({ name: users.name }).from(users).where(eq(users.id, managerId));
  await manager.goto(`/payments/${purchaseId}`);
  await manager.getByRole("button", { name: "Record payment" }).first().click();
  const sheet = manager.getByRole("dialog");
  await sheet.locator("label").filter({ hasText: /^UPI QR$/ }).click();
  await sheet.getByLabel(/^UTR/).fill(newUtr());
  await sheet.getByRole("button", { name: "Save payment" }).click();
  await expect(sheet).toBeHidden();
  const paid = manager.getByRole("listitem").filter({ hasText: /^No proof\s*Instalment 1/ });
  await expect(paid).toContainText(`Recorded by ${managerName}`);
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.purchaseId, purchaseId), eq(payments.status, "unverified")));
  expect(row.createdById).toBe(managerId);
});
