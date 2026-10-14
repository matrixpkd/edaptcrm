/**
 * Schedules the CRM's cron routes from inside Supabase (pg_cron + pg_net), for when Vercel cannot: the Hobby plan
 * only allows cron jobs that run once a day, and the "frequent" job must run every 15 minutes (abandoned-checkout
 * calls after an hour, untouched-lead alerts, the 8:30 digests).
 *
 *   DATABASE_URL=<supabase session URL, port 5432> APP_URL=https://crm.edapt.in CRON_SECRET=<same as Vercel> \
 *     npm run cron:schedule                      # every 15 minutes: /api/cron/frequent (the default)
 *   npm run cron:schedule -- --jobs frequent,nightly,weekly   # run every job from Supabase (then empty vercel.json crons)
 *   npm run cron:schedule -- --status            # list the jobs, their last runs and the last HTTP responses
 *   npm run cron:schedule -- --remove            # unschedule every edapt-* job
 *
 * Idempotent: running it again updates the schedule and the stored URL/secret. With Supabase Vault available the
 * URL and secret are kept in Vault (names edapt_crm_url / edapt_cron_secret) and read at run time; otherwise they
 * are written into the job's SQL.
 */
import "./env";
import path from "node:path";
import postgres from "postgres";

type Sql = postgres.Sql | postgres.TransactionSql;

export type CronJobName = "frequent" | "nightly" | "weekly";

/** Schedules in UTC (pg_cron's time zone on Supabase), matching the comments in src/app/api/cron/*. */
export const CRON_JOBS: Record<CronJobName, { schedule: string; timeoutMs: number }> = {
  frequent: { schedule: "*/15 * * * *", timeoutMs: 120_000 },
  nightly: { schedule: "30 20 * * *", timeoutMs: 300_000 },
  weekly: { schedule: "30 3 * * 1", timeoutMs: 120_000 },
};

export const JOB_PREFIX = "edapt-";
export const VAULT_URL_NAME = "edapt_crm_url";
export const VAULT_SECRET_NAME = "edapt_cron_secret";

function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The SQL pg_cron runs: one asynchronous GET to the cron route with the bearer secret. */
export function buildCronCommand(
  job: CronJobName,
  source: { vault: true } | { vault: false; appUrl: string; secret: string },
): string {
  const url = source.vault
    ? `(select decrypted_secret from vault.decrypted_secrets where name = ${literal(VAULT_URL_NAME)}) || ${literal(`/api/cron/${job}`)}`
    : literal(`${source.appUrl}/api/cron/${job}`);
  const secret = source.vault
    ? `(select decrypted_secret from vault.decrypted_secrets where name = ${literal(VAULT_SECRET_NAME)})`
    : literal(source.secret);
  return [
    "select net.http_get(",
    `  url := ${url},`,
    `  headers := jsonb_build_object('Authorization', 'Bearer ' || ${secret}),`,
    `  timeout_milliseconds := ${CRON_JOBS[job].timeoutMs}`,
    ");",
  ].join("\n");
}

/** "https://crm.edapt.in/" -> "https://crm.edapt.in"; refuses anything that is not an http(s) origin. */
export function normaliseAppUrl(raw: string | undefined, { allowLocal = false } = {}): string {
  if (!raw) throw new Error("APP_URL is not set (the public address of the CRM, e.g. https://crm.edapt.in)");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`APP_URL is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`APP_URL must be http(s): ${raw}`);
  if (!allowLocal && /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname)) {
    throw new Error(`APP_URL points at ${u.hostname}; Supabase cannot reach it. Use the deployed address.`);
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Whether schema.name exists as a function (any signature: Vault and pg_net signatures vary between versions). */
async function hasFunction(sql: Sql, schema: string, name: string): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = ${schema} and p.proname = ${name}
    ) as ok`;
  return row.ok === true;
}

/** Makes sure pg_cron and pg_net exist (on Supabase both can also be switched on under Database → Extensions). */
export async function ensureExtensions(sql: Sql): Promise<void> {
  if (!(await hasFunction(sql, "cron", "schedule"))) {
    try {
      await sql`create extension if not exists pg_cron`;
    } catch (e) {
      throw new Error(
        `Could not enable pg_cron (${(e as Error).message}). In Supabase, open Database → Extensions and enable "pg_cron", then run this again.`,
      );
    }
  }
  if (!(await hasFunction(sql, "net", "http_get"))) {
    try {
      const [ext] = await sql`select to_regnamespace('extensions') is not null as ok`;
      if (ext.ok) await sql`create extension if not exists pg_net with schema extensions`;
      else await sql`create extension if not exists pg_net`;
    } catch (e) {
      throw new Error(
        `Could not enable pg_net (${(e as Error).message}). In Supabase, open Database → Extensions and enable "pg_net", then run this again.`,
      );
    }
  }
}

async function upsertVaultSecret(sql: Sql, name: string, value: string): Promise<void> {
  const [existing] = await sql`select id from vault.secrets where name = ${name}`;
  if (existing) await sql`select vault.update_secret(${existing.id}::uuid, ${value})`;
  else await sql`select vault.create_secret(${value}, ${name}, ${"Edapt CRM cron"})`;
}

export type InstallResult = { jobs: { name: string; schedule: string }[]; vault: boolean };

