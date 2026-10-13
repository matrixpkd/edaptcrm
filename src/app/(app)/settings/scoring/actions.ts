"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action";
import { saveSettingAudited } from "@/lib/admin/settings";
import { validateScoring } from "@/lib/admin/validate";
import { getSettings } from "@/lib/settings";
import { adminForAction, failFrom, jsonField, NOT_ADMIN, withWarnings } from "../_lib/guard";

export async function saveScoringAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const j = jsonField(fd);
  if (!j.ok) return fail("Nothing to save. Reload the page and try again.");
  const lists = await getSettings(["lists.industries", "lists.ageBands"]);
  const v = validateScoring(j.value, {
    industries: lists["lists.industries"].map((i) => i.key),
    ageBands: lists["lists.ageBands"].map((i) => i.key),
  });
  if (!v.ok) return fail(v.error);
  try {
    const { changed } = await saveSettingAudited("scoring", v.value, admin);
    revalidatePath("/settings/scoring");
    return ok(
      undefined,
      withWarnings(changed ? "Scoring saved. Contacts pick it up at their next change, or recalculate everyone now." : "No changes to save.", v.warnings),
    );
  } catch (e) {
    return failFrom(e, "save scoring");
  }
}
