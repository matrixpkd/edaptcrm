import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL, E2E_ENV, E2E_PORT, E2E_URL } from "./tests/e2e/support/env";

// the specs make their fixtures through the domain services, against the same database as the server
process.env.DATABASE_URL = E2E_DATABASE_URL;
process.env.DATABASE_POOL_MAX ??= "3";

/** Specs about the phone-first screens run on the phone only; desk and API flows run on the laptop only. */
const PHONE_ONLY = /\/(contact|rate|phone-layout)\.spec\.ts$/;
const LAPTOP_ONLY = /\/(admin-pages|cron|import|payments|scoping|webhooks)\.spec\.ts$/;

/**
 * End-to-end tests (`npm run test:e2e`). The web server is a production build of the app (`.next-e2e`) on port 3403
 * against the `edapt_e2e` database; the global setup empties that database, seeds the admin, the starter products
 * and the demo data, then signs one person in per role (admin, manager, sales, support) for the specs to reuse.
 *
 *   npm run test:e2e                         # build, start, seed and run everything
 *   E2E_DEMO=0 npm run test:e2e              # skip the 1.5-minute demo seed (the specs make their own data)
 *   E2E_SKIP_BUILD=1 npm run test:e2e        # reuse the last .next-e2e build
 *   npx playwright test tests/e2e/today.spec.ts --project=phone
 *
 * Outside CI an already running server on 3403 is reused (`node tests/e2e/support/serve.mjs` with the same env).
 * Every spec creates its own contacts with unique phone numbers, so the specs run in parallel and in any order.
 */
export default defineConfig({
  testDir: "tests/e2e",
  // test files import domain services (to make fixtures); this maps `server-only` to an empty module for them
  tsconfig: "./tests/e2e/tsconfig.json",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: E2E_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // the production build registers a service worker; it must not cache pages between tests
    serviceWorkers: "block",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  },
  projects: [
    {
      name: "laptop",
      testIgnore: PHONE_ONLY,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "phone",
      testIgnore: LAPTOP_ONLY,
      // iPhone 13 size on Chromium (only Chromium is installed)
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: devices["iPhone 13"].userAgent,
      },
    },
  ],
  webServer: {
    command: `node tests/e2e/support/serve.mjs`,
    url: `${E2E_URL}/api/health`,
    env: E2E_ENV,
    reuseExistingServer: !process.env.CI,
    // a cold production build takes a few minutes
    timeout: 600_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  metadata: { port: E2E_PORT },
});
