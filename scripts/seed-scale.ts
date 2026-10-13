/**
 * Scale seeder: fills a database with three years of Edapt-sized history for performance work.
 *
 *   DATABASE_URL=postgres://…/edapt_perf npm run db:seed:scale              # 50,000 contacts
 *   DATABASE_URL=… npx tsx --conditions=react-server scripts/seed-scale.ts --contacts 5000 --seed 7 --no-alerts
 *
 * Unlike the demo seeder this does NOT go through the per-row services: rows are generated in memory and written
 * with multi-row INSERTs (about 50,000 contacts, 80,000 purchases with verified payments, 120,000 enquiries,
 * 60,000 interactions, ratings on 30%, referrals, ownership logs and follow-up tasks). The generator keeps the
 * schema's invariants: unique phones and references, existing ids for every reference, amount_inr = amount x the
 * month's rate from Settings > Currency, sales credit only when the owner talked to the buyer in the 30 days
 * before, ratings that match the contact's rated fields. Calculated columns are then written the only way they
 * are ever written — recomputeAll() — and the alert rules run once, with each phase timed.
 *
 * Needs `npm run db:seed` first (admin + products); refuses to run when the database already holds contacts.
 */
import "./env";
import { randomUUID } from "node:crypto";
import { count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  contacts,
  enquiries,
  interactions,
  organisations,
  ownershipLog,
  payments,
  products,
  purchases,
  ratings,
  tasks,
  users,
  type FieldSource,
  type InteractionType,
  type PaymentMode,
  type Role,
} from "@/db/schema";
import { runAllAlerts } from "@/lib/alerts/jobs";
import { hashPassword } from "@/lib/auth/password";
import { recomputeAll } from "@/lib/metrics/recompute";
import { rateFromTable, roundMoney } from "@/lib/money/fx";
import { refreshPurchaseStatus } from "@/lib/money/purchases";
import { getSetting } from "@/lib/settings";
import { DEMO_PASSWORD, DEMO_TEAM } from "./seed-demo";
import { ageBand, countryOfPhone, createRng, makePerson, newPersonPool, occupation, type Rng } from "./seed-data";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const GCC = ["AE", "SA", "QA", "KW", "BH", "OM"];
const CHUNK = 1000;

type Opts = { contacts: number; seed: number; alerts: boolean };

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { contacts: 50_000, seed: 20261013, alerts: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--contacts") opts.contacts = Math.max(100, Math.floor(Number(argv[++i])));
    else if (a === "--seed") opts.seed = Math.floor(Number(argv[++i]));
    else if (a === "--no-alerts") opts.alerts = false;
  }
  if (!Number.isFinite(opts.contacts)) throw new Error("--contacts needs a number");
  return opts;
}

// ---------------------------------------------------------------------------
// Row types (what is written)
// ---------------------------------------------------------------------------

type ContactRow = typeof contacts.$inferInsert;
type EnquiryRow = typeof enquiries.$inferInsert;
type InteractionRow = typeof interactions.$inferInsert & { userId: string };
type RatingRow = typeof ratings.$inferInsert;
type PurchaseRow = typeof purchases.$inferInsert;
type PaymentRow = typeof payments.$inferInsert;
type TaskRow = typeof tasks.$inferInsert;
type OwnershipRow = typeof ownershipLog.$inferInsert;
type OrgRow = typeof organisations.$inferInsert;

type Member = { id: string; role: Role; team: string | null };
type Catalogue = Map<string, { id: string; name: string; family: string; listPrice: number; currency: string }>;

