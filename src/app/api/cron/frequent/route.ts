import { runJobs } from "../run";

/**
 * Every 15 minutes: abandoned checkouts, untouched leads, lead release, follow-up pings, instalments due,
 * unverified payments, alert emails and the daily digests (each user at their local send time).
 * Vercel Hobby only allows daily crons, so this one is called by Supabase pg_cron (`npm run cron:schedule`), or by any
 * scheduler that sends `Authorization: Bearer $CRON_SECRET`; anything else gets 401. On Vercel Pro it may instead be
 * added to vercel.json as "*\/15 * * * *" (then remove the Supabase job with `npm run cron:schedule -- --remove`).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export function GET(req: Request): Promise<Response> {
  return runJobs(req, "frequent");
}
