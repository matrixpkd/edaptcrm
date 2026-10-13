import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import postgres from "postgres";
import { chromium, type FullConfig } from "@playwright/test";
import { E2E_DATABASE_URL, E2E_ENV, PASSWORD, PEOPLE, authFile, type E2ERole } from "./support/env";

const root = path.resolve(__dirname, "../..");

function run(args: string[], label: string) {
  const started = Date.now();
  execFileSync("npx", args, { cwd: root, env: { ...process.env, ...E2E_ENV }, stdio: ["ignore", "pipe", "pipe"] });
  console.log(`[e2e setup] ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

async function truncateAll(sql: postgres.Sql) {
  const rows = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public' and tablename not like '\\_\\_%'`;
  if (rows.length) {
    await sql.unsafe(`truncate table ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`);
  }
}

/** The role logins, created here when the demo seed did not run (same emails and password as the demo team). */
async function ensurePeople(sql: postgres.Sql) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  for (const p of Object.values(PEOPLE)) {
    await sql`
      insert into users (name, email, password_hash, role, team, timezone, active)
      values (${p.name}, ${p.email}, ${hash}, ${p.role}, ${p.team}, 'Asia/Kolkata', true)
      on conflict ((lower(email))) do nothing`;
  }
}

/** Signs each role in through the login form once and saves the cookies for the specs. */
async function signIn(baseURL: string) {
  fs.mkdirSync(path.join(root, "tests/e2e/.auth"), { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const role of Object.keys(PEOPLE) as E2ERole[]) {
      const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.goto("/login");
      await page.getByLabel("Email").fill(PEOPLE[role].email);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL("**/today", { timeout: 30_000 });
      await context.storageState({ path: path.join(root, authFile(role)) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * Resets edapt_e2e: schema push, empty every table, admin + starter products, the demo data (E2E_DEMO=0 skips it;
 * if the demo seeder fails the run carries on without it, since every spec makes its own data), the role logins,
 * then one saved sign-in per role.
 */
export default async function globalSetup(config: FullConfig) {
  const dbName = new URL(E2E_DATABASE_URL).pathname.slice(1);
  if (!dbName.includes("e2e")) throw new Error(`Refusing to reset ${dbName}: the e2e database name must contain "e2e"`);
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("baseURL is not set");

  run(["tsx", "scripts/db-custom.ts"], "extensions created (drizzle/custom)");
  run(["drizzle-kit", "push", "--force"], "schema pushed");
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await truncateAll(sql);
    const demo = process.env.E2E_DEMO !== "0";
    try {
      run(["tsx", "--conditions=react-server", "scripts/seed.ts", ...(demo ? ["--demo"] : [])], demo ? "admin, products and demo data seeded" : "admin and products seeded");
    } catch (e) {
      if (!demo) throw e;
      const err = e as { stderr?: Buffer; message: string };
      console.warn(`[e2e setup] the demo seed failed, carrying on without it:\n${err.stderr?.toString().slice(-2000) ?? err.message}`);
      await truncateAll(sql);
      run(["tsx", "--conditions=react-server", "scripts/seed.ts"], "admin and products seeded");
    }
    await ensurePeople(sql);
  } finally {
    await sql.end();
  }
  await signIn(baseURL);
}
