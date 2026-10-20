import type { PoolConfig } from "pg";

/**
 * Pool settings for the app's database client (node-postgres), from DATABASE_URL. Pure, so it is unit tested.
 *
 * Supabase's shared pooler (Supavisor) serves session mode on port 5432 and transaction mode on port 6543 of the
 * same host. Serverless functions must use transaction mode: session mode admits only `pool_size` clients in total
 * (15 on small plans), and a few page loads at once, each with its link prefetches, open more than that, so pages
 * fail with "max clients reached" (EMAXCONNSESSION). A Supabase pooler URL on 5432 is therefore moved to 6543
 * unless DATABASE_POOLER=session. node-postgres suits transaction mode: one query at a time per connection, and
 * no named prepared statements.
 *
 * Pool size: transaction mode admits 200 clients on small plans, and a burst of requests starts one Vercel instance
 * per request, so each instance keeps ONE connection by default on Vercel (the usual serverless setting; a page's
 * parallel queries take turns on it). Elsewhere (local, scripts) the default is 5. DATABASE_POOL_MAX overrides both.
 *
 * TLS: `sslmode` keeps its libpq meaning (require = encrypted, certificate not checked; verify-full = checked).
 * Supabase hosts are encrypted by default. Other hosts without `sslmode` (local Postgres) connect in plain text.
 */
export const SUPABASE_POOLER_HOST = /\.pooler\.supabase\.com$/i;
const SUPABASE_HOST = /\.supabase\.(com|co)$/i;
const SESSION_PORT = 5432;
const TRANSACTION_PORT = 6543;

type Env = Record<string, string | undefined>;

export function poolConfig(url: string, env: Env = process.env): PoolConfig {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://");
  }

  const port = u.port ? Number(u.port) : SESSION_PORT;
  if (SUPABASE_POOLER_HOST.test(u.hostname) && port === SESSION_PORT && env.DATABASE_POOLER !== "session") {
    u.port = String(TRANSACTION_PORT);
  }

  const sslmode = u.searchParams.get("sslmode");
  // node-postgres reads sslmode as verify-full; TLS is set below instead, with libpq's meaning
  u.searchParams.delete("sslmode");

  return {
    connectionString: u.toString(),
    ssl: sslFor(sslmode, SUPABASE_HOST.test(u.hostname)),
    max: positiveInt(env.DATABASE_POOL_MAX, env.VERCEL ? 1 : 5),
    // close idle connections soon; on Vercel the instance is kept alive until they close (see ./index.ts)
    idleTimeoutMillis: 5_000,
    // fail fast instead of hanging a request when the pooler cannot be reached
    connectionTimeoutMillis: 15_000,
    // scripts exit when their work is done, without waiting for idle connections to time out
    allowExitOnIdle: true,
  };
}

function sslFor(sslmode: string | null, supabase: boolean): PoolConfig["ssl"] {
  switch (sslmode) {
    case "disable":
    case "allow":
      return false;
    case "prefer":
    case "require":
    case "no-verify":
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
    case null:
      return supabase ? { rejectUnauthorized: false } : false;
    default:
      throw new Error(`DATABASE_URL has an unknown sslmode "${sslmode}"`);
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
