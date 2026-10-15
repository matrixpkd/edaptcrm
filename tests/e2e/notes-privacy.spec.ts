import { eq } from "drizzle-orm";
import { settings } from "@/db/schema";
import { test, expect, db, getContact, makeContact, makeUser, uniqueWord } from "./support/fixtures";

/**
 * On a contact (beyond the spec): quick notes with one pinned note at the top, WhatsApp message templates, marketing
 * consent in one tap, and an admin erasing a person's data on request.
 */

test("a salesperson adds a note, pins it to the top and unpins it", async ({ pageFor }) => {
  const rep = await makeUser({ role: "sales" });
  const c = await makeContact({ owner: rep });
  const page = await pageFor(rep);
  await page.goto(`/contacts/${c.id}`);
  const form = page.getByRole("form", { name: "Add a note" });
  const text = `Only call after 6 pm ${uniqueWord()}`;
  await form.getByRole("textbox", { name: "Note" }).fill(text);
  await form.getByText("Pin to the top").click();
  await form.getByRole("button", { name: "Add note" }).click();
  const pinned = page.getByRole("region", { name: "Pinned note" });
  await expect(pinned).toContainText(text);
  // the note is on the timeline too, and the lead is still New (a note is not a call)
  await expect(page.getByRole("main")).toContainText(text);
  expect((await getContact(c.id)).stage).toBe("new");
  await pinned.getByRole("button", { name: "Unpin this note" }).click();
  await expect(pinned).toHaveCount(0);
  await page.getByRole("button", { name: "Pin this note to the top" }).first().click();
  await expect(page.getByRole("region", { name: "Pinned note" })).toContainText(text);
});

test("WhatsApp offers the admin's templates filled in for the contact", async ({ pageFor }) => {
  const admin = await makeUser({ role: "admin" });
  const rep = await makeUser({ role: "sales" });
  const c = await makeContact({ owner: rep });
  const ap = await pageFor(admin);
  const before = await db.select().from(settings).where(eq(settings.key, "templates.whatsapp"));
  try {
    await ap.goto("/settings/templates");
    await ap.getByRole("button", { name: "Add template" }).click();
    const last = ap.locator(`li[aria-label^="Template"]`).last();
    const name = `Workshop reminder ${uniqueWord()}`;
    await last.getByLabel("Name").fill(name);
    await last.getByLabel("Message").fill("Hi {first_name}, see you at the workshop! {price}");
    await expect(last).toContainText("Unknown placeholder: {price}");
    await last.getByLabel("Message").fill("Hi {first_name}, see you at the workshop! – {owner}");
    await expect(last).toContainText("Hi Priya, see you at the workshop! – Asha");
    await ap.getByRole("button", { name: "Save templates" }).click();
    await expect(ap.getByRole("status").filter({ hasText: "Templates saved." })).toBeVisible();

    const page = await pageFor(rep);
    await page.goto(`/contacts/${c.id}`);
    await page.getByRole("button", { name: "WhatsApp" }).click();
    const sheet = page.getByRole("dialog", { name: `WhatsApp ${c.name}` });
    const link = sheet.getByRole("link", { name: new RegExp(name) });
    const href = decodeURIComponent((await link.getAttribute("href")) ?? "");
    expect(href).toBe(`https://wa.me/${c.phoneE164.slice(1)}?text=Hi ${c.name.split(" ")[0]}, see you at the workshop! – ${rep.name}`);
    await expect(sheet.getByRole("link", { name: "Open the chat without a message" })).toHaveAttribute("href", `https://wa.me/${c.phoneE164.slice(1)}`);

    // {owner} is whoever sends it: an admin opening the rep's contact signs with their own name, not the rep's
    await ap.goto(`/contacts/${c.id}`);
    await ap.getByRole("button", { name: "WhatsApp" }).click();
    const adminLink = ap.getByRole("dialog", { name: `WhatsApp ${c.name}` }).getByRole("link", { name: new RegExp(name) });
    expect(decodeURIComponent((await adminLink.getAttribute("href")) ?? "")).toBe(
      `https://wa.me/${c.phoneE164.slice(1)}?text=Hi ${c.name.split(" ")[0]}, see you at the workshop! – ${admin.name}`,
    );
  } finally {
    // leave the shared setting as it was for other specs
    if (before[0]) await db.update(settings).set({ value: before[0].value }).where(eq(settings.key, "templates.whatsapp"));
    else await db.delete(settings).where(eq(settings.key, "templates.whatsapp"));
  }
});

test("consent in one tap, and an admin erases a person's data on request", async ({ pageFor }) => {
  const admin = await makeUser({ role: "admin" });
  const rep = await makeUser({ role: "sales" });
  const c = await makeContact({ owner: rep });
  const rp = await pageFor(rep);
  await rp.goto(`/contacts/${c.id}`);
  await expect(rp.getByTestId("consent-status")).toHaveText("Not asked yet");
  await rp.getByText("Privacy", { exact: true }).click();
  await rp.getByRole("button", { name: "Agreed" }).click();
  await expect(rp.getByTestId("consent-status")).toContainText("Yes, since");
  await rp.getByRole("button", { name: "Withdrawn" }).click();
  await expect(rp.getByTestId("consent-status")).toContainText("No, since");
  // only an admin may erase
  await expect(rp.getByRole("button", { name: "Erase personal data" })).toHaveCount(0);

  const ap = await pageFor(admin);
  await ap.goto(`/contacts/${c.id}`);
  await ap.getByText("Privacy", { exact: true }).click();
  await ap.getByRole("button", { name: "Erase personal data" }).click();
  const sheet = ap.getByRole("dialog", { name: `Erase ${c.name}'s personal data?` });
  await sheet.getByLabel(/Why/).fill("Asked by email");
  await sheet.getByLabel("Type ERASE to confirm").fill("erase it");
  await sheet.getByRole("button", { name: "Erase for good" }).click();
  await expect(sheet.getByRole("alert")).toContainText("Type ERASE to confirm");
  await sheet.getByLabel("Type ERASE to confirm").fill("ERASE");
  await sheet.getByRole("button", { name: "Erase for good" }).click();
  await expect(ap.getByRole("heading", { name: "Erased contact" })).toBeVisible();
  await expect(ap.getByText(c.name)).toHaveCount(0);
  const after = await getContact(c.id);
  expect(after).toMatchObject({ name: "Erased contact", email: null });
  expect(after.erasedAt).not.toBeNull();
  await ap.goto(`/contacts?q=${encodeURIComponent(c.name)}`);
  await expect(ap.getByRole("link", { name: c.name })).toHaveCount(0);
});
