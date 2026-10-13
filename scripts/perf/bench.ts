/**
 * Performance bench at Edapt's real scale (docs/PERFORMANCE.md). Runs the server-side work of every interactive
 * screen and job against a scale database, times each scenario (median of warm runs) and EXPLAINs the slowest
 * SQL statements it issued.
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/edapt_perf \
 *     npx tsx --conditions=react-server scripts/perf/bench.ts [--only name,name] [--runs 5] [--explain] [--heavy] [--out dir]
 *
 * Results (JSON, and the plans with --explain) go to --out (default: <tmp>/edapt-perf).
 * --heavy also runs the long jobs (recomputeAll, runAllAlerts, nightly, import match on 5,000 rows, exports).
 * Writes (capture, purchase, alerts) run inside a transaction that is rolled back, so the data does not drift;
 * recomputeAll writes for real (it is idempotent). Refuses databases whose name lacks "perf" or "bench".
 */
import "../env";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";

type Captured = { q: string; p: unknown[] };
let capturing: Captured[] | null = null;
(globalThis as unknown as { __edaptSql?: postgres.Sql }).__edaptSql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: Number(process.env.DATABASE_POOL_MAX ?? 5),
  debug: (_c: number, q: string, p: unknown[]) => {
    capturing?.push({ q, p });
  },
});

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY = opt("--only")?.split(",");
const RUNS = Number(opt("--runs") ?? 5);
const EXPLAIN = flag("--explain");
const HEAVY = flag("--heavy");
const OUT = opt("--out") ?? path.join(tmpdir(), "edapt-perf");

class Rollback extends Error {}

type Scenario = {
  name: string;
  group: string;
  budgetMs: number;
  run: () => Promise<unknown>;
  runs?: number;
  heavy?: boolean;
};

