import { test, expect, getContact, makeContact } from "./support/fixtures";

// phone project only (playwright.config.ts)

test("choosing scales updates the live preview, and saving changes the grade and score on the contact page", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales" });
  expect(contact.edaptScore).not.toBeNull();
  const page = await pageAs("sales");
  await page.goto(`/contacts/${contact.id}`);
  await page.getByRole("link", { name: "Rate", exact: true }).tap();
  await expect(page).toHaveURL(new RegExp(`/contacts/${contact.id}/rate$`));
  await expect(page.getByRole("heading", { name: "Rate customer" })).toBeVisible();

  // the phone layout's live preview (the laptop card is hidden at this width)
  const live = page.getByText(/^Edapt Score \d+, grade [ABCD]/).first();
  await expect(live).toHaveText(`Edapt Score ${contact.edaptScore}, grade ${contact.grade}`);

  const pick = async (legend: string, text: string | RegExp) => {
    await page.getByRole("group", { name: legend }).locator("label").filter({ hasText: text }).tap();
  };
  const read = async () => {
    const m = /^Edapt Score (\d+), grade ([ABCD])/.exec((await live.textContent()) ?? "");
    return { score: Number(m![1]), grade: m![2] };
  };

  await pick("Umer familiarity", "Follows closely");
  await expect(live).toContainText(`was ${contact.edaptScore} (${contact.grade})`);
  const afterOne = await read();
  expect(afterOne.score).toBeGreaterThan(contact.edaptScore!);

  await pick("AI knowledge", "Uses AI every week");
  await pick("Spending power", "High");
  await pick("Age band", /^35 to 44$/);
  await pick("Industry or role", /^Business owner$/);
  await page.getByRole("radio", { name: "5 stars" }).tap();
  await expect.poll(async () => (await read()).score).toBeGreaterThan(afterOne.score);
  const preview = await read();
  expect(preview.grade).toBe("A");

  await page.getByRole("textbox", { name: /^Notes/ }).fill("Runs three supermarkets, wants AI for stock control");
  await page.getByRole("button", { name: "Save rating" }).tap();

  await expect(page).toHaveURL(new RegExp(`/contacts/${contact.id}$`));
  await expect(page.getByTitle(`Edapt Score ${preview.score}`)).toHaveText(`${preview.grade}${preview.score}`);
  const saved = await getContact(contact.id);
  expect(saved).toMatchObject({ edaptScore: preview.score, grade: preview.grade, umerLevel: 4, aiLevel: 3, spendingBand: 5, gutStars: 5 });
  expect(saved.edaptScore).not.toBe(contact.edaptScore);
});
