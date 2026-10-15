/**
 * The Today queue ranking (spec "Alerts and the Today queue"). PURE: no server imports, unit tested in
 * tests/unit/today-rank.test.ts; src/lib/today/queue.ts loads the tasks and calls buildQueue().
 *
 * Every row on Today is one or more open tasks for one contact. The ranking:
 *
 *   1. Abandoned checkouts sit at the very top: they are the hottest leads Edapt has.
 *   2. Overdue follow-ups and overdue tasks someone set by hand (due before the start of the user's local today)
 *      come next, on top of the rest.
 *   3. Everything else is ranked by ONE combined score, `rankScore`, on the 0-100 scale of the Edapt Score:
 *        - a lead's rankScore is its Edapt Score (unscored = 0);
 *        - a customer's rankScore comes from their expected 90-day revenue (repeat probability x price of the
 *          next best offer), mapped onto the same scale with a log curve:
 *              rankScore = 20 x log10(1 + expected_90d_inr), held between 0 and 100
 *          so ₹100 ≈ 40 (a grade C lead), ₹1,000 ≈ 60 (B), ₹5,600 ≈ 75 (A), ₹10,000 ≈ 80 and ₹1 lakh = 100.
 *          A customer with no forecast yet (no cohort rate or no priced offer) falls back to their Edapt Score.
 *      Customers are therefore ordered by expected revenue and leads by Edapt Score, and the two interleave on
 *      one scale: a customer worth about ₹5,600 in the next 90 days is as urgent as a grade A lead.
 *   The same score orders rows inside bands 1 and 2. Ties: higher task priority, then the earlier due date,
 *   then the older task.
 *
 * Rows are capped (settings thresholds.todayCap, default 40); the rest are counted as "left out".
 */
import type { Stage, TaskType } from "@/db/schema";
import { compactAgo, localDayEnd, localDayStart, localDaysBetween, localTime, shortDate } from "./time";

export type QueueBand = "abandoned" | "overdue" | "next";
export type QueueKind = "customer" | "lead" | "none";

/** Band order: lower sorts first. */
export const BAND_ORDER: Record<QueueBand, number> = { abandoned: 0, overdue: 1, next: 2 };

export type QueueContact = {
  id: string;
  name: string;
  phoneE164: string;
  phoneCountry: string | null;
  ownerId: string | null;
  grade: "A" | "B" | "C" | "D" | null;
  edaptScore: number | null;
  stage: Stage;
  nextOffer: string | null;
  purchaseCount: number;
  expected90dInr: number | null;
  nextExpectedAt: Date | null;
  lastEnquiryAt: Date | null;
};

export type QueueTask = {
  id: string;
  type: TaskType;
  reason: string;
  dueAt: Date;
  priority: number;
  createdAt: Date;
  /** null = the unassigned pool */
  userId: string | null;
  contact: QueueContact | null;
  /**
   * Not a stored task but a row Today derives itself (a lead assigned to the user in the last
   * thresholds.untouchedOwnerHours with no call or message yet). It has no id to complete: logging an
   * interaction clears it, and after the window the alerts engine raises a real "untouched_lead" task.
   */
  synthetic?: boolean;
};

export type QueueRow = {
  /** stable React key: the contact id (or the task id when the task has no contact) plus the assignee in team view */
  key: string;
  band: QueueBand;
  kind: QueueKind;
  rankScore: number;
  /** the task that ranks the row (its reason leads the row) */
  primary: Omit<QueueTask, "contact">;
  /** every stored open task on this row, primary first: Done / Snooze / Dismiss act on all of them.
   *  Empty for a derived new-lead row (logging an interaction clears it). */
  taskIds: string[];
  types: TaskType[];
  /** "why it is here": the primary task's reason */
  reason: string;
  /** reasons of the other tasks on the row */
  alsoReasons: string[];
  /** short context bits: "Grade A lead", "enquired 2h ago", "Overdue 2 days" */
  context: string[];
  contact: QueueContact | null;
  /** every task on the row is in the pool */
  pool: boolean;
  /** Dismiss is for alerts: offered when the row has stored tasks and none is a follow-up or a transfer request */
  canDismiss: boolean;
  /** a transfer request is answered with Approve / Decline instead of Done */
  transferTaskId: string | null;
};

export type QueueCounts = {
  abandoned: number;
  overdue: number;
  customers: number;
  leads: number;
  /** rows without a contact */
  other: number;
  total: number;
};

export type BuiltQueue = {
  rows: QueueRow[];
  /** rows before the cap */
  total: number;
  /** rows not shown because of the cap */
  leftOut: number;
  cap: number;
  /** counts over every row (before the cap) */
  counts: QueueCounts;
};