type Out = {
  contacts: ContactRow[];
  enquiries: EnquiryRow[];
  interactions: InteractionRow[];
  ratings: RatingRow[];
  purchases: PurchaseRow[];
  payments: PaymentRow[];
  tasks: TaskRow[];
  ownership: OwnershipRow[];
  organisations: OrgRow[];
  /** purchases whose status must be derived from their payments (EMI, refunds, unverified) */
  special: string[];
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to load scale data in production");
  const t0 = performance.now();
  const lap = (() => {
    let last = performance.now();
    return (label: string) => {
      const now = performance.now();
      console.log(`  ${label}: ${((now - last) / 1000).toFixed(1)}s`);
      last = now;
    };
  })();

  const [{ n: existing }] = await db.select({ n: count() }).from(contacts);
  if (existing > 0) {
    console.log(`The database already holds ${existing} contacts; the scale seeder only fills an empty CRM. Run \`npm run db:reset\` and \`npm run db:seed\` first.`);
    return;
  }
  const catalogue = await loadCatalogue();
  const team = await ensureTeam();
  const currency = await getSetting("currency");
  const thresholds = await getSetting("thresholds");
  console.log(`Generating ${opts.contacts.toLocaleString("en-IN")} contacts over three years (seed ${opts.seed})…`);

  const out = generate(opts, { catalogue, team, rates: currency.rates, creditDays: thresholds.salesCreditDays });
  lap(
    `generated ${out.contacts.length} contacts, ${out.purchases.length} purchases, ${out.payments.length} payments, ` +
      `${out.enquiries.length} enquiries, ${out.interactions.length} interactions, ${out.ratings.length} ratings, ${out.tasks.length} tasks`,
  );

  await insertAll("organisations", out.organisations, (c) => db.insert(organisations).values(c));
  await insertAll("contacts", out.contacts, (c) => db.insert(contacts).values(c));
  await insertAll("ownership_log", out.ownership, (c) => db.insert(ownershipLog).values(c));
  await insertAll("enquiries", out.enquiries, (c) => db.insert(enquiries).values(c));
  await insertAll("interactions", out.interactions, (c) => db.insert(interactions).values(c));
  await insertAll("ratings", out.ratings, (c) => db.insert(ratings).values(c));
  await insertAll("purchases", out.purchases, (c) => db.insert(purchases).values(c));
  await insertAll("payments", out.payments, (c) => db.insert(payments).values(c));
  await insertAll("tasks", out.tasks, (c) => db.insert(tasks).values(c));
  lap("bulk inserts");

  // EMI, refunds and payments still waiting: their status comes from the money module's own rule
  for (const id of out.special) await refreshPurchaseStatus(id);
  lap(`purchase status for ${out.special.length} instalment / refund / unverified purchases`);

  await db.execute(sql`analyze`);
  let tick = performance.now();
  const written = await recomputeAll({
    onProgress: (done, total) => {
      if (performance.now() - tick > 15_000) {
        tick = performance.now();
        console.log(`    recompute ${done}/${total}…`);
      }
    },
  });
  lap(`recomputeAll (cohorts + ${written} contacts)`);

  if (opts.alerts) {
    // fresh planner statistics after the bulk load and the recompute: with stale ones the at-risk rule's anti-join
    // against tasks picks a nested loop and takes minutes instead of seconds
    await db.execute(sql`analyze`);
    const r = await runAllAlerts(new Date());
    lap(
      `alert rules (${r.atRisk.created} at-risk, ${r.dueForNextRung.created} next-rung, ${r.untouchedLeads.ownerAlerts} untouched, ` +
        `${r.releaseStaleLeads.released} released, ${r.instalmentsDue.dueTasks + r.instalmentsDue.overdueTasks} instalments, ${r.vipGoneQuiet.notified} VIP alerts)`,
    );
  }
  await printSummary();
  console.log(`Scale seed finished in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}

async function insertAll<T>(label: string, rows: T[], insert: (chunk: T[]) => PromiseLike<unknown>) {
  const t = performance.now();
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
  console.log(`    ${label}: ${rows.length} rows in ${((performance.now() - t) / 1000).toFixed(1)}s`);
}

async function loadCatalogue(): Promise<Catalogue> {
  const rows = await db.select().from(products);
  const need = ["Entry AI Workshop", "AI Workshop", "AI Agents for Business", "Applied AI Mastery", "The AI Office membership", "Premium program", "Consulting engagement", "School AI program", "Constituency AI literacy program", "International delegation"];
  const map: Catalogue = new Map(rows.map((p) => [p.name, { id: p.id, name: p.name, family: p.family, listPrice: Number(p.listPrice), currency: p.currency }]));
  const missing = need.filter((n) => !map.has(n));
  if (missing.length) throw new Error(`Run \`npm run db:seed\` first: the starter products are missing (${missing.join(", ")})`);
  return map;
}

/** The demo team (same logins as the demo data), created directly when missing. */
async function ensureTeam(): Promise<{ admin: Member; manager: Member; kerala: Member[]; dubai: Member[]; support: Member[] }> {
  const admin = (await db.select().from(users).where(eq(users.role, "admin")).limit(1))[0];
  if (!admin) throw new Error("Run `npm run db:seed` first: there is no admin");
  const have = await db.select().from(users).where(inArray(sql`lower(${users.email})`, DEMO_TEAM.map((m) => m.email)));
  const missing = DEMO_TEAM.filter((m) => !have.some((u) => u.email.toLowerCase() === m.email));
  if (missing.length) {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    await db.insert(users).values(missing.map((m) => ({ name: m.name, email: m.email, role: m.role, team: m.team, timezone: m.timezone, passwordHash })));
  }
  const all = await db.select().from(users).where(eq(users.active, true));
  const m = (u: (typeof all)[number]): Member => ({ id: u.id, role: u.role, team: u.team });
  const manager = all.find((u) => u.role === "manager") ?? admin;
  return {
    admin: m(admin),
    manager: m(manager),
    kerala: all.filter((u) => u.role === "sales" && u.team === "kerala").map(m),
    dubai: all.filter((u) => u.role === "sales" && u.team === "dubai").map(m),
    support: all.filter((u) => u.role === "support").map(m),
  };
}

