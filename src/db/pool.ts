import { Pool, type PoolClient } from "pg";

/**
 * True for "the database or pooler has no room for another client": Supavisor's EMAXCONN / EMAXCONNSESSION
 * (SQLSTATE XX000) and Postgres' 53300 (too many connections). Nothing has run on the connection yet, so a
 * retry is safe.
 */
export function isTooManyClients(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (code === "53300") return true;
  return typeof message === "string" && /\bEMAXCONN|max client(s| connections) reached|too many (clients|connections)/i.test(message);
}

/** Waits before each retry of a refused connection (about 4 s in all, with jitter). */
export const RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];

type ConnectCallback = (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void;

/**
 * A pg Pool that waits and retries when the pooler is full instead of failing the request. A burst of requests
 * (many serverless instances starting at once) can briefly use every client slot the pooler has; a moment later
 * requests finish and slots free up. On a retry the pool first reuses a connection of its own that has come free,
 * so under pressure an instance needs fewer connections. Both `pool.connect()` (transactions) and `pool.query()`
 * (which calls connect with a callback) go through here.
 */
export class RetryingPool extends Pool {
  // pg-pool's own declarations: a promise without a callback, nothing with one
  connect(): Promise<PoolClient>;
  connect(callback: ConnectCallback): void;
  connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const attempt = this.connectWithRetry();
    if (!callback) return attempt;
    attempt.then(
      (client) => callback(undefined, client, (release) => client.release(release as Error | boolean | undefined)),
      (err: Error) => callback(err, undefined, () => {}),
    );
  }

  private async connectWithRetry(): Promise<PoolClient> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.connect();
      } catch (e) {
        if (!isTooManyClients(e) || attempt >= RETRY_DELAYS_MS.length) throw e;
        const delay = RETRY_DELAYS_MS[attempt] * (0.5 + Math.random());
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
