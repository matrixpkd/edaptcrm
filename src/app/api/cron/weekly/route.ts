import { runJobs } from "../run";

/**
 * Mondays at 03:30 UTC (about 9:00 IST, vercel.json): the weekly summary to Umer.
 * Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`; anything else gets 401.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(req: Request): Promise<Response> {
  return runJobs(req, "weekly");
}
