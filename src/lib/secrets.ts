import "server-only";
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
export function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization") ?? "";
  return safeEqual(auth, `Bearer ${secret}`);
}

/**
 * Webhooks authenticate with a shared secret passed as `?token=`, an `x-webhook-secret`
 * header, or `Authorization: Bearer <secret>`.
 */
export function isAuthorizedWebhook(req: Request, envName: string): boolean {
  const secret = process.env[envName];
  if (!secret) return process.env.NODE_ENV !== "production";
  const url = new URL(req.url);
  const candidates = [
    url.searchParams.get("token"),
    req.headers.get("x-webhook-secret"),
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""),
  ].filter((v): v is string => !!v);
  return candidates.some((c) => safeEqual(c, secret));
}