// ---------------------------------------------------------------------------
// Generation (pure, in memory)
// ---------------------------------------------------------------------------

type Ctx = {
  catalogue: Catalogue;
  team: Awaited<ReturnType<typeof ensureTeam>>;
  rates: Record<string, Record<string, number>>;
  creditDays: number;
};

function generate(opts: Opts, ctx: Ctx): Out {
  const rng = createRng(opts.seed);
  const N = opts.contacts;
  const now = Date.now();
  const START = now - 3 * 365 * DAY;
  const pool = newPersonPool();
  const out: Out = { contacts: [], enquiries: [], interactions: [], ratings: [], purchases: [], payments: [], tasks: [], ownership: [], organisations: [], special: [] };
  const refSeq = { n: 0 };
  const P = (name: string) => ctx.catalogue.get(name)!;
  const workshops = ["Entry AI Workshop", "AI Workshop", "AI Agents for Business", ...[...ctx.catalogue.values()].filter((p) => p.family === "workshop" && !["Entry AI Workshop", "AI Workshop", "AI Agents for Business"].includes(p.name)).map((p) => p.name)];
  const rr = { kerala: 0, dubai: 0 };
  const ownerFor = (country: string) => {
    const list = GCC.includes(country) ? ctx.team.dubai : ctx.team.kerala;
    if (!list.length) return null;
    const key = GCC.includes(country) ? "dubai" : "kerala";
    return list[rr[key]++ % list.length];
  };
  const fx = (cur: string, at: number) => (cur === "INR" ? 1 : rateFromTable(ctx.rates, cur, new Date(at)));

  // organisations (schools, constituency offices, companies)
  const orgCount = Math.max(2, Math.round(N / 250));
  const orgIds: { id: string; kind: string; country: string }[] = [];
  for (let i = 0; i < orgCount; i++) {
    const kind = rng.weighted([
      ["school", 4],
      ["company", 4],
      ["constituency_office", 1],
      ["partner", 1],
    ] as const);
    const p = makePerson(rng, pool, { allowSameNameCity: true });
    const id = randomUUID();
    const name =
      kind === "school"
        ? `${rng.pick(["St. Mary's", "Al Ameen", "Crescent", "Vidya Mandir", "MES", "Carmel", "Bharatiya Vidya"])} ${rng.pick(["Higher Secondary School", "Public School", "English School", "Academy"])}, ${p.city} #${i + 1}`
        : kind === "constituency_office"
          ? `MLA Office, ${p.city} #${i + 1}`
          : `${p.last} ${rng.pick(["Traders", "Group", "Logistics", "Builders", "Retail"])}${p.region === "gcc" ? " LLC" : ""} #${i + 1}`;
    out.organisations.push({ id, name, kind, city: p.city, state: p.state, country: p.country, createdAt: new Date(START + rng.int(0, 700) * DAY) });
    orgIds.push({ id, kind, country: p.country });
  }

  // contacts in creation order (so a referrer always exists before the people it brings)
  const createdAts: number[] = [];
  for (let i = 0; i < N; i++) {
    for (;;) {
      const d = rng.float(0, 3 * 365);
      if (rng.next() <= Math.pow(2, -d / 365)) {
        createdAts.push(now - d * DAY - 2 * HOUR);
        break;
      }
    }
  }
  createdAts.sort((a, b) => a - b);
  const delegationN = Math.round((N * 400) / 50_000);
  const advocates: { id: string; phone: string; weight: number }[] = [];

  for (let i = 0; i < N; i++) {
    const r = rng.fork(i);
    const delegation = i < delegationN;
    const createdAt = delegation ? START + r.int(0, 60) * DAY : createdAts[i];
    const p = makePerson(r, pool, { allowSameNameCity: true });
    const job = occupation(r, p);
    const id = randomUUID();
    const country = countryOfPhone(p.phone);
    const owner = ownerFor(country);
    const customer = delegation ? r.chance(0.62) : r.chance(0.72);
    const referrer = !delegation && advocates.length > 20 && r.chance(0.06) ? pickAdvocate(r, advocates) : null;
    const door = delegation
      ? "delegation"
      : referrer
        ? "referral"
        : r.weighted([
            ["youtube", 34],
            ["meta_ad", 30],
            ["mla_program", 7],
            ["workshop_webinar", 7],
            ["search_website", 6],
            ["book_keynote", 5],
            ["school_partnership", 1],
            ["business_partner", 1],
            ["ai_office", 2],
            ["other", 7],
          ] as const);
    const channel = delegation
      ? "import"
      : customer && r.chance(0.75)
        ? "tagmango_checkout"
        : door === "meta_ad"
          ? "meta_lead_form"
          : door === "mla_program"
            ? "walk_in_event"
            : r.weighted([
                ["whatsapp_api", 5],
                ["website_form", 2],
                ["whatsapp_app", 2],
                ["phone_call", 1],
              ] as const);
    const campaign = door === "mla_program" ? r.pick(["koduvally_ai_literacy", "buddhi_yatra_malappuram"]) : door === "meta_ad" && r.chance(0.5) ? "claude_mastery_meta" : null;
    const b2bOrg = !delegation && customer && r.chance(0.006) ? r.pick(orgIds) : null;

    // the timeline of this person: interactions first (they decide sales credit), then purchases
    const ownerInteractions: number[] = [];
    const touches: InteractionRow[] = [];
    const leadCalls = !customer || r.chance(0.2) ? r.int(customer ? 1 : 0, 4) : 0;
    let t = createdAt + r.int(1, 30) * HOUR;
    for (let k = 0; k < leadCalls && owner && t < now; k++) {
      touches.push(touch(r, id, owner.id, t, k === leadCalls - 1 && !customer));
      ownerInteractions.push(t);
      t += r.int(1, 4) * DAY;
    }

    // purchases
    const contactPurchases: PurchaseRow[] = [];
    if (customer) {
      const nPurchases = delegation ? 1 : r.weighted([
        [1, 30],
        [2, 25],
        [3, 17],
        [4, 12],
        [5, 8],
        [6, 5],
        [8, 3],
      ] as const);
      let at = delegation ? createdAt + r.int(5, 30) * DAY : Math.max(createdAt + r.int(0, 3) * HOUR, t);
      const bought = new Set<string>();
      for (let k = 0; k < nPurchases && at < now - HOUR; k++) {
        const product = delegation
          ? "International delegation"
          : b2bOrg && k === 0
            ? b2bOrg.kind === "school"
              ? "School AI program"
              : b2bOrg.kind === "constituency_office"
                ? "Constituency AI literacy program"
                : "Consulting engagement"
            : nextProduct(r, k, bought, job.industry, country, workshops);
        bought.add(product);
        // a climb usually follows a call from the owner
        if (owner && (P(product).family !== "workshop" || r.chance(0.12)) && !delegation && r.chance(0.7)) {
          const callAt = at - r.int(1, 12) * DAY;
          if (callAt > createdAt) {
            touches.push(touch(r, id, owner.id, callAt, false));
            ownerInteractions.push(callAt);
          }
        }
        const row = purchase(r, {
          id,
          product: P(product),
          at,
          country,
          orgId: b2bOrg && k === 0 ? b2bOrg.id : null,
          owner,
          ownerInteractions,
          creditDays: ctx.creditDays,
          fx,
          refSeq,
          manager: ctx.team.manager,
          now,
          out,
        });
        contactPurchases.push(row);
        at += r.int(15, 150) * DAY;
      }
      if (contactPurchases.length && r.chance(0.12)) advocates.push({ id, phone: p.phone, weight: r.chance(0.1) ? 25 : 1 });
    }

    // after the last purchase: the odd at-risk call and support issues
    const lastPurchase = contactPurchases.length ? contactPurchases[contactPurchases.length - 1].purchasedAt!.getTime() : null;
    if (lastPurchase && owner && r.chance(0.25)) {
      const callAt = lastPurchase + r.int(60, 400) * DAY;
      if (callAt < now - HOUR) touches.push(touch(r, id, owner.id, callAt, false));
    }
    if (lastPurchase && ctx.team.support.length && r.chance(0.15)) {
      const at = contactPurchases[0].purchasedAt!.getTime() + r.int(1, 30) * DAY;
      if (at < now) {
        touches.push({
          id: randomUUID(),
          contactId: id,
          userId: r.pick(ctx.team.support).id,
          type: "support_issue",
          direction: "in",
          outcome: "resolved",
          summary: r.pick(["Could not find the Zoom link; resent it", "Asked for the recording; shared it", "Certificate name corrected", "Needed a GST invoice; emailed it"]),
          occurredAt: new Date(at),
          createdAt: new Date(at + r.int(1, 30) * 60_000),
        });
      }
    }
    touches.sort((a, b) => a.occurredAt!.getTime() - b.occurredAt!.getTime());
    out.interactions.push(...touches);
    const firstTask = out.tasks.length;
    followUpTasks(r, touches, owner, now, out);

    // enquiries: the first touch, one per TagMango order, and some later chats
    const firstRef = channel === "meta_lead_form" ? `meta:lead:${i}:${r.digits(10)}` : channel === "whatsapp_api" ? `libromi:msg:${i}:${r.hex(12)}` : channel === "website_form" ? `website:form:${i}:${r.hex(8)}` : null;
    const firstIsCheckout = channel === "tagmango_checkout" && contactPurchases[0]?.source !== "manual";
    if (!firstIsCheckout) {
      out.enquiries.push({ id: randomUUID(), contactId: id, channel, campaign, sourceRef: firstRef, receivedAt: new Date(createdAt), status: channel === "import" ? "handled" : "open", createdAt: new Date(createdAt) });
    }
    for (const pu of contactPurchases) {
      if (pu.mode !== "tagmango") continue;
      out.enquiries.push({
        id: randomUUID(),
        contactId: id,
        channel: "tagmango_checkout",
        campaign: pu.campaign ?? null,
        productInterest: pu.productName,
        sourceRef: `tagmango:order:${pu.reference}:completed`,
        receivedAt: pu.purchasedAt!,
        status: "handled",
        createdAt: pu.purchasedAt!,
      });
    }
    // ratings (30%): self at the door, then sometimes sales after a call; the contact shows the latest
    const contact: ContactRow = {
      id,
      phoneE164: p.phone,
      phoneCountry: country,
      name: p.name,
      email: customer || r.chance(0.5) ? p.email : null,
      type: b2bOrg ? "business" : "individual",
      organisationId: b2bOrg?.id ?? null,
      city: p.city,
      state: p.state,
      country: p.country,
      language: r.chance(0.6) ? p.language : null,
      designation: b2bOrg || r.chance(0.2) ? job.designation : null,
      companyName: b2bOrg ? null : (job.company ?? null),
      firstDoor: door,
      firstCampaign: campaign,
      firstChannel: channel,
      lastChannel: channel,
      lastCampaign: campaign,
      referredById: referrer?.id ?? null,
      consent: r.chance(0.7) ? true : null,
      consentAt: null,
      stage: "new",
      stageChangedAt: new Date(createdAt),
      ownerId: owner?.id ?? null,
      firstOwnerId: owner?.id ?? null,
      ownerAssignedAt: owner ? new Date(createdAt) : null,
      tags: delegation ? ["Legacy: Delegation"] : b2bOrg ? ["B2B"] : [],
      createdById: channel === "whatsapp_app" || channel === "phone_call" || channel === "walk_in_event" ? (owner?.id ?? null) : channel === "import" ? ctx.team.admin.id : null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    };
    if (contact.consent) contact.consentAt = new Date(createdAt);
    rate(r, contact, owner, touches, job.industry, out);

    // Lost (with a reason) or Qualified, set by hand on some leads; untouched leads went back to the pool
    if (!contactPurchases.length && touches.length && r.chance(0.12)) {
      contact.stage = "lost";
      contact.lostReason = r.pick(["price", "timing", "not_interested", "wrong_number", "bought_elsewhere", "other"]);
      contact.stageChangedAt = touches[touches.length - 1].occurredAt;
    } else if (!contactPurchases.length && touches.length && r.chance(0.05)) {
      contact.stage = "qualified";
      contact.stageChangedAt = touches[touches.length - 1].occurredAt;
    }
    // later enquiries (chats, forms, an old abandoned checkout). A customer can come back any time; an open lead
    // only while it is still owned (before the release), and a Lost one only before it was lost — a later enquiry
    // would have pulled it back and given it to someone through capture
    const extra = r.weighted([
      [0, 50],
      [1, 30],
      [2, 15],
      [3, 5],
    ] as const);
    const ownerTouches = touches.filter((x) => x.userId === owner?.id).map((x) => x.occurredAt!.getTime());
    const leadUntil = contact.stage === "lost" ? contact.stageChangedAt!.getTime() : Math.max(createdAt, ...ownerTouches) + 6 * DAY;
    const until = Math.min(now - HOUR, contactPurchases.length ? now : leadUntil);
    for (let k = 0; k < extra && until > createdAt + DAY; k++) {
      const at = createdAt + r.float(0.5, (until - createdAt) / DAY) * DAY;
      const ch = r.weighted([
        ["whatsapp_api", 6],
        ["meta_lead_form", 2],
        ["website_form", 1],
        ["tagmango_checkout", 1],
      ] as const);
      out.enquiries.push({
        id: randomUUID(),
        contactId: id,
        channel: ch,
        campaign: ch === "meta_lead_form" ? "claude_mastery_meta" : null,
        sourceRef: `${ch}:${i}:${k}:${r.hex(8)}`,
        receivedAt: new Date(at),
        // an old abandoned checkout, long handled
        status: ch === "tagmango_checkout" ? "abandoned" : "handled",
        createdAt: new Date(at),
      });
    }

    if (owner) {
      out.ownership.push({ id: randomUUID(), contactId: id, fromUserId: null, toUserId: owner.id, reason: contact.createdById ? "Added by hand" : "New lead: round robin", changedById: contact.createdById ?? null, changedAt: new Date(createdAt) });
      // use it or lose it: an open lead with no call for a week went back to the pool (as the release job does)
      const lastTouch = touches.filter((x) => x.userId === owner.id).reduce((m, x) => Math.max(m, x.occurredAt!.getTime()), createdAt);
      const released = !contactPurchases.length && contact.stage !== "lost" && lastTouch < now - 8 * DAY;
      if (released) {
        contact.ownerId = null;
        contact.ownerAssignedAt = null;
        out.ownership.push({ id: randomUUID(), contactId: id, fromUserId: owner.id, toUserId: null, reason: "No interaction for 7 days", changedById: null, changedAt: new Date(lastTouch + 7 * DAY + HOUR) });
        // their open follow-ups moved to the pool with them
        for (const task of out.tasks.slice(firstTask)) if (task.status === "open") task.userId = null;
      }
    }
    out.contacts.push(contact);
  }
  return out;
}

