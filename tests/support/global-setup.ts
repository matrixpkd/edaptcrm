import { execSync } from "node:child_process";
import { config } from "dotenv";

/** Syncs the schema into the test database once per run. */
export default function setup() {
  const env = config({ path: ".env.test", processEnv: {} }).parsed ?? {};
  execSync("npx drizzle-kit push --force", {
    env: { ...process.env, ...env, DATABASE_URL: env.DATABASE_URL },
    stdio: "pipe",
  });
}
