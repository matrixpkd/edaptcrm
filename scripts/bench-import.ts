/**
 * Import commit benchmark: a generated 2,000-row TagMango orders file (repeat buyers, affiliates, contacts that
 * already exist) through upload, mapping, clean, match and commit, reporting rows per second for each phase.
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/edapt_perf npx tsx --conditions=react-server scripts/bench-import.ts [rows]
 *
 * EMPTIES EVERY TABLE of that database first, so it refuses any database whose name does not contain "test",
 * "perf" or "bench".
 */
import "./env";
import { rmSync } from "node:fs";
import path from "node:path";

// BENCH_PROFILE=1 counts the SQL statements of the commit phase (grouped by their first words), through the query
// log hook src/db reads when it is first loaded (it is imported dynamically below).
const profile = new Map<string, number>();
let profiling = false;
if (process.env.BENCH_PROFILE) {
  (globalThis as unknown as { __edaptQueryLog?: (q: string) => void }).__edaptQueryLog = (q) => {
    if (!profiling) return;
    const k = q.replace(/\s+/g, " ").replace(/\$\d+/g, "?").slice(0, 110);
    profile.set(k, (profile.get(k) ?? 0) + 1);
  };
}

const ROWS = Number(process.argv[2] ?? 2000);

function guard() {
  const name = new URL(process.env.DATABASE_URL ?? "postgres://x/unknown").pathname.slice(1);
  if (!/test|perf|bench/i.test(name)) throw new Error(`Refusing to empty "${name}": use a database named *test*, *perf* or *bench*`);
}