function pickAdvocate(r: Rng, list: { id: string; phone: string; weight: number }[]) {
  const total = list.reduce((s, a) => s + a.weight, 0);
  let x = r.next() * total;
  for (const a of list) {
    x -= a.weight;
    if (x < 0) return a;
  }
  return list[list.length - 1];
}

function nextProduct(r: Rng, k: number, bought: Set<string>, industry: string, country: string, workshops: string[]): string {
  if (k === 0) {
    return r.weighted([
      ["Entry AI Workshop", 40],
      ["AI Workshop", 35],
      ["AI Agents for Business", industry === "business_owner" ? 25 : 5],
      ...workshops.slice(3).map((w) => [w, 6] as const),
    ]);
  }
  const climb = r.next();
  if (!bought.has("Applied AI Mastery") && climb < 0.22) return "Applied AI Mastery";
  if (bought.has("Applied AI Mastery") && !bought.has("The AI Office membership") && climb < (GCC.includes(country) || industry === "business_owner" ? 0.35 : 0.12)) return "The AI Office membership";
  if (bought.has("The AI Office membership") && climb < 0.15) return r.chance(0.5) ? "Premium program" : "Consulting engagement";
  const fresh = workshops.filter((w) => !bought.has(w));
  return fresh.length ? r.pick(fresh) : r.pick(workshops);
}

