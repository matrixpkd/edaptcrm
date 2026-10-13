"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { dismissDuplicateReview, mergeContacts } from "@/lib/contacts/merge";
import { isUuid } from "@/lib/utils";
import { actionError } from "../contacts/_components/action-errors";

/** Merge one side of a possible-duplicate pair into the other (the winner stays). */
export async function mergePairAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.merge")) return fail("Only a manager or admin can merge contacts");
  const winnerId = str(fd, "winnerId");
  const loserId = str(fd, "loserId");
  if (!isUuid(winnerId) || !isUuid(loserId)) return fail("Choose which record to keep");
  try {
    await mergeContacts(winnerId, loserId, user, str(fd, "reason") ?? "Duplicate review");
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/duplicates");
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${winnerId}`);
  return ok(undefined, "Merged. Undo is on the kept contact's Merge tab.");
}

/** "Not the same person": the pair is closed and never flagged again. */
export async function dismissPairAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.merge")) return fail("Only a manager or admin can review duplicates");
  const reviewId = str(fd, "reviewId");
  if (!isUuid(reviewId)) return fail("Review not found");
  try {
    await dismissDuplicateReview(reviewId, user);
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/duplicates");
  return ok(undefined, "Kept as two different people");
}
