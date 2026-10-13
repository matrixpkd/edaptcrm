import fs from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { contacts, importBatches } from "@/db/schema";
import { test, expect, db, findContactByPhone, getContact, makeContact, uniquePhone, uniqueWord } from "./support/fixtures";

// laptop project only (playwright.config.ts)

test("upload, map, clean, match, review, commit and undo a small CSV", async ({ pageAs }, testInfo) => {
  test.setTimeout(120_000);
  const city = `Town${uniqueWord(5).toLowerCase()}`;
  // already in the CRM: one by phone (will merge), one by name + city only (conflict)
  const known = await makeContact({ owner: "sales", name: `Known ${uniqueWord()}` });
  const namesake = await makeContact({ owner: "sales", name: `Same ${uniqueWord()}`, profile: { city } });
  const [p1, p2, p3] = [await uniquePhone(), await uniquePhone(), await uniquePhone()];
  const newcomers = [`Anu ${uniqueWord()}`, `Babu ${uniqueWord()}`];
  const knownEmail = `${uniqueWord().toLowerCase()}@example.com`;

  const csv = [
    "Name,Mobile,Email,City",
    `${newcomers[0]},${p1.typed},,Kochi`,
    `${newcomers[1]},${p2.typed},,Kannur`,
    `${known.name},${known.phoneE164},${knownEmail},`,
    `${namesake.name},${p3.typed},,${city}`,
    `Nobody ${uniqueWord()},12345,,Kollam`,
  ].join("\n");
  const file = testInfo.outputPath("e2e-import.csv");
  fs.writeFileSync(file, csv + "\n");

  const page = await pageAs("admin");
  page.on("dialog", (d) => void d.accept());

  // 1. upload
  await page.goto("/import");
  await page.locator("label").filter({ hasText: "Other sheet or document" }).click();
  await page.locator('input[type="file"][name="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "Upload and map columns" }).click();
  await expect(page).toHaveURL(/\/import\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const batchId = /\/import\/([0-9a-f-]{36})/.exec(page.url())![1];

  // 2. map: the keyword rules propose the columns; check them and go on
  await expect(page.getByLabel("Imports Mobile as")).toHaveValue("phone");
  await expect(page.getByLabel("Imports Name as")).toHaveValue("name");
  await page.getByLabel("First door for new contacts").selectOption({ label: "Other" });
  await page.getByRole("button", { name: "Save and clean rows" }).click();

  // 3-4. clean and match run by themselves, then 5. review
  await expect(page.getByText(/Ready to commit|ready to commit/).first()).toBeVisible({ timeout: 60_000 });
  const tile = (view: string) => page.locator(`a[href$="/import/${batchId}?view=${view}"]`).first();
  await expect(tile("new")).toContainText(/New\s*2/);
  await expect(tile("merge")).toContainText(/Will merge\s*1/);
  await expect(tile("conflict")).toContainText(/Conflict\s*1/);
  await expect(tile("invalid")).toContainText(/Invalid\s*1/);

  // the conflict must be decided before committing: treat it as a new person
  await expect(page.getByRole("button", { name: "Commit import" })).toBeDisabled();
  await page.getByRole("button", { name: "All conflicts → new" }).click();
  await expect(page.getByRole("heading", { name: /^Ready to commit 4 rows/ })).toBeVisible();

  // 6. commit
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(page.getByRole("heading", { name: /^Committed/ })).toBeVisible({ timeout: 60_000 });
  const created = [await findContactByPhone(p1.e164), await findContactByPhone(p2.e164), await findContactByPhone(p3.e164)];
  expect(created.map((c) => c?.name)).toEqual([...newcomers, namesake.name]);
  expect(created.every((c) => c?.importBatchId === batchId)).toBe(true);
  expect((await getContact(known.id)).email).toBe(knownEmail);
  await page.goto(`/contacts?q=${encodeURIComponent(newcomers[0])}`);
  await expect(page.getByRole("link", { name: newcomers[0] }).first()).toBeVisible();

  // undo: the new contacts go, the merged contact is put back as it was
  await page.goto(`/import/${batchId}`);
  await page.getByRole("button", { name: "Undo import" }).click();
  await expect(page.getByRole("heading", { name: /^Undone/ })).toBeVisible({ timeout: 60_000 });
  const ids = created.map((c) => c!.id);
  expect(await db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, ids))).toHaveLength(0);
  expect((await getContact(known.id)).email).toBeNull();
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  expect(batch.status).toBe("undone");
});
