"use server";
import { revalidatePath } from "next/cache";
import { bool, fail, list, ok, str, type ActionResult } from "@/lib/action";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { reassignContacts, requestTransfer } from "@/lib/contacts/assignment";
import { getContact } from "@/lib/contacts/internal";
import { CONTACTS_PAGE_SIZE, createSavedView, deleteSavedView } from "@/lib/contacts/queries";
import { isUuid } from "@/lib/utils";
import { actionError } from "./_components/action-errors";

/** Manager/admin: move the selected contacts to one person (or back to the pool) with a reason. */
export async function bulkReassignAction(
  _prev: ActionResult,
  fd: FormData,
): Promise<ActionResult<{ changed: number }>> {
  const user = await requireUser();
  if (!can(user, "contacts.reassign")) return fail("Only a manager or admin can reassign contacts");
  const ids = [...new Set(list(fd, "ids"))].filter(isUuid);
  if (!ids.length) return fail("Select at least one contact");
  if (ids.length > CONTACTS_PAGE_SIZE * 4) return fail(`Reassign up to ${CONTACTS_PAGE_SIZE * 4} contacts at a time`);
  const to = str(fd, "toUserId");
  if (!to) return fail("Choose who gets these contacts", { toUserId: "Choose someone" });
  const toUserId = to === "pool" ? null : to;
  if (toUserId !== null && !isUuid(toUserId)) return fail("Choose someone from the list");
  // optional: an empty reason still leaves a clear line in the ownership log
  const reason = str(fd, "reason") ?? (toUserId ? "Assigned in bulk by a manager" : "Unassigned to the pool by a manager");
  let changed = 0;
  try {
    changed = await reassignContacts(ids, toUserId, user, reason);
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/contacts");
  revalidatePath("/today");
  return ok(
    { changed },
    changed === 0
      ? "Nothing changed: they already belong there"
      : `${changed} contact${changed === 1 ? "" : "s"} ${toUserId ? "reassigned" : "moved to the pool"}`,
  );
}

/** Saves the current list query under a name (shared with everyone when a manager/admin ticks the box). */
export async function saveViewAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await createSavedView(user, {
      name: str(fd, "name") ?? "",
      query: str(fd, "query") ?? "",
      shared: bool(fd, "shared"),
    });
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/contacts");
  return ok(undefined, "View saved");
}

export async function deleteViewAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = str(fd, "viewId");
  if (!id || !(await deleteSavedView(user, id))) return fail("You can only delete your own views");
  revalidatePath("/contacts");
  return ok(undefined, "View deleted");
}

/**
 * Salesperson, Contacts list: one tap asks the manager for a lead in the pool (rule 5: salespeople request, they
 * never take). Asking twice while a request is open changes nothing.
 */
export async function requestPoolLeadAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.requestTransfer")) return fail("Managers assign pool leads directly");
  const contactId = str(fd, "contactId");
  if (!contactId || !isUuid(contactId)) return fail("Contact not found");
  let created = false;
  try {
    const c = await getContact(contactId);
    if (c.ownerId) return fail(c.ownerId === user.id ? "This lead is already yours" : "Someone already owns this lead");
    created = (await requestTransfer(contactId, user, "Asked for this pool lead from the contacts list")).created;
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/contacts");
  return ok(undefined, created ? "Requested. Your manager will assign it." : "You already asked for this lead.");
}
