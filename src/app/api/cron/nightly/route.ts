import { runJobs } from "../run";

/**
 * Nightly at 02:00 IST (20:30 UTC, vercel.json): recompute every contact (cohorts first), then due for next rung,
 * at risk and VIPs gone quiet, then old processed webhook events are pruned (180 days), then the frequent steps run
 * once more as a safety net. Vercel Hobby fires it at any time within the 20:00 UTC hour.
 * Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`; anything else gets 401.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export function GET(req: Request): Promise<Response> {
  return runJobs(req, "nightly");
}