type Result = { name: string; group: string; budgetMs: number; medianMs: number; minMs: number; maxMs: number; queries: number; ok: boolean };

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/unknown").pathname.slice(1);
  if (!/perf|bench/i.test(dbName)) throw new Error(`Refusing to bench "${dbName}": use a database named *perf* or *bench*`);
  const client = (globalThis as unknown as { __edaptSql: postgres.Sql }).__edaptSql;

  const { eq, sql, desc } = await import("drizzle-orm");
  const { db } = await import("@/db");
  const s = await import("@/db/schema");
  const q = await import("@/lib/contacts/queries");
  const { getContactPurchases } = await import("@/lib/money");
  const { recordPurchase } = await import("@/lib/money/purchases");
  const { nboProducts } = await import("@/lib/admin/nbo");
  const { getTodayQueue, getTeamQueues } = await import("@/lib/today/queue");
  const desk = await import("@/app/(app)/payments/_lib/queries");
  const m = await import("@/lib/dashboard/metrics");
  const { resolvePeriod } = await import("@/lib/dashboard/period");
  const { calibration } = await import("@/lib/dashboard/calibration");
  const { checkQuickAddDuplicate } = await import("@/lib/contacts/identity");
  const { captureEnquiry } = await import("@/lib/contacts/capture");
  const { prepareExport } = await import("@/lib/admin/export");
  const { runAllAlerts, runNightlyJobs } = await import("@/lib/alerts/jobs");
  const { recomputeAll, recomputeContact } = await import("@/lib/metrics/recompute");
  const { buildCohorts } = await import("@/lib/metrics/repeat");
  const { getSettings } = await import("@/lib/settings");
  const { listNotifications } = await import("@/lib/today/inbox");
  const { buildDailyDigest, buildWeeklySummary } = await import("@/lib/alerts/digest");

  const userRows = await db.select().from(s.users);
  const byEmail = (e: string) => {
    const u = userRows.find((x) => x.email === e) ?? userRows.find((x) => x.role === e);
    if (!u) throw new Error(`no user ${e}`);
    return u;
  };
  const admin = byEmail("admin");
  const manager = byEmail("manager");
  // the salesperson with the most open tasks
  const [busiest] = await db
    .select({ userId: s.tasks.userId, n: sql<number>`count(*)::int` })
    .from(s.tasks)
    .where(sql`${s.tasks.status} = 'open' and ${s.tasks.userId} in (select id from users where role = 'sales')`)
    .groupBy(s.tasks.userId)
    .orderBy(desc(sql`count(*)`))
    .limit(1);
  const sales = userRows.find((u) => u.id === busiest?.userId) ?? byEmail("sales");

  // a heavy contact (most timeline rows) and a typical one
  const [heavy] = await db.execute<{ id: string }>(sql`
    select c.id from contacts c
    where c.merged_into_id is null
    order by (select count(*) from enquiries e where e.contact_id = c.id) + c.purchase_count desc
    limit 1`);
  const [typical] = await db.execute<{ id: string; phone_e164: string; name: string }>(
    sql`select id, phone_e164, name from contacts where merged_into_id is null and purchase_count = 1 order by id limit 1 offset 1234`,
  );
  const [product] = await db.select().from(s.products).where(eq(s.products.active, true)).limit(1);
  const settings = await getSettings(["lists.campaigns", "lists.channels", "lists.tags", "lists.languages", "ladder.families"]);
  const anyCampaign = settings["lists.campaigns"][0]?.key ?? "none";
  const anyTag = settings["lists.tags"][0]?.key ?? "vip";

  const now = new Date();
  const tz = "Asia/Kolkata";
  const month = resolvePeriod({ period: undefined, from: undefined, to: undefined }, now, tz);
  const ninety = resolvePeriod({ period: "90d", from: undefined, to: undefined }, now, tz);

  const listPage = (user: typeof admin, f: Record<string, string>, page = 1) => async () => {
    const filters = q.parseContactFilters(f);
    const viewAll = user.role === "admin" || user.role === "manager";
    return Promise.all([
      q.listContacts(user, filters, { page }),
      getSettings(["lists.channels", "lists.firstDoors", "lists.campaigns", "lists.languages", "lists.tags", "ladder.families"]),
      q.listSavedViews(user),
      q.listContactCountries(user),
      viewAll ? q.listOwnerOptions() : [],
      viewAll ? q.listAssignableUsers() : [],
    ]);
  };
  const contactPage = (id: string, tab: "timeline" | "purchases") => async () => {
    const c = await q.getContactHeader(id);
    if (!c) throw new Error("contact missing");
    return Promise.all([
      q.getContactFootprint(c.id),
      q.listAssignableUsers(),
      tab === "timeline" ? q.getContactTimeline(c.id, { page: 1 }) : null,
      tab === "purchases" ? getContactPurchases(c.id) : null,
      nboProducts(),
    ]);
  };
  const layout = (u: typeof admin) => () =>
    db.select({ n: sql<number>`count(*)` }).from(s.notifications).where(sql`${s.notifications.userId} = ${u.id} and ${s.notifications.readAt} is null`);
  const deskWindow = { now, timeZone: tz, withinDays: 7, staleDays: 2 };

  /** runs fn inside a transaction that is always rolled back */
  const rolledBack = (fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>) => async () => {
    try {
      await db.transaction(async (tx) => {
        await fn(tx);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  };
  let seq = 0;
  const freshPhone = () => `+9198${String(99000000 + (Date.now() % 900000) * 10 + (seq++ % 10)).slice(-8)}`;

  const scenarios: Scenario[] = [
    // ---- shell
    { group: "shell", name: "layout unread count (sales)", budgetMs: 50, run: layout(sales) },
    { group: "shell", name: "notifications inbox (sales)", budgetMs: 300, run: () => listNotifications(sales.id) },
    // ---- contacts list
    { group: "contacts", name: "list default sort (admin)", budgetMs: 300, run: listPage(admin, {}) },
    { group: "contacts", name: "list default sort (sales)", budgetMs: 300, run: listPage(sales, {}) },
    { group: "contacts", name: "list page 500 (admin)", budgetMs: 300, run: listPage(admin, {}, 500) },
    { group: "contacts", name: "list sort ltv", budgetMs: 300, run: listPage(admin, { sort: "ltv" }) },
    { group: "contacts", name: "list sort activity", budgetMs: 300, run: listPage(admin, { sort: "activity" }) },
    { group: "contacts", name: "list sort created", budgetMs: 300, run: listPage(admin, { sort: "created" }) },
    { group: "contacts", name: "list sort name", budgetMs: 300, run: listPage(admin, { sort: "name" }) },
    { group: "contacts", name: "filter grade A", budgetMs: 300, run: listPage(admin, { grade: "A" }) },
    { group: "contacts", name: "filter stage repeat", budgetMs: 300, run: listPage(admin, { stage: "repeat" }) },
    { group: "contacts", name: "filter first door", budgetMs: 300, run: listPage(admin, { door: "youtube" }) },
    { group: "contacts", name: "filter campaign", budgetMs: 300, run: listPage(admin, { campaign: anyCampaign }) },
    { group: "contacts", name: "filter channel", budgetMs: 300, run: listPage(admin, { channel: "whatsapp_api" }) },
    { group: "contacts", name: "filter owner mine (sales)", budgetMs: 300, run: listPage(sales, { owner: "mine" }) },
    { group: "contacts", name: "filter owner pool", budgetMs: 300, run: listPage(admin, { owner: "pool" }) },
    { group: "contacts", name: "filter family", budgetMs: 300, run: listPage(admin, { family: "workshop" }) },
    { group: "contacts", name: "filter country AE", budgetMs: 300, run: listPage(admin, { country: "AE" }) },
    { group: "contacts", name: "filter language", budgetMs: 300, run: listPage(admin, { lang: "ml" }) },
    { group: "contacts", name: "filter tag", budgetMs: 300, run: listPage(admin, { tag: anyTag }) },
    { group: "contacts", name: "filter at risk", budgetMs: 300, run: listPage(admin, { risk: "1" }) },
    { group: "contacts", name: "filter unrated", budgetMs: 300, run: listPage(admin, { unrated: "1" }) },
    { group: "contacts", name: "filters combined (sales)", budgetMs: 300, run: listPage(sales, { grade: "B", stage: "new", risk: "1" }) },
    { group: "contacts", name: "search partial name", budgetMs: 300, run: listPage(admin, { q: typical.name.split(" ")[0].slice(0, 4) }) },
    { group: "contacts", name: "search rare name (sales)", budgetMs: 300, run: listPage(sales, { q: "zzqx" }) },
    { group: "contacts", name: "search partial phone 5 digits", budgetMs: 300, run: listPage(admin, { q: typical.phone_e164.slice(-5) }) },
    { group: "contacts", name: "search full phone", budgetMs: 300, run: listPage(admin, { q: typical.phone_e164 }) },
    { group: "contacts", name: "search email part", budgetMs: 300, run: listPage(admin, { q: "@gmail" }) },
    { group: "contacts", name: "picker search (merge tab)", budgetMs: 300, run: () => q.searchContactsForPicker(admin, typical.name.slice(0, 5)) },
    // ---- contact page
    { group: "contact page", name: "header + timeline (heavy contact)", budgetMs: 300, run: contactPage(heavy.id, "timeline") },
    { group: "contact page", name: "header + purchases (heavy contact)", budgetMs: 300, run: contactPage(heavy.id, "purchases") },
    { group: "contact page", name: "header + timeline (typical)", budgetMs: 300, run: contactPage(typical.id, "timeline") },
    { group: "contact page", name: "ratings + referrals tabs", budgetMs: 300, run: () => Promise.all([q.getContactRatings(heavy.id), q.getContactReferrals(heavy.id, admin)]) },
    // ---- today
    { group: "today", name: "Today queue (busiest sales)", budgetMs: 300, run: () => getTodayQueue(sales, now) },
    { group: "today", name: "Today queue (manager)", budgetMs: 300, run: () => getTodayQueue(manager, now) },
    { group: "today", name: "Team view (manager)", budgetMs: 300, run: () => getTeamQueues(manager, now) },
    // ---- payments desk
    { group: "payments", name: "desk totals (manager)", budgetMs: 150, run: () => desk.getDeskTotals(manager, deskWindow) },
    { group: "payments", name: "tab unverified (manager)", budgetMs: 300, run: () => Promise.all([desk.getDeskTotals(manager, deskWindow), desk.listUnverified(manager, { limit: desk.DESK_PAGE_SIZE, offset: 0 })]) },
    { group: "payments", name: "tab due (manager)", budgetMs: 300, run: () => Promise.all([desk.getDeskTotals(manager, deskWindow), desk.listInstalmentsDue(manager, deskWindow, { limit: desk.DESK_PAGE_SIZE, offset: 0 })]) },
    { group: "payments", name: "tab recent (manager)", budgetMs: 300, run: () => Promise.all([desk.getDeskTotals(manager, deskWindow), desk.countRecentPurchases(manager), desk.listRecentPurchases(manager, { limit: desk.DESK_PAGE_SIZE, offset: 0 })]) },
    { group: "payments", name: "tab recent (sales)", budgetMs: 300, run: () => Promise.all([desk.getDeskTotals(sales, deskWindow), desk.countRecentPurchases(sales), desk.listRecentPurchases(sales, { limit: desk.DESK_PAGE_SIZE, offset: 0 })]) },
    { group: "payments", name: "tab recent page 100 (manager)", budgetMs: 300, run: () => desk.listRecentPurchases(manager, { limit: desk.DESK_PAGE_SIZE, offset: 99 * desk.DESK_PAGE_SIZE }) },
    // ---- dashboard (each function, then the page's Promise.all)
    { group: "dashboard", name: "revenueByFamily", budgetMs: 300, run: () => m.revenueByFamily(month) },
    { group: "dashboard", name: "newCustomers", budgetMs: 300, run: () => m.newCustomers(month) },
    { group: "dashboard", name: "leadsAndConversionByChannel", budgetMs: 300, run: () => m.leadsAndConversionByChannel(month) },
    { group: "dashboard", name: "leadsAndConversionByChannel (90d)", budgetMs: 300, run: () => m.leadsAndConversionByChannel(ninety) },
    { group: "dashboard", name: "ltvByFirstDoor", budgetMs: 300, run: () => m.ltvByFirstDoor() },
    { group: "dashboard", name: "repeatRate", budgetMs: 300, run: () => m.repeatRate() },
    { group: "dashboard", name: "medianDaysFirstToSecond", budgetMs: 300, run: () => m.medianDaysFirstToSecond() },
    { group: "dashboard", name: "rungMoves", budgetMs: 300, run: () => m.rungMoves(month) },
    { group: "dashboard", name: "rungMoves (90d)", budgetMs: 300, run: () => m.rungMoves(ninety) },
    { group: "dashboard", name: "forecast90d", budgetMs: 300, run: () => m.forecast90d() },
    { group: "dashboard", name: "atRiskPool", budgetMs: 300, run: () => m.atRiskPool() },
    { group: "dashboard", name: "abandonedCheckoutsRecovered", budgetMs: 300, run: () => m.abandonedCheckoutsRecovered(month) },
    { group: "dashboard", name: "assistedVsSelfServe", budgetMs: 300, run: () => m.assistedVsSelfServe(month) },
    { group: "dashboard", name: "teamView", budgetMs: 300, run: () => m.teamView(month) },
    { group: "dashboard", name: "teamView (90d)", budgetMs: 300, run: () => m.teamView(ninety) },
    { group: "dashboard", name: "beyondUmerShare", budgetMs: 300, run: () => m.beyondUmerShare({ ...month, timeZone: tz }) },
    { group: "dashboard", name: "languageMix", budgetMs: 300, run: () => m.languageMix(month) },
    { group: "dashboard", name: "referralLeaderboard", budgetMs: 300, run: () => m.referralLeaderboard() },
    { group: "dashboard", name: "dataHealth", budgetMs: 300, run: () => m.dataHealth(now) },
    { group: "dashboard", name: "lostReasons", budgetMs: 300, run: () => m.lostReasons(month) },
    {
      group: "dashboard",
      name: "dashboard page (all, parallel)",
      budgetMs: 1500,
      run: () =>
        Promise.all([
          getSettings(["thresholds"]),
          m.revenueByFamily(month),
          m.newCustomers(month),
          m.leadsAndConversionByChannel(month),
          m.ltvByFirstDoor(),
          m.repeatRate(),
          m.medianDaysFirstToSecond(),
          m.rungMoves(month),
          m.forecast90d(),
          m.atRiskPool(),
          m.abandonedCheckoutsRecovered(month),
          m.assistedVsSelfServe(month),
          m.teamView(month),
          m.beyondUmerShare({ ...month, timeZone: tz }),
          m.languageMix(month),
          m.referralLeaderboard(),
          m.dataHealth(now),
          m.lostReasons(month),
        ]),
    },
    { group: "dashboard", name: "calibration report", budgetMs: 1500, run: () => calibration(now) },
    // ---- typing and single writes
    { group: "writes", name: "duplicate check (existing phone)", budgetMs: 100, run: () => checkQuickAddDuplicate(typical.phone_e164, sales) },
    { group: "writes", name: "duplicate check (new phone)", budgetMs: 100, run: () => checkQuickAddDuplicate("+919812300001", sales) },
    {
      group: "writes",
      name: "captureEnquiry (new contact)",
      budgetMs: 150,
      run: rolledBack((tx) => captureEnquiry({ phone: freshPhone(), name: "Perf Lead", channel: "whatsapp", createdById: sales.id }, tx)),
    },
    {
      group: "writes",
      name: "captureEnquiry (existing contact)",
      budgetMs: 150,
      run: rolledBack((tx) => captureEnquiry({ phone: typical.phone_e164, channel: "website", createdById: sales.id }, tx)),
    },
    {
      group: "writes",
      name: "captureEnquiry (heavy contact)",
      budgetMs: 150,
      run: rolledBack(async (tx) => {
        const [c] = await tx.select({ phone: s.contacts.phoneE164 }).from(s.contacts).where(eq(s.contacts.id, heavy.id));
        return captureEnquiry({ phone: c.phone, channel: "website", createdById: sales.id }, tx);
      }),
    },
    {
      group: "writes",
      name: "recordPurchase + recompute (typical)",
      budgetMs: 150,
      run: rolledBack((tx) =>
        recordPurchase(
          { contactId: typical.id, productId: product.id, amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: `PERF-${Date.now()}-${seq++}` },
          null,
          tx,
        ),
      ),
    },
    {
      group: "writes",
      name: "recordPurchase + recompute (heavy)",
      budgetMs: 150,
      run: rolledBack((tx) =>
        recordPurchase(
          { contactId: heavy.id, productId: product.id, amount: 999, currency: "INR", mode: "tagmango", source: "tagmango", reference: `PERF-${Date.now()}-${seq++}` },
          null,
          tx,
        ),
      ),
    },
    { group: "writes", name: "recomputeContact (heavy)", budgetMs: 100, run: rolledBack((tx) => recomputeContact(heavy.id, tx)) },
    // ---- jobs
    { group: "jobs", name: "buildCohorts", budgetMs: 2000, run: () => buildCohorts(db, now), runs: 3 },
    { group: "jobs", name: "daily digest (busiest sales)", budgetMs: 1000, run: () => buildDailyDigest(sales, now), runs: 3 },
    { group: "jobs", name: "daily digest (manager)", budgetMs: 1000, run: () => buildDailyDigest(manager, now), runs: 3 },
    { group: "jobs", name: "weekly summary", budgetMs: 3000, run: () => buildWeeklySummary(now), runs: 3 },
    {
      group: "jobs",
      name: "export contacts (all, streamed)",
      budgetMs: 30_000,
      heavy: true,
      runs: 1,
      run: async () => drain((await prepareExport("contacts", admin, new URLSearchParams())).stream),
    },
    {
      group: "jobs",
      name: "export purchases (all, streamed)",
      budgetMs: 30_000,
      heavy: true,
      runs: 1,
      run: async () => drain((await prepareExport("purchases", admin, new URLSearchParams())).stream),
    },
    { group: "jobs", name: "runAllAlerts (rolled back)", budgetMs: 30_000, heavy: true, runs: 1, run: rolledBack((tx) => runAllAlerts(now, tx)) },
    {
      // five weeks on: a new month of dedupe keys, so every rule raises its alerts again (the worst case)
      group: "jobs",
      name: "runAllAlerts +35 days (rolled back)",
      budgetMs: 30_000,
      heavy: true,
      runs: 1,
      run: rolledBack(async (tx) => {
        const r = await runAllAlerts(new Date(now.getTime() + 35 * 86_400_000), tx);
        console.log("    alerts:", JSON.stringify(r).slice(0, 600));
        return r;
      }),
    },
    { group: "jobs", name: "import clean+match 5,000 rows", budgetMs: 60_000, heavy: true, runs: 1, run: () => importMatch(5000) },
    {
      group: "jobs",
      name: "recomputeAll (50k)",
      budgetMs: 180_000,
      heavy: true,
      runs: 1,
      run: async () => {
        let last = 0;
        const t0 = performance.now();
        const n = await recomputeAll({
          now,
          onProgress: (done: number) => {
            if (done - last >= 10_000) {
              last = done;
              console.log(`    recomputeAll ${done} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
            }
          },
        });
        return n;
      },
    },
    { group: "jobs", name: "nightly jobs (all steps)", budgetMs: 300_000, heavy: true, runs: 1, run: async () => {
      const r = await runNightlyJobs(now);
      console.log("    nightly steps:", Object.fromEntries(Object.entries(r.steps).map(([k, v]) => [k, `${v.ms}ms${v.ok ? "" : " FAILED " + v.error}`])));
      return r;
    } },
  ];

  async function drain(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    return bytes;
  }

  async function importMatch(rows: number) {
    const { createImportBatch, getBatchView, runCleanChunk, saveMapping } = await import("@/lib/import/batches");
    const { runMatchChunk } = await import("@/lib/import/match");
    // 40% of rows are people already in the CRM (by phone or by email), the rest are new
    const existing = await db.execute<{ name: string; phone_e164: string; email: string | null; city: string | null }>(
      sql`select name, phone_e164, email, city from contacts where merged_into_id is null order by md5(id::text) limit ${Math.round(rows * 0.4)}`,
    );
    const lines = ["Name,Phone,Email,City,Notes"];
    for (let i = 0; i < rows; i++) {
      const e = existing[i];
      if (e && i % 2 === 0) lines.push(`${e.name},${e.phone_e164},,${e.city ?? ""},existing by phone`);
      else if (e && e.email) lines.push(`${e.name},+9197${String(10000000 + i).slice(-8)},${e.email},${e.city ?? ""},existing by email`);
      else lines.push(`Import Person ${i},+9196${String(20000000 + i).slice(-8)},import${i}@example.com,Kochi,new`);
    }
    const bytes = new TextEncoder().encode(lines.join("\n"));
    const id = await createImportBatch({ fileName: "perf.csv", fileType: "text/csv", bytes, source: "other" }, admin);
    try {
      const view = await getBatchView(id, admin);
      await saveMapping(id, { mapping: view!.mapping ?? {}, defaults: { firstDoor: "youtube" } }, admin);
      const t0 = performance.now();
      while (!(await runCleanChunk(id, admin, { limit: 2000 })).finished);
      const t1 = performance.now();
      while (!(await runMatchChunk(id, admin, { limit: 2000 })).finished);
      const t2 = performance.now();
      const done = await getBatchView(id, admin);
      console.log(`    clean ${(t1 - t0).toFixed(0)}ms, match ${(t2 - t1).toFixed(0)}ms, counts ${JSON.stringify(done?.countsT)}`);
    } finally {
      const [b] = await db.select({ fileUrl: s.importBatches.fileUrl }).from(s.importBatches).where(eq(s.importBatches.id, id));
      await db.delete(s.importBatches).where(eq(s.importBatches.id, id));
      if (b?.fileUrl) rmSync(path.join(process.cwd(), "uploads", b.fileUrl.replace(/^\/api\/files\//, "")), { force: true });
    }
  }

  mkdirSync(OUT, { recursive: true });
  const results: Result[] = [];
  const explainOut: string[] = [];
  const selected = scenarios.filter((x) => (ONLY ? ONLY.some((o) => x.name.toLowerCase().includes(o.toLowerCase()) || x.group === o) : HEAVY || !x.heavy));
  console.log(`db ${dbName}; admin ${admin.email}, manager ${manager.email}, sales ${sales.email} (${busiest?.n ?? 0} open tasks); heavy contact ${heavy.id}`);
  for (const sc of selected) {
    const runs = sc.runs ?? RUNS;
    const times: number[] = [];
    let queries = 0;
    if (runs > 1) await sc.run(); // warm-up
    for (let i = 0; i < runs; i++) {
      const captured: Captured[] = [];
      capturing = captured;
      const t0 = performance.now();
      await sc.run();
      times.push(performance.now() - t0);
      capturing = null;
      queries = captured.length;
      if (i === runs - 1 && EXPLAIN && !sc.heavy) explainOut.push(await explainAll(sc.name, captured));
    }
    const r: Result = {
      name: sc.name,
      group: sc.group,
      budgetMs: sc.budgetMs,
      medianMs: median(times),
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      queries,
      ok: median(times) <= sc.budgetMs,
    };
    results.push(r);
    console.log(
      `${r.ok ? "  ok " : "SLOW "} ${sc.group.padEnd(13)} ${sc.name.padEnd(42)} ${r.medianMs.toFixed(1).padStart(9)} ms  (min ${r.minMs.toFixed(1)}, max ${r.maxMs.toFixed(1)}, ${queries} queries, budget ${sc.budgetMs})`,
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(path.join(OUT, `bench-${stamp}.json`), JSON.stringify(results, null, 2));
  if (explainOut.length) writeFileSync(path.join(OUT, `explain-${stamp}.txt`), explainOut.join("\n"));
  console.log(`results in ${OUT}/bench-${stamp}.json${explainOut.length ? ` and explain-${stamp}.txt` : ""}`);

  /** EXPLAIN (ANALYZE, BUFFERS) of every distinct read the scenario issued; the slowest three are kept. */
  async function explainAll(name: string, captured: Captured[]): Promise<string> {
    const seen = new Set<string>();
    const plans: { ms: number; q: string; plan: string }[] = [];
    for (const c of captured) {
      const text = c.q.trim();
      if (!/^(select|with)\b/i.test(text) || /for update|for no key update|for share/i.test(text) || seen.has(text)) continue;
      seen.add(text);
      try {
        const rows = await client.unsafe(`explain (analyze, buffers) ${text}`, c.p as never[]);
        const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
        const ms = Number(/Execution Time: ([\d.]+)/.exec(plan)?.[1] ?? 0);
        plans.push({ ms, q: text, plan });
      } catch (e) {
        plans.push({ ms: -1, q: text, plan: `explain failed: ${(e as Error).message}` });
      }
    }
    plans.sort((a, b) => b.ms - a.ms);
    return [
      `=== ${name}: ${plans.length} distinct reads, ${plans.reduce((a, p) => a + Math.max(p.ms, 0), 0).toFixed(1)} ms total execution`,
      ...plans.slice(0, 3).map((p) => `--- ${p.ms} ms\n${p.q.slice(0, 1500)}\n${p.plan}\n`),
    ].join("\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
