import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-secret checks for the machine-to-machine routes (cron, webhooks).
 * - Comparisons are constant-time (both sides hashed to the same length first, so not even the length leaks).
 * - Fail closed in production: when the secret's env var is missing or blank there, every request is refused
 *   (and the misconfiguration is logged). Only in development / tests does a missing secret let requests in.
 */

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

const warned = new Set<string>();

/** The configured secret, or null when unset/blank. */
function secretFrom(envName: string): string | null {
  const v = process.env[envName]?.trim();
  return v ? v : null;
}

/** Without a configured secret: allowed only outside production. */
function missingSecret(envName: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  if (!warned.has(envName)) {
    warned.add(envName);
    console.error(`[secrets] ${envName} is not set: requests that need it are refused until it is configured`);
  }
  return false;
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
export function isAuthorizedCron(req: Request): boolean {
  const secret = secretFrom("CRON_SECRET");
  if (!secret) return missingSecret("CRON_SECRET");
  const auth = req.headers.get("authorization") ?? "";
  return safeEqual(auth, `Bearer ${secret}`);
}

/**
 * Webhooks authenticate with a shared secret passed as `?token=`, an `x-webhook-secret`
 * header, or `Authorization: Bearer <secret>`.
 */
export function isAuthorizedWebhook(req: Request, envName: string): boolean {
  const secret = secretFrom(envName);
  if (!secret) return missingSecret(envName);
  const url = new URL(req.url);
  const candidates = [
    url.searchParams.get("token"),
    req.headers.get("x-webhook-secret"),
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""),
  ].filter((v): v is string => !!v);
  // every candidate is compared, so the time taken does not depend on which one matched
  let ok = false;
  for (const c of candidates) if (safeEqual(c, secret)) ok = true;
  return ok;
}
