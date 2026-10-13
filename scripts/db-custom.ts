/**
 * Applies drizzle/custom/*.sql (in file-name order) to DATABASE_URL: the SQL Drizzle cannot express, such as
 * `create extension`. It must run before `drizzle-kit push` and before the generated migrations, because the
 * schema has indexes that depend on it. Every statement in those files is idempotent.
 *
 *   npx tsx scripts/db-custom.ts          (npm run db:push and npm run db:migrate call it first)
 */
import "./env";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

export const CUSTOM_SQL_DIR = path.resolve(__dirname, "../drizzle/custom");

export async function applyCustomSql(url: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  const files = readdirSync(CUSTOM_SQL_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    for (const f of files) {
      await client.unsafe(readFileSync(path.join(CUSTOM_SQL_DIR, f), "utf8"));
      log(`applied drizzle/custom/${f}`);
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
  applyCustomSql(url, (m) => console.log(m)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
