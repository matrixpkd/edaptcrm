import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { db, queryRows } from "@/db";
import { RetryingPool } from "@/db/pool";

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

describe("a full pooler", () => {
  // A role allowed one connection stands in for a pooler with no free client slot (Postgres refuses with 53300).
  const role = `edapt_limited_${process.pid}`;
  const url = new URL(process.env.DATABASE_URL!);
  const limitedUrl = () => {
    const u = new URL(url);
    u.username = role;
    u.password = "limited-pass";
    return u.toString();
  };

  beforeAll(async () => {
    await db.execute(sql.raw(`drop role if exists ${role}`));
    await db.execute(sql.raw(`create role ${role} login password 'limited-pass' connection limit 1`));
  });
  afterAll(async () => {
    await db.execute(sql.raw(`select pg_terminate_backend(pid) from pg_stat_activity where usename = '${role}'`));
    await db.execute(sql.raw(`drop role if exists ${role}`));
  });

  it("is waited out: a second query reuses the connection once it is free, instead of failing", async () => {
    const pool = new RetryingPool({ connectionString: limitedUrl(), max: 3 });
    try {
      const [slow, quick] = await Promise.all([pool.query("select pg_sleep(0.4), 1 as n"), pool.query("select 2 as n")]);
      expect(slow.rows[0].n).toBe(1);
      expect(quick.rows[0].n).toBe(2);
      expect(pool.totalCount).toBe(1);
      const client = await pool.connect(); // transactions take a client the same way
      client.release();
    } finally {
      await pool.end();
    }
  });

  it("fails without the retry (the case it guards)", async () => {
    const pool = new Pool({ connectionString: limitedUrl(), max: 3 });
    try {
      const results = await Promise.allSettled([pool.query("select pg_sleep(0.4)"), pool.query("select 2")]);
      expect(results.some((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "53300")).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
