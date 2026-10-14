/**
 * scripts/schedule-cron.ts against stand-ins for Supabase's pg_cron, pg_net and Vault (created inside a transaction
 * that is always rolled back, so the test database is left untouched).
 */
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  buildCronCommand,
  installCronSchedule,
  normaliseAppUrl,
  removeCronSchedule,
  VAULT_SECRET_NAME,
  VAULT_URL_NAME,
} from "../../scripts/schedule-cron";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
afterAll(() => sql.end());

const SECRET = "a-long-random-cron-secret-123";
class Rollback extends Error {}

async function withStubs(fn: (tx: postgres.TransactionSql) => Promise<void>, { vault = true } = {}) {
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`
        create schema cron;
        create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
        create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
          insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
          on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
          returning jobid $$;
        create function cron.unschedule(job_name text) returns boolean language sql as $$
          delete from cron.job where jobname = job_name returning true $$;
        create schema net;
        create table net.calls (url text, headers jsonb, timeout int);
        create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
          returns bigint language sql as $$ insert into net.calls values (url, headers, timeout_milliseconds); select 1::bigint $$;
      `);
      if (vault) {
        await tx.unsafe(`
          create schema vault;
          create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
          create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
          create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
            returns uuid language sql as $$ insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description) returning id $$;
          create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
            returns void language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
        `);
      }
      await fn(tx);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

/** Runs the job's stored SQL the way pg_cron would and returns the HTTP call it queued. */
async function fire(tx: postgres.TransactionSql, jobname: string) {
  const [job] = await tx`select command from cron.job where jobname = ${jobname}`;
  await tx.unsafe(job.command as string);
  const [call] = await tx`select url, headers, timeout from net.calls order by ctid desc limit 1`;
  return call as { url: string; headers: Record<string, string>; timeout: number };
}

describe("cron:schedule", () => {
  it("schedules the 15-minute job with the URL and secret kept in Vault", async () => {
    await withStubs(async (tx) => {
      const r = await installCronSchedule(tx, { appUrl: "https://crm.edapt.in", secret: SECRET });
      expect(r).toEqual({ vault: true, jobs: [{ name: "edapt-frequent", schedule: "*/15 * * * *" }] });
      const [job] = await tx`select schedule, command from cron.job where jobname = 'edapt-frequent'`;
      expect(job.schedule).toBe("*/15 * * * *");
      expect(job.command).not.toContain(SECRET); // read from Vault at run time
      const call = await fire(tx, "edapt-frequent");
      expect(call.url).toBe("https://crm.edapt.in/api/cron/frequent");
      expect(call.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
      expect(call.timeout).toBe(120_000);
      const secrets = await tx`select name from vault.secrets order by name`;
      expect(secrets.map((s) => s.name)).toEqual([VAULT_SECRET_NAME, VAULT_URL_NAME].sort());
    });
  });

  it("is idempotent: running it again updates the job and the secret instead of adding copies", async () => {
    await withStubs(async (tx) => {
      await installCronSchedule(tx, { appUrl: "https://crm.edapt.in", secret: SECRET });
      await installCronSchedule(tx, { appUrl: "https://crm.edapt.in", secret: `${SECRET}-rotated` });
      expect((await tx`select count(*)::int as n from cron.job`)[0].n).toBe(1);
      expect((await tx`select count(*)::int as n from vault.secrets`)[0].n).toBe(2);
      const call = await fire(tx, "edapt-frequent");
      expect(call.headers.Authorization).toBe(`Bearer ${SECRET}-rotated`);
    });
  });

  it("without Vault writes the URL and secret into the job, and can schedule every job", async () => {
    await withStubs(
      async (tx) => {
        const r = await installCronSchedule(tx, {
          appUrl: "https://crm.edapt.in",
          secret: "it's-a-long-secret-with-a-quote",
          jobs: ["frequent", "nightly", "weekly"],
        });
        expect(r.vault).toBe(false);
        expect(r.jobs.map((j) => j.schedule)).toEqual(["*/15 * * * *", "30 20 * * *", "30 3 * * 1"]);
        const nightly = await fire(tx, "edapt-nightly");
        expect(nightly.url).toBe("https://crm.edapt.in/api/cron/nightly");
        expect(nightly.headers.Authorization).toBe("Bearer it's-a-long-secret-with-a-quote");
        expect(nightly.timeout).toBe(300_000);
      },
      { vault: false },
    );
  });

  it("removes only its own jobs", async () => {
    await withStubs(async (tx) => {
      await installCronSchedule(tx, { appUrl: "https://crm.edapt.in", secret: SECRET, jobs: ["frequent", "weekly"] });
      await tx`select cron.schedule('someone-else', '0 * * * *', 'select 1')`;
      expect(await removeCronSchedule(tx, ["weekly"])).toEqual(["edapt-weekly"]);
      expect(await removeCronSchedule(tx)).toEqual(["edapt-frequent"]);
      expect((await tx`select jobname from cron.job`).map((j) => j.jobname)).toEqual(["someone-else"]);
    });
  });

  it("refuses a short secret and an address Supabase cannot reach", async () => {
    await withStubs(async (tx) => {
      await expect(installCronSchedule(tx, { appUrl: "https://crm.edapt.in", secret: "short" })).rejects.toThrow(/CRON_SECRET/);
    });
    expect(() => normaliseAppUrl("http://localhost:3000")).toThrow(/cannot reach/);
    expect(() => normaliseAppUrl(undefined)).toThrow(/APP_URL is not set/);
    expect(normaliseAppUrl("https://crm.edapt.in/")).toBe("https://crm.edapt.in");
  });

  it("builds a plain GET with the bearer header", () => {
    expect(buildCronCommand("frequent", { vault: false, appUrl: "https://x.example", secret: "s" })).toBe(
      [
        "select net.http_get(",
        "  url := 'https://x.example/api/cron/frequent',",
        "  headers := jsonb_build_object('Authorization', 'Bearer ' || 's'),",
        "  timeout_milliseconds := 120000",
        ");",
      ].join("\n"),
    );
  });
});