/** Deterministic pseudo-random numbers, so every run imports the same file. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const FIRST = ["Anil", "Meera", "Joseph", "Priya", "Rahul", "Sneha", "Fathima", "Vivek", "Arjun", "Divya", "Hari", "Lakshmi", "Nisha", "Rafeeq", "Shameer"];
const LAST = ["Kumar", "Nair", "Menon", "Pillai", "Rahman", "Mathew", "Das", "Raj", "Varghese", "Thomas", "K", "P"];
const CITIES = ["Kochi", "Thrissur", "Kozhikode", "Kannur", "Kollam", "Trivandrum", "Dubai", "Malappuram", "Palakkad"];
const MANGOS: [string, number][] = [
  ["AI Workshop", 999],
  ["AI Agents for Business", 1999],
  ["Applied AI Mastery", 24999],
  ["Prompting Workshop", 699],
];

export function buildCsv(rows: number): { csv: string; existingPhones: string[] } {
  const r = rng(42);
  const people = Math.round(rows * 0.7);
  const phone = (i: number) => `98${String(47000000 + i * 7).padStart(8, "0")}`;
  const lines = ["Order ID,Customer Name,Email,Dial Code,Phone,Mango,Amount,Currency,Order Date,Affiliate Name,Affiliate Phone,City"];
  for (let n = 0; n < rows; n++) {
    // the first `people` rows are distinct buyers; the rest are repeat purchases by earlier buyers
    const p = n < people ? n : Math.floor(r() * people);
    // name + city unique per buyer (same name in the same city would be a conflict for a human to decide)
    const name = `${FIRST[p % FIRST.length]} ${LAST[Math.floor(p / FIRST.length) % LAST.length]}`;
    const [mango, price] = MANGOS[Math.floor(r() * MANGOS.length)];
    const day = 1 + Math.floor(r() * 27);
    const month = 1 + Math.floor(r() * 12);
    const affiliate = r() < 0.1 ? Math.floor(r() * people) : null;
    lines.push(
      [
        `TM-B${100000 + n}`,
        name,
        `buyer${p}@example.com`,
        "91",
        phone(p),
        mango,
        String(price),
        "INR",
        `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/2025`,
        affiliate !== null ? `${FIRST[affiliate % FIRST.length]} Affiliate` : "",
        affiliate !== null ? phone(affiliate) : "",
        CITIES[Math.floor(p / (FIRST.length * LAST.length)) % CITIES.length],
      ].join(","),
    );
  }
  // one in ten buyers is already in the CRM (a Quick Add or a webhook got there first)
  const existingPhones = Array.from({ length: Math.round(people / 10) }, (_, i) => `+91${phone(i * 10)}`);
  return { csv: lines.join("\n"), existingPhones };
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const out = await fn();
  return [out, performance.now() - t0];
}

async function main() {
  guard();
  // imported after the client above is in place
  const { eq, sql } = await import("drizzle-orm");
  const { db, queryRows } = await import("@/db");
  const { contacts, importBatches, products, users } = await import("@/db/schema");
  const { createImportBatch, getBatchView, resolveAllConflictsAsNew, runCleanChunk, saveMapping } = await import("@/lib/import/batches");
  const { runCommitChunk, startCommit } = await import("@/lib/import/commit");
  const { runMatchChunk } = await import("@/lib/import/match");
  const { runUndoChunk, startUndo } = await import("@/lib/import/undo");

  const names = (await queryRows<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`)).map((x) => `"${x.tablename}"`);
  await db.execute(sql.raw(`truncate table ${names.join(", ")} restart identity cascade`));
  const [admin] = await db.insert(users).values({ name: "Bench Admin", email: "bench@edapt.test", role: "admin", team: "kerala" }).returning();
  await db.insert(users).values([
    { name: "Sales A", email: "a@edapt.test", role: "sales", team: "kerala" },
    { name: "Sales B", email: "b@edapt.test", role: "sales", team: "kerala" },
  ]);
  await db.insert(products).values(MANGOS.map(([name, price]) => ({ name, family: name.includes("Mastery") ? "applied_ai_mastery" : "workshop", rung: name.includes("Mastery") ? 2 : 1, listPrice: price })));
  const { csv, existingPhones } = buildCsv(ROWS);
  for (const [i, p] of existingPhones.entries()) {
    await db.insert(contacts).values({ phoneE164: p, phoneCountry: "IN", name: `Existing ${i}`, firstDoor: "youtube", stage: "new" });
  }

  const id = await createImportBatch({ fileName: "bench.csv", fileType: "text/csv", bytes: new TextEncoder().encode(csv), source: "tagmango" }, admin);
  const view = await getBatchView(id, admin);
  await saveMapping(id, { mapping: view!.mapping ?? {}, defaults: { ownerFallback: "round_robin" } }, admin);
  const [, cleanMs] = await timed(async () => {
    while (!(await runCleanChunk(id, admin, { limit: 2000 })).finished);
  });
  const [, matchMs] = await timed(async () => {
    while (!(await runMatchChunk(id, admin, { limit: 2000 })).finished);
  });
  // anything left undecided (none with the default size) is imported as new
  await resolveAllConflictsAsNew(id, admin);
  const toCommit = await startCommit(id, admin);
  profiling = true;
  const [, commitMs] = await timed(async () => {
    // the screen's own chunk settings (500 rows, 20 s budget)
    while (!(await runCommitChunk(id, admin, process.env.BENCH_CHUNK ? { limit: Number(process.env.BENCH_CHUNK) } : {})).finished);
  });
  profiling = false;
  const done = await getBatchView(id, admin);
  const [, undoMs] = await timed(async () => {
    await startUndo(id, admin);
    while (!(await runUndoChunk(id, admin)).finished);
  });
  const [{ n: left }] = await db.select({ n: sql<number>`count(*)::int` }).from(contacts);

  const rate = (n: number, ms: number) => `${Math.round((n / ms) * 1000)} rows/s (${(ms / n).toFixed(1)} ms/row, ${(ms / 1000).toFixed(1)} s)`;
  console.log(`rows: ${ROWS}, to commit: ${toCommit}`);
  console.log(`clean:  ${rate(ROWS, cleanMs)}`);
  console.log(`match:  ${rate(ROWS, matchMs)}`);
  console.log(`commit: ${rate(toCommit, commitMs)}`);
  console.log(`undo:   ${rate(toCommit, undoMs)}`);
  console.log(`counts: ${JSON.stringify(done?.countsT)}`);
  console.log(`after undo: ${left} contacts (${existingPhones.length} existed before)`);
  if (process.env.BENCH_PROFILE) {
    const total = [...profile.values()].reduce((a, b) => a + b, 0);
    console.log(`commit statements: ${total} (${(total / toCommit).toFixed(1)} per row)`);
    for (const [q, n] of [...profile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(String(n).padStart(7), q);
  }

  const [b] = await db.select({ fileUrl: importBatches.fileUrl }).from(importBatches).where(eq(importBatches.id, id));
  if (b?.fileUrl) rmSync(path.join(process.cwd(), "uploads", b.fileUrl.replace(/^\/api\/files\//, "")), { force: true });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
