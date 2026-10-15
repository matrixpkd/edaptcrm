import { test, expect, expectNoHorizontalScroll, expectTapTarget, makeContact, makeTask, makeUser } from "./support/fixtures";

// The five screens the team uses all day are designed for a 390px phone first
// phone project only (playwright.config.ts)

test.beforeEach(async ({ page }) => {
  expect(page.viewportSize()?.width).toBe(390);
});

test("Today fits the phone and its row actions are easy to tap", async ({ pageFor }) => {
  const rep = await makeUser();
  const a = await makeContact({ owner: rep, name: "Layout Checkout Longname Kunjumuhammed Vattaparambil" });
  const b = await makeContact({ owner: rep });
  await makeTask({ userId: rep.id, contactId: a.id, type: "abandoned_checkout", reason: "Started paying for The AI Office Dubai October 2026 (AED 2,499) an hour ago and did not finish the payment" });
  await makeTask({ userId: rep.id, contactId: b.id, type: "follow_up", reason: "Follow-up you set after a call: send the brochure" });

  const page = await pageFor(rep);
  await page.goto("/today");
  await expect(page.locator("main ol > li")).toHaveCount(2);
  await expectNoHorizontalScroll(page);
  const row = page.locator("main ol > li").first();
  await expectTapTarget(row.getByRole("link", { name: /^Call / }));
  await expectTapTarget(row.getByRole("link", { name: /^WhatsApp / }));
  await expectTapTarget(row.getByRole("button", { name: "Done" }));
  await expectTapTarget(row.getByRole("button", { name: "Snooze" }));
  await expectTapTarget(row.getByRole("link", { name: /^Log an interaction/ }));
  // the bottom bar
  const bar = page.getByRole("navigation").last();
  for (const name of ["Today", "Contacts", "Quick Add"]) await expectTapTarget(bar.getByRole("link", { name }));
});

test("Quick Add fits the phone with big fields and a visible Save", async ({ pageAs }) => {
  const page = await pageAs("sales");
  await page.goto("/contacts/new");
  await expectNoHorizontalScroll(page);
  await expectTapTarget(page.getByRole("textbox", { name: /^Phone/ }));
  await expectTapTarget(page.getByRole("textbox", { name: /^Name/ }));
  for (const chip of await page.getByRole("radiogroup", { name: "Most used channels" }).getByRole("radio").all()) await expectTapTarget(chip);
  await expectTapTarget(page.getByLabel("First door"));
  const save = page.getByRole("button", { name: "Save contact" });
  await save.scrollIntoViewIfNeeded();
  await expectTapTarget(save);
  // the optional fields open without breaking the width
  await page.getByRole("button", { name: /^More/ }).tap();
  await expectNoHorizontalScroll(page);
});

test("the contact page fits the phone and its actions are easy to tap", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales", name: "Layout Abdurahiman Puthenpurayil Muhammedkutty" });
  const page = await pageAs("sales");
  await page.goto(`/contacts/${contact.id}`);
  await expectNoHorizontalScroll(page);
  for (const name of ["Call", "WhatsApp", "Log", "Rate", "Record payment", "Edit"]) {
    // WhatsApp is a button when message templates exist (it asks which message to start with)
    const link = name === "WhatsApp" ? page.getByRole("button", { name, exact: true }) : page.getByRole("link", { name, exact: true });
    await expect(link).toBeInViewport();
    await expectTapTarget(link);
  }
  for (const tab of ["Timeline", "Purchases", "Ratings", "Referrals", "Details"]) {
    await expectTapTarget(page.getByRole("link", { name: new RegExp(`^${tab}`) }).first(), 36);
  }
});

test("Log interaction fits the phone with Save always on screen", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales" });
  const page = await pageAs("sales");
  await page.goto(`/contacts/${contact.id}/log`);
  await expectNoHorizontalScroll(page);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeInViewport();
  await expectTapTarget(save);
  for (const group of ["Type", "Next follow-up"]) {
    const chips = page.getByRole("group", { name: group }).locator("label");
    for (const chip of await chips.all()) await expectTapTarget(chip);
  }
  await expectTapTarget(page.getByRole("group", { name: /^Outcome/ }).locator("label").first());
  await expectTapTarget(page.getByRole("link", { name: "Close" }));
  // choosing "Pick a date" adds a field without widening the page
  await page.locator("label").filter({ hasText: /^Pick a date$/ }).tap();
  await expectTapTarget(page.getByLabel(/^Follow-up date/));
  await expectNoHorizontalScroll(page);
  await expect(save).toBeInViewport();
});

test("Rate customer fits the phone with the preview and Save always on screen", async ({ pageAs }) => {
  const contact = await makeContact({ owner: "sales" });
  const page = await pageAs("sales");
  await page.goto(`/contacts/${contact.id}/rate`);
  await expectNoHorizontalScroll(page);
  const save = page.getByRole("button", { name: /rating/i });
  await expect(save).toBeInViewport();
  await expectTapTarget(save);
  for (const group of ["AI knowledge", "Umer familiarity", "Spending power"]) {
    for (const row of await page.getByRole("group", { name: group }).locator("label").all()) await expectTapTarget(row);
  }
  for (const star of await page.getByRole("radiogroup", { name: "Gut rating" }).getByRole("radio").all()) await expectTapTarget(star);
  await page.getByRole("group", { name: "Spending power" }).locator("label").filter({ hasText: "Middle" }).first().tap();
  await expect(page.getByText(/^Edapt Score \d+, grade [ABCD]/).first()).toBeAttached();
  await expect(save).toBeInViewport();
  await expectNoHorizontalScroll(page);
});
