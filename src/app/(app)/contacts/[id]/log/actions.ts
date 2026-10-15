"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { INTERACTION_TYPES, type InteractionType } from "@/db/schema";
import { bool, fail, str, type ActionResult } from "@/lib/action";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { ContactError } from "@/lib/contacts/errors";
import { logFromSheet } from "@/lib/today/log";
import { loadLogScreen } from "@/lib/today/screens";
import { FollowUpError, LOG_TYPES, resolveFollowUp, safeReturnPath, suggestedLostReason } from "@/lib/today/rules";
import { validTimeZone } from "@/lib/today/time";
import { flash } from "@/lib/flash";

const MAX_NOTE = 2000;

/** "Call logged. Follow-up set." for the toast on the page the user goes back to. */
function loggedMessage(type: InteractionType, markLost: boolean, followUp: boolean): string {
  const what = `${LOG_TYPES.find((t) => t.value === type)?.label ?? "Interaction"} logged`;
  if (markLost) return `${what}. Marked as lost.`;
  return followUp ? `${what}. Follow-up set.` : `${what}.`;
}

/**
 * Logs one interaction (and optionally marks the contact Lost) in one transaction, then goes back to where the
 * user came from. Support logs on any contact without changing the owner; sales on their own and pool contacts.
 */
export async function logInteractionAction(contactId: string, _prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "interactions.log")) return fail("You cannot log interactions");
  const screen = await loadLogScreen(contactId, user);
  if (!screen) return fail("This contact is not available to you");

  const type = str(fd, "type");
  if (!type || !INTERACTION_TYPES.includes(type as InteractionType)) {
    return fail("Choose what kind of touch this was", { type: "Choose a type" });
  }
  const direction = str(fd, "direction") ?? "out";
  if (direction !== "in" && direction !== "out") return fail("Choose incoming or outgoing", { direction: "Choose one" });
  const summary = str(fd, "summary");
  if (summary && summary.length > MAX_NOTE) {
    return fail(`Keep the note under ${MAX_NOTE} characters`, { summary: "Too long" });
  }
  const outcome = str(fd, "outcome");

  let nextFollowUpAt: Date | null;
  try {
    nextFollowUpAt = resolveFollowUp(str(fd, "followUp"), str(fd, "followUpDate"), new Date(), validTimeZone(user.timezone));
  } catch (e) {
    if (e instanceof FollowUpError) return fail(e.message, { followUp: e.message });
    throw e;
  }

  const markLost = bool(fd, "markLost");
  const lostReason = str(fd, "lostReason");
  if (markLost) {
    if (!screen.canMarkLost) return fail("You cannot mark this contact as lost");
    if (!suggestedLostReason(outcome)) {
      return fail("Mark lost goes with a Not interested or Wrong number outcome", { outcome: "Choose the outcome" });
    }
    if (!lostReason) return fail("Choose why they are lost", { lostReason: "Choose a reason" });
  }

  try {
    await logFromSheet(
      screen.contact.id,
      { type: type as InteractionType, outcome, summary, direction, nextFollowUpAt },
      { markLost, lostReason },
      user,
    );
  } catch (e) {
    if (e instanceof ContactError) return fail(e.message, e.field ? { [e.field]: e.message } : undefined);
    throw e;
  }

  revalidatePath("/today");
  revalidatePath(`/contacts/${screen.contact.id}`);
  await flash(loggedMessage(type as InteractionType, markLost, nextFollowUpAt !== null));
  redirect(safeReturnPath(str(fd, "return"), `/contacts/${screen.contact.id}`));
}