const SUMMARIES: Record<string, string[]> = {
  connected: ["Explained the workshop format", "Asked about weekend batches", "Wanted to know about recordings"],
  interested: ["Interested in the next batch", "Wants AI for his business", "Asked about Applied AI Mastery"],
  no_answer: ["No answer", "Switched off", "Rang twice, no answer"],
  info_sent: ["Sent the brochure on WhatsApp", "Shared the payment link"],
  not_interested: ["Not interested right now", "Only wanted the free webinar"],
};

function touch(r: Rng, contactId: string, userId: string, at: number, last: boolean): InteractionRow {
  const outcome = last && r.chance(0.3) ? "not_interested" : r.pick(["connected", "interested", "no_answer", "no_answer", "info_sent"]);
  const type: InteractionType = outcome === "info_sent" ? "whatsapp" : r.chance(0.1) ? "meeting" : "call";
  return {
    id: randomUUID(),
    contactId,
    userId,
    type,
    direction: "out",
    outcome,
    summary: r.pick(SUMMARIES[outcome]),
    nextFollowUpAt: !last && outcome !== "not_interested" && r.chance(0.6) ? new Date(at + r.int(1, 4) * DAY) : null,
    occurredAt: new Date(at),
    createdAt: new Date(at + r.int(1, 20) * 60_000),
  };
}

