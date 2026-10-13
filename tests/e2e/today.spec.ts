import { inArray, eq } from "drizzle-orm";
import { contacts, tasks } from "@/db/schema";
import { test, expect, db, makeContact, makeTask, makeUser } from "./support/fixtures";

// Today is phone-first and used on laptops: both projects run it. Each test has a salesperson of its own (in a team
// no lead is routed to), so their queue holds exactly what the test puts there.

const HOUR = 3_600_000;

/** Contacts owned by `owner`, assigned days ago (so they are not "new lead" rows of their own). */
async function ownedContacts(owner: { id: string }, n: number, name = "Queue") {
  const list = [];
  for (let i = 0; i < n; i++) list.push(await makeContact({ owner, name: `${name} ${String(i + 1).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}` }));
  await db
    .update(contacts)
    .set({ ownerAssignedAt: new Date(Date.now() - 3 * 24 * HOUR) })
    .where(inArray(contacts.id, list.map((c) => c.id)));
  return list;
}

test("abandoned checkouts sit at the top with their reason", async ({ pageFor }) => {
  const rep = await makeUser();
  const [lead, customer, checkout] = await ownedContacts(rep, 3);
  await makeTask({ userId: rep.id, contactId: lead.id, type: "next_rung", reason: "Due for the next rung", priority: 50 });
  await makeTask({ userId: rep.id, contactId: customer.id, type: "follow_up", reason: "Follow-up you set after a call", dueAt: new Date(Date.now() - 2 * 24 * HOUR) });
  const reason = "Started paying for Claude Mastery Workshop (₹999) 2 hours ago and did not finish";
  await makeTask({ userId: rep.id, contactId: checkout.id, type: "abandoned_checkout", reason, dueAt: new Date(Date.now() - 2 * HOUR) });

  const page = await pageFor(rep);
  await page.goto("/today");
  await expect(page.getByText("3 actions", { exact: true })).toBeVisible();
  const sections = page.locator("main section h2");
  await expect(sections.first()).toContainText("Hottest leads");
  const rows = page.locator("main ol > li");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText(checkout.name);
  await expect(rows.first()).toContainText(reason);
  await expect(rows.nth(1)).toContainText(customer.name);
  await expect(rows.nth(1)).toContainText("Follow-up you set after a call");
});

test("Done removes a row", async ({ pageFor }) => {
  const rep = await makeUser();
  const [a, b] = await ownedContacts(rep, 2);
  const taskId = await makeTask({ userId: rep.id, contactId: a.id, type: "follow_up", reason: "Follow-up you set after a call: send the brochure" });
  await makeTask({ userId: rep.id, contactId: b.id, type: "follow_up", reason: "Follow-up you set after a call: call after 6" });

  const page = await pageFor(rep);
  await page.goto("/today");
  const row = page.locator("main ol > li").filter({ has: page.getByRole("link", { name: a.name, exact: true }) });
  await expect(row).toContainText("send the brochure");
  await row.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("link", { name: a.name, exact: true })).toHaveCount(0);
  await expect.poll(async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0].status).toBe("done");

  await page.reload();
  await expect(page.getByRole("link", { name: b.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: a.name, exact: true })).toHaveCount(0);
  await expect(page.getByText("1 action", { exact: true })).toBeVisible();
});

test("the queue stops at 40 rows and says how many are left out", async ({ pageFor }) => {
  const rep = await makeUser();
  const list = await ownedContacts(rep, 45, "Capped");
  for (const [i, c] of list.entries()) {
    await makeTask({ userId: rep.id, contactId: c.id, type: "follow_up", reason: `Follow-up you set after a call: item ${i + 1}`, dueAt: new Date(Date.now() - (i + 1) * 60_000) });
  }

  const page = await pageFor(rep);
  await page.goto("/today");
  await expect(page.getByText("45 actions", { exact: true })).toBeVisible();
  await expect(page.getByText(/ranked for you, top 40 shown/)).toBeVisible();
  await expect(page.locator("main ol > li")).toHaveCount(40);
  await expect(page.getByText("5 more are waiting below the cap.", { exact: false })).toBeVisible();
});
