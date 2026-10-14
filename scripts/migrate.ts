/**
 * Applies drizzle/custom/*.sql (extensions Drizzle cannot create), then the SQL migrations in ./drizzle, then
 * drizzle/custom/after/*.sql (row level security) (use for Supabase: `DATABASE_URL=... npm run db:migrate`).
 */
import "./env";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { applyCustomSql } from "./db-custom";

async function main() {
  await applyCustomSql(process.env.DATABASE_URL!, (m) => console.log(m));
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  await client.end();
  await applyCustomSql(process.env.DATABASE_URL!, (m) => console.log(m), { phase: "after" });
  console.log("Migrations applied");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