const NOT_DISMISSIBLE: TaskType[] = ["follow_up", "transfer_request"];

/** 0-100 score for a customer's expected 90-day revenue (see the header). */
export function revenueRankScore(expected90dInr: number): number {
  const v = Math.max(0, Number(expected90dInr) || 0);
  return Math.min(100, Math.max(0, 20 * Math.log10(1 + v)));
}

export function kindOf(contact: Pick<QueueContact, "purchaseCount"> | null): QueueKind {
  if (!contact) return "none";
  return contact.purchaseCount > 0 ? "customer" : "lead";
}

/** The combined ranking score of a contact (see the header). */
export function rankScore(
  contact: Pick<QueueContact, "purchaseCount" | "expected90dInr" | "edaptScore"> | null,
): number {
  if (!contact) return 0;
  if (contact.purchaseCount > 0) {
    if (contact.expected90dInr !== null && contact.expected90dInr !== undefined) {
      return revenueRankScore(contact.expected90dInr);
    }
    return contact.edaptScore ?? 0;
  }
  return contact.edaptScore ?? 0;
}

/** Task types with a real deadline set by a person: overdue ones sit just under abandoned checkouts. */
export const OVERDUE_BAND_TYPES: TaskType[] = ["follow_up", "task"];

/** Abandoned checkout > overdue follow-up or task > the rest. `dayStart` is 00:00 of the user's local today. */
export function bandOf(task: Pick<QueueTask, "type" | "dueAt">, dayStart: Date): QueueBand {
  if (task.type === "abandoned_checkout") return "abandoned";
  if (OVERDUE_BAND_TYPES.includes(task.type) && task.dueAt.getTime() < dayStart.getTime()) return "overdue";
  return "next";
}

type Ranked = { task: QueueTask; band: QueueBand; score: number };

function compareRanked(a: Ranked, b: Ranked): number {
  return (
    BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
    b.score - a.score ||
    b.task.priority - a.task.priority ||
    a.task.dueAt.getTime() - b.task.dueAt.getTime() ||
    a.task.createdAt.getTime() - b.task.createdAt.getTime() ||
    (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0)
  );
}

/**
 * The "why it is here" context of a row, after the task reason:
 * - leads: "Grade A lead" and "enquired 2h ago";
 * - customers: "Grade B customer", "Expected to buy around 12 Oct" (or "Was expected to buy around ...");
 * - timing of the primary task: "Overdue 2 days" when a follow-up or instalment was due before today ("Open for
 *   2 days" for an alert raised before today), "Due 4:00 pm" later today.
 */
export function contextFor(
  task: Pick<QueueTask, "dueAt" | "type" | "synthetic">,
  contact: QueueContact | null,
  now: Date,
  timeZone: string,
): string[] {
  const out: string[] = [];
  if (contact) {
    const grade = contact.grade ? `Grade ${contact.grade}` : null;
    if (contact.purchaseCount > 0) {
      out.push(grade ? `${grade} customer` : "Customer");
      if (contact.nextExpectedAt) {
        const when = shortDate(contact.nextExpectedAt, now, timeZone);
        out.push(
          contact.nextExpectedAt.getTime() >= localDayStart(now, timeZone).getTime()
            ? `Expected to buy around ${when}`
            : `Was expected to buy around ${when}`,
        );
      }
    } else {
      out.push(grade ? `${grade} lead` : "Lead, not scored yet");
      if (contact.lastEnquiryAt) out.push(`enquired ${compactAgo(contact.lastEnquiryAt, now)}`);
    }
  }
  // a derived new-lead row's "due" time is when it was assigned: not a deadline
  if (task.synthetic) return out;
  const days = localDaysBetween(task.dueAt, now, timeZone);
  const plural = `${days} day${days === 1 ? "" : "s"}`;
  // only a follow-up, a task or an instalment has a real deadline; an alert's due time is when it was raised
  if (days > 0) out.push(DEADLINE_TYPES.includes(task.type) ? `Overdue ${plural}` : `Open for ${plural}`);
  else if (task.dueAt.getTime() > now.getTime()) out.push(`Due ${localTime(task.dueAt, timeZone)}`);
  return out;
}

const DEADLINE_TYPES: TaskType[] = ["follow_up", "instalment_due", "task"];

const DAY_MS = 24 * 60 * 60 * 1000;
const AT_RISK_DAYS = /^At risk: \d+ days past/;

/**
 * A task's reason as of `now`. The at-risk alert's text counts the days past the expected purchase when it was
 * raised ("At risk: 36 days past ..."); a task left open for months would show a stale count, so the count is
 * worked out again from the contact's expected purchase date. Every other reason is shown as stored.
 */
