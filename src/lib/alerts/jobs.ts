import "server-only";
/**
 * Scheduled jobs (src/app/api/cron/*) and "Run alerts now".
 *
 * - frequent (every 15 minutes, from Supabase pg_cron: `npm run cron:schedule`; Vercel Hobby allows only daily
 *   crons): abandoned checkouts, untouched leads, lead release, follow-up pings, instalments due, unverified
 *   payments, alert emails, daily digests (each user at their own local 8:30).
 * - nightly (02:00 IST, vercel.json): recompute every contact (rebuilds cohorts first), then next rung, at risk, VIPs
 *   gone quiet, then prune webhook_events older than 180 days that were processed without an error, sign-in attempts
 *   older than a day and expired sessions; finally the frequent steps once more, so alerts still go out (a day late)
 *   if the 15-minute schedule is missing or down. Every rule is idempotent, so the extra pass never duplicates.
 * - weekly (Monday 09:00 IST): the weekly summary.
 *
 * Steps run one after another; a failing step is logged and reported (the route answers 500) but does not stop
 * the steps after it, so one bad rule never silences every other alert.
 */
import { db, type Tx } from "@/db";
import { pruneExpiredSessions, pruneLoginAttempts } from "@/lib/auth/login-limit";
import { recomputeAll } from "@/lib/metrics/recompute";
import { pruneWebhookEvents } from "@/lib/webhooks/retention";
import { sendDailyDigests, sendWeeklySummary } from "./digest";
import { sendPendingNotificationEmails } from "./mailer";
import {
  abandonedCheckouts,
  atRisk,
  closeRepurchasedTasks,
  dueForNextRung,
  followUpsDue,
  instalmentsDue,
  releaseStaleLeads,
  unverifiedPayments,
  untouchedLeads,
  vipGoneQuiet,
} from "./rules";

export type StepReport = { ok: boolean; ms: number; result?: unknown; error?: string };
export type JobReport = { ok: boolean; job: string; now: string; ms: number; steps: Record<string, StepReport> };
type Step = [name: string, run: () => Promise<unknown>];

/** A step "fails" when it throws, or when it reports failures of its own (e.g. emails the service refused). */
function reportedErrors(result: unknown): string | null {
  if (result && typeof result === "object" && "failed" in result) {
    const r = result as { failed?: number; errors?: string[] };
    if (r.failed && r.failed > 0) return (r.errors ?? []).slice(0, 5).join("; ") || `${r.failed} failed`;
  }
  return null;
}

async function runSteps(job: string, now: Date, steps: Step[]): Promise<JobReport> {
  const started = Date.now();
  const report: JobReport = { ok: true, job, now: now.toISOString(), ms: 0, steps: {} };
  for (const [name, run] of steps) {
    const t0 = Date.now();
    try {
      const result = await run();
      const error = reportedErrors(result);
      report.steps[name] = { ok: !error, ms: Date.now() - t0, result, ...(error ? { error } : {}) };
      if (error) {
        report.ok = false;
        console.error(`[cron:${job}] ${name}: ${error}`);
      }
    } catch (e) {
      report.ok = false;
      const error = e instanceof Error ? e.message : String(e);
      report.steps[name] = { ok: false, ms: Date.now() - t0, error };
      console.error(`[cron:${job}] ${name} failed`, e);
    }
  }
  report.ms = Date.now() - started;
  return report;
}

function frequentSteps(now: Date): Step[] {
  return [
    ["abandonedCheckouts", () => abandonedCheckouts(now)],
    // release first, so a released lead's untouched alert is dismissed in the same run
    ["releaseStaleLeads", () => releaseStaleLeads(now)],
    ["untouchedLeads", () => untouchedLeads(now)],
    ["followUpsDue", () => followUpsDue(now)],
    ["instalmentsDue", () => instalmentsDue(now)],
    ["unverifiedPayments", () => unverifiedPayments(now)],
    ["sendPendingNotificationEmails", () => sendPendingNotificationEmails(now)],
    ["sendDailyDigests", () => sendDailyDigests(now)],
  ];
}

/** Every 15 minutes. */
export function runFrequentJobs(now: Date = new Date()): Promise<JobReport> {
  return runSteps("frequent", now, frequentSteps(now));
}

/**
 * Nightly at 02:00 IST: scores, repeat metrics and cohorts first, then the alerts that read them, then a catch-up
 * pass of the frequent steps (reported as "catchUp.<step>").
 */
