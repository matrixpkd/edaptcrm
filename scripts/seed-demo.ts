/**
 * Demo data: about 18 months of Edapt's history, built ONLY through the domain services (capture, interactions,
 * ratings, purchases, verification, refunds, stages, transfers, merges, the weekly lead release), so every
 * calculated column, stage, task, notification, ownership log and audit row is what the CRM itself would have
 * written. Called by `npm run db:seed -- --demo` (scripts/seed.ts).
 *
 * How it works: a deterministic plan (seeded PRNG) of dated steps — people enquiring, buying on TagMango,
 * salespeople calling and rating, managers verifying — is replayed in time order under a simulated clock
 * (scripts/seed-clock.ts), so each service stamps the day it "happened". Afterwards the clock is put back,
 * database-stamped times are moved onto the timeline, and the nightly recompute and every alert rule run at the
 * real now, which fills Today, the bell and the dashboard.
 *
 * Refuses to run when the demo team already exists or the database already holds contacts.
 */
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  contacts,
  duplicateReviews,
  interactions,
  notifications,
  payments,
  products,
  purchases,
  ratings,
  tasks,
  users,
  type InteractionType,
  type PaymentMode,
  type Role,
} from "@/db/schema";
import { editCurrency } from "@/lib/admin/currency";
import { createProduct } from "@/lib/admin/products";
import { createUser } from "@/lib/admin/users";
import { runAllAlerts, type RunAllAlertsResult } from "@/lib/alerts/jobs";
import { abandonedCheckouts, atRisk, closeRepurchasedTasks, dueForNextRung, vipGoneQuiet } from "@/lib/alerts/rules";
import { hashPassword } from "@/lib/auth/password";
import { reassignContacts, releaseStaleLeads, requestTransfer, resolveTransferRequest } from "@/lib/contacts/assignment";
import { captureEnquiry, type CaptureInput } from "@/lib/contacts/capture";
import { localTimeInDays } from "@/lib/contacts/follow-up";
import { logInteraction } from "@/lib/contacts/interactions";
import { setManualStage } from "@/lib/contacts/lifecycle";
import { mergeContacts } from "@/lib/contacts/merge";
import { createOrganisation } from "@/lib/contacts/organisations";
import { applyRating, updateContactProfile, type ProfilePatch } from "@/lib/contacts/profile";
import type { RatingInput } from "@/lib/contacts/rules";
import { recomputeAll } from "@/lib/metrics/recompute";
import { recordInstalmentPayment, recordPurchase, recordRefund, verifyPayment } from "@/lib/money/purchases";
import { markAllNotificationsRead } from "@/lib/today/inbox";
import { logFromSheet } from "@/lib/today/log";
import { actOnTasks } from "@/lib/today/tasks";
import { backdateDefaults, backdateSoFar, dbNow, startSimClock, type SimClock } from "./seed-clock";
import {
  ageBand,
  countryOfPhone,
  createRng,
  makePerson,
  mobileNumber,
  newPersonPool,
  occupation,
  tagmangoOrderId,
  utr,
  type Occupation,
  type Person,
  type PersonPool,
  type Region,
  type Rng,
} from "./seed-data";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEMO_PASSWORD = "change-me-now";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const IST = "Asia/Kolkata";
const GST = "Asia/Dubai";
const GCC = ["AE", "SA", "QA", "KW", "BH", "OM"];

export type MemberKey = "umer" | "meera" | "asha" | "biju" | "ravi" | "fatima" | "omar" | "sana" | "joseph";

export const DEMO_TEAM: { key: Exclude<MemberKey, "umer">; name: string; email: string; role: Role; team: string; timezone: string }[] = [
  { key: "meera", name: "Meera Krishnan", email: "meera@edapt.in", role: "manager", team: "kerala", timezone: IST },
  { key: "asha", name: "Asha Thomas", email: "asha@edapt.in", role: "sales", team: "kerala", timezone: IST },
  { key: "biju", name: "Biju Varghese", email: "biju@edapt.in", role: "sales", team: "kerala", timezone: IST },
  { key: "ravi", name: "Ravi Menon", email: "ravi@edapt.in", role: "sales", team: "kerala", timezone: IST },
  { key: "fatima", name: "Fatima Rahman", email: "fatima@edapt.in", role: "sales", team: "dubai", timezone: GST },
  { key: "omar", name: "Omar Haddad", email: "omar@edapt.in", role: "sales", team: "dubai", timezone: GST },
  { key: "sana", name: "Sana Shirin", email: "sana@edapt.in", role: "support", team: "kerala", timezone: IST },
  { key: "joseph", name: "Joseph Mathew", email: "joseph@edapt.in", role: "support", team: "dubai", timezone: GST },
];
export const DEMO_EMAILS = DEMO_TEAM.map((m) => m.email);

const KERALA_REPS: MemberKey[] = ["asha", "biju", "ravi"];
const DUBAI_REPS: MemberKey[] = ["fatima", "omar"];

/** First doors of people who buy on TagMango without a referrer, weighted (YouTube and Meta ads most). */
const BUYER_DOORS: readonly (readonly [string, number])[] = [
  ["youtube", 36],
  ["meta_ad", 32],
  ["workshop_webinar", 9],
  ["search_website", 6],
  ["book_keynote", 6],
  ["other", 4],
];

/** Workshops Umer launches during the 18 months (created through Settings > Products on their launch day). */
const LAUNCHES: { name: string; price: number; externalIds: string[]; description: string; daysAgo: number }[] = [
  { name: "ChatGPT for Teachers", price: 699, externalIds: ["chatgpt-for-teachers"], description: "Two evenings of hands-on ChatGPT for school and college teachers", daysAgo: 558 },
  { name: "Claude Mastery Workshop", price: 999, externalIds: ["claude-mastery*"], description: "Weekend workshop on Claude for work and business", daysAgo: 290 },
  { name: "AI Video Creation Workshop", price: 999, externalIds: ["ai-video-creation"], description: "Make reels and explainer videos with AI tools", daysAgo: 210 },
];

const WORKSHOPS = ["Entry AI Workshop", "AI Workshop", "Claude Mastery Workshop", "AI Video Creation Workshop", "ChatGPT for Teachers", "AI Agents for Business"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Member = { key: MemberKey; id: string; name: string; role: Role; team: string | null; timezone: string };
type ProductRef = { id: string; name: string; family: string; listPrice: number; currency: string };
type Paid = { purchaseId: string; paymentIds: string[]; product: string };

type Story = {
  key: string;
  p: Person;
  team: "kerala" | "dubai";
  tz: string;
  rng: Rng;
  /** live contact id once captured */
  id: string | null;
  /** the salesperson who works the contact while it sits in the pool */
  rep: MemberKey;
  langKnown: boolean;
  job: Occupation;
  /** workshops bought (plan time) */
  bought: Set<string>;
  firstPurchaseAt: number | null;
  paid: Paid[];
  tags?: string[];
};

type Step = { at: number; seq: number; label: string; run: () => Promise<unknown> };

export type SeedDemoOptions = {
  /** roughly how many contacts (default 600) */
  contacts?: number;
  /** PRNG seed (default 20261013) */
  seed?: number;
  /** no progress output */
  quiet?: boolean;
};

export type DemoSummary = {
  skipped?: string;
  contacts: number;
  customers: number;
  ltvInr: number;
  byStage: Record<string, number>;
  byGrade: Record<string, number>;
  seconds: number;
  richContact: string | null;
};

// ---------------------------------------------------------------------------
// The timeline (a min-heap of dated steps)
// ---------------------------------------------------------------------------

class Timeline {
  private heap: Step[] = [];
  private seq = 0;
  constructor(readonly horizon: number) {}

  /** Adds a step; steps after the horizon (the real now) have not happened yet and are dropped. */
  add(at: number, label: string, run: () => Promise<unknown>): boolean {
    if (!Number.isFinite(at) || at > this.horizon) return false;
    this.heap.push({ at, seq: this.seq++, label, run });
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
    return true;
  }

  pop(): Step | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(l, m)) m = l;
        if (r < h.length && this.less(r, m)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }

  get size() {
    return this.heap.length;
  }

  private less(a: number, b: number) {
    const x = this.heap[a];
    const y = this.heap[b];
    return x.at < y.at || (x.at === y.at && x.seq < y.seq);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function seedDemo(opts: SeedDemoOptions = {}): Promise<DemoSummary> {
  const started = Date.now();
  const log = (msg: string) => {
    if (!opts.quiet) console.log(msg);
  };
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to load demo data in production");

  const empty: DemoSummary = { contacts: 0, customers: 0, ltvInr: 0, byStage: {}, byGrade: {}, seconds: 0, richContact: null };
  const existing = await db
    .select({ email: users.email })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, DEMO_EMAILS));
  if (existing.length) {
    const msg = `Demo data is already loaded (${existing.map((u) => u.email).join(", ")} exist). Run \`npm run db:reset\` and seed again for a fresh copy.`;
    log(msg);
    return { ...empty, skipped: msg };
  }
  const [{ n: contactCount }] = await db.select({ n: count() }).from(contacts);
  if (contactCount > 0) {
    const msg = `The database already holds ${contactCount} contacts; demo data only goes into an empty CRM. Run \`npm run db:reset\` first.`;
    log(msg);
    return { ...empty, skipped: msg };
  }
  const [admin] = await db
    .select()
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.active, true)))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!admin) throw new Error("No admin user: run `npm run db:seed` (without --demo) first");

  const T0 = Date.now();
  const START = T0 - 548 * DAY;
  const rng = createRng(opts.seed ?? 20261013);
  const scale = Math.max(0.05, (opts.contacts ?? 600) / 600);
  const tl = new Timeline(T0 - MIN);
  const pool = newPersonPool();

  log(`Loading demo data: ~${Math.round(600 * scale)} contacts over 18 months (simulated clock, real services)…`);
  const clock = await startSimClock(new Date(START - 21 * DAY));
  let world: World | null = null;
  try {
    await clock.mark();
    world = await setup(admin, { T0, START, rng, tl, pool, clock, scale, log });
    plan(world);
    log(`  ${tl.size} steps planned`);
    await run(world);
  } finally {
    clock.stop();
  }
  const w = world;

  // ---- back to the real clock: move database-stamped times onto the timeline, then the nightly jobs and alerts
  const until = await dbNow();
  const moved = await backdateDefaults(until);
  log(`  ${moved} database timestamps moved onto the timeline`);
  const now = new Date();
  // recomputeAll rebuilds the repeat cohorts (buildCohorts) first, exactly like the nightly job
  const recomputed = await recomputeAll({ now });
  const alerts = await runAllAlerts(now);
  log(`  recomputed ${recomputed} contacts; alerts: ${describeAlerts(alerts)}`);

  const summary = await summarize(w, (Date.now() - started) / 1000);
  log(formatSummary(summary, await counts()));
  return summary;
}

// ---------------------------------------------------------------------------
// World: the team, the catalogue and helpers shared by every story
// ---------------------------------------------------------------------------

type World = {
  T0: number;
  START: number;
  rng: Rng;
  tl: Timeline;
  pool: PersonPool;
  clock: SimClock;
  scale: number;
  log: (msg: string) => void;
  m: Record<MemberKey, Member>;
  products: Map<string, ProductRef>;
  launches: Record<string, number>;
  stories: Story[];
  /** contacts Meera already gave a second chance (reassigned after a release) */
  secondChance: Set<string>;
  /** repeat-purchase tasks (at risk, next rung) the team has already picked up */
  triaged: Set<string>;
  rich: Story | null;
  storySeq: number;
};

