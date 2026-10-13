import "server-only";
/**
 * Public API of the alerts module (server only). Pure helpers: ./schedule. Email HTML builders: src/emails.
 * Server action for the Settings "Run alerts now" button: runAlertsNowAction in ./actions.
 */
export { adminIds, closeContactTasks, completeTask, createTask, createTasks, managerIds, notify } from "./core";
export type { NewNotification, NewTask } from "./core";
export {
  ABANDONED_LOOKBACK_DAYS,
  CHECKOUT_CHANNEL,
  PRIORITY_HIGH,
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
export { buildDailyDigest, buildWeeklySummary, dailyDigestKey, sendDailyDigests, sendWeeklySummary } from "./digest";
export type { DigestUser, SendResult, WeeklySummary } from "./digest";
export { sendPendingNotificationEmails } from "./mailer";
export { runAllAlerts, runFrequentJobs, runNightlyJobs, runWeeklyJobs, summarizeRun } from "./jobs";
export type { JobReport, RunAllAlertsResult } from "./jobs";
export { umerRecipients } from "./shared";