/** A follow-up task per interaction that set one: done when the same person touched the contact again, else open. */
function followUpTasks(r: Rng, touches: InteractionRow[], owner: Member | null, now: number, out: Out) {
  for (let k = 0; k < touches.length; k++) {
    const t = touches[k];
    if (!t.nextFollowUpAt) continue;
    const next = touches.slice(k + 1).find((x) => x.userId === t.userId);
    const stale = t.occurredAt!.getTime() < now - 21 * DAY;
    out.tasks.push({
      id: randomUUID(),
      contactId: t.contactId,
      userId: owner?.id ?? t.userId,
      type: "follow_up",
      reason: `Follow-up you set after a ${t.type === "whatsapp" ? "WhatsApp chat" : t.type}: ${t.summary}`,
      dueAt: t.nextFollowUpAt,
      status: next || stale ? "done" : "open",
      completedAt: next ? next.occurredAt : stale ? new Date(t.nextFollowUpAt.getTime() + r.int(1, 48) * HOUR) : null,
      completedById: next || stale ? t.userId : null,
      dedupeKey: `follow_up:${t.id}`,
      payload: { interactionId: t.id },
      createdById: t.userId,
      createdAt: t.createdAt,
    });
  }
}

function purchase(
  r: Rng,
  x: {
    id: string;
    product: { id: string; name: string; family: string; listPrice: number; currency: string };
    at: number;
    country: string;
    orgId: string | null;
    owner: Member | null;
    ownerInteractions: number[];
    creditDays: number;
    fx: (cur: string, at: number) => number;
    refSeq: { n: number };
    manager: Member;
    now: number;
    out: Out;
  },
): PurchaseRow {
  const { product: p, at } = x;
  const gcc = GCC.includes(x.country);
  const workshop = p.family === "workshop";
  const mode: PaymentMode =
    p.family === "delegation" || p.family === "b2b_program" || p.family === "constituency_program" || p.family === "consulting" || p.family === "premium"
      ? "bank_transfer"
      : workshop
        ? r.chance(0.95)
          ? "tagmango"
          : "upi_qr"
        : p.family === "applied_ai_mastery"
          ? r.weighted([
              ["tagmango", 40],
              ["bank_transfer", 40],
              ["upi_qr", 20],
            ] as const)
          : "bank_transfer";
  // money: the catalogue price (USD for The AI Office); Gulf customers paying by transfer pay in AED
  let currency = p.currency;
  let amount = p.listPrice;
  if (currency === "INR" && workshop && r.chance(0.08)) amount = Math.max(499, amount - 200);
  if (gcc && mode === "bank_transfer" && p.family !== "delegation" && r.chance(0.6)) {
    const inr = p.listPrice * x.fx(p.currency, at);
    currency = "AED";
    amount = Math.round(inr / x.fx("AED", at));
  }
  const listPrice = currency === p.currency ? p.listPrice : amount;
  const rate = x.fx(currency, at);
  const amountInr = roundMoney(amount * rate);
  x.refSeq.n += 1;
  const reference =
    mode === "tagmango"
      ? Math.floor(at / 1000).toString(16).padStart(8, "0") + x.refSeq.n.toString(16).padStart(16, "0")
      : p.family === "delegation"
        ? `DLG-${x.refSeq.n}`
        : `${mode === "upi_qr" ? "UPI" : "NEFT"}${String(x.refSeq.n).padStart(12, "0")}`;
  const credited = x.owner && x.ownerInteractions.some((t) => t < at && t >= at - x.creditDays * DAY) ? x.owner : null;
  const source = p.family === "delegation" || at < x.now - 400 * DAY ? "import" : mode === "tagmango" ? "tagmango" : "manual";
  const id = randomUUID();
  const emi = !workshop && p.family !== "delegation" && mode !== "tagmango" && r.chance(0.12);
  const row: PurchaseRow = {
    id,
    contactId: x.id,
    organisationId: x.orgId,
    productId: p.id,
    productName: p.name,
    family: p.family,
    listPrice,
    discount: roundMoney(Math.max(0, listPrice - amount)),
    amount,
    currency,
    fxRate: rate,
    amountInr,
    purchasedAt: new Date(at),
    mode,
    reference: emi ? null : reference,
    status: "paid",
    creditedUserId: credited?.id ?? null,
    assisted: !!credited,
    source,
    hasInstalments: emi,
    campaign: null,
    createdById: mode === "tagmango" || source === "import" ? null : (x.owner?.id ?? null),
    createdAt: new Date(at),
    updatedAt: new Date(at),
  };
  x.out.purchases.push(row);

  const verifiedBy = mode === "tagmango" ? null : x.manager.id;
  const paymentRow = (seq: number, amt: number, payAt: number, ref: string | null, status: "verified" | "unverified" | "scheduled", dueAt: number | null): PaymentRow => {
    const r2 = x.fx(currency, payAt);
    return {
      id: randomUUID(),
      purchaseId: id,
      contactId: x.id,
      kind: "payment",
      seq,
      amount: amt,
      currency,
      fxRate: r2,
      amountInr: roundMoney(amt * r2),
      dueAt: dueAt === null ? null : new Date(dueAt),
      paidAt: status === "scheduled" ? null : new Date(payAt),
      mode,
      reference: status === "scheduled" ? null : ref,
      status,
      verifiedById: status === "verified" ? verifiedBy : null,
      verifiedAt: status === "verified" ? new Date(payAt + (mode === "tagmango" ? 0 : r.int(1, 30) * HOUR)) : null,
      createdById: row.createdById,
      createdAt: new Date(payAt),
      updatedAt: new Date(payAt),
    };
  };
  if (emi) {
    // three monthly instalments; the ones still in the future are scheduled
    const each = roundMoney(amount / 3);
    const parts = [each, each, roundMoney(amount - 2 * each)];
    parts.forEach((amt, k) => {
      const due = at + k * 30 * DAY;
      const paid = due < x.now - 2 * DAY && r.chance(0.92);
      x.out.payments.push(paymentRow(k + 1, amt, due, `${reference}-${k + 1}`, paid ? "verified" : "scheduled", due));
    });
    x.out.special.push(id);
  } else {
    const waiting = mode !== "tagmango" && source === "manual" && at > x.now - 5 * DAY && r.chance(0.5);
    x.out.payments.push(paymentRow(1, amount, at, reference, waiting ? "unverified" : "verified", null));
    if (waiting) x.out.special.push(id);
    // a few refunds (verified, with a reason)
    if (!waiting && r.chance(0.005)) {
      const full = r.chance(0.6);
      const amt = full ? amount : roundMoney(amount * 0.2);
      x.out.payments.push({
        id: randomUUID(),
        purchaseId: id,
        contactId: x.id,
        kind: "refund",
        seq: 1,
        amount: amt,
        currency,
        fxRate: rate,
        amountInr: full ? amountInr : roundMoney(amt * rate),
        paidAt: new Date(at + 3 * DAY),
        mode,
        reference: null,
        status: "verified",
        verifiedById: x.manager.id,
        verifiedAt: new Date(at + 3 * DAY),
        reason: full ? "Could not attend; refunded in full" : "Discount promised on the call",
        createdById: x.manager.id,
        createdAt: new Date(at + 3 * DAY),
        updatedAt: new Date(at + 3 * DAY),
      });
      x.out.special.push(id);
    }
  }
  return row;
}