async function setup(
  admin: typeof users.$inferSelect,
  base: Pick<World, "T0" | "START" | "rng" | "tl" | "pool" | "clock" | "scale" | "log">,
): Promise<World> {
  const umer: Member = { key: "umer", id: admin.id, name: admin.name, role: admin.role, team: admin.team, timezone: admin.timezone };
  const actor = { id: umer.id, role: umer.role };
  const m = { umer } as Record<MemberKey, Member>;
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const t of DEMO_TEAM) {
    const { user } = await createUser({ name: t.name, email: t.email, role: t.role, team: t.team, timezone: t.timezone, phone: null }, actor);
    // the team starts with the shared demo password instead of the generated temporary one
    await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    m[t.key] = { key: t.key, id: user.id, name: user.name, role: user.role, team: user.team, timezone: user.timezone };
  }

  const catalogue = await db.select().from(products);
  const byName = new Map<string, ProductRef>(
    catalogue.map((p) => [p.name, { id: p.id, name: p.name, family: p.family, listPrice: Number(p.listPrice), currency: p.currency }]),
  );
  const need = ["Entry AI Workshop", "AI Workshop", "AI Agents for Business", "Applied AI Mastery", "The AI Office membership", "Premium program", "Consulting engagement", "School AI program", "International delegation"];
  const missing = need.filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`Demo data needs the starter products (missing: ${missing.join(", ")}). Run \`npm run db:seed\` on an empty database first.`);

  const w: World = {
    ...base,
    m,
    products: byName,
    launches: Object.fromEntries(LAUNCHES.map((l) => [l.name, base.T0 - l.daysAgo * DAY])),
    stories: [],
    secondChance: new Set(),
    triaged: new Set(),
    rich: null,
    storySeq: 0,
  };
  // the workshop catalogue grows over the 18 months (Umer adds each launch in Settings > Products)
  for (const l of LAUNCHES) {
    if (byName.has(l.name)) continue;
    base.tl.add(w.launches[l.name], `launch ${l.name}`, async () => {
      const p = await createProduct(
        { name: l.name, family: "workshop", listPrice: l.price, currency: "INR", active: true, externalIds: l.externalIds, description: l.description },
        actor,
      );
      byName.set(p.name, { id: p.id, name: p.name, family: p.family, listPrice: Number(p.listPrice), currency: p.currency });
    });
  }
  return w;
}

const P = (w: World, name: string): ProductRef => {
  const p = w.products.get(name);
  if (!p) throw new Error(`Unknown product ${name}`);
  return p;
};

/** List price at plan time (a launch may not be in the catalogue yet). */
const listPriceOf = (w: World, name: string): number => w.products.get(name)?.listPrice ?? LAUNCHES.find((l) => l.name === name)?.price ?? 999;

const teamOf = (phone: string): "kerala" | "dubai" => (GCC.includes(countryOfPhone(phone)) ? "dubai" : "kerala");

function newStory(w: World, p: Person, opts: { rep?: MemberKey; langKnown?: boolean } = {}): Story {
  const r = w.rng.fork(w.storySeq++);
  const team = teamOf(p.phone);
  const s: Story = {
    key: `s${w.storySeq}`,
    p,
    team,
    tz: team === "dubai" ? GST : IST,
    rng: r,
    id: null,
    rep: opts.rep ?? r.pick(team === "dubai" ? DUBAI_REPS : KERALA_REPS),
    langKnown: opts.langKnown ?? r.chance(0.62),
    job: occupation(r, p),
    bought: new Set(),
    firstPurchaseAt: null,
    paid: [],
  };
  w.stories.push(s);
  return s;
}

function person(w: World, o: Parameters<typeof makePerson>[2] = {}): Person {
  return makePerson(w.rng, w.pool, o);
}

/** A moment `days` calendar days after `from` at a working hour in `tz` (always after `from`). */
function workAt(r: Rng, from: number, days: number, tz: string, hours: [number, number] = [9, 19]): number {
  let t = localTimeInDays(new Date(from), tz, days, r.int(hours[0], hours[1] - 1), r.int(0, 59)).getTime();
  while (t <= from) t += DAY;
  return t;
}

/** `days` calendar days before the real now at hh:mm in `tz`. */
const ago = (w: World, days: number, hour: number, minute = 0, tz = IST) => localTimeInDays(new Date(w.T0), tz, -days, hour, minute).getTime();

/** A start moment in the last 18 months; the business doubles about every five months, so most are recent. */
function growingMoment(r: Rng, w: World, minDaysAgo = 1, maxDaysAgo = 540): number {
  for (;;) {
    const d = r.int(minDaysAgo, maxDaysAgo);
    if (r.next() <= Math.pow(2, -d / 160)) return w.T0 - d * DAY - r.int(0, 23) * HOUR - r.int(0, 59) * MIN;
  }
}

/** Evening-heavy checkout time on the day `t` falls on (IST), never after `t`'s day ends. */
function checkoutTime(r: Rng, t: number): number {
  const hour = r.weighted([
    [8, 2],
    [11, 4],
    [13, 4],
    [16, 4],
    [19, 7],
    [21, 9],
    [22, 6],
    [23, 2],
  ] as const);
  const at = localTimeInDays(new Date(t), IST, 0, hour, r.int(0, 59)).getTime();
  return at >= t ? at : at + DAY;
}

/** A working-hour moment on the local day of `target` (the day before if that is still to come). */
function workingOn(r: Rng, w: World, target: number, tz: string): number {
  let at = localTimeInDays(new Date(target), tz, 0, r.int(9, 18), r.int(0, 59)).getTime();
  while (at > w.T0 - 20 * MIN) at -= DAY;
  return at;
}

// ---------------------------------------------------------------------------
// Run-time helpers (each one calls a domain service)
// ---------------------------------------------------------------------------

async function liveId(s: Story): Promise<string | null> {
  let id = s.id;
  for (let hop = 0; id && hop < 5; hop++) {
    const [c] = await db.select({ merged: contacts.mergedIntoId }).from(contacts).where(eq(contacts.id, id)).limit(1);
    if (!c) return null;
    if (!c.merged) return id;
    id = c.merged;
  }
  return id;
}

/** The person who works the contact now: its owner (never support), else the story's salesperson (pool). */
async function worker(w: World, s: Story): Promise<Member> {
  const id = await liveId(s);
  if (id) {
    const [c] = await db.select({ ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, id)).limit(1);
    const owner = Object.values(w.m).find((x) => x.id === c?.ownerId);
    if (owner && owner.role !== "support") return owner;
  }
  return w.m[s.rep];
}

async function capture(s: Story, input: Omit<CaptureInput, "phone">) {
  const res = await captureEnquiry({
    phone: s.p.phone,
    name: s.p.name,
    receivedAt: new Date(),
    ...input,
    profile: {
      city: s.p.city,
      state: s.p.state,
      country: s.p.country,
      ...(s.langKnown ? { language: s.p.language } : {}),
      ...input.profile,
    },
    tags: [...(s.tags ?? []), ...(input.tags ?? [])],
  });
  s.id = res.contact.id;
  return res;
}

type Touch = {
  type?: InteractionType;
  outcome: string;
  summary: string;
  direction?: "in" | "out";
  /** follow-up in N calendar days at a working hour in the actor's time zone */
  followUpDays?: number | null;
  /** an exact follow-up time */
  followUpAt?: number;
  by?: MemberKey;
};

async function touch(w: World, s: Story, o: Touch): Promise<Member | null> {
  const id = await liveId(s);
  if (!id) return null;
  const actor = o.by ? w.m[o.by] : await worker(w, s);
  const now = new Date();
  const next = o.followUpAt
    ? new Date(o.followUpAt)
    : o.followUpDays
      ? localTimeInDays(now, actor.timezone, o.followUpDays, s.rng.int(10, 16), s.rng.pick([0, 15, 30, 45]))
      : null;
  await logInteraction(
    id,
    { type: o.type ?? "call", outcome: o.outcome, summary: o.summary, direction: o.direction ?? "out", nextFollowUpAt: next },
    actor,
  );
  return actor;
}

async function rateBySales(w: World, s: Story, values: RatingInput, by?: MemberKey) {
  const id = await liveId(s);
  if (!id) return;
  const actor = by ? w.m[by] : await worker(w, s);
  if (actor.role === "support") return;
  await applyRating(id, values, "sales", actor.id);
}

async function editProfile(w: World, s: Story, patch: ProfilePatch, by?: MemberKey) {
  const id = await liveId(s);
  if (!id) return;
  const actor = by ? w.m[by] : await worker(w, s);
  await updateContactProfile(id, patch, actor);
}

type Order = {
  product: string;
  status: "completed" | "started" | "failed";
  orderId: string;
  amount?: number;
  door?: string | null;
  campaign?: string | null;
  referrer?: Story | null;
  selfRatings?: CaptureInput["selfRatings"];
};

/** What the TagMango webhook does for an order: capture the touch, then record the verified purchase. */
async function tagmango(w: World, s: Story, o: Order) {
  const prod = P(w, o.product);
  const res = await capture(s, {
    email: s.p.email,
    channel: "tagmango_checkout",
    firstDoor: o.door ?? null,
    campaign: o.campaign ?? null,
    productInterest: prod.name,
    sourceRef: `tagmango:order:${o.orderId}:${o.status}`,
    enquiryStatus: o.status === "completed" ? "handled" : o.status === "started" ? "checkout_started" : "checkout_failed",
    referrer: o.referrer ? { phone: o.referrer.p.phone, name: o.referrer.p.name } : null,
    selfRatings: o.selfRatings,
    skipAlerts: o.status === "completed",
  });
  if (o.status !== "completed") return;
  const r = await recordPurchase(
    {
      contactId: res.contact.id,
      productId: prod.id,
      amount: o.amount ?? prod.listPrice,
      currency: "INR",
      purchasedAt: new Date(),
      mode: "tagmango",
      reference: o.orderId,
      source: "tagmango",
      verified: true,
      campaign: o.campaign ?? null,
    },
    null,
  );
  s.paid.push({ ...r, product: prod.name });
}

type Sale = {
  product: string;
  amount: number;
  currency: string;
  mode: PaymentMode;
  by?: MemberKey;
  /** hours until the manager verifies; null = left waiting */
  verifyAfterHours: number | null;
  /** EMI: instalment amounts; the first is paid now, the rest fall due every `everyDays` */
  instalments?: number[];
  everyDays?: number;
  /** instalment numbers (2-based) the customer pays on time; others stay unpaid */
  payInstalments?: number[];
  listPrice?: number;
  discount?: number;
  organisationId?: () => string | null;
  notes?: string;
};

/** A salesperson records a bank transfer / UPI payment (unverified) and the manager verifies it later. */
async function manualSale(w: World, s: Story, o: Sale): Promise<Paid | null> {
  const id = await liveId(s);
  if (!id) return null;
  const actor = o.by ? w.m[o.by] : await worker(w, s);
  const now = new Date();
  const ref = utr(s.rng, o.mode);
  const every = o.everyDays ?? 30;
  const instalments = o.instalments?.map((amount, i) => ({
    amount,
    dueAt: i === 0 ? now : localTimeInDays(now, actor.timezone, i * every, 10),
  }));
  const prod = P(w, o.product);
  const r = await recordPurchase(
    {
      contactId: id,
      productId: prod.id,
      amount: o.amount,
      currency: o.currency,
      purchasedAt: now,
      mode: o.mode,
      reference: instalments ? null : ref,
      source: "manual",
      instalments,
      paidNow: instalments ? { amount: instalments[0].amount, reference: ref, mode: o.mode } : undefined,
      listPrice: o.listPrice,
      discount: o.discount,
      organisationId: o.organisationId?.() ?? null,
      notes: o.notes ?? null,
    },
    actor,
  );
  const paid = { ...r, product: prod.name };
  s.paid.push(paid);
  if (o.verifyAfterHours !== null) {
    w.tl.add(now.getTime() + o.verifyAfterHours * HOUR, `verify ${prod.name}`, () => verify(w, r.paymentIds[0]));
  }
  if (instalments) {
    for (const seq of o.payInstalments ?? []) {
      const due = instalments[seq - 1]?.dueAt.getTime();
      const pid = r.paymentIds[seq - 1];
      if (!due || !pid) continue;
      const at = due + s.rng.int(-3, 1) * DAY + s.rng.int(1, 8) * HOUR;
      w.tl.add(Math.max(at, now.getTime() + DAY), `instalment ${seq}`, async () => {
        const [p] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, pid)).limit(1);
        if (p?.status !== "scheduled") return;
        const payer = await worker(w, s);
        await recordInstalmentPayment(pid, { reference: utr(s.rng, o.mode), mode: o.mode, paidAt: new Date() }, payer);
        w.tl.add(Date.now() + s.rng.int(3, 40) * HOUR, `verify instalment ${seq}`, () => verify(w, pid));
      });
    }
  }
  return paid;
}

async function verify(w: World, paymentId: string) {
  const [p] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (p?.status !== "unverified") return;
  await verifyPayment(paymentId, w.m.meera);
}

/** The contact's open tasks of a type, done by whoever works it (Today "Done"). */
async function completeTasks(w: World, s: Story, type: (typeof tasks.$inferSelect)["type"]) {
  const id = await liveId(s);
  if (!id) return;
  const open = await db
    .select({ id: tasks.id, userId: tasks.userId })
    .from(tasks)
    .where(and(eq(tasks.contactId, id), eq(tasks.type, type), eq(tasks.status, "open")));
  if (!open.length) return;
  const actor = await worker(w, s);
  const mine = open.filter((t) => t.userId === actor.id || t.userId === null).map((t) => t.id);
  if (mine.length) await actOnTasks(mine, "done", { ...actor });
}