/** Creates or updates the pg_cron jobs. */
export async function installCronSchedule(
  sql: Sql,
  opts: { appUrl: string; secret: string; jobs?: CronJobName[]; useVault?: boolean },
): Promise<InstallResult> {
  if (!opts.secret || opts.secret.length < 16) {
    throw new Error("CRON_SECRET must be set to the same long random value as on Vercel (16+ characters)");
  }
  const jobs = opts.jobs?.length ? opts.jobs : (["frequent"] as CronJobName[]);
  await ensureExtensions(sql);
  const vault =
    opts.useVault !== false &&
    (await hasFunction(sql, "vault", "create_secret")) &&
    (await hasFunction(sql, "vault", "update_secret"));
  if (vault) {
    await upsertVaultSecret(sql, VAULT_URL_NAME, opts.appUrl);
    await upsertVaultSecret(sql, VAULT_SECRET_NAME, opts.secret);
  }
  const out: InstallResult = { jobs: [], vault };
  for (const job of jobs) {
    const name = `${JOB_PREFIX}${job}`;
    const command = buildCronCommand(job, vault ? { vault: true } : { vault: false, appUrl: opts.appUrl, secret: opts.secret });
    // pg_cron updates the job in place when the name already exists
    await sql`select cron.schedule(${name}, ${CRON_JOBS[job].schedule}, ${command})`;
    out.jobs.push({ name, schedule: CRON_JOBS[job].schedule });
  }
  return out;
}

/** Unschedules the named jobs (default: every edapt-* job). Returns the names removed. */
export async function removeCronSchedule(sql: Sql, jobs?: CronJobName[]): Promise<string[]> {
  const [cron] = await sql`select to_regclass('cron.job') is not null as ok`;
  if (!cron.ok) return [];
  const names = jobs?.length
    ? jobs.map((j) => `${JOB_PREFIX}${j}`)
    : (await sql`select jobname from cron.job where jobname like ${`${JOB_PREFIX}%`}`).map((r) => r.jobname as string);
  const removed: string[] = [];
  for (const name of names) {
    const [exists] = await sql`select 1 from cron.job where jobname = ${name}`;
    if (!exists) continue;
    await sql`select cron.unschedule(${name})`;
    removed.push(name);
  }
  return removed;
}

async function printStatus(sql: Sql): Promise<void> {
  const [cron] = await sql`select to_regclass('cron.job') is not null as ok`;
  if (!cron.ok) {
    console.log("pg_cron is not enabled in this database. Enable pg_cron and pg_net, then run `npm run cron:schedule`.");
    return;
  }
  const jobs = await sql`select jobid, jobname, schedule, active from cron.job where jobname like ${`${JOB_PREFIX}%`} order by jobname`;
  if (!jobs.length) {
    console.log("No edapt-* jobs are scheduled. Run `npm run cron:schedule`.");
    return;
  }
  console.table(jobs.map((j) => ({ job: j.jobname, schedule: j.schedule, active: j.active })));
  try {
    const runs = await sql`
      select j.jobname, d.status, d.return_message, d.start_time
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where j.jobname like ${`${JOB_PREFIX}%`}
      order by d.start_time desc limit 10`;
    console.log("Last runs (pg_cron queued the request):");
    console.table(runs.map((r) => ({ job: r.jobname, status: r.status, at: r.start_time, message: r.return_message })));
  } catch {
    /* job_run_details is optional */
  }
  try {
    const responses = await sql`
      select status_code, timed_out, error_msg, created from net._http_response order by created desc limit 10`;
    console.log("Last HTTP responses (200 = the CRM ran the job; 401 = CRON_SECRET differs from Vercel's):");
    console.table(responses.map((r) => ({ status: r.status_code, timedOut: r.timed_out, error: r.error_msg, at: r.created })));
  } catch {
    /* pg_net keeps responses for a few hours only */
  }
}

function parseJobs(arg: string | undefined): CronJobName[] | undefined {
  if (!arg) return undefined;
  const list = arg.split(",").map((s) => s.trim()).filter(Boolean);
  for (const j of list) if (!(j in CRON_JOBS)) throw new Error(`Unknown job "${j}". Use frequent, nightly or weekly.`);
  return list as CronJobName[];
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (use the Supabase session connection, port 5432)");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    if (flag("status")) return await printStatus(sql);
    if (flag("remove")) {
      const removed = await removeCronSchedule(sql, parseJobs(value("jobs")));
      console.log(removed.length ? `Removed ${removed.join(", ")}` : "Nothing to remove.");
      return;
    }
    const appUrl = normaliseAppUrl(process.env.APP_URL, { allowLocal: flag("allow-local") });
    const result = await installCronSchedule(sql, {
      appUrl,
      secret: process.env.CRON_SECRET ?? "",
      jobs: parseJobs(value("jobs")),
      useVault: !flag("no-vault"),
    });
    for (const j of result.jobs) console.log(`Scheduled ${j.name} (${j.schedule} UTC) -> ${appUrl}/api/cron/${j.name.slice(JOB_PREFIX.length)}`);
    console.log(
      result.vault
        ? `The URL and secret are stored in Supabase Vault (${VAULT_URL_NAME}, ${VAULT_SECRET_NAME}).`
        : "Supabase Vault is not available here, so the URL and secret are written into the job's SQL.",
    );
    console.log("Check it in 15 minutes with `npm run cron:schedule -- --status` (expect HTTP 200).");
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