export function runNightlyJobs(now: Date = new Date()): Promise<JobReport> {
  return runSteps("nightly", now, [
    ["recomputeAll", async () => ({ contacts: await recomputeAll({ now }) })],
    ["closeRepurchasedTasks", () => closeRepurchasedTasks(now)],
    ["dueForNextRung", () => dueForNextRung(now)],
    ["atRisk", () => atRisk(now)],
    ["vipGoneQuiet", () => vipGoneQuiet(now)],
    ["pruneWebhookEvents", () => pruneWebhookEvents(now)],
    ["pruneLoginAttempts", () => pruneLoginAttempts(now)],
    ["pruneExpiredSessions", () => pruneExpiredSessions(now)],
    ...frequentSteps(now).map(([name, run]): Step => [`catchUp.${name}`, run]),
  ]);
}

/** Monday morning. */
export function runWeeklyJobs(now: Date = new Date()): Promise<JobReport> {
  return runSteps("weekly", now, [["sendWeeklySummary", () => sendWeeklySummary(now)]]);
}

export type RunAllAlertsResult = {
  abandonedCheckouts: Awaited<ReturnType<typeof abandonedCheckouts>>;
  untouchedLeads: Awaited<ReturnType<typeof untouchedLeads>>;
  releaseStaleLeads: Awaited<ReturnType<typeof releaseStaleLeads>>;
  followUpsDue: Awaited<ReturnType<typeof followUpsDue>>;
  instalmentsDue: Awaited<ReturnType<typeof instalmentsDue>>;
  unverifiedPayments: Awaited<ReturnType<typeof unverifiedPayments>>;
  closeRepurchasedTasks: Awaited<ReturnType<typeof closeRepurchasedTasks>>;
  dueForNextRung: Awaited<ReturnType<typeof dueForNextRung>>;
  atRisk: Awaited<ReturnType<typeof atRisk>>;
  vipGoneQuiet: Awaited<ReturnType<typeof vipGoneQuiet>>;
  emails: Awaited<ReturnType<typeof sendPendingNotificationEmails>>;
};

/**
 * Runs every alert rule now (without the nightly recompute and without digests), then sends the alert emails.
 * Idempotent like each rule. Used by tests and by the admin "Run alerts now" action (src/lib/alerts/actions.ts);
 * it does not check permissions itself — callers do.
 */
export async function runAllAlerts(now: Date = new Date(), tx: Tx = db): Promise<RunAllAlertsResult> {
  return {
    abandonedCheckouts: await abandonedCheckouts(now, tx),
    releaseStaleLeads: await releaseStaleLeads(now, tx),
    untouchedLeads: await untouchedLeads(now, tx),
    followUpsDue: await followUpsDue(now, tx),
    instalmentsDue: await instalmentsDue(now, tx),
    unverifiedPayments: await unverifiedPayments(now, tx),
    closeRepurchasedTasks: await closeRepurchasedTasks(now, tx),
    dueForNextRung: await dueForNextRung(now, tx),
    atRisk: await atRisk(now, tx),
    vipGoneQuiet: await vipGoneQuiet(now, tx),
    emails: await sendPendingNotificationEmails(now, tx),
  };
}

/** One line for a toast: "3 tasks and 5 alerts raised, 2 emails sent". */
export function summarizeRun(r: RunAllAlertsResult): string {
  const tasks =
    r.abandonedCheckouts.tasks +
    r.untouchedLeads.ownerAlerts +
    r.instalmentsDue.dueTasks +
    r.instalmentsDue.overdueTasks +
    r.dueForNextRung.created +
    r.atRisk.created;
  const alerts =
    r.untouchedLeads.managerAlerts +
    r.followUpsDue.notified +
    r.instalmentsDue.notified +
    r.unverifiedPayments.notified +
    r.vipGoneQuiet.notified;
  const parts = [
    `${tasks} task${tasks === 1 ? "" : "s"}`,
    `${alerts} alert${alerts === 1 ? "" : "s"} raised`,
    ...(r.releaseStaleLeads.released ? [`${r.releaseStaleLeads.released} lead${r.releaseStaleLeads.released === 1 ? "" : "s"} released`] : []),
    `${r.emails.emails} email${r.emails.emails === 1 ? "" : "s"} sent`,
  ];
  return parts.join(", ");
}
