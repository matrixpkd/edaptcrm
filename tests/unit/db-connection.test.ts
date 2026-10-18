import { describe, expect, it } from "vitest";
import { poolConfig } from "@/db/connection";

const SESSION = "postgresql://postgres.abcd:s3cr%40t@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres";

function target(url: string, env: Record<string, string | undefined> = {}) {
  const c = poolConfig(url, env);
  return { url: new URL(c.connectionString!), ssl: c.ssl, max: c.max };
}

describe("poolConfig", () => {
  it("moves a Supabase session-pooler URL to the transaction pooler, keeping the credentials", () => {
    const { url } = target(SESSION);
    expect(url.hostname).toBe("aws-0-ap-southeast-1.pooler.supabase.com");
    expect(url.port).toBe("6543");
    expect(url.username).toBe("postgres.abcd");
    expect(decodeURIComponent(url.password)).toBe("s3cr@t");
    expect(url.pathname).toBe("/postgres");
  });

  it("keeps the session pooler when DATABASE_POOLER=session", () => {
    expect(target(SESSION, { DATABASE_POOLER: "session" }).url.port).toBe("5432");
  });

  it("leaves a transaction-pooler URL and non-Supabase hosts as they are", () => {
    expect(target(SESSION.replace(":5432", ":6543")).url.port).toBe("6543");
    expect(target("postgres://postgres:postgres@localhost:5432/edapt").url.port).toBe("5432");
    expect(target("postgres://u:p@db.example.com/app").url.port).toBe("");
  });

  it("encrypts Supabase connections by default, and local ones only when asked", () => {
    expect(target(SESSION).ssl).toEqual({ rejectUnauthorized: false });
    expect(target("postgres://u:p@db.abcd.supabase.co:5432/postgres").ssl).toEqual({ rejectUnauthorized: false });
    expect(target("postgres://postgres:postgres@localhost:5432/edapt").ssl).toBe(false);
    expect(target(`${SESSION}?sslmode=disable`).ssl).toBe(false);
  });

  it("gives sslmode its libpq meaning and removes it from the URL node-postgres reads", () => {
    const req = target("postgres://u:p@db.example.com:5432/app?sslmode=require&application_name=crm");
    expect(req.ssl).toEqual({ rejectUnauthorized: false });
    expect(req.url.searchParams.get("sslmode")).toBeNull();
    expect(req.url.searchParams.get("application_name")).toBe("crm");
    expect(target("postgres://u:p@db.example.com/app?sslmode=verify-full").ssl).toEqual({ rejectUnauthorized: true });
    expect(() => poolConfig("postgres://u:p@db.example.com/app?sslmode=sometimes", {})).toThrow(/unknown sslmode/);
  });

  it("sizes the pool from DATABASE_POOL_MAX, falling back to 5 for missing or bad values", () => {
    expect(target(SESSION, { DATABASE_POOL_MAX: "3" }).max).toBe(3);
    expect(target(SESSION).max).toBe(5);
    expect(target(SESSION, { DATABASE_POOL_MAX: "0" }).max).toBe(5);
    expect(target(SESSION, { DATABASE_POOL_MAX: "lots" }).max).toBe(5);
  });

  it("rejects URLs that are not Postgres URLs", () => {
    expect(() => poolConfig("not a url", {})).toThrow(/not a valid URL/);
    expect(() => poolConfig("mysql://u:p@h/db", {})).toThrow(/postgres:\/\//);
  });
});
