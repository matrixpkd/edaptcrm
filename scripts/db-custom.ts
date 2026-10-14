/**
 * Applies drizzle/custom/*.sql (in file-name order) to DATABASE_URL: the SQL Drizzle cannot express, such as
 * `create extension`. It must run before `drizzle-kit push` and before the generated migrations, because the
 * schema has indexes that depend on it. drizzle/custom/after/*.sql runs once the tables exist (row level security).
 * Every statement in those files is idempotent.
 *
 *   npx tsx scripts/db-custom.ts          (npm run db:push and npm run db:migrate call it first)
 *   npx tsx scripts/db-custom.ts --after  (and this one last)
 */
import "./env";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

export const CUSTOM_SQL_DIR = path.resolve(__dirname, "../drizzle/custom");

export async function applyCustomSql(
  url: string,
  log: (msg: string) => void = () => {},
  { phase = "before" }: { phase?: "before" | "after" } = {},
): Promise<string[]> {
  const dir = phase === "after" ? path.join(CUSTOM_SQL_DIR, "after") : CUSTOM_SQL_DIR;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    for (const f of files) {
      await client.unsafe(readFileSync(path.join(dir, f), "utf8"));
      log(`applied ${path.relative(path.resolve(CUSTOM_SQL_DIR, ".."), path.join(dir, f))}`);
    }
  } finally {
    await client.end();
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const phase = process.argv.includes("--after") ? "after" : "before";
  applyCustomSql(url, (m) => console.log(m), { phase }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
