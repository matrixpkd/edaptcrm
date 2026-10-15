"use server";
import { revalidatePath } from "next/cache";
import { STAGES, type Stage } from "@/db/schema";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { requireUser } from "@/lib/auth/session";
import { ContactError } from "@/lib/contacts/errors";
import { getLiveContact } from "@/lib/contacts/internal";
import { reopenContact, setManualStage } from "@/lib/contacts/lifecycle";
import { moveIntent, STAGE_TITLES } from "@/lib/pipeline/rules";
import { isUuid } from "@/lib/utils";

/**
 * A card dropped on the pipeline board (or moved with the phone's Move menu). Only the moves a person may make:
 * Qualified, Lost (with a reason) and Reopen; the lifecycle service re-checks the rights and the rules.
 */
export async function moveCardAction(_prev: ActionResult, fd: FormData): Promise<ActionResult<{ stage: Stage }>> {
  const user = await requireUser();
  const contactId = str(fd, "contactId");
  const to = str(fd, "to") as Stage | null;
  if (!contactId || !isUuid(contactId)) return fail("That contact no longer exists");
  if (!to || !STAGES.includes(to)) return fail("Choose a column");
  try {
    const c = await getLiveContact(contactId);
    const intent = moveIntent(c.stage, to, c.purchaseCount);
    let after;
    if (intent.kind === "none") return fail(intent.reason);
    if (intent.kind === "reopen") after = await reopenContact(contactId, user);
    else if (intent.kind === "qualify") after = await setManualStage(contactId, "qualified", {}, user);
    else after = await setManualStage(contactId, "lost", { lostReason: str(fd, "lostReason") }, user);
    revalidatePath("/pipeline");
    revalidatePath(`/contacts/${contactId}`);
    const msg =
      intent.kind === "reopen"
        ? `Reopened: ${after.name} is now ${STAGE_TITLES[after.stage]}`
        : `${after.name} moved to ${STAGE_TITLES[after.stage]}`;
    return ok({ stage: after.stage }, msg);
  } catch (e) {
    if (e instanceof ContactError) return fail(e.message);
    throw e;
  }
}
