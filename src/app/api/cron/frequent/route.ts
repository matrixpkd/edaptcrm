import { runJobs } from "../run";

/**
 * Every 15 minutes (vercel.json): abandoned checkouts, untouched leads, lead release, follow-up pings,
 * instalments due, unverified payments, alert emails and the daily digests (each user at their local send time).
 * Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`; anything else gets 401.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export function GET(req: Request): Promise<Response> {
  return runJobs(req, "frequent");
}
