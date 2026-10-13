/**
 * Fixtures for the e2e specs: pages signed in as a role, fresh users, and data made through the domain services
 * (the same code paths the app uses), against the e2e database. Every helper makes its own unique phone numbers and
 * names, so specs never depend on each other or on the demo data.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { test as base, expect, type Browser, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";
import bcrypt from "bcryptjs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, sessions, tasks, users, type Contact, type Role, type TaskType } from "@/db/schema";
import { createTask } from "@/lib/alerts/core";
import { captureEnquiry, type CaptureInput } from "@/lib/contacts/capture";
import { normalizePhone } from "@/lib/phone";
import { E2E_URL, PASSWORD, PEOPLE, authFile, type E2ERole } from "./env";

export { expect };
export { db };

// ---------------------------------------------------------------------------
// Unique values
// ---------------------------------------------------------------------------

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** A made-up surname such as "Quvaren": letters only, so proper-casing leaves it as typed. */
export function uniqueWord(len = 7): string {
  let w = "";
  for (let i = 0; i < len; i++) w += LETTERS[randomInt(LETTERS.length)];
  return w[0].toUpperCase() + w.slice(1);
}

/** "Test Quvaren" style names, unique per call. */
export function uniqueName(first = "Test"): string {
  return `${first} ${uniqueWord()}`;
}

function digits(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String(randomInt(10));
  return s;
}

/**
 * A valid mobile number nobody in the database has (primary or alternate phone).
 * `typed` is how a salesperson would type it: "98470 12345" for India, "050 123 4567" for the UAE.
 */
export async function uniquePhone(country: "IN" | "AE" = "IN"): Promise<{ e164: string; typed: string; international: string }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const typed =
      country === "IN" ? `9${digits(4)} ${digits(5)}` : `05${["0", "2", "5", "6"][randomInt(4)]} ${digits(3)} ${digits(4)}`;
    const raw = country === "AE" ? `+971 ${typed.slice(1)}` : typed;
    const n = normalizePhone(raw);
    if (!n || n.country !== country) continue;
    const taken = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(sql`${contacts.phoneE164} = ${n.e164} or ${n.e164} = any(${contacts.altPhones})`)
      .limit(1);
    if (!taken.length) return { e164: n.e164, typed, international: n.international };
  }
  throw new Error("could not find an unused phone number");
}

// ---------------------------------------------------------------------------
// People and sessions
// ---------------------------------------------------------------------------

const idCache = new Map<string, string>();

/** The user id of a role's login (or of any email). */
export async function userId(who: E2ERole | { email: string }): Promise<string> {
  const email = typeof who === "string" ? PEOPLE[who].email : who.email;
  const hit = idCache.get(email);
  if (hit) return hit;
  const [u] = await db.select({ id: users.id }).from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
  if (!u) throw new Error(`no user ${email}: did the global setup run?`);
  idCache.set(email, u.id);
  return u.id;
}

export type FreshUser = { id: string; name: string; email: string; role: Role };

/**
 * A new team member of their own. `team` defaults to one no rule assigns leads to, so their Today holds only what a
 * spec gives them (no pool tasks, no round-robin leads).
 */
export async function makeUser(opts: { role?: Role; team?: string | null; name?: string } = {}): Promise<FreshUser> {
  const name = opts.name ?? uniqueName("Rep");
  const email = `e2e-${name.split(" ")[1].toLowerCase()}-${digits(4)}@e2e.test`;
  const [u] = await db
    .insert(users)
    .values({
      name,
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      role: opts.role ?? "sales",
      team: opts.team === undefined ? "e2e-isolated" : opts.team,
      timezone: "Asia/Kolkata",
    })
    .returning();
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

/** A session row and its cookie, the same as signing in through the form (see src/lib/auth/session.ts). */
async function sessionCookie(uid: string) {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    id: createHash("sha256").update(token).digest("hex"),
    userId: uid,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    userAgent: "playwright",
  });
  const url = new URL(E2E_URL);
  return { name: "edapt_session", value: token, domain: url.hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" as const };
}

