"use server";
import { revalidatePath } from "next/cache";
import { fail, list, ok, str, type ActionResult } from "@/lib/action";
import { setOnboardingDismissed } from "@/lib/admin/onboarding";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { resolveTransferRequest } from "@/lib/contacts/assignment";
import { ContactError } from "@/lib/contacts/errors";
import { isSnoozeKey } from "@/lib/today/rules";
import { actOnTasks, TodayError, type QueueAction } from "@/lib/today/tasks";

const DONE_MESSAGES: Record<QueueAction, string> = {
  done: "Marked done",
  dismiss: "Dismissed",
  snooze: "Snoozed",
};

/**
 * Done / Snooze / Dismiss on a Today row (all of the row's tasks). The service checks each task: its assignee,
 * a manager or admin, or a salesperson for a pool task on a contact they can see.
 */
export async function queueTaskAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const action = str(fd, "action");
  if (action !== "done" && action !== "dismiss" && action !== "snooze") return fail("Unknown action");
  const snooze = str(fd, "snooze");
  if (action === "snooze" && !isSnoozeKey(snooze)) return fail("Choose when to snooze until");
  try {
    await actOnTasks(list(fd, "taskId"), action, user, { snooze: isSnoozeKey(snooze) ? snooze : undefined });
  } catch (e) {
    if (e instanceof TodayError) return fail(e.message);
    throw e;
  }
  revalidatePath("/today");
  return ok(undefined, DONE_MESSAGES[action]);
}

/** A manager answers a transfer request from their Today queue. */
export async function transferDecisionAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.reassign")) return fail("Only a manager or admin can answer transfer requests");
  const taskId = str(fd, "taskId");
  const decision = str(fd, "decision");
  if (!taskId) return fail("That request no longer exists");
  if (decision !== "approve" && decision !== "decline") return fail("Approve or decline the request");
  try {
    const r = await resolveTransferRequest(taskId, decision, user);
    revalidatePath("/today");
    revalidatePath("/contacts");
    return ok(
      undefined,
      decision === "approve" ? (r.moved ? "Transfer approved and moved" : "Transfer approved") : "Transfer declined",
    );
  } catch (e) {
    if (e instanceof ContactError) return fail(e.message);
    throw e;
  }
}

/** Hides the admin's "Getting started" checklist on Today, or (show=1) brings it back. */
export async function onboardingVisibilityAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  if (!can(user, "settings.manage")) return;
  await setOnboardingDismissed(user.id, str(fd, "show") !== "1");
  revalidatePath("/today");
  revalidatePath("/settings");
}
