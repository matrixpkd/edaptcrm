/**
 * Pure rules for the Today, Log interaction and Rate customer screens (safe in client components).
 * Unit tested in tests/unit/today-rules.test.ts.
 */
import type { InteractionType, Role, TaskType } from "@/db/schema";
import { safeNextPath } from "@/lib/auth/redirect";
import { followUpPresets, type FollowUpPresetKey } from "@/lib/contacts/follow-up";
import { localDateAt, localDayStart } from "./time";

// ---------------------------------------------------------------------------
// Who may act on a Today task
// ---------------------------------------------------------------------------

/**
 * Done / Snooze / Dismiss on a task: its assignee, any manager or admin, or — for a pool task (no assignee) — a
 * salesperson who can see the contact (it is in the pool or theirs), since pool work is anyone's to pick up.
 */
export function canActOnTask(
  user: { id: string; role: Role },
  task: { userId: string | null },
  contact: { ownerId: string | null } | null,
): boolean {
  if (user.role === "admin" || user.role === "manager") return true;
  if (task.userId !== null) return task.userId === user.id;
  if (user.role !== "sales") return false;
  return !contact || contact.ownerId === null || contact.ownerId === user.id;
}

/** Task types that Dismiss cannot close: a follow-up is done or snoozed; a transfer request is answered. */
export function dismissible(type: TaskType): boolean {
  return type !== "follow_up" && type !== "transfer_request";
}

export const SNOOZE_OPTIONS = [
  { key: "tomorrow", label: "Tomorrow", days: 1 },
  { key: "in3Days", label: "3 days", days: 3 },
] as const;
export type SnoozeKey = (typeof SNOOZE_OPTIONS)[number]["key"];

export function isSnoozeKey(v: unknown): v is SnoozeKey {
  return SNOOZE_OPTIONS.some((o) => o.key === v);
}

// ---------------------------------------------------------------------------
// Log interaction
// ---------------------------------------------------------------------------

/** The type chips, in order. */
export const LOG_TYPES: { value: InteractionType; label: string }[] = [
  { value: "call", label: "Call" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "meeting", label: "Meeting" },
  { value: "email", label: "Email" },
  { value: "note", label: "Note" },
  { value: "support_issue", label: "Support issue" },
];

/** Support logs support issues by default; everyone else logs calls. A valid ?type= wins. */
export function defaultLogType(role: Role, requested?: string | null): InteractionType {
  if (requested && LOG_TYPES.some((t) => t.value === requested)) return requested as InteractionType;
  return role === "support" ? "support_issue" : "call";
}

export type FollowUpChoice = FollowUpPresetKey | "none" | "custom";

export const FOLLOW_UP_CHOICES: { value: FollowUpChoice; label: string }[] = [
  { value: "tomorrow", label: "Tomorrow" },
  { value: "in3Days", label: "3 days" },
  { value: "in1Week", label: "1 week" },
  { value: "none", label: "None" },
  { value: "custom", label: "Pick a date" },
];

/** How far ahead a custom follow-up may be set. */
export const MAX_FOLLOW_UP_DAYS = 366;

/**
 * The follow-up instant for a chip: tomorrow / 3 days / 1 week at 10:00 in the user's time zone, a custom
 * date (YYYY-MM-DD) at 10:00 local, or null for none. Throws a plain message for an invalid custom date.
 */
export function resolveFollowUp(
  choice: string | null | undefined,
  customDate: string | null | undefined,
  now: Date,
  timeZone: string,
): Date | null {
  if (!choice || choice === "none") return null;
  if (choice === "custom") {
    const at = customDate ? localDateAt(customDate, timeZone) : null;
    if (!at) throw new FollowUpError("Pick a date for the follow-up");
    if (at.getTime() < localDayStart(now, timeZone).getTime()) throw new FollowUpError("The follow-up date is in the past");
    if (at.getTime() > now.getTime() + MAX_FOLLOW_UP_DAYS * 86_400_000) {
      throw new FollowUpError("Pick a follow-up date within a year");
    }
    return at;
  }
  const presets = followUpPresets(now, timeZone);
  if (choice in presets) return presets[choice as FollowUpPresetKey];
  throw new FollowUpError("Choose when to follow up");
}

export class FollowUpError extends Error {
  readonly field = "followUp";
  constructor(message: string) {
    super(message);
    this.name = "FollowUpError";
  }
}

/** Outcomes that offer the quick "Mark lost", with the lost reason they suggest. */
export const LOST_OUTCOMES: Record<string, string> = {
  not_interested: "not_interested",
  wrong_number: "wrong_number",
};

export function suggestedLostReason(outcome: string | null | undefined): string | null {
  return (outcome && LOST_OUTCOMES[outcome]) || null;
}

/** A sensible next follow-up for an outcome, used until the user picks one themselves. */
export function suggestedFollowUp(outcome: string | null | undefined): FollowUpChoice {
  switch (outcome) {
    case "no_answer":
    case "busy":
      return "tomorrow";
    case "interested":
    case "payment_promised":
    case "info_sent":
      return "in3Days";
    default:
      return "none";
  }
}

/**
 * Where to go after saving: a same-site path from ?return= (never another origin, never back into the form
 * itself), else the fallback (the contact page).
 */
export function safeReturnPath(raw: string | null | undefined, fallback: string): string {
  const v = safeNextPath(raw, "");
  if (!v) return fallback;
  const path = v.split(/[?#]/)[0];
  if (/\/(log|rate)\/?$/.test(path)) return fallback;
  return v;
}
