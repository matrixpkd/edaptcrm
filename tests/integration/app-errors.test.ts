import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { appErrors } from "@/db/schema";
import { CLIENT_ERROR_LIMIT, pruneAppErrors, recordAppError } from "@/lib/app-errors";
import { POST } from "@/app/api/client-errors/route";
import { resetDb } from "../support/db";

function report(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://crm.test/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://crm.test", host: "crm.test", "x-forwarded-for": "10.0.0.9", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("error log", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("records server errors and trims long values", async () => {
    await recordAppError({ kind: "server", message: "x".repeat(5000), path: "/dashboard", method: "GET", source: "render" });
    const [row] = await db.select().from(appErrors);
    expect(row.message).toHaveLength(2000);
    expect(row).toMatchObject({ kind: "server", path: "/dashboard", source: "render" });
  });

  it("accepts same-origin browser reports and refuses cross-site ones", async () => {
    expect((await report({ message: "TypeError: x is undefined", path: "/today" })).status).toBe(200);
    expect((await report({ message: "boom" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await report("not json")).status).toBe(400);
    const rows = await db.select().from(appErrors);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "client", message: "TypeError: x is undefined", path: "/today", ip: "10.0.0.9" });
  });

  it("rate limits browser reports per address", async () => {
    for (let i = 0; i < CLIENT_ERROR_LIMIT; i++) await recordAppError({ kind: "client", message: `e${i}`, ip: "10.0.0.9" });
    expect((await report({ message: "one more" })).status).toBe(429);
  });

  it("prunes errors older than 30 days", async () => {
    await db.insert(appErrors).values([
      { kind: "server", message: "old", createdAt: new Date(Date.now() - 31 * 24 * 3600_000) },
      { kind: "server", message: "new" },
    ]);
    expect(await pruneAppErrors()).toEqual({ deleted: 1 });
  });
});