export function liveReason(task: Pick<QueueTask, "type" | "reason">, contact: QueueContact | null, now: Date): string {
  if (task.type !== "at_risk" || !contact?.nextExpectedAt || !AT_RISK_DAYS.test(task.reason)) return task.reason;
  const days = Math.max(0, Math.floor((now.getTime() - contact.nextExpectedAt.getTime()) / DAY_MS));
  return task.reason.replace(AT_RISK_DAYS, `At risk: ${days} day${days === 1 ? "" : "s"} past`);
}

export type BuildQueueOptions = {
  now: Date;
  /** the user's time zone: decides "today" and "overdue" */
  timeZone: string;
  cap: number;
  /**
   * "contact": one row per contact (a user's own queue, own and pool tasks together).
   * "assignee": one row per contact and assignee (team view sections).
   */
  groupBy?: "contact" | "assignee";
};

/**
 * Ranks open tasks into Today rows. Tasks due after the end of the user's local today are ignored
 * (the caller normally filters them in SQL already). Several tasks on one contact become one row,
 * ranked by its best task; Done / Snooze act on all of them.
 */
export function buildQueue(tasks: QueueTask[], opts: BuildQueueOptions): BuiltQueue {
  const dayStart = localDayStart(opts.now, opts.timeZone);
  const dayEnd = localDayEnd(opts.now, opts.timeZone);
  const ranked: Ranked[] = tasks
    .filter((t) => t.dueAt.getTime() < dayEnd.getTime())
    .map((task) => ({ task, band: bandOf(task, dayStart), score: rankScore(task.contact) }))
    .sort(compareRanked);

  const groups = new Map<string, Ranked[]>();
  for (const r of ranked) {
    const base = r.task.contact?.id ?? `task:${r.task.id}`;
    // transfer requests stay on their own row: they are answered, not done
    const own = r.task.type === "transfer_request" ? `:transfer:${r.task.id}` : "";
    const key = opts.groupBy === "assignee" ? `${base}:${r.task.userId ?? "pool"}${own}` : `${base}${own}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  // Map keeps insertion order, and tasks were inserted best-first, so groups come out ranked by their best task
  const rows: QueueRow[] = [];
  for (const [key, list] of groups) {
    const top = list[0];
    const { contact, ...primary } = top.task;
    const reasons = list.map((r) => liveReason(r.task, r.task.contact, opts.now));
    const stored = list.filter((r) => !r.task.synthetic);
    rows.push({
      key,
      band: top.band,
      kind: kindOf(contact),
      rankScore: Math.round(top.score * 10) / 10,
      primary,
      taskIds: stored.map((r) => r.task.id),
      types: [...new Set(list.map((r) => r.task.type))],
      reason: reasons[0],
      alsoReasons: [...new Set(reasons.slice(1).filter((x) => x !== reasons[0]))],
      // filled in below for the rows that survive the cap (date formatting is the slow part of a long queue)
      context: [],
      contact,
      pool: list.every((r) => r.task.userId === null),
      canDismiss: stored.length > 0 && stored.every((r) => !NOT_DISMISSIBLE.includes(r.task.type)),
      transferTaskId: top.task.type === "transfer_request" ? top.task.id : null,
    });
  }

  const counts: QueueCounts = { abandoned: 0, overdue: 0, customers: 0, leads: 0, other: 0, total: rows.length };
  for (const r of rows) {
    if (r.band === "abandoned") counts.abandoned += 1;
    else if (r.band === "overdue") counts.overdue += 1;
    else if (r.kind === "customer") counts.customers += 1;
    else if (r.kind === "lead") counts.leads += 1;
    else counts.other += 1;
  }

  const cap = Math.max(0, Math.floor(opts.cap));
  const shown = rows.slice(0, cap);
  for (const r of shown) {
    r.context = contextFor(r.primary, r.contact, opts.now, opts.timeZone);
  }
  return {
    rows: shown,
    total: rows.length,
    leftOut: Math.max(0, rows.length - cap),
    cap,
    counts,
  };
}

/** Human labels for task types (Today row tags, team view). */
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  follow_up: "Follow-up",
  abandoned_checkout: "Abandoned checkout",
  hot_lead: "Hot lead",
  new_lead: "New lead",
  untouched_lead: "Untouched lead",
  next_rung: "Due for next rung",
  at_risk: "At risk",
  instalment_due: "Instalment due",
  unverified_payment: "Unverified payment",
  new_advocate: "New advocate",
  vip_quiet: "VIP gone quiet",
  lead_released: "Lead released",
  transfer_request: "Transfer request",
  duplicate_review: "Possible duplicate",
  task: "Task",
};