/** Ratings on ~30% of contacts; the contact's rated fields and field_sources follow the latest rating per field. */
function rate(r: Rng, c: ContactRow, owner: Member | null, touches: InteractionRow[], industry: string, out: Out) {
  if (!r.chance(0.3)) return;
  const sources: Record<string, FieldSource> = {};
  const created = c.createdAt!.getTime();
  const call0 = touches.some((t) => t.userId === owner?.id && (t.outcome === "connected" || t.outcome === "interested"));
  // self-rating at the door, unless a salesperson is about to rate them anyway
  const selfFirst = !call0 || r.chance(0.45);
  if (selfFirst) {
    const v = { aiLevel: r.int(0, 4), umerLevel: r.int(0, 4), ageBand: r.chance(0.5) ? ageBand(r) : null };
    out.ratings.push({ id: randomUUID(), contactId: c.id!, ratedByUserId: null, source: "self", ...v, createdAt: new Date(created + 5 * 60_000) });
    Object.assign(c, { aiLevel: v.aiLevel, umerLevel: v.umerLevel, ...(v.ageBand ? { ageBand: v.ageBand } : {}) });
    sources.ai_level = "self";
    sources.umer_level = "self";
    if (v.ageBand) sources.age_band = "self";
  }
  const call = touches.find((t) => t.userId === owner?.id && (t.outcome === "connected" || t.outcome === "interested"));
  if (owner && call && (!selfFirst || r.chance(0.4))) {
    const v = {
      aiLevel: r.int(0, 5),
      umerLevel: r.int(0, 5),
      spendingBand: r.int(1, 5),
      gutStars: r.int(1, 5),
      ageBand: ageBand(r),
      industry,
    };
    out.ratings.push({ id: randomUUID(), contactId: c.id!, ratedByUserId: owner.id, source: "sales", ...v, createdAt: call.occurredAt });
    Object.assign(c, v);
    for (const k of ["ai_level", "umer_level", "spending_band", "gut_stars", "age_band", "industry"]) sources[k] = "sales";
  }
  c.fieldSources = sources;
}

async function printSummary() {
  const rows = await db.execute<{ t: string; n: string }>(sql`
    select 'contacts' t, count(*)::text n from contacts union all
    select 'customers', count(*)::text from contacts where purchase_count > 0 union all
    select 'purchases', count(*)::text from purchases union all
    select 'payments', count(*)::text from payments union all
    select 'enquiries', count(*)::text from enquiries union all
    select 'interactions', count(*)::text from interactions union all
    select 'rated contacts', count(distinct contact_id)::text from ratings union all
    select 'referred contacts', count(*)::text from contacts where referred_by_id is not null union all
    select 'open tasks', count(*)::text from tasks where status = 'open' union all
    select 'total LTV (INR)', round(sum(ltv_inr))::text from contacts
  `);
  console.log(rows.map((r) => `  ${r.t}: ${Number(r.n).toLocaleString("en-IN")}`).join("\n"));
  const stages = await db.execute<{ stage: string; n: string }>(sql`select stage, count(*)::text n from contacts group by 1 order by 2 desc`);
  console.log(`  by stage: ${stages.map((s) => `${s.stage} ${s.n}`).join(", ")}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
