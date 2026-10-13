import { execSync } from "node:child_process";
import { config } from "dotenv";

/** Syncs the schema into the test database once per run (extensions from drizzle/custom first, as db:push does). */
export default function setup() {
  const env = config({ path: ".env.test", processEnv: {} }).parsed ?? {};
  const url = process.env.TEST_DATABASE_URL || env.DATABASE_URL;
  const opts = { env: { ...process.env, ...env, DATABASE_URL: url }, stdio: "pipe" as const };
  execSync("npx tsx scripts/db-custom.ts", opts);
  execSync("npx drizzle-kit push --force", opts);
}