/** The device options of the running project (laptop or phone), for contexts the spec opens itself. */
function deviceOptions(testInfo: TestInfo): BrowserContextOptions {
  const u = testInfo.project.use;
  return {
    baseURL: u.baseURL,
    viewport: u.viewport,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    userAgent: u.userAgent,
    locale: u.locale,
    timezoneId: u.timezoneId,
    serviceWorkers: "block",
  };
}

type Fixtures = {
  /** A page in its own browser context, signed in as one of the role logins (saved by the global setup). */
  pageAs: (role: E2ERole) => Promise<Page>;
  /** A page signed in as any user (e.g. one from makeUser). */
  pageFor: (user: { id: string }) => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  pageAs: async ({ browser }, provide, testInfo) => {
    const opened: Awaited<ReturnType<Browser["newContext"]>>[] = [];
    await provide(async (role) => {
      const context = await browser.newContext({ ...deviceOptions(testInfo), storageState: authFile(role) });
      opened.push(context);
      return context.newPage();
    });
    for (const c of opened) await c.close();
  },
  pageFor: async ({ browser }, provide, testInfo) => {
    const opened: Awaited<ReturnType<Browser["newContext"]>>[] = [];
    await provide(async (user) => {
      const context = await browser.newContext(deviceOptions(testInfo));
      await context.addCookies([await sessionCookie(user.id)]);
      opened.push(context);
      return context.newPage();
    });
    for (const c of opened) await c.close();
  },
});

// ---------------------------------------------------------------------------
// Data through the services
// ---------------------------------------------------------------------------

/**
 * A contact captured like a Quick Add by `owner` (or into the pool with owner: null). No alerts are raised, so
 * nobody's Today changes unless the spec adds a task.
 */
export async function makeContact(
  opts: { owner?: E2ERole | { id: string } | null; name?: string; country?: "IN" | "AE" } & Partial<CaptureInput> = {},
): Promise<Contact> {
  const { owner = "sales", country = "IN", ...rest } = opts;
  const ownerId = owner === null ? null : typeof owner === "string" ? await userId(owner) : owner.id;
  const phone = rest.phone ?? (await uniquePhone(country)).e164;
  const r = await captureEnquiry({
    channel: "phone_call",
    firstDoor: "youtube",
    name: rest.name ?? uniqueName(),
    createdById: ownerId,
    ownerId,
    skipAlerts: true,
    skipAssignment: owner === null,
    ...rest,
    phone,
  });
  return r.contact;
}

/** A Today task for `userId` (null = the pool). */
export async function makeTask(t: {
  userId: string | null;
  contactId: string | null;
  type: TaskType;
  reason: string;
  dueAt?: Date;
  priority?: number;
}): Promise<string> {
  const id = await createTask({ ...t, dedupeKey: `e2e:${randomBytes(8).toString("hex")}` });
  if (!id) throw new Error("task not created");
  return id;
}

export async function getContact(id: string): Promise<Contact> {
  const [c] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!c) throw new Error(`no contact ${id}`);
  return c;
}

export async function findContactByPhone(e164: string): Promise<Contact | null> {
  const [c] = await db.select().from(contacts).where(eq(contacts.phoneE164, e164));
  return c ?? null;
}

export async function openTasks(contactId: string, types?: TaskType[]) {
  return db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.contactId, contactId), eq(tasks.status, "open"), types ? inArray(tasks.type, types) : undefined),
    );
}

// ---------------------------------------------------------------------------
// Phone layout checks
// ---------------------------------------------------------------------------

/** No sideways scrolling: the page is never wider than the screen. */
export async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `page is ${scrollWidth}px wide on a ${innerWidth}px screen`).toBeLessThanOrEqual(innerWidth);
}

/** A main action is on screen and at least 40px tall (a comfortable tap target). */
export async function expectTapTarget(locator: ReturnType<Page["locator"]>, min = 40) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, "element has no box").not.toBeNull();
  expect(box!.height, `tap target is ${box!.height}px tall`).toBeGreaterThanOrEqual(min);
}
