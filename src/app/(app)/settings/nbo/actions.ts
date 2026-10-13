"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action";
import { saveNboRules } from "@/lib/admin/nbo";
import { adminForAction, failFrom, jsonField, NOT_ADMIN, withWarnings } from "../_lib/guard";

export async function saveNboAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const j = jsonField(fd);
  if (!j.ok) return fail("Nothing to save. Reload the page and try again.");
  try {
    const { changed, warnings } = await saveNboRules(j.value, admin);
    revalidatePath("/settings/nbo");
    return ok(
      undefined,
      withWarnings(changed ? "Offer rules saved. Contacts get the new offers at their next change, or recalculate everyone now." : "No changes to save.", warnings),
    );
  } catch (e) {
    return failFrom(e, "save offer rules");
  }
}
