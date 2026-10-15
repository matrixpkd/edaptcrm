import { eq } from "drizzle-orm";
import { notifications, tasks } from "@/db/schema";
import { test, expect, db, expectNoHorizontalScroll, makeContact, makeUser, uniqueWord } from "./support/fixtures";

/**
 * Tasks and reminders (beyond the spec): add from /tasks, from Today and from a contact page; it shows on Today when
 * due; Done, Reschedule, Edit, Cancel and Reopen work; managers give tasks to others and see Team tasks; the agenda.
 */

test("a salesperson adds a task, sees it on Today, reschedules it, finishes it and reopens it", async ({ pageFor }) => {
  const rep = await makeUser({ role: "sales" });
  const page = await pageFor(rep);
  const title = `Prepare the price list ${uniqueWord()}`;

  await page.goto("/today");
  await page.getByRole("link", { name: "Add a task" }).click();
  await expect(page).toHaveURL(/\/tasks\/new/);
  // a title of spaces is refused by the server with a message, nothing is saved
  await page.getByLabel("What needs doing").fill("   ");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Write what needs doing" })).toBeVisible();
  await page.getByLabel("What needs doing").fill(title);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByLabel("Time").fill("00:05");
  await page.getByRole("button", { name: "Add task" }).click();
  // back on Today, where the task is due
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByText(title)).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto("/tasks");
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText("Overdue");
  await row.getByRole("button", { name: "Reschedule" }).click();
  await row.getByRole("group", { name: "Reschedule to" }).getByRole("button", { name: "Tomorrow" }).click();
  await expect(row).toContainText("Tomorrow 10:00 am");
  await page.goto("/tasks?view=upcoming");
  await expect(page.getByText(title)).toBeVisible();
  await page.getByRole("button", { name: `Mark done: ${title}` }).click();
  await expect(page.getByRole("status").filter({ hasText: `Marked done: ${title}` })).toBeVisible();
  await page.goto("/tasks?view=done");
  const done = page.getByRole("listitem").filter({ hasText: title });
  await done.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Reopened: ${title}` })).toBeVisible();
  const [t] = await db.select().from(tasks).where(eq(tasks.reason, title));
  expect(t.status).toBe("open");
});

test("a task added on a contact page shows there, can be edited, and the agenda lists it", async ({ pageFor }) => {
  const rep = await makeUser({ role: "sales" });
  const c = await makeContact({ owner: rep });
  const page = await pageFor(rep);
  const title = `Send the brochure ${uniqueWord()}`;
  await page.goto(`/contacts/${c.id}`);
  const card = page.getByRole("region", { name: "Tasks" });
  await card.getByRole("link", { name: "Add task" }).click();
  await expect(page.getByRole("heading", { name: `New task for ${c.name}` })).toBeVisible();
  await page.getByLabel("What needs doing").fill(title);
  await page.getByRole("button", { name: "Tomorrow" }).click();
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${c.id}$`));
  await expect(card).toContainText(title);

  await card.getByRole("link", { name: `Edit: ${title}` }).click();
  await page.getByLabel("What needs doing").fill(`${title} and price`);
  await page.getByLabel("Notes").fill("PDF in the shared drive");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${c.id}$`));
  await expect(card).toContainText(`${title} and price`);

  await page.goto("/tasks?view=agenda");
  await expect(page.getByRole("region", { name: "Agenda" })).toContainText(`${title} and price`);
  await page.getByRole("group", { name: "Agenda range" }).getByRole("link", { name: "Day" }).click();
  await expect(page.getByRole("region", { name: "Agenda" })).not.toContainText(`${title} and price`);
  await page.getByRole("link", { name: "Next day" }).click();
  await expect(page.getByRole("region", { name: "Agenda" })).toContainText(`${title} and price`);
});

test("a manager gives a task to a salesperson, who is alerted; only managers see Team tasks", async ({ pageFor }) => {
  const manager = await makeUser({ role: "manager" });
  const rep = await makeUser({ role: "sales" });
  const c = await makeContact({ owner: rep });
  const title = `Call about the AI Office ${uniqueWord()}`;
  const mp = await pageFor(manager);
  await mp.goto(`/tasks/new?contact=${c.id}`);
  await mp.getByLabel("What needs doing").fill(title);
  await mp.getByLabel("For").selectOption({ value: rep.id });
  await mp.getByRole("button", { name: "Add task" }).click();
  await expect(mp).toHaveURL(new RegExp(`/contacts/${c.id}$`));
  await mp.goto(`/tasks?view=team&who=${rep.id}`);
  await expect(mp.getByRole("listitem").filter({ hasText: title })).toContainText(`For ${rep.name}`);

  const [n] = await db.select().from(notifications).where(eq(notifications.userId, rep.id));
  expect(n.title).toBe(`New task from ${manager.name}: ${title}`);
  const rp = await pageFor(rep);
  await rp.goto("/tasks");
  await expect(rp.getByRole("listitem").filter({ hasText: title })).toContainText(`From ${manager.name}`);
  await expect(rp.getByRole("link", { name: /Team tasks/ })).toHaveCount(0);
  // a salesperson cannot pick someone else
  await rp.goto("/tasks/new");
  await expect(rp.getByLabel("For")).toHaveCount(0);
});
