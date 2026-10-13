"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { can, canEditContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { reassignContacts, requestTransfer } from "@/lib/contacts/assignment";
import { getContact } from "@/lib/contacts/internal";
import { reopenContact, setManualStage } from "@/lib/contacts/lifecycle";
import { mergeContacts, undoMerge } from "@/lib/contacts/merge";
import { isUuid } from "@/lib/utils";
import { actionError } from "../_components/action-errors";

/**
 * Contact page actions. Each one re-checks the signed-in user's rights here and again in the service.
 */

function contactIdFrom(fd: FormData): string | null {
  const id = str(fd, "contactId");
  return id && isUuid(id) ? id : null;
}

function refresh(contactId: string) {
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/contacts");
}

/** Mark Qualified or Mark Lost (with a reason from settings). */
export async function setStageAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const contactId = contactIdFrom(fd);
  if (!contactId) return fail("Contact not found");
  const stage = str(fd, "stage");
  if (stage !== "qualified" && stage !== "lost") return fail("Only Qualified and Lost are set by hand");
  if (!can(user, "contacts.setStage")) return fail("You cannot change the stage");
  try {
    const c = await getContact(contactId);
    if (!canEditContact(user, c)) return fail("You cannot change this contact's stage");
    await setManualStage(contactId, stage, { lostReason: str(fd, "lostReason") }, user);
  } catch (e) {
    return actionError(e);
  }
  refresh(contactId);
  return ok(undefined, stage === "lost" ? "Marked as lost" : "Marked as qualified");
}

/** Clears Lost so the automatic stage applies again. */
export async function reopenAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const contactId = contactIdFrom(fd);
  if (!contactId) return fail("Contact not found");
  try {
    await reopenContact(contactId, user);
  } catch (e) {
    return actionError(e);
  }
  refresh(contactId);
  return ok(undefined, "Reopened");
}

/** Manager/admin: hand the contact to someone else, or back to the pool. */
export async function reassignAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.reassign")) return fail("Only a manager or admin can reassign contacts");
  const contactId = contactIdFrom(fd);
  if (!contactId) return fail("Contact not found");
  const to = str(fd, "toUserId");
  const toUserId = to === "pool" ? null : to;
  if (toUserId !== null && !isUuid(toUserId))
    return fail("Choose who gets this contact", { toUserId: "Choose who gets this contact" });
  const reason = str(fd, "reason");
  if (!reason) return fail("Give a reason for the reassignment", { reason: "Give a reason" });
  let changed = 0;
  try {
    changed = await reassignContacts([contactId], toUserId, user, reason);
  } catch (e) {
    return actionError(e);
  }
  refresh(contactId);
  return ok(
    undefined,
    changed ? (toUserId ? "Reassigned" : "Moved to the pool") : "Nothing changed: they already own it",
  );
}

/** Salesperson: ask a manager for this contact (or to hand one of theirs to a colleague). */
export async function requestTransferAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.requestTransfer")) return fail("Managers reassign directly");
  const contactId = contactIdFrom(fd);
  if (!contactId) return fail("Contact not found");
  const reason = str(fd, "reason");
  if (!reason) return fail("Say why you need this contact", { reason: "Say why you need this contact" });
  const to = str(fd, "toUserId");
  if (to && !isUuid(to)) return fail("Choose a colleague from the list");
  let created = false;
  try {
    created = (await requestTransfer(contactId, user, reason, to ?? null)).created;
  } catch (e) {
    return actionError(e);
  }
  revalidatePath(`/contacts/${contactId}`);
  return ok(undefined, created ? "Request sent to your manager" : "You already asked. Your manager will answer soon.");
}

/** Manager/admin: merge another record (the loser) into this contact (the winner). */
export async function mergeAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.merge")) return fail("Only a manager or admin can merge contacts");
  const winnerId = str(fd, "winnerId");
  const loserId = str(fd, "loserId");
  if (!isUuid(winnerId) || !isUuid(loserId)) return fail("Choose the two records to merge");
  try {
    await mergeContacts(winnerId, loserId, user, str(fd, "reason"));
  } catch (e) {
    return actionError(e);
  }
  refresh(winnerId);
  revalidatePath(`/contacts/${loserId}`);
  revalidatePath("/duplicates");
  redirect(`/contacts/${winnerId}?merged=1`);
}

/** Manager/admin: undo a merge; the merged record comes back with everything it brought. */
export async function undoMergeAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.merge")) return fail("Only a manager or admin can undo merges");
  const mergeId = str(fd, "mergeId");
  const contactId = contactIdFrom(fd);
  if (!isUuid(mergeId) || !contactId) return fail("Merge not found");
  try {
    await undoMerge(mergeId, user);
  } catch (e) {
    return actionError(e);
  }
  refresh(contactId);
  revalidatePath("/duplicates");
  redirect(`/contacts/${contactId}?tab=merge&undone=1`);
}
