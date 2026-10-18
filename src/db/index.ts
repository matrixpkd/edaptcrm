import "server-only";
import type { SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { poolConfig } from "./connection";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. Every service function accepts one. */
export type Tx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as {
  __edaptPool?: Pool;
  /** Set by the perf benches before they load this module, to capture every statement the app sends. */
  __edaptQueryLog?: (query: string, params: unknown[]) => void;
};

function createPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // Transaction-mode pooler on Supabase, TLS and pool size: see ./connection.ts
  const pool = new Pool(poolConfig(url));
  // A connection the pooler or server drops must not crash the process. The pool only listens on idle connections,
  // so listen on every connection too (one held by a transaction): the query in flight rejects, the pool drops the
  // dead connection and opens a new one on the next query.
  pool.on("connect", (client) => client.on("error", (e) => console.error("[db] connection error", e)));
  pool.on("error", () => {}); // already logged by the connection's own listener
  return pool;
}

const pool = globalForDb.__edaptPool ?? createPool();
if (process.env.NODE_ENV !== "production") globalForDb.__edaptPool = pool;

const queryLog = globalForDb.__edaptQueryLog;
export const db: Database = drizzle(pool, { schema, ...(queryLog ? { logger: { logQuery: queryLog } } : {}) });
export { schema };

/**
 * The rows of a raw SQL query (`db.execute` returns the driver's result object).
 *
 * Services run several queries with Promise.all on whatever handle they get. On an open transaction pg@8 queues them
 * on its one connection (with a deprecation warning); pg@9 drops that, so keep `pg` on ^8 until those run in turn.
 */
export async function queryRows<T extends Record<string, unknown>>(query: SQL, t: Tx = db): Promise<T[]> {
  const result = await t.execute<T>(query);
  return result.rows as T[];
}