/**
 * After a customer pays, whoever works the contact confirms on WhatsApp, which also closes the follow-up they had
 * set while chasing the payment (skipped when nothing is open).
 */
function closeLoop(w: World, s: Story, after: number) {
  const r = s.rng;
  w.tl.add(after + r.int(2, 20) * HOUR, "close the loop", async () => {
    const id = await liveId(s);
    if (!id) return;
    const actor = await worker(w, s);
    const open = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.contactId, id), eq(tasks.type, "follow_up"), eq(tasks.status, "open"), eq(tasks.userId, actor.id)))
      .limit(1);
    if (!open.length) return;
    await touch(w, s, {
      type: "whatsapp",
      outcome: "paid",
      summary: r.pick(["Payment received; sent the joining link", "Paid; added to the batch WhatsApp group", "Confirmed the payment and shared the schedule"]),
    });
  });
}

// ---------------------------------------------------------------------------
// Words people use
// ---------------------------------------------------------------------------

const SAY = {
  noAnswer: ["No answer", "Rang twice, no answer", "Phone switched off", "Not reachable, will try again", "Call cut after two rings"],
  busy: ["Asked to call back in the evening", "Driving, asked to call tomorrow", "In a meeting, call after 5", "Busy with Friday prayers, call later"],
  connected: [
    "Explained the workshop format and timings",
    "Asked if there is a Malayalam batch",
    "Wanted to know if recordings are shared",
    "Checked the weekend batch dates",
    "Asked whether a laptop is needed",
  ],
  interested: [
    "Interested; wants to use AI for the shop's billing and stock",
    "Keen on the next Claude Mastery batch",
    "Interested for his team of 6; asked about a group price",
    "Wants to automate customer replies on WhatsApp",
    "Interested after watching the YouTube live",
    "Wants help writing proposals and reports with AI",
  ],
  info: ["Sent the brochure and batch dates on WhatsApp", "Shared the payment link and the syllabus", "Sent the recording of the free webinar", "Sent EMI options"],
  promised: ["Will pay by UPI tonight", "Promised to transfer on salary day", "Will pay after discussing with his partner", "Paying this weekend"],
  notInterested: ["Not interested right now", "Only wanted the free webinar", "Says he is too busy this quarter", "Already doing a course elsewhere"],
  support: [
    ["Could not find the Zoom link for Saturday's session", "Resent the link on WhatsApp"],
    ["Asked for the recording of day 2", "Shared the recording link"],
    ["Name on the certificate was misspelt", "Corrected and reissued the certificate"],
    ["Needed a GST invoice for the company", "Emailed the invoice"],
    ["Payment went through twice on TagMango", "Checked: only one order was charged"],
    ["Could not log in to the community", "Reset the TagMango access"],
  ] as const,
};

/** A touch whose note matches its outcome (a WhatsApp when info was sent). */
function said(r: Rng, outcome: string, extra: Partial<Touch> = {}): Touch {
  const lines: Record<string, readonly string[]> = {
    no_answer: SAY.noAnswer,
    busy: SAY.busy,
    interested: SAY.interested,
    info_sent: SAY.info,
    payment_promised: SAY.promised,
    not_interested: SAY.notInterested,
  };
  return { type: outcome === "info_sent" ? "whatsapp" : "call", outcome, summary: r.pick(lines[outcome] ?? SAY.connected), ...extra };
}

function lostReasonFor(r: Rng, outcome: string): string {
  if (outcome === "wrong_number") return "wrong_number";
  return r.weighted([
    ["price", 3],
    ["timing", 3],
    ["not_interested", 4],
    ["bought_elsewhere", 1],
    ["other", 1],
  ]);
}

function selfRatingsFor(r: Rng, door: string | null): CaptureInput["selfRatings"] {
  const umer =
    door === "youtube" ? r.int(2, 4) : door === "book_keynote" ? r.int(3, 5) : door === "meta_ad" ? r.int(0, 2) : door === "referral" ? r.int(1, 3) : r.int(0, 3);
  return {
    umerLevel: umer,
    aiLevel: r.weighted([
      [0, 1],
      [1, 4],
      [2, 4],
      [3, 2],
      [4, 1],
    ]),
    ...(r.chance(0.5) ? { ageBand: ageBand(r) } : {}),
  };
}

function salesRating(r: Rng, s: Story, o: { warm?: boolean } = {}): RatingInput {
  const job = s.job;
  const band =
    job.industry === "business_owner" ? r.int(3, 5) : job.industry === "senior_manager" ? r.int(3, 4) : job.industry === "student" ? 1 : r.int(2, 3);
  return {
    aiLevel: r.weighted([
      [0, 1],
      [1, 3],
      [2, 4],
      [3, 3],
      [4, 1],
      [5, job.industry === "it_professional" ? 2 : 0.2],
    ]),
    umerLevel: o.warm ? r.int(2, 4) : r.int(0, 3),
    spendingBand: Math.min(5, band + (s.team === "dubai" && r.chance(0.5) ? 1 : 0)),
    gutStars: o.warm ? r.int(3, 5) : r.int(2, 4),
    ageBand: ageBand(r),
    industry: job.industry,
    notes: job.company ? `${job.designation} at ${job.company}` : r.chance(0.3) ? `${job.designation}` : null,
  };
}

function workshopFor(w: World, r: Rng, s: Story, at: number): string {
  const available = WORKSHOPS.filter((name) => !s.bought.has(name) && (w.launches[name] ?? 0) <= at);
  const weight = (name: string) => {
    switch (name) {
      case "Entry AI Workshop":
        return s.bought.size ? 4 : 32;
      case "AI Workshop":
        return 30;
      case "Claude Mastery Workshop":
        return 24;
      case "AI Video Creation Workshop":
        return 8;
      case "ChatGPT for Teachers":
        return s.job.industry === "teacher" ? 45 : 2;
      case "AI Agents for Business":
        return s.job.industry === "business_owner" ? 40 : s.bought.size ? 10 : 3;
      default:
        return 1;
    }
  };
  const name = available.length ? r.weighted(available.map((n) => [n, weight(n)] as const)) : "AI Workshop";
  s.bought.add(name);
  return name;
}

/** AED price of an INR list price in the month of `at` (rates set by Umer each month). */
function aed(w: World, inr: number, at: number): number {
  return Math.round(inr / aedRate(w, at));
}

function aedRate(w: World, at: number): number {
  const months = (at - w.START) / (30.4 * DAY);
  return Math.round((22.32 + Math.max(0, Math.min(18, months)) * 0.021) * 100) / 100;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function plan(w: World) {
  planHousekeeping(w);
  const n = (k: number) => Math.max(1, Math.round(k * w.scale));
  planDelegation(w, n(40));
  planMlaEvent(w, "koduvally_ai_literacy", "Koduvally", ago(w, 318, 10), n(22), "ravi");
  planMlaEvent(w, "buddhi_yatra_malappuram", "Malappuram", ago(w, 164, 10), n(20), "asha");
  for (let i = 0; i < n(300); i++) {
    const s = newStory(w, person(w));
    planBuyer(w, s, growingMoment(s.rng, w, 2, 540));
  }
  for (let i = 0; i < n(158); i++) {
    const s = newStory(w, person(w));
    planLead(w, s, growingMoment(s.rng, w, 1, 520));
  }
  // the last two weeks' inflow: the leads the team is working right now
  for (let i = 0; i < n(42); i++) {
    const s = newStory(w, person(w));
    const kind = s.rng.weighted([
      ["active", 72],
      ["lost", 8],
      ["late_buyer", 10],
      ["untouched", 10],
    ] as const);
    planLead(w, s, w.T0 - s.rng.int(36, 14 * 24) * HOUR, kind);
  }
  planAdvocates(w, n(5));
  planSetPieces(w);
}

/** Monthly currency rates, the weekly lead release (and the manager's follow-through), notifications read. */
function planHousekeeping(w: World) {
  const umer = () => ({ id: w.m.umer.id, role: w.m.umer.role });
  // Umer keeps Settings > Currency current: one AED and one USD rate per month
  for (let i = 0; i <= 18; i++) {
    const d = new Date(w.START);
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1, 5, 0);
    const month = new Date(first).toISOString().slice(0, 7);
    if (month === "2026-01" || month === "2026-10") continue; // already in the defaults
    const at = Math.max(first, w.START - 20 * DAY);
    w.tl.add(at, `rates ${month}`, async () => {
      const usd = Math.round((82.1 + i * 0.07) * 100) / 100;
      await editCurrency({ op: "setRate", currency: "AED", month, rate: aedRate(w, first) }, umer());
      await editCurrency({ op: "setRate", currency: "USD", month, rate: usd }, umer());
    });
  }
  // every Monday: the team clears the bell, the release job runs; Meera works through released leads on Tuesday
  for (let d = 0; d < 560; d++) {
    const monday = localTimeInDays(new Date(w.START), IST, d, 9, 0).getTime();
    // 09:00 IST is 03:30 UTC, the same calendar day
    if (new Date(monday).getUTCDay() !== 1 || monday > w.T0) continue;
    // the nightly job (recompute, then the repeat-purchase alerts), shown here once a week
    w.tl.add(monday - 7 * HOUR, "nightly jobs", () => nightly(w));
    w.tl.add(monday, "notifications read", async () => {
      for (const m of Object.values(w.m)) await markAllNotificationsRead(m.id);
    });
    w.tl.add(monday + 30 * MIN, "weekly lead release", () => releaseStaleLeads(new Date()));
    w.tl.add(monday + 50 * HOUR, "manager handles released leads", () => handleReleased(w));
  }
}

/** The nightly job (recompute every contact, then next rung, at risk, VIP gone quiet), and the team's triage. */
async function nightly(w: World) {
  // keep database-stamped times (created_at) on the simulated timeline for the services that read them
  await backdateSoFar();
  const now = new Date();
  await recomputeAll({ now });
  await closeRepurchasedTasks(now);
  await dueForNextRung(now);
  await atRisk(now);
  await vipGoneQuiet(now);
  const open = await db
    .select({ id: tasks.id, type: tasks.type, contactId: tasks.contactId })
    .from(tasks)
    .where(and(inArray(tasks.type, ["at_risk", "next_rung"]), eq(tasks.status, "open")))
    .orderBy(asc(tasks.createdAt), asc(tasks.id));
  const fresh = open.filter((t) => !w.triaged.has(t.id) && t.contactId);
  const r = w.rng.fork(fresh.length + 11);
  const dismiss: string[] = [];
  for (const t of fresh) {
    w.triaged.add(t.id);
    // called, waved off, or simply left on Today (the cap keeps the list short)
    const choice = r.weighted(
      t.type === "next_rung"
        ? ([["call", 60], ["dismiss", 15], ["leave", 25]] as const)
        : ([["call", 30], ["dismiss", 58], ["leave", 12]] as const),
    );
    if (choice === "leave") continue;
    if (choice === "dismiss") {
      dismiss.push(t.id);
      continue;
    }
    const contactId = t.contactId!;
    const at = workAt(r, now.getTime(), r.int(1, 3), IST);
    w.tl.add(at, `${t.type} call`, () => repeatCall(w, r, t.id, t.type, contactId));
  }
  // the rest are waved off from Today over the next day or two
  if (dismiss.length) w.tl.add(workAt(r, now.getTime(), r.int(1, 2), IST), "triage repeat-purchase rows", () => dismissTasks(w, dismiss));
}

