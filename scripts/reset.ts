/** Development only: empties every table in DATABASE_URL. */
import "./env";
import { sql } from "drizzle-orm";
import { db, queryRows } from "@/db";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset in production");
  const rows = await queryRows<{ tablename: string }>(sql`select tablename from pg_tables where schemaname='public'`);
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate table ${names} restart identity cascade`));
  console.log("All tables emptied");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
