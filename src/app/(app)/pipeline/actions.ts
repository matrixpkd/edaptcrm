"use server";
import { revalidatePath } from "next/cache";
import { STAGES, type Stage } from "@/db/schema";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { ContactError, ContactNotFoundError } from "@/lib/contacts/errors";
import { moveBoardCard } from "@/lib/pipeline/move";
import { STAGE_TITLES } from "@/lib/pipeline/rules";
import { isUuid } from "@/lib/utils";

/** The one reply for a contact that does not exist and for one the person may not open. */
const GONE = "That contact no longer exists";

/**
 * A card dropped on the pipeline board (or moved with the phone's Move menu). Only the moves a person may make:
 * Qualified, Lost (with a reason) and Reopen. Rights are checked before anything about the contact is said
 * (src/lib/pipeline/move.ts); the lifecycle service re-checks the rights and the rules.
 */
export async function moveCardAction(_prev: ActionResult, fd: FormData): Promise<ActionResult<{ stage: Stage }>> {
  const user = await requireUser();
  if (!can(user, "contacts.setStage")) return fail("You cannot change stages");
  const contactId = str(fd, "contactId");
  const to = str(fd, "to") as Stage | null;
  if (!contactId || !isUuid(contactId)) return fail(GONE);
  if (!to || !STAGES.includes(to)) return fail("Choose a column");
  try {
    const { kind, contact: after } = await moveBoardCard(contactId, to, { lostReason: str(fd, "lostReason") }, user);
    revalidatePath("/pipeline");
    revalidatePath(`/contacts/${contactId}`);
    const msg =
      kind === "reopen"
        ? `Reopened: ${after.name} is now ${STAGE_TITLES[after.stage]}`
        : `${after.name} moved to ${STAGE_TITLES[after.stage]}`;
    return ok({ stage: after.stage }, msg);
  } catch (e) {
    if (e instanceof ContactNotFoundError) return fail(GONE);
    if (e instanceof ContactError) return fail(e.message);
    throw e;
  }
}
