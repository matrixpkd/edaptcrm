import "server-only";
import { runFrequentJobs, runNightlyJobs, runWeeklyJobs, type JobReport } from "@/lib/alerts/jobs";
import { isAuthorizedCron } from "@/lib/secrets";

const JOBS: Record<"frequent" | "nightly" | "weekly", (now: Date) => Promise<JobReport>> = {
  frequent: runFrequentJobs,
  nightly: runNightlyJobs,
  weekly: runWeeklyJobs,
};

/**
 * Shared handler of the cron routes: checks the cron secret, runs the job and answers with its report as JSON
 * (200 when every step succeeded, 500 when any step failed; the report says which).
 */
export async function runJobs(req: Request, job: keyof typeof JOBS): Promise<Response> {
  if (!isAuthorizedCron(req)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const report = await JOBS[job](new Date());
  return Response.json(report, { status: report.ok ? 200 : 500, headers: { "cache-control": "no-store" } });
}
