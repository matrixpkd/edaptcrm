import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, queryRows } from "@/db";

async function terminate(pid: number) {
  // from another pooled connection, as a pooler restart or a network drop would
  await db.execute(sql`select pg_terminate_backend(${pid}::int)`);
}

describe("database connection", () => {
  it("returns the rows of a raw query, on the pool and inside a transaction", async () => {
    expect(await queryRows<{ n: number }>(sql`select 1::int as n union all select 2`)).toEqual([{ n: 1 }, { n: 2 }]);
    const inTx = await db.transaction((tx) => queryRows<{ ok: boolean }>(sql`select true as ok`, tx));
    expect(inTx).toEqual([{ ok: true }]);
  });

  it("survives a connection dropped while a transaction holds it: the transaction fails, the next query works", async () => {
    const run = db.transaction(async (tx) => {
      const [{ pid }] = await queryRows<{ pid: number }>(sql`select pg_backend_pid() as pid`, tx);
      await terminate(pid);
      await new Promise((r) => setTimeout(r, 200)); // e.g. waiting on bcrypt or an email inside the transaction
      await tx.execute(sql`select 1`);
    });
    await expect(run).rejects.toThrow();
    expect(await queryRows<{ ok: number }>(sql`select 1::int as ok`)).toEqual([{ ok: 1 }]);
  });

  it("survives a connection dropped in the middle of a query", async () => {
    const run = db.transaction(async (tx) => {
      const [{ pid }] = await queryRows<{ pid: number }>(sql`select pg_backend_pid() as pid`, tx);
      await Promise.all([tx.execute(sql`select pg_sleep(2)`), new Promise((r) => setTimeout(r, 150)).then(() => terminate(pid))]);
    });
    await expect(run).rejects.toThrow();
    expect(await queryRows<{ ok: number }>(sql`select 1::int as ok`)).toEqual([{ ok: 1 }]);
  });
});
