import { test, expect } from "./support/fixtures";
import { E2E_SECRETS } from "./support/env";

// laptop project only (playwright.config.ts)

test("cron runs only with the bearer secret", async ({ request }) => {
  // with the demo data the frequent job (alerts, digests) takes a while
  test.setTimeout(150_000);
  const ok = await request.get("/api/cron/frequent", { headers: { authorization: `Bearer ${E2E_SECRETS.cron}` }, timeout: 120_000 });
  expect(ok.status()).toBe(200);
  expect(ok.headers()["content-type"]).toContain("application/json");
  expect(await ok.json()).toMatchObject({ ok: true });

  expect((await request.get("/api/cron/frequent")).status()).toBe(401);
  expect((await request.get("/api/cron/frequent", { headers: { authorization: "Bearer nope" } })).status()).toBe(401);
});
