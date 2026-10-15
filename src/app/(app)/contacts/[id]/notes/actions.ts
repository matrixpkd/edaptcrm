"use server";
import { revalidatePath } from "next/cache";
import { bool, fail, ok, str, type ActionResult } from "@/lib/action";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { addNote, setPinned } from "@/lib/contacts/notes";
import { isUuid } from "@/lib/utils";
import { actionError } from "../../_components/action-errors";

/** The contact page's "Add note" (optionally pinned to the top). */
export async function addNoteAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "interactions.log")) return fail("You cannot add notes");
  const contactId = str(fd, "contactId");
  if (!contactId || !isUuid(contactId)) return fail("Contact not found");
  try {
    await addNote(contactId, str(fd, "note") ?? "", user, { pin: bool(fd, "pin") });
  } catch (e) {
    return actionError(e);
  }
  revalidatePath(`/contacts/${contactId}`);
  return ok(undefined, bool(fd, "pin") ? "Note added and pinned" : "Note added");
}

/** Pin or unpin a note. */
export async function pinNoteAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const contactId = str(fd, "contactId");
  const pin = str(fd, "pin") === "1";
  try {
    await setPinned(str(fd, "noteId") ?? "", pin, user);
  } catch (e) {
    return actionError(e);
  }
  if (contactId && isUuid(contactId)) revalidatePath(`/contacts/${contactId}`);
  return ok(undefined, pin ? "Pinned to the top" : "Unpinned");
}