/** Who acts on a contact now: the owner (never support), else a salesperson of its team (the pool). */
async function actorFor(w: World, contactId: string, r: Rng): Promise<{ actor: Member; live: boolean }> {
  const [c] = await db
    .select({ ownerId: contacts.ownerId, phoneCountry: contacts.phoneCountry, merged: contacts.mergedIntoId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  const owner = Object.values(w.m).find((x) => x.id === c?.ownerId && x.role !== "support");
  const actor = owner ?? w.m[r.pick(GCC.includes(c?.phoneCountry ?? "") ? DUBAI_REPS : KERALA_REPS)];
  return { actor, live: !!c && !c.merged };
}

async function repeatCall(w: World, r: Rng, taskId: string, type: string, contactId: string) {
  const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (task?.status !== "open") return;
  const { actor, live } = await actorFor(w, contactId, r);
  if (!live) return;
  const connected = r.chance(0.6);
  const summary = !connected
    ? r.pick(SAY.noAnswer)
    : type === "next_rung"
      ? r.pick(["Told them about the next rung; will decide after this month", "Interested in the next batch; sent the details", "Asked for the Applied AI Mastery syllabus"])
      : r.pick(["Checked in; busy this month, will look at the next batch", "Happy with the workshop; no plans right now", "Asked about weekend batches for the new topics"]);
  await logInteraction(
    contactId,
    { type: connected && r.chance(0.3) ? "whatsapp" : "call", outcome: connected ? r.pick(["connected", "interested", "info_sent"]) : "no_answer", summary, direction: "out" },
    actor,
  );
  await actOnTasks([taskId], "done", { ...actor });
}

async function dismissTasks(w: World, ids: string[]) {
  const rows = await db
    .select({ id: tasks.id, userId: tasks.userId, contactId: tasks.contactId, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.id, ids));
  const r = w.rng.fork(ids.length + 13);
  const byActor = new Map<string, { actor: Member; ids: string[] }>();
  for (const t of rows) {
    if (t.status !== "open" || !t.contactId) continue;
    const assignee = Object.values(w.m).find((x) => x.id === t.userId);
    const actor = assignee ?? (await actorFor(w, t.contactId, r)).actor;
    const group = byActor.get(actor.id) ?? { actor, ids: [] };
    group.ids.push(t.id);
    byActor.set(actor.id, group);
  }
  for (const { actor, ids: mine } of byActor.values()) {
    for (let i = 0; i < mine.length; i += 50) await actOnTasks(mine.slice(i, i + 50), "dismiss", { ...actor });
  }
}

async function handleReleased(w: World) {
  const open = await db
    .select({ id: tasks.id, contactId: tasks.contactId, phoneCountry: contacts.phoneCountry, stage: contacts.stage })
    .from(tasks)
    .innerJoin(contacts, eq(contacts.id, tasks.contactId))
    .where(and(eq(tasks.type, "lead_released"), eq(tasks.status, "open"), eq(tasks.userId, w.m.meera.id), isNull(contacts.ownerId)))
    .orderBy(asc(tasks.createdAt));
  const r = w.rng.fork(open.length + 7);
  const done: string[] = [];
  for (const t of open) {
    // one in six gets a second chance with a different salesperson, who calls the next day
    if (t.contactId && !w.secondChance.has(t.contactId) && r.chance(1 / 6)) {
      w.secondChance.add(t.contactId);
      const to = w.m[r.pick(GCC.includes(t.phoneCountry ?? "") ? DUBAI_REPS : KERALA_REPS)];
      await reassignContacts([t.contactId], to.id, w.m.meera, "Released lead: one more try with a fresh voice");
      const contactId = t.contactId;
      w.tl.add(Date.now() + r.int(18, 30) * HOUR, "second-chance call", async () => {
        const [c] = await db.select({ ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
        if (c?.ownerId !== to.id) return;
        const connected = r.chance(0.4);
        await logInteraction(
          contactId,
          {
            type: "call",
            outcome: connected ? "connected" : "no_answer",
            summary: connected ? "Spoke again; will think about the next batch" : r.pick(SAY.noAnswer),
            direction: "out",
          },
          to,
        );
      });
    }
    done.push(t.id);
  }
  for (let i = 0; i < done.length; i += 50) await actOnTasks(done.slice(i, i + 50), "done", { ...w.m.meera });
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/**
 * A workshop buyer: most pay on TagMango without talking to anyone; some enquire first and get a call; a quarter
 * buy again; some climb to Applied AI Mastery after a call, and a few of those to The AI Office.
 */
function planBuyer(
  w: World,
  s: Story,
  start: number,
  o: { door?: string | null; campaign?: string | null; referrer?: Story; product?: string; climb?: boolean; aiOffice?: boolean; selfRate?: boolean; leadFirst?: boolean } = {},
) {
  const r = s.rng;
  const door = o.door !== undefined ? o.door : o.referrer ? null : r.weighted(BUYER_DOORS);
  const campaign =
    o.campaign !== undefined ? o.campaign : door === "meta_ad" && start > w.launches["Claude Mastery Workshop"] && r.chance(0.65) ? "claude_mastery_meta" : null;
  let t = start;
  const intro = o.leadFirst ?? (!o.referrer && r.chance(0.14));
  if (intro) t = planLeadIntro(w, s, t, door, campaign);
  t = checkoutTime(r, t);
  const product = o.product ?? (campaign === "claude_mastery_meta" && r.chance(0.7) && !s.bought.has("Claude Mastery Workshop") ? "Claude Mastery Workshop" : workshopFor(w, r, s, t));
  s.bought.add(product);
  const orderId = tagmangoOrderId(r, new Date(t));
  const selfRatings = (o.selfRate ?? r.chance(0.45)) ? selfRatingsFor(r, door ?? "referral") : undefined;
  const order: Order = { product, status: "completed", orderId, door, campaign, referrer: o.referrer ?? null, selfRatings };
  const coupon = r.chance(0.1) && listPriceOf(w, product) >= 999;
  if (coupon) order.amount = listPriceOf(w, product) - 200;
  if (r.chance(0.08)) w.tl.add(t - r.int(2, 6) * MIN, "checkout started", () => tagmango(w, s, { ...order, status: "started" }));
  else if (r.chance(0.03)) w.tl.add(t - r.int(20, 50) * MIN, "checkout failed", () => tagmango(w, s, { ...order, status: "failed" }));
  w.tl.add(t, `buy ${product}`, () => tagmango(w, s, order));
  s.firstPurchaseAt = t;
  if (intro) closeLoop(w, s, t);

  if (r.chance(0.1)) planSupportIssue(w, s, t + r.int(1, 25) * DAY);

  // repeat purchases
  if (r.chance(0.26)) {
    const last = planRepeat(w, s, t);
    if (r.chance(0.35)) planRepeat(w, s, last);
  }
  // the climb
  const climbP = s.job.industry === "business_owner" ? 0.28 : s.job.industry === "senior_manager" || s.job.industry === "it_professional" ? 0.14 : 0.07;
  if (o.climb ?? r.chance(climbP)) planClimb(w, s, t + r.int(14, 130) * DAY, { aiOffice: o.aiOffice });
}

/** Enquires first (Meta lead form, WhatsApp or the website), gets a call or two, then buys. Returns when. */
function planLeadIntro(w: World, s: Story, start: number, door: string | null, campaign: string | null): number {
  const r = s.rng;
  const channel = door === "meta_ad" ? "meta_lead_form" : door === "search_website" ? "website_form" : "whatsapp_api";
  const t0 = start;
  w.tl.add(t0, "enquiry", () =>
    capture(s, {
      email: r.chance(0.6) ? s.p.email : null,
      channel,
      firstDoor: door,
      campaign,
      sourceRef: channel === "meta_lead_form" ? `meta:lead:${r.digits(16)}` : channel === "whatsapp_api" ? `libromi:msg:wamid.${r.hex(24)}` : `website:form:${r.hex(12)}`,
      notes: channel === "whatsapp_api" ? r.pick(["Hi, saw your video. Details of the workshop please", "Is there a Malayalam batch?", "What is the fee?"]) : null,
    }),
  );
  const call1 = workAt(r, t0 + r.int(30, 600) * MIN, 0, s.tz);
  const connected = r.chance(0.65);
  w.tl.add(call1, "first call", async () => {
    await touch(w, s, connected ? said(r, r.pick(["connected", "interested"]), { followUpDays: r.int(1, 2) }) : said(r, "no_answer", { followUpDays: 1 }));
    if (connected && r.chance(0.6)) await rateBySales(w, s, salesRating(r, s));
  });
  const call2 = workAt(r, call1, r.int(1, 2), s.tz);
  w.tl.add(call2, "second touch", () =>
    touch(w, s, said(r, r.pick(["info_sent", "payment_promised"]), { type: "whatsapp" })),
  );
  return call2 + r.int(1, 30) * HOUR;
}

function planRepeat(w: World, s: Story, after: number): number {
  const r = s.rng;
  const at = checkoutTime(r, after + r.int(25, 160) * DAY);
  const product = workshopFor(w, r, s, at);
  if (r.chance(0.3)) {
    const call = workAt(r, at - r.int(2, 6) * DAY, 0, s.tz);
    w.tl.add(call, "repeat nudge", () =>
      touch(w, s, { outcome: "interested", summary: `Told them about the ${product} batch`, followUpDays: r.int(2, 4) }),
    );
    closeLoop(w, s, at);
  }
  w.tl.add(at, `repeat ${product}`, () => tagmango(w, s, { product, status: "completed", orderId: tagmangoOrderId(r, new Date(at)) }));
  return at;
}

/** Workshop feedback call -> brochure -> Applied AI Mastery (TagMango, bank transfer, UPI or EMI) -> maybe The AI Office. */
function planClimb(w: World, s: Story, start: number, o: { aiOffice?: boolean } = {}) {
  const r = s.rng;
  const t1 = workAt(r, start, 0, s.tz);
  w.tl.add(t1, "climb call", async () => {
    await touch(w, s, { outcome: "interested", summary: r.pick(["Liked the workshop; asked about Applied AI Mastery", "Wants to go deeper; explained Applied AI Mastery", "Asked how Applied AI Mastery differs from the workshop"]), followUpDays: r.int(2, 3) });
    if (r.chance(0.75)) await rateBySales(w, s, salesRating(r, s, { warm: true }));
    if (s.job.company && r.chance(0.7)) await editProfile(w, s, { designation: s.job.designation, companyName: s.job.company, language: s.p.language });
  });
  const t2 = workAt(r, t1, r.int(2, 3), s.tz);
  w.tl.add(t2, "brochure", () => touch(w, s, { type: "whatsapp", outcome: "info_sent", summary: "Sent the Applied AI Mastery brochure and EMI options", followUpDays: r.int(1, 2) }));
  const t3 = workAt(r, t2, r.int(1, 2), s.tz);
  w.tl.add(t3, "promise", () => touch(w, s, { outcome: "payment_promised", summary: r.pick(SAY.promised), followUpDays: 2 }));
  const t4 = t3 + r.int(4, 40) * HOUR;
  const gcc = s.team === "dubai";
  const how = gcc ? "aed" : r.weighted([
    ["tagmango", 40],
    ["transfer", 40],
    ["emi", 20],
  ] as const);
  w.tl.add(t4, "buy Applied AI Mastery", async () => {
    if (how === "tagmango") {
      const discounted = r.chance(0.3);
      await tagmango(w, s, { product: "Applied AI Mastery", status: "completed", orderId: tagmangoOrderId(r, new Date()), amount: discounted ? 19999 : undefined });
    } else if (how === "aed") {
      const amount = aed(w, 24999, Date.now());
      await manualSale(w, s, { product: "Applied AI Mastery", amount, currency: "AED", listPrice: amount, discount: 0, mode: "bank_transfer", verifyAfterHours: r.int(2, 30) });
    } else if (how === "emi") {
      await manualSale(w, s, { product: "Applied AI Mastery", amount: 24999, currency: "INR", mode: r.pick(["bank_transfer", "upi_qr"] as const), instalments: [8333, 8333, 8333], payInstalments: [2, 3], verifyAfterHours: r.int(2, 24) });
    } else {
      await manualSale(w, s, { product: "Applied AI Mastery", amount: r.chance(0.25) ? 22499 : 24999, currency: "INR", mode: r.pick(["bank_transfer", "upi_qr"] as const), verifyAfterHours: r.weighted([[r.int(1, 20), 7], [r.int(20, 60), 2], [r.int(60, 120), 1]] as const) });
    }
  });
  w.tl.add(workAt(r, t4, 1, s.tz), "welcome to AAM", () => touch(w, s, { type: "whatsapp", outcome: "paid", summary: "Added to the Applied AI Mastery batch group" }));

  const officeP = o.aiOffice ?? (gcc || s.job.industry === "business_owner" ? r.chance(0.35) : r.chance(0.08));
  if (!officeP) return;
  const t5 = workAt(r, t4, r.int(60, 200), s.tz);
  w.tl.add(t5, "AI Office meeting", async () => {
    await touch(w, s, { type: "meeting", outcome: "interested", summary: gcc ? "Met at the Dubai office; wants The AI Office for his managers" : "Zoom call: interested in The AI Office membership", followUpDays: 2 });
  });
  const t6 = workAt(r, t5, r.int(2, 6), s.tz);
  w.tl.add(t6, "buy The AI Office", async () => {
    if (gcc && r.chance(0.6)) {
      const amount = Math.round((999 * 83.2) / aedRate(w, Date.now()));
      await manualSale(w, s, { product: "The AI Office membership", amount, currency: "AED", listPrice: amount, discount: 0, mode: "bank_transfer", verifyAfterHours: r.int(3, 30) });
    } else {
      await manualSale(w, s, { product: "The AI Office membership", amount: 999, currency: "USD", mode: "bank_transfer", verifyAfterHours: r.int(3, 30) });
    }
  });
  closeLoop(w, s, t6);
}

function planSupportIssue(w: World, s: Story, at: number) {
  const r = s.rng;
  const [issue, fix] = r.pick(SAY.support);
  const by: MemberKey = s.team === "dubai" ? "joseph" : r.chance(0.8) ? "sana" : "joseph";
  w.tl.add(workAt(r, at, 0, s.team === "dubai" ? GST : IST), "support issue", () =>
    touch(w, s, { type: "support_issue", outcome: "resolved", summary: `${issue}. ${fix}.`, direction: "in", by }),
  );
}

type LeadKind = "active" | "cold" | "lost" | "late_buyer" | "untouched";

/** A lead from an ad, WhatsApp, the website or a salesperson's own Quick Add. Most never buy. */
function planLead(w: World, s: Story, start: number, forced?: LeadKind) {
  const r = s.rng;
  const recent = start > w.T0 - 21 * DAY;
  const kind: LeadKind =
    forced ??
    (recent
      ? r.weighted([
          ["active", 68],
          ["untouched", 8],
          ["lost", 10],
          ["late_buyer", 14],
        ] as const)
      : r.weighted([
          ["cold", 46],
          ["lost", 16],
          ["late_buyer", 16],
          ["untouched", 22],
        ] as const));
  const gccRecent = s.team === "dubai" && start > w.T0 - 25 * DAY;
  const channel = gccRecent && r.chance(0.5) ? "website_form" : r.weighted([
    ["meta_lead_form", 40],
    ["whatsapp_api", 30],
    ["website_form", 10],
    ["quick_add", 20],
  ] as const);
  const metaCampaign = start > w.launches["Claude Mastery Workshop"] && r.chance(0.7) ? "claude_mastery_meta" : null;
  const t0 = channel === "quick_add" ? workAt(r, start, 0, s.tz) : start;
  w.tl.add(t0, `lead via ${channel}`, () => {
    switch (channel) {
      case "meta_lead_form":
        return capture(s, { email: r.chance(0.7) ? s.p.email : null, channel, firstDoor: "meta_ad", campaign: metaCampaign, sourceRef: `meta:lead:${r.digits(16)}`, productInterest: metaCampaign ? "Claude Mastery Workshop" : null });
      case "whatsapp_api":
        return capture(s, { channel, firstDoor: r.chance(0.75) ? "youtube" : "other", sourceRef: `libromi:msg:wamid.${r.hex(24)}`, notes: r.pick(["Hi, I saw your video on ChatGPT for business. Details please", "Fee for the AI workshop?", "Is the class in Malayalam?", "Can my son join? He is in plus two"]) });
      case "website_form":
        return capture(s, {
          email: s.p.email,
          channel,
          firstDoor: gccRecent ? "ai_office" : r.chance(0.6) ? "search_website" : "ai_office",
          campaign: gccRecent ? "ai_office_dubai_oct_2026" : null,
          productInterest: gccRecent || r.chance(0.4) ? "The AI Office membership" : null,
          sourceRef: `website:form:${r.hex(12)}`,
          profile: s.job.company ? { companyName: s.job.company, designation: s.job.designation, industry: s.job.industry } : undefined,
        });
      default: {
        const rep = w.m[s.rep];
        return capture(s, {
          channel: r.chance(0.5) ? "phone_call" : "whatsapp_app",
          firstDoor: r.weighted([
            ["youtube", 4],
            ["book_keynote", 2],
            ["referral", 2],
            ["other", 2],
          ] as const),
          createdById: rep.id,
          ownerId: rep.id,
          notes: r.chance(0.4) ? "Called the sales number after a YouTube live" : null,
        });
      }
    }
  });
  if (kind === "untouched") return;

  let t = channel === "quick_add" ? t0 + r.int(2, 20) * MIN : workAt(r, t0 + r.int(20, 1200) * MIN, 0, s.tz);
  if (kind === "active") {
    const lastAt = Math.max(t + HOUR, workingOn(r, w, w.T0 - r.float(0.1, 5.5) * DAY, s.tz));
    let first = true;
    while (t < lastAt - DAY) {
      const connected = r.chance(first ? 0.6 : 0.7);
      const isFirst = first;
      w.tl.add(t, "lead call", async () => {
        await touch(w, s, said(r, connected ? r.pick(["connected", "interested"]) : r.pick(["no_answer", "busy"]), { followUpDays: connected ? r.int(1, 3) : 1 }));
        if (connected && isFirst && r.chance(0.7)) await rateBySales(w, s, salesRating(r, s));
      });
      first = false;
      t = workAt(r, t, r.int(1, 4), s.tz);
    }
    // the last touch sets the follow-up that is due around today: overdue, today or later this week
    const tz = s.tz;
    let offset = r.weighted([
      [-3, 1],
      [-2, 2],
      [-1, 3],
      [0, 6],
      [1, 3],
      [2, 2],
      [4, 1],
    ] as const);
    let followUpAt = localTimeInDays(new Date(w.T0), tz, offset, r.int(10, 17), r.pick([0, 30])).getTime();
    while (followUpAt <= lastAt + HOUR) followUpAt = localTimeInDays(new Date(w.T0), tz, ++offset, r.int(10, 17), 0).getTime();
    const qualify = r.chance(0.3);
    w.tl.add(lastAt, "lead call (latest)", async () => {
      await touch(w, s, said(r, qualify ? "interested" : r.pick(["connected", "interested", "busy", "info_sent"]), { followUpAt }));
      if (qualify) {
        const id = await liveId(s);
        const actor = await worker(w, s);
        const [c] = id ? await db.select({ n: contacts.purchaseCount, stage: contacts.stage }).from(contacts).where(eq(contacts.id, id)) : [];
        if (id && c && c.n === 0 && c.stage !== "lost" && actor.role !== "support") await setManualStage(id, "qualified", {}, actor);
      }
      if (r.chance(0.45)) await rateBySales(w, s, salesRating(r, s, { warm: qualify }));
    });
    return;
  }

  const tries = kind === "cold" ? r.int(1, 3) : r.int(1, 2);
  for (let i = 0; i < tries; i++) {
    const lastTry = i === tries - 1;
    w.tl.add(t, "lead call", () =>
      touch(
        w,
        s,
        said(r, kind === "cold" ? r.pick(["no_answer", "busy", "no_answer"]) : r.pick(["connected", "no_answer", "interested"]), {
          // a lead the salesperson gives up on gets no next follow-up
          followUpDays: kind === "cold" && lastTry ? null : r.int(1, 3),
        }),
      ),
    );
    t = workAt(r, t, r.int(1, 3), s.tz);
  }
  if (kind === "cold") {
    if (r.chance(0.3)) w.tl.add(t, "last WhatsApp", () => touch(w, s, { type: "whatsapp", outcome: "info_sent", summary: "Sent the details on WhatsApp; no reply" }));
    return;
  }
  if (kind === "lost") {
    const outcome = r.chance(0.2) ? "wrong_number" : "not_interested";
    const reason = lostReasonFor(r, outcome);
    w.tl.add(t, "marked lost", async () => {
      const id = await liveId(s);
      if (!id) return;
      const actor = await worker(w, s);
      const summary = outcome === "wrong_number" ? "Wrong number; says he never enquired" : reason === "price" ? "Felt the fee is too high for now" : reason === "timing" ? "No time until after the exams; call next year" : r.pick(SAY.notInterested);
      await logFromSheet(id, { type: "call", outcome, summary }, { markLost: actor.role !== "support", lostReason: reason }, actor);
    });
    return;
  }
  // late buyer: the calls worked, they pay on TagMango a little later
  w.tl.add(t, "promise", () => touch(w, s, { type: "whatsapp", outcome: "payment_promised", summary: r.pick(SAY.promised), followUpDays: 2 }));
  const buyAt = checkoutTime(r, t + r.int(1, 4) * DAY);
  const product = workshopFor(w, r, s, buyAt);
  w.tl.add(buyAt, `buy ${product}`, () => tagmango(w, s, { product, status: "completed", orderId: tagmangoOrderId(r, new Date(buyAt)), campaign: metaCampaign }));
  s.firstPurchaseAt = buyAt;
  closeLoop(w, s, buyAt);
  if (r.chance(0.25)) planRepeat(w, s, buyAt);
}

/** An MLA program day: a salesperson enters attendees on the spot; a few are called, some buy a workshop later. */
function planMlaEvent(w: World, campaign: string, city: string, day: number, attendees: number, rep: MemberKey) {
  for (let i = 0; i < attendees; i++) {
    const nearby = w.rng.chance(0.7) ? { city } : { region: "kerala" as Region };
    const s = newStory(w, person(w, nearby), { rep, langKnown: true });
    const r = s.rng;
    const at = day + i * r.int(2, 6) * MIN;
    const rateAtEvent = r.chance(0.4);
    w.tl.add(at, "MLA attendee", async () => {
      await capture(s, { channel: "walk_in_event", firstDoor: "mla_program", campaign, createdById: w.m[rep].id, ownerId: w.m[rep].id, email: r.chance(0.3) ? s.p.email : null });
      // they sat through Umer's session: familiarity 4 on the anchored scale
      if (rateAtEvent) await rateBySales(w, s, { umerLevel: 4, aiLevel: r.int(0, 2), ageBand: ageBand(r), gutStars: r.int(2, 4) }, rep);
    });
    if (r.chance(0.35)) {
      const call = workAt(r, at, r.int(1, 3), IST);
      const keen = r.chance(0.5);
      w.tl.add(call, "after-event call", () =>
        touch(w, s, keen ? { outcome: "interested", summary: "Enjoyed the session; wants the entry workshop", followUpDays: 2 } : r.chance(0.5) ? { outcome: "connected", summary: "Thanked them for attending; shared the workshop link" } : said(r, "no_answer")),
      );
      if (keen && !r.chance(0.6)) {
        w.tl.add(workAt(r, call, r.int(2, 3), IST), "after-event follow-up", () => touch(w, s, { type: "whatsapp", outcome: "info_sent", summary: "Sent the workshop link again; no reply" }));
      } else if (keen) {
        const buyAt = checkoutTime(r, call + r.int(1, 3) * DAY);
        w.tl.add(buyAt, "MLA attendee buys", () => tagmango(w, s, { product: "Entry AI Workshop", status: "completed", orderId: tagmangoOrderId(r, new Date(buyAt)), campaign }));
        s.firstPurchaseAt = buyAt;
        closeLoop(w, s, buyAt);
      }
    } else if (r.chance(0.12)) {
      const buyAt = checkoutTime(r, at + r.int(10, 60) * DAY);
      w.tl.add(buyAt, "MLA attendee buys", () => tagmango(w, s, { product: "Entry AI Workshop", status: "completed", orderId: tagmangoOrderId(r, new Date(buyAt)), campaign }));
      s.firstPurchaseAt = buyAt;
    }
  }
}

/** The legacy delegation list (Phase 2 import, by Umer): ~40 people, most with a trip on record. */
function planDelegation(w: World, count: number) {
  const importDay = ago(w, 470, 11);
  const trips = ["Dubai AI Expo delegation", "Singapore Smart City delegation", "China tech delegation", "Europe innovation delegation"];
  const vips: Story[] = [];
  for (let i = 0; i < count; i++) {
    const s = newStory(w, person(w, { region: w.rng.chance(0.8) ? "kerala" : "gcc" }), { langKnown: true });
    s.tags = ["Legacy: Delegation"];
    const r = s.rng;
    if (r.chance(0.6)) s.job = { industry: "business_owner", designation: "Owner", company: `${s.p.last.length > 2 ? s.p.last : s.p.first} ${r.pick(["Traders", "Builders", "Textiles", "Group"])}` };
    const tripAt = w.T0 - r.int(600, 1080) * DAY;
    const trip = r.pick(trips);
    const hasTrip = r.chance(0.62);
    w.tl.add(importDay + i * 4000, "delegation import", async () => {
      await capture(s, {
        channel: "import",
        firstDoor: "delegation",
        email: r.chance(0.7) ? s.p.email : null,
        receivedAt: new Date(tripAt - r.int(20, 60) * DAY),
        createdById: w.m.umer.id,
        skipAlerts: true,
        notes: hasTrip ? `Delegation list: ${trip}, ${new Date(tripAt).getUTCFullYear()}` : "Delegation list: enquired, did not travel",
        profile: s.job.company ? { industry: s.job.industry, companyName: s.job.company, designation: s.job.designation } : undefined,
      });
      if (!hasTrip) return;
      const r2 = await recordPurchase(
        {
          contactId: s.id!,
          productId: P(w, "International delegation").id,
          productName: trip,
          amount: r.int(25, 37) * 5000,
          currency: "INR",
          purchasedAt: new Date(tripAt - r.int(5, 15) * DAY),
          mode: "bank_transfer",
          reference: `DLG-${new Date(tripAt).getUTCFullYear()}-${String(i + 101).padStart(4, "0")}`,
          source: "import",
        },
        { id: w.m.umer.id, role: w.m.umer.role },
      );
      s.paid.push({ ...r2, product: trip });
    });
    if (hasTrip && s.job.industry === "business_owner" && vips.length < Math.max(2, Math.round(10 * w.scale))) vips.push(s);
  }
  // owners work the delegation pool for The AI Office, as the next best offer says
  vips.forEach((s, i) => {
    const r = s.rng;
    const call = workAt(r, importDay + r.int(20, 380) * DAY, 0, s.tz);
    w.tl.add(call, "delegation call", async () => {
      await touch(w, s, { outcome: "interested", summary: "Remembers the trip fondly; interested in The AI Office", followUpDays: 3 });
      await rateBySales(w, s, { ...salesRating(r, s, { warm: true }), umerLevel: r.int(4, 5), spendingBand: r.int(4, 5) });
    });
    if (i % 3 === 2) return;
    const buy = workAt(r, call, r.int(4, 12), s.tz);
    w.tl.add(buy, "delegation buys The AI Office", () =>
      s.team === "dubai"
        ? manualSale(w, s, { product: "The AI Office membership", amount: 3670, currency: "AED", listPrice: 3670, discount: 0, mode: "bank_transfer", verifyAfterHours: r.int(2, 30) })
        : manualSale(w, s, { product: "The AI Office membership", amount: 999, currency: "USD", mode: "bank_transfer", verifyAfterHours: r.int(2, 30) }),
    );
    closeLoop(w, s, buy);
  });
}

/** Advocates: customers who keep bringing people in through their TagMango affiliate link. */
function planAdvocates(w: World, count: number) {
  const specs: { city: string; job: Occupation; door: string; size: [number, number] }[] = [
    { city: "Kozhikode", job: { industry: "healthcare_professional", designation: "Doctor" }, door: "youtube", size: [4, 5] },
    { city: "Kochi", job: { industry: "teacher", designation: "Teacher" }, door: "book_keynote", size: [3, 4] },
    { city: "Dubai", job: { industry: "business_owner", designation: "Managing Director", company: "Noor Spices LLC" }, door: "youtube", size: [3, 4] },
    { city: "Bengaluru", job: { industry: "it_professional", designation: "Engineering Manager" }, door: "youtube", size: [3, 3] },
    { city: "Malappuram", job: { industry: "business_owner", designation: "Owner", company: "Shameer Textiles" }, door: "meta_ad", size: [3, 4] },
  ];
  for (let i = 0; i < Math.min(count, specs.length); i++) {
    const spec = specs[i];
    const s = newStory(w, person(w, { city: spec.city, community: spec.city === "Dubai" ? "malayali_muslim" : undefined }), { langKnown: true });
    s.job = spec.job;
    const r = s.rng;
    const start = w.T0 - r.int(330, 430) * DAY;
    const rich = i === 0;
    planBuyer(w, s, start, { door: spec.door, climb: rich || r.chance(0.5), aiOffice: rich, selfRate: true, leadFirst: false, campaign: null });
    if (rich) {
      w.rich = s;
      planRepeat(w, s, start + 20 * DAY);
      planSupportIssue(w, s, start + 40 * DAY);
      // this week: Premium for the doctors at his clinic, on Today tomorrow
      const meet = workingOn(r, w, w.T0 - 3 * DAY, s.tz);
      w.tl.add(meet, "Premium conversation", async () => {
        await touch(w, s, {
          type: "meeting",
          outcome: "interested",
          summary: "Wants the Premium program for the six doctors at his clinic; asked for a group price",
          followUpAt: localTimeInDays(new Date(w.T0), s.tz, 1, 11, 0).getTime(),
        });
        await rateBySales(w, s, { aiLevel: 3, umerLevel: 5, spendingBand: 5, gutStars: 5, notes: "Our best advocate: four colleagues joined through him" });
        await editProfile(w, s, { tags: ["VIP", "Mentor prospect"] });
      });
    }
    // referrals spread from soon after the first purchase until the last few weeks
    const n = r.int(spec.size[0], spec.size[1]);
    const from = (s.firstPurchaseAt ?? start) + r.int(10, 30) * DAY;
    const to = w.T0 - r.int(5, 40) * DAY;
    for (let k = 0; k < n; k++) {
      const at = from + ((to - from) * k) / Math.max(1, n - 1) + r.int(-4, 4) * DAY;
      const friend = newStory(w, person(w, r.chance(0.7) ? { city: spec.city } : { region: spec.city === "Dubai" ? "gcc" : "kerala" }));
      if (spec.job.industry === "teacher" && r.chance(0.7)) friend.job = { industry: "teacher", designation: "Teacher" };
      planBuyer(w, friend, at, { referrer: s, leadFirst: false, climb: false });
      // the owner calls the advocate to thank them (the "new advocate" row on Today)
      w.tl.add(workAt(r, at, r.int(1, 3), s.tz), "thank the advocate", async () => {
        await touch(w, s, { outcome: "connected", summary: `Thanked them for referring ${friend.p.first}` });
        await completeTasks(w, s, "new_advocate");
      });
      if (i === 4 && k === 0) {
        // a chain: this referral brings two more of their own
        for (let j = 0; j < 2; j++) {
          const next = newStory(w, person(w, { region: "kerala" }));
          planBuyer(w, next, at + r.int(30, 90) * DAY + j * 9 * DAY, { referrer: friend, leadFirst: false, climb: false });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Set pieces: the moments every screen should show today
// ---------------------------------------------------------------------------

function planSetPieces(w: World) {
  const T0 = w.T0;
  const story = (o: Parameters<typeof makePerson>[2], s?: { rep?: MemberKey; job?: Occupation }) => {
    const st = newStory(w, person(w, o), { rep: s?.rep, langKnown: true });
    if (s?.job) st.job = s.job;
    return st;
  };

  // ---- two hot grade-A leads in the last day
  const khalid = story({ city: "Dubai", community: "arab", gender: "m" }, { job: { industry: "business_owner", designation: "Managing Director", company: "Al Noor Logistics LLC" } });
  w.tl.add(T0 - 3 * HOUR - 10 * MIN, "hot lead (Dubai)", () =>
    capture(khalid, {
      email: khalid.p.email,
      channel: "website_form",
      firstDoor: "ai_office",
      campaign: "ai_office_dubai_oct_2026",
      productInterest: "The AI Office membership",
      sourceRef: `website:form:${khalid.rng.hex(12)}`,
      profile: { industry: "business_owner", designation: "Managing Director", companyName: "Al Noor Logistics LLC", language: "en" },
      selfRatings: { umerLevel: 3, aiLevel: 3, ageBand: "45-54", spendingBand: 5 },
      notes: "Wants The AI Office for his 12 managers; asked for a call before the October session",
    }),
  );
  const sreejith = story({ city: "Kochi", community: "malayali_hindu", gender: "m" }, { job: { industry: "business_owner", designation: "Founder", company: "Nair Hardware & Paints" } });
  const hot2 = T0 - 20 * HOUR;
  w.tl.add(hot2, "hot lead (Kochi)", () =>
    capture(sreejith, {
      email: sreejith.p.email,
      channel: "meta_lead_form",
      firstDoor: "meta_ad",
      campaign: "claude_mastery_meta",
      productInterest: "Claude Mastery Workshop",
      sourceRef: `meta:lead:${sreejith.rng.digits(16)}`,
      profile: { industry: "business_owner", designation: "Founder", companyName: "Nair Hardware & Paints" },
      selfRatings: { umerLevel: 4, aiLevel: 2, ageBand: "35-44", spendingBand: 4 },
    }),
  );
  w.tl.add(hot2 + 95 * MIN, "hot lead call", () =>
    touch(w, sreejith, { outcome: "interested", summary: "Runs three hardware shops; wants AI for quotations and stock. Call back with the batch dates", followUpAt: localTimeInDays(new Date(T0), IST, 0, 16, 30).getTime() }),
  );

  // ---- untouched leads (assigned 1-2 days ago, nobody has called)
  for (let i = 0; i < 3; i++) {
    const s = story({ region: i === 2 ? "gcc" : "kerala" });
    w.tl.add(T0 - (28 + i * 9) * HOUR, "untouched lead", () =>
      capture(s, { channel: "meta_lead_form", firstDoor: "meta_ad", campaign: "claude_mastery_meta", email: s.p.email, sourceRef: `meta:lead:${s.rng.digits(16)}` }),
    );
  }

  // ---- abandoned checkouts in the last day (and one recovered)
  // checkout times in the last day at hours people shop (each over an hour old, so the rule has fired)
  const slots = [
    ...[21, 19, 14, 12, 10].map((h) => ago(w, 0, h, w.rng.int(0, 59))),
    ...[22, 21, 20, 18, 15, 12].map((h) => ago(w, 1, h, w.rng.int(0, 59))),
  ].filter((t) => t < T0 - 75 * MIN && t > T0 - 23 * HOUR);
  const abandon = (product: string, status: "started" | "failed", existing?: Story) => {
    const s = existing ?? story({ region: w.rng.chance(0.75) ? "kerala" : "gcc" });
    const at = slots.shift() ?? T0 - 2 * HOUR;
    const orderId = tagmangoOrderId(s.rng, new Date(at));
    w.tl.add(at, `checkout ${status}`, () => tagmango(w, s, { product, status, orderId, door: existing ? undefined : s.rng.pick(["youtube", "meta_ad"]) }));
    if (status === "failed") w.tl.add(at - 6 * MIN, "checkout started", () => tagmango(w, s, { product, status: "started", orderId, door: existing ? undefined : "youtube" }));
    return s;
  };
  abandon("Claude Mastery Workshop", "started");
  abandon("AI Workshop", "failed");
  abandon("Entry AI Workshop", "failed");
  // an existing workshop customer stalls on the Applied AI Mastery checkout
  const repeatCustomer = story({ region: "kerala" }, { job: { industry: "senior_manager", designation: "Branch Manager" } });
  planBuyer(w, repeatCustomer, T0 - 140 * DAY, { door: "youtube", climb: false, leadFirst: false });
  planRepeat(w, repeatCustomer, T0 - 140 * DAY);
  abandon("Applied AI Mastery", "failed", repeatCustomer);
  // recovered: started, abandoned an hour later, the owner called, paid that evening
  const recovered = story({ region: "kerala" });
  const startedAt = T0 - 30 * HOUR;
  const recoveredOrder = tagmangoOrderId(recovered.rng, new Date(startedAt));
  w.tl.add(startedAt, "checkout started", () => tagmango(w, recovered, { product: "AI Workshop", status: "started", orderId: recoveredOrder, door: "youtube" }));
  w.tl.add(startedAt + 70 * MIN, "abandoned-checkout rule", () => abandonedCheckouts(new Date()));
  w.tl.add(startedAt + 3 * HOUR, "recovery call", () => touch(w, recovered, { outcome: "payment_promised", summary: "Card was declined; will retry with UPI tonight", followUpDays: 1 }));
  w.tl.add(startedAt + 5 * HOUR, "checkout completed", async () => {
    // the money module checks the alert was raised before the payment: put database stamps on the timeline first
    await backdateSoFar();
    await tagmango(w, recovered, { product: "AI Workshop", status: "completed", orderId: tagmangoOrderId(recovered.rng, new Date()) });
  });
  closeLoop(w, recovered, startedAt + 5 * HOUR);

  // ---- bank transfers waiting for verification (some older than 2 days)
  const waiting: { hoursAgo: number; product: string; amount: number; currency: string; mode: PaymentMode; region: Region; rep: MemberKey }[] = [
    { hoursAgo: 4 * 24 + 3, product: "Applied AI Mastery", amount: 24999, currency: "INR", mode: "bank_transfer", region: "kerala", rep: "asha" },
    { hoursAgo: 3 * 24 + 5, product: "Applied AI Mastery", amount: 1110, currency: "AED", mode: "bank_transfer", region: "gcc", rep: "omar" },
    { hoursAgo: 5 * 24 + 2, product: "The AI Office membership", amount: 3670, currency: "AED", mode: "bank_transfer", region: "gcc", rep: "fatima" },
    { hoursAgo: 26, product: "AI Workshop", amount: 999, currency: "INR", mode: "upi_qr", region: "kerala", rep: "ravi" },
    { hoursAgo: 10, product: "Consulting engagement", amount: 50000, currency: "INR", mode: "bank_transfer", region: "kerala", rep: "biju" },
  ];
  for (const x of waiting) {
    const s = story({ region: x.region }, { rep: x.rep, job: x.product === "Consulting engagement" ? { industry: "business_owner", designation: "Director", company: "Malabar Agro Foods" } : undefined });
    const payAt = workingOn(s.rng, w, T0 - x.hoursAgo * HOUR, s.tz);
    w.tl.add(payAt - 9 * DAY, "enquiry", () =>
      capture(s, { channel: "whatsapp_app", firstDoor: "youtube", createdById: w.m[x.rep].id, ownerId: w.m[x.rep].id, email: s.p.email }),
    );
    w.tl.add(payAt - 8 * DAY, "call", async () => {
      await touch(w, s, { outcome: "interested", summary: `Discussed ${x.product}`, followUpDays: 3 });
      await rateBySales(w, s, salesRating(s.rng, s, { warm: true }));
    });
    w.tl.add(payAt - 4 * DAY, "bank details", () => touch(w, s, { type: "whatsapp", outcome: "info_sent", summary: "Sent the bank details and the batch dates", followUpDays: 3 }));
    w.tl.add(payAt - 3 * HOUR, "promise", () => touch(w, s, { outcome: "payment_promised", summary: "Will transfer today and send the screenshot" }));
    const listed = x.currency !== "INR" ? { listPrice: x.amount, discount: 0 } : {};
    w.tl.add(payAt, "payment recorded", () => manualSale(w, s, { product: x.product, amount: x.amount, currency: x.currency, mode: x.mode, verifyAfterHours: null, by: x.rep, ...listed }));
  }

  // ---- EMI: one instalment overdue, one due in two days, others scheduled
  const emi = (o: { region: Region; rep: MemberKey; product: string; amounts: number[]; currency: string; startDaysAgo: number; every: number; pay: number[] }) => {
    const s = story({ region: o.region }, { rep: o.rep });
    const at = workAt(s.rng, T0 - o.startDaysAgo * DAY, 0, s.tz);
    w.tl.add(at - 5 * DAY, "enquiry", () => capture(s, { channel: "whatsapp_app", firstDoor: "youtube", createdById: w.m[o.rep].id, ownerId: w.m[o.rep].id, email: s.p.email }));
    w.tl.add(at - 4 * DAY, "call", () => touch(w, s, { outcome: "interested", summary: `Wants ${o.product} on EMI`, followUpDays: 2 }));
    const total = o.amounts.reduce((a, b) => a + b, 0);
    const listed = o.currency !== "INR" ? { listPrice: total, discount: 0 } : {};
    w.tl.add(at, "EMI purchase", () =>
      manualSale(w, s, { product: o.product, amount: total, currency: o.currency, mode: "bank_transfer", instalments: o.amounts, everyDays: o.every, payInstalments: o.pay, verifyAfterHours: 20, by: o.rep, ...listed }),
    );
    closeLoop(w, s, at);
    return s;
  };
  // #2 paid, #3 four days overdue
  emi({ region: "kerala", rep: "biju", product: "Applied AI Mastery", amounts: [8333, 8333, 8333], currency: "INR", startDaysAgo: 94, every: 45, pay: [2] });
  // #2 due in two days
  emi({ region: "gcc", rep: "fatima", product: "Applied AI Mastery", amounts: [370, 370, 370], currency: "AED", startDaysAgo: 28, every: 30, pay: [] });
  // #2 due tomorrow
  emi({ region: "kerala", rep: "asha", product: "Applied AI Mastery", amounts: [8333, 8333, 8333], currency: "INR", startDaysAgo: 29, every: 30, pay: [] });
  // Premium on EMI: #2 paid, #3 in about three weeks
  emi({ region: "kerala", rep: "ravi", product: "Premium program", amounts: [50000, 50000, 50000], currency: "INR", startDaysAgo: 40, every: 30, pay: [2] });

  // ---- two refunds
  const refundCase = (o: { daysAgo: number; product: string; amount: number; reason: string; refund: number; afterDays: number }) => {
    const s = story({ region: "kerala" });
    const at = checkoutTime(s.rng, T0 - o.daysAgo * DAY);
    w.tl.add(at, `buy ${o.product}`, () => tagmango(w, s, { product: o.product, status: "completed", orderId: tagmangoOrderId(s.rng, new Date(at)), amount: o.amount, door: "meta_ad" }));
    w.tl.add(workAt(s.rng, at, o.afterDays, IST), "refund", async () => {
      await touch(w, s, { type: "support_issue", outcome: "resolved", summary: o.reason, direction: "in", by: "sana" });
      const paid = s.paid[0];
      if (paid) await recordRefund(paid.purchaseId, { amount: o.refund, reason: o.reason, mode: "tagmango" }, w.m.meera);
    });
  };
  refundCase({ daysAgo: 52, product: "AI Workshop", amount: 999, refund: 999, afterDays: 3, reason: "Could not attend the live sessions; asked for a refund" });
  refundCase({ daysAgo: 110, product: "Applied AI Mastery", amount: 24999, refund: 5000, afterDays: 6, reason: "The early-bird discount promised on the call was not applied" });

  // ---- B2B: a school and a Dubai company
  planB2B(w);

  // ---- possible duplicates: same name in the same city, different numbers (4 open, 1 merged)
  const originals = w.stories.filter((s) => s.firstPurchaseAt && s.firstPurchaseAt < T0 - 80 * DAY && !s.tags?.length).slice(0, 40);
  const picks = w.rng.shuffle([...originals]).slice(0, 5);
  picks.forEach((orig, i) => {
    const twin = newStory(w, { ...orig.p, phone: mobileNumber(w.rng, countryOfPhone(orig.p.phone), w.pool.phones), email: `${orig.p.email.split("@")[0]}.work@${orig.p.email.split("@")[1]}` }, { langKnown: true });
    const at = workAt(twin.rng, Math.max(orig.firstPurchaseAt! + 20 * DAY, T0 - (i === 4 ? 45 : 30 - i * 6) * DAY), 0, twin.tz);
    w.tl.add(at, "second number", () =>
      capture(twin, {
        channel: i % 2 ? "whatsapp_api" : "website_form",
        firstDoor: "other",
        email: twin.p.email,
        sourceRef: i % 2 ? `libromi:msg:wamid.${twin.rng.hex(24)}` : `website:form:${twin.rng.hex(12)}`,
      }),
    );
    if (i === 4) {
      // Meera checks the review and merges the two records
      w.tl.add(at + 2 * DAY, "merge duplicate", async () => {
        const a = await liveId(orig);
        const b = await liveId(twin);
        if (a && b && a !== b) await mergeContacts(a, b, w.m.meera, "Same person: second number from his office");
      });
    }
  });

  // ---- transfer requests: two waiting for Meera, one approved months ago
  const movedToDubai = story({ region: "kerala" });
  movedToDubai.p = { ...movedToDubai.p, city: "Dubai", state: null, country: "AE" };
  w.tl.add(T0 - 40 * DAY, "enquiry", () => capture(movedToDubai, { channel: "whatsapp_api", firstDoor: "youtube", email: movedToDubai.p.email, sourceRef: `libromi:msg:wamid.${movedToDubai.rng.hex(24)}` }));
  w.tl.add(workAt(movedToDubai.rng, T0 - 40 * DAY, 0, IST), "call", () => touch(w, movedToDubai, { outcome: "interested", summary: "Moved to Dubai last month; still on his Indian number", followUpDays: 3 }));
  w.tl.add(T0 - 37 * DAY, "buy", () => tagmango(w, movedToDubai, { product: "AI Workshop", status: "completed", orderId: tagmangoOrderId(movedToDubai.rng, new Date(T0 - 37 * DAY)) }));
  closeLoop(w, movedToDubai, T0 - 37 * DAY);
  w.tl.add(T0 - 26 * HOUR, "transfer request (Fatima)", async () => {
    const id = await liveId(movedToDubai);
    const [c] = id ? await db.select({ ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, id)) : [];
    if (id && c?.ownerId !== w.m.fatima.id) await requestTransfer(id, w.m.fatima, "Lives in Dubai now; I can meet him at the AI Office session");
  });
  w.tl.add(T0 - 5 * HOUR, "transfer request (Ravi)", async () => {
    const [c] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(isNull(contacts.ownerId), isNull(contacts.mergedIntoId), eq(contacts.firstCampaign, "koduvally_ai_literacy"), eq(contacts.purchaseCount, 0)))
      .orderBy(asc(contacts.createdAt))
      .limit(1);
    if (c) await requestTransfer(c.id, w.m.ravi, "Called me directly after the Koduvally session; I know the family");
  });
  w.tl.add(T0 - 95 * DAY, "transfer request (Asha, approved)", async () => {
    const [c] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(isNull(contacts.ownerId), isNull(contacts.mergedIntoId), eq(contacts.phoneCountry, "IN"), eq(contacts.purchaseCount, 0)))
      .orderBy(asc(contacts.createdAt))
      .limit(1);
    if (!c) return;
    const res = await requestTransfer(c.id, w.m.asha, "She messaged me on WhatsApp about the teachers' batch");
    const taskId = res.taskIds[0];
    if (taskId) w.tl.add(Date.now() + 20 * HOUR, "approve transfer", () => resolveTransferRequest(taskId, "approve", w.m.meera));
  });

  // ---- Umer's own network and Meera's accounts (their Today is not empty either)
  planPersonal(w, "umer", [
    { city: "Kochi", job: { industry: "business_owner", designation: "Chairman", company: "Periyar Group" }, door: "book_keynote", buy: "Premium program", latest: "Wants Premium seats for two more directors next quarter" },
    { city: "Dubai", job: { industry: "business_owner", designation: "CEO", company: "Gulf Bridge Contracting" }, door: "business_partner", buy: "The AI Office membership", latest: "Asked for the AI Office calendar for his site managers" },
    { city: "Thiruvananthapuram", job: { industry: "senior_manager", designation: "Director", company: "Technopark startup" }, door: "book_keynote", buy: null, latest: "Will confirm the team workshop after the board meeting" },
    { city: "Kozhikode", job: { industry: "business_owner", designation: "Owner", company: "Malabar Hospitals" }, door: "business_partner", buy: "Consulting engagement", latest: "Asked for references from other hospitals for phase two" },
    { city: "Abu Dhabi", job: { industry: "senior_manager", designation: "Head of HR" }, door: "book_keynote", buy: null, latest: "Wants a proposal for 25 managers before Diwali" },
  ]);
  planPersonal(w, "meera", [
    { city: "Thrissur", job: { industry: "senior_manager", designation: "HR Manager", company: "Thrissur Cooperative Bank" }, door: "search_website", buy: null, latest: "Bank wants a quote for 60 staff; sent two options" },
    { city: "Kochi", job: { industry: "business_owner", designation: "Owner", company: "Cochin Travels" }, door: "referral", buy: "Applied AI Mastery", latest: "Doing well in the batch; may send his two managers" },
    { city: "Kannur", job: { industry: "government", designation: "Deputy Tahsildar" }, door: "mla_program", buy: null, latest: "Asked whether the taluk office staff can join on a weekend" },
  ]);

  // ---- support issues in the last few days (the contact page timeline and support's own view)
  const customers = w.stories.filter((s) => s.firstPurchaseAt && s.firstPurchaseAt < T0 - 10 * DAY);
  for (let i = 0; i < 6 && customers.length; i++) {
    const s = w.rng.pick(customers);
    planSupportIssue(w, s, T0 - w.rng.int(1, 4) * DAY);
  }
  // ---- two climbs this month that already went through
  for (let i = 0; i < 2; i++) {
    const s = story({ region: "kerala" }, { job: { industry: "business_owner", designation: "Owner" } });
    planBuyer(w, s, T0 - (90 + i * 30) * DAY, { door: "youtube", climb: false, leadFirst: false });
    const at = checkoutTime(s.rng, T0 - (3 + i * 4) * DAY);
    w.tl.add(at - 2 * DAY, "climb call", () => touch(w, s, { outcome: "interested", summary: "Ready for Applied AI Mastery; will pay on TagMango", followUpDays: 2 }));
    w.tl.add(at, "buy Applied AI Mastery", () => tagmango(w, s, { product: "Applied AI Mastery", status: "completed", orderId: tagmangoOrderId(s.rng, new Date(at)) }));
    closeLoop(w, s, at);
  }
}

/** People a manager or Umer handles personally (Quick Add with themselves as owner). */
function planPersonal(w: World, who: MemberKey, list: { city: string; job: Occupation; door: string; buy: string | null; latest: string }[]) {
  const T0 = w.T0;
  const owner = w.m[who];
  list.forEach((x, i) => {
    const s = newStory(w, person(w, { city: x.city }), { rep: who, langKnown: true });
    s.job = x.job;
    const r = s.rng;
    // an open lead with no touch for a week goes back to the pool, whoever owns it: these are worked closely
    const start = workAt(r, x.buy ? T0 - r.int(60, 200) * DAY : T0 - r.int(9, 18) * DAY, 0, s.tz);
    w.tl.add(start, "personal contact", () =>
      capture(s, {
        channel: r.pick(["phone_call", "whatsapp_app"]),
        firstDoor: x.door,
        email: s.p.email,
        createdById: owner.id,
        ownerId: owner.id,
        profile: { industry: x.job.industry, designation: x.job.designation, companyName: x.job.company ?? null },
      }),
    );
    w.tl.add(start + 2 * HOUR, "meeting", async () => {
      await touch(w, s, { type: "meeting", outcome: "interested", summary: x.job.company ? `Met at ${x.job.company}; talked about AI for the team` : "Coffee meeting after the keynote", by: who, followUpDays: 3 });
      await rateBySales(w, s, { ...salesRating(r, s, { warm: true }), umerLevel: who === "umer" ? 5 : 3, gutStars: 5 }, who);
    });
    if (x.buy) {
      const buyAt = workAt(r, start, r.int(3, 5), s.tz);
      const amount = x.buy === "The AI Office membership" ? 999 : P(w, x.buy).listPrice;
      const currency = x.buy === "The AI Office membership" ? "USD" : "INR";
      w.tl.add(buyAt, `buy ${x.buy}`, async () => {
        const paid = await manualSale(w, s, { product: x.buy!, amount, currency, mode: "bank_transfer", verifyAfterHours: who === "umer" ? null : 6, by: who });
        // an admin may verify what they recorded themselves
        if (paid && who === "umer") await verifyPayment(paid.paymentIds[0], w.m.umer);
      });
      closeLoop(w, s, buyAt);
    }
    // the latest touch: follow-ups due today, overdue and next week
    const offset = [0, -1, 0, 3, -2][i % 5];
    const followUpAt = localTimeInDays(new Date(T0), owner.timezone, offset, 11 + i, 0).getTime();
    const lastAt = workingOn(r, w, Math.min(followUpAt - 2 * DAY, T0 - 2 * HOUR), owner.timezone);
    if (!x.buy) {
      // in between: a proposal, a call, a WhatsApp every few days
      for (let t = workAt(r, start, r.int(2, 4), s.tz); t < lastAt - DAY; t = workAt(r, t, r.int(2, 4), s.tz)) {
        w.tl.add(t, "personal touch", () =>
          touch(w, s, { type: r.pick(["call", "whatsapp", "email"] as const), outcome: r.pick(["connected", "info_sent"]), summary: r.pick(["Sent the proposal draft", "Shared case studies from two clients", "Discussed dates and the team size", "Introduced Meera for the logistics"]), by: who, followUpDays: 3 }),
        );
      }
    }
    w.tl.add(lastAt, "latest touch", () =>
      touch(w, s, { type: r.pick(["call", "whatsapp", "meeting"] as const), outcome: "connected", summary: x.latest, by: who, followUpAt }),
    );
  });
}

function planB2B(w: World) {
  // a school in Thrissur buys the School AI program
  const principal = newStory(w, person(w, { city: "Thrissur", community: "malayali_christian", gender: "f" }), { rep: "ravi", langKnown: true });
  principal.job = { industry: "teacher", designation: "Principal", company: "St. Mary's Higher Secondary School" };
  let schoolId: string | null = null;
  const t0 = ago(w, 150, 11);
  w.tl.add(t0, "school enquiry", () =>
    capture(principal, { channel: "website_form", firstDoor: "school_partnership", email: principal.p.email, productInterest: "School AI program", sourceRef: `website:form:${principal.rng.hex(12)}`, notes: "AI training for 40 teachers and the senior students" }),
  );
  w.tl.add(t0 + 3 * HOUR, "call", () => touch(w, principal, { outcome: "interested", summary: "Wants a proposal for 40 teachers", followUpDays: 4 }));
  w.tl.add(ago(w, 146, 15), "school visit", async () => {
    const actor = await worker(w, principal);
    const org = await createOrganisation({ name: "St. Mary's Higher Secondary School", kind: "school", city: "Thrissur", state: "Kerala", country: "IN" }, actor);
    schoolId = org.id;
    await editProfile(w, principal, { organisationId: org.id, type: "business", designation: "Principal", companyName: org.name });
    await touch(w, principal, { type: "meeting", outcome: "interested", summary: "Met the principal and the manager; proposal sent for June", followUpDays: 5 });
  });
  w.tl.add(ago(w, 142, 12), "management approves", () =>
    touch(w, principal, { outcome: "payment_promised", summary: "Management approved; invoice sent, NEFT next week", followUpDays: 4 }),
  );
  w.tl.add(ago(w, 138, 12), "school pays", () =>
    manualSale(w, principal, { product: "School AI program", amount: 100000, currency: "INR", mode: "bank_transfer", verifyAfterHours: 22, organisationId: () => schoolId, notes: "Batch 1: 40 teachers, June" }),
  );
  closeLoop(w, principal, ago(w, 138, 12));

  // a trading company in Dubai buys a consulting engagement (in AED)
  const partner = newStory(w, person(w, { city: "Dubai", community: "malayali_muslim", gender: "m" }), { rep: "omar", langKnown: true });
  partner.job = { industry: "business_owner", designation: "Managing Partner", company: "Gulf Star Trading LLC" };
  let companyId: string | null = null;
  const c0 = ago(w, 96, 10, 0, GST);
  w.tl.add(c0, "company enquiry", () =>
    capture(partner, { channel: "meta_lead_form", firstDoor: "meta_ad", email: partner.p.email, sourceRef: `meta:lead:${partner.rng.digits(16)}`, profile: { industry: "business_owner", designation: "Managing Partner", companyName: "Gulf Star Trading LLC" } }),
  );
  w.tl.add(c0 + 4 * HOUR, "call", () => touch(w, partner, { outcome: "interested", summary: "Wants AI to answer supplier emails and track shipments", followUpDays: 2 }));
  w.tl.add(ago(w, 92, 16, 0, GST), "office visit", async () => {
    const actor = await worker(w, partner);
    const org = await createOrganisation({ name: "Gulf Star Trading LLC", kind: "company", city: "Dubai", country: "AE" }, actor);
    companyId = org.id;
    await editProfile(w, partner, { organisationId: org.id, type: "business" });
    await touch(w, partner, { type: "meeting", outcome: "interested", summary: "Office visit in Deira: scoped a 4-week consulting engagement", followUpDays: 3 });
    await rateBySales(w, partner, { aiLevel: 2, umerLevel: 2, spendingBand: 5, gutStars: 5, ageBand: "45-54", industry: "business_owner", notes: "Imports spices and dry fruits; 30 staff" });
  });
  w.tl.add(ago(w, 89, 12, 0, GST), "company pays", () =>
    manualSale(w, partner, { product: "Consulting engagement", amount: 4400, currency: "AED", listPrice: 4400, discount: 0, mode: "bank_transfer", verifyAfterHours: 30, organisationId: () => companyId, notes: "4-week engagement: supplier email assistant" }),
  );
  closeLoop(w, partner, ago(w, 89, 12, 0, GST));
}

// ---------------------------------------------------------------------------
// Running the plan
// ---------------------------------------------------------------------------

async function run(w: World) {
  let done = 0;
  const total = w.tl.size;
  // Date is simulated while the plan runs: time the run with the monotonic clock
  const t0 = performance.now();
  for (let step = w.tl.pop(); step; step = w.tl.pop()) {
    w.clock.set(new Date(step.at));
    await w.clock.mark();
    try {
      await step.run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Demo step "${step.label}" (${new Date(step.at).toISOString()}) failed: ${msg}`, { cause: e });
    }
    done += 1;
    if (done % 500 === 0) w.log(`  ${done} steps (${Math.round((performance.now() - t0) / 1000)}s)…`);
  }
  w.log(`  ${done} steps replayed (${total} planned up front, the rest added as the story unfolded) in ${Math.round((performance.now() - t0) / 1000)}s`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function describeAlerts(a: RunAllAlertsResult): string {
  return [
    `${a.abandonedCheckouts.tasks} abandoned checkouts`,
    `${a.untouchedLeads.ownerAlerts} untouched leads`,
    `${a.releaseStaleLeads.released} leads released`,
    `${a.followUpsDue.notified} follow-up pings`,
    `${a.instalmentsDue.dueTasks + a.instalmentsDue.overdueTasks} instalments due`,
    `${a.unverifiedPayments.payments} unverified payments`,
    `${a.dueForNextRung.created} next-rung`,
    `${a.atRisk.created} at-risk`,
    `${a.vipGoneQuiet.contacts} VIPs gone quiet`,
  ].join(", ");
}

async function summarize(w: World, seconds: number): Promise<DemoSummary> {
  const live = isNull(contacts.mergedIntoId);
  const stageRows = await db.select({ k: contacts.stage, n: count() }).from(contacts).where(live).groupBy(contacts.stage);
  const gradeRows = await db.select({ k: contacts.grade, n: count() }).from(contacts).where(live).groupBy(contacts.grade);
  const [{ n, customers, ltv }] = await db
    .select({
      n: count(),
      customers: sql<number>`count(*) filter (where ${contacts.purchaseCount} > 0)`.mapWith(Number),
      ltv: sql<number>`coalesce(sum(${contacts.ltvInr}), 0)`.mapWith(Number),
    })
    .from(contacts)
    .where(live);
  let richContact: string | null = null;
  if (w.rich) {
    const id = await liveId(w.rich);
    if (id) richContact = (await db.select({ name: contacts.name }).from(contacts).where(eq(contacts.id, id)))[0]?.name ?? null;
  }
  return {
    contacts: n,
    customers,
    ltvInr: ltv,
    byStage: Object.fromEntries(stageRows.map((r) => [r.k, r.n])),
    byGrade: Object.fromEntries(gradeRows.map((r) => [r.k ?? "unscored", r.n])),
    seconds,
    richContact,
  };
}

async function counts() {
  const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  return {
    purchases: await one(db.select({ n: count() }).from(purchases)),
    unverified: await one(db.select({ n: count() }).from(payments).where(and(eq(payments.status, "unverified"), eq(payments.kind, "payment")))),
    scheduled: await one(db.select({ n: count() }).from(payments).where(eq(payments.status, "scheduled"))),
    refunds: await one(db.select({ n: count() }).from(payments).where(eq(payments.kind, "refund"))),
    interactions: await one(db.select({ n: count() }).from(interactions)),
    rated: await one(db.select({ n: sql<number>`count(distinct ${ratings.contactId})`.mapWith(Number) }).from(ratings)),
    openTasks: await one(db.select({ n: count() }).from(tasks).where(eq(tasks.status, "open"))),
    unread: await one(db.select({ n: count() }).from(notifications).where(isNull(notifications.readAt))),
    reviews: await one(db.select({ n: count() }).from(duplicateReviews).where(eq(duplicateReviews.status, "open"))),
    referred: await one(db.select({ n: count() }).from(contacts).where(and(isNotNull(contacts.referredById), isNull(contacts.mergedIntoId)))),
  };
}

function formatSummary(s: DemoSummary, c: Awaited<ReturnType<typeof counts>>): string {
  const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(s.ltvInr);
  const fmt = (o: Record<string, number>) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  return [
    `Demo data loaded in ${s.seconds.toFixed(0)}s`,
    `  contacts ${s.contacts} · unique customers ${s.customers} · total LTV ${inr}`,
    `  by stage: ${fmt(s.byStage)}`,
    `  by grade: ${fmt(s.byGrade)}`,
    `  purchases ${c.purchases} · refunds ${c.refunds} · payments waiting for verification ${c.unverified} · instalments scheduled ${c.scheduled}`,
    `  interactions ${c.interactions} · rated contacts ${c.rated} · referred contacts ${c.referred} · open duplicate reviews ${c.reviews}`,
    `  open tasks ${c.openTasks} · unread notifications ${c.unread}`,
    s.richContact ? `  a rich contact page to open: ${s.richContact}` : "",
    `  sign in as umer@ / meera@ / asha@ / biju@ / ravi@ / fatima@ / omar@ / sana@ / joseph@edapt.in — password "${DEMO_PASSWORD}"`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Counts behind the seed log (also used by the integration test). */
export const demoCounts = counts;
