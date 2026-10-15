import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
/** A database handle or an open transaction. Every service function accepts one. */
export type Tx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __edaptSql?: postgres.Sql };

function createClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, {
    // No prepared statements, so either Supabase pooler mode works. Use the SESSION pooler (port 5432): the
    // transaction pooler (6543) stalls on pipelined queries, which this driver sends whenever several queries run
    // at once (dashboard, server actions with parallel reads) — see README "Deploy".
    prepare: false,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    // fail fast instead of hanging a request when the pooler cannot be reached
    connect_timeout: 15,
  });
}

const client = globalForDb.__edaptSql ?? createClient();
if (process.env.NODE_ENV !== "production") globalForDb.__edaptSql = client;

export const db: Database = drizzle(client, { schema });
export { schema };
