"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action";
import { saveSettingAudited } from "@/lib/admin/settings";
import { validateTemplates } from "@/lib/templates/whatsapp";
import { adminForAction, failFrom, jsonField, NOT_ADMIN } from "../_lib/guard";

/** Settings -> Message templates: saves the WhatsApp templates (audited). */
export async function saveTemplatesAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const j = jsonField(fd);
  if (!j.ok) return fail("Nothing to save. Reload the page and try again.");
  const v = validateTemplates(j.value);
  if (!v.ok) {
    const first = v.issues[0];
    return fail(first.index >= 0 ? `Template ${first.index + 1}: ${first.message}` : first.message);
  }
  try {
    const { changed } = await saveSettingAudited("templates.whatsapp", v.value, admin);
    revalidatePath("/settings/templates");
    revalidatePath("/contacts", "layout");
    return ok(undefined, changed ? "Templates saved." : "No changes to save.");
  } catch (e) {
    return failFrom(e, "save templates");
  }
}
