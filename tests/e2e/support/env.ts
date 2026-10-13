/**
 * Shared settings of the e2e run: port, database, secrets and the people the specs sign in as.
 * Imported by playwright.config.ts (so it must not import app code) and by the specs.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3403);
export const E2E_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/edapt_e2e";

export const E2E_SECRETS = {
  cron: "e2e-cron-secret",
  tagmango: "e2e-tagmango-secret",
  libromi: "e2e-libromi-secret",
  pabbly: "e2e-pabbly-secret",
} as const;

/** Environment of the web server (and of the specs, which use the same database). */
export const E2E_ENV: Record<string, string> = {
  DATABASE_URL: E2E_DATABASE_URL,
  DATABASE_POOL_MAX: "10",
  APP_URL: E2E_URL,
  NEXT_DIST_DIR: ".next-e2e",
  E2E_PORT: String(E2E_PORT),
  CRON_SECRET: E2E_SECRETS.cron,
  TAGMANGO_WEBHOOK_SECRET: E2E_SECRETS.tagmango,
  LIBROMI_WEBHOOK_SECRET: E2E_SECRETS.libromi,
  PABBLY_WEBHOOK_SECRET: E2E_SECRETS.pabbly,
  // no outside services in e2e: heuristic import mapping, logged emails, files under ./uploads
  ANTHROPIC_API_KEY: "",
  RESEND_API_KEY: "",
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  ADMIN_EMAIL: "umer@edapt.in",
  ADMIN_NAME: "Umer Abdussalam",
  ADMIN_PASSWORD: "change-me-now",
};

export const PASSWORD = "change-me-now";

export type E2ERole = "admin" | "manager" | "sales" | "sales2" | "support";

/** The demo team's logins (created by the demo seed, or by the global setup when the demo is skipped). */
export const PEOPLE: Record<E2ERole, { email: string; name: string; role: "admin" | "manager" | "sales" | "support"; team: string }> = {
  admin: { email: "umer@edapt.in", name: "Umer Abdussalam", role: "admin", team: "kerala" },
  manager: { email: "meera@edapt.in", name: "Meera Krishnan", role: "manager", team: "kerala" },
  sales: { email: "asha@edapt.in", name: "Asha Thomas", role: "sales", team: "kerala" },
  sales2: { email: "biju@edapt.in", name: "Biju Varghese", role: "sales", team: "kerala" },
  support: { email: "sana@edapt.in", name: "Sana Shirin", role: "support", team: "kerala" },
};

/** Saved sign-in (cookies) per role, written by the global setup. */
export function authFile(role: E2ERole): string {
  return `tests/e2e/.auth/${role}.json`;
}
