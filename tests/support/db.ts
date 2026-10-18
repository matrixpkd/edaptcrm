/**
 * Integration-test helpers. Import from tests only.
 * Usage:
 *   beforeEach(async () => { await resetDb(); });
 *   const admin = await makeUser({ role: "admin" });
 */
import { sql } from "drizzle-orm";
import { db, queryRows } from "@/db";
import { users, type Role } from "@/db/schema";

export async function resetDb() {
  const rows = await queryRows<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not like '\\_\\_%'`,
  );
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate table ${names} restart identity cascade`));
}

let n = 0;
export async function makeUser(over: Partial<{ name: string; email: string; role: Role; team: string | null; active: boolean; timezone: string }> = {}) {
  n += 1;
  const [u] = await db
    .insert(users)
    .values({
      name: over.name ?? `User ${n}`,
      email: over.email ?? `user${n}-${Date.now()}@test.local`,
      role: over.role ?? "sales",
      team: over.team === undefined ? "kerala" : over.team,
      active: over.active ?? true,
      timezone: over.timezone ?? "Asia/Kolkata",
    })
    .returning();
  return u;
}
